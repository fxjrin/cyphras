#![cfg(test)]
extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, String, U256};
use types::ExtData;

use crate::{merkle, nullifier, tx, Vault, VaultClient};

const SENDER: &str = "GBAPNCYC3R33IATBS6KQGN4EPOVZCNC7VFWPURXHLPV4W7JWLCPENM2G";
const RECIPIENT: &str = "GCOHGXLEL4OEKN75E56Q5QJQB453QJMOSG35RJ6DR77655CPKBXKRGRO";
const RELAYER: &str = "GDSMH6TSGB2AVFNLSGAQWV6DZQNKA7F6J6M7BQBPMANAP3EAZTONIDOM";

fn addr(env: &Env, s: &str) -> Address {
    Address::from_string(&String::from_str(env, s))
}

fn hex(env: &Env, x: &U256) -> std::string::String {
    let b: Bytes = x.to_be_bytes();
    let mut out = std::vec::Vec::new();
    for byte in b.iter() {
        out.push(byte);
    }
    out.iter().map(|b| std::format!("{b:02x}")).collect()
}

// Emits the public signals a deposit proof must bind, computed exactly as
// transact does. Run: cargo test -p vault e2e_fixture -- --nocapture
#[test]
fn e2e_fixture_values() {
    let env = Env::default();
    let id = env.register(Vault, ());
    let client = VaultClient::new(&env, &id);
    let admin = addr(&env, SENDER);
    let token = addr(&env, RELAYER);
    let domain = U256::from_u32(&env, 67890);
    client.init(
        &admin,
        &token,
        &domain,
        &1_000_000_000i128,
        &1_000_000_000_000i128,
    );

    let empty_root = client.current_root();

    let ext = ExtData {
        ext_amount: 100,
        fee: 0,
        recipient: addr(&env, RECIPIENT),
        relayer: addr(&env, RELAYER),
        encrypted_output0: Bytes::new(&env),
        encrypted_output1: Bytes::new(&env),
    };
    let edh = tx::hash_ext_data(&env, &ext);
    let pa = tx::calc_public_amount(&env, 100);

    std::println!("E2E_ROOT={}", hex(&env, &empty_root));
    std::println!("E2E_EXTHASH={}", hex(&env, &edh));
    std::println!("E2E_PUBAMOUNT={}", hex(&env, &pa));
    std::println!("E2E_DOMAIN={}", hex(&env, &domain));
}

const RECIPIENT_C: &str = "CBKGSQT4SWKRTZMFM2XKIEQLK4HN6QD3KPLZE6ERHICMPFO5PAJL4SQ6";

