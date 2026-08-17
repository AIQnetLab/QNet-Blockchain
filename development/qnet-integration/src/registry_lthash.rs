//! LtHash — homomorphic (incremental, order-independent) multiset hash for `registry_root`.
//!
//! WHY: `registry_root` must commit the full chain-confirmed roster {node_id, wallet, reg_height,
//! burn} (super+light) into the QC checkpoint, recomputed on snapshot-verify and checked in
//! `content_ok` every checkpoint. A flat sequential-SHA3 recompute is O(N) per checkpoint per
//! validator — a liveness cliff at millions. An ADDITIVE-mod-2^256 set hash is O(1) but
//! CRYPTOGRAPHICALLY FORGEABLE by Wagner/generalized-birthday on an adversary-chosen snapshot roster
//! (and `registry_root` is exactly that anti-forge boundary), so it is unusable.
//!
//! LtHash (Lewi-Kim-Boneh-Wu; Facebook/Folly `LtHash16`) is the right primitive: the state is a
//! vector of `LANES` 16-bit lanes; a row contributes `expand(row)` (a SHAKE256 stream split into
//! lanes); the multiset hash is the component-wise wrapping sum of all rows' lane vectors. It is:
//!   * order-independent / commutative  → add rows in any order, identical result;
//!   * incremental and REVERSIBLE        → `add` then `sub` the same row is a no-op (reorg/re-reg);
//!   * collision-resistant at 1024×16    → the 2048-byte state is one lattice, NOT 1024 independent
//!     16-bit targets (expand() couples all lanes through one SHAKE stream), so the generalized-
//!     birthday attack that breaks additive-mod-2^N stays well above 128 bits.
//!
//! `registry_root` = sha3-256(state bytes): a forged roster must collide the full 2048-byte LtHash
//! state (the parameter set's hardness) or sha3 itself (2^128). The sha3 wrapper only narrows output.
//!
//! DETERMINISM: `expand` is a pure function of the canonical row bytes (domain tag + length-prefixed
//! fields, fixed little-endian), so every node computes byte-identical contributions. The SAME
//! `row_lanes` helper MUST be used by both the incremental-apply path and the from-scratch recompute
//! (reorg/boot/snapshot/fallback) — they differ only in iteration order, which LtHash makes irrelevant.

use sha3::{Digest, Sha3_256, Shake256};
use sha3::digest::{ExtendableOutput, Update, XofReader};

/// 1024 lanes × 16-bit = 2048-byte state (Folly LtHash16 / LKBW parameter set, >128-bit security).
pub const LANES: usize = 1024;
/// Serialized state size in bytes (LANES × 2).
pub const STATE_BYTES: usize = LANES * 2;

/// The incremental multiset-hash accumulator: component-wise wrapping-add of every row's lanes.
#[derive(Clone)]
pub struct LtHash {
    lanes: [u16; LANES],
}

impl Default for LtHash {
    fn default() -> Self { LtHash { lanes: [0u16; LANES] } }
}

impl LtHash {
    /// Empty accumulator (the root of the empty roster).
    pub fn new() -> Self { Self::default() }

    /// Restore from the 2048-byte serialized state (little-endian lanes). Wrong length ⇒ empty.
    pub fn from_bytes(b: &[u8]) -> Self {
        let mut s = LtHash::new();
        if b.len() == STATE_BYTES {
            for i in 0..LANES {
                s.lanes[i] = u16::from_le_bytes([b[2 * i], b[2 * i + 1]]);
            }
        }
        s
    }

    /// Serialize to 2048 bytes (little-endian lanes) for storage.
    pub fn to_bytes(&self) -> [u8; STATE_BYTES] {
        let mut out = [0u8; STATE_BYTES];
        for i in 0..LANES {
            let le = self.lanes[i].to_le_bytes();
            out[2 * i] = le[0];
            out[2 * i + 1] = le[1];
        }
        out
    }

