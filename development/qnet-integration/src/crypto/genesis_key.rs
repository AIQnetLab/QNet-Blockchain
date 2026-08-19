//! v27 HOLE1 — deterministic ML-DSA-65 keypair from the wallet mnemonic
//! (wipe-safe, pin-able, no random keygen/TOFU). KEYGEN=fips204 (FIPS-204
//! det. keygen_from_seed); SIGN/VERIFY=unchanged pqcrypto-mldsa. Byte-compat
//! proven by KAT + enforced fail-closed at boot (assert_backend_compatible).

use sha3::{Digest, Sha3_256};

/// ML-DSA-65 standard byte sizes (FIPS 204). Identical in `fips204` and
/// `pqcrypto-mldsa`; asserted by the KAT.
pub const MLDSA65_PK_LEN: usize = 1952;
pub const MLDSA65_SK_LEN: usize = 4032;

/// Domain separator so the consensus key is independent of any other key
/// derived from the same mnemonic (wallet address path is distinct).
const XI_DOMAIN: &[u8] = b"QNet/ML-DSA-65/consensus-identity/v1";

/// Derive the 32-byte FIPS-204 KeyGen seed `xi` from raw seed material
/// (BIP-39 seed bytes or any high-entropy secret). Domain-separated.
pub fn derive_xi(seed_material: &[u8]) -> [u8; 32] {
    let mut h = Sha3_256::new();
    h.update(XI_DOMAIN);
    h.update(seed_material);
    let d = h.finalize();
    let mut xi = [0u8; 32];
    xi.copy_from_slice(&d);
    xi
}

/// Derive the ML-DSA-65 KeyGen seed `xi` from a BIP-39 mnemonic. Bound to
/// the SAME BIP-39 seed as the wallet address (one mnemonic → one identity),
/// on a distinct domain so the consensus key ≠ any other derived key.
pub fn derive_xi_from_mnemonic(mnemonic: &str) -> [u8; 32] {
    let seed64 = crate::crypto::solana_derivation::bip39_seed64(mnemonic);
    derive_xi(&seed64)
}

/// Deterministic ML-DSA-65 keypair from a BIP-39 mnemonic. Standard FIPS-204
/// encoded `(pk_bytes, sk_bytes)`, parseable by the production
/// `pqcrypto-mldsa` path (KAT-proven). Wipe-safe: re-derives identically.
pub fn derive_mldsa65_from_mnemonic(mnemonic: &str) -> (Vec<u8>, Vec<u8>) {
    derive_mldsa65_from_xi(&derive_xi_from_mnemonic(mnemonic))
}

/// Deterministic ML-DSA-65 keypair from `xi`. Returns standard FIPS-204
/// encoded `(public_key_bytes, secret_key_bytes)` — directly parseable by
/// the production `pqcrypto-mldsa` sign/verify path (proven by the KAT).
pub fn derive_mldsa65_from_xi(xi: &[u8; 32]) -> (Vec<u8>, Vec<u8>) {
    use fips204::ml_dsa_65;
    use fips204::traits::{KeyGen, SerDes};

    let (pk, sk) = ml_dsa_65::KG::keygen_from_seed(xi);
    let pk_bytes = pk.into_bytes().to_vec();
    let sk_bytes = sk.into_bytes().to_vec();
    (pk_bytes, sk_bytes)
}

// ── User-wallet ML-DSA-65 identity (pure-Dilithium migration, F0.2) ───────────
// Distinct from the consensus key: one mnemonic yields INDEPENDENT keys because the
// KeyGen seed is derived on a different path. Cross-client byte-exactness: the 32-byte
// seed is SHAKE-256 of a canonical seed string — byte-identical to the mobile native
// `derive_seed_from_string` (`shake256(out, 32, str, len)`), so node / mobile / ext
// derive the SAME keypair (hence the SAME EON address) from the SAME mnemonic. The
// cross-client KAT vector below pins it. Genesis-locked constant.
const WALLET_SEED_PREFIX: &str = "QNET_WALLET_MLDSA65_v1:";

/// Canonical wallet seed string: `PREFIX + hex(BIP-39 64-byte seed)`. Node and the
/// client wallets SHAKE-256 this exact string to obtain the 32-byte KeyGen seed.
pub fn wallet_seed_string(mnemonic: &str) -> String {
    let seed64 = crate::crypto::solana_derivation::bip39_seed64(mnemonic);
    format!("{}{}", WALLET_SEED_PREFIX, hex::encode(seed64))
}

