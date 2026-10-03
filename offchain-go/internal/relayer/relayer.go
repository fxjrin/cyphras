// Relayer: accepts a client-built {proof, ext}, becomes the transaction source,
// and submits transact so the user's own account never signs. The vault refunds
// ext.fee to the relayer, so a self-calibrating fee floor keeps a relayed spend
// from ever costing the relayer money. Go port of offchain/relayer/src/index.ts.
package relayer

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/cyphras/offchain-go/internal/logclient"
	"github.com/cyphras/offchain-go/internal/soroban"
	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/xdr"
)

type Config struct {
	Vault          string
	NetCost        int64 // bootstrap XLM-stroop cost until the first real tx calibrates
	MarginBps      int64 // target markup baked into the quote
	MinMarginBps   int64 // floor enforced over the real simulated cost
	QuoteBufferBps int64 // headroom for gas drift between quote and submit
	RatePPM        int64 // pool asset per 1 XLM (1e6 scale)
}

type Relayer struct {
	client *soroban.Client
	signer *keypair.Full
	cfg    Config
	log    *logclient.Client

	mu           sync.Mutex
	observedCost int64 // XLM stroops the relayer actually pays, self-calibrated
}

func New(client *soroban.Client, signer *keypair.Full, cfg Config, lc *logclient.Client) *Relayer {
	return &Relayer{client: client, signer: signer, cfg: cfg, log: lc, observedCost: cfg.NetCost}
}

func (r *Relayer) toAsset(xlm int64) int64 { return xlm * r.cfg.RatePPM / 1_000_000 }

type quote struct {
	fee, basis, margin int64
}

func (r *Relayer) quote() quote {
	r.mu.Lock()
	observed := r.observedCost
	r.mu.Unlock()
	basis := r.toAsset(observed + observed*r.cfg.QuoteBufferBps/10_000)
	margin := basis * r.cfg.MarginBps / 10_000
	return quote{fee: basis + margin, basis: basis, margin: margin}
}

// learnCost jumps up at once but decays down slowly, so a cheap outlier cannot
// drop the quote below real gas.
func (r *Relayer) learnCost(cost int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if cost > r.observedCost {
		r.observedCost = cost
	} else {
		r.observedCost -= (r.observedCost - cost) / 8
	}
}

func (r *Relayer) calibrated() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.observedCost != r.cfg.NetCost
}

func (r *Relayer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", r.health)
	mux.HandleFunc("GET /quote", r.quoteHandler)
	mux.HandleFunc("POST /submit", r.submit)
	return cors(mux)
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
		if req.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, req)
	})
}

func intPtr(n int) *int { return &n }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (r *Relayer) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "relayer": r.signer.Address()})
}

func (r *Relayer) quoteHandler(w http.ResponseWriter, _ *http.Request) {
	q := r.quote()
	writeJSON(w, http.StatusOK, map[string]string{
		"fee":          fmt.Sprint(q.fee),
		"netCost":      fmt.Sprint(q.basis),
		"margin":       fmt.Sprint(q.margin),
		"marginBps":    fmt.Sprint(r.cfg.MarginBps),
		"minMarginBps": fmt.Sprint(r.cfg.MinMarginBps),
		"calibrated":   fmt.Sprint(r.calibrated()),
	})
}

type submitBody struct {
	Proof struct {
		A            string   `json:"a"`
		B            string   `json:"b"`
		C            string   `json:"c"`
		Root         string   `json:"root"`
		PublicAmount string   `json:"public_amount"`
		ExtDataHash  string   `json:"ext_data_hash"`
		Nullifiers   []string `json:"nullifiers"`
		Commitments  []string `json:"commitments"`
	} `json:"proof"`
	Ext struct {
		ExtAmount        string `json:"ext_amount"`
		Fee              string `json:"fee"`
		Recipient        string `json:"recipient"`
		Relayer          string `json:"relayer"`
		EncryptedOutput0 string `json:"encrypted_output0"`
		EncryptedOutput1 string `json:"encrypted_output1"`
	} `json:"ext"`
}

var hexRe = regexp.MustCompile(`^[0-9a-f]*$`)

func hexLen(s string, n int) bool { return len(s) == n && hexRe.MatchString(s) }

