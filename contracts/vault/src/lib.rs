#![no_std]

//! Shielded-pool vault: custody, the Poseidon2 Merkle tree, the nullifier set,
//! key registration, and the transact entry point.

pub mod merkle;
pub mod nullifier;
pub mod tx;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, Bytes, BytesN, Env, U256,
};
use types::{ExtData, Groth16Proof, TxProof};

// EXTEND_TO stays below any plausible network max_entry_ttl so extend_ttl can
// never exceed the limit and panic, which would freeze every spend. A keeper
// re-bumps before THRESHOLD.
pub mod ttl {
    pub const THRESHOLD: u32 = 200_000;
    pub const EXTEND_TO: u32 = 500_000;
}

#[contracterror]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    StaleVersion = 3,
    UnknownRoot = 4,
    SpentNullifier = 5,
    WrongExtHash = 6,
    WrongPublicAmount = 7,
    InvalidProof = 8,
    DepositTooLarge = 9,
    BadExtData = 10,
    Reentrancy = 11,
    TreeFull = 12,
    NonCanonicalInput = 13,
    BadDomain = 14,
    Paused = 15,
    BadConfig = 16,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    Domain,
    MaxDeposit,
    TvlCap,
    Tvl,
    Paused,
    Lock,
    Commitment(Address),
    EncKey(Address),
}

#[contractevent]
pub struct NewCommitment {
    pub index: u32,
    pub commitment: U256,
    pub encrypted_output: Bytes,
}

#[contractevent]
pub struct NewNullifier {
    pub nullifier: U256,
}

#[contracttype]
#[derive(Clone)]
pub struct RegisteredCommitment {
    pub version: u32,
    pub value: U256,
}

