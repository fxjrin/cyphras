# circuits

groth16 (bn254) tooling for `src/transaction.circom`, built with circom 2.2.2 and snarkjs.

The `circom` 2.x compiler is a standalone binary (install separately, not via npm). snarkjs and circomlib come from npm.

## Install

```
npm install
```

## Build

Compiles the circuit to `build/`, resolving includes from `lib/` and `node_modules/` (circomlib):

```
npm run build
```

Emits `build/transaction.r1cs`, `build/transaction.sym`, and `build/transaction_js/transaction.wasm`.

## Trusted setup

Phase-2 groth16 setup. Requires the phase-1 Hermez powers-of-tau file at `keys/powersOfTau28_hez_final_16.ptau` (power 16 = 65536 constraints):

```
curl -L -o keys/powersOfTau28_hez_final_16.ptau \
  https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau
npm run setup
```

One contribution with OS-random entropy, then a random beacon. A solo setup is fine for testnet but is technically forgeable; mainnet needs a multi-party ceremony. Emits `keys/transaction.zkey` and `keys/verification_key.json`.

## Prove / verify

Provide your own witness at `build/input.json`, then:

```
npm run prove
npm run verify
```