// Emits the values a withdraw proof needs: the root after the deposit's two
// commitments, the zero-subtree siblings for leaf 0's path, and the withdraw
// ext-data hash / public amount.
#[test]
fn e2e_withdraw_fixture_values() {
    let env = Env::default();
    let id = env.register(Vault, ());
    let client = VaultClient::new(&env, &id);
    let domain = U256::from_u32(&env, 67890);
    client.init(
        &addr(&env, SENDER),
        &addr(&env, RELAYER),
        &domain,
        &1_000_000_000i128,
        &1_000_000_000_000i128,
    );

    let comm0 = u256_from_hex(
        &env,
        "05eb8d8bf489a9f8b7b7e8a6e97de0e7a319d9c63baefc33d5a4d3a5a65681b5",
    );
    let comm1 = u256_from_hex(
        &env,
        "08b2518e5ef5e98738a4dd819dd20904d70e4f5721e54af663372a6fe84007d6",
    );
    let post_root = env.as_contract(&id, || {
        merkle::insert(&env, comm0);
        merkle::insert(&env, comm1);
        merkle::current_root(&env)
    });
    std::println!("W_ROOT={}", hex(&env, &post_root));

    // zeros[i] = compress(zeros[i-1], zeros[i-1]); leaf 0's path is
    // [comm1, zeros[1], ... zeros[18]], 19 siblings for depth 20.
    let mut z = U256::from_u32(&env, 0);
    for i in 1..merkle::DEPTH {
        z = poseidon2::poseidon2_compress(&env, z.clone(), z.clone());
        std::println!("W_ZERO{}={}", i, hex(&env, &z));
    }

    let ext = ExtData {
        ext_amount: -100,
        fee: 0,
        recipient: addr(&env, RECIPIENT_C),
        relayer: addr(&env, RELAYER),
        encrypted_output0: Bytes::new(&env),
        encrypted_output1: Bytes::new(&env),
    };
    std::println!("W_EXTHASH={}", hex(&env, &tx::hash_ext_data(&env, &ext)));
    std::println!(
        "W_PUBAMOUNT={}",
        hex(&env, &tx::calc_public_amount(&env, -100))
    );

    // Private transfer: spend comm0, no custody movement (ext_amount = 0).
    let t_ext = ExtData {
        ext_amount: 0,
        fee: 0,
        recipient: addr(&env, RECIPIENT),
        relayer: addr(&env, RELAYER),
        encrypted_output0: Bytes::new(&env),
        encrypted_output1: Bytes::new(&env),
    };
    std::println!("T_EXTHASH={}", hex(&env, &tx::hash_ext_data(&env, &t_ext)));
    std::println!(
        "T_PUBAMOUNT={}",
        hex(&env, &tx::calc_public_amount(&env, 0))
    );
}

fn u256_from_hex(env: &Env, s: &str) -> U256 {
    let bytes = s.as_bytes();
    let mut buf = [0u8; 32];
    let h = |c: u8| -> u8 {
        if c >= b'a' {
            c - b'a' + 10
        } else {
            c - b'0'
        }
    };
    for i in 0..32 {
        buf[i] = (h(bytes[2 * i]) << 4) | h(bytes[2 * i + 1]);
    }
    U256::from_be_bytes(env, &Bytes::from_array(env, &buf))
}

fn setup(env: &Env) -> (Address, VaultClient) {
    let id = env.register(Vault, ());
    let client = VaultClient::new(env, &id);
    let admin = Address::generate(env);
    let token = Address::generate(env);
    let domain = U256::from_u32(env, 67890);
    client.init(
        &admin,
        &token,
        &domain,
        &1_000_000_000i128,
        &1_000_000_000_000i128,
    );
    (id, client)
}

#[test]
fn registration_is_versioned_and_authorized() {
    let env = Env::default();
    env.mock_all_auths();
    let (_id, client) = setup(&env);

    let owner = Address::generate(&env);
    let c1 = U256::from_u32(&env, 111);
    client.register_commitment(&owner, &1, &c1);
    assert_eq!(client.get_commitment(&owner).unwrap().value, c1);

    // A newer version supersedes.
    let c2 = U256::from_u32(&env, 222);
    client.register_commitment(&owner, &2, &c2);
    assert_eq!(client.get_commitment(&owner).unwrap().value, c2);

    // A stale (<=) version is rejected.
    let res = client.try_register_commitment(&owner, &2, &U256::from_u32(&env, 333));
    assert!(res.is_err());

    let pk = BytesN::from_array(&env, &[7u8; 32]);
    client.register_enc_key(&owner, &1, &pk);
    assert_eq!(client.get_enc_key(&owner).unwrap().value, pk);
}

#[test]
fn merkle_insert_advances_root_history() {
    let env = Env::default();
    let (id, _client) = setup(&env);

    env.as_contract(&id, || {
        let empty = merkle::current_root(&env);
        assert!(!merkle::is_known_root(&env, &U256::from_u32(&env, 0)));

        let (i0, r0) = merkle::insert(&env, U256::from_u32(&env, 42));
        assert_eq!(i0, 0);
        assert_ne!(r0, empty);
        assert!(merkle::is_known_root(&env, &r0));

        let (i1, r1) = merkle::insert(&env, U256::from_u32(&env, 43));
        assert_eq!(i1, 1);
        assert_ne!(r1, r0);
        // Older roots stay valid within the history window.
        assert!(merkle::is_known_root(&env, &r0));
        assert!(merkle::is_known_root(&env, &r1));
        assert_eq!(merkle::current_root(&env), r1);
    });
}

