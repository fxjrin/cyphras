// Indexer: ingests vault events from Soroban RPC into Postgres and serves the
// wallet API (/notes, /nullifier, /stream, /health). Go port of offchain/indexer.
package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/cyphras/offchain-go/internal/config"
	"github.com/cyphras/offchain-go/internal/indexer"
	"github.com/cyphras/offchain-go/internal/logclient"
	"github.com/cyphras/offchain-go/internal/soroban"
	"github.com/stellar/go-stellar-sdk/network"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	rpcURL := config.Get("RPC_URL", "https://soroban-testnet.stellar.org")
	passphrase := config.Get("NETWORK_PASSPHRASE", network.TestNetworkPassphrase)
	vault := config.MustGet("VAULT_CONTRACT_ID")
	dbURL := config.MustGet("DATABASE_URL")
	confirmations := config.GetInt64("CONFIRMATIONS", 1)
	syncLagLimit := config.GetInt64("SYNC_LAG_THRESHOLD", 100)
	addr := ":" + config.Get("PORT", "8080")

	db, err := indexer.NewDB(ctx, dbURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer db.Close()

	client := soroban.NewClient(rpcURL, passphrase)
	defer client.Close()

	lc := logclient.New("cy1-indexer", config.Get("ADMIN_API_URL", ""), config.Get("ADMIN_API_SHARED_SECRET", ""))

	ix := indexer.New(client, db, vault, confirmations, lc)
	hub := indexer.NewHub()
	go hub.Listen(ctx, db.Pool())
	go ix.Run(ctx)

	api := indexer.NewAPI(db, hub, ix, syncLagLimit)
	if err := indexer.StartServer(ctx, addr, api.Handler()); err != nil {
		log.Fatalf("server: %v", err)
	}
}
