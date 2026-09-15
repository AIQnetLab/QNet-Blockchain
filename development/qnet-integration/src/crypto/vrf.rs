// QNet ML-DSA-65-VRF: Post-Quantum Verifiable Random Function
// NIST FIPS 204 (ML-DSA-65) + SHA3-256
//
// Construction:
//   evaluate(sk, input) -> (output, proof)
//   verify(pk, input, output, proof) -> bool
//
// SHA3-256 for domain separation + output derivation
// ML-DSA-65 detached_sign for proof generation (deterministic in PQClean)

use pqcrypto_mldsa::mldsa65 as dilithium3;
use pqcrypto_traits::sign::{
    PublicKey as PkTrait,
    SecretKey as SkTrait,
    DetachedSignature as SigTrait,
    SignedMessage as SmTrait,
};
use sha3::{Sha3_256, Sha3_512, Digest};

// Domain separation constants.
//
// The active construction is v7: a deterministic sk-bound output with the pair authenticated by an
// ML-DSA-65 signature (`b"QNet_VRF_v7_OUTPUT"` / `b"QNet_VRF_v7_PROOF"`). Determinism is required by
// the beacon recompute at the checkpoint — see `evaluate`.
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
    /// ML-DSA-65 detached signature proof
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
    ///   output = SHA3-512("QNet_VRF_v7_OUTPUT" ‖ pk ‖ sk ‖ input)[..32]
    ///   proof  = ML-DSA-65 signature over ("QNet_VRF_v7_PROOF" ‖ pk ‖ input ‖ output)
    ///
    /// Determinism is a consensus-safety invariant, not a convenience. `vrf_output` is NOT covered by
    /// `MicroBlock::hash()`, yet every node recomputes the window beacon from the STORED bodies at the
    /// checkpoint. A producer that re-produces height h after a rollback emits the same seven hashed
    /// fields — timestamp is `genesis_ts + h*SLOT`, so even that is fixed — hence a byte-identical
    /// hash. If the output moved between the two evaluations, peers holding either variant see every
    /// tail hash match (never TailDiverged, so no repair is solicited) and then disagree on the beacon,
    /// which is a terminal ContentCheck::Reject. Five honest nodes, no attacker, permanent freeze.
    ///
    /// Price paid, knowingly: a verifier holding only pk cannot recompute the output, so `verify_static`
    /// proves the producer AUTHENTICATED this (input, output) pair — not that the pair was forced.
    /// Verifiability needs `output = f(public, proof)` with a UNIQUE proof; ML-DSA-65 is randomised, so
    /// on this primitive verifiable and deterministic are mutually exclusive. That is why no consensus
    /// value reads `vrf_output`: the window beacon folds QC-signed block hashes instead.
    pub fn evaluate(&self, input: &[u8]) -> Result<VrfOutput, String> {
        let sk_bytes = self.sk.as_ref()
            .ok_or("[ERR][VRF] not initialized")?;
        let pk_bytes = self.pk.as_ref()
            .ok_or("[ERR][VRF] pk not initialized")?;

        let output = Self::output_from_secret(pk_bytes, sk_bytes, input);
        let proof_msg = Self::proof_message(pk_bytes, input, &output);
        let sk = dilithium3::SecretKey::from_bytes(sk_bytes)
            .map_err(|e| format!("[ERR][VRF] sk_parse err={:?}", e))?;
        let sig = dilithium3::detached_sign(&proof_msg, &sk);

        Ok(VrfOutput { output, proof: SigTrait::as_bytes(&sig).to_vec() })
    }

    /// sk-bound, deterministic output. Unpredictable to anyone without sk; unrecomputable by a
    /// verifier, which is exactly the limitation `evaluate` documents.
    fn output_from_secret(pk_bytes: &[u8], sk_bytes: &[u8], input: &[u8]) -> [u8; 32] {
        let mut h = Sha3_512::new();
        h.update(b"QNet_VRF_v7_OUTPUT");
        h.update(pk_bytes);
        h.update(sk_bytes);
        h.update(input);
        let d = h.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&d[..32]);
        out
    }

    /// The message the VRF proof signs. Covers the output so the (input, output) pair is bound to pk:
    /// a MITM cannot swap the output of a block in flight without invalidating this signature too.
    fn proof_message(pk_bytes: &[u8], input: &[u8], output: &[u8; 32]) -> Vec<u8> {
        let mut m = Vec::with_capacity(32 + pk_bytes.len() + input.len() + output.len());
        m.extend_from_slice(b"QNet_VRF_v7_PROOF");
        m.extend_from_slice(pk_bytes);
        m.extend_from_slice(input);
        m.extend_from_slice(output);
        m
    }

    /// Verify a VRF proof (stateless, no secret key needed).
    ///
    /// Proves that the holder of `pk` signed THIS (input, output) pair. It does NOT prove the output
    /// was correctly derived — see `evaluate` for why that is unreachable on a randomised signature.
    pub fn verify_static(pk_bytes: &[u8], input: &[u8], vrf: &VrfOutput) -> Result<bool, String> {
        if pk_bytes.len() != D3_PK_BYTES {
            return Err(format!("[ERR][VRF] verify pk_size={}", pk_bytes.len()));
        }
        let proof_msg = Self::proof_message(pk_bytes, input, &vrf.output);
        let pk = dilithium3::PublicKey::from_bytes(pk_bytes)
            .map_err(|e| format!("[ERR][VRF] pk_parse err={:?}", e))?;
        let sig = dilithium3::DetachedSignature::from_bytes(&vrf.proof)
            .map_err(|e| format!("[ERR][VRF] sig_parse err={:?}", e))?;
        if dilithium3::verify_detached_signature(&sig, &proof_msg, &pk).is_err() {
            return Ok(false);
        }
        Ok(true)
    }

    // ── Leader election (PUBLIC deterministic hash — nothing here is secret) ──

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


    /// Pick winner: lowest VRF output (deterministic tiebreaker)
    pub fn select_winner(candidates: &[(String, VrfOutput)]) -> Option<(String, VrfOutput)> {
        candidates.iter()
            .min_by_key(|(_, v)| v.output)
            .map(|(id, v)| (id.clone(), v.clone()))
    }

    /// v4.5: PRIMARY deterministic leader selection.
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

    // Hashing is inlined in `evaluate` / `verify_static` with the literal `QNet_VRF_v7_*` domain
    // tags — no shared helpers, so a tag can never drift between signer and verifier.
}

