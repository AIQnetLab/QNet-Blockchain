//! Hybrid Dilithium + Ed25519 wrapper (production-ready)
//! June 2025 implementation

use pqcrypto_mldsa::mldsa44::*;
use ed25519_dalek::{SigningKey as EdSigningKey, VerifyingKey as EdPublicKey, Signature as EdSig, Signer, Verifier};
use rand_core::OsRng;

/// Public key of hybrid scheme
#[derive(Clone)]
pub struct HybridPublicKey {
    pub pq_pk: PublicKey,
    pub ed_pk: EdPublicKey,
}

/// Private key of hybrid scheme
pub struct HybridSecretKey {
    pq_sk: SecretKey,
    ed_sk: EdSigningKey,
}

/// Signature = Dilithium SignedMessage (sig || msg) + Ed25519 sig
#[derive(Clone)]
pub struct HybridSignature {
    pub pq_sig: SignedMessage,
    pub ed_sig: EdSig,
}

impl HybridSecretKey {
    /// Generate new keypair
    pub fn generate() -> (HybridPublicKey, HybridSecretKey) {
        // Dilithium keypair
        let (pq_pk, pq_sk) = keypair();
        // Ed25519 keypair
        let ed_sk = EdSigningKey::generate(&mut OsRng);
        let ed_pk = ed_sk.verifying_key();
        let pk = HybridPublicKey { pq_pk, ed_pk };
        let sk = HybridSecretKey { pq_sk, ed_sk };
        (pk, sk)
    }

    /// Sign message
    pub fn sign(&self, msg: &[u8]) -> HybridSignature {
        let pq_sig = sign(msg, &self.pq_sk);
        let ed_sig = self.ed_sk.sign(msg);
        HybridSignature { pq_sig, ed_sig }
    }
}

impl HybridPublicKey {
    /// Verify hybrid signature (both parts must be valid)
    pub fn verify(&self, msg: &[u8], sig: &HybridSignature) -> bool {
        // open() decrypts SignedMessage and returns the original message if valid
        match open(&sig.pq_sig, &self.pq_pk) {
            Ok(recovered) if ct_eq_pq(recovered.as_slice(), msg) => {}
            _ => return false,
        }
        self.ed_pk.verify(msg, &sig.ed_sig).is_ok()
    }
}

#[inline(never)]
fn ct_eq_pq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) { diff |= x ^ y; }
    std::hint::black_box(diff) == 0
}

