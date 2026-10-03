// Keeper: periodically calls bump_ttl so the vault's pool state stays alive
// within the Soroban rent window. Uses its own KEEPER_SECRET, never the relayer
// key. Exposes a minimal /health so the admin panel can poll it like the other
// services. Go port of offchain/relayer/src/keeper.ts.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/cyphras/offchain-go/internal/config"
	"github.com/cyphras/offchain-go/internal/logclient"
	"github.com/cyphras/offchain-go/internal/soroban"
	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/xdr"
)

type state struct {
	mu        sync.Mutex
	lastBump  time.Time
	lastHash  string
	lastError string
}

func (s *state) ok(hash string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastBump, s.lastHash, s.lastError = time.Now().UTC(), hash, ""
}

func (s *state) fail(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastError = err.Error()
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	rpcURL := config.Get("RPC_URL", "https://soroban-testnet.stellar.org")
	passphrase := config.Get("NETWORK_PASSPHRASE", network.TestNetworkPassphrase)
	vault := config.MustGet("VAULT_CONTRACT_ID")
	secret := config.MustGet("KEEPER_SECRET")
	interval := time.Duration(config.GetInt64("KEEPER_INTERVAL_MS", 7*24*3600*1000)) * time.Millisecond
	addr := ":" + config.Get("PORT", "8092")
	lc := logclient.New("cy1-keeper", config.Get("ADMIN_API_URL", ""), config.Get("ADMIN_API_SHARED_SECRET", ""))

	signer, err := keypair.ParseFull(secret)
	if err != nil {
		log.Fatalf("bad KEEPER_SECRET: %v", err)
	}
	client := soroban.NewClient(rpcURL, passphrase)
	defer client.Close()

	st := &state{}

	// Health server so the admin panel can poll the keeper like indexer/relayer.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		st.mu.Lock()
		body := map[string]any{
			"ok":       st.lastError == "",
			"keeper":   signer.Address(),
			"vault":    vault,
			"lastHash": st.lastHash,
		}
		if !st.lastBump.IsZero() {
			body["lastBumpAgoSeconds"] = int64(time.Since(st.lastBump).Seconds())
		}
		if st.lastError != "" {
			body["lastError"] = st.lastError
		}
		st.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	})
	srv := &http.Server{Addr: addr, Handler: mux}
	go func() {
		<-ctx.Done()
		sd, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sd)
	}()
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("health server: %v", err)
		}
	}()

	log.Printf("keeper up: vault=%s signer=%s interval=%s health=%s", vault, signer.Address(), interval, addr)
	lc.Log("startup", "info", nil, map[string]any{"vault": vault, "signer": signer.Address(), "intervalMs": interval.Milliseconds()})
	for ctx.Err() == nil {
		if hash, err := bump(ctx, client, signer, vault); err != nil {
			st.fail(err)
			log.Printf("keeper error: %v", err)
			lc.Log("bump_ttl_failed", "error", nil, map[string]any{"error": err.Error()})
		} else {
			st.ok(hash)
			log.Printf("bump_ttl submitted: hash=%s", hash)
			lc.Log("bump_ttl", "info", nil, map[string]any{"hash": hash})
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func bump(parent context.Context, client *soroban.Client, signer *keypair.Full, vault string) (string, error) {
	op, err := soroban.Invoke(vault, signer.Address(), "bump_ttl", []xdr.ScVal{})
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(parent, 90*time.Second)
	defer cancel()
	res, err := client.Submit(ctx, signer, op)
	if err != nil {
		return "", err
	}
	return res.Hash, nil
}
