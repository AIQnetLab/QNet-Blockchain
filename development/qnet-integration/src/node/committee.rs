//! Committee derivation, eligibility snapshots, equivocation evidence and ban sets.

use super::*;

impl BlockchainNode {
    /// Get Genesis candidates with REAL reputation from DeterministicReputationState
    /// 
    /// PRODUCTION v2.32: Eliminates code duplication across:
    /// - select_microblock_producer (Genesis epoch)
    /// - calculate_qualified_candidates (Genesis epoch)
    /// - should_initiate_consensus (Genesis fallback)
    /// 
    /// All locations now use THIS function for consistency!
    pub(super) fn get_genesis_candidates_with_real_reputation(
        _p2p: &Arc<SimplifiedP2P>,
    ) -> Vec<(String, f64)> {
        use crate::genesis_constants::GENESIS_NODE_IPS;
        use qnet_consensus::deterministic_reputation::{INITIAL_REPUTATION, MIN_CONSENSUS_REPUTATION};

        // PRODUCTION: Deterministic conversion from 0-100 scale to 0.0-1.0
        // Uses integer truncation to basis points first, then single f64 division
        // to guarantee identical results across all platforms.
        let to_normalized = |rep_0_100: f64| -> f64 {
            // Truncate to integer basis points: 70.0 → 7000, 85.5 → 8550
            let bps = (rep_0_100 * 100.0) as u64; // 0-10000
            let min_bps = (MIN_CONSENSUS_REPUTATION * 100.0) as u64;
            let clamped_bps = bps.max(min_bps).min(10_000);
            // Convert to 0.0-1.0 via single deterministic division
            clamped_bps as f64 / 10_000.0
        };

        // ONE deterministic model: genesis bootstrap nodes are admitted at the consensus
        // floor (70). No live-engine read — the per-node display engine can diverge across
        // the network and must never gate consensus. (Genesis epoch h≤180 predates any
        // tombstone; for h>180 the authoritative eligible snapshot excludes tombstoned IDs.)
        let initial_norm = to_normalized(INITIAL_REPUTATION);
        GENESIS_NODE_IPS.iter()
            .map(|(_, id)| (format!("genesis_node_{}", id), initial_norm))
            .collect()
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ELIGIBLE PRODUCERS SNAPSHOT (v2.27.0)
    // Epoch-based validator set for deterministic producer selection
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Create eligible producers snapshot for next epoch (90 blocks)
    /// This snapshot is stored in macroblock and used for deterministic producer selection
    /// All nodes will read the SAME snapshot from blockchain - NO gossip race conditions!
    /// 
    /// PRODUCTION: Scales to millions of nodes with MAX_VALIDATORS limit
    /// PRODUCTION v2.34: Create DETERMINISTIC eligible producers snapshot
    /// 
    /// ARCHITECTURE v9.3: Base set = actual BFT committers (who proved sync by signing commit).
    /// Grace window: recently registered Super nodes (last 3 epochs) added for onboarding.
    /// NO P2P registry lookups - all nodes compute IDENTICAL list from on-chain data!
    /// 
    /// Reputation is taken from DeterministicReputationState which is synchronized via blockchain.
    /// Deterministic consensus reputation — a PURE function of the committed chain, identical
    /// on every node (it feeds the eligible-set ≥70 gate + epoch_commitment).
    ///
    /// Under UNIFORM-VRF validator selection the reputation VALUE no longer ranks who is chosen
    /// (sortition is equal-chance among all ≥70 nodes), so consensus reputation reduces to its
    /// two load-bearing roles and nothing more:
    ///   • ADMISSION — every participant starts at the 70 floor (eligible).
    ///   • SLASHING  — a verified on-chain equivocation proof drops the offender to 0 → excluded.
    /// Producer rotation rewards are an ECONOMIC signal (emission) + a live-engine display value;
    /// they are deliberately NOT folded here. Keeping this map at {70 | 0} makes it trivially
    /// divergence-free (no per-node rotation accounting can ever skew epoch_commitment) and
    /// removes the rich-get-richer entrenchment vector at scale.
    ///
    /// Scans the committed window for proofs; bans are permanent so the first verified proof
    /// wins. O(window_head) reads — a persisted/anchored ban-set is the scale follow-up.
    pub(super) async fn compute_consensus_reputation_map(
        storage: &Storage,
        consensus_participants: &[String],
        macroblock_index: u64,
        state_guard: &StateManager,
    ) -> std::collections::HashMap<String, f64> {
        use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        let mut rep: std::collections::HashMap<String, f64> = consensus_participants.iter()
            .map(|id| (id.clone(), INITIAL_REPUTATION)).collect();
        // Verified equivocation offenders (block double-sign OR same-round checkpoint-vote
        // double-sign) → banned (0 → excluded by the ≥70 gate). The cumulative set is anchored
        // on the previous macroblock (O(window), pruning-safe); a forged proof never verifies,
        // so honest nodes are never banned.
        // Bans come from APPLIED STATE, not from re-scanning the window's block bodies.
        // `Account.banned_at_height` is write-once monotone, journaled (the offender is in
        // get_all_affected_addresses) and unconditionally part of the account leaf hash — i.e. it is
        // already inside state_root and therefore already agreed by the QC that certified it. Re-deriving
        // it from bodies was a redundant computation whose ONLY new property was a dependency on which
        // blocks this node still holds; under body pruning (6 epochs) it silently lost every ban in a
        // pruned window.
        let window_head = macroblock_index.saturating_mul(90);
        for id in consensus_participants {
            if banned_at_or_below(state_guard, storage, id, window_head) {
                rep.insert(id.clone(), 0.0);
            }
        }
        rep
    }

    /// Canonicalize stored macroblock bytes to the plaintext bincode preimage.
    /// Fail-CLOSED: a zstd-magic prefix that fails to decompress is a corrupt block —
    /// return None so it fails identically on every node. NEVER pass raw compressed
    /// bytes into parsing (that would diverge per-impl). Absent magic ⇒ stored
    /// uncompressed (see storage save_macroblock), bytes used as-is.
    pub(crate) fn macroblock_plaintext(raw: Vec<u8>) -> Option<Vec<u8>> {
        const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
        if raw.len() >= 4 && raw[0..4] == ZSTD_MAGIC {
            zstd::decode_all(&raw[..]).ok()
        } else {
            Some(raw)
        }
    }

    /// Resolve the relaxed THRESHOLD for a checkpoint carrying a recovery pin, enforcing every clause
    /// of the relaxed-QC validity rule.
    ///
    /// The signing SET is never relaxed: the caller quorum-checks a pinned certificate against the
    /// SAME derived committee a strict certificate for that head would use, so a relaxed and a strict
    /// quorum over one head always intersect (`relaxed_quorum(n) + quorum_size(n) > n`), and two
    /// relaxed quorums intersect too. A pin that selected its own committee left the two free to be
    /// disjoint — a two-content finality fork with zero Byzantine nodes.
    ///
    /// Reads ONLY the anchor macroblock — final, at or below the last seal, retained forever (only
    /// microblock BODIES prune) — and identifies it by `checkpoint_content_digest`, not
    /// `MacroBlock::hash()`, because the block hash omits `consensus_data`: every field read below
    /// would otherwise be un-covered per-node data and two nodes could reach opposite verdicts on one
    /// certificate.
    pub(crate) fn resolve_recovery_pin(
        storage: &Storage,
        index: u64,
        cp: &qnet_consensus::checkpoint_bft::Checkpoint,
        a: u64,
        ah: [u8; 32],
        committee_len: usize,
    ) -> Result<usize, String> {
        use qnet_consensus::checkpoint_bft::{Checkpoint, MACROBLOCK_INTERVAL, QuorumCertificate,
                                             RELAXED_MIN_COMMITTEE, checkpoint_content_digest,
                                             recovery_step_for_head, relaxed_quorum};
        if a == 0 { return Err(format!("v2_rc_anchor_zero mb={}", index)); }
        // Absent anchor is a DEFER, never a rejection: a node that has not yet pulled MB_A must fetch
        // it and retry, exactly like the ordinary N-2 committee anchor. Rejecting would brick a cold
        // join across the span permanently.
        let raw = match storage.get_macroblock_by_height(a).ok().flatten() {
            Some(r) => r,
            None => return Err(format!("v2_rc_defer_anchor mb={} need_anchor={}", index, a)),
        };
        let bytes = Self::macroblock_plaintext(raw)
            .ok_or_else(|| format!("v2_rc_anchor_corrupt mb={}", index))?;
        let mb_a = bincode::deserialize::<qnet_state::MacroBlock>(&bytes)
            .map_err(|_| format!("v2_rc_anchor_decode mb={}", index))?;
        let anchor_qc = mb_a.consensus_data.checkpoint_qc.as_ref()
            .ok_or_else(|| format!("v2_rc_anchor_noqc mb={}", index))?;
        let (cp_a, _qc_a): (Checkpoint, QuorumCertificate) = bincode::deserialize(anchor_qc)
            .map_err(|_| format!("v2_rc_anchor_decode mb={}", index))?;
        // Identity of the anchor, and the ONLY thing read out of its certificate. The content digest
        // covers the anchor's window head and epoch data but NOT its own pin, so it is identical
        // across every certificate that can legally exist for that window — a conformant re-proposal
        // at another round, and a pinned and an unpinned certificate for one window alike. Anything
        // outside it (the anchor's pin, its signer count) differs between those variants, and a
        // validity verdict that read it would be a function of which variant a node happens to
        // store. The no-chained-span bound therefore lives on the arm gate (`rc_try_arm_dry`), where
        // a divergent read costs liveness instead of partitioning the network.
        if checkpoint_content_digest(&cp_a)[..] != ah[..] {
            return Err(format!("v2_rc_anchor_mismatch mb={}", index));
        }
        let anchor_head = a.saturating_mul(MACROBLOCK_INTERVAL);
        if cp_a.window_head_height != anchor_head {
            return Err(format!("v2_rc_anchor_offboundary mb={}", index));
        }
        // Below the floor the relaxation does not exist: at genesis scale it would buy one node of
        // liveness while making a single Byzantine member sufficient to break safety.
        if committee_len < RELAXED_MIN_COMMITTEE {
            return Err(format!("v2_rc_floor mb={} n={}", index, committee_len));
        }
        // Position pin on the WINDOW; the index is deliberately free (a view change advances it
        // without certifying a window). Attribution for the freed index comes from the engine's
        // one-content-per-head rule plus `pinned_double_vote`, not from same-round equivocation.
        if recovery_step_for_head(anchor_head, cp.window_head_height).is_none() {
            return Err(format!("v2_rc_unpinned mb={} head={}", index, cp.window_head_height));
        }
        // Parent link: monotone only. CONTIGUITY would conflict with the f+1 view jump, which stays
        // live during a span and can leave a gap between high_qc.index and the round being driven;
        // requiring `p.index + 1 == cp.index` made every proposal after such a jump unverifiable.
        // A hash link to the anchor's own QC is not checkable either — that hash folds the anchor's
        // index and proposer, which a legal re-proposal changes. The chain link that matters is the
        // macroblock's `previous_hash`, checked by the caller against the stored parent.
        match &cp.parent_qc {
            Some(p) if p.index < cp.index => {}
            _ => return Err(format!("v2_rc_parent mb={}", index)),
        }
        Ok(relaxed_quorum(committee_len))
    }

    /// Loads the cumulative ban-set stored in macroblock `mb_index`'s body
    /// (`consensus_data.banned_validators`). `None` ⇒ macroblock absent OR no anchor field
    /// (pre-feature chain) — the caller then rebuilds via full scan. `Some(set)` ⇒ the
    /// anchor (possibly empty = no bans through that macroblock). Macroblock bytes may be
    /// zstd-compressed on disk.
    pub(super) fn load_macroblock_ban_set(storage: &Storage, mb_index: u64) -> Option<std::collections::HashSet<String>> {
        if mb_index == 0 { return Some(std::collections::HashSet::new()); }
        let raw = storage.get_macroblock_by_height(mb_index).ok().flatten()?;
        let bytes = Self::macroblock_plaintext(raw)?;
        let mb = bincode::deserialize::<qnet_state::MacroBlock>(&bytes).ok()?;
        let ser = mb.consensus_data.banned_validators?;
        bincode::deserialize::<Vec<String>>(&ser).ok().map(|v| v.into_iter().collect())
    }

    /// Cumulative equivocation ban-set as of macroblock `mb_index` — a PURE function of the
    /// committed chain, identical on every node. ANCHORED on the previous macroblock's stored
    /// set so it scans only THIS window's microblocks (O(90)) rather than re-scanning from
    /// genesis: scales to 100k+ nodes and survives microblock pruning (needs only the prev
    /// macroblock body + this window). Full-scan fallback only when the anchor is absent
    /// (genesis window, or a pre-feature chain). Bans are permanent ⇒ the first verified proof
    /// for an offender wins; a forged proof never verifies ⇒ honest nodes are never banned.
    /// Cryptographically verify an equivocation proof carried by a TX. Non-proof TXs pass untouched.
    ///
    /// This became MANDATORY the moment the proof gained an account-state effect (banned_at_height):
    /// both admission paths used to wave these through as "self-verifying" because the apply arm was a
    /// no-op, so a junk proof was harmless. It no longer is — without this any peer could ban any
    /// identity. Verdict is a pure function of the TX bytes plus committed chain state (the offender's
    /// key resolves through `load_vrf_public_key`, else the genesis anchor), so every node agrees.
    pub async fn equivocation_proof_verified(storage: &Storage, tx: &qnet_state::Transaction) -> bool {
        match &tx.tx_type {
            qnet_state::TransactionType::EquivocationProof { offender, height, block_a, block_b } => {
                Self::verify_equivocation_proof(storage, offender, *height, block_a, block_b)
            }
            qnet_state::TransactionType::VoteEquivocationProof {
                offender, checkpoint_a, signature_a, checkpoint_b, signature_b
            } => {
                Self::verify_vote_equivocation_proof(
                    storage, offender, checkpoint_a, signature_a, checkpoint_b, signature_b).await
            }
            _ => true,
        }
    }

    /// The cumulative ban set at `mb_index`, or None when this node cannot derive it EXACTLY.
    ///
    /// FAIL-STOP, not fail-open. The set zeroes reputation in the eligible-producer snapshot, which is
    /// folded into `epoch_commitment` and compared byte-for-byte by every validator — so a set that is
    /// merely "what this node could reconstruct from what it happens to hold" is a divergence, not a
    /// degraded answer. Two inputs can be locally absent:
    ///   - the anchor set at mb_index-1. Rebuilding from height 1 instead is WRONG once body pruning has
    ///     run (retention is 6 epochs), because every ban inside a pruned window silently disappears.
    ///   - any microblock body in the window being scanned.
    /// Either one ⇒ None ⇒ the caller abstains from producing a snapshot and syncs. Abstaining is safe:
    /// the quorum that does hold the data keeps sealing, and an abstaining node still follows the chain.
    pub async fn compute_cumulative_ban_set(storage: &Storage, mb_index: u64) -> Option<std::collections::HashSet<String>> {
        let window_head = mb_index.saturating_mul(90);
        let (mut bans, scan_start) = if mb_index >= 2 {
            match Self::load_macroblock_ban_set(storage, mb_index - 1) {
                Some(anchor) => (anchor, (mb_index - 1) * 90 + 1),
                None => {
                    if is_warn() {
                        println!("[WARN][BAN] anchor_absent mb={} — abstaining until sync", mb_index - 1);
                    }
                    crate::sync_manager::nudge_sync_check();
                    return None;
                }
            }
        } else {
            (std::collections::HashSet::new(), 1u64) // genesis window (mb_index 0/1)
        };
        let mut h = scan_start;
        while h <= window_head {
            let b = match storage.load_microblock_auto_format(h) {
                Ok(Some(b)) => b,
                _ => {
                    if is_warn() {
                        println!("[WARN][BAN] body_absent h={} mb={} — abstaining until sync", h, mb_index);
                    }
                    crate::sync_manager::nudge_sync_check();
                    return None;
                }
            };
            for tx in &b.transactions {
                match &tx.tx_type {
                    qnet_state::TransactionType::EquivocationProof { offender, height, block_a, block_b } => {
                        if !bans.contains(offender)
                            && Self::verify_equivocation_proof(storage, offender, *height, block_a, block_b) {
                            bans.insert(offender.clone());
                        }
                    }
                    qnet_state::TransactionType::VoteEquivocationProof { offender, checkpoint_a, signature_a, checkpoint_b, signature_b } => {
                        if !bans.contains(offender)
                            && Self::verify_vote_equivocation_proof(storage, offender, checkpoint_a, signature_a, checkpoint_b, signature_b).await {
                            bans.insert(offender.clone());
                        }
                    }
                    _ => {}
                }
            }
            h += 1;
        }
        Some(bans)
    }

    /// Re-verify an on-chain checkpoint-vote-equivocation proof. TWO sound shapes, and the offender's
    /// consensus key must have signed BOTH preimages (over the canonical `QNET_BFT2_VOTE:<hex(hash)>`
    /// message):
    ///   SAME ROUND — `same_round_double_vote`: one `index`, different committed CONTENT.
    ///   PINNED HEAD — `pinned_double_vote`: one window head, different committed CONTENT, at least one
    ///   side pinned. A pin frees the index, so this is the only shape that can see the offence.
    /// Carrying the full preimages is what proves either shape (the vote sig covers only the hash).
    /// Verified via the canonical async verifier vs the offender's registry PK; fail-safe (any mismatch
    /// → false → no ban). Identical on every node.
    pub(super) async fn verify_vote_equivocation_proof(
        storage: &Storage,
        offender: &str,
        checkpoint_a: &[u8],
        signature_a: &[u8],
        checkpoint_b: &[u8],
        signature_b: &[u8],
    ) -> bool {
        use qnet_consensus::checkpoint_bft::Checkpoint;
        let ca: Checkpoint = match bincode::deserialize(checkpoint_a) { Ok(c) => c, Err(_) => return false };
        let cb: Checkpoint = match bincode::deserialize(checkpoint_b) { Ok(c) => c, Err(_) => return false };
        // BOTH shapes key on the committed CONTENT digest, never on `hash()`. That is what makes them
        // safe: the protocol-mandated re-proposal of one window at a new index, and the pinned
        // re-proposal of the round a replica already voted at, both carry IDENTICAL content, so
        // neither can be convicted; an unpinned/unpinned pair at one head (a rollback legally
        // re-voting an uncertified window) is excluded too. The proof TX is unsigned and
        // anyone-submittable and the ban folds into epoch_commitment, so a verifier must never punish
        // what the voter is instructed to do.
        if !qnet_consensus::checkpoint_bft::same_round_double_vote(&ca, &cb)
            && !qnet_consensus::checkpoint_bft::pinned_double_vote(&ca, &cb) {
            return false;
        }
        let ha = ca.hash();
        let hb = cb.hash();
        if ha == hb { return false; } // same checkpoint — not equivocation
        let msg_a = format!("QNET_BFT2_VOTE:{}", hex::encode(ha));
        let msg_b = format!("QNET_BFT2_VOTE:{}", hex::encode(hb));
        let sa = match std::str::from_utf8(signature_a) { Ok(s) => s, Err(_) => return false };
        let sb = match std::str::from_utf8(signature_b) { Ok(s) => s, Err(_) => return false };
        // Pin the PK explicitly, exactly as the QC verifier does. The generic entry point resolves the
        // key through the RAM registry, which is idle-evicted and can TOFU a first-seen key — two nodes
        // would then derive different ban sets, and the set is folded into epoch_commitment, so the
        // macroblock would fail to certify. Unknown key ⇒ no ban (fail-safe, mirrors the block path).
        let pk_bytes = match Self::equivocation_offender_pk(storage, offender) {
            Some(p) => p,
            None => return false,
        };
        qnet_consensus::consensus_crypto::verify_consensus_signature_bound(offender, &msg_a, sa, &pk_bytes).await
            && qnet_consensus::consensus_crypto::verify_consensus_signature_bound(offender, &msg_b, sb, &pk_bytes).await
    }

    /// Offender consensus PK from COMMITTED chain state (never the RAM registry, which is
    /// idle-evicted and per-process ⇒ a fork source: this verdict feeds banned_validators, which is
    /// folded into epoch_commitment and rejected on mismatch).
    pub(super) fn equivocation_offender_pk(storage: &Storage, offender: &str) -> Option<Vec<u8>> {
        // The standalone vrf_pk_ row is NOT pruned when a branch is reorged out and is also writable
        // off-chain, so on its own it is a local artefact. Cross-check it against the commitment in the
        // canonical node_ registry row (reg_height-bounded, covered by registry_root, pruned on reorg):
        // only a key the chain committed can produce a ban, and the ban is folded into epoch_commitment.
        // Genesis identities fall back to the pinned anchor, which is stronger than any row.
        if let Ok(Some(p)) = storage.load_vrf_public_key(offender) {
            if let Ok(Some(tag)) = storage.node_signer_key_commitment(offender) {
                if hex::encode(Sha3_256::digest(&p)) == tag {
                    return Some(p);
                }
            }
        }
        crate::genesis_constants::get_genesis_anchor_pk(offender)
    }

    /// Re-verify an on-chain equivocation proof: both headers carry the offender's
    /// ML-DSA-65 signature over the `Block_Sig_v23.1` digest of their fields. Returns
    /// true iff both verify for the SAME (offender, height) and the headers differ —
    /// unforgeable proof of double-signing. Deterministic (registry PK + Dilithium),
    /// identical on every node; fail-safe (anything off → false → no ban).
    pub(super) fn verify_equivocation_proof(
        storage: &Storage,
        offender: &str,
        height: u64,
        block_a: &qnet_state::EquivocationHeader,
        block_b: &qnet_state::EquivocationHeader,
    ) -> bool {
        // Compare BLOCK IDENTITY, never the whole struct. `EquivocationHeader` derives PartialEq and
        // carries `signature`, so a struct compare called two copies of ONE genuine block "different"
        // whenever their signature bytes differed — which happens with no attacker at all, because
        // ML-DSA signing is randomised and an honest producer re-emits after a rollback. It was also
        // forgeable outright: hex::decode accepts either case, so re-casing the hex of a single public
        // signature yielded two "different" headers that both verify. Either way anyone could mint a
        // valid proof against any producer from one public block, and the ban is permanent committed
        // state — at n=5 two of them halt finality for good. This mirrors the vote-equivocation
        // sibling, which has always compared checkpoint hashes.
        if equivocation_identity_hash(height, offender, block_a)
            == equivocation_identity_hash(height, offender, block_b) { return false; }
        let pk_bytes = match Self::equivocation_offender_pk(storage, offender) {
            Some(p) => p,
            None => return false,
        };
        Self::verify_block_header_sig(offender, height, block_a, &pk_bytes)
            && Self::verify_block_header_sig(offender, height, block_b, &pk_bytes)
    }

    /// Verify one equivocation header's signature against `pk_bytes`. Reconstructs the
    /// EXACT `Block_Sig_v23.1` signing digest from `sign_microblock_with_dilithium`.
    pub(super) fn verify_block_header_sig(
        producer: &str,
        height: u64,
        hdr: &qnet_state::EquivocationHeader,
        pk_bytes: &[u8],
    ) -> bool {
        let mut hasher = Sha3_256::new();
        hasher.update(b"Block_Sig_v23.1");
        hasher.update(&height.to_be_bytes());
        hasher.update(&hdr.timestamp.to_be_bytes());
        hasher.update(&hdr.merkle_root);
        hasher.update(&hdr.previous_hash);
        hasher.update(&hdr.state_root);
        hasher.update(producer.as_bytes());
        if let Some(ref vrf) = hdr.vrf_output { hasher.update(vrf); }
        hasher.update(&hdr.timeout_round.to_be_bytes());
        // v23.2: bind carried_baseline (matches sign_microblock_with_dilithium).
        hasher.update(&hdr.carried_baseline.to_be_bytes());
        // Blocker-3: bind pk_digest (captured from the block's txs at header extraction) so this
        // equivocation-proof re-verify reconstructs the SAME signed digest as the producer.
        hasher.update(&hdr.pk_digest);
        let digest = hasher.finalize();
        // Wire format: "dilithium3_v4:" + hex(detached_sig).
        let sig_str = match std::str::from_utf8(&hdr.signature) { Ok(s) => s, Err(_) => return false };
        let sig_hex = match sig_str.strip_prefix("dilithium3_v4:") { Some(x) => x, None => return false };
        let sig_bytes = match hex::decode(sig_hex) { Ok(b) => b, Err(_) => return false };
        use pqcrypto_mldsa::mldsa65 as dilithium3;
        use pqcrypto_traits::sign::{PublicKey as PkTrait, DetachedSignature as SigTrait};
        let pk = match <dilithium3::PublicKey as PkTrait>::from_bytes(pk_bytes) { Ok(p) => p, Err(_) => return false };
        let sig = match <dilithium3::DetachedSignature as SigTrait>::from_bytes(&sig_bytes) { Ok(s) => s, Err(_) => return false };
        dilithium3::verify_detached_signature(&sig, digest.as_ref(), &pk).is_ok()
    }

    pub(super) async fn create_eligible_producers_snapshot(
        _p2p: &Arc<SimplifiedP2P>,
        consensus_participants: &[String],
        _own_node_id: &str,
        _own_node_type: NodeType,
        macroblock_index: u64,
        storage: &Storage,
        state_guard: &StateManager,
    ) -> Vec<qnet_state::EligibleProducer> {
        const MIN_REPUTATION_BP: u32 = 7000; // 70.00% eligibility floor (fixed-point centipercent)

        // Consensus reputation = pure function of the committed chain (identical on every node),
        // NOT the per-node-divergent live engine. Forensic: the live engine self-credits the
        // microblock rotation reward only on the producer and never replays it elsewhere → each
        // node's map differs → eligible/epoch_commitment diverge → checkpoint never reaches n−f.
        let reputation_map = Self::compute_consensus_reputation_map(
            storage, consensus_participants, macroblock_index, state_guard,
        ).await;

        // ── INACTIVITY SHRINK ──────────────────────────────────────────────────────────────────────
        // Carrying every previous member forward unconditionally is what let a stalled quorum stay
        // stalled forever: quorum(n) = n - (n-1)/3 is taken over the eligible set, so a set that never
        // loses its dead members has a threshold that never becomes reachable again. This is the same
        // failure an inactivity-leak design answers — keep producing, and shrink the denominator
        // until the honest online remainder clears the bar.
        //
        // Liveness here is the node's ON-CHAIN heartbeat, not connectivity: the set is a function of
        // committed blocks up to scan_end, so a partition does NOT give the two sides different sets —
        // they read the same committed heartbeats and shrink identically. That is what makes shrinking
        // safe to do without any record of who signed a QC (which can never enter a hash preimage).
        //
        // Requires A1: without production continuing past a stalled finality, no new heartbeat could
        // ever land, so the set could never shrink and recovery was impossible by construction.
        let live_scan_end = macroblock_index.saturating_mul(90);
        let live_now = match recent_heartbeat_senders(storage, live_scan_end) {
            Some(x) => x,
            // Index unusable ⇒ abstain rather than shrink on a partial liveness view.
            None => return Vec::new(),
        };
        let mut eligible: Vec<qnet_state::EligibleProducer> = consensus_participants.iter()
            .filter(|node_id| {
                // Restart bar, checked before the genesis carve-out so a compromised genesis identity
                // can also be retired.
                if crate::genesis_constants::restart_excludes(node_id) { return false; }
                // Genesis stays: it is the bootstrap floor and the set must never collapse below it.
                node_id.starts_with("genesis_node_") || live_now.contains(*node_id)
            })
            .map(|node_id| {
                // reputation_map is 0–100; commit as centipercent u32 (×100, rounded) so the
                // macroblock body is bit-identical across nodes — no f64 in the consensus hash.
                let rep = reputation_map.get(node_id).copied()
                    .unwrap_or(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION);
                qnet_state::EligibleProducer {
                    node_id: node_id.clone(),
                    reputation: (rep.clamp(0.0, 100.0) * 100.0).round() as u32,
                }
            })
            .filter(|p| p.reputation >= MIN_REPUTATION_BP)
            .collect();
        if is_info() {
            let dropped = consensus_participants.len().saturating_sub(eligible.len());
            if dropped > 0 {
                println!("[INFO][SNAP] inactivity_shrink mb={} carried={} dropped={} reason=no_recent_heartbeat",
                         macroblock_index, eligible.len(), dropped);
            }
        }

        // O(1) membership index kept in lockstep with `eligible` so the L1/L2
        // "already present?" checks are O(1), not O(eligible) per candidate — the
        // snapshot runs every macroblock and at 100k registered supers the old
        // `eligible.iter().any()` made admission O(R×E). Insert on every push.
        let mut eligible_ids: std::collections::HashSet<String> =
            eligible.iter().map(|p| p.node_id.clone()).collect();

        // Break the closed consensus loop. eligible_producers =
        // consensus_participants ONLY was self-referential (participants came
        // from the prev macroblock's eligible from that round's participants)
        // → new nodes could never enter even after on-chain registration. Fix:
        // scan the chain for confirmed Super NodeRegistration TXs (rep ≥
        // MIN_REPUTATION; deterministic — same chain on all nodes). Two-level
        // re-entry: L1 recent-registration scan (grace for NEW nodes), L2
        // carry-over for nodes in any of the last 3 macroblocks' eligible
        // sets (RETURNING nodes). Without L2 a genesis node offline >3 epochs
        // is locked out (block-0 registration is outside the scan window).
        {
            // ── LEVEL 1: Recent NodeReactivation TX scan (SYNC-PROOF REQUIRED) ──
            //
            // v10.0 CRITICAL FIX: NodeRegistration alone does NOT grant eligibility.
            // A node MUST prove it is synced via NodeReactivation TX, which contains
            // `current_height` — the node's chain height at reactivation time.
            // v31.13+v31.14: HBC-only eligibility. Scan window = full epoch so a
            // returning node's next HBC is always in range. Phase 1 builds the
            // registered-super-node set; Phase 2A is the single eligibility path.
            let scan_end = macroblock_index * 90;

            // Phase 1: registered Super node IDs (necessary, not sufficient). Sourced from the
            // deterministic, snapshot-carried srtr_ registry index — NOT a recent-block body scan.
            // A body scan only saw registrations inside the last epoch, so a node whose NodeRegistration
            // is older than that window (every genesis node: block 0; any super away beyond the L2
            // carryover) could never re-enter the producer/committee set after a snapshot cold-join —
            // it synced but stayed ineligible. The registry index holds EVERY chain-confirmed super
            // regardless of registration age (the same source the reward roster uses), so a returning
            // node re-enters through the Phase-2A heartbeat gate below WITHOUT re-registration. Phase-2A
            // (recent on-chain Heartbeat) absorbs any registration-timing edge: a just-applied
            // registration not yet heartbeated is filtered out, so eligible-set membership stays stable.
            // Bounded to scan_end AT THE SOURCE. This set feeds eligible_producers -> epoch_commitment
            // -> the QC, so it must be a function of the height, not of how far this node happens to have
            // applied. The unbounded twin (super_registrations_sorted) let the live pool run ahead of
            // scan_end; the downstream reg-height filter then had to undo it.
            let registered_super_nodes: std::collections::HashSet<String> =
                match storage.super_registrations_as_of(scan_end) {
                    Ok(regs) => regs.into_iter().map(|(node_id, _w)| node_id).collect(),
                    // Empty is this snapshot's ABSTAIN sentinel: it yields an empty eligible set, which
                    // the WindowEnd guard turns into a defer. Never give this arm a fallback roster —
                    // that would publish a set nobody else derives, straight into epoch_commitment.
                    Err(_) => std::collections::HashSet::new(),
                };

            // v35: Phase-2A admits a registered Super node on UNFORGEABLE on-chain liveness —
            // a Heartbeat-TX in the current or previous subwindow (Account.heartbeat_slots),
            // proving it is synced to ~now — replacing the removed HBC sample proof. Sorted
            // iteration keeps the eligible set deterministic; the reputation floor still applies.
            {
                let hb_epoch = scan_end / 14400;
                let cur_sub = ((scan_end % 14400) / 1440) as u16;
                // Deterministic recent-Heartbeat set from committed block bodies bounded to end_height
                // (NOT the async-lagging accounts CF, whose per-node persist lag gave a divergent eligible
                // set → epoch_commitment split → finality stall). Computed once; identical on every member.
                // Same committed-heartbeat set the carry-over filter used (scan_end == live_scan_end).
                let recent_hb = &live_now;
                let additions = phase2a_eligible_additions(
                    state_guard, storage, &registered_super_nodes, recent_hb, &eligible_ids,
                    &reputation_map, scan_end, MIN_REPUTATION_BP,
                );
                let added_tally = additions.len();
                for p in additions {
                    eligible_ids.insert(p.node_id.clone());
                    eligible.push(p);
                }
                if added_tally > 0 {
                    println!("[INFO][SNAP] L1_TALLY added={} epoch={} subwin={} total={}",
                             added_tally, hb_epoch, cur_sub, eligible.len());
                }
            }

            // LEVEL 2 (carry-over gated on on-chain commits) was DELETED, not disabled: it read
            // `mb.consensus_data.commits`, which has no writer anywhere — v2 seals the macroblock with
            // `..Default::default()` and the only producer lived in the removed commit/reveal path. So
            // `live_committers` was always empty and the gate rejected every candidate it examined.
            // Nothing is lost (the unconditional carry-forward above dominates), but its comment
            // claimed a dead node "auto-expires after the window", which was never true and misread
            // three separate analyses.
        }

        // Genesis floor: the 5 canonical genesis producers stay permanently eligible, so a fork or
        // quiet epoch that collapses the committed roster to one committer cannot degenerate the
        // leader candidate set to len==1 (the mb-boundary production pin). Additive + deterministic.
        {
            const GENESIS_FLOOR_REP_BP: u32 = 10000; // 100.00% centipercent, ≥ MIN_REPUTATION_BP
            for i in 1..=5u32 {
                let gid = format!("genesis_node_{:03}", i);
                // Never resurrect a slashed genesis. The reputation map is keyed on THIS window's
                // participants, and a banned genesis leaves that set one window after the ban — from then
                // on the map has no entry for it and a map-only guard reads "not banned", re-admitting a
                // proven equivocator at max reputation every other window. Read the ban itself.
                if banned_at_or_below(state_guard, storage, &gid, macroblock_index.saturating_mul(90)) { continue; }
                if reputation_map.get(&gid).map_or(false, |r| *r == 0.0) { continue; }
                // The floor is ADDITIVE, so it re-admits regardless of what the two arms above
                // filtered — and a restart bar sets neither `banned_at_height` nor reputation 0.
                // Without this the one mechanism for retiring a compromised GENESIS key is a silent
                // no-op, i.e. the set with the most authority is the only one a restart cannot clean.
                if crate::genesis_constants::restart_excludes(&gid) { continue; }
                if eligible_ids.insert(gid.clone()) {
                    eligible.push(qnet_state::EligibleProducer { node_id: gid, reputation: GENESIS_FLOOR_REP_BP });
                }
            }
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // v14.1: DEFENSIVE DEDUP — prevent duplicate node_ids in eligible set
        // ═══════════════════════════════════════════════════════════════════════════
        // Upstream checks in Level 1 (line 2471) and Level 2 (line 2536) should
        // already prevent duplicates, but defence-in-depth is cheap and critical:
        // a single duplicate silently inflates BFT quorum and breaks liveness.
        //
        // We dedupe by node_id AFTER sort, keeping the FIRST occurrence (highest
        // reputation after initial sort or L1/L2 addition order). Same complexity
        // as the subsequent VRF sort — O(n log n) total.
        //
        // Determinism preserved: same input → same deduped output on every node.
        // ═══════════════════════════════════════════════════════════════════════════
        {
            let pre_dedup = eligible.len();
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::with_capacity(pre_dedup);
            eligible.retain(|p| !p.node_id.is_empty() && seen.insert(p.node_id.clone()));
            let removed = pre_dedup - eligible.len();
            if removed > 0 {
                println!("[WARN][SNAP] dedup mb={} removed={} pre={} post={} — duplicates detected (should never happen)",
                         macroblock_index, removed, pre_dedup, eligible.len());
            }
        }

        eligible.sort_by(|a, b| a.node_id.cmp(&b.node_id));

        // v3.37: VRF-based fair selection when exceeding MAX_VALIDATORS
        // Reputation-first ordering preserved; equal-reputation tiebreaker uses
        // deterministic VRF hash instead of alphabetical node_id — ensures every
        // node with the same reputation has an equal chance each epoch.
        // Precompute hashes O(n) — same pattern as select_consensus_committee.
        if eligible.len() > MAX_VALIDATORS {

            // v15.0: Strict N-2 seed. If this node is missing mb=(N-2) locally
            // it is BEHIND the chain — it must abstain from truncating the
            // candidate set here rather than improvise a different seed.
            // Skipping the truncation keeps the full candidate list; the
            // actual producer decision downstream relies on the seed set
            // inside the v2 macroblock path (consensus_v2_node),
            // which applies the same N-2 requirement and triggers a sync
            // when the seed is unavailable. All honest nodes with the same
            // on-chain view reach the same truncation result.
            let vrf_seed_opt = Self::try_load_macroblock_beacon(storage, macroblock_index);
            let vrf_seed: [u8; 32] = match vrf_seed_opt {
                Some(seed) => seed,
                None => {
                    if crate::node::is_warn() {
                        println!(
                            "[WARN][SNAP] vrf_seed_unavailable mb={} — skipping MAX_VALIDATORS truncation, node needs sync",
                            macroblock_index,
                        );
                    }
                    // ABSTAIN. Returning the UNTRUNCATED list would make the snapshot a function of
                    // local RocksDB holdings: nodes that hold the seed emit 1000 producers, nodes that
                    // do not emit all ~100k, and both land in epoch_commitment. "Every similarly-behind
                    // node produces the same list" is not the bar — every node must produce the same
                    // list. No seed, no snapshot.
                    crate::sync_manager::nudge_sync_check();
                    return Vec::new();
                }
            };

            let vrf_scores: std::collections::HashMap<String, [u8; 32]> = eligible.iter()
                .map(|p| {
                    let mut h = Sha3_256::new();
                    h.update(b"EPOCH_VALIDATOR_VRF_v3.37");
                    h.update(&vrf_seed);
                    h.update(&macroblock_index.to_le_bytes());
                    h.update(p.node_id.as_bytes());
                    (p.node_id.clone(), h.finalize().into())
                })
                .collect();

            // SCALE FAIRNESS: select the validator set by UNIFORM VRF sortition among all
            // eligible (≥70) nodes — NOT by accumulated-reputation rank. Ranking by reputation
            // ENTRENCHES the set: producers climb above the 70 floor and then permanently hold
            // every MAX_VALIDATORS slot, locking out all other nodes forever (fatal at 100k+
            // nodes where the eligible pool ≫ MAX_VALIDATORS — 99% become permanent spectators
            // and the active set freezes on whoever bootstrapped first). Uniform sortition
            // re-rolls each epoch from the on-chain N-2 beacon, so every eligible node rotates
            // in fairly. Reputation has already done its job at the ≥70 admission gate
            // (slashed/jailed are excluded below the floor); Sybil resistance is the node-
            // activation cost. Mirrors select_consensus_committee (same beacon-seeded VRF, one
            // tier up). node_id is a total-order tiebreak for the (cryptographically
            // unreachable) SHA3-collision case.
            // O(N) partial-select (quickselect) instead of a full O(N log N) sort of the whole
            // pool — the committee-selection ceiling at 100k+ eligible. Yields the identical set
            // (the MAX_VALIDATORS lowest VRF scores; node_id total-order tiebreak), then sort only
            // the selected for deterministic order. Reached only when len > MAX_VALIDATORS.
            // Index panics on a missing key, and `panic = "abort"` makes that remote process
            // death on a consensus path. A missing score sorts last, deterministically.
            let score_of = |id: &String| vrf_scores.get(id).copied().unwrap_or([0xffu8; 32]);
            eligible.select_nth_unstable_by(MAX_VALIDATORS, |a, b| {
                score_of(&a.node_id).cmp(&score_of(&b.node_id))
                    .then_with(|| a.node_id.cmp(&b.node_id))
            });
            eligible.truncate(MAX_VALIDATORS);
            eligible.sort_by(|a, b| a.node_id.cmp(&b.node_id));

            println!("[INFO][SNAP] vrf_selection mb={} total={} selected={} seed={}",
                macroblock_index, consensus_participants.len(), eligible.len(),
                hex::encode(&vrf_seed[..8]));
        }
        
        if is_debug() { println!("[DBG][SNAP] consensus_participants={} (NOT heartbeat eligible!)", eligible.len()); }
        eligible
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v3.36: COMMITTEE-BASED BFT — VRF-subsampled committee for scalable consensus
    // When validators > COMMITTEE_THRESHOLD, select a random committee of COMMITTEE_SIZE
    // using deterministic VRF derived from randomness_beacon of MacroBlock N-2.
    // All nodes compute IDENTICAL committee from same blockchain data.
    // ═══════════════════════════════════════════════════════════════════════════
    // v34: single source of truth in qnet_consensus — the failover voting set (unified_p2p)
    // derives the SAME committee via the same const + sample_committee, so the two layers agree.
    pub(super) const CONSENSUS_COMMITTEE_SIZE: usize = qnet_consensus::checkpoint_bft::COMMITTEE_SIZE;
    pub(super) const COMMITTEE_THRESHOLD: usize = qnet_consensus::checkpoint_bft::COMMITTEE_THRESHOLD;

    /// v15.0: Strict N-2 beacon loader.
    ///
    /// Returns the canonical randomness_beacon from macroblock (index - 2),
    /// or `None` if that macroblock is not in local storage OR its beacon
    /// field is empty. Genesis epoch (index < 2) is the only case where
    /// this function synthesises a zero seed — that rule is universal and
    /// applied identically by every honest node.
    ///
    /// Why there is NO N-3 escape fallback:
    ///   * Consensus participants must agree on ONE seed per macroblock
    ///     boundary. If some nodes used N-2 and others N-3 for the same
    ///     boundary they would compute different committees, different
    ///     VRF scores, different leaders — silent per-node divergence.
    ///   * A missing N-2 locally signals "this node is behind the chain",
    ///     NOT "the network skipped that macroblock". With Fix #5 unified
    ///     finalize fallback, mb=(M-2) is ALWAYS created on-chain (via
    ///     deterministic fallback leader when commit-reveal fails). So
    ///     if local storage lacks mb=(M-2), the node has a sync gap and
    ///     must catch up — not improvise its own seed.
    ///   * Callers must treat `None` as "not ready for macroblock M":
    ///     trigger sync, abstain from voting/producing, wait for the
    ///     missing macroblock to arrive. This is the standard participation
    ///     guard that every BFT SMR system applies to missing on-chain
    ///     state.
    ///
    /// Scalability: O(1) storage lookup + O(block size) deserialisation,
    /// independent of committee size.
    pub(super) fn try_load_macroblock_beacon(storage: &Storage, macroblock_index: u64) -> Option<[u8; 32]> {
        // v15.0.1: Bootstrap edge — first three macroblocks use a universal
        // zero seed because their N-2 target lies before any on-chain
        // macroblock exists:
        //   * mb_idx=0 / mb_idx=1  →  genesis epoch, no prior macroblock at all.
        //   * mb_idx=2             →  N-2 = mb_idx=0, which is never created
        //                             (no macroblock at genesis h=0).
        // From mb_idx=3 onward, N-2 = mb_idx=1 exists on-chain (finalised
        // at h=90) and the strict-N-2 guard kicks in for real. Every honest
        // node applies the same rule deterministically, so the zero-seed
        // bootstrap window is fork-safe.
        //
        // Previous behaviour: old code used `macroblock_index >= 2` outside
        // this helper AND silently fell back to `[0u8; 32]` on storage
        // None. Replacing that with a strict None-returns-Err guard broke
        // bootstrap at mb_idx=2 because mb_idx=0 is unreachable — every
        // node aborted the h=180 macroblock, mb=2 never entered the chain,
        // and mb=4 at h=360 could never find its N-2 snapshot. Extending
        // the zero-seed window to `< 3` preserves the strict guard for
        // real-world behind-chain cases while keeping bootstrap alive.
        if macroblock_index < 3 {
            return Some([0u8; 32]);
        }
        let n_minus_2 = macroblock_index - 2;
        // DERIVED from window N-2's microblocks, not read out of macroblock N-2. Same value by
        // construction (the sealer folds exactly these block hashes), but it exists as soon as the window's
        // blocks do — so the seed no longer disappears when finality stops. Absent body ⇒ abstain.
        if let Some(b) = crate::node::derive_window_beacon(storage, n_minus_2) {
            return Some(b);
        }
        // Fall back to the SEALED value. Identical by construction (the sealer folds exactly these
        // block hashes), and a snapshot cold-joiner holds macroblocks at/above its anchor while holding no
        // bodies below it — without this it would abstain for a full window after every cold join.
        if let Ok(Some(data)) = storage.get_macroblock_by_height(n_minus_2) {
            if let Ok(mb) = bincode::deserialize::<qnet_state::MacroBlock>(&data) {
                if let Some(b) = mb.consensus_data.randomness_beacon {
                    return Some(b);
                }
            }
        }
        if crate::node::is_warn() {
            println!("[WARN][VRF] seed_underivable n2={} — no bodies and no seal, abstaining", n_minus_2);
        }
        None
    }

    pub(super) fn select_consensus_committee(
        all_candidates: &[String],
        macroblock_index: u64,
        storage: &Storage,
    ) -> Vec<String> {
        if all_candidates.len() <= Self::COMMITTEE_THRESHOLD {
            return all_candidates.to_vec();
        }

        // Strict N-2 seed. A node lacking mb=(N-2) is behind and MUST NOT improvise a seed (divergent
        // committee → fork). ABSTAIN: return empty so the caller's is_committee_member gate is false and
        // the node skips participation cleanly (matching committee_for_height None / qualified Vec::new()).
        // Returning the full uncapped list would make it self-select onto a >cap committee no peer computes.
        let seed: [u8; 32] = match Self::try_load_macroblock_beacon(storage, macroblock_index) {
            Some(s) => s,
            None => {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][COMMITTEE] seed_unavailable mb={} action=abstain node_behind_chain",
                        macroblock_index,
                    );
                }
                return Vec::new();
            }
        };


        // v34: delegate the VRF subsample to the SINGLE canonical fn that the microblock-failover
        // voting set (unified_p2p::deterministic_eligible_ids) also calls — both derive a
        // byte-identical committee from the same (sorted candidates, window, seed) ⇒ the two
        // consensus layers can never disagree on membership (a divergent copy would fork).
        let committee = qnet_consensus::checkpoint_bft::sample_committee(
            all_candidates,
            macroblock_index,
            &seed,
            Self::COMMITTEE_THRESHOLD,
            Self::CONSENSUS_COMMITTEE_SIZE,
        );

        println!("[INFO][COMMITTEE] mb={} total={} committee={} seed={}",
            macroblock_index, all_candidates.len(), committee.len(),
            hex::encode(&seed[..8]));

        committee
    }

