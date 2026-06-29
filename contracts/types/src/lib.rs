#![no_std]

//! Shared contract types.

use soroban_sdk::{
    contracterror, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine},
    Address, Bytes, Vec, U256,
};

// Uncompressed affine, big-endian, to match the host's BN254 encoding.
#[contracttype]
#[derive(Clone)]
pub struct Groth16Proof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

#[contracterror]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Groth16Error {
    InvalidProof = 0,
    MalformedPublicInputs = 1,
}

// Proof plus the public signals the vault binds.
// Domain is omitted so a proof cannot replay across vaults.
#[contracttype]
#[derive(Clone)]
pub struct TxProof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
    pub root: U256,
    pub public_amount: U256,
    pub ext_data_hash: U256,
    pub input_nullifiers: Vec<U256>,
    pub output_commitments: Vec<U256>,
}

// Bound by ext_data_hash inside the proof.
// ext_amount sign: positive deposit, negative withdrawal, zero transfer.
#[contracttype]
#[derive(Clone)]
pub struct ExtData {
    pub ext_amount: i128,
    pub fee: i128,
    pub recipient: Address,
    pub relayer: Address,
    pub encrypted_output0: Bytes,
    pub encrypted_output1: Bytes,
}