const FX_A: &str = "18f0be880e75e5cd58f0f2bc569d437138e5d8a1300c5449d487c4c0cb12a80906ff8d13724492dc3721b22ef3e9d1e4594a596d13d21be40d9472c8fcb6bd8b";
const FX_B: &str = "08bd441881e973df0be6a7552e88b216fde4e8b0e40c4dcf7b502f954f2ba7f1169fa56a7b3706895f83b51082cfabe2d4ac972157d8267914b5c3c560ac7dd20cc97be1cb059b6417e5b0e0bab47d0b525c2092929e1073d75ad73be55d822a0d2cf8846eee135ec7f5975acc6c775ad60dc8bba0b1435700ab34c2d7945a79";
const FX_C: &str = "1b7d845bdd7a6d9b1c1426c36d5cba4ad6b1e112ab16f037788853fec602252b22f02bb798f2782e939207b7fe81cd1ca059cf55fa983590e87a62a8831127e1";
const FX_ROOT: &str = "119827e780a1850d7b7e34646edc1ce918211c26dda4e13bcd1611f6f81c3680";
const FX_PUBAMOUNT: &str = "0000000000000000000000000000000000000000000000000000000000000064";
const FX_EXTHASH: &str = "2a70fdae388029aeac29dc6521cf5830c5cf7453b7920e0bb6ffc01b5244efe1";
const FX_NULL0: &str = "0504c53835603287669797b37d749539ff9061ab3013353aa79e9b5b0f221133";
const FX_NULL1: &str = "1b7bd7cf06e2bbc898b9729aa2bd6658aed5969593aa59d0f3c6ab0ad55f7111";
const FX_COMM0: &str = "05eb8d8bf489a9f8b7b7e8a6e97de0e7a319d9c63baefc33d5a4d3a5a65681b5";
const FX_COMM1: &str = "08b2518e5ef5e98738a4dd819dd20904d70e4f5721e54af663372a6fe84007d6";

fn hx<const N: usize>(s: &str) -> [u8; N] {
    let bytes = s.as_bytes();
    let mut out = [0u8; N];
    let h = |c: u8| -> u8 {
        if c >= b'a' {
            c - b'a' + 10
        } else {
            c - b'0'
        }
    };
    for i in 0..N {
        out[i] = (h(bytes[2 * i]) << 4) | h(bytes[2 * i + 1]);
    }
    out
}

fn u256_hex(env: &Env, s: &str) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &hx::<32>(s)))
}