/// SHAKE-256(seed_string) -> 32-byte ML-DSA-65 KeyGen seed. Byte-for-byte identical
/// to the mobile native `shake256(out, 32, str, len)` used by generateKeypairFromSeed.
pub fn wallet_xi_from_seed_string(seed_string: &str) -> [u8; 32] {
    use sha3::Shake256;
    use sha3::digest::{Update, ExtendableOutput, XofReader};
    let mut h = Shake256::default();
    Update::update(&mut h, seed_string.as_bytes());
    let mut xof = h.finalize_xof();
    let mut xi = [0u8; 32];
    xof.read(&mut xi);
    xi
}

/// Deterministic USER-WALLET ML-DSA-65 keypair from a BIP-39 mnemonic. Standard
/// FIPS-204 encoding (pk 1952, sk 4032), byte-identical to the mobile/ext wallet key.
pub fn derive_wallet_mldsa65_from_mnemonic(mnemonic: &str) -> (Vec<u8>, Vec<u8>) {
    let xi = wallet_xi_from_seed_string(&wallet_seed_string(mnemonic));
    derive_mldsa65_from_xi(&xi)
}

/// Fail-closed startup self-test: determinism + sizes + fips204→pqcrypto
/// cross-sign/verify. Any failure → caller MUST abort (boot refusal, not split).
pub fn backend_self_test() -> Result<(), String> {
    use pqcrypto_mldsa::mldsa65;
    use pqcrypto_traits::sign::{PublicKey as _, SecretKey as _};

    // 1. Determinism: same xi → identical key bytes.
    let xi = derive_xi(b"qnet-backend-self-test-vector");
    let (pk1, sk1) = derive_mldsa65_from_xi(&xi);
    let (pk2, sk2) = derive_mldsa65_from_xi(&xi);
    if pk1 != pk2 || sk1 != sk2 {
        return Err("keygen_not_deterministic".into());
    }

    // 2. Standard sizes.
    if pk1.len() != MLDSA65_PK_LEN || sk1.len() != MLDSA65_SK_LEN {
        return Err(format!(
            "size_mismatch pk={} sk={} (want {}/{})",
            pk1.len(), sk1.len(), MLDSA65_PK_LEN, MLDSA65_SK_LEN
        ));
    }

    // 3. Cross-backend: keys derived by fips204 must sign+verify under the
    //    production pqcrypto-mldsa path (the path consensus_crypto uses).
    let q_pk = mldsa65::PublicKey::from_bytes(&pk1)
        .map_err(|e| format!("pqcrypto_pk_parse {:?}", e))?;
    let q_sk = mldsa65::SecretKey::from_bytes(&sk1)
        .map_err(|e| format!("pqcrypto_sk_parse {:?}", e))?;

    let msg = b"qnet v27 genesis-identity backend compatibility probe";
    let sig = mldsa65::detached_sign(msg, &q_sk);
    mldsa65::verify_detached_signature(&sig, msg, &q_pk)
        .map_err(|e| format!("cross_backend_verify_failed {:?}", e))?;

    // Negative control: a tampered message must NOT verify.
    let bad = b"qnet v27 genesis-identity backend compatibility probe!";
    if mldsa65::verify_detached_signature(&sig, bad, &q_pk).is_ok() {
        return Err("verify_accepts_tampered_message".into());
    }

    Ok(())
}

/// Fail-closed wrapper: log with the project's 2-tier scheme and abort the
/// process on incompatibility. Called once at startup before consensus.
pub fn assert_backend_compatible_or_die() {
    match backend_self_test() {
        Ok(()) => {
            println!("[INFO][CRYPTO] genesis_key_backend_self_test ok backend=fips204_keygen+pqcrypto_mldsa_sign");
        }
        Err(reason) => {
            eprintln!(
                "[CRIT][CRYPTO] genesis_key_backend_self_test FAILED reason={} \
                 action=halt_startup hint=fips204_pqcrypto-mldsa_byte_incompatibility",
                reason
            );
            std::process::exit(3);
        }
    }
}

