package indexer

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// ---- ScVal builders that mirror how soroban's #[contractevent] emits events ----

func sym(s string) xdr.ScVal {
	v := xdr.ScSymbol(s)
	return xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &v}
}

func u32v(n uint32) xdr.ScVal {
	v := xdr.Uint32(n)
	return xdr.ScVal{Type: xdr.ScValTypeScvU32, U32: &v}
}

func u256v(b []byte) xdr.ScVal {
	var p xdr.UInt256Parts
	p.HiHi = xdr.Uint64(binary.BigEndian.Uint64(b[0:8]))
	p.HiLo = xdr.Uint64(binary.BigEndian.Uint64(b[8:16]))
	p.LoHi = xdr.Uint64(binary.BigEndian.Uint64(b[16:24]))
	p.LoLo = xdr.Uint64(binary.BigEndian.Uint64(b[24:32]))
	return xdr.ScVal{Type: xdr.ScValTypeScvU256, U256: &p}
}

func bytesv(b []byte) xdr.ScVal {
	sb := xdr.ScBytes(b)
	return xdr.ScVal{Type: xdr.ScValTypeScvBytes, Bytes: &sb}
}

func mapv(entries []xdr.ScMapEntry) xdr.ScVal {
	m := xdr.ScMap(entries)
	mp := &m
	return xdr.ScVal{Type: xdr.ScValTypeScvMap, Map: &mp}
}

