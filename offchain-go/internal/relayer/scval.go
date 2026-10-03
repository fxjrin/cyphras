// ScVal builders pinned to the vault's transact contracttype. Field names, types,
// and canonical (symbol-sorted) map order mirror offchain/relayer/src/scval.ts
// exactly; the contract rejects any structural or ordering mismatch.
package relayer

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/big"

	"github.com/cyphras/offchain-go/internal/soroban"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"
)

type ProofHex struct {
	A, B, C      string
	Root         string
	PublicAmount string
	ExtDataHash  string
	Nullifiers   []string
	Commitments  []string
}

type ExtHex struct {
	ExtAmount        *big.Int
	Fee              *big.Int
	Recipient        string
	Relayer          string
	EncryptedOutput0 []byte
	EncryptedOutput1 []byte
}

func symVal(s string) xdr.ScVal {
	v := xdr.ScSymbol(s)
	return xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &v}
}

func bytesVal(b []byte) xdr.ScVal {
	sb := xdr.ScBytes(b)
	return xdr.ScVal{Type: xdr.ScValTypeScvBytes, Bytes: &sb}
}

func bytesFromHex(h string) (xdr.ScVal, error) {
	b, err := hex.DecodeString(h)
	if err != nil {
		return xdr.ScVal{}, fmt.Errorf("bad hex %q: %w", h, err)
	}
	return bytesVal(b), nil
}

// u256FromHex parses a big-endian hex value and left-pads it to 32 bytes.
func u256FromHex(h string) (xdr.ScVal, error) {
	n, ok := new(big.Int).SetString(h, 16)
	if !ok {
		return xdr.ScVal{}, fmt.Errorf("bad u256 hex %q", h)
	}
	if n.Sign() < 0 {
		return xdr.ScVal{}, fmt.Errorf("negative u256 %q", h)
	}
	raw := n.Bytes()
	if len(raw) > 32 {
		return xdr.ScVal{}, fmt.Errorf("u256 overflow %q", h)
	}
	buf := make([]byte, 32)
	copy(buf[32-len(raw):], raw)
	p := xdr.UInt256Parts{
		HiHi: xdr.Uint64(binary.BigEndian.Uint64(buf[0:8])),
		HiLo: xdr.Uint64(binary.BigEndian.Uint64(buf[8:16])),
		LoHi: xdr.Uint64(binary.BigEndian.Uint64(buf[16:24])),
		LoLo: xdr.Uint64(binary.BigEndian.Uint64(buf[24:32])),
	}
	return xdr.ScVal{Type: xdr.ScValTypeScvU256, U256: &p}, nil
}

// i128Val encodes a signed big.Int as two's-complement Int128Parts. ext_amount
// is negative for withdrawals, so both signs must round-trip.
func i128Val(v *big.Int) xdr.ScVal {
	mask := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 64), big.NewInt(1))
	t := new(big.Int).Set(v)
	if v.Sign() < 0 {
		t.Add(t, new(big.Int).Lsh(big.NewInt(1), 128)) // two's complement over 128 bits
	}
	lo := new(big.Int).And(t, mask).Uint64()
	hi := int64(new(big.Int).Rsh(t, 64).Uint64())
	p := xdr.Int128Parts{Hi: xdr.Int64(hi), Lo: xdr.Uint64(lo)}
	return xdr.ScVal{Type: xdr.ScValTypeScvI128, I128: &p}
}

func addressVal(s string) (xdr.ScVal, error) {
	switch {
	case strkey.IsValidEd25519PublicKey(s):
		aid, err := xdr.AddressToAccountId(s)
		if err != nil {
			return xdr.ScVal{}, err
		}
		a := xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeAccount, AccountId: &aid}
		return xdr.ScVal{Type: xdr.ScValTypeScvAddress, Address: &a}, nil
	case strkey.IsValidContractAddress(s):
		a, err := soroban.ContractAddress(s)
		if err != nil {
			return xdr.ScVal{}, err
		}
		return xdr.ScVal{Type: xdr.ScValTypeScvAddress, Address: &a}, nil
	}
	return xdr.ScVal{}, fmt.Errorf("not a valid address: %q", s)
}

func vecU256(hexes []string) (xdr.ScVal, error) {
	vals := make([]xdr.ScVal, 0, len(hexes))
	for _, h := range hexes {
		v, err := u256FromHex(h)
		if err != nil {
			return xdr.ScVal{}, err
		}
		vals = append(vals, v)
	}
	vec := xdr.ScVec(vals)
	vp := &vec
	return xdr.ScVal{Type: xdr.ScValTypeScvVec, Vec: &vp}, nil
}

func mapVal(entries []xdr.ScMapEntry) xdr.ScVal {
	m := xdr.ScMap(entries)
	mp := &m
	return xdr.ScVal{Type: xdr.ScValTypeScvMap, Map: &mp}
}

func entry(key string, val xdr.ScVal) xdr.ScMapEntry {
	return xdr.ScMapEntry{Key: symVal(key), Val: val}
}

// proofScVal builds the TxProof map with symbol-sorted keys.
func proofScVal(p ProofHex) (xdr.ScVal, error) {
	a, err := bytesFromHex(p.A)
	if err != nil {
		return xdr.ScVal{}, err
	}
	b, err := bytesFromHex(p.B)
	if err != nil {
		return xdr.ScVal{}, err
	}
	c, err := bytesFromHex(p.C)
	if err != nil {
		return xdr.ScVal{}, err
	}
	edh, err := u256FromHex(p.ExtDataHash)
	if err != nil {
		return xdr.ScVal{}, err
	}
	nulls, err := vecU256(p.Nullifiers)
	if err != nil {
		return xdr.ScVal{}, err
	}
	comms, err := vecU256(p.Commitments)
	if err != nil {
		return xdr.ScVal{}, err
	}
	pub, err := u256FromHex(p.PublicAmount)
	if err != nil {
		return xdr.ScVal{}, err
	}
	root, err := u256FromHex(p.Root)
	if err != nil {
		return xdr.ScVal{}, err
	}
	return mapVal([]xdr.ScMapEntry{
		entry("a", a),
		entry("b", b),
		entry("c", c),
		entry("ext_data_hash", edh),
		entry("input_nullifiers", nulls),
		entry("output_commitments", comms),
		entry("public_amount", pub),
		entry("root", root),
	}), nil
}

// extScVal builds the ExtData map with symbol-sorted keys.
func extScVal(e ExtHex) (xdr.ScVal, error) {
	recipient, err := addressVal(e.Recipient)
	if err != nil {
		return xdr.ScVal{}, err
	}
	relayer, err := addressVal(e.Relayer)
	if err != nil {
		return xdr.ScVal{}, err
	}
	return mapVal([]xdr.ScMapEntry{
		entry("encrypted_output0", bytesVal(e.EncryptedOutput0)),
		entry("encrypted_output1", bytesVal(e.EncryptedOutput1)),
		entry("ext_amount", i128Val(e.ExtAmount)),
		entry("fee", i128Val(e.Fee)),
		entry("recipient", recipient),
		entry("relayer", relayer),
	}), nil
}
