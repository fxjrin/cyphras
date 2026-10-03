package indexer

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct{ pool *pgxpool.Pool }

func NewDB(ctx context.Context, url string) (*DB, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &DB{pool: pool}, nil
}

func (d *DB) Close()              { d.pool.Close() }
func (d *DB) Pool() *pgxpool.Pool { return d.pool }

func (d *DB) NextLeafIndex(ctx context.Context) (int64, error) {
	var n int64
	err := d.pool.QueryRow(ctx, "SELECT COALESCE(MAX(leaf_index)+1, 0) FROM commitments").Scan(&n)
	return n, err
}

func (d *DB) Cursor(ctx context.Context) (int64, error) {
	var n int64
	err := d.pool.QueryRow(ctx, "SELECT last_ledger FROM cursor WHERE id=1").Scan(&n)
	return n, err
}

func (d *DB) DeployLedger(ctx context.Context) (int64, bool, error) {
	var v *int64
	if err := d.pool.QueryRow(ctx, "SELECT deploy_ledger FROM cursor WHERE id=1").Scan(&v); err != nil {
		return 0, false, err
	}
	if v == nil {
		return 0, false, nil
	}
	return *v, true, nil
}

func (d *DB) SetDeployLedger(ctx context.Context, n int64) error {
	_, err := d.pool.Exec(ctx, "UPDATE cursor SET deploy_ledger=$1, updated_at=now() WHERE id=1", n)
	return err
}

func (d *DB) SetGapState(ctx context.Context, gap bool, lastErr string) error {
	var e *string
	if lastErr != "" {
		e = &lastErr
	}
	_, err := d.pool.Exec(ctx, "UPDATE cursor SET gap_detected=$1, last_error=$2, updated_at=now() WHERE id=1", gap, e)
	return err
}

func (d *DB) LedgerOfLeaf(ctx context.Context, index int64) (int64, bool, error) {
	var v *int64
	err := d.pool.QueryRow(ctx, "SELECT ledger FROM commitments WHERE leaf_index=$1", index).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) || v == nil {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return *v, true, nil
}

type CursorState struct {
	LastLedger       int64
	DeployLedger     *int64
	GapDetected      bool
	LastError        *string
	CursorAdvancedAt time.Time
}

func (d *DB) CursorState(ctx context.Context) (CursorState, error) {
	var s CursorState
	err := d.pool.QueryRow(ctx,
		"SELECT last_ledger, deploy_ledger, gap_detected, last_error, cursor_advanced_at FROM cursor WHERE id=1").
		Scan(&s.LastLedger, &s.DeployLedger, &s.GapDetected, &s.LastError, &s.CursorAdvancedAt)
	return s, err
}

type applyResult struct {
	gap      bool
	expected int64
}

// ApplyBatch inserts a batch and advances the cursor in one transaction. A leaf
// gap rolls the whole batch back and reports the expected next index, mirroring
// apply() in ingest.ts. Overlapping rescans are idempotent (ON CONFLICT).
func (d *DB) ApplyBatch(ctx context.Context, events []decodedEvent, safe int64) (applyResult, error) {
	commits := make([]decodedEvent, 0, len(events))
	nulls := make([]decodedEvent, 0, len(events))
	for _, e := range events {
		if e.kind == kindCommitment {
			commits = append(commits, e)
		} else {
			nulls = append(nulls, e)
		}
	}
	sort.Slice(commits, func(i, j int) bool { return commits[i].index < commits[j].index })

	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return applyResult{}, err
	}
	defer tx.Rollback(ctx)

	var expected int64
	if err := tx.QueryRow(ctx, "SELECT COALESCE(MAX(leaf_index)+1, 0) FROM commitments").Scan(&expected); err != nil {
		return applyResult{}, err
	}

	inserted := false
	for _, c := range commits {
		if int64(c.index) < expected {
			continue // already applied; overlap is safe
		}
		if int64(c.index) != expected {
			return applyResult{gap: true, expected: expected}, nil // defer rolls back
		}
		if _, err := tx.Exec(ctx,
			"INSERT INTO commitments(leaf_index,commitment,encrypted_output,ledger,tx_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(leaf_index) DO NOTHING",
			c.index, c.value, c.enc, c.ledger, c.txHash); err != nil {
			return applyResult{}, err
		}
		expected = int64(c.index) + 1
		inserted = true
	}
	for _, n := range nulls {
		if _, err := tx.Exec(ctx,
			"INSERT INTO nullifiers(nullifier,ledger,tx_hash) VALUES($1,$2,$3) ON CONFLICT(nullifier) DO NOTHING",
			n.value, n.ledger, n.txHash); err != nil {
			return applyResult{}, err
		}
	}
	if _, err := tx.Exec(ctx,
		"UPDATE cursor SET last_ledger=$1, updated_at=now(), cursor_advanced_at=now() WHERE id=1", safe); err != nil {
		return applyResult{}, err
	}
	// NOTIFY fires on COMMIT only, so a rolled-back batch wakes nobody.
	if inserted {
		if _, err := tx.Exec(ctx, "SELECT pg_notify('new_commitment', $1)", fmt.Sprint(expected)); err != nil {
			return applyResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return applyResult{}, err
	}
	return applyResult{}, nil
}

type Note struct {
	LeafIndex       int64  `json:"leaf_index"`
	Commitment      string `json:"commitment"`
	EncryptedOutput string `json:"encrypted_output"`
	Ledger          int64  `json:"ledger"`
}

func (d *DB) Notes(ctx context.Context, since int64) ([]Note, error) {
	rows, err := d.pool.Query(ctx,
		"SELECT leaf_index, encode(commitment,'hex'), encode(encrypted_output,'hex'), ledger FROM commitments WHERE leaf_index >= $1 ORDER BY leaf_index",
		since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Note{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.LeafIndex, &n.Commitment, &n.EncryptedOutput, &n.Ledger); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (d *DB) NullifierSpent(ctx context.Context, hexNullifier string) (bool, error) {
	var one int
	err := d.pool.QueryRow(ctx, "SELECT 1 FROM nullifiers WHERE nullifier = decode($1,'hex')", hexNullifier).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
