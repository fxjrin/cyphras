#![no_std]

//! Groth16/BN254 verifier with a verification key embedded at compile time via build.rs.

use soroban_sdk::{
    contract, contractimpl,
    crypto::bn254::{Bn254Fr, Bn254G1Affine as G1, Bn254G2Affine as G2},
    vec, BytesN, Env, Vec,
};
use types::{Groth16Error, Groth16Proof};

include!(concat!(env!("OUT_DIR"), "/vk.rs"));

struct VerificationKey {
    alpha: G1,
    beta: G2,
    gamma: G2,
    delta: G2,
    ic: Vec<G1>,
}

fn embedded_vk(env: &Env) -> VerificationKey {
    let mut ic: Vec<G1> = Vec::new(env);
    for bytes in VK_IC.iter() {
        ic.push_back(G1::from_bytes(BytesN::from_array(env, bytes)));
    }
    VerificationKey {
        alpha: G1::from_bytes(BytesN::from_array(env, &VK_ALPHA_G1)),
        beta: G2::from_bytes(BytesN::from_array(env, &VK_BETA_G2)),
        gamma: G2::from_bytes(BytesN::from_array(env, &VK_GAMMA_G2)),
        delta: G2::from_bytes(BytesN::from_array(env, &VK_DELTA_G2)),
        ic,
    }
}

/// Verify a Groth16 proof against the embedded key. Library entry so the vault
/// can verify in-process; returns true only for a valid proof.
pub fn verify_groth16(env: &Env, proof: &Groth16Proof, public_inputs: &Vec<Bn254Fr>) -> bool {
    let vk = embedded_vk(env);
    let bn = env.crypto().bn254();

    // IC has one extra point for the constant term.
    if public_inputs.len().checked_add(1) != Some(vk.ic.len()) {
        return false;
    }

    let mut vk_x = match vk.ic.get(0) {
        Some(p) => p,
        None => return false,
    };
    for i in 0..public_inputs.len() {
        let s = public_inputs.get(i).unwrap();
        let term = match vk.ic.get(i + 1) {
            Some(t) => t,
            None => return false,
        };
        vk_x = bn.g1_add(&vk_x, &bn.g1_mul(&term, &s));
    }

    #[allow(clippy::arithmetic_side_effects)]
    let neg_a = -proof.a.clone();
    let g1_points = vec![env, neg_a, vk.alpha, vk_x, proof.c.clone()];
    let g2_points = vec![env, proof.b.clone(), vk.beta, vk.gamma, vk.delta];

    bn.pairing_check(g1_points, g2_points)
}

#[contract]
pub struct Verifier;

#[contractimpl]
impl Verifier {
    /// Verify a Groth16 proof against the embedded key.
    pub fn verify(
        env: Env,
        proof: Groth16Proof,
        public_inputs: Vec<Bn254Fr>,
    ) -> Result<bool, Groth16Error> {
        if verify_groth16(&env, &proof, &public_inputs) {
            Ok(true)
        } else {
            Err(Groth16Error::InvalidProof)
        }
    }
}
