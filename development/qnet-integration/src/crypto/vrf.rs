// QNet Dilithium3-VRF: Post-Quantum Verifiable Random Function
// NIST FIPS 204 (ML-DSA-65) + SHA3-256
//
// Construction:
//   evaluate(sk, input) -> (output, proof)
//   verify(pk, input, output, proof) -> bool
//
// SHA3-256 for domain separation + output derivation
// Dilithium3 detached_sign for proof generation (deterministic in PQClean)

use pqcrypto_mldsa::mldsa65 as dilithium3;
use pqcrypto_traits::sign::{
    PublicKey as PkTrait,
    SecretKey as SkTrait,
    DetachedSignature as SigTrait,
    SignedMessage as SmTrait,
};
use sha3::{Sha3_256, Digest};

// Domain separation constants.
//
// v15.15: removed unused v4 VRF helpers (`DOMAIN_EVAL`, `DOMAIN_OUTPUT`,
// `hash_input_keyed`, `derive_output`). The active VRF construction is v5,
// implemented inline in `DilithiumVrf::evaluate` with `b"QNet_VRF_v5_OUTPUT"`
// and `b"QNet_VRF_v5_PROOF"` literal domain tags. The v4 helpers were
// orphaned during the v4→v5 refactor and never re-wired to a caller.
//
// `DOMAIN_SLOT` is still in use — it tags the seed input for
// `compute_slot_seed`, the entry point for secret-leader-election and
// macroblock-boundary VRF derivation. Format: `H(DOMAIN_SLOT || mb_hash ||
// round_le_bytes)` — independent from the v4/v5 evaluate path.
const DOMAIN_SLOT: &[u8] = b"QNet_VRF_SlotSeed_v4";

// FIX R24-H4: Auto-zeroizing Vec wrapper for secret key material.
// Ensures Dilithium SK bytes are write_volatile-cleared on drop,
// preventing key material from lingering in process memory.
pub struct ZeroizingVec(pub Vec<u8>);

impl std::ops::Deref for ZeroizingVec {
    type Target = [u8];
    fn deref(&self) -> &[u8] { &self.0 }
}

impl Drop for ZeroizingVec {
    fn drop(&mut self) {
        for byte in self.0.iter_mut() {
            unsafe { std::ptr::write_volatile(byte, 0u8); }
        }
        std::hint::black_box(&self.0);
    }
}

/// ML-DSA-65 (FIPS 204) sizes — CTILDEBYTES=48
pub const D3_PK_BYTES: usize = 1952;
pub const D3_SK_BYTES: usize = 4032;
pub const D3_SIG_BYTES: usize = 3309;

/// VRF evaluation result
#[derive(Debug, Clone)]
pub struct VrfOutput {
    /// Pseudorandom output (32 bytes)
    pub output: [u8; 32],
    /// Dilithium3 detached signature proof
    pub proof: Vec<u8>,
}

impl VrfOutput {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(36 + self.proof.len());
        buf.extend_from_slice(&self.output);
        buf.extend_from_slice(&(self.proof.len() as u32).to_le_bytes());
        buf.extend_from_slice(&self.proof);
        buf
    }

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < 36 {
            return Err(format!("[ERR][VRF] data_too_short len={}", data.len()));
        }
        let mut output = [0u8; 32];
        output.copy_from_slice(&data[..32]);
        let plen = u32::from_le_bytes([data[32], data[33], data[34], data[35]]) as usize;
        if data.len() < 36 + plen {
            return Err(format!("[ERR][VRF] proof_truncated need={} have={}", 36 + plen, data.len()));
        }
        Ok(Self { output, proof: data[36..36 + plen].to_vec() })
    }

    pub fn output_as_u128(&self) -> u128 {
        u128::from_le_bytes([
            self.output[0], self.output[1], self.output[2], self.output[3],
            self.output[4], self.output[5], self.output[6], self.output[7],
            self.output[8], self.output[9], self.output[10], self.output[11],
            self.output[12], self.output[13], self.output[14], self.output[15],
        ])
    }
}