// parse validates and converts the request into typed proof/ext, mirroring the
// TS parseBody checks.
func (b *submitBody) parse() (ProofHex, ExtHex, *big.Int, error) {
	if !hexLen(b.Proof.A, 128) || !hexLen(b.Proof.B, 256) || !hexLen(b.Proof.C, 128) {
		return ProofHex{}, ExtHex{}, nil, fmt.Errorf("bad proof points")
	}
	extAmount, ok := new(big.Int).SetString(b.Ext.ExtAmount, 10)
	if !ok {
		return ProofHex{}, ExtHex{}, nil, fmt.Errorf("bad ext_amount")
	}
	fee, ok := new(big.Int).SetString(b.Ext.Fee, 10)
	if !ok || fee.Sign() < 0 {
		return ProofHex{}, ExtHex{}, nil, fmt.Errorf("bad fee")
	}
	enc0, err := hex.DecodeString(b.Ext.EncryptedOutput0)
	if err != nil {
		return ProofHex{}, ExtHex{}, nil, fmt.Errorf("bad encrypted_output0")
	}
	enc1, err := hex.DecodeString(b.Ext.EncryptedOutput1)
	if err != nil {
		return ProofHex{}, ExtHex{}, nil, fmt.Errorf("bad encrypted_output1")
	}
	proof := ProofHex{
		A: b.Proof.A, B: b.Proof.B, C: b.Proof.C,
		Root: b.Proof.Root, PublicAmount: b.Proof.PublicAmount, ExtDataHash: b.Proof.ExtDataHash,
		Nullifiers: b.Proof.Nullifiers, Commitments: b.Proof.Commitments,
	}
	ext := ExtHex{
		ExtAmount: extAmount, Fee: fee,
		Recipient: b.Ext.Recipient, Relayer: b.Ext.Relayer,
		EncryptedOutput0: enc0, EncryptedOutput1: enc1,
	}
	return proof, ext, fee, nil
}

func (r *Relayer) submit(w http.ResponseWriter, req *http.Request) {
	var body submitBody
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 64*1024)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	proof, ext, fee, err := body.parse()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if ext.ExtAmount.Sign() > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "deposits are submitted by the wallet, not the relayer"})
		return
	}
	if ext.Relayer != r.signer.Address() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ext.relayer must equal this relayer address; the fee would be paid elsewhere"})
		return
	}
	// Cheap pre-check in asset units before paying for a simulation.
	if fee.Cmp(big.NewInt(r.toAsset(r.observedCostSnapshot()))) < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "fee below relayer cost estimate; GET /quote"})
		return
	}

	proofSc, err := proofScVal(proof)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	extSc, err := extScVal(ext)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	sender, err := addressVal(r.signer.Address())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	op, err := soroban.Invoke(r.cfg.Vault, r.signer.Address(), "transact", []xdr.ScVal{proofSc, extSc, sender})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(req.Context(), 90*time.Second)
	defer cancel()

	prepared, err := r.client.Prepare(ctx, r.signer, op)
	if err != nil {
		r.log.Log("submit_failed", "error", intPtr(http.StatusBadGateway), map[string]any{"stage": "prepare", "error": err.Error()})
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "prepare failed: " + err.Error()})
		return
	}
	r.learnCost(prepared.Fee) // recalibrate from the real simulated gas

	costAsset := r.toAsset(prepared.Fee)
	required := big.NewInt(costAsset + costAsset*r.cfg.MinMarginBps/10_000)
	if fee.Cmp(required) < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":    fmt.Sprintf("fee %s below required %s (asset cost %d + %dbps min margin); GET /quote and re-prove", fee, required, costAsset, r.cfg.MinMarginBps),
			"cost":     fmt.Sprint(costAsset),
			"required": required.String(),
		})
		return
	}

	res, err := r.client.Send(ctx, r.signer, prepared)
	if err != nil {
		r.log.Log("submit_failed", "error", intPtr(http.StatusBadGateway), map[string]any{"stage": "send", "error": err.Error()})
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "send failed: " + err.Error()})
		return
	}
	profit := new(big.Int).Sub(fee, big.NewInt(costAsset))
	log.Printf("relayed spend: hash=%s fee=%s gasXlm=%d costAsset=%d profit=%s", res.Hash, fee, prepared.Fee, costAsset, profit)
	r.log.Log("relayed_spend", "info", nil, map[string]any{
		"hash":   res.Hash,
		"fee":    fee.String(),
		"gasXlm": prepared.Fee,
		"profit": profit.String(),
	})
	writeJSON(w, http.StatusOK, map[string]string{
		"hash":   res.Hash,
		"fee":    fee.String(),
		"cost":   fmt.Sprint(costAsset),
		"profit": profit.String(),
	})
}

func (r *Relayer) observedCostSnapshot() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.observedCost
}