    /// Add a row's contribution (component-wise wrapping add). Order-independent.
    pub fn add(&mut self, row_lanes: &[u16; LANES]) {
        for i in 0..LANES {
            self.lanes[i] = self.lanes[i].wrapping_add(row_lanes[i]);
        }
    }

    /// Remove a row's contribution (component-wise wrapping sub) — the exact inverse of `add`.
    pub fn remove(&mut self, row_lanes: &[u16; LANES]) {
        for i in 0..LANES {
            self.lanes[i] = self.lanes[i].wrapping_sub(row_lanes[i]);
        }
    }

    /// The committed digest: sha3-256 over the serialized state. This is `registry_root`.
    pub fn root(&self) -> [u8; 32] {
        let mut h = Sha3_256::new();
        Digest::update(&mut h, b"qnet-registry-root-v2");
        Digest::update(&mut h, self.to_bytes());
        h.finalize().into()
    }
}

/// Canonical per-row lane vector — the ONE shared helper used by BOTH the incremental delta and the
/// from-scratch recompute, so they can never drift. seed = sha3-256(domain ‖ len-prefixed fields);
/// the seed seeds SHAKE256, whose 2048-byte stream is split into 1024 little-endian u16 lanes.
/// Fields = the chain-confirmed identity {node_id, wallet, reg_height, reg_index, node_type, burn,
/// vrf_pk_sha3}. vrf_pk_sha3
/// is sha3-256 of the node's consensus pubkey (super/genesis), so registry_root binds the QC signer
/// keys — a light client verifies a served committee pubkey against the QC-signed root. Light/keyless
/// rows pass empty (consistently length-prefixed, like burn). Must be co-resident (written in the
/// registration batch from the NodeRegistration TX) so every node hashes the same bytes.
/// v4 adds `reg_index` and `node_type`.
///
/// `reg_index` is the node's permanent ordinal — every eligibility bitmap is indexed by it, so it
/// must be root-covered or a snapshot could hand a node a different bit than the network agreed on.
///
/// `node_type` was the half of the hole `reg_index` alone does not close: the row is admitted whole
/// from a snapshot, and flipping a super's type to "light" adds an `lrtr_` entry while the row still
/// folds exactly once — so `registry_root` MATCHED while the light roster silently gained a super.
/// It is also writable through the RPC cache path with a peer-supplied value, unlike every other
/// field here. Hashing it and freezing it are both required; either alone leaves the hole open.
pub fn row_lanes(
    node_id: &str,
    wallet: &str,
    reg_height: u64,
    reg_index: u32,
    node_type: &str,
    burn: &str,
    vrf_pk_sha3: &[u8],
) -> [u16; LANES] {
    let mut seed = Sha3_256::new();
    Digest::update(&mut seed, b"qnet-registry-row-v4");
    Digest::update(&mut seed, (node_id.len() as u32).to_le_bytes());
    Digest::update(&mut seed, node_id.as_bytes());
    Digest::update(&mut seed, (wallet.len() as u32).to_le_bytes());
    Digest::update(&mut seed, wallet.as_bytes());
    Digest::update(&mut seed, reg_height.to_le_bytes());
    Digest::update(&mut seed, reg_index.to_le_bytes());
    Digest::update(&mut seed, (node_type.len() as u32).to_le_bytes());
    Digest::update(&mut seed, node_type.as_bytes());
    Digest::update(&mut seed, (burn.len() as u32).to_le_bytes());
    Digest::update(&mut seed, burn.as_bytes());
    Digest::update(&mut seed, (vrf_pk_sha3.len() as u32).to_le_bytes());
    Digest::update(&mut seed, vrf_pk_sha3);
    let seed = seed.finalize();

    let mut xof = Shake256::default();
    xof.update(&seed);
    let mut reader = xof.finalize_xof();
    let mut buf = [0u8; STATE_BYTES];
    reader.read(&mut buf);

    let mut lanes = [0u16; LANES];
    for i in 0..LANES {
        lanes[i] = u16::from_le_bytes([buf[2 * i], buf[2 * i + 1]]);
    }
    lanes
}