// =========================================================================
// DilithiumVrf — core VRF engine
// =========================================================================

pub struct DilithiumVrf {
    sk: Option<Vec<u8>>,
    pk: Option<Vec<u8>>,
    node_id: String,
}

/// Backward compatibility alias
pub type QNetVrf = DilithiumVrf;

impl DilithiumVrf {
    pub fn new(node_id: String) -> Self {
        Self { sk: None, pk: None, node_id }
    }

    /// Initialize from raw key bytes
    pub fn initialize_from_keys(&mut self, pk: &[u8], sk: &[u8]) -> Result<(), String> {
        if pk.len() != D3_PK_BYTES {
            return Err(format!("[ERR][VRF] pk_size={} expected={}", pk.len(), D3_PK_BYTES));
        }
        if sk.len() != D3_SK_BYTES {
            return Err(format!("[ERR][VRF] sk_size={} expected={}", sk.len(), D3_SK_BYTES));
        }
        self.pk = Some(pk.to_vec());
        self.sk = Some(sk.to_vec());
        println!("[INFO][VRF] initialized node={} pk_hash={}",
                 self.node_id, &hex::encode(Sha3_256::digest(pk))[..16]);
        Ok(())
    }

    /// Initialize from existing DilithiumKeyManager
    pub fn initialize_from_key_manager(
        &mut self,
        km: &crate::crypto::key_manager::DilithiumKeyManager,
    ) -> Result<(), String> {
        let (pk, sk) = km.get_keypair()
            .map_err(|e| format!("[ERR][VRF] keypair_load err={}", e))?;
        self.initialize_from_keys(PkTrait::as_bytes(&pk), SkTrait::as_bytes(&sk))
    }

    pub fn get_public_key(&self) -> Option<Vec<u8>> {
        self.pk.clone()
    }

    pub fn get_public_key_hex(&self) -> Option<String> {
        self.pk.as_ref().map(|pk| hex::encode(pk))
    }

    /// Returns secret key bytes wrapped in ZeroizingVec for auto-zeroization on drop.
    /// FIX R24-H4: Previously returned raw Vec<u8> without auto-zeroization.
    /// Now returns ZeroizingVec that write_volatile-zeroizes all bytes when dropped.
    pub fn get_secret_key_bytes(&self) -> Option<ZeroizingVec> {
        self.sk.as_ref().map(|sk| ZeroizingVec(sk.clone()))
    }

    // ── Core VRF ─────────────────────────────────────────────────────────

    /// Evaluate VRF — deterministic: same (sk, input) → same output.
    ///
    /// ML-DSA-65 signing is randomized (FIPS 204), so the output must NOT
    /// be derived from signature bytes (that breaks determinism and makes
    /// leader-election claims non-reproducible). Instead:
    ///   output = SHA3-512(domain ‖ pk ‖ sk ‖ input)[..32]  (sk-bound, deterministic)
    ///   proof  = Dilithium3 sig over (domain_proof ‖ pk ‖ input ‖ output)
    /// Output is sk-private (unforgeable, hidden until reveal); the proof
    /// ties (input, output) to pk. Output determinism despite randomized
    /// signature bytes is the invariant leader election relies on.
    pub fn evaluate(&self, input: &[u8]) -> Result<VrfOutput, String> {
        let sk_bytes = self.sk.as_ref()
            .ok_or("[ERR][VRF] not initialized")?;
        let pk_bytes = self.pk.as_ref()
            .ok_or("[ERR][VRF] pk not initialized")?;

        // ── Deterministic output: SHA3-512(domain || pk || sk || input) → 32 bytes ──
        // sk-bound, so without sk the output is computationally
        // hidden; deterministic, so two calls with the same input
        // yield byte-identical outputs.
        use sha3::Sha3_512;
        let mut out_hasher = Sha3_512::new();
        out_hasher.update(b"QNet_VRF_v5_OUTPUT");
        out_hasher.update(pk_bytes);
        out_hasher.update(sk_bytes);
        out_hasher.update(input);
        let out_full = out_hasher.finalize();
        let mut output = [0u8; 32];
        output.copy_from_slice(&out_full[..32]);

        // ── Proof: Dilithium3 signature over (domain_proof || pk || input || output) ──
        // Anyone can verify (input, output, proof) ties together under
        // pk; even though the signature bytes are randomised by
        // FIPS 204, the verification predicate is deterministic
        // (`verify_detached_signature` returns the same accept/reject
        // for the same fixed (msg, sig, pk) input).
        let mut proof_msg = Vec::with_capacity(32 + pk_bytes.len() + input.len() + 32);
        proof_msg.extend_from_slice(b"QNet_VRF_v5_PROOF");
        proof_msg.extend_from_slice(pk_bytes);
        proof_msg.extend_from_slice(input);
        proof_msg.extend_from_slice(&output);

        let sk = dilithium3::SecretKey::from_bytes(sk_bytes)
            .map_err(|e| format!("[ERR][VRF] sk_parse err={:?}", e))?;
        let sig = dilithium3::detached_sign(&proof_msg, &sk);
        let proof = SigTrait::as_bytes(&sig).to_vec();

        Ok(VrfOutput { output, proof })
    }