// End-to-end deposit: a real Groth16 proof bound to the vault's computed
// root/ext-data-hash/public-amount flows through transact, moving SAC custody
// and spending the input nullifiers.
#[test]
#[ignore = "needs a fresh proof fixture from the new trusted setup; regenerate when the witness builder lands"]
fn e2e_deposit_moves_custody_and_spends_nullifiers() {
    use soroban_sdk::{
        crypto::bn254::{Bn254G1Affine, Bn254G2Affine},
        token::{StellarAssetClient, TokenClient},
        BytesN,
    };
    use types::TxProof;

    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();
    let mint = StellarAssetClient::new(&env, &token);
    let coin = TokenClient::new(&env, &token);

    let vault_id = env.register(Vault, ());
    let client = VaultClient::new(&env, &vault_id);
    let admin = addr(&env, SENDER);
    let domain = U256::from_u32(&env, 67890);
    client.init(
        &admin,
        &token,
        &domain,
        &1_000_000_000i128,
        &1_000_000_000_000i128,
    );

    // The vault's empty root must equal the proof's bound root.
    assert_eq!(client.current_root(), u256_hex(&env, FX_ROOT));

    // sender is outside ExtData, so it does not affect the proof; use a
    // generated address that holds the SAC without a classic trustline.
    let sender = Address::generate(&env);
    mint.mint(&sender, &100i128);

    let mut nulls = soroban_sdk::Vec::new(&env);
    nulls.push_back(u256_hex(&env, FX_NULL0));
    nulls.push_back(u256_hex(&env, FX_NULL1));
    let mut comms = soroban_sdk::Vec::new(&env);
    comms.push_back(u256_hex(&env, FX_COMM0));
    comms.push_back(u256_hex(&env, FX_COMM1));

    let proof = TxProof {
        a: Bn254G1Affine::from_bytes(BytesN::from_array(&env, &hx::<64>(FX_A))),
        b: Bn254G2Affine::from_bytes(BytesN::from_array(&env, &hx::<128>(FX_B))),
        c: Bn254G1Affine::from_bytes(BytesN::from_array(&env, &hx::<64>(FX_C))),
        root: u256_hex(&env, FX_ROOT),
        public_amount: u256_hex(&env, FX_PUBAMOUNT),
        ext_data_hash: u256_hex(&env, FX_EXTHASH),
        input_nullifiers: nulls,
        output_commitments: comms,
    };
    let ext = ExtData {
        ext_amount: 100,
        fee: 0,
        recipient: addr(&env, RECIPIENT),
        relayer: addr(&env, RELAYER),
        encrypted_output0: Bytes::new(&env),
        encrypted_output1: Bytes::new(&env),
    };

    client.transact(&proof, &ext, &sender);

    assert_eq!(coin.balance(&vault_id), 100);
    assert_eq!(coin.balance(&sender), 0);
    assert!(client.is_nullifier_spent(&u256_hex(&env, FX_NULL0)));
    assert!(client.is_nullifier_spent(&u256_hex(&env, FX_NULL1)));
    assert_eq!(client.current_root(), u256_hex(&env, W_ROOT));

    // Withdraw: spend the deposit's 100-value note (comm0) via a real Merkle
    // path, paying the recipient out of custody.
    let mut w_nulls = soroban_sdk::Vec::new(&env);
    w_nulls.push_back(u256_hex(&env, W_NULL0));
    w_nulls.push_back(u256_hex(&env, W_NULL1));
    let mut w_comms = soroban_sdk::Vec::new(&env);
    w_comms.push_back(u256_hex(&env, W_COMM0));
    w_comms.push_back(u256_hex(&env, W_COMM1));
    let w_proof = TxProof {
        a: Bn254G1Affine::from_bytes(BytesN::from_array(&env, &hx::<64>(W_A))),
        b: Bn254G2Affine::from_bytes(BytesN::from_array(&env, &hx::<128>(W_B))),
        c: Bn254G1Affine::from_bytes(BytesN::from_array(&env, &hx::<64>(W_C))),
        root: u256_hex(&env, W_ROOT),
        public_amount: u256_hex(&env, W_PUBAMOUNT),
        ext_data_hash: u256_hex(&env, W_EXTHASH),
        input_nullifiers: w_nulls,
        output_commitments: w_comms,
    };
    let recipient = addr(&env, RECIPIENT_C);
    let w_ext = ExtData {
        ext_amount: -100,
        fee: 0,
        recipient: recipient.clone(),
        relayer: addr(&env, RELAYER),
        encrypted_output0: Bytes::new(&env),
        encrypted_output1: Bytes::new(&env),
    };
    client.transact(&w_proof, &w_ext, &sender);

    assert_eq!(coin.balance(&vault_id), 0);
    assert_eq!(coin.balance(&recipient), 100);
    assert!(client.is_nullifier_spent(&u256_hex(&env, W_NULL0)));
}

