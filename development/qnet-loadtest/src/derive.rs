//! Deterministic ML-DSA-65 (Dilithium3) key derivation + QNet EON address +
//! transaction signing — byte-identical to the node.
//!
//! KEYGEN  = fips204 FIPS-204 deterministic `keygen_from_seed` (== node
//!           crypto/genesis_key.rs::derive_mldsa65_from_xi).
//! ADDRESS = SHA512(pk) formatted `{19}eon{15}{8-checksum}` (== node
//!           crypto/solana_derivation.rs::eon_from_qnet_dilithium_pubkey).
//! SIGN    = raw detached ML-DSA-65 signature, hex on the wire (node
//!           verify_user_tx_dilithium: sig 3309 B + pk 1952 B, verify_detached).
//! The fips204→pqcrypto byte-compatibility is proven by the node's own boot KAT.

use sha2::{Digest as _, Sha512};
use sha3::Sha3_256;
use fips204::ml_dsa_65;
use fips204::traits::{KeyGen, SerDes};
use pqcrypto_mldsa::mldsa65;
use pqcrypto_traits::sign::{DetachedSignature as _, SecretKey as _};

pub const MLDSA65_PK_LEN: usize = 1952;
pub const MLDSA65_SK_LEN: usize = 4032;
pub const MLDSA65_SIG_LEN: usize = 3309;

/// KeyGen-seed domain for the loadtest account pool. genesis.rs derives the
/// funded addresses from the SAME string, so funded address == signing key.
pub const LOADTEST_XI_DOMAIN: &str = "QNET_LOADTEST_MLDSA65_v1:";

/// SHAKE-256(input)[..32] — the 32-byte FIPS-204 KeyGen seed (same primitive as
/// node genesis_key.rs::wallet_xi_from_seed_string).
pub fn shake256_32(input: &[u8]) -> [u8; 32] {
    use sha3::Shake256;
    use sha3::digest::{Update, ExtendableOutput, XofReader};
    let mut h = Shake256::default();
    Update::update(&mut h, input);
    let mut xof = h.finalize_xof();
    let mut xi = [0u8; 32];
    xof.read(&mut xi);
    xi
}

/// Deterministic xi for loadtest account #index.
pub fn loadtest_xi(index: u64) -> [u8; 32] {
    shake256_32(format!("{}{}", LOADTEST_XI_DOMAIN, index).as_bytes())
}

/// Deterministic (pk_bytes, sk_bytes) from a 32-byte xi. Standard FIPS-204
/// encoding (pk 1952, sk 4032); the sk bytes parse into pqcrypto-mldsa.
pub fn keypair_from_xi(xi: &[u8; 32]) -> (Vec<u8>, Vec<u8>) {
    let (pk, sk) = ml_dsa_65::KG::keygen_from_seed(xi);
    (pk.into_bytes().to_vec(), sk.into_bytes().to_vec())
}

/// QNet EON address (45 chars) from a raw ML-DSA-65 public key.
pub fn eon_from_pubkey(pk_bytes: &[u8]) -> String {
    let full = hex::encode(Sha512::digest(pk_bytes)); // 128 lowercase hex
    let part1 = &full[0..19];
    let part2 = &full[19..34];
    let body = format!("{}eon{}", part1, part2);
    let chk = hex::encode(&Sha3_256::digest(body.as_bytes())[..4]);
    format!("{}eon{}{}", part1, part2, chk)
}

/// Chain tag prefixed onto every canonical sign-preimage. MUST equal `QNET_CHAIN_ID` in
/// core/qnet-state/src/transaction.rs, or nothing this harness signs verifies on the node.
pub const QNET_CHAIN_TAG: &str = "q1337|";

/// Canonical signing message for a Transfer (node build_canonical_verify_message).
pub fn transfer_message(
    from: &str, to: &str, amount: u64, nonce: u64, gas_price: u64, gas_limit: u64,
) -> String {
    format!("{}transfer:{}:{}:{}:{}:{}:{}",
        QNET_CHAIN_TAG, from, to, amount, nonce, gas_price, gas_limit)
}

/// Node wire signature: hex of the RAW 3309-byte detached ML-DSA-65 signature.
/// The REST layer hex-decodes it; verify_user_tx_dilithium requires exactly
/// sig==3309 B (+ pk==1952 B, on the wire or rehydrated from committed state).
pub fn sign_wire(msg: &[u8], sk_bytes: &[u8]) -> Result<String, String> {
    let sk = mldsa65::SecretKey::from_bytes(sk_bytes).map_err(|e| format!("sk_parse {:?}", e))?;
    let sig = mldsa65::detached_sign(msg, &sk);
    debug_assert_eq!(sig.as_bytes().len(), MLDSA65_SIG_LEN);
    Ok(hex::encode(sig.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pqcrypto_traits::sign::PublicKey as _;

    /// Golden cross-client KAT from node crypto/genesis_key.rs (public "abandon..about"
    /// test vector). Proves our SHAKE/fips204/SHA512/SHA3 pipeline is byte-exact vs the node.
    #[test]
    fn kat_xi_to_address() {
        let mut xi = [0u8; 32];
        hex::decode_to_slice(
            "5c5c79cac60d06d566b9c23047ad28b5da96dab4367593563ef34539067b57f6",
            &mut xi,
        ).unwrap();
        let (pk, sk) = keypair_from_xi(&xi);
        assert_eq!(pk.len(), MLDSA65_PK_LEN);
        assert_eq!(sk.len(), MLDSA65_SK_LEN);
        assert_eq!(
            hex::encode(Sha3_256::digest(&pk)),
            "cc8dbbec8ddd7b01f7926748b3738028ab92570e04e694bf0f4ddc346085de6f"
        );
        assert_eq!(eon_from_pubkey(&pk), "d9fa370374e24333242eon847d1d354dcd87fe873823e");
    }

    /// fips204-derived keys must produce a detached sig that verify_detached accepts —
    /// the exact node-side check (verify_user_tx_dilithium_inner).
    #[test]
    fn keygen_signs_detached_and_verifies() {
        let (pk_b, sk_b) = keypair_from_xi(&loadtest_xi(7));
        let pk = mldsa65::PublicKey::from_bytes(&pk_b).unwrap();
        let msg = transfer_message("aaa", "bbb", 1, 1, 10, 10_000);
        let sig_hex = sign_wire(msg.as_bytes(), &sk_b).unwrap();
        let sig_bytes = hex::decode(&sig_hex).unwrap();
        assert_eq!(sig_bytes.len(), MLDSA65_SIG_LEN);
        let sig = mldsa65::DetachedSignature::from_bytes(&sig_bytes).unwrap();
        mldsa65::verify_detached_signature(&sig, msg.as_bytes(), &pk).expect("must verify");
    }

    #[test]
    fn address_shape_and_determinism() {
        let (pk, _) = keypair_from_xi(&loadtest_xi(0));
        let a = eon_from_pubkey(&pk);
        assert_eq!(a.len(), 45);
        assert_eq!(&a[19..22], "eon");
        assert_eq!(a, eon_from_pubkey(&pk)); // deterministic
        // hex(3309 B) = 6618 chars, all lowercase hex
        let s = sign_wire(b"m", &keypair_from_xi(&loadtest_xi(0)).1).unwrap();
        assert_eq!(s.len(), MLDSA65_SIG_LEN * 2);
        assert!(s.bytes().all(|c| c.is_ascii_hexdigit()));
    }
}
