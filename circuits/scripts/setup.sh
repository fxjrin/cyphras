#!/usr/bin/env bash
# Phase-2 groth16 trusted setup for transaction.circom on bn254.
# Solo setup is fine for testnet but is technically forgeable; mainnet needs a multi-party ceremony.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
KEYS="$ROOT/keys"
R1CS="$BUILD/transaction.r1cs"
PTAU="$KEYS/powersOfTau28_hez_final_16.ptau"

# Phase-1 powers-of-tau (Hermez, power 16 = 65536 constraints).
if [ ! -f "$PTAU" ]; then
  echo "missing $PTAU" >&2
  echo "download: https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau" >&2
  exit 1
fi

if [ ! -f "$R1CS" ]; then
  echo "missing $R1CS, run: npm run build" >&2
  exit 1
fi

mkdir -p "$KEYS"

INIT_ZKEY="$KEYS/transaction_0000.zkey"
CONTRIB_ZKEY="$KEYS/transaction_0001.zkey"
FINAL_ZKEY="$KEYS/transaction.zkey"
VK="$KEYS/verification_key.json"

snarkjs groth16 setup "$R1CS" "$PTAU" "$INIT_ZKEY"

# One contribution with strong OS entropy (non-interactive).
ENTROPY="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
snarkjs zkey contribute "$INIT_ZKEY" "$CONTRIB_ZKEY" --name="solo-testnet-contribution" -e="$ENTROPY"

# Random beacon finalizes phase 2.
BEACON="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
snarkjs zkey beacon "$CONTRIB_ZKEY" "$FINAL_ZKEY" "$BEACON" 10 --name="final-beacon"

snarkjs zkey export verificationkey "$FINAL_ZKEY" "$VK"

# Keep only the final zkey + vk.
rm -f "$INIT_ZKEY" "$CONTRIB_ZKEY"

echo "setup done:"
echo "  $FINAL_ZKEY"
echo "  $VK"