const T_A: &str = "1cc6ae4a6fbaa95744e3f60ccab79806ad43b50c50d5e1d9ba91546bd636686c1e3184aae4ae03c3efbc1e6ece845cecfaae61a73aeadeb756bd537d3c5e0f01";
const T_B: &str = "18b6d3f741f38270cac77447c48330d235da87d7fe431465615ae33b43d3ac710bb92e969f02ac4e118bf38a9f684e39abb2572a1f3b9f95dd073624c41f727d018033e783bfb054229aea4bd3656e81f3f05a9c94c06574b9e0c50fff24bde812398bd5d0813a1a3ab0ff06c8e5cab52b6d0852c98aebe69c61b8d61c856ebd";
const T_C: &str = "18ffa279ed2ce2cf896e4697c4499c6ed301737f1ad5d0bab15f6234e77266820c86c2700e2ae57b7aa7bfb7c922207cb3b2793d21299d81af7a1d5d0e851723";
const T_EXTHASH: &str = "1058ae41684009c5d7d99a4cb3f1150366c70275ed4ce6d3bf60ca289c3c3065";
const T_COMM0: &str = "0c2b09c118dc77d59f77f994b1cc286f2e81d93dcffe6f70f6776f80af9cf5d6";
const T_COMM1: &str = "2cde1aa1fc6b881e10d8fd7ba8fab10e7c36bb47f46387e6aac979696d8ed991";

// Private transfer: deposit, then spend comm0 into two new notes (60 + 40)
// with ext_amount = 0, so no token leaves custody but the note set advances.
#[test]
#[ignore = "needs a fresh proof fixture from the new trusted setup; regenerate when the witness builder lands"]
fn e2e_private_transfer_keeps_custody_and_advances_tree() {
    use soroban_sdk::{
        crypto::bn254::{Bn254G1Affine, Bn254G2Affine},
        token::{StellarAssetClient, TokenClient},
        BytesN,
    };
    use types::TxProof;

    let env = Env::default();
    env.mock_all_auths();

    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = sac.address();
    let coin = TokenClient::new(&env, &token);
    let vault_id = env.register(Vault, ());
    let client = VaultClient::new(&env, &vault_id);
    let domain = U256::from_u32(&env, 67890);
    client.init(
        &addr(&env, SENDER),
        &token,
        &domain,
        &1_000_000_000i128,
        &1_000_000_000_000i128,
    );

    // deposit 100 using the deposit fixture proof
    let sender = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&sender, &100i128);
    let mk_proof = |a: &str,
                    b: &str,
                    c: &str,
                    root: &str,
                    pa: &str,
                    eh: &str,
                    n0: &str,
                    n1: &str,
                    c0: &str,
                    c1: &str| {
        let mut ns = soroban_sdk::Vec::new(&env);
        ns.push_back(u256_hex(&env, n0));
        ns.push_back(u256_hex(&env, n1));
        let mut cs = soroban_sdk::Vec::new(&env);
        cs.push_back(u256_hex(&env, c0));
        cs.push_back(u256_hex(&env, c1));
        TxProof {
            a: Bn254G1Affine::from_bytes(BytesN::from_array(&env, &hx::<64>(a))),
            b: Bn254G2Affine::from_bytes(BytesN::from_array(&env, &hx::<128>(b))),
            c: Bn254G1Affine::from_bytes(BytesN::from_array(&env, &hx::<64>(c))),
            root: u256_hex(&env, root),
            public_amount: u256_hex(&env, pa),
            ext_data_hash: u256_hex(&env, eh),
            input_nullifiers: ns,
            output_commitments: cs,
        }
    };
    let dep_ext = ExtData {
        ext_amount: 100,
        fee: 0,
        recipient: addr(&env, RECIPIENT),
        relayer: addr(&env, RELAYER),
        encrypted_output0: Bytes::new(&env),
        encrypted_output1: Bytes::new(&env),
    };
    client.transact(
        &mk_proof(
            FX_A,
            FX_B,
            FX_C,
            FX_ROOT,
            FX_PUBAMOUNT,
            FX_EXTHASH,
            FX_NULL0,
            FX_NULL1,
            FX_COMM0,
            FX_COMM1,
        ),
        &dep_ext,
        &sender,
    );
    assert_eq!(coin.balance(&vault_id), 100);

    // private transfer: spend comm0 (W_NULL0/1), ext_amount = 0, new notes 60+40
    let t_ext = ExtData {
        ext_amount: 0,
        fee: 0,
        recipient: addr(&env, RECIPIENT),
        relayer: addr(&env, RELAYER),
        encrypted_output0: Bytes::new(&env),
        encrypted_output1: Bytes::new(&env),
    };
    let root_before = client.current_root();
    client.transact(
        &mk_proof(
            T_A,
            T_B,
            T_C,
            W_ROOT,
            T_PUBAMOUNT,
            T_EXTHASH,
            W_NULL0,
            W_NULL1,
            T_COMM0,
            T_COMM1,
        ),
        &t_ext,
        &sender,
    );

    assert_eq!(coin.balance(&vault_id), 100); // no custody movement
    assert!(client.is_nullifier_spent(&u256_hex(&env, W_NULL0)));
    assert_ne!(client.current_root(), root_before); // two new notes inserted
}