// =========================================================================
// WalletIdentity — seed → wallet address + ML-DSA-65 keypair
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

    /// Sign data with ML-DSA-65 (detached)
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

    /// Re-evaluation MUST be byte-identical even though the ML-DSA signature underneath is randomised
    /// per call: a leader claim is verified against a re-derived output, so a drifting one would make
    /// a node's own claim unverifiable to its peers.
    #[test]
    fn test_vrf_deterministic() {
        let (pk, sk) = dilithium3::keypair();
        let pk_b = PkTrait::as_bytes(&pk).to_vec();
        let mut vrf = DilithiumVrf::new("t1".into());
        vrf.initialize_from_keys(&pk_b, SkTrait::as_bytes(&sk)).unwrap();
        let a = vrf.evaluate(b"input").unwrap();
        let b = vrf.evaluate(b"input").unwrap();

        assert_eq!(a.output, b.output, "VRF output must be deterministic");
        assert_ne!(a.output, vrf.evaluate(b"other").unwrap().output, "output must track the input");
        // Both evaluations verify despite differing signature bytes — determinism lives in the output,
        // not in the proof, so a randomised signer cannot perturb it.
        assert_ne!(a.proof, b.proof, "ML-DSA signing is randomised");
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

    /// What the proof DOES buy: the (input, output) pair is bound to pk, so nobody but the key holder
    /// can put an output on the wire. It does NOT stop the key holder itself from choosing one — that
    /// needs a unique signature, see `evaluate`. This test pins the boundary so the guarantee is not
    /// over-read later.
    #[test]
    fn substituted_output_does_not_verify() {
        let (pk, sk) = dilithium3::keypair();
        let pk_b = PkTrait::as_bytes(&pk).to_vec();
        let mut vrf = DilithiumVrf::new("t3".into());
        vrf.initialize_from_keys(&pk_b, SkTrait::as_bytes(&sk)).unwrap();
        let honest = vrf.evaluate(b"slot-seed").unwrap();
        assert!(DilithiumVrf::verify_static(&pk_b, b"slot-seed", &honest).unwrap());

        // A relay keeps the producer's signature and swaps the output: the signature covers the
        // output, so it fails.
        let tampered = VrfOutput { output: [0u8; 32], proof: honest.proof.clone() };
        assert!(!DilithiumVrf::verify_static(&pk_b, b"slot-seed", &tampered).unwrap(),
                "a substituted output must not verify");
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