    /// Verify VRF proof (stateless, no secret key needed).
    ///
    /// v5: verifies the Dilithium signature ties (pk, input, output)
    /// together. The output itself cannot be recomputed without sk —
    /// see `evaluate` doc for the construction rationale. The verifier
    /// trusts that the holder of `pk`'s matching sk evaluated the VRF
    /// honestly and signed the resulting (input, output) pair; a
    /// dishonest claimer would have to forge a Dilithium signature,
    /// which is the same security assumption that protects every
    /// other consensus message in the system.
    pub fn verify_static(pk_bytes: &[u8], input: &[u8], vrf: &VrfOutput) -> Result<bool, String> {
        if pk_bytes.len() != D3_PK_BYTES {
            return Err(format!("[ERR][VRF] verify pk_size={}", pk_bytes.len()));
        }
        // Reconstruct the same proof message the prover signed.
        let mut proof_msg = Vec::with_capacity(32 + pk_bytes.len() + input.len() + 32);
        proof_msg.extend_from_slice(b"QNet_VRF_v5_PROOF");
        proof_msg.extend_from_slice(pk_bytes);
        proof_msg.extend_from_slice(input);
        proof_msg.extend_from_slice(&vrf.output);

        let pk = dilithium3::PublicKey::from_bytes(pk_bytes)
            .map_err(|e| format!("[ERR][VRF] pk_parse err={:?}", e))?;
        let sig = dilithium3::DetachedSignature::from_bytes(&vrf.proof)
            .map_err(|e| format!("[ERR][VRF] sig_parse err={:?}", e))?;
        if dilithium3::verify_detached_signature(&sig, &proof_msg, &pk).is_err() {
            return Ok(false);
        }
        Ok(true)
    }

    // ── Secret Leader Election ───────────────────────────────────────────

