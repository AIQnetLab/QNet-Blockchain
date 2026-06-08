// Checkpoint-BFT types (spec: docs/CONSENSUS_V2_SPEC.md).
// One consensus object — the Checkpoint — commits a window of K leader-streamed
// microblocks via a 2f+1 QC. Dilithium sigs are non-aggregatable, so a QC keeps
// a signer set + Merkle root for compact light-client verification.

use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use std::collections::HashSet;

pub type NodeId = String;
pub type Hash = [u8; 32];

/// BFT quorum = n−f, f = floor((n-1)/3). 0 for empty set. n−f (not 2f+1) is the
/// safe threshold when n>3f+1: any two quorums then share ≥f+1 nodes ⇒ ≥1 honest ⇒
/// no two conflicting QCs. (n−f == 2f+1 exactly when n=3f+1.) E.g. n=5⇒4, n=100⇒67.
pub fn quorum_size(committee_len: usize) -> usize {
    if committee_len == 0 { return 0; }
    let f = (committee_len - 1) / 3;
    committee_len - f
}

/// Deterministic leader for checkpoint `index`, seeded ONLY by the committed
/// parent hash — one agreed input ⇒ identical leader on every honest node.
pub fn leader_index(index: u64, parent_checkpoint_hash: &Hash, committee_len: usize) -> usize {
    if committee_len == 0 { return 0; }
    let mut h = Sha3_256::new();
    h.update(b"qnet-leader-v2");
    h.update(index.to_le_bytes());
    h.update(parent_checkpoint_hash);
    let d = h.finalize();
    let mut x = [0u8; 8];
    x.copy_from_slice(&d[..8]);
    (u64::from_le_bytes(x) % committee_len as u64) as usize
}

/// Canonical committee parameters: when the eligible set exceeds `COMMITTEE_THRESHOLD`,
/// consensus runs over a VRF-sampled committee of `COMMITTEE_SIZE`. Single source of truth.
pub const COMMITTEE_THRESHOLD: usize = 120;
pub const COMMITTEE_SIZE: usize = 100;

/// Deterministic VRF committee subsample. `sorted_candidates` MUST be sorted by node_id by the
/// caller, so the index→candidate mapping is identical on every node; `window` is the macroblock
/// index the committee serves; `seed` is that window's N-2 randomness beacon. ≤ `threshold` ⇒ the
/// whole set is the committee (no subsample). Pure & deterministic.
///
/// THE single committee-selection function: BOTH the macroblock checkpoint sealer AND the
/// microblock-failover voting set call this with the same inputs, so the two consensus layers
/// can NEVER disagree on committee membership (a divergent re-implementation would fork the
/// chain — which is exactly why this is one shared function, not two copies).
pub fn sample_committee(
    sorted_candidates: &[NodeId],
    window: u64,
    seed: &Hash,
    threshold: usize,
    size: usize,
) -> Vec<NodeId> {
    if sorted_candidates.len() <= threshold {
        return sorted_candidates.to_vec();
    }
    let mut scored: Vec<(usize, Hash)> = sorted_candidates
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let mut h = Sha3_256::new();
            h.update(b"COMMITTEE_VRF_v3.36");
            h.update(&seed[..]);
            h.update(window.to_le_bytes());
            h.update((i as u64).to_le_bytes());
            let hash: Hash = h.finalize().into();
            (i, hash)
        })
        .collect();
    scored.sort_by(|a, b| a.1.cmp(&b.1));
    scored.truncate(size);
    scored.sort_by_key(|&(idx, _)| idx);
    scored.iter().map(|(idx, _)| sorted_candidates[*idx].clone()).collect()
}

/// VRF-only randomness beacon (§4.6): XOR-accumulate verifiable VRF outputs of an
/// epoch's committed microblocks, then domain-hash. XOR is order-independent ⇒
/// identical on every node regardless of collection order. Replaces RANDAO.
pub fn accumulate_beacon(vrf_outputs: &[Hash]) -> Hash {
    let mut acc = [0u8; 32];
    for o in vrf_outputs {
        for i in 0..32 { acc[i] ^= o[i]; }
    }
    let mut h = Sha3_256::new();
    h.update(b"qnet-beacon-v2");
    h.update(acc);
    h.finalize().into()
}