#[cfg(test)]
mod kat {
    use super::*;
    use pqcrypto_mldsa::mldsa65;
    use pqcrypto_traits::sign::{PublicKey as _, SecretKey as _};

    #[test]
    fn keygen_is_deterministic() {
        let xi = derive_xi(b"vector-A");
        let (pk1, sk1) = derive_mldsa65_from_xi(&xi);
        let (pk2, sk2) = derive_mldsa65_from_xi(&xi);
        assert_eq!(pk1, pk2, "pk must be deterministic for fixed xi");
        assert_eq!(sk1, sk2, "sk must be deterministic for fixed xi");

        // Different xi → different key (sanity).
        let xi_b = derive_xi(b"vector-B");
        let (pk_b, _) = derive_mldsa65_from_xi(&xi_b);
        assert_ne!(pk1, pk_b, "distinct xi must yield distinct pk");
    }

    #[test]
    fn standard_sizes() {
        let (pk, sk) = derive_mldsa65_from_xi(&derive_xi(b"sizes"));
        assert_eq!(pk.len(), MLDSA65_PK_LEN, "ML-DSA-65 pk = 1952 bytes");
        assert_eq!(sk.len(), MLDSA65_SK_LEN, "ML-DSA-65 sk = 4032 bytes");
    }

    // ── Wallet identity (F0.2) ────────────────────────────────────────────────
    const TEST_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn wallet_keygen_deterministic_sized_and_independent() {
        let (pk1, sk1) = derive_wallet_mldsa65_from_mnemonic(TEST_MNEMONIC);
        let (pk2, sk2) = derive_wallet_mldsa65_from_mnemonic(TEST_MNEMONIC);
        assert_eq!(pk1, pk2, "wallet pk must be deterministic");
        assert_eq!(sk1, sk2, "wallet sk must be deterministic");
        assert_eq!(pk1.len(), MLDSA65_PK_LEN);
        assert_eq!(sk1.len(), MLDSA65_SK_LEN);
        // Same mnemonic must NOT reuse the consensus key (distinct derivation paths).
        let (cons_pk, _) = derive_mldsa65_from_mnemonic(TEST_MNEMONIC);
        assert_ne!(pk1, cons_pk, "wallet key must be independent of the consensus key");
    }

    /// Cross-client KAT anchor: the canonical seed string, the SHAKE-256 xi, and the
    /// resulting EON address are fixed constants that the mobile (native shake256 +
    /// pqclean) and the extension (@noble ml-dsa) wallet MUST reproduce byte-for-byte.
    /// Run with `--nocapture` to print the reference vector for pinning in the clients.
    #[test]
    fn wallet_cross_client_kat_vector() {
        let s = wallet_seed_string(TEST_MNEMONIC);
        let xi = wallet_xi_from_seed_string(&s);
        let (pk, _sk) = derive_wallet_mldsa65_from_mnemonic(TEST_MNEMONIC);
        let pk_hex = hex::encode(&pk);
        let eon = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex)
            .expect("valid pk hex");

        // xi must be exactly SHAKE-256(seed_string) truncated to 32 bytes.
        assert_eq!(xi.len(), 32);
        // EON layout: 45 chars, positional "eon" tag at [19..22].
        assert_eq!(eon.len(), 45, "EON must be 45 chars");
        assert_eq!(&eon[19..22], "eon", "positional eon tag");

