//! Nullifier set with O(1)-per-spend storage.
//!
//! Each nullifier is its own persistent entry, so a spend reads and writes only
//! that key regardless of set size. A single growing map would cap the pool at
//! one ledger entry and make every spend costlier over time. Archived entries
//! must be restored, never recreated, so an archived nullifier cannot reopen a
//! double-spend.

use soroban_sdk::{contracttype, Env, U256};

use crate::ttl;

#[contracttype]
#[derive(Clone)]
pub enum NullifierKey {
    Spent(U256),
}

pub fn is_spent(env: &Env, n: &U256) -> bool {
    env.storage()
        .persistent()
        .has(&NullifierKey::Spent(n.clone()))
}

/// Record a nullifier as spent. Returns false if it was already spent.
pub fn mark_spent(env: &Env, n: &U256) -> bool {
    if is_spent(env, n) {
        return false;
    }
    let key = NullifierKey::Spent(n.clone());
    env.storage().persistent().set(&key, &());
    env.storage()
        .persistent()
        .extend_ttl(&key, ttl::THRESHOLD, ttl::EXTEND_TO);
    true
}