/// Commitment over a checkpoint's epoch-transition data: the next-epoch eligible-producer
/// snapshot (opaque bytes), the committee (order-independent), and the cumulative ban set
/// (order-independent). Bound into the checkpoint hash ⇒ the QC certifies the validator set
/// AND the bans; syncing nodes verify the macroblock's published set/banned_validators against
/// it instead of re-running the full epoch scan, so a relayer cannot corrupt the stored ban
/// set without breaking the QC. A domain tag + length prefix separate committee from bans, so
/// no element can migrate across the boundary and preserve the byte stream (canonical).
pub fn epoch_commitment(eligible_producers: &[u8], committee: &[NodeId], banned: &[NodeId]) -> Hash {
    let mut cs: Vec<&NodeId> = committee.iter().collect();
    cs.sort();
    let mut bs: Vec<&NodeId> = banned.iter().collect();
    bs.sort();
    let mut h = Sha3_256::new();
    h.update(b"qnet-epoch-v2");
    h.update((eligible_producers.len() as u64).to_le_bytes());
    h.update(eligible_producers);
    for c in cs { h.update(c.as_bytes()); h.update([0u8]); }
    h.update(b"banned");
    h.update((bs.len() as u64).to_le_bytes());
    for b in bs { h.update(b.as_bytes()); h.update([0u8]); }
    h.finalize().into()
}

/// A committee member's vote on a checkpoint hash (Dilithium sig over the hash).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Vote {
    pub checkpoint_hash: Hash,
    pub index: u64,
    pub voter: NodeId,
    pub signature: Vec<u8>,
}

/// 2f+1 distinct committee votes over one checkpoint.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QuorumCertificate {
    pub checkpoint_hash: Hash,
    pub index: u64,
    pub signers: Vec<NodeId>,
    pub sig_merkle_root: Hash,
    pub sigs: Vec<Vec<u8>>, // aligned with `signers`
}

/// One replica's timeout for view `index`, carrying its highest-QC index.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TimeoutMsg {
    pub index: u64,
    pub voter: NodeId,
    pub high_qc_index: u64, // 0 = none
    pub signature: Vec<u8>,
}

/// 2f+1 timeouts ⇒ advance the checkpoint view; carries the highest QC seen.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TimeoutCertificate {
    pub index: u64,
    pub timeouts: Vec<TimeoutMsg>,
    pub high_qc: Option<QuorumCertificate>,
}

/// The consensus object: commits `window_mb_hashes` (K microblocks) at finality.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Checkpoint {
    pub index: u64,
    pub parent_qc: Option<QuorumCertificate>,
    pub window_head_height: u64,
    pub window_mb_hashes: Vec<Hash>,
    pub state_root: Hash,
    pub beacon: Hash,
    /// Commitment to the epoch-transition data this checkpoint publishes (next-epoch
    /// eligible producers + committee). In the QC-signed hash ⇒ 2f+1 certify the
    /// validator set, so syncing (non-committee) nodes trust it without re-deriving.
    pub epoch_commitment: Hash,
    /// Proposer's wall-clock for this window (the head microblock's timestamp).
    /// In the QC-signed hash ⇒ agreed by the committee ⇒ every node seals an
    /// identical MacroBlock from the checkpoint (no producer dependency, no fork).
    pub timestamp: u64,
    pub proposer: NodeId,
    pub proposer_sig: Vec<u8>,
}

impl Checkpoint {
    /// Canonical hash over consensus-critical fields (excludes proposer_sig).
    pub fn hash(&self) -> Hash {
        let mut h = Sha3_256::new();
        h.update(b"qnet-checkpoint-v2");
        h.update(self.index.to_le_bytes());
        if let Some(qc) = &self.parent_qc {
            h.update(qc.checkpoint_hash);
            h.update(qc.index.to_le_bytes());
        }
        h.update(self.window_head_height.to_le_bytes());
        for mh in &self.window_mb_hashes { h.update(mh); }
        h.update(self.state_root);
        h.update(self.beacon);
        h.update(self.epoch_commitment);
        h.update(self.timestamp.to_le_bytes());
        h.update(self.proposer.as_bytes());
        h.finalize().into()
    }
}

