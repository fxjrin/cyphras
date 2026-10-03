package indexer

import (
	"encoding/binary"
	"fmt"

	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/xdr"
)

type eventKind int

const (
	kindCommitment eventKind = iota
	kindNullifier
)

// decodedEvent is a vault event flattened to exactly what the DB stores. Field
// names mirror offchain/indexer/src/ingest.ts's Decoded interface.
type decodedEvent struct {
	id     string
	kind   eventKind
	index  uint32 // commitment only
	value  []byte // 32-byte commitment or nullifier (big-endian)
	enc    []byte // encrypted_output, commitment only
	ledger int32
	txHash string
}

// u256Bytes reassembles a U256 into its 32-byte big-endian form, matching the
// TS `buf(bigint)` = 32-byte hex the commitments/nullifiers columns store.
func u256Bytes(p xdr.UInt256Parts) []byte {
	b := make([]byte, 32)
	binary.BigEndian.PutUint64(b[0:8], uint64(p.HiHi))
	binary.BigEndian.PutUint64(b[8:16], uint64(p.HiLo))
	binary.BigEndian.PutUint64(b[16:24], uint64(p.LoHi))
	binary.BigEndian.PutUint64(b[24:32], uint64(p.LoLo))
	return b
}

// scMap flattens an ScVal map into symbol-keyed fields.
func scMap(v xdr.ScVal) (map[string]xdr.ScVal, error) {
	m, ok := v.GetMap()
	if !ok || m == nil {
		return nil, fmt.Errorf("event value is not a map")
	}
	out := make(map[string]xdr.ScVal, len(*m))
	for _, e := range *m {
		sym, ok := e.Key.GetSym()
		if !ok {
			return nil, fmt.Errorf("event map key is not a symbol")
		}
		out[string(sym)] = e.Val
	}
	return out, nil
}

// decodeEvent parses a vault contract event; returns (nil, nil) for events we
// do not track, mirroring the TS decode() returning null.
func decodeEvent(e protocol.EventInfo) (*decodedEvent, error) {
	if len(e.TopicXDR) < 1 {
		return nil, nil
	}
	var topic0 xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(e.TopicXDR[0], &topic0); err != nil {
		return nil, fmt.Errorf("decode topic: %w", err)
	}
	name, ok := topic0.GetSym()
	if !ok {
		return nil, nil
	}
	var val xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(e.ValueXDR, &val); err != nil {
		return nil, fmt.Errorf("decode value: %w", err)
	}
	fields, err := scMap(val)
	if err != nil {
		return nil, err
	}

	switch string(name) {
	case "new_commitment":
		idx, ok := fields["index"].GetU32()
		if !ok {
			return nil, fmt.Errorf("commitment index is not u32")
		}
		cval, ok := fields["commitment"].GetU256()
		if !ok {
			return nil, fmt.Errorf("commitment is not u256")
		}
		enc, ok := fields["encrypted_output"].GetBytes()
		if !ok {
			return nil, fmt.Errorf("encrypted_output is not bytes")
		}
		return &decodedEvent{
			id: e.ID, kind: kindCommitment, index: uint32(idx),
			value: u256Bytes(cval), enc: []byte(enc),
			ledger: e.Ledger, txHash: e.TransactionHash,
		}, nil
	case "new_nullifier":
		nval, ok := fields["nullifier"].GetU256()
		if !ok {
			return nil, fmt.Errorf("nullifier is not u256")
		}
		return &decodedEvent{
			id: e.ID, kind: kindNullifier, value: u256Bytes(nval),
			ledger: e.Ledger, txHash: e.TransactionHash,
		}, nil
	}
	return nil, nil
}
