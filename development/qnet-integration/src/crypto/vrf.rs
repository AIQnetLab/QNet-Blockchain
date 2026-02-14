// QNet Dilithium3-VRF: Post-Quantum Verifiable Random Function
// NIST FIPS 204 (ML-DSA-65) + SHA3-256
//
// Construction:
//   evaluate(sk, input) -> (output, proof)
//   verify(pk, input, output, proof) -> bool
//
// SHA3-256 for domain separation + output derivation
// Dilithium3 detached_sign for proof generation (deterministic in PQClean)

use pqcrypto_dilithium::dilithium3;
use pqcrypto_traits::sign::{
    PublicKey as PkTrait,
    SecretKey as SkTrait,
    DetachedSignature as SigTrait,
};
use sha3::{Sha3_256, Digest};

// Domain separation constants
const DOMAIN_EVAL: &[u8] = b"QNet_Dilithium3_VRF_Eval_v3";
const DOMAIN_OUTPUT: &[u8] = b"QNet_Dilithium3_VRF_Output_v3";
const DOMAIN_SLOT: &[u8] = b"QNet_VRF_SlotSeed_v3";

/// Dilithium3 sizes
pub const D3_PK_BYTES: usize = 1952;
pub const D3_SK_BYTES: usize = 4032;
pub const D3_SIG_BYTES: usize = 3293;

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

    /// Get secret key bytes (for block signing)
    /// SECURITY: Only call from trusted signing code paths
    pub fn get_secret_key_bytes(&self) -> Option<Vec<u8>> {
        self.sk.clone()
    }

    // ── Core VRF ─────────────────────────────────────────────────────────

    /// Evaluate VRF (deterministic: same sk+input → same output)
    pub fn evaluate(&self, input: &[u8]) -> Result<VrfOutput, String> {
        let sk_bytes = self.sk.as_ref()
            .ok_or("[ERR][VRF] not initialized")?;
        let msg = Self::hash_input(input);
        let sk = dilithium3::SecretKey::from_bytes(sk_bytes)
            .map_err(|e| format!("[ERR][VRF] sk_parse err={:?}", e))?;
        let sig = dilithium3::detached_sign(&msg, &sk);
        let proof = SigTrait::as_bytes(&sig).to_vec();
        let output = Self::derive_output(&proof);
        Ok(VrfOutput { output, proof })
    }

    /// Verify VRF proof (stateless, no secret key needed)
    pub fn verify_static(pk_bytes: &[u8], input: &[u8], vrf: &VrfOutput) -> Result<bool, String> {
        if pk_bytes.len() != D3_PK_BYTES {
            return Err(format!("[ERR][VRF] verify pk_size={}", pk_bytes.len()));
        }
        let msg = Self::hash_input(input);
        let pk = dilithium3::PublicKey::from_bytes(pk_bytes)
            .map_err(|e| format!("[ERR][VRF] pk_parse err={:?}", e))?;
        let sig = dilithium3::DetachedSignature::from_bytes(&vrf.proof)
            .map_err(|e| format!("[ERR][VRF] sig_parse err={:?}", e))?;
        if dilithium3::verify_detached_signature(&sig, &msg, &pk).is_err() {
            return Ok(false);
        }
        Ok(Self::derive_output(&vrf.proof) == vrf.output)
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
    /// P(0 winners) ~ e^(-EXPECTED_WINNERS) ~ 2e-9 — practically impossible.
    pub fn calculate_threshold(rep: f64, total_rep: f64) -> u128 {
        if total_rep <= 0.0 || rep <= 0.0 { return 0; }
        let p = (Self::EXPECTED_WINNERS * rep / total_rep).min(1.0);
        (u128::MAX as f64 * p).min(u128::MAX as f64) as u128
    }

    /// Pick winner: lowest VRF output (deterministic tiebreaker)
    pub fn select_winner(candidates: &[(String, VrfOutput)]) -> Option<(String, VrfOutput)> {
        candidates.iter()
            .min_by_key(|(_, v)| v.output)
            .map(|(id, v)| (id.clone(), v.clone()))
    }

    /// Deterministic secondary leader — fallback when VRF produces 0 claims.
    /// SHA3-256(domain ++ slot_seed ++ height ++ round) -> candidate index.
    /// Predictable but guaranteed — ensures liveness under any conditions.
    pub fn deterministic_fallback(
        slot_seed: &[u8; 32], height: u64, round: u64, num_candidates: usize,
    ) -> usize {
        if num_candidates == 0 { return 0; }
        let mut h = Sha3_256::new();
        h.update(b"QNET_SECONDARY_V1");
        h.update(slot_seed);
        h.update(&height.to_le_bytes());
        h.update(&round.to_le_bytes());
        let result = h.finalize();
        let idx_bytes: [u8; 8] = result[..8].try_into().unwrap_or([0u8; 8]);
        let idx = u64::from_le_bytes(idx_bytes);
        (idx % num_candidates as u64) as usize
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    fn hash_input(input: &[u8]) -> Vec<u8> {
        let mut h = Sha3_256::new();
        h.update(DOMAIN_EVAL);
        h.update(input);
        h.finalize().to_vec()
    }

    fn derive_output(proof: &[u8]) -> [u8; 32] {
        let mut h = Sha3_256::new();
        h.update(DOMAIN_OUTPUT);
        h.update(proof);
        let r = h.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&r);
        out
    }
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

    /// Derive EON wallet address from seed
    /// Format: {19hex}eon{15hex}{4hex checksum} = 41 chars
    pub fn derive_wallet_address(seed: &str) -> String {
        let hash = Sha3_256::digest(format!("QNet_Wallet_v1{}", seed).as_bytes());
        let hex_str = hex::encode(&hash);
        let p1 = &hex_str[..19];
        let p2 = &hex_str[19..34];
        let body = format!("{}eon{}", p1, p2);
        let ck = hex::encode(&Sha3_256::digest(body.as_bytes())[..2]);
        format!("{}eon{}{}", p1, p2, ck)
    }

    /// Sign data with Dilithium3 (detached)
    pub fn sign(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        let sk = dilithium3::SecretKey::from_bytes(&self.dilithium_sk)
            .map_err(|e| format!("[ERR][WALLET] sk_parse err={:?}", e))?;
        Ok(SigTrait::as_bytes(&dilithium3::detached_sign(data, &sk)).to_vec())
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
}

impl Drop for WalletIdentity {
    fn drop(&mut self) {
        for b in self.dilithium_sk.iter_mut() { *b = 0; }
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
        let (pk, sk) = dilithium3::keypair();
        let mut vrf = DilithiumVrf::new("t1".into());
        vrf.initialize_from_keys(PkTrait::as_bytes(&pk), SkTrait::as_bytes(&sk)).unwrap();
        let a = vrf.evaluate(b"input").unwrap();
        let b = vrf.evaluate(b"input").unwrap();
        assert_eq!(a.output, b.output);
        assert_eq!(a.proof, b.proof);
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
        assert_eq!(a.len(), 41);
        assert!(a.contains("eon"));
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
        let expected = (u128::MAX as f64 * 0.02) as u128;
        assert!(t1000 > 0);
        assert!((t1000 as f64 - expected as f64).abs() / (expected as f64) < 0.01);

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
