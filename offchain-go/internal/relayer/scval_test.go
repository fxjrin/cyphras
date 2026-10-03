package relayer

import (
	"math/big"
	"strings"
	"testing"

	"github.com/stellar/go-stellar-sdk/xdr"
)

// Expected base64 produced by the canonical TypeScript builders in
// offchain/relayer/src/scval.ts for the fixed vector below. Byte-identical Go
// output proves the two encoders agree, so the contract accepts either.
const (
	wantProof = "AAAAEQAAAAEAAAAIAAAADwAAAAFhAAAAAAAADQAAAEABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAADwAAAAFiAAAAAAAADQAAAIACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAA8AAAABYwAAAAAAAA0AAABAAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwAAAA8AAAANZXh0X2RhdGFfaGFzaAAAAAAAAAsPDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDwAAAA8AAAAQaW5wdXRfbnVsbGlmaWVycwAAABAAAAABAAAAAgAAAAsREREREREREREREREREREREREREREREREREREREREREQAAAAsSEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEgAAAA8AAAASb3V0cHV0X2NvbW1pdG1lbnRzAAAAAAAQAAAAAQAAAAIAAAALISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEAAAALIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIAAAAPAAAADXB1YmxpY19hbW91bnQAAAAAAAALAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAPAAAABHJvb3QAAAALCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo="
	wantExt   = "AAAAEQAAAAEAAAAGAAAADwAAABFlbmNyeXB0ZWRfb3V0cHV0MAAAAAAAAA0AAAAE3q2+7wAAAA8AAAARZW5jcnlwdGVkX291dHB1dDEAAAAAAAANAAAAAsr+AAAAAAAPAAAACmV4dF9hbW91bnQAAAAAAAr/////////////////8L3AAAAADwAAAANmZWUAAAAACgAAAAAAAAAAAAAAAAAAw1AAAAAPAAAACXJlY2lwaWVudAAAAAAAABIAAAAAAAAAACTi+apKbYJwAdSLdXoj16ocGs1WlL/NeZ6lvEZbbGFjAAAADwAAAAdyZWxheWVyAAAAABIAAAAAAAAAACTi+apKbYJwAdSLdXoj16ocGs1WlL/NeZ6lvEZbbGFj"
)

const poolRelayer = "GASOF6NKJJWYE4AB2SFXK6RD26VBYGWNK2KL7TLZT2S3YRS3NRQWH4UQ"

func TestProofScValMatchesTS(t *testing.T) {
	p := ProofHex{
		A:            strings.Repeat("01", 64),
		B:            strings.Repeat("02", 128),
		C:            strings.Repeat("03", 64),
		Root:         strings.Repeat("0a", 32),
		PublicAmount: "05",
		ExtDataHash:  strings.Repeat("0f", 32),
		Nullifiers:   []string{strings.Repeat("11", 32), strings.Repeat("12", 32)},
		Commitments:  []string{strings.Repeat("21", 32), strings.Repeat("22", 32)},
	}
	v, err := proofScVal(p)
	if err != nil {
		t.Fatal(err)
	}
	got, err := xdr.MarshalBase64(v)
	if err != nil {
		t.Fatal(err)
	}
	if got != wantProof {
		t.Errorf("proof ScVal differs from TS:\n got=%s\nwant=%s", got, wantProof)
	}
}

func TestExtScValMatchesTS(t *testing.T) {
	e := ExtHex{
		ExtAmount:        big.NewInt(-1000000), // withdrawal: negative, exercises i128 two's complement
		Fee:              big.NewInt(50000),
		Recipient:        poolRelayer,
		Relayer:          poolRelayer,
		EncryptedOutput0: []byte{0xde, 0xad, 0xbe, 0xef},
		EncryptedOutput1: []byte{0xca, 0xfe},
	}
	v, err := extScVal(e)
	if err != nil {
		t.Fatal(err)
	}
	got, err := xdr.MarshalBase64(v)
	if err != nil {
		t.Fatal(err)
	}
	if got != wantExt {
		t.Errorf("ext ScVal differs from TS:\n got=%s\nwant=%s", got, wantExt)
	}
}