/// FIX-5: LtHash row for one account's (address -> ML-DSA-65 pk) binding. Bound into the 2f+1
/// Checkpoint as `dilithium_pk_root` so a node joining via an UNTRUSTED snapshot can verify the
/// restored per-account pubkeys match the committed set — a malicious snapshot that omits/alters an
/// account's pk fails the root check (→ snapshot rejected) instead of stalling that account's elided
/// TXs forever at 100k cold-join. Same SOUND-INCREMENTAL LtHash primitive as the registry: O(1) to
/// add per first-use pk-bind, O(1) to read via the per-checkpoint seal, collision-resistant on an
/// adversary-chosen snapshot set (plain additive set-hash is forgeable; LtHash is not). Length-
/// prefixed so no address/pk pair aliases another. Domain-separated from the registry row.
pub fn pk_row_lanes(address: &str, pk: &[u8]) -> [u16; LANES] {
    lanes_from_seed(&pk_row_seed(address, pk))
}

/// 32-byte seed of a dpk row. Journaled per unfinalized bind (dpkj_): 32 bytes reproduce the full
/// lane vector for reorg subtraction without storing the 1952-byte pk.
pub fn pk_row_seed(address: &str, pk: &[u8]) -> [u8; 32] {
    let mut seed = Sha3_256::new();
    Digest::update(&mut seed, b"qnet-dpk-row-v1");
    Digest::update(&mut seed, (address.len() as u32).to_le_bytes());
    Digest::update(&mut seed, address.as_bytes());
    Digest::update(&mut seed, (pk.len() as u32).to_le_bytes());
    Digest::update(&mut seed, pk);
    seed.finalize().into()
}

