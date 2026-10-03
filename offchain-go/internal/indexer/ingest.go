package indexer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/cyphras/offchain-go/internal/logclient"
	"github.com/cyphras/offchain-go/internal/soroban"
	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/xdr"
)

const (
	// Just under the RPC's ~7-day event retention window.
	retentionLedgers = 110_000
	// getEvents caps a page at 10000; a window this size for a low-activity pool
	// stays well under that, so we never need in-window cursor pagination.
	scanWindow   = 10_000
	pageLimit    = 10_000
	maxRescan    = 5
	pollInterval = 5 * time.Second
	maxBackoff   = 60 * time.Second
)

// errRetention signals the resume point fell out of RPC retention; never produced
// by transient failures, so the loop halts visibly instead of skipping leaves.
var errRetention = errors.New("resume ledger older than RPC oldestLedger")

type Indexer struct {
	client        *soroban.Client
	db            *DB
	vault         string
	confirmations int64
	log           *logclient.Client
}

func New(client *soroban.Client, db *DB, vault string, confirmations int64, lc *logclient.Client) *Indexer {
	if confirmations < 1 {
		confirmations = 1
	}
	if confirmations > 2 {
		confirmations = 2
	}
	return &Indexer{client: client, db: db, vault: vault, confirmations: confirmations, log: lc}
}

func isRetentionError(err error) bool {
	m := strings.ToLower(err.Error())
	return (strings.Contains(m, "startledger") || strings.Contains(m, "start ledger")) &&
		(strings.Contains(m, "oldest") || strings.Contains(m, "older") ||
			strings.Contains(m, "retention") || strings.Contains(m, "out of range"))
}

func (ix *Indexer) latestLedger(ctx context.Context) (int64, error) {
	r, err := ix.client.RPC().GetLatestLedger(ctx)
	if err != nil {
		return 0, err
	}
	return int64(r.Sequence), nil
}

// fetchRange pulls [from, to] in a single getEvents call. Fails loudly if a
// window ever hits the page limit rather than silently dropping leaves.
func (ix *Indexer) fetchRange(ctx context.Context, from, to int64) ([]decodedEvent, int64, error) {
	req := protocol.GetEventsRequest{
		StartLedger: uint32(from),
		EndLedger:   uint32(to + 1),
		Filters: []protocol.EventFilter{{
			EventType:   protocol.EventTypeSet{protocol.EventTypeContract: nil},
			ContractIDs: []string{ix.vault},
		}},
		Pagination: &protocol.PaginationOptions{Limit: pageLimit},
	}
	res, err := ix.client.RPC().GetEvents(ctx, req)
	if err != nil {
		if isRetentionError(err) {
			return nil, 0, errRetention
		}
		return nil, 0, err
	}
	if len(res.Events) >= pageLimit {
		return nil, 0, fmt.Errorf("window [%d,%d] hit page limit %d; shrink scanWindow", from, to, pageLimit)
	}
	out := make([]decodedEvent, 0, len(res.Events))
	for _, e := range res.Events {
		if int64(e.Ledger) > to {
			continue
		}
		d, err := decodeEvent(e)
		if err != nil {
			return nil, 0, err
		}
		if d != nil {
			out = append(out, *d)
		}
	}
	return out, int64(res.OldestLedger), nil
}

// deployLedgerFromInstance reads the vault's contract-INSTANCE entry
// lastModifiedLedgerSeq. Unlike the shared code (wasm) entry - whose ledger is
// when the wasm was first uploaded, often long before this instance and out of
// retention - the instance entry is created when THIS vault is deployed, so its
// ledger is a recent, in-retention bound that needs no events (works for an
// empty pool). It moves forward on instance writes/TTL bumps, so it can overshoot
// leaf 0 after activity; the caller re-anchors via walk-back when that happens.
func (ix *Indexer) deployLedgerFromInstance(ctx context.Context) (int64, bool, error) {
	addr, err := soroban.ContractAddress(ix.vault)
	if err != nil {
		return 0, false, err
	}
	var instanceKey xdr.LedgerKey
	if err := instanceKey.SetContractData(addr,
		xdr.ScVal{Type: xdr.ScValTypeScvLedgerKeyContractInstance},
		xdr.ContractDataDurabilityPersistent); err != nil {
		return 0, false, err
	}
	instanceB64, err := xdr.MarshalBase64(instanceKey)
	if err != nil {
		return 0, false, err
	}
	res, err := ix.client.RPC().GetLedgerEntries(ctx, protocol.GetLedgerEntriesRequest{Keys: []string{instanceB64}})
	if err != nil || len(res.Entries) == 0 || res.Entries[0].LastModifiedLedger == 0 {
		return 0, false, err
	}
	return int64(res.Entries[0].LastModifiedLedger), true, nil
}