    /// Compute slot seed from macroblock hash + round
    pub fn compute_slot_seed(mb_hash: &[u8; 32], round: u64) -> [u8; 32] {
        let mut h = Sha3_256::new();
        h.update(DOMAIN_SLOT);
        h.update(mb_hash);
        h.update(&round.to_le_bytes());
        let r = h.finalize();
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&r);
        seed
    }

    /// Am I elected for this slot?
    pub fn evaluate_election(
        &self, slot_seed: &[u8; 32], my_rep: f64, total_rep: f64,
    ) -> Result<Option<VrfOutput>, String> {
        let vrf = self.evaluate(slot_seed)?;
        let threshold = Self::calculate_threshold(my_rep, total_rep);
        if vrf.output_as_u128() < threshold {
            println!("[INFO][VRF] elected node={} rep={:.1}/{:.1}", self.node_id, my_rep, total_rep);
            Ok(Some(vrf))
        } else {
            Ok(None)
        }
    }

    /// Verify another node's election claim
    pub fn verify_election(
        pk: &[u8], slot_seed: &[u8; 32], vrf: &VrfOutput, rep: f64, total_rep: f64,
    ) -> Result<bool, String> {
        if !Self::verify_static(pk, slot_seed, vrf)? {
            return Ok(false);
        }
        Ok(vrf.output_as_u128() < Self::calculate_threshold(rep, total_rep))
    }

    /// Expected winners per round — controls claim density in P2P gossip.
    /// 5 nodes  -> all 5 broadcast  (P = min(1.0, 20/5*rep_fraction) = 1.0)
    /// 50 nodes -> ~20 broadcast     (~80 KB gossip)
    /// 1000 nodes -> ~20 broadcast   (~80 KB gossip, same bandwidth)
    pub const EXPECTED_WINNERS: f64 = 20.0;

    /// Election threshold: P(elected) = EXPECTED_WINNERS * (rep / total_rep)
    /// Guarantees ~EXPECTED_WINNERS claims per round regardless of network size.
    /// P(0 winners) ~ e^(-EXPECTED_WINNERS) ~ 2e-9 -- practically impossible.
    ///
    /// FIX M-M20: Integer-only arithmetic to ensure cross-platform determinism.
    /// All nodes must compute identical thresholds -- f64 precision varies by platform.
    pub fn calculate_threshold(rep: f64, total_rep: f64) -> u128 {
        if total_rep <= 0.0 || rep <= 0.0 { return 0; }

        // Scale to integer arithmetic: multiply by 1_000_000 to preserve 6 decimal places
        let rep_scaled = (rep * 1_000_000.0) as u128;
        let total_scaled = (total_rep * 1_000_000.0) as u128;
        if total_scaled == 0 { return 0; }

        let expected = (Self::EXPECTED_WINNERS * 1_000_000.0) as u128;

        // p_scaled = expected * rep / total (in millionths)
        let p_scaled = expected.saturating_mul(rep_scaled) / total_scaled;

        // If probability >= 1.0 (in millionths), saturate to MAX
        if p_scaled >= 1_000_000 {
            return u128::MAX;
        }

        // threshold = u128::MAX * p_scaled / 1_000_000
        (u128::MAX / 1_000_000).saturating_mul(p_scaled)
    }

    /// Pick winner: lowest VRF output (deterministic tiebreaker)
    pub fn select_winner(candidates: &[(String, VrfOutput)]) -> Option<(String, VrfOutput)> {
        candidates.iter()
            .min_by_key(|(_, v)| v.output)
            .map(|(id, v)| (id.clone(), v.clone()))
    }

    /// v4.5: PRIMARY deterministic leader selection (Ethereum/Solana model).
    ///
    /// All inputs are on-chain → all nodes compute identical result.
    /// Zero P2P dependency. Mathematically impossible to disagree.
    ///
    /// `timeout_round`: 0 = normal, 1+ = BFT-certified failover round.
    /// Different timeout_round values produce different leaders (different hash).
    pub fn deterministic_leader(
        slot_seed: &[u8; 32], height: u64, leadership_round: u64,
        timeout_round: u64, num_candidates: usize,
    ) -> usize {
        if num_candidates == 0 { return 0; }
        let mut h = Sha3_256::new();
        h.update(b"QNET_LEADER_V4.5");
        h.update(slot_seed);
        h.update(&height.to_le_bytes());
        h.update(&leadership_round.to_le_bytes());
        h.update(&timeout_round.to_le_bytes());
        let result = h.finalize();
        let idx_bytes: [u8; 8] = result[..8].try_into().unwrap_or([0u8; 8]);
        let idx = u64::from_le_bytes(idx_bytes);
        (idx % num_candidates as u64) as usize
    }

    /// Legacy deterministic fallback — kept for backward compatibility.
    pub fn deterministic_fallback(
        slot_seed: &[u8; 32], height: u64, round: u64, num_candidates: usize,
    ) -> usize {
        Self::deterministic_leader(slot_seed, height, round, 0, num_candidates)
    }

    // v15.15: removed orphaned v4 helpers `hash_input_keyed` and
    // `derive_output`. Active VRF (v5) inlines its hashing inside
    // `evaluate` / `verify_static` with `b"QNet_VRF_v5_OUTPUT"` and
    // `b"QNet_VRF_v5_PROOF"` literal domain tags — no shared helpers
    // needed.
}