#[contracttype]
#[derive(Clone)]
pub struct RegisteredEncKey {
    pub version: u32,
    pub value: BytesN<32>,
}

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    pub fn init(
        env: Env,
        admin: Address,
        token: Address,
        domain: U256,
        max_deposit: i128,
        tvl_cap: i128,
    ) -> Result<(), Error> {
        let s = env.storage().persistent();
        if s.has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if domain == U256::from_u32(&env, 0) || !tx::is_canonical(&env, &domain) {
            return Err(Error::BadDomain);
        }
        if max_deposit <= 0 || tvl_cap < max_deposit {
            return Err(Error::BadConfig);
        }
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Token, &token);
        s.set(&DataKey::Domain, &domain);
        s.set(&DataKey::MaxDeposit, &max_deposit);
        s.set(&DataKey::TvlCap, &tvl_cap);
        s.set(&DataKey::Tvl, &0i128);
        s.set(&DataKey::Paused, &false);
        merkle::init(&env);
        Ok(())
    }

    fn admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Admin: pause or resume `transact`.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        env.storage().persistent().set(&DataKey::Paused, &paused);
        Ok(())
    }

    /// Admin: upgrade the contract Wasm, keeping address and storage.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Keeper: extend the TTL of the tree state and the instance so the pool
    /// never archives. Permissionless; only prolongs liveness.
    pub fn bump_ttl(env: Env) {
        merkle::bump_all(&env);
        env.storage()
            .instance()
            .extend_ttl(ttl::THRESHOLD, ttl::EXTEND_TO);
    }

    /// Deposit (ext_amount > 0), withdraw (ext_amount < 0), or internal transfer
    /// (ext_amount == 0). Spends two input notes and creates two output notes.
    pub fn transact(env: Env, proof: TxProof, ext: ExtData, sender: Address) -> Result<(), Error> {
        sender.require_auth();

        // Token transfers below call an external contract.
        let t = env.storage().temporary();
        if t.has(&DataKey::Lock) {
            return Err(Error::Reentrancy);
        }
        t.set(&DataKey::Lock, &true);

        let s = env.storage().persistent();
        if s.get(&DataKey::Paused).unwrap_or(false) {
            return Err(Error::Paused);
        }
        let token: Address = s.get(&DataKey::Token).ok_or(Error::NotInitialized)?;
        let domain: U256 = s.get(&DataKey::Domain).ok_or(Error::NotInitialized)?;
        let this = env.current_contract_address();

        if ext.fee < 0 {
            return Err(Error::BadExtData);
        }
        let signed = ext
            .ext_amount
            .checked_sub(ext.fee)
            .ok_or(Error::BadExtData)?;

        // Non-canonical inputs let a proof bind a value other than the one
        // checked here, since x and x + p map to the same field element.
        if !tx::is_canonical(&env, &proof.root)
            || !tx::is_canonical(&env, &proof.public_amount)
            || !tx::is_canonical(&env, &proof.ext_data_hash)
        {
            return Err(Error::NonCanonicalInput);
        }
        for v in proof.input_nullifiers.iter() {
            if !tx::is_canonical(&env, &v) {
                return Err(Error::NonCanonicalInput);
            }
        }
        for v in proof.output_commitments.iter() {
            if !tx::is_canonical(&env, &v) {
                return Err(Error::NonCanonicalInput);
            }
        }

        // TVL tracks real custody: signed = ext_amount - fee.
        let max: i128 = s.get(&DataKey::MaxDeposit).ok_or(Error::NotInitialized)?;
        let cap: i128 = s.get(&DataKey::TvlCap).ok_or(Error::NotInitialized)?;
        if ext.ext_amount > max {
            return Err(Error::DepositTooLarge);
        }
        let mut tvl: i128 = s.get(&DataKey::Tvl).unwrap_or(0);
        tvl = tvl.checked_add(signed).ok_or(Error::BadExtData)?;
        if tvl < 0 {
            return Err(Error::BadExtData);
        }
        if tvl > cap {
            return Err(Error::DepositTooLarge);
        }
        if merkle::is_full(&env) {
            return Err(Error::TreeFull);
        }
        if !merkle::is_known_root(&env, &proof.root) {
            return Err(Error::UnknownRoot);
        }
        for n in proof.input_nullifiers.iter() {
            if nullifier::is_spent(&env, &n) {
                return Err(Error::SpentNullifier);
            }
        }
        if tx::hash_ext_data(&env, &ext) != proof.ext_data_hash {
            return Err(Error::WrongExtHash);
        }
        if tx::calc_public_amount(&env, signed) != proof.public_amount {
            return Err(Error::WrongPublicAmount);
        }

        let g16 = Groth16Proof {
            a: proof.a.clone(),
            b: proof.b.clone(),
            c: proof.c.clone(),
        };
        if !verifier::verify_groth16(&env, &g16, &tx::public_inputs(&env, &proof, &domain)) {
            return Err(Error::InvalidProof);
        }

        // State commits before any funds move.
        s.set(&DataKey::Tvl, &tvl);
        for n in proof.input_nullifiers.iter() {
            nullifier::mark_spent(&env, &n);
            NewNullifier { nullifier: n }.publish(&env);
        }
        let c0 = proof.output_commitments.get(0).ok_or(Error::BadExtData)?;
        let c1 = proof.output_commitments.get(1).ok_or(Error::BadExtData)?;
        let (i0, _) = merkle::insert(&env, c0.clone());
        let (i1, _) = merkle::insert(&env, c1.clone());
        NewCommitment {
            index: i0,
            commitment: c0,
            encrypted_output: ext.encrypted_output0,
        }
        .publish(&env);
        NewCommitment {
            index: i1,
            commitment: c1,
            encrypted_output: ext.encrypted_output1,
        }
        .publish(&env);

        // Funds move last, after all state is committed.
        let token_client = TokenClient::new(&env, &token);
        if ext.ext_amount > 0 {
            token_client.transfer(&sender, &this, &ext.ext_amount);
        } else if ext.ext_amount < 0 {
            let out = ext.ext_amount.checked_neg().ok_or(Error::BadExtData)?;
            token_client.transfer(&this, &ext.recipient, &out);
        }
        if ext.fee > 0 {
            token_client.transfer(&this, &ext.relayer, &ext.fee);
        }

        t.remove(&DataKey::Lock);
        Ok(())
    }

    /// Register or rotate the caller's shielded-spend commitment. Versioned and
    /// owner-authorized, so it cannot be front-run and a later version always
    /// supersedes an earlier one.
    pub fn register_commitment(
        env: Env,
        owner: Address,
        version: u32,
        commitment: U256,
    ) -> Result<(), Error> {
        owner.require_auth();
        let s = env.storage().persistent();
        let key = DataKey::Commitment(owner);
        if let Some(prev) = s.get::<_, RegisteredCommitment>(&key) {
            if version <= prev.version {
                return Err(Error::StaleVersion);
            }
        }
        s.set(
            &key,
            &RegisteredCommitment {
                version,
                value: commitment,
            },
        );
        s.extend_ttl(&key, ttl::THRESHOLD, ttl::EXTEND_TO);
        Ok(())
    }

    /// Register or rotate the caller's note-viewing public key.
    pub fn register_enc_key(
        env: Env,
        owner: Address,
        version: u32,
        pubkey: BytesN<32>,
    ) -> Result<(), Error> {
        owner.require_auth();
        let s = env.storage().persistent();
        let key = DataKey::EncKey(owner);
        if let Some(prev) = s.get::<_, RegisteredEncKey>(&key) {
            if version <= prev.version {
                return Err(Error::StaleVersion);
            }
        }
        s.set(
            &key,
            &RegisteredEncKey {
                version,
                value: pubkey,
            },
        );
        s.extend_ttl(&key, ttl::THRESHOLD, ttl::EXTEND_TO);
        Ok(())
    }

    pub fn current_root(env: Env) -> U256 {
        merkle::current_root(&env)
    }

    pub fn is_known_root(env: Env, root: U256) -> bool {
        merkle::is_known_root(&env, &root)
    }

    pub fn is_nullifier_spent(env: Env, nullifier: U256) -> bool {
        nullifier::is_spent(&env, &nullifier)
    }

    pub fn get_commitment(env: Env, owner: Address) -> Option<RegisteredCommitment> {
        env.storage().persistent().get(&DataKey::Commitment(owner))
    }

    pub fn get_enc_key(env: Env, owner: Address) -> Option<RegisteredEncKey> {
        env.storage().persistent().get(&DataKey::EncKey(owner))
    }
}

#[cfg(test)]
mod test;
