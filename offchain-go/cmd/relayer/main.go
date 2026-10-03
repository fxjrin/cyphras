// Relayer service entrypoint. Fails fast at boot if RELAYER_SECRET's pubkey does
// not equal the pool relayerAddress, since the vault refunds fees to that exact
// address and a mismatched signer would front gas unreimbursed.
package main

import (
	"context"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/cyphras/offchain-go/internal/config"
	"github.com/cyphras/offchain-go/internal/logclient"
	"github.com/cyphras/offchain-go/internal/relayer"
	"github.com/cyphras/offchain-go/internal/soroban"
	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/network"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	rpcURL := config.Get("RPC_URL", "https://soroban-testnet.stellar.org")
	passphrase := config.Get("NETWORK_PASSPHRASE", network.TestNetworkPassphrase)
	vault := config.MustGet("VAULT_CONTRACT_ID")
	secret := config.MustGet("RELAYER_SECRET")
	poolRelayer := config.Get("POOL_RELAYER_ADDRESS", "GASOF6NKJJWYE4AB2SFXK6RD26VBYGWNK2KL7TLZT2S3YRS3NRQWH4UQ")
	addr := ":" + config.Get("PORT", "8081")

	signer, err := keypair.ParseFull(secret)
	if err != nil {
		log.Fatalf("bad RELAYER_SECRET: %v", err)
	}
	if signer.Address() != poolRelayer {
		log.Fatalf("RELAYER_SECRET pubkey %s != pool relayerAddress %s; the vault would pay fees to a different account",
			signer.Address(), poolRelayer)
	}

	client := soroban.NewClient(rpcURL, passphrase)
	defer client.Close()

	lc := logclient.New("cy1-relayer", config.Get("ADMIN_API_URL", ""), config.Get("ADMIN_API_SHARED_SECRET", ""))

	rl := relayer.New(client, signer, relayer.Config{
		Vault:          vault,
		NetCost:        config.GetInt64("NET_COST", 700_000),
		MarginBps:      config.GetInt64("MARGIN_BPS", 2_000),
		MinMarginBps:   config.GetInt64("MIN_MARGIN_BPS", 500),
		QuoteBufferBps: config.GetInt64("QUOTE_BUFFER_BPS", 1_000),
		RatePPM:        config.GetInt64("RATE_PPM", 1_000_000),
	}, lc)

	srv := &http.Server{Addr: addr, Handler: rl.Handler()}
	go func() {
		<-ctx.Done()
		sd, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sd)
	}()
	log.Printf("relayer on %s (relayer=%s vault=%s)", addr, signer.Address(), vault)
	lc.Log("startup", "info", nil, map[string]any{"relayer": signer.Address(), "vault": vault})
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}