// deployLedgerFromWalkBack anchors on leaf 0 directly; authoritative when the
// code-entry bound overshoots (e.g. after a keeper TTL bump).
func (ix *Indexer) deployLedgerFromWalkBack(ctx context.Context, latest int64) (int64, error) {
	windowFrom := max(int64(1), latest-retentionLedgers)
	for windowFrom <= latest {
		windowTo := min(windowFrom+scanWindow-1, latest)
		events, _, err := ix.fetchRange(ctx, windowFrom, windowTo)
		if err != nil {
			return 0, err
		}
		for _, d := range events {
			if d.kind == kindCommitment && d.index == 0 {
				return int64(d.ledger), nil
			}
		}
		windowFrom = windowTo + 1
	}
	return 0, fmt.Errorf("leaf 0 not found in walk-back from %d", max(int64(1), latest-retentionLedgers))
}

// discoverDeployLedger prefers the code-entry bound (works for empty pools) and
// falls back to leaf-0 walk-back; forceWalkBack skips code entry once it is
// proven to overshoot leaf 0.
func (ix *Indexer) discoverDeployLedger(ctx context.Context, latest int64, forceWalkBack bool) (int64, error) {
	if !forceWalkBack {
		if led, ok, err := ix.deployLedgerFromInstance(ctx); err == nil && ok {
			return led, nil
		}
	}
	return ix.deployLedgerFromWalkBack(ctx, latest)
}

func (ix *Indexer) ingestRange(ctx context.Context, from, safe int64) (applyResult, error) {
	windowFrom := from
	for windowFrom <= safe {
		windowTo := min(windowFrom+scanWindow-1, safe)
		events, oldest, err := ix.fetchRange(ctx, windowFrom, windowTo)
		if err != nil {
			return applyResult{}, err
		}
		// Numeric retention guard: some providers clamp instead of erroring.
		if oldest > 0 && windowFrom < oldest {
			return applyResult{}, errRetention
		}
		res, err := ix.db.ApplyBatch(ctx, events, windowTo)
		if err != nil {
			return applyResult{}, err
		}
		if res.gap {
			return res, nil
		}
		windowFrom = windowTo + 1
	}
	return applyResult{}, nil
}

func (ix *Indexer) tick(ctx context.Context) error {
	deploy, ok, err := ix.db.DeployLedger(ctx)
	if err != nil {
		return err
	}
	if !ok {
		latest, err := ix.latestLedger(ctx)
		if err != nil {
			return err
		}
		deploy, err = ix.discoverDeployLedger(ctx, latest, false)
		if err != nil {
			return err
		}
		if err := ix.db.SetDeployLedger(ctx, deploy); err != nil {
			return err
		}
	}

	latest, err := ix.latestLedger(ctx)
	if err != nil {
		return err
	}
	safe := latest - ix.confirmations

	// Empty tree rescans from deploy and never trusts a stale cursor.
	expected, err := ix.db.NextLeafIndex(ctx)
	if err != nil {
		return err
	}
	var from int64
	if expected == 0 {
		from = deploy
	} else {
		cur, err := ix.db.Cursor(ctx)
		if err != nil {
			return err
		}
		from = cur + 1
	}
	if from > safe {
		return nil
	}

	attempts := 0
	for {
		res, err := ix.ingestRange(ctx, from, safe)
		if err != nil {
			return err
		}
		if !res.gap {
			break
		}
		// A gap at leaf 0 means the code-entry deploy ledger overshot it; re-anchor
		// via walk-back rather than rewinding to a too-late deploy.
		if res.expected == 0 {
			deploy, err = ix.discoverDeployLedger(ctx, safe, true)
			if err != nil {
				return err
			}
			if err := ix.db.SetDeployLedger(ctx, deploy); err != nil {
				return err
			}
			from = deploy
			continue
		}
		attempts++
		if attempts > maxRescan {
			return fmt.Errorf("leaf gap unresolved after %d rescans: expected %d", maxRescan, res.expected)
		}
		_ = ix.db.SetGapState(ctx, true, fmt.Sprintf("leaf gap: expected %d", res.expected))
		rewind, ok, err := ix.db.LedgerOfLeaf(ctx, res.expected-1)
		if err != nil {
			return err
		}
		if !ok || rewind < deploy {
			from = deploy
		} else {
			from = rewind
		}
	}
	return ix.db.SetGapState(ctx, false, "")
}

func (ix *Indexer) Run(ctx context.Context) {
	ix.log.Log("startup", "info", nil, map[string]any{"vault": ix.vault})
	backoff := pollInterval
	degraded := false
	for {
		if ctx.Err() != nil {
			return
		}
		err := ix.tick(ctx)
		switch {
		case err == nil:
			if degraded {
				ix.log.Log("sync_recovered", "info", nil, nil)
				degraded = false
			}
			backoff = pollInterval
		case errors.Is(err, errRetention):
			_ = ix.db.SetGapState(ctx, true, errRetention.Error())
			log.Printf("retention gap: %v; halting ingest until backfilled", err)
			if !degraded {
				ix.log.Log("retention_gap", "error", nil, map[string]any{"error": err.Error()})
				degraded = true
			}
			sleep(ctx, maxBackoff)
			continue
		default:
			_ = ix.db.SetGapState(ctx, true, err.Error())
			log.Printf("ingest error: %v", err)
			if !degraded {
				ix.log.Log("ingest_error", "error", nil, map[string]any{"error": err.Error()})
				degraded = true
			}
			backoff = min(backoff*2, maxBackoff)
			sleep(ctx, backoff)
			continue
		}
		sleep(ctx, pollInterval)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
