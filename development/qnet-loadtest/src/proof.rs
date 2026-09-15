//! P3b — independent verification that a transaction's log leaf is committed in the window `logs_root`,
//! via the node `GET /api/v1/logs/proof` SHARDED 2-level merkle proof.
//!
//! Byte-identical to node `qnet-consensus/src/checkpoint_bft.rs::{verify_logs_merkle_proof,
//! verify_logs_window_proof}` and the mobile `QcLightClient.{verifyLogInclusion,verifyLogWindowInclusion}`:
//!   L1 leaf : cur = SHA3_256("log-leaf" || raw_leaf); node "log-node" || (cur,sib order by `right`)
//!             → accept L1 iff hex(cur) == block_root.
//!   L2 leaf : cur = SHA3_256("logw-leaf" || block_root); node "logw-node" || (order by `right`)
//!             → accept iff hex(cur) == logs_root.
//!
//! Scope: this is a MEASUREMENT harness — it proves inclusion against the `logs_root` the endpoint
//! returns, but does NOT QC-anchor that root to the committed `Checkpoint.logs_root` (the mobile light
//! client does that via verifyMacroblockLogsRoot; the harness only samples proof correctness + latency).

use sha3::{Digest as _, Sha3_256};

/// One proof element: a sibling hash and whether it sits on the RIGHT of the
/// current node (i.e. current node is the left child).
#[derive(Debug, Clone)]
pub struct ProofStep {
    pub hash: [u8; 32],
    pub right: bool,
}

/// Fold the leaf up through the proof and compare to the expected root (hex).
pub fn verify_logs_merkle_proof(raw_leaf: &[u8], proof: &[ProofStep], expected_root_hex: &str) -> bool {
    let mut cur: [u8; 32] = {
        let mut h = Sha3_256::new();
        h.update(b"log-leaf");
        h.update(raw_leaf);
        h.finalize().into()
    };
    for step in proof {
        let mut h = Sha3_256::new();
        h.update(b"log-node");
        if step.right {
            h.update(cur);
            h.update(step.hash);
        } else {
            h.update(step.hash);
            h.update(cur);
        }
        cur = h.finalize().into();
    }
    hex::encode(cur) == expected_root_hex.to_lowercase()
}

/// LEVEL 2 (sharded logs): fold a block sub-root up the window proof to the committed `logs_root`.
/// Byte-mirror of checkpoint_bft::verify_logs_window_proof (sha3 "logw-leaf"/"logw-node"). The endpoint
/// returns a 2-level proof: `proof` (leaf→block_root) + `window_proof` (block_root→logs_root); accept iff
/// verify_logs_merkle_proof(leaf, proof, block_root) AND this folds block_root to logs_root.
pub fn verify_logs_window_proof(sub_root: &[u8; 32], proof: &[ProofStep], window_root_hex: &str) -> bool {
    let mut cur: [u8; 32] = {
        let mut h = Sha3_256::new();
        h.update(b"logw-leaf");
        h.update(sub_root);
        h.finalize().into()
    };
    for step in proof {
        let mut h = Sha3_256::new();
        h.update(b"logw-node");
        if step.right {
            h.update(cur);
            h.update(step.hash);
        } else {
            h.update(step.hash);
            h.update(cur);
        }
        cur = h.finalize().into();
    }
    hex::encode(cur) == window_root_hex.to_lowercase()
}

/// Parse the endpoint's `proof` JSON array (`[{"hash":<64hex>,"right":<bool>}]`)
/// into typed steps.
pub fn parse_proof(arr: &[serde_json::Value]) -> Result<Vec<ProofStep>, String> {
    arr.iter().map(|el| {
        let hx = el.get("hash").and_then(|v| v.as_str()).ok_or("proof step missing hash")?;
        let right = el.get("right").and_then(|v| v.as_bool()).ok_or("proof step missing right")?;
        let mut hash = [0u8; 32];
        hex::decode_to_slice(hx, &mut hash).map_err(|e| format!("bad proof hash hex: {e}"))?;
        Ok(ProofStep { hash, right })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf_hash(l: &[u8]) -> [u8; 32] {
        let mut h = Sha3_256::new(); h.update(b"log-leaf"); h.update(l); h.finalize().into()
    }
    fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
        let mut h = Sha3_256::new(); h.update(b"log-node"); h.update(a); h.update(b); h.finalize().into()
    }

    #[test]
    fn single_leaf_root_is_leaf_hash() {
        let leaf = b"only-leaf";
        let root = hex::encode(leaf_hash(leaf));
        assert!(verify_logs_merkle_proof(leaf, &[], &root));
        assert!(!verify_logs_merkle_proof(b"other", &[], &root));
    }

    #[test]
    fn two_leaf_left_and_right() {
        let (l0, l1) = (b"leaf-0".as_slice(), b"leaf-1".as_slice());
        let (h0, h1) = (leaf_hash(l0), leaf_hash(l1));
        let root = hex::encode(node_hash(&h0, &h1));
        // leaf 0 is the LEFT child → sibling h1 on the RIGHT.
        assert!(verify_logs_merkle_proof(l0, &[ProofStep { hash: h1, right: true }], &root));
        // leaf 1 is the RIGHT child → sibling h0 on the LEFT.
        assert!(verify_logs_merkle_proof(l1, &[ProofStep { hash: h0, right: false }], &root));
        // wrong side must fail.
        assert!(!verify_logs_merkle_proof(l0, &[ProofStep { hash: h1, right: false }], &root));
    }
}