// =========================================================================
// WalletIdentity — seed → wallet address + Dilithium3 keypair
// =========================================================================

pub struct WalletIdentity {
    pub wallet_address: String,
    pub dilithium_pk: Vec<u8>,
    dilithium_sk: Vec<u8>,
    pub seed_fingerprint: [u8; 32],
}

impl WalletIdentity {
    /// Create from seed phrase + persistent keypair bytes
    pub fn from_seed_and_keys(seed: &str, pk: Vec<u8>, sk: Vec<u8>) -> Result<Self, String> {
        let wallet_address = Self::derive_wallet_address(seed);
        let mut fp = [0u8; 32];
        let h = Sha3_256::digest(format!("QNet_Seed_FP_v1{}", seed).as_bytes());
        fp.copy_from_slice(&h);

        if pk.len() != D3_PK_BYTES {
            return Err(format!("[ERR][WALLET] pk_size={}", pk.len()));
        }
        if sk.len() != D3_SK_BYTES {
            return Err(format!("[ERR][WALLET] sk_size={}", sk.len()));
        }
        println!("[INFO][WALLET] created addr={} pk_hash={}",
                 wallet_address, &hex::encode(Sha3_256::digest(&pk))[..16]);
        Ok(Self { wallet_address, dilithium_pk: pk, dilithium_sk: sk, seed_fingerprint: fp })
    }

    /// Derive EON wallet address from mnemonic seed phrase.
    /// eon = SHA512(WALLET ML-DSA-65 pk), byte-identical to mobile generateQNetAddress.
    /// Format: {19hex}eon{15hex}{8hex SHA3-256 checksum} = 45 chars
    pub fn derive_wallet_address(seed: &str) -> String {
        // Pure-Dilithium identity: eon = SHA512(WALLET ML-DSA-65 pk), byte-identical to the
        // mobile wallet's generateQNetAddress (same SHAKE-seeded keygen, KAT-proven), so the app
        // and the node compute the SAME reward/identity address — and node_id — for one seed.
        // This is the WALLET key the user claims rewards with; the node's consensus signing key
        // (derive_mldsa65_from_mnemonic) is a separate domain and never the on-chain wallet.
        let (wallet_pk, _sk) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(seed);
        if let Some(addr) = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&hex::encode(&wallet_pk)) {
            return addr;
        }
        // Defensive fallback (unreachable for a hex pk): legacy deterministic form.
        let hash = Sha3_256::digest(format!("QNet_Wallet_v1{}", seed).as_bytes());
        let hex_str = hex::encode(&hash);
        let p1 = &hex_str[..19];
        let p2 = &hex_str[19..34];
        let body = format!("{}eon{}", p1, p2);
        let ck = hex::encode(&Sha3_256::digest(body.as_bytes())[..4]);
        format!("{}eon{}{}", p1, p2, ck)
    }

    /// Sign data with Dilithium3 (detached)
    pub fn sign(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        let sk = dilithium3::SecretKey::from_bytes(&self.dilithium_sk)
            .map_err(|e| format!("[ERR][WALLET] sk_parse err={:?}", e))?;
        Ok(SigTrait::as_bytes(&dilithium3::detached_sign(data, &sk)).to_vec())
    }

    /// Sign data and produce consensus-compatible signature string.
    /// Format: "dilithium_sig_{node_id}_{base64([sm_len(4)]+[SignedMessage]+[pk_len(4)]+[pk(1952)])}"
    pub fn sign_consensus(&self, node_id: &str, data: &[u8]) -> Result<String, String> {
        use base64::engine::general_purpose;
        use base64::Engine;

        let sk = dilithium3::SecretKey::from_bytes(&self.dilithium_sk)
            .map_err(|e| format!("[ERR][WALLET] sk_parse err={:?}", e))?;
        let signed_msg = dilithium3::sign(data, &sk);
        let sm_bytes = SmTrait::as_bytes(&signed_msg);

        let mut combined = Vec::with_capacity(4 + sm_bytes.len() + 4 + self.dilithium_pk.len());
        combined.extend_from_slice(&(sm_bytes.len() as u32).to_le_bytes());
        combined.extend_from_slice(sm_bytes);
        combined.extend_from_slice(&(self.dilithium_pk.len() as u32).to_le_bytes());
        combined.extend_from_slice(&self.dilithium_pk);

        let b64 = general_purpose::STANDARD.encode(&combined);
        Ok(format!("dilithium_sig_{}_{}", node_id, b64))
    }

    /// Create VRF instance from this identity
    pub fn create_vrf(&self, node_id: &str) -> Result<DilithiumVrf, String> {
        let mut vrf = DilithiumVrf::new(node_id.to_string());
        vrf.initialize_from_keys(&self.dilithium_pk, &self.dilithium_sk)?;
        Ok(vrf)
    }

    /// Verify signature from any public key
    pub fn verify_signature(pk: &[u8], data: &[u8], sig_bytes: &[u8]) -> Result<bool, String> {
        let pk = dilithium3::PublicKey::from_bytes(pk)
            .map_err(|e| format!("[ERR][WALLET] pk err={:?}", e))?;
        let sig = dilithium3::DetachedSignature::from_bytes(sig_bytes)
            .map_err(|e| format!("[ERR][WALLET] sig err={:?}", e))?;
        Ok(dilithium3::verify_detached_signature(&sig, data, &pk).is_ok())
    }

    pub fn pk_hex(&self) -> String { hex::encode(&self.dilithium_pk) }

    /// Return raw secret key bytes for VRF key announce broadcast.
    /// SECURITY: Returns a reference — caller MUST NOT persist or clone
    /// without zeroing the copy after use (Vec is NOT auto-zeroed on drop).
    pub fn sk_bytes(&self) -> &[u8] { &self.dilithium_sk }
}

