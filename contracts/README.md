# Cyphras contracts

Soroban contracts for a shielded-pool vault: a Groth16/BN254 verifier with a
compile-time embedded verification key, a Poseidon2 hash, shared types, and the
vault that ties them together.

## Workspace

- `types` - shared contract types (proof, errors, ext data)
- `poseidon2` - Poseidon2 hash over BN254
- `verifier` - Groth16 verifier with embedded VK (library + contract)
- `vault` - shielded-pool vault; verifies in-process via the verifier library

## Build

```sh
# Build all crates to wasm (wasm32v1-none release).
stellar contract build

# Or with cargo directly:
cargo build --target wasm32v1-none --release
```

The verifier is linked into the vault as a library (`verify_groth16`), so the
vault wasm carries verification end to end. There is no separate verifier
contract to deploy.

## Deploy (testnet)

Edit the placeholders at the top of `scripts/deploy.sh` (or pass them as env
vars), then run:

```sh
SOURCE=testnet-deployer \
SAC_TOKEN_ID=<SAC contract id> \
ADMIN=<admin address> \
DOMAIN=<domain U256> \
bash scripts/deploy.sh
```

The script builds the wasm, deploys the vault to testnet, and calls `init` with
the SAC token id, admin, domain, max deposit, and TVL cap.

## EXPECTED_VK_SHA256 pin

The verifier embeds the verification key at compile time and prints its sha256 as
a build warning (`embedded VK sha256 = ...`). For release and deploy builds, set
`EXPECTED_VK_SHA256` to the audited trusted-setup VK hash:

```sh
EXPECTED_VK_SHA256=<audited vk sha256> stellar contract build --package vault
```

A mismatch fails the build closed, so a wrong, testnet, or unaudited ceremony VK
can never ship silently. Verify the pinned hash by recomputing it from the VK
JSON yourself; do not trust a quoted value.
