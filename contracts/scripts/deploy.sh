#!/usr/bin/env bash
# Build the contracts workspace to wasm and deploy the vault to Stellar testnet.
set -euo pipefail

# Resolve repo paths relative to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WASM_DIR="${CONTRACTS_DIR}/target/wasm32v1-none/release"

# Deploy identity and network (must already exist in the stellar CLI keychain).
SOURCE="${SOURCE:-testnet-deployer}"
NETWORK="${NETWORK:-testnet}"

# Init args: fill these with the real values before running.
SAC_TOKEN_ID="${SAC_TOKEN_ID:-PLACEHOLDER_SAC_CONTRACT_ID}" # SAC token contract id
ADMIN="${ADMIN:-PLACEHOLDER_ADMIN_ADDRESS}"                 # vault admin address
DOMAIN="${DOMAIN:-PLACEHOLDER_DOMAIN_U256}"                 # domain separator (U256)
MAX_DEPOSIT="${MAX_DEPOSIT:-1000000000}"                    # per-deposit cap (stroops)
TVL_CAP="${TVL_CAP:-1000000000000}"                         # total value locked cap (stroops)

# The verifier is library-embedded into the vault wasm; building the vault builds it.
# Fail closed unless the embedded VK matches this hash (override to re-pin a new setup).
export EXPECTED_VK_SHA256="${EXPECTED_VK_SHA256:-0e4e9d81c4a30c4969fa9e66c098934f53a23490a914cf1b5be6ef638c056c3e}"

echo "Building vault to wasm (VK pin enforced)..."
stellar contract build --package vault

echo "Deploying vault to ${NETWORK}..."
VAULT_ID="$(stellar contract deploy \
  --wasm "${WASM_DIR}/vault.wasm" \
  --source "${SOURCE}" \
  --network "${NETWORK}")"
echo "Vault deployed: ${VAULT_ID}"

echo "Initializing vault..."
stellar contract invoke \
  --id "${VAULT_ID}" \
  --source "${SOURCE}" \
  --network "${NETWORK}" \
  -- init \
  --admin "${ADMIN}" \
  --token "${SAC_TOKEN_ID}" \
  --domain "${DOMAIN}" \
  --max_deposit "${MAX_DEPOSIT}" \
  --tvl_cap "${TVL_CAP}"

echo "Done. Vault id: ${VAULT_ID}"