/// Merkle root over an ordered signature list (light clients verify root + sample).
pub fn sig_merkle_root(sigs: &[Vec<u8>]) -> Hash {
    if sigs.is_empty() { return [0u8; 32]; }
    let mut layer: Vec<Hash> = sigs.iter().map(|s| {
        let mut h = Sha3_256::new(); h.update(b"leaf"); h.update(s); h.finalize().into()
    }).collect();
    while layer.len() > 1 {
        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        for pair in layer.chunks(2) {
            let mut h = Sha3_256::new();
            h.update(b"node");
            h.update(pair[0]);
            h.update(if pair.len() == 2 { pair[1] } else { pair[0] });
            next.push(h.finalize().into());
        }
        layer = next;
    }
    layer[0]
}

impl QuorumCertificate {
    /// Structural + cryptographic validity. `verify_sig(voter, msg, sig)` is
    /// injected so this crate stays crypto-agnostic. `committee` = sorted epoch set.
    pub fn verify<F: Fn(&str, &[u8], &[u8]) -> bool>(
        &self,
        committee: &[NodeId],
        verify_sig: F,
    ) -> Result<(), &'static str> {
        let q = quorum_size(committee.len());
        if q == 0 || self.signers.len() < q { return Err("qc_below_quorum"); }
        if self.signers.len() != self.sigs.len() { return Err("qc_len_mismatch"); }
        let mut seen = HashSet::new();
        for s in &self.signers {
            if !seen.insert(s.as_str()) { return Err("qc_duplicate_signer"); }
            if !committee.iter().any(|c| c == s) { return Err("qc_non_member"); }
        }
        if sig_merkle_root(&self.sigs) != self.sig_merkle_root { return Err("qc_merkle_mismatch"); }
        for (voter, sig) in self.signers.iter().zip(self.sigs.iter()) {
            if !verify_sig(voter, &self.checkpoint_hash, sig) { return Err("qc_bad_sig"); }
        }
        Ok(())
    }
}

impl TimeoutCertificate {
    /// Structural + cryptographic validity (mirror of `QuorumCertificate::verify`).
    /// A TC is valid iff it carries ≥ `quorum_size` DISTINCT committee members' timeouts,
    /// ALL for this TC's view (`index`), each signature valid, and — if it carries a
    /// `high_qc` — that QC verifies too. Crypto-agnostic: the caller injects the per-timeout
    /// signature check and the high_qc check. This is the gate that stops a forged/empty TC
    /// from advancing a node's view: without it, `Tc { timeouts: [], high_qc: None }` was
    /// accepted and bumped `current_index` monotonically — an unauthenticated, non-self-healing
    /// view-desync DoS (adopt_qc never rewinds the view).
    pub fn verify<F, Q>(
        &self,
        committee: &[NodeId],
        verify_timeout_sig: F,
        verify_qc: Q,
    ) -> Result<(), &'static str>
    where
        F: Fn(&TimeoutMsg) -> bool,
        Q: Fn(&QuorumCertificate) -> bool,
    {
        let q = quorum_size(committee.len());
        if q == 0 || self.timeouts.len() < q { return Err("tc_below_quorum"); }
        let mut seen = HashSet::new();
        for t in &self.timeouts {
            if t.index != self.index { return Err("tc_index_mismatch"); }
            if !seen.insert(t.voter.as_str()) { return Err("tc_duplicate_voter"); }
            if !committee.iter().any(|c| c == &t.voter) { return Err("tc_non_member"); }
            if !verify_timeout_sig(t) { return Err("tc_bad_sig"); }
        }
        if let Some(hq) = &self.high_qc {
            if !verify_qc(hq) { return Err("tc_bad_high_qc"); }
        }
        Ok(())
    }
}