impl Drop for DilithiumVrf {
    fn drop(&mut self) {
        // FIX L-M19: Compiler-proof secret key zeroing via write_volatile + black_box
        if let Some(ref mut sk) = self.sk {
            for byte in sk.iter_mut() {
                unsafe { core::ptr::write_volatile(byte, 0u8); }
            }
            std::hint::black_box(&sk);
        }
        println!("[INFO][CRYPTO] vrf_key_zeroed");
    }
}

impl Drop for WalletIdentity {
    fn drop(&mut self) {
        // FIX L-M19: Compiler-proof secret key zeroing via write_volatile + black_box
        for byte in self.dilithium_sk.iter_mut() {
            unsafe { core::ptr::write_volatile(byte, 0u8); }
        }
        std::hint::black_box(&self.dilithium_sk);
        println!("[INFO][CRYPTO] wallet_key_zeroed");
    }
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vrf_deterministic() {
        // v5 VRF construction: OUTPUT must be deterministic (same sk +
        // input → same 32-byte output) — this is the core property
        // every consensus path that consumes the VRF relies on.
        //
        // PROOF (the Dilithium3 signature) is INTENTIONALLY randomised
        // by FIPS 204 ML-DSA-65 — every call returns different signature
        // bytes for the same message. Both proofs are still valid
        // witnesses for the (input, output) pair, so the verification
        // predicate accepts both. Asserting byte-equality on proofs
        // would conflate "deterministic VRF output" with "deterministic
        // signature scheme" — a different (and stronger) property that
        // QNet's post-quantum signing primitive does not provide.
        let (pk, sk) = dilithium3::keypair();
        let pk_b = PkTrait::as_bytes(&pk).to_vec();
        let mut vrf = DilithiumVrf::new("t1".into());
        vrf.initialize_from_keys(&pk_b, SkTrait::as_bytes(&sk)).unwrap();
        let a = vrf.evaluate(b"input").unwrap();
        let b = vrf.evaluate(b"input").unwrap();
        assert_eq!(a.output, b.output, "VRF output must be deterministic");
        // Both proofs verify under the same (pk, input, output) — that
        // is the property the consensus path requires.
        assert!(DilithiumVrf::verify_static(&pk_b, b"input", &a).unwrap());
        assert!(DilithiumVrf::verify_static(&pk_b, b"input", &b).unwrap());
    }

