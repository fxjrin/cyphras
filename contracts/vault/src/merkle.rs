//! Append-only Poseidon2 Merkle tree with a root-history ring buffer.
//!
//! The frontier, zero-subtree hashes, and root history are each packed into one
//! ledger entry, so an insert touches a handful of entries regardless of depth
//! or history size. Leaves are never stored; they are emitted as events.

use poseidon2::poseidon2_compress;
use soroban_sdk::{contracttype, Env, Vec, U256};

use crate::ttl;

pub const DEPTH: u32 = 20;
pub const ROOT_HISTORY: u32 = 64;

#[contracttype]
#[derive(Clone)]
pub enum MerkleKey {
    Zeros,
    Frontier,
    Roots,
    CurrentRootIndex,
    NextLeafIndex,
}

fn get_vec(env: &Env, key: &MerkleKey) -> Vec<U256> {
    env.storage().persistent().get(key).unwrap()
}

/// Initialize an empty tree: precompute zero-subtree hashes per level, seed the
/// frontier with them, and store the empty root in slot 0.
pub fn init(env: &Env) {
    let s = env.storage().persistent();
    let mut zeros: Vec<U256> = Vec::new(env);
    let mut cur = U256::from_u32(env, 0);
    zeros.push_back(cur.clone());
    for _ in 1..DEPTH {
        cur = poseidon2_compress(env, cur.clone(), cur.clone());
        zeros.push_back(cur.clone());
    }
    let root0 = poseidon2_compress(env, cur.clone(), cur);

    let mut roots: Vec<U256> = Vec::new(env);
    roots.push_back(root0);
    for _ in 1..ROOT_HISTORY {
        roots.push_back(U256::from_u32(env, 0));
    }

    s.set(&MerkleKey::Zeros, &zeros);
    s.set(&MerkleKey::Frontier, &zeros);
    s.set(&MerkleKey::Roots, &roots);
    s.set(&MerkleKey::CurrentRootIndex, &0u32);
    s.set(&MerkleKey::NextLeafIndex, &0u32);
}

/// Insert one leaf, update the frontier, and push the new root into history.
pub fn insert(env: &Env, leaf: U256) -> (u32, U256) {
    let s = env.storage().persistent();
    let zeros = get_vec(env, &MerkleKey::Zeros);
    let mut frontier = get_vec(env, &MerkleKey::Frontier);
    let start_index: u32 = s.get(&MerkleKey::NextLeafIndex).unwrap();

    let mut index = start_index;
    let mut current = leaf;
    for level in 0..DEPTH {
        if index % 2 == 0 {
            frontier.set(level, current.clone());
            let right = zeros.get(level).unwrap();
            current = poseidon2_compress(env, current, right);
        } else {
            let left = frontier.get(level).unwrap();
            current = poseidon2_compress(env, left, current);
        }
        index /= 2;
    }

    let cur_idx: u32 = s.get(&MerkleKey::CurrentRootIndex).unwrap();
    let next_idx = (cur_idx + 1) % ROOT_HISTORY;
    let mut roots = get_vec(env, &MerkleKey::Roots);
    roots.set(next_idx, current.clone());

    s.set(&MerkleKey::Frontier, &frontier);
    s.set(&MerkleKey::Roots, &roots);
    s.set(&MerkleKey::CurrentRootIndex, &next_idx);
    s.set(&MerkleKey::NextLeafIndex, &(start_index + 1));

    (start_index, current)
}

/// Keeper: lift all tree entries to the long TTL window. Writes in `insert`
/// only refresh touched entries to the persistence floor.
pub fn bump_all(env: &Env) {
    let p = env.storage().persistent();
    for key in [
        MerkleKey::Zeros,
        MerkleKey::Frontier,
        MerkleKey::Roots,
        MerkleKey::CurrentRootIndex,
        MerkleKey::NextLeafIndex,
    ] {
        p.extend_ttl(&key, ttl::THRESHOLD, ttl::EXTEND_TO);
    }
}

/// True when fewer than two leaves remain; transact inserts two per call.
pub fn is_full(env: &Env) -> bool {
    let next: u32 = env
        .storage()
        .persistent()
        .get(&MerkleKey::NextLeafIndex)
        .unwrap();
    next + 2 > (1u32 << DEPTH)
}

pub fn current_root(env: &Env) -> U256 {
    let idx: u32 = env
        .storage()
        .persistent()
        .get(&MerkleKey::CurrentRootIndex)
        .unwrap();
    get_vec(env, &MerkleKey::Roots).get(idx).unwrap()
}

/// True if `root` (nonzero) matches any root currently in the history ring.
pub fn is_known_root(env: &Env, root: &U256) -> bool {
    if *root == U256::from_u32(env, 0) {
        return false;
    }
    let roots = get_vec(env, &MerkleKey::Roots);
    for r in roots.iter() {
        if r == *root {
            return true;
        }
    }
    false
}
