extern crate std;

use soroban_sdk::{Bytes, Env, U256};
use std::vec::Vec as StdVec;

use crate::poseidon2::poseidon2_compress;

fn to_hex(env: &Env, x: &U256) -> std::string::String {
    let bytes: Bytes = x.to_be_bytes();
    let mut buf = StdVec::new();
    for b in bytes.iter() {
        buf.push(b);
    }
    buf.iter().map(|b| std::format!("{b:02x}")).collect()
}

// Pins on-chain Poseidon2 compression outputs. The same inputs run through the
// circom poseidon2_compress circuit must produce identical field elements;
// scripts/poseidon2-parity.sh regenerates and checks the circom side.
#[test]
fn compress_reference_vectors() {
    let env = Env::default();

    let cases = [(7u32, 11u32), (0u32, 0u32), (1u32, 2u32)];
    for (l, r) in cases {
        let left = U256::from_u32(&env, l);
        let right = U256::from_u32(&env, r);
        let out = poseidon2_compress(&env, left, right);
        std::println!("compress({l},{r}) = {}", to_hex(&env, &out));
    }

    // Locked vector for (7, 11). Filled from the first run, then cross-checked
    // against the circom witness output in scripts/poseidon2-parity.sh.
    let out = poseidon2_compress(&env, U256::from_u32(&env, 7), U256::from_u32(&env, 11));
    assert_eq!(to_hex(&env, &out), EXPECTED_7_11);
}

// Cross-checked against the circom poseidon2_compress witness (identical).
const EXPECTED_7_11: &str = "0960972bcfa9d858be6a1cca2c850d2eb0e5df1ad309192beeb95f8be328945f";