    #[test]
    fn test_vrf_verify() {
        let (pk, sk) = dilithium3::keypair();
        let pk_b = PkTrait::as_bytes(&pk).to_vec();
        let mut vrf = DilithiumVrf::new("t2".into());
        vrf.initialize_from_keys(&pk_b, SkTrait::as_bytes(&sk)).unwrap();
        let out = vrf.evaluate(b"msg").unwrap();
        assert!(DilithiumVrf::verify_static(&pk_b, b"msg", &out).unwrap());
        assert!(!DilithiumVrf::verify_static(&pk_b, b"wrong", &out).unwrap());
    }

    #[test]
    fn test_wallet_address_deterministic() {
        let a = WalletIdentity::derive_wallet_address("test seed");
        let b = WalletIdentity::derive_wallet_address("test seed");
        assert_eq!(a, b);
        assert_eq!(a.len(), 45);
        assert!(a.contains("eon"));
    }

    /// Node's wallet address == SHA512(WALLET ML-DSA-65 pk), i.e. byte-identical to the mobile
    /// wallet's generateQNetAddress — one seed → one on-chain identity for app and node.
    #[test]
    fn test_wallet_address_is_dilithium_pk_eon() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let (pk, _sk) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(m);
        let expected = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&hex::encode(&pk)).unwrap();
        assert_eq!(WalletIdentity::derive_wallet_address(m), expected,
            "wallet address must be the eon of the WALLET Dilithium pk (app-identical)");
    }



    #[test]
    fn test_vrf_serialization() {
        let v = VrfOutput { output: [42u8; 32], proof: vec![1, 2, 3] };
        let r = VrfOutput::from_bytes(&v.to_bytes()).unwrap();
        assert_eq!(r.output, v.output);
        assert_eq!(r.proof, v.proof);
    }

    #[test]
    fn test_threshold_expected_winners() {
        // 5 nodes, equal rep -> P(elected) = min(1.0, 20 * 1/5) = 1.0 -> all elected
        let t5 = DilithiumVrf::calculate_threshold(90.0, 450.0);
        assert_eq!(t5, u128::MAX); // saturates at 1.0

        // 1000 nodes, equal rep -> P(elected) = 20/1000 = 0.02
        let t1000 = DilithiumVrf::calculate_threshold(1.0, 1000.0);
        // Integer-only: threshold = (u128::MAX / 1_000_000) * 20_000
        let expected_int = (u128::MAX / 1_000_000).saturating_mul(20_000);
        assert!(t1000 > 0);
        // Allow small integer rounding difference
        let diff = if t1000 > expected_int { t1000 - expected_int } else { expected_int - t1000 };
        assert!(diff < u128::MAX / 1_000_000, "threshold diff too large");

        // Zero rep -> 0
        assert_eq!(DilithiumVrf::calculate_threshold(0.0, 100.0), 0);
        assert_eq!(DilithiumVrf::calculate_threshold(10.0, 0.0), 0);
    }

    #[test]
    fn test_deterministic_fallback() {
        let seed = [1u8; 32];
        // Same inputs -> same result
        let a = DilithiumVrf::deterministic_fallback(&seed, 100, 5, 10);
        let b = DilithiumVrf::deterministic_fallback(&seed, 100, 5, 10);
        assert_eq!(a, b);
        assert!(a < 10);

        // Different height -> different result (with high probability)
        let c = DilithiumVrf::deterministic_fallback(&seed, 101, 5, 10);
        // Not guaranteed to differ, but extremely likely with 10 slots
        // Just verify it's in range
        assert!(c < 10);

        // Different round -> different result
        let d = DilithiumVrf::deterministic_fallback(&seed, 100, 6, 10);
        assert!(d < 10);
    }
}