    /// Deterministic consensus committee for the EPOCH of block height `h`, from the finalized
    /// N-2 macroblock snapshot — a pure function of on-chain state, so every validator computes the
    /// same set for the same `h` (required: a NodeRegistration is re-validated on every node).
    /// window = epoch, seed = N-2 beacon, candidates = N-2 eligible_producers (sorted). THE single
    /// resolver: `unified_p2p::deterministic_eligible_ids` now delegates here rather than answering
    /// the same question with its own staleness policy. Keyed on `h`, not the local tip, and with NO
    /// walk-back (reject, don't guess, if N-2 is absent locally). `None` = genesis era (no N-2 yet); the caller falls back to the genesis
    /// committee (the only nodes that exist then). NOT a crutch: post-genesis this IS the live
    /// committee; at genesis the committee simply IS the 5 genesis.
    pub(crate) fn committee_for_height(storage: &Storage, h: u64) -> Option<Vec<String>> {
        let epoch = (h.saturating_sub(1)) / 90 + 1;
        let n2 = epoch.saturating_sub(2);
        if n2 == 0 { return None; } // genesis era: epochs 1-2 have no N-2 snapshot
        // THE single committee resolver, STRICTLY at N-2. Absent => None, never a guess: a walk-back
        // returns whichever macroblock the node happens to hold, and the VRF seed comes from THAT
        // macroblock, so a different stop index is a different committee. It also deletes the defer
        // valve, since `n2_committee_absent` IS this returning None — turning "every node stalls" into
        // "honest nodes disagree on block validity". Cost: no failover committee past the seal
        // frontier, so rotation waits for finality. A stall is recoverable; a split is not.
        Self::committee_from_macroblock(storage, n2, epoch)
    }