/// 2-chain commit: given a child checkpoint and its QC, returns the PARENT index
/// that becomes final (child justifies parent and is itself QC'd at index+1).
pub fn commits_parent(child: &Checkpoint, child_qc: &QuorumCertificate) -> Option<u64> {
    let pq = child.parent_qc.as_ref()?;
    if child_qc.index == child.index && child.index == pq.index + 1 {
        Some(pq.index)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(n: u8) -> Hash { [n; 32] }

    #[test]
    fn quorum_math() {
        assert_eq!(quorum_size(0), 0);
        assert_eq!(quorum_size(1), 1);
        assert_eq!(quorum_size(4), 3);   // f=1, n=3f+1 ⇒ n−f=2f+1
        assert_eq!(quorum_size(5), 4);   // f=1, n>3f+1 ⇒ n−f=4 (2f+1=3 would be unsafe)
        assert_eq!(quorum_size(7), 5);   // f=2
        assert_eq!(quorum_size(100), 67);// f=33
        assert_eq!(quorum_size(1000), 667);
    }

    #[test]
    fn beacon_order_independent_and_sensitive() {
        let a = vec![h(1), h(2), h(3)];
        let b = vec![h(3), h(1), h(2)];          // same set, different order
        assert_eq!(accumulate_beacon(&a), accumulate_beacon(&b));
        assert_ne!(accumulate_beacon(&a), accumulate_beacon(&[h(1), h(2)]));
        assert_eq!(accumulate_beacon(&[]), accumulate_beacon(&[]));
    }

    #[test]
    fn leader_is_pure_and_in_range() {
        let p = h(9);
        let a = leader_index(5, &p, 100);
        let b = leader_index(5, &p, 100);
        assert_eq!(a, b);                 // pure function
        assert!(a < 100);                 // in range
        // different input ⇒ may differ, but always deterministic
        assert_eq!(leader_index(6, &p, 100), leader_index(6, &p, 100));
        assert_eq!(leader_index(5, &h(1), 5), leader_index(5, &h(1), 5));
    }

    #[test]
    fn checkpoint_hash_excludes_sig() {
        let mut c = Checkpoint {
            index: 1, parent_qc: None, window_head_height: 90,
            window_mb_hashes: vec![h(1), h(2)], state_root: h(3),
            beacon: h(4), epoch_commitment: h(0), timestamp: 0, proposer: "n1".into(), proposer_sig: vec![1,2,3],
        };
        let x = c.hash();
        c.proposer_sig = vec![9, 9, 9];   // sig change must NOT change hash
        assert_eq!(c.hash(), x);
        c.state_root = h(7);              // field change MUST change hash
        assert_ne!(c.hash(), x);
    }

    #[test]
    fn merkle_root_deterministic_and_sensitive() {
        let a = vec![vec![1u8,2], vec![3,4], vec![5,6]];
        assert_eq!(sig_merkle_root(&a), sig_merkle_root(&a));
        let b = vec![vec![1u8,2], vec![3,4], vec![5,7]];
        assert_ne!(sig_merkle_root(&a), sig_merkle_root(&b));
        assert_eq!(sig_merkle_root(&[]), [0u8; 32]);
    }

    fn mk_qc(committee: &[NodeId], hash: Hash, index: u64, n: usize) -> QuorumCertificate {
        let signers: Vec<NodeId> = committee.iter().take(n).cloned().collect();
        let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
        QuorumCertificate { checkpoint_hash: hash, index, sig_merkle_root: sig_merkle_root(&sigs), signers, sigs }
    }

    #[test]
    fn qc_verify_paths() {
        let committee: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let ok = |_v: &str, _m: &[u8], _s: &[u8]| true;
        // valid: 4 of 5 (quorum = n−f = 4)
        let qc = mk_qc(&committee, h(1), 7, 4);
        assert!(qc.verify(&committee, ok).is_ok());
        // below quorum
        let qc2 = mk_qc(&committee, h(1), 7, 3);
        assert_eq!(qc2.verify(&committee, ok), Err("qc_below_quorum"));
        // non-member
        let mut qc3 = mk_qc(&committee, h(1), 7, 4);
        qc3.signers[0] = "evil".into();
        qc3.sig_merkle_root = sig_merkle_root(&qc3.sigs);
        assert_eq!(qc3.verify(&committee, ok), Err("qc_non_member"));
        // duplicate signer
        let mut qc4 = mk_qc(&committee, h(1), 7, 4);
        qc4.signers[1] = qc4.signers[0].clone();
        assert_eq!(qc4.verify(&committee, ok), Err("qc_duplicate_signer"));
        // merkle mismatch
        let mut qc5 = mk_qc(&committee, h(1), 7, 4);
        qc5.sig_merkle_root = h(99);
        assert_eq!(qc5.verify(&committee, ok), Err("qc_merkle_mismatch"));
        // bad sig
        let qc6 = mk_qc(&committee, h(1), 7, 4);
        let bad = |_v: &str, _m: &[u8], _s: &[u8]| false;
        assert_eq!(qc6.verify(&committee, bad), Err("qc_bad_sig"));
    }

    fn mk_tmo(voter: &str, index: u64) -> TimeoutMsg {
        TimeoutMsg { index, voter: voter.into(), high_qc_index: 0, signature: voter.as_bytes().to_vec() }
    }

    #[test]
    fn tc_verify_paths() {
        let committee: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let vsig = |t: &TimeoutMsg| t.signature == t.voter.as_bytes().to_vec();
        let vqc = |_q: &QuorumCertificate| true;
        // valid: 4 distinct committee timeouts at view 7 (quorum = n−f = 4)
        let good = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), mk_tmo("n3",7)], high_qc: None };
        assert!(good.verify(&committee, vsig, vqc).is_ok());
        // EMPTY timeouts — the H4 attack (was accepted, advanced the view) → reject
        let empty = TimeoutCertificate { index: 7, timeouts: vec![], high_qc: None };
        assert_eq!(empty.verify(&committee, vsig, vqc), Err("tc_below_quorum"));
        // below quorum (3 < 4) → reject
        let short = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7)], high_qc: None };
        assert_eq!(short.verify(&committee, vsig, vqc), Err("tc_below_quorum"));
        // a timeout for a DIFFERENT view → reject
        let wrongidx = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), mk_tmo("n3",6)], high_qc: None };
        assert_eq!(wrongidx.verify(&committee, vsig, vqc), Err("tc_index_mismatch"));
        // duplicate voter → reject
        let dup = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7)], high_qc: None };
        assert_eq!(dup.verify(&committee, vsig, vqc), Err("tc_duplicate_voter"));
        // non-committee voter → reject
        let outsider = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), mk_tmo("evil",7)], high_qc: None };
        assert_eq!(outsider.verify(&committee, vsig, vqc), Err("tc_non_member"));
        // bad timeout signature → reject
        let mut bad_t = mk_tmo("n3",7); bad_t.signature = vec![0];
        let badsig = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), bad_t], high_qc: None };
        assert_eq!(badsig.verify(&committee, vsig, vqc), Err("tc_bad_sig"));
        // carries an invalid high_qc → reject
        let with_bad_qc = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), mk_tmo("n3",7)], high_qc: Some(mk_qc(&committee, h(1), 6, 4)) };
        assert_eq!(with_bad_qc.verify(&committee, vsig, |_q| false), Err("tc_bad_high_qc"));
    }

    #[test]
    fn committee_sample_deterministic_bounded_and_order_preserving() {
        let seed = h(9);
        // ≤ threshold → the WHOLE set is the committee (no subsample). This is why the genesis
        // 5-node net is a no-op: committee == eligible == 5, failover quorum unchanged.
        let small: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        assert_eq!(sample_committee(&small, 7, &seed, COMMITTEE_THRESHOLD, COMMITTEE_SIZE), small);

        // > threshold → subsample to exactly COMMITTEE_SIZE, deterministic, a subset, order-preserving.
        let big: Vec<NodeId> = (0..300).map(|i| format!("n{:03}", i)).collect();
        let c1 = sample_committee(&big, 7, &seed, COMMITTEE_THRESHOLD, COMMITTEE_SIZE);
        assert_eq!(c1, sample_committee(&big, 7, &seed, COMMITTEE_THRESHOLD, COMMITTEE_SIZE), "deterministic");
        assert_eq!(c1.len(), COMMITTEE_SIZE);
        assert!(c1.iter().all(|x| big.contains(x)), "committee ⊆ candidates");
        let uniq: std::collections::HashSet<&String> = c1.iter().collect();
        assert_eq!(uniq.len(), COMMITTEE_SIZE, "distinct members");
        let mut sorted = c1.clone(); sorted.sort();
        assert_eq!(c1, sorted, "preserves sorted-candidate order ⇒ failover & checkpoint match");

        // Same (candidates, window, seed) on both layers ⇒ identical committee; a different window
        // or seed legitimately rotates it.
        assert_ne!(c1, sample_committee(&big, 7, &h(1), COMMITTEE_THRESHOLD, COMMITTEE_SIZE), "seed-sensitive");
        assert_ne!(c1, sample_committee(&big, 8, &seed, COMMITTEE_THRESHOLD, COMMITTEE_SIZE), "window-sensitive");
    }

    #[test]
    fn epoch_commitment_binds_banned() {
        let elig = b"elig-snapshot-bytes";
        let committee: Vec<NodeId> = vec!["c1".into(), "c2".into()];
        let base = epoch_commitment(elig, &committee, &[]);
        let banned_a: Vec<NodeId> = vec!["bad1".into()];
        let banned_b: Vec<NodeId> = vec!["bad1".into(), "bad2".into()];
        let ca = epoch_commitment(elig, &committee, &banned_a);
        let cb = epoch_commitment(elig, &committee, &banned_b);
        // The ban set is bound: any change to it changes the commitment ⇒ a corrupted stored
        // banned_validators can never match the QC-certified checkpoint.
        assert_ne!(base, ca, "adding a ban changes the commitment");
        assert_ne!(base, cb);
        assert_ne!(ca, cb, "ban-set contents are bound, not just length");
        // Order-independent (sorted internally) ⇒ every sealer/verifier agrees regardless of
        // the order the ban set was assembled in.
        let banned_b_rev: Vec<NodeId> = vec!["bad2".into(), "bad1".into()];
        assert_eq!(cb, epoch_commitment(elig, &committee, &banned_b_rev), "ban order does not matter");
        // Domain separation: a member must not be reinterpretable across the committee/ban
        // boundary — committee=[X],banned=[] differs from committee=[],banned=[X].
        let only_committee = epoch_commitment(elig, &vec!["X".into()], &[]);
        let only_banned = epoch_commitment(elig, &[], &vec!["X".into()]);
        assert_ne!(only_committee, only_banned, "committee vs ban are domain-separated");
    }

    #[test]
    fn two_chain_commit() {
        let committee: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let parent_qc = mk_qc(&committee, h(1), 4, 3);
        let child = Checkpoint {
            index: 5, parent_qc: Some(parent_qc), window_head_height: 450,
            window_mb_hashes: vec![h(1)], state_root: h(2), beacon: h(3),
            epoch_commitment: h(0), timestamp: 0, proposer: "n0".into(), proposer_sig: vec![],
        };
        let child_qc = mk_qc(&committee, child.hash(), 5, 3);
        assert_eq!(commits_parent(&child, &child_qc), Some(4)); // C4 final
        // wrong child_qc index ⇒ no commit
        let bad_qc = mk_qc(&committee, child.hash(), 6, 3);
        assert_eq!(commits_parent(&child, &bad_qc), None);
    }

    #[test]
    fn wire_roundtrip() {
        let committee: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let qc = mk_qc(&committee, h(1), 7, 3);
        let c = Checkpoint {
            index: 7, parent_qc: Some(qc.clone()), window_head_height: 630,
            window_mb_hashes: vec![h(1), h(2)], state_root: h(3), beacon: h(4),
            epoch_commitment: h(0), timestamp: 0, proposer: "n1".into(), proposer_sig: vec![1,2,3],
        };
        let bytes = bincode::serialize(&c).unwrap();
        let back: Checkpoint = bincode::deserialize(&bytes).unwrap();
        assert_eq!(c, back);
        let tc = TimeoutCertificate { index: 7, timeouts: vec![
            TimeoutMsg { index: 7, voter: "n0".into(), high_qc_index: 6, signature: vec![1] },
        ], high_qc: Some(qc) };
        let tb = bincode::serialize(&tc).unwrap();
        assert_eq!(tc, bincode::deserialize::<TimeoutCertificate>(&tb).unwrap());
    }
}
