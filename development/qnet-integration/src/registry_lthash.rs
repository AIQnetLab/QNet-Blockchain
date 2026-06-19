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
/// Fields are EXACTLY the chain-confirmed identity {node_id, wallet, reg_height, burn} — never the
/// raw node_ JSON (which carries a non-deterministic timestamp + mutable reputation). Genesis/light-
/// not-yet-attested rows carry burn="" and are hashed with the empty burn (consistently included).
pub fn row_lanes(node_id: &str, wallet: &str, reg_height: u64, burn: &str) -> [u16; LANES] {
    let mut seed = Sha3_256::new();
    Digest::update(&mut seed, b"qnet-registry-row-v2");
    Digest::update(&mut seed, (node_id.len() as u32).to_le_bytes());
    Digest::update(&mut seed, node_id.as_bytes());
    Digest::update(&mut seed, (wallet.len() as u32).to_le_bytes());
    Digest::update(&mut seed, wallet.as_bytes());
    Digest::update(&mut seed, reg_height.to_le_bytes());
    Digest::update(&mut seed, (burn.len() as u32).to_le_bytes());
    Digest::update(&mut seed, burn.as_bytes());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_is_order_independent() {
        let a = row_lanes("super_a", "wA", 10, "bA");
        let b = row_lanes("super_b", "wB", 20, "bB");
        let c = row_lanes("light_c", "wC", 30, "");
        let mut s1 = LtHash::new();
        s1.add(&a); s1.add(&b); s1.add(&c);
        let mut s2 = LtHash::new();
        s2.add(&c); s2.add(&a); s2.add(&b); // different order
        assert_eq!(s1.root(), s2.root(), "LtHash must be order-independent (multiset)");
    }

    #[test]
    fn add_then_remove_is_noop() {
        let a = row_lanes("super_a", "wA", 10, "bA");
        let b = row_lanes("super_b", "wB", 20, "bB");
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
        let old = row_lanes("super_a", "walletOLD", 10, "burnA");
        let new = row_lanes("super_a", "walletNEW", 50, "burnA");
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
        s1.add(&row_lanes("super_a", "wA", 10, "bA"));
        let mut s2 = LtHash::new();
        s2.add(&row_lanes("super_a", "wATTACKER", 10, "bA")); // rebound wallet
        assert_ne!(s1.root(), s2.root(), "a forged burn→wallet binding must change the root");
    }

    #[test]
    fn serialize_roundtrip() {
        let mut s = LtHash::new();
        s.add(&row_lanes("super_a", "wA", 10, "bA"));
        s.add(&row_lanes("light_b", "wB", 20, "bB"));
        let bytes = s.to_bytes();
        let restored = LtHash::from_bytes(&bytes);
        assert_eq!(s.root(), restored.root(), "state must round-trip through bytes");
    }

    #[test]
    fn empty_state_root_is_stable() {
        assert_eq!(LtHash::new().root(), LtHash::new().root());
        assert_eq!(LtHash::from_bytes(&[]).root(), LtHash::new().root(), "bad length ⇒ empty");
    }
}