    /// Sample the committee for `epoch` out of macroblock `idx`'s sealed snapshot, or None if that
    /// macroblock is absent or carries no usable snapshot.
    ///
    /// Committee AND beacon must come from the SAME macroblock, or leader selection and committee
    /// membership are computed against different randomness and the two consensus layers disagree.
    pub(super) fn committee_from_macroblock(storage: &Storage, idx: u64, epoch: u64) -> Option<Vec<String>> {
        let raw = storage.get_macroblock_by_height(idx).ok()??;
        let bytes = Self::macroblock_plaintext(raw)?;
        let mb = bincode::deserialize::<qnet_state::MacroBlock>(&bytes).ok()?;
        // Seed = this macroblock's OWN beacon. NOT try_load_macroblock_beacon(idx) — that subtracts 2
        // AGAIN, giving epoch-4 randomness and a different VRF subset than the real committee.
        let seed = mb.consensus_data.randomness_beacon?;
        let snap = mb.consensus_data.eligible_producers.as_ref()?;
        let eligible = bincode::deserialize::<Vec<qnet_state::EligibleProducer>>(snap).ok()?;
        // restart_excludes filtered HERE (restart GAP B): the barred set is bound into the eligible
        // FIELD only at the builder, but a restart resumes at K+1 whose committee samples the PRE-restart
        // K-1/K macroblocks (WS-pin-frozen, freeloader-laden). Filtering the DERIVED voting set — not the
        // stored field — excludes them from the tail windows while the WS-pin digest still verifies.
        let mut ids: Vec<String> = eligible.into_iter()
            .map(|p| p.node_id)
            .filter(|s| !s.is_empty() && !crate::genesis_constants::restart_excludes(s))
            .collect();
        if ids.is_empty() { return None; }
        ids.sort(); // byte-stable input to the VRF sample
        Some(qnet_consensus::checkpoint_bft::sample_committee(
            &ids, epoch, &seed, Self::COMMITTEE_THRESHOLD, Self::CONSENSUS_COMMITTEE_SIZE,
        ))
    }

    
    // NOTE: get_eligible_producers_for_height() was REMOVED in v2.46
    // Use calculate_qualified_candidates() instead - it's the SINGLE SOURCE OF TRUTH
    // and properly handles Genesis fallback + background sync for missing MacroBlocks
    
}