        // GOLDEN cross-client vector (genesis-locked). Mobile (native shake256 +
        // pqclean) and the extension (@noble ml-dsa) MUST reproduce these exactly.
        // Any change here is an intentional, breaking derivation change.
        assert_eq!(
            hex::encode(xi),
            "5c5c79cac60d06d566b9c23047ad28b5da96dab4367593563ef34539067b57f6",
            "SHAKE-256 xi golden vector"
        );
        let pk_sha3 = {
            use sha3::{Digest, Sha3_256};
            let mut h = Sha3_256::new();
            h.update(&pk);
            hex::encode(h.finalize())
        };
        assert_eq!(
            pk_sha3,
            "cc8dbbec8ddd7b01f7926748b3738028ab92570e04e694bf0f4ddc346085de6f",
            "ML-DSA-65 pk golden digest"
        );
        assert_eq!(
            eon, "d9fa370374e24333242eon847d1d354dcd87fe873823e",
            "wallet EON golden vector"
        );
        // Determinism of the address end-to-end.
        let (pk_b, _) = derive_wallet_mldsa65_from_mnemonic(TEST_MNEMONIC);
        assert_eq!(
            eon,
            crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&hex::encode(&pk_b)).unwrap(),
            "address must be deterministic from the mnemonic"
        );

        println!("---8<--- WALLET KAT (pin in mobile + extension) ---8<---");
        println!("mnemonic       = {}", TEST_MNEMONIC);
        println!("seed_string    = {}", s);
        println!("xi_shake256    = {}", hex::encode(xi));
        println!("pk_len         = {}", pk.len());
        println!("pk_sha3_256    = {}", {
            use sha3::{Digest, Sha3_256};
            let mut h = Sha3_256::new();
            h.update(&pk);
            hex::encode(h.finalize())
        });
        println!("eon_address    = {}", eon);
        println!("---8<--- END WALLET KAT ---8<---");
    }

    /// Decisive: fips204-derived keypair must sign/verify under prod
    /// pqcrypto-mldsa (the consensus path). Green → keygen-only swap is sound.
    #[test]
    fn fips204_pqcrypto_byte_compatible() {
        let xi = derive_xi(b"cross-backend-vector");
        let (pk_bytes, sk_bytes) = derive_mldsa65_from_xi(&xi);

        let q_pk = mldsa65::PublicKey::from_bytes(&pk_bytes)
            .expect("pqcrypto-mldsa must parse fips204 public key bytes");
        let q_sk = mldsa65::SecretKey::from_bytes(&sk_bytes)
            .expect("pqcrypto-mldsa must parse fips204 secret key bytes");

        let msg = b"qnet genesis identity cross-backend KAT";
        let sig = mldsa65::detached_sign(msg, &q_sk);
        mldsa65::verify_detached_signature(&sig, msg, &q_pk)
            .expect("pqcrypto sign+verify must succeed on fips204-derived keys");

        let tampered = b"qnet genesis identity cross-backend KAT.";
        assert!(
            mldsa65::verify_detached_signature(&sig, tampered, &q_pk).is_err(),
            "tampered message must not verify"
        );
    }

    #[test]
    fn backend_self_test_passes() {
        backend_self_test().expect("startup backend self-test must pass");
    }

    /// v27 HOLE1b: offline GENESIS_CONSENSUS_PKS generator (#[ignore]d,
    /// mnemonics from env — no secrets in repo). Run:
    ///   QNET_GEN_SEED_001..005=".." cargo test -p qnet-integration \
    ///   gen_genesis_consensus_pks -- --ignored --nocapture
    #[test]
    #[ignore]
    fn gen_genesis_consensus_pks() {
        println!("---8<--- GENESIS_CONSENSUS_PKS BEGIN ---8<---");
        println!("pub const GENESIS_CONSENSUS_PKS: &[(&str, &str)] = &[");
        for id in ["001", "002", "003", "004", "005"] {
            let var = format!("QNET_GEN_SEED_{}", id);
            let mnemonic = std::env::var(&var)
                .unwrap_or_else(|_| panic!("missing env {}", var));
            let (pk, _sk) = derive_mldsa65_from_mnemonic(mnemonic.trim());
            assert_eq!(pk.len(), MLDSA65_PK_LEN, "pk size for {}", id);
            println!("    (\"genesis_node_{}\", \"{}\"),", id, hex::encode(&pk));
        }
        println!("];");
        println!("---8<--- GENESIS_CONSENSUS_PKS END ---8<---");
    }

    /// Shape of the two committed genesis tables, checked on every run: five aligned entries, each
    /// consensus PK a 1952-byte ML-DSA-65 key, each wallet a well-formed distinct eon address.
    /// Catches a corrupted or half-edited table without needing any seed.
    #[test]
    fn genesis_constant_tables_are_well_formed() {
        use crate::genesis_constants::{GENESIS_CONSENSUS_PKS, GENESIS_WALLETS};
        const IDS: [&str; 5] = ["001", "002", "003", "004", "005"];
        assert_eq!(GENESIS_CONSENSUS_PKS.len(), IDS.len());
        assert_eq!(GENESIS_WALLETS.len(), IDS.len());
        for (idx, id) in IDS.iter().enumerate() {
            assert_eq!(GENESIS_CONSENSUS_PKS[idx].0, format!("genesis_node_{}", id));
            assert_eq!(GENESIS_WALLETS[idx].0, *id);
            let pk = hex::decode(GENESIS_CONSENSUS_PKS[idx].1).expect("consensus pk must be hex");
            assert_eq!(pk.len(), MLDSA65_PK_LEN, "consensus pk size for {}", id);
            let w = GENESIS_WALLETS[idx].1;
            assert_eq!(w.len(), 45, "eon length for {}", id);
            assert_eq!(&w[19..22], "eon", "positional eon tag for {}", id);
        }
        for i in 0..IDS.len() {
            for j in (i + 1)..IDS.len() {
                assert_ne!(GENESIS_CONSENSUS_PKS[i].1, GENESIS_CONSENSUS_PKS[j].1, "duplicate pk");
                assert_ne!(GENESIS_WALLETS[i].1, GENESIS_WALLETS[j].1, "duplicate wallet");
            }
        }
    }

    /// Pre-launch identity linkage gate. Proves GENESIS_WALLETS[i] and
    /// GENESIS_CONSENSUS_PKS[i] come from the SAME seed i: derives BOTH the
    /// consensus PK (block-signing domain) and the wallet eon (reward/claim
    /// domain) from each mnemonic and asserts each equals its committed
    /// constant. A pass means a genesis operator importing seed i sees exactly
    /// GENESIS_WALLETS[i] in the app and the node credits rewards there.
    ///
    /// Runs in the ordinary suite — no `--ignored` — and needs the five genesis
    /// mnemonics, which are never in the repo. Supply them as files (preferred,
    /// mode 0600) or as env vars, then run the normal command:
    ///   QNET_GEN_SEED_001_FILE=/run/secrets/gen001 .. QNET_GEN_SEED_005_FILE=..
    ///   cargo test -p qnet-integration --lib verify_genesis_identity_linkage -- --nocapture
    /// With no seeds supplied it reports SKIPPED and proves nothing; with some
    /// but not all it FAILS, because a partially-configured gate is the one that
    /// silently passes at launch.
    #[test]
    fn verify_genesis_identity_linkage() {
        use crate::crypto::vrf::WalletIdentity;
        use crate::genesis_constants::{GENESIS_CONSENSUS_PKS, GENESIS_WALLETS};
        const IDS: [&str; 5] = ["001", "002", "003", "004", "005"];
        let seeds: Vec<Option<String>> = IDS.iter()
            .map(|id| crate::node::load_wallet_seed(&format!("QNET_GEN_SEED_{}", id)))
            .collect();
        let supplied = seeds.iter().filter(|s| s.is_some()).count();
        if supplied == 0 {
            println!("[WARN][GENESIS] identity_linkage_skipped reason=seeds_absent \
                      action=set_QNET_GEN_SEED_001..005[_FILE]_before_a_fresh_launch");
            return;
        }
        assert_eq!(
            supplied, IDS.len(),
            "partial genesis seed set ({}/{}): supply all five or none — a partial gate passes \
             without proving the missing seeds", supplied, IDS.len()
        );
        for (idx, id) in IDS.iter().enumerate() {
            let mnemonic = seeds[idx].as_deref().expect("checked above");
            let mnemonic = mnemonic.trim();

            // Consensus domain (block signing) — the boot-time anchor.
            let (pk, _sk) = derive_mldsa65_from_mnemonic(mnemonic);
            let pk_hex = hex::encode(&pk);
            assert_eq!(
                pk_hex, GENESIS_CONSENSUS_PKS[idx].1,
                "consensus PK mismatch for {} (seed != GENESIS_CONSENSUS_PKS[{}])", id, idx
            );

            // Wallet domain (reward/claim identity) — must match app derivation.
            let wallet = WalletIdentity::derive_wallet_address(mnemonic);
            assert_eq!(
                wallet, GENESIS_WALLETS[idx].1,
                "wallet eon mismatch for {} (seed != GENESIS_WALLETS[{}])", id, idx
            );
            // Both constants proven from the same seed i.
            println!("[OK] genesis {} linked: wallet={}", id, wallet);
        }
        println!("[OK] all 5 genesis seeds: consensus PK + wallet eon both match constants");
    }
}
