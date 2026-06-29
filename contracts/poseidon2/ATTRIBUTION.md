# Attribution

`src/constants.rs` and `src/poseidon2.rs` are vendored from
NethermindEth/stellar-private-payments, licensed under Apache-2.0. They wrap the
CAP-0075 `poseidon2_permutation` host function with BN254 t=2/t=3 parameters.

The circom side (`circuits/lib/poseidon2/*.circom`) is from the same source.

Parity between the two is independently verified in this repo: the on-chain
output (src/parity_test.rs) is cross-checked bit-for-bit against the circom
witness (scripts/poseidon2-parity.sh). Verified vector:

  poseidon2_compress(7, 11) =
  0960972bcfa9d858be6a1cca2c850d2eb0e5df1ad309192beeb95f8be328945f

A copy of the Apache-2.0 license terms applies to the vendored files; see
https://github.com/NethermindEth/stellar-private-payments.