/// Expand a row seed into its lane vector (SHAKE256 stream, LE u16 lanes).
pub fn lanes_from_seed(seed: &[u8; 32]) -> [u16; LANES] {
    let mut xof = Shake256::default();
    xof.update(seed);
    let mut reader = xof.finalize_xof();
    let mut buf = [0u8; STATE_BYTES];
    reader.read(&mut buf);

    let mut lanes = [0u16; LANES];
    for i in 0..LANES {
        lanes[i] = u16::from_le_bytes([buf[2 * i], buf[2 * i + 1]]);
    }
    lanes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_is_order_independent() {
        let a = row_lanes("super_a", "wA", 10, 0, "super", "bA", b"kA");
        let b = row_lanes("super_b", "wB", 20, 0, "super", "bB", b"kB");
        let c = row_lanes("light_c", "wC", 30, 0, "light", "", b"");
        let mut s1 = LtHash::new();
        s1.add(&a); s1.add(&b); s1.add(&c);
        let mut s2 = LtHash::new();
        s2.add(&c); s2.add(&a); s2.add(&b); // different order
        assert_eq!(s1.root(), s2.root(), "LtHash must be order-independent (multiset)");
    }

    #[test]
    fn add_then_remove_is_noop() {
        let a = row_lanes("super_a", "wA", 10, 0, "super", "bA", b"kA");
        let b = row_lanes("super_b", "wB", 20, 0, "super", "bB", b"kB");
        let mut s = LtHash::new();
        s.add(&a); s.add(&b);
        let before = s.root();
        s.add(&b); // a re-applied row
        s.remove(&b); // undone
        assert_eq!(s.root(), before, "add+remove of the same row is a no-op (reorg/re-reg/idempotency)");
    }

    #[test]
    fn remove_old_add_new_replaces_a_row() {
        // Re-registration: subtract the OLD row, add the NEW row → only NEW remains.
        let old = row_lanes("super_a", "walletOLD", 10, 0, "super", "burnA", b"kA");
        let new = row_lanes("super_a", "walletNEW", 50, 0, "super", "burnA", b"kA");
        let mut live = LtHash::new();
        live.add(&old);            // first registration
        live.remove(&old); live.add(&new); // re-registration delta
        // from-scratch of the FINAL roster (only the new row):
        let mut scratch = LtHash::new();
        scratch.add(&new);
        assert_eq!(live.root(), scratch.root(), "remove(old)+add(new) == from-scratch of the new roster");
    }

    #[test]
    fn distinct_rosters_differ() {
        let mut s1 = LtHash::new();
        s1.add(&row_lanes("super_a", "wA", 10, 0, "super", "bA", b"kA"));
        let mut s2 = LtHash::new();
        s2.add(&row_lanes("super_a", "wATTACKER", 10, 0, "super", "bA", b"kA")); // rebound wallet
        assert_ne!(s1.root(), s2.root(), "a forged burn→wallet binding must change the root");
    }

    #[test]
    fn vrf_pk_binds_root() {
        // The consensus signer key is committed: swapping it changes the root, so a light
        // client cannot be fed a forged committee pubkey that still matches registry_root.
        let mut s1 = LtHash::new();
        s1.add(&row_lanes("super_a", "wA", 10, 0, "super", "bA", b"key_honest"));
        let mut s2 = LtHash::new();
        s2.add(&row_lanes("super_a", "wA", 10, 0, "super", "bA", b"key_forged"));
        assert_ne!(s1.root(), s2.root(), "a swapped consensus pubkey must change the root");
    }

    #[test]
    fn pk_seed_expand_equals_direct() {
        // Journal stores the 32-byte seed; subtraction re-expands it. Must equal the add-path lanes.
        let pk = vec![7u8; 1952];
        let direct = pk_row_lanes("eon_addr", &pk);
        let via_seed = lanes_from_seed(&pk_row_seed("eon_addr", &pk));
        assert_eq!(direct, via_seed);
    }

    #[test]
    fn serialize_roundtrip() {
        let mut s = LtHash::new();
        s.add(&row_lanes("super_a", "wA", 10, 0, "super", "bA", b"kA"));
        s.add(&row_lanes("light_b", "wB", 20, 0, "light", "bB", b""));
        let bytes = s.to_bytes();
        let restored = LtHash::from_bytes(&bytes);
        assert_eq!(s.root(), restored.root(), "state must round-trip through bytes");
    }

    #[test]
    fn empty_state_root_is_stable() {
        assert_eq!(LtHash::new().root(), LtHash::new().root());
        assert_eq!(LtHash::from_bytes(&[]).root(), LtHash::new().root(), "bad length ⇒ empty");
    }

    /// The Rust HALF of the cross-language registry_root pin. Not #[ignore]: an emitter that only
    /// prints leaves the JS test asserting against its own frozen constant, so a preimage change on
    /// this side keeps BOTH suites green while the device silently rejects every registry proof —
    /// and with it every committee pubkey it resolves. Asserting the same constant here means the
    /// break surfaces on `cargo test`, in the same commit that causes it.
    #[test]
    fn registry_root_cross_language_vector_is_pinned() {
        let rows = [
            ("genesis_node_001", "wallet_g1", 10u64, 0u32, "super", "burn_g1"),
            ("super_abc123",     "wallet_s1", 4200u64, 1u32, "super", "burn_s1"),
            ("light_def456",     "wallet_l1", 9001u64, 2u32, "light", ""),
        ];
        let mut lt = LtHash::new();
        for (id, w, h, idx, ty, burn) in rows.iter() {
            let vrf = if *ty == "super" { vec![0xABu8; 32] } else { Vec::new() };
            lt.add(&row_lanes(id, w, *h, *idx, ty, burn, &vrf));
            println!("VECTOR_ROW={}|{}|{}|{}|{}|{}|{}", id, w, h, idx, ty, burn, hex::encode(&vrf));
        }
        let root = hex::encode(lt.root());
        println!("VECTOR_REGISTRY_ROOT={}", root);
        // Mirrored verbatim by applications/qnet-mobile/__tests__/RegistryRootPin.test.js.
        assert_eq!(root, "a3b7cbb3aa2e3a4829e98569c2e6bc63ba4a1480c09845fc5525c511b9c4b30a",
                   "registry row preimage changed — regenerate the mobile pin in the SAME commit");
    }
}