const T_PUBAMOUNT: &str = "0000000000000000000000000000000000000000000000000000000000000000";

const W_A: &str = "206dee628a2752f5c74fba369bd1f4ba1dbdd77456bf982de12b639121383f800fed5bf041c6533db00697c8a7fc680ed88ca5b0d7ad95e8d49c191a98cb0fd9";
const W_B: &str = "25a2b1946b0a903a3cd4d79ca48892c48e710635e14f46e0c2a2338bb654f47a1dbe52da36cc5e599e96c6de444b221bddf91bf5be18b84d081f7d8e6b15cc4705c63352dd3ef237052da80501ac9bb3ffb887ab6ef278c2bfc0ba50851a64060dd14be08e050749faf763309b4dd37c549eccfa6cba0195172d31d18152010f";
const W_C: &str = "1831db3e6693c499025a032f3b59dc120f96fd0ff79c11aade5c453450d7a16704cb82cb2efba96a7069ee2a6579ecf32e16758db08fa39571d1bb0f69404a61";
const W_ROOT: &str = "291235e6444795910644ace17bff923ba00b888803c7bbc441614b88686064d3";
const W_PUBAMOUNT: &str = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593efffff9d";
const W_EXTHASH: &str = "28bcfa05399011dd0886b71c226a74fdc73c4a5df1600d71881971f1d5c61c49";
const W_NULL0: &str = "2f51e7816facb02c597f7357e4f5573891d1c6308a8a40ba3afba639fad5fe71";
const W_NULL1: &str = "123ae552daaf8018b193bf1adf122ad18b4d1f28ec01a61a9cb5a0d377a14f38";
const W_COMM0: &str = "16ddc81a2cc53e9040ee5cd0903f3b0ed1c7c966f6c0c35f1d73238c64271023";
const W_COMM1: &str = "282beb538ca46036330f12d2aaeb62fe81685e9a16ead163671dc53f8252db3c";

#[test]
fn nullifier_double_spend_is_rejected() {
    let env = Env::default();
    let (id, _client) = setup(&env);

    env.as_contract(&id, || {
        let n = U256::from_u32(&env, 9001);
        assert!(!nullifier::is_spent(&env, &n));
        assert!(nullifier::mark_spent(&env, &n));
        assert!(nullifier::is_spent(&env, &n));
        // Second spend of the same nullifier fails.
        assert!(!nullifier::mark_spent(&env, &n));
    });
}
