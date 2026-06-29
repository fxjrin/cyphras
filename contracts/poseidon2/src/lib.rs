#![no_std]

//! Poseidon2 over BN254 (t=2 compression, t=3 hash) using the CAP-0075 host
//! permutation, with parameters that match the circom `poseidon2_compress`
//! template. The parity test below pins reference vectors so the on-chain hash
//! and the in-circuit hash cannot silently diverge.
//!
//! The permutation constants and the compression/hash wrappers are vendored
//! from NethermindEth/stellar-private-payments (Apache-2.0); see ATTRIBUTION.md.

pub mod constants;
pub mod poseidon2;

pub use poseidon2::{poseidon2_compress, poseidon2_hash2};

#[cfg(test)]
mod parity_test;
