//! Field-arithmetic helpers and public-input construction for transact.

use poseidon2::constants::bn256_modulus;
use soroban_sdk::{crypto::bn254::Bn254Fr, xdr::ToXdr, Bytes, BytesN, Env, Vec, U256};
use types::{ExtData, TxProof};

fn u128_to_u256(env: &Env, v: u128) -> U256 {
    let mut buf = [0u8; 32];
    buf[16..].copy_from_slice(&v.to_be_bytes());
    U256::from_be_bytes(env, &Bytes::from_array(env, &buf))
}

pub fn u256_to_fr(env: &Env, x: &U256) -> Bn254Fr {
    let b = x.to_be_bytes();
    let len = b.len();
    let mut buf = [0u8; 32];
    for i in 0..len {
        buf[(32 - len + i) as usize] = b.get(i).unwrap();
    }
    Bn254Fr::from_bytes(BytesN::from_array(env, &buf))
}

/// True if `x` is canonical (`x < p`). Otherwise x and x + p map to the same
/// field element and the on-chain U256 equality checks would not match the
/// value the proof binds.
pub fn is_canonical(env: &Env, x: &U256) -> bool {
    *x < bn256_modulus(env)
}

/// publicAmount = `signed` (= ext_amount - fee) as a field element, wrapping
/// negatives to modulus - |signed|. Matches `sumIns + publicAmount == sumOuts`.
/// `signed` must be > i128::MIN; the caller computes it with checked_sub.
pub fn calc_public_amount(env: &Env, signed: i128) -> U256 {
    if signed >= 0 {
        u128_to_u256(env, signed as u128)
    } else {
        let abs = u128_to_u256(env, signed.unsigned_abs());
        bn256_modulus(env).sub(&abs)
    }
}

/// Binds the external data: keccak256 of its XDR, reduced into the field. The
/// client computes the same value and the circuit carries it as a public input.
pub fn hash_ext_data(env: &Env, ext: &ExtData) -> U256 {
    let payload = ext.clone().to_xdr(env);
    let digest: BytesN<32> = env.crypto().keccak256(&payload).into();
    U256::from_be_bytes(env, &Bytes::from(digest)).rem_euclid(&bn256_modulus(env))
}

/// Public inputs in the circuit's declared order:
/// root, publicAmount, extDataHash, domain, inputNullifier[2], outputCommitment[2].
pub fn public_inputs(env: &Env, proof: &TxProof, domain: &U256) -> Vec<Bn254Fr> {
    let mut v: Vec<Bn254Fr> = Vec::new(env);
    v.push_back(u256_to_fr(env, &proof.root));
    v.push_back(u256_to_fr(env, &proof.public_amount));
    v.push_back(u256_to_fr(env, &proof.ext_data_hash));
    v.push_back(u256_to_fr(env, domain));
    for n in proof.input_nullifiers.iter() {
        v.push_back(u256_to_fr(env, &n));
    }
    for c in proof.output_commitments.iter() {
        v.push_back(u256_to_fr(env, &c));
    }
    v
}
