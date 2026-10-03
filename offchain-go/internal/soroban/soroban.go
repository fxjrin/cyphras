// Package soroban wraps the Stellar RPC client with the one thing every service
// here needs: build an InvokeHostFunction, simulate it, fold the simulation's
// footprint/resource-fee/auth back in, sign, and submit. This is the Go
// equivalent of the JS SDK's getAccount -> prepareTransaction -> sign -> send.
package soroban

import (
	"context"
	"fmt"

	"github.com/stellar/go-stellar-sdk/clients/rpcclient"
	"github.com/stellar/go-stellar-sdk/keypair"
	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"
)

type Client struct {
	rpc        *rpcclient.Client
	passphrase string
}

func NewClient(rpcURL, passphrase string) *Client {
	return &Client{rpc: rpcclient.NewClient(rpcURL, nil), passphrase: passphrase}
}

func (c *Client) Close()                 { c.rpc.Close() }
func (c *Client) RPC() *rpcclient.Client { return c.rpc }

// ContractAddress turns a C... strkey contract id into an ScAddress.
func ContractAddress(contractID string) (xdr.ScAddress, error) {
	raw, err := strkey.Decode(strkey.VersionByteContract, contractID)
	if err != nil {
		return xdr.ScAddress{}, fmt.Errorf("decode contract id %q: %w", contractID, err)
	}
	var cid xdr.ContractId
	copy(cid[:], raw)
	return xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeContract, ContractId: &cid}, nil
}

// Invoke builds an InvokeHostFunction op calling fn(args...) on contractID, sourced from source.
func Invoke(contractID, source, fn string, args []xdr.ScVal) (*txnbuild.InvokeHostFunction, error) {
	addr, err := ContractAddress(contractID)
	if err != nil {
		return nil, err
	}
	return &txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
			InvokeContract: &xdr.InvokeContractArgs{
				ContractAddress: addr,
				FunctionName:    xdr.ScSymbol(fn),
				Args:            args,
			},
		},
		SourceAccount: source,
	}, nil
}

type SubmitResult struct {
	Hash string
	Fee  int64 // total fee paid in stroops: inclusion (MinBaseFee) + resource fee
}

// PreparedTx is a simulated, assembled, unsigned transaction ready to sign and
// send. Fee is the XLM gas the source will pay, exposed so a caller (the relayer)
// can validate a user-supplied fee against the real simulated cost before sending.
type PreparedTx struct {
	tx  *txnbuild.Transaction
	Fee int64
}

// Prepare runs build -> simulate -> assemble for a single InvokeHostFunction: it
// mutates op in place with the simulation's SorobanData and auth entries and
// returns the final unsigned transaction. Equivalent to the JS getAccount +
// prepareTransaction step, split out so callers can inspect the fee first.
func (c *Client) Prepare(ctx context.Context, signer *keypair.Full, op *txnbuild.InvokeHostFunction) (*PreparedTx, error) {
	acct, err := c.rpc.LoadAccount(ctx, signer.Address())
	if err != nil {
		return nil, fmt.Errorf("load account: %w", err)
	}
	seq, err := acct.GetSequenceNumber()
	if err != nil {
		return nil, fmt.Errorf("read sequence: %w", err)
	}

	// Rebuilt from the same captured sequence so both envelopes match.
	build := func(baseFee int64) (*txnbuild.Transaction, error) {
		return txnbuild.NewTransaction(txnbuild.TransactionParams{
			SourceAccount:        &txnbuild.SimpleAccount{AccountID: signer.Address(), Sequence: seq},
			IncrementSequenceNum: true,
			Operations:           []txnbuild.Operation{op},
			BaseFee:              baseFee,
			Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(300)},
		})
	}

	tx, err := build(txnbuild.MinBaseFee)
	if err != nil {
		return nil, fmt.Errorf("build for simulation: %w", err)
	}
	simXDR, err := tx.Base64()
	if err != nil {
		return nil, err
	}

	sim, err := c.rpc.SimulateTransaction(ctx, protocol.SimulateTransactionRequest{Transaction: simXDR})
	if err != nil {
		return nil, fmt.Errorf("simulate: %w", err)
	}
	if sim.Error != "" {
		return nil, fmt.Errorf("simulation failed: %s", sim.Error)
	}

	var sorobanData xdr.SorobanTransactionData
	if err := xdr.SafeUnmarshalBase64(sim.TransactionDataXDR, &sorobanData); err != nil {
		return nil, fmt.Errorf("decode soroban data: %w", err)
	}
	op.Ext = xdr.TransactionExt{V: 1, SorobanData: &sorobanData}

	// transact carries proof-bound auth resolved by the simulation; bump_ttl has none.
	if len(sim.Results) > 0 && sim.Results[0].AuthXDR != nil {
		for _, encoded := range *sim.Results[0].AuthXDR {
			var entry xdr.SorobanAuthorizationEntry
			if err := xdr.SafeUnmarshalBase64(encoded, &entry); err != nil {
				return nil, fmt.Errorf("decode auth entry: %w", err)
			}
			op.Auth = append(op.Auth, entry)
		}
	}

	// One operation, so the fee is inclusion + the simulated resource fee.
	fee := int64(txnbuild.MinBaseFee) + sim.MinResourceFee
	final, err := build(fee)
	if err != nil {
		return nil, fmt.Errorf("rebuild with fee: %w", err)
	}
	return &PreparedTx{tx: final, Fee: fee}, nil
}

// Send signs and submits a prepared transaction.
func (c *Client) Send(ctx context.Context, signer *keypair.Full, p *PreparedTx) (SubmitResult, error) {
	signed, err := p.tx.Sign(c.passphrase, signer)
	if err != nil {
		return SubmitResult{}, fmt.Errorf("sign: %w", err)
	}
	signedXDR, err := signed.Base64()
	if err != nil {
		return SubmitResult{}, err
	}
	send, err := c.rpc.SendTransaction(ctx, protocol.SendTransactionRequest{Transaction: signedXDR})
	if err != nil {
		return SubmitResult{}, fmt.Errorf("send: %w", err)
	}
	if send.Status == "ERROR" {
		return SubmitResult{}, fmt.Errorf("send rejected: %s", send.ErrorResultXDR)
	}
	return SubmitResult{Hash: send.Hash, Fee: p.Fee}, nil
}

// Submit is the prepare-then-send convenience used by the keeper.
func (c *Client) Submit(ctx context.Context, signer *keypair.Full, op *txnbuild.InvokeHostFunction) (SubmitResult, error) {
	p, err := c.Prepare(ctx, signer, op)
	if err != nil {
		return SubmitResult{}, err
	}
	return c.Send(ctx, signer, p)
}
