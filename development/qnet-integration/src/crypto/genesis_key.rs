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
}