func mustB64(t *testing.T, v xdr.ScVal) string {
	t.Helper()
	s, err := xdr.MarshalBase64(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return s
}

func TestDecodeCommitment(t *testing.T) {
	comm := make([]byte, 32)
	comm[0] = 0x01
	comm[31] = 0xab
	enc := []byte{0xde, 0xad, 0xbe, 0xef}
	val := mapv([]xdr.ScMapEntry{
		{Key: sym("commitment"), Val: u256v(comm)},
		{Key: sym("encrypted_output"), Val: bytesv(enc)},
		{Key: sym("index"), Val: u32v(7)},
	})
	ev := protocol.EventInfo{
		ID: "e1", Ledger: 123, TransactionHash: "tx1",
		TopicXDR: []string{mustB64(t, sym("new_commitment"))},
		ValueXDR: mustB64(t, val),
	}
	d, err := decodeEvent(ev)
	if err != nil {
		t.Fatal(err)
	}
	if d == nil || d.kind != kindCommitment {
		t.Fatalf("expected commitment, got %+v", d)
	}
	if d.index != 7 {
		t.Errorf("index = %d, want 7", d.index)
	}
	if !bytes.Equal(d.value, comm) {
		t.Errorf("commitment bytes mismatch: got %x", d.value)
	}
	if !bytes.Equal(d.enc, enc) {
		t.Errorf("enc mismatch: got %x", d.enc)
	}
}

func TestDecodeNullifier(t *testing.T) {
	null := make([]byte, 32)
	null[15] = 0x99
	val := mapv([]xdr.ScMapEntry{{Key: sym("nullifier"), Val: u256v(null)}})
	ev := protocol.EventInfo{
		ID: "e2", Ledger: 200, TransactionHash: "tx2",
		TopicXDR: []string{mustB64(t, sym("new_nullifier"))},
		ValueXDR: mustB64(t, val),
	}
	d, err := decodeEvent(ev)
	if err != nil {
		t.Fatal(err)
	}
	if d == nil || d.kind != kindNullifier {
		t.Fatalf("expected nullifier, got %+v", d)
	}
	if !bytes.Equal(d.value, null) {
		t.Errorf("nullifier bytes mismatch: got %x", d.value)
	}
}

func TestDecodeUnknownEventIgnored(t *testing.T) {
	val := mapv([]xdr.ScMapEntry{{Key: sym("x"), Val: u32v(1)}})
	ev := protocol.EventInfo{
		ID: "e3", TopicXDR: []string{mustB64(t, sym("something_else"))}, ValueXDR: mustB64(t, val),
	}
	d, err := decodeEvent(ev)
	if err != nil || d != nil {
		t.Fatalf("unknown event should be (nil,nil), got d=%+v err=%v", d, err)
	}
}

// ---- Ingest + API against a real Postgres (gated on TEST_DATABASE_URL) ----

func commitEvent(index uint32, valueByte byte, ledger int32) decodedEvent {
	v := make([]byte, 32)
	v[31] = valueByte
	return decodedEvent{kind: kindCommitment, index: index, value: v, enc: []byte{valueByte}, ledger: ledger, txHash: "tx"}
}

func nullEvent(valueByte byte, ledger int32) decodedEvent {
	v := make([]byte, 32)
	v[31] = valueByte
	return decodedEvent{kind: kindNullifier, value: v, ledger: ledger, txHash: "tx"}
}

func TestIngestGaplessAndAPI(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run the DB-backed test")
	}
	ctx := context.Background()
	db, err := NewDB(ctx, url)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	defer db.Close()
	if _, err := db.pool.Exec(ctx, "TRUNCATE commitments, nullifiers; UPDATE cursor SET last_ledger=0, deploy_ledger=NULL, gap_detected=false, last_error=NULL"); err != nil {
		t.Fatalf("reset: %v", err)
	}

	// Gapless batch: leaves 0 and 1 plus a nullifier.
	res, err := db.ApplyBatch(ctx, []decodedEvent{
		commitEvent(1, 0x11, 101),
		commitEvent(0, 0x10, 100),
		nullEvent(0xaa, 100),
	}, 101)
	if err != nil {
		t.Fatalf("apply gapless: %v", err)
	}
	if res.gap {
		t.Fatalf("unexpected gap on gapless batch")
	}
	if n, _ := db.NextLeafIndex(ctx); n != 2 {
		t.Fatalf("next leaf = %d, want 2", n)
	}

	// A batch that starts at leaf 3 must be rejected as a gap (expected 2).
	res, err = db.ApplyBatch(ctx, []decodedEvent{commitEvent(3, 0x13, 103)}, 103)
	if err != nil {
		t.Fatalf("apply gap: %v", err)
	}
	if !res.gap || res.expected != 2 {
		t.Fatalf("expected gap at 2, got gap=%v expected=%d", res.gap, res.expected)
	}
	if n, _ := db.NextLeafIndex(ctx); n != 2 {
		t.Fatalf("gap batch must not insert; next leaf = %d, want 2", n)
	}

	// /notes returns both leaves in order with correct hex.
	api := NewAPI(db, NewHub(), stubLedger(105), 100)
	rec := httptest.NewRecorder()
	api.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/notes?since=0", nil))
	var notes []Note
	if err := json.Unmarshal(rec.Body.Bytes(), &notes); err != nil {
		t.Fatalf("notes decode: %v (body=%s)", err, rec.Body.String())
	}
	if len(notes) != 2 || notes[0].LeafIndex != 0 || notes[1].LeafIndex != 1 {
		t.Fatalf("notes = %+v", notes)
	}
	wantComm0 := make([]byte, 32)
	wantComm0[31] = 0x10
	if notes[0].Commitment != hex.EncodeToString(wantComm0) {
		t.Errorf("commitment0 hex = %s", notes[0].Commitment)
	}

	// /nullifier: spent vs unspent.
	spentHex := hex.EncodeToString(func() []byte { b := make([]byte, 32); b[31] = 0xaa; return b }())
	rec = httptest.NewRecorder()
	api.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nullifier/"+spentHex, nil))
	if got := rec.Body.String(); !bytes.Contains([]byte(got), []byte(`"spent":true`)) {
		t.Errorf("expected spent:true, got %s", got)
	}
	rec = httptest.NewRecorder()
	api.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nullifier/"+hex.EncodeToString(make([]byte, 32)), nil))
	if got := rec.Body.String(); !bytes.Contains([]byte(got), []byte(`"spent":false`)) {
		t.Errorf("expected spent:false, got %s", got)
	}

	// /health: last_ledger 101, latest 105, lag 4 -> ready.
	rec = httptest.NewRecorder()
	api.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health code = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var health map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &health)
	if health["ok"] != true {
		t.Errorf("health not ok: %v", health)
	}
}

type stubLedger int64

func (s stubLedger) latestLedger(context.Context) (int64, error) { return int64(s), nil }

var _ ledgerSource = stubLedger(0)
var _ = time.Second
