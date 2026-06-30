# Cyphras shielded off-chain services

Turns the on-chain shielded XLM pool into a usable wallet experience on testnet.
Everything here is reconstructable from chain history; none of it is a source of
truth for funds. The vault contract is the only authority.

## Architecture

```
   wallet (browser extension)
     |  prove (snarkjs WASM) + build ExtData (Stellar JS SDK XDR)
     v
   relayer  --submit-->  vault contract (Soroban testnet)
     ^                       |  events: new_commitment / new_nullifier
     |  fee in-asset (XLM)   v
   indexer  <--getEvents--  Soroban RPC
     |  (Postgres: commitments, nullifiers)
     v
   wallet  <--/notes /nullifier /stream-- indexer API
```

## Services

- postgres: the indexer's durable store (commitments, nullifiers). Bound
  to loopback only; not exposed to the public network.
- indexer: ingests vault events from Soroban RPC and serves the wallet the notes
  it needs to scan and the nullifier status it needs to detect spent notes.
- relayer: accepts a client-built {proof, ExtData}, becomes the tx source, and
  submits transact. The vault pays ext.fee to the relayer in-asset, reimbursing
  the XLM gas it fronts. Submitting via the relayer breaks the link between a
  spend and the user's own Stellar account.
- keeper: periodically calls bump_ttl to keep pool state alive within the
  Soroban rent window.

Proving is client-side in the extension; there is no prover service here. The
pool is XLM (native) only.

## Local run

1. `cp .env.example .env` and fill in RELAYER_SECRET, KEEPER_SECRET, and
   POSTGRES_PASSWORD. Leave VAULT_CONTRACT_ID at its default (the deployed
   testnet vault) unless pointing at a different deploy.
2. `docker compose up`. This starts Postgres (schema auto-applied from
   db/schema.sql), the indexer (loopback :8080), the relayer (loopback :8081),
   and the keeper.

## Indexer API

- `GET /health` - readiness; reports not-ready when sync lag exceeds the
  configured threshold so the wallet does not trust a partial leaf set.
- `GET /notes?since=<leafIndex>` - commitments + encrypted outputs to scan and
  decrypt, ordered by leaf index.
- `GET /nullifier/:hex` - whether a 32-byte nullifier (hex) is already spent.
- `GET /stream` - server-sent events pushing a wake signal each time a new
  commitment (leaf) is ingested.

## Relayer API

- `GET /quote` - itemized fee quote: total fee, net gas cost, margin, margin in
  bps, and whether the estimate is calibrated. The wallet bakes the fee into the
  proof before submitting.
- `POST /submit` - body {proof, ext}; submits transact as the relayer source and
  returns {hash}.

## Critical: relayer identity

RELAYER_SECRET's public key MUST equal the pool relayerAddress
GASOF6NKJJWYE4AB2SFXK6RD26VBYGWNK2KL7TLZT2S3YRS3NRQWH4UQ. The vault transfers
ext.fee to that exact address. If the running signer differs, the relayer fronts
the XLM gas on every submit and is never reimbursed.

## Production hosting

Production runs behind host nginx, which terminates TLS and path-routes
https://private.cyphras.com/indexer/* and /relayer/* to the loopback-bound
services. See deploy/nginx.private.cyphras.com.conf; certbot --nginx manages the
certificate for private.cyphras.com.
