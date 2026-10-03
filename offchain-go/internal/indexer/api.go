package indexer

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Hub fans a Postgres LISTEN new_commitment signal out to SSE subscribers. The
// payload is only a wake signal; clients re-scan /notes locally, so it leaks nothing.
type Hub struct {
	mu   sync.Mutex
	subs map[chan string]struct{}
}

func NewHub() *Hub { return &Hub{subs: map[chan string]struct{}{}} }

func (h *Hub) sub() chan string {
	ch := make(chan string, 8)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *Hub) unsub(ch chan string) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *Hub) broadcast(msg string) {
	h.mu.Lock()
	for ch := range h.subs {
		select {
		case ch <- msg:
		default: // drop if a slow client is full; it re-scans anyway
		}
	}
	h.mu.Unlock()
}

// Listen holds a dedicated connection on LISTEN new_commitment and rebroadcasts;
// reconnects on any connection drop.
func (h *Hub) Listen(ctx context.Context, pool *pgxpool.Pool) {
	for ctx.Err() == nil {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			sleep(ctx, time.Second)
			continue
		}
		if _, err := conn.Exec(ctx, "LISTEN new_commitment"); err != nil {
			conn.Release()
			sleep(ctx, time.Second)
			continue
		}
		for ctx.Err() == nil {
			n, err := conn.Conn().WaitForNotification(ctx)
			if err != nil {
				break
			}
			h.broadcast(n.Payload)
		}
		conn.Release()
		sleep(ctx, time.Second)
	}
}

type API struct {
	db           *DB
	hub          *Hub
	client       ledgerSource
	syncLagLimit int64
}

// ledgerSource is the sync-lag probe; kept an interface so tests need no live RPC.
type ledgerSource interface {
	latestLedger(ctx context.Context) (int64, error)
}

func NewAPI(db *DB, hub *Hub, client ledgerSource, syncLagLimit int64) *API {
	return &API{db: db, hub: hub, client: client, syncLagLimit: syncLagLimit}
}

func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.health)
	mux.HandleFunc("GET /notes", a.notes)
	mux.HandleFunc("GET /nullifier/{hex}", a.nullifier)
	mux.HandleFunc("GET /stream", a.stream)
	return cors(mux)
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	state, err := a.db.CursorState(ctx)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	leafCount, _ := a.db.NextLeafIndex(ctx)

	var latest *int64
	var syncLag *int64
	if l, err := a.client.latestLedger(ctx); err == nil {
		latest = &l
		lag := l - state.LastLedger
		syncLag = &lag
	}
	lagExceeded := syncLag != nil && *syncLag > a.syncLagLimit
	ready := !state.GapDetected && !lagExceeded

	code := http.StatusOK
	if !ready {
		code = http.StatusServiceUnavailable
	}
	writeJSON(w, code, map[string]any{
		"ok":               ready,
		"leaf_count":       leafCount,
		"last_ledger":      state.LastLedger,
		"latest_ledger":    latest,
		"sync_lag_ledgers": syncLag,
		"sync_lag_seconds": int64(time.Since(state.CursorAdvancedAt).Seconds()),
		"gap_detected":     state.GapDetected,
		"last_error":       state.LastError,
	})
}

func (a *API) notes(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	rows, err := a.db.Notes(r.Context(), since)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (a *API) nullifier(w http.ResponseWriter, r *http.Request) {
	spent, err := a.db.NullifierSpent(r.Context(), r.PathValue("hex"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"spent": spent})
}

func (a *API) stream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write([]byte("retry: 5000\n\n")); err != nil {
		return
	}
	flusher.Flush()

	ch := a.hub.sub()
	defer a.hub.unsub(ch)
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case payload := <-ch:
			if _, err := w.Write([]byte("event: new_commitment\ndata: " + payload + "\n\n")); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// StartServer runs the API until ctx is cancelled.
func StartServer(ctx context.Context, addr string, h http.Handler) error {
	srv := &http.Server{Addr: addr, Handler: h}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("indexer api on %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
