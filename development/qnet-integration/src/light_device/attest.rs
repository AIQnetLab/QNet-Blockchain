//! The attestor side of a device statement (A3) and the collector (A4).
//!
//! Every attestor - the ingress genesis for itself and each of the other four on the internal route -
//! re-verifies the whole request before it signs: the wallet's delegation to the ping key the enrolment
//! names (so a genesis cannot bind someone else's node to a device), the device evidence over the
//! enrolment preimage it rebuilds itself, the oracle's lease under the pinned key, and the proposed
//! statement against both. Then it checks its own records: one device key serves one node, one remotely
//! provisioned attestation key one live node, a paused node stays paused, and at one binding sequence of a
//! node it signs for one device only (its vote). Four signatures make a statement final; two statements for
//! different devices at one node and sequence, or for one device and two nodes, would need eight signatures
//! from five attestors, three of which refuse the second (a split race yields at most one statement).

use serde::{Deserialize, Serialize};

use super::evidence::{self, DeviceBlock, Evidence, VerifiedDevice, Verifier};
use super::messages::{self, LeaseStatement, StatementFields};
use super::record::{DeviceRecord, KeyEntry, Vote};
use super::statement::{self, GenesisSet, LeaseProof, OraclePins};
use super::{DeviceReason, DeviceRefusal, DeviceState, Op, Platform, StepRefusal, Trust, CHALLENGE_TTL_SECS,
            CLOCK_SKEW_SECS, LEASE_MAX_AGE_SECS, STATEMENT_QUORUM};
use crate::light_binding::{self as lb, Refusal};

/// What the ingress asks every attestor to sign (the committee RPC `node_attestDevice`, genesis callers
/// only). Carries public evidence and the wallet's signed delegation; never a vendor token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttestRequest {
    pub ingress: String,
    pub requested_at: u64,
    /// The proposed statement preimage.
    pub statement: String,
    pub wallet: String,
    /// hex of the wallet key K.
    pub identity_pubkey: String,
    /// hex of the ping key the binding names.
    pub ping_pubkey: String,
    /// hex: K over `{chain_tag}delegate_ping:v2:{pp}:{N}:{seq}`.
    pub delegation_sig: String,
    pub seq: u64,
    /// The app's device block as it came (the stamp is the ingress's alone; attestors do not read it).
    pub device: serde_json::Value,
    /// hex of the device key (for a key the records already hold it must be theirs).
    pub hw_pub: String,
    #[serde(default)]
    pub lease: Option<LeaseProof>,
    /// The Play verdict the oracle decoded, for attestors holding the app's verification key.
    #[serde(default)]
    pub pi_jws: Option<String>,
    /// For a key the records already hold: the node whose record holds it at the ingress, which an
    /// attestor missing that record pulls from the ingress first.
    #[serde(default)]
    pub key_node: Option<String>,
    /// A rotation (section 5.4): `device` is the new key's block, `hw_pub` the new key, and this the key it
    /// retires with that key's signature over the same preimage.
    #[serde(default)]
    pub rotate: Option<RotateProof>,
}

/// The retiring key of a rotation and its signature over the rotation preimage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RotateProof {
    /// hex(sha3(old hw_pub)): the key the node's record holds.
    pub old_key: String,
    /// b64url of the old key's device signature.
    pub old_sig: String,
}

/// What an attestor reads besides the request.
pub struct Env<'a> {
    pub storage: &'a crate::storage::Storage,
    pub verifier: &'a Verifier,
    pub genesis: &'a GenesisSet,
    pub pins: &'a OraclePins,
    pub now: u64,
    pub epoch: u64,
    pub mainnet: bool,
}

/// A request that passed every check that reads no vote.
#[derive(Debug, Clone)]
pub struct Checked {
    pub fields: StatementFields,
    pub device: VerifiedDevice,
    pub block: DeviceBlock,
    pub lease: Option<LeaseStatement>,
    pub rebind_from: Option<String>,
    /// The enrolment or rebind preimage the device signed.
    pub preimage: String,
    /// The binding sequence the preimage carries.
    pub seq: u64,
}

fn refuse(r: DeviceReason) -> StepRefusal {
    StepRefusal::device(r)
}

fn bad(what: &'static str) -> StepRefusal {
    if crate::node::is_debug() {
        println!("[DBG][DEVICE] attest_request_refused reason={}", what);
    }
    StepRefusal::Binding(Refusal::BadRequest)
}

fn is_hex_len(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The wallet's authorization: node = pseudonym of the wallet, wallet = EON of the key, the key = the
/// registration's commitment where the chain has one here, and the key's delegation to the ping key at the
/// binding sequence.
pub fn check_wallet(storage: &crate::storage::Storage, node: &str, wallet: &str, identity: &str, ping_pk: &str,
                    delegation_sig: &str, seq: u64) -> Result<(), StepRefusal> {
    if !is_hex_len(identity, lb::MLDSA65_PK_HEX) || !is_hex_len(ping_pk, lb::MLDSA65_PK_HEX)
        || !is_hex_len(delegation_sig, lb::MLDSA65_SIG_HEX) {
        return Err(StepRefusal::Binding(Refusal::BadSignature));
    }
    if crate::rpc::generate_light_node_pseudonym(wallet) != node
        || crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(identity).as_deref() != Some(wallet) {
        return Err(StepRefusal::Binding(Refusal::IdentityMismatch));
    }
    if storage.is_node_registration_onchain(node) {
        let committed = storage.resolve_light_identity_pk(node, Some(identity)).map_or(false, |k| k.eq_ignore_ascii_case(identity));
        if !committed { return Err(StepRefusal::Binding(Refusal::IdentityMismatch)); }
    }
    if !crate::rpc::verify_mobile_dilithium_signature(&lb::delegation_v2_message(ping_pk, node, seq), delegation_sig, identity) {
        return Err(StepRefusal::Binding(Refusal::BadSignature));
    }
    Ok(())
}

/// The device a request names: a new key's evidence over the enrolment preimage, a known key's assertion,
/// or the device key of the node a rebind leaves. Returns the device and the preimage it signed.
pub fn check_device(env: &Env<'_>, node: &str, wallet: &str, identity: &str, ping_pk: &str, seq: u64, block: &DeviceBlock)
    -> Result<(VerifiedDevice, String, Option<String>), StepRefusal>
{
    let pp_sha3 = lb::sha3_hex(&hex::decode(ping_pk).map_err(|_| StepRefusal::Binding(Refusal::BadSignature))?);
    let known = |hw_pub_hex: &str, prefer: Option<&DeviceRecord>| -> Result<(Vec<u8>, Option<DeviceRecord>), StepRefusal> {
        let hw_pub = hex::decode(hw_pub_hex).ok().filter(|k| k.len() == 65).ok_or_else(|| refuse(DeviceReason::NotGenuine))?;
        let hw_key = hex::encode(messages::sha3_256(&hw_pub));
        // The record that last held the key carries its provenance and its last counter.
        let rec = prefer.cloned().filter(|r| r.hw_key == hw_key).or_else(|| {
            env.storage.device_key_entry(&hw_key).and_then(|e| env.storage.device_record(&e.node_id)).filter(|r| r.hw_key == hw_key)
        });
        Ok((hw_pub, rec))
    };
    let from_record = |platform: Platform, hw_pub: Vec<u8>, rec: Option<DeviceRecord>, counter: u32| -> Result<VerifiedDevice, StepRefusal> {
        let rec = rec.ok_or_else(|| refuse(DeviceReason::NotGenuine))?;
        if rec.platform != platform { return Err(refuse(DeviceReason::NotGenuine)); }
        Ok(VerifiedDevice {
            platform, hw_pub: hw_pub.try_into().map_err(|_| refuse(DeviceReason::NotGenuine))?, prov: rec.prov, trust: rec.trust,
            att_key: rec.att_key.clone(), certs_issued: rec.certs_issued, serials: rec.serials.clone(), receipt: None,
            counter, fresh: false,
        })
    };
    match &block.evidence {
        Evidence::IosAttestation { .. } | Evidence::Android { .. } => {
            let e = messages::enrol_preimage(node, wallet, &pp_sha3, seq, &block.nonce, &block.preimage_flags());
            let dev = env.verifier.verify_new_key(block, &e, env.now).map_err(|r| {
                if crate::node::is_info() {
                    println!("[INFO][DEVICE] evidence_refused node={} platform={} reason={} code={}", node,
                             block.platform.as_str(), r.reason.as_str(), r.code);
                }
                refuse(r.reason)
            })?;
            if dev.platform != block.platform { return Err(refuse(DeviceReason::NotGenuine)); }
            Ok((dev, e, None))
        }
        Evidence::IosAssertion { key_id, assertion } => {
            let e = messages::enrol_preimage(node, wallet, &pp_sha3, seq, &block.nonce, &block.preimage_flags());
            // A key the attestors hold: its point and provenance come from the records, never from the request,
            // also after the record of the node it served ended (a Stop, then another wallet in the install).
            let k = env.storage.device_known_key(&hex::encode(key_id)).filter(|k| k.platform == Platform::Ios)
                .ok_or_else(|| refuse(DeviceReason::NotGenuine))?;
            let (hw_pub, rec) = known(&k.hw_pub, None)?;
            let rec = rec.or_else(|| env.storage.device_record(&k.node_id).filter(|r| r.hw_pub == k.hw_pub));
            let last = rec.as_ref().map_or(0, |r| super::store::last_counter(env.storage, r));
            let counter = env.verifier.verify_known_key(Platform::Ios, &hw_pub, assertion, &e, last)
                .map_err(|r| refuse(r.reason))?;
            Ok((VerifiedDevice {
                platform: Platform::Ios, hw_pub: hw_pub.try_into().map_err(|_| refuse(DeviceReason::NotGenuine))?, prov: k.prov,
                trust: k.trust, att_key: None, certs_issued: None, serials: Vec::new(), receipt: None, counter, fresh: false,
            }, e, None))
        }
        Evidence::Rebind { from, sig, wallet_sig } => {
            let r = messages::rebind_preimage(from, node, seq, &block.nonce);
            let old = env.storage.device_record(from).filter(|o| o.live()).ok_or_else(|| refuse(DeviceReason::NotGenuine))?;
            if old.platform != block.platform { return Err(refuse(DeviceReason::NotGenuine)); }
            // A pause holds the device it paused: it does not move to another wallet's node meanwhile.
            if old.paused_at(env.epoch) { return Err(StepRefusal::Device(old.pause_refusal())); }
            let (hw_pub, rec) = known(&old.hw_pub, Some(&old))?;
            let counter = env.verifier.verify_known_key(old.platform, &hw_pub, sig, &r, super::store::last_counter(env.storage, &old))
                .map_err(|x| refuse(x.reason))?;
            if !crate::rpc::verify_mobile_dilithium_signature(&r, wallet_sig, identity) {
                return Err(StepRefusal::Binding(Refusal::BadSignature));
            }
            Ok((from_record(old.platform, hw_pub, rec, counter)?, r, Some(from.clone())))
        }
    }
}

/// The oracle's lease: signed under a pinned key, for this node and device, fresh; and on Android, where
/// the app's Play verification key is pinned, the verdict inside it checked here too.
pub fn check_lease(env: &Env<'_>, p: &LeaseProof, tag: &[u8; 32], node: &str, device: &VerifiedDevice,
                   block: &DeviceBlock, preimage: &str, pi_jws: Option<&str>, op: Op) -> Result<LeaseStatement, StepRefusal> {
    let sig = hex::decode(&p.oracle_sig).map_err(|_| bad("oracle_sig"))?;
    if !env.pins.verify(&p.statement, &sig, env.epoch) { return Err(bad("oracle_sig")); }
    let l = LeaseStatement::parse(&p.statement).ok_or_else(|| bad("lease"))?;
    if l.node != node || &l.device_tag != tag { return Err(bad("lease_names_another_device")); }
    if l.issued_at > env.now + CLOCK_SKEW_SECS || env.now.saturating_sub(l.issued_at) > LEASE_MAX_AGE_SECS + CLOCK_SKEW_SECS {
        return Err(refuse(DeviceReason::Stale));
    }
    if device.platform == Platform::Android && !l.pi_digest.is_empty() {
        if let Some(key) = statement::play_verification_key() {
            let jws = pi_jws.ok_or_else(|| refuse(DeviceReason::NotGenuine))?;
            // An enrolment's nonce binds the new key and its report; a rotation's and a rebind's the preimage.
            let nonce = match &block.evidence {
                Evidence::Android { report, .. } if op == Op::Enrol => messages::play_nonce_enrol_digest(preimage, &device.hw_pub, report),
                _ => messages::play_nonce_digest(preimage),
            };
            let v = qnet_device_attest::play::verify_verdict(jws, &key, &nonce, &env.verifier.policies.play, env.now * 1000)
                .map_err(|r| refuse(DeviceReason::from_evidence(r.reason())))?;
            if hex::encode(v.payload_digest) != l.pi_digest || Trust::from(v.trust) != device.trust {
                return Err(refuse(DeviceReason::AppUnrecognized));
            }
        }
    }
    Ok(l)
}

/// A rotation's checks on this attestor's own record (section 5.4): the node's record at the binding's
/// sequence holds the key the rotation retires, no pause runs, and that key signed the rotation preimage
/// (the iOS counter above the last one taken). Returns the preimage and the record. An attestor whose record
/// is not the one the rotation rests on (`rotation_rests_on`) pulls the ingress's first (`attest_answer`).
pub fn check_rotation(env: &Env<'_>, node: &str, seq: u64, ping_pk_sha3: &str, proof: &RotateProof, nonce: &str)
    -> Result<(String, DeviceRecord), StepRefusal>
{
    let rec = env.storage.device_record(node).filter(|r| !r.provisional && r.live())
        .ok_or_else(|| refuse(DeviceReason::NotGenuine))?;
    if rec.hw_key != proof.old_key || rec.seq != seq { return Err(StepRefusal::Binding(Refusal::StaleSeq)); }
    // A rotated key counts at once because the key it retires did; a statement that carried no lease never
    // counted, and its key never met the oracle's claim. It waits for an enrolment with the token.
    if rec.lease.is_none() { return Err(refuse(DeviceReason::Stale)); }
    // A pause holds the key it paused: a revoked chain re-enrols (its new chain meets the list), it does not
    // rotate away from the pause.
    if rec.paused_at(env.epoch) { return Err(StepRefusal::Device(rec.pause_refusal())); }
    let preimage = messages::rotate_preimage(node, &proof.old_key, ping_pk_sha3, seq, nonce);
    let old_sig = messages::b64url_decode(&proof.old_sig).filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or(StepRefusal::Binding(Refusal::BadSignature))?;
    let hw_pub = rec.hw_pub_bytes().ok_or_else(|| refuse(DeviceReason::NotGenuine))?;
    env.verifier.verify_known_key(rec.platform, &hw_pub, &old_sig, &preimage, super::store::last_counter(env.storage, &rec))
        .map_err(|e| if e.reason == DeviceReason::Stale { refuse(DeviceReason::Stale) } else { StepRefusal::Binding(Refusal::BadSignature) })?;
    Ok((preimage, rec))
}

/// `r` is the record a rotation retiring `old_key` at the binding sequence `seq` rests on, as `check_rotation`
/// reads it: final, live, at that sequence, holding that key, with a lease. An attestor whose record differs
/// (it missed a statement: a re-link at the next sequence after a Stop, an enrolment with the vendor token
/// after one without it, a previous rotation) pulls the ingress's before it answers (`attest_answer`).
pub fn rotation_rests_on(r: &DeviceRecord, old_key: &str, seq: u64) -> bool {
    !r.provisional && r.live() && r.seq == seq && r.hw_key == old_key && r.lease.is_some()
}

/// Every check of a rotation request that reads no vote: the wallet's delegation to the ping key the
/// preimage names, the old key's signature on this attestor's record, the new key's evidence over the same
/// preimage, the oracle's lease (a rotation always carries one), and the proposed statement against them.
fn verify_rotation(env: &Env<'_>, req: &AttestRequest, proof: &RotateProof) -> Result<Checked, StepRefusal> {
    let f = StatementFields::parse(&req.statement).ok_or_else(|| bad("statement"))?;
    if req.seq == 0 || req.seq > env.now.saturating_add(lb::COPY_FUTURE_SEQ_SLACK_SECS) { return Err(bad("seq")); }
    check_wallet(env.storage, &f.node, &req.wallet, &req.identity_pubkey, &req.ping_pubkey, &req.delegation_sig, req.seq)?;
    let block = evidence::parse_rotation_block(&req.device).map_err(refuse)?;
    let pp_sha3 = lb::sha3_hex(&hex::decode(&req.ping_pubkey).map_err(|_| StepRefusal::Binding(Refusal::BadSignature))?);
    let (preimage, rec) = check_rotation(env, &f.node, req.seq, &pp_sha3, proof, &block.nonce)?;
    let device = env.verifier.verify_new_key(&block, &preimage, env.now).map_err(|r| refuse(r.reason))?;
    if device.platform != rec.platform || device.platform != block.platform || hex::encode(device.hw_pub) != req.hw_pub {
        return Err(refuse(DeviceReason::NotGenuine));
    }
    if device.hw_key() == rec.hw_key { return Err(bad("same_key")); }
    if env.mainnet && device.trust == Trust::Test { return Err(refuse(DeviceReason::AppUnrecognized)); }
    let tag = device.device_tag();
    if f.hw_key != device.hw_key() || f.device_tag != tag || f.platform != device.platform || f.prov != device.prov
        || f.trust != device.trust || f.op != Op::Rotate {
        return Err(bad("statement_names_another_device"));
    }
    let p = req.lease.as_ref().ok_or_else(|| bad("rotation_without_lease"))?;
    let lease = check_lease(env, p, &tag, &f.node, &device, &block, &preimage, req.pi_jws.as_deref(), Op::Rotate)?;
    let sig = hex::decode(&p.oracle_sig).map_err(|_| bad("oracle_sig"))?;
    if messages::lease_hash(&p.statement, &sig) != f.lease_hash { return Err(bad("lease_hash")); }
    if !statement::state_admissible(f.state, Some(&lease), Op::Rotate) { return Err(bad("state")); }
    if f.issued_epoch + 1 < env.epoch || f.issued_epoch > env.epoch + 1 { return Err(refuse(DeviceReason::Stale)); }
    if f.effective_epoch != statement::effective_epoch(Some(&lease), Op::Rotate, f.issued_epoch) { return Err(bad("effective_epoch")); }
    Ok(Checked { fields: f, device, block, lease: Some(lease), rebind_from: None, preimage, seq: req.seq })
}

/// Every check of a request that reads no vote.
pub fn verify_request(env: &Env<'_>, req: &AttestRequest) -> Result<Checked, StepRefusal> {
    if req.requested_at > env.now + CLOCK_SKEW_SECS || env.now.saturating_sub(req.requested_at) > CHALLENGE_TTL_SECS + CLOCK_SKEW_SECS {
        return Err(refuse(DeviceReason::Stale));
    }
    if let Some(proof) = &req.rotate {
        return verify_rotation(env, req, proof);
    }
    let f = StatementFields::parse(&req.statement).ok_or_else(|| bad("statement"))?;
    if req.seq == 0 || req.seq > env.now.saturating_add(lb::COPY_FUTURE_SEQ_SLACK_SECS) { return Err(bad("seq")); }
    check_wallet(env.storage, &f.node, &req.wallet, &req.identity_pubkey, &req.ping_pubkey, &req.delegation_sig, req.seq)?;
    let block = evidence::parse_block(&req.device).map_err(refuse)?;
    let (device, preimage, rebind_from) = check_device(env, &f.node, &req.wallet, &req.identity_pubkey, &req.ping_pubkey,
                                                       req.seq, &block)?;
    if env.mainnet && device.trust == Trust::Test { return Err(refuse(DeviceReason::AppUnrecognized)); }
    if !device.fresh && hex::encode(device.hw_pub) != req.hw_pub { return Err(refuse(DeviceReason::NotGenuine)); }
    let op = if rebind_from.is_some() { Op::Rebind } else { Op::Enrol };
    let tag = device.device_tag();
    if f.hw_key != device.hw_key() || f.device_tag != tag || f.platform != device.platform || f.prov != device.prov
        || f.trust != device.trust || f.op != op {
        return Err(bad("statement_names_another_device"));
    }
    let lease = match &req.lease {
        Some(p) => {
            let l = check_lease(env, p, &tag, &f.node, &device, &block, &preimage, req.pi_jws.as_deref(), op)?;
            let sig = hex::decode(&p.oracle_sig).map_err(|_| bad("oracle_sig"))?;
            if messages::lease_hash(&p.statement, &sig) != f.lease_hash { return Err(bad("lease_hash")); }
            Some(l)
        }
        None => {
            if f.lease_hash != messages::no_lease_hash() { return Err(bad("lease_hash")); }
            None
        }
    };
    if !statement::state_admissible(f.state, lease.as_ref(), op) { return Err(bad("state")); }
    if f.issued_epoch + 1 < env.epoch || f.issued_epoch > env.epoch + 1 { return Err(refuse(DeviceReason::Stale)); }
    if f.effective_epoch != statement::effective_epoch(lease.as_ref(), op, f.issued_epoch) { return Err(bad("effective_epoch")); }
    Ok(Checked { fields: f, device, block, lease, rebind_from, preimage, seq: req.seq })
}

/// The refusal a key's final entry and reservation give a device for `node`: none when the key is free, is
/// this node's, or is the key a rebind moves away from its old node (whose own pause `check_device`
/// reads). A pause holds the device it paused (the rebind's rule, on every path): while the node whose
/// record holds the key is paused - also after its record ended or its binding was released by a Stop or a
/// later binding - the key moves to no other node, and the answer is that pause.
fn key_refusal(env: &Env<'_>, entries: [Option<KeyEntry>; 2], node: &str, rebind_from: Option<&str>) -> Option<StepRefusal> {
    for e in entries.into_iter().flatten() {
        if e.node_id == node || Some(e.node_id.as_str()) == rebind_from { continue; }
        let holder = env.storage.device_record(&e.node_id).filter(|r| !r.provisional);
        if let Some(r) = holder.as_ref().filter(|r| r.paused_at(env.epoch) || r.pause_until(env.epoch) > 0) {
            return Some(StepRefusal::Device(r.pause_refusal()));
        }
        let live = !e.final_ || holder.map_or(false, |r| {
            r.state_at(env.storage.is_node_registration_onchain(&r.node_id), env.epoch, env.now) != DeviceState::Ended
                && !binding_released(env.storage, &r)
        });
        if e.holds(live, env.now) { return Some(refuse(DeviceReason::KeyInUse)); }
    }
    None
}

/// The device of `r` no longer holds its node's binding: its own ping key withdrew it ("Stop on this
/// device") or a later binding replaced it. Its key then serves nothing, and the same install may link
/// another wallet's node with it (owner decision (b)). No binding row here at all is not a release.
pub fn binding_released(storage: &crate::storage::Storage, r: &DeviceRecord) -> bool {
    binding_released_by(storage.light_binding_reach(&r.node_id).as_ref(), r)
}

/// `binding_released` against a binding row already read (`Storage::light_binding_reach`).
pub fn binding_released_by(binding: Option<&crate::light_binding::BindingReach>, r: &DeviceRecord) -> bool {
    binding.map_or(false, |b| !(b.v2 && b.device_bound() && b.seq == r.seq))
}

/// The checks on this attestor's own records: key and attestation-key ownership, a running pause, a newer
/// statement, and its vote at this node and sequence. A rotation keeps the binding's sequence, so the vote
/// the statement it rotates from left there does not hold it back: that statement is final here already.
/// Reads only.
pub fn admit(env: &Env<'_>, node: &str, seq: u64, device: &VerifiedDevice, rebind_from: Option<&str>, op: Op) -> Result<(), StepRefusal> {
    let hw_key = device.hw_key();
    // A chain the revocation list names: a new key's is refused by the verifier already; a key the records
    // hold (a rebind) carries its stored chain's serials, so a revoked device cannot move to another node.
    if !device.fresh && evidence::revoked_any(&device.serials) { return Err(refuse(DeviceReason::NotGenuine)); }
    let key = [env.storage.device_key_entry(&hw_key), env.storage.device_key_reservation(&hw_key)];
    if let Some(r) = key_refusal(env, key, node, rebind_from) { return Err(r); }
    if let Some(att) = &device.att_key {
        let att_entries = [env.storage.device_attkey_entry(att), env.storage.device_attkey_reservation(att)];
        if let Some(r) = key_refusal(env, att_entries, node, rebind_from) { return Err(r); }
    }
    let cur = env.storage.device_record(node).filter(|r| !r.provisional);
    if let Some(cur) = &cur {
        // A timed pause runs to its epoch, also when its record ended meanwhile (a Stop does not end a
        // pause). A revocation holds only the chain it names: a new enrolment's chain meets the list.
        if cur.pause_until(env.epoch) > 0 {
            return Err(StepRefusal::Device(DeviceRefusal {
                paused_until: Some(cur.until_epoch), reference: cur.reference(), ..DeviceRefusal::new(DeviceReason::SlotPaused)
            }));
        }
        if cur.seq > seq && cur.live() { return Err(StepRefusal::Binding(Refusal::StaleSeq)); }
    }
    if let Some(v) = env.storage.device_vote(node, seq) {
        let rotated_from = op == Op::Rotate && cur.as_ref().map_or(false, |c| c.stmt_hash == v.stmt_hash);
        if v.blocks(&hw_key, env.now) && !rotated_from { return Err(StepRefusal::Binding(Refusal::StaleSeq)); }
    }
    Ok(())
}

/// Admit and record the vote and the key reservations, atomically with respect to every other device write
/// here. After this the attestor signs.
pub fn reserve(env: &Env<'_>, c: &Checked) -> Result<(), StepRefusal> {
    let _g = super::device_write_lock();
    admit(env, &c.fields.node, c.seq, &c.device, c.rebind_from.as_deref(), c.fields.op)?;
    let hw_key = c.device.hw_key();
    let mut w = crate::storage::DeviceWrite::default();
    w.votes.push((c.fields.node.clone(), c.seq, Vote { hw_key: hw_key.clone(), stmt_hash: c.fields.hash(), at: env.now }));
    // The reservation sits beside the key's final entry and never replaces it: a rebind's old node keeps its
    // entry until the new statement is final.
    let reservation = KeyEntry { node_id: c.fields.node.clone(), seq: c.seq, final_: false, at: env.now };
    w.key_reservations.push((hw_key, Some(reservation.clone())));
    if let Some(att) = &c.device.att_key {
        w.attkey_reservations.push((att.clone(), Some(reservation)));
    }
    env.storage.device_write(w).map_err(|_| bad("storage"))
}

/// An attestor's answer on the wire.
pub fn signed_answer(genesis_id: &str, raw_sig_hex: &str) -> serde_json::Value {
    serde_json::json!({ "success": true, "genesis_id": genesis_id, "sig": raw_sig_hex })
}

/// What a collection gathered.
#[derive(Debug, Clone, Default)]
pub struct Collected {
    /// (genesis id, raw signature hex), distinct and verified.
    pub sigs: Vec<(String, String)>,
    /// (genesis id, stated reason) of attestors that refused.
    pub refusals: Vec<(String, String)>,
}

impl Collected {
    pub fn is_final(&self) -> bool {
        self.sigs.len() >= STATEMENT_QUORUM
    }

    /// Quorum is out of reach once more attestors refused than the set can spare.
    pub fn impossible(&self, members: usize) -> bool {
        members.saturating_sub(self.refusals.len()) < STATEMENT_QUORUM
    }

    /// The reason most attestors refused with.
    pub fn refusal(&self) -> Option<StepRefusal> {
        let mut counts: Vec<(&str, usize)> = Vec::new();
        for (_, r) in &self.refusals {
            match counts.iter_mut().find(|(x, _)| x == r) { Some(e) => e.1 += 1, None => counts.push((r.as_str(), 1)) }
        }
        let (top, _) = counts.into_iter().max_by_key(|(_, n)| *n)?;
        Some(match DeviceReason::parse(top) {
            Some(d) => refuse(d),
            None if top == Refusal::StaleSeq.as_str() => StepRefusal::Binding(Refusal::StaleSeq),
            None if top == Refusal::IdentityMismatch.as_str() => StepRefusal::Binding(Refusal::IdentityMismatch),
            None if top == Refusal::BadSignature.as_str() => StepRefusal::Binding(Refusal::BadSignature),
            None => refuse(DeviceReason::Stale),
        })
    }
}

/// Gather signatures over `statement`: this node's own (`own_id`, already reserved and signed), then every
/// other member through `ask`, concurrently, until four verify under the pinned keys or the budget runs
/// out. A member's answer counts only for the member it was asked; this node is never asked over the wire.
pub async fn collect<F, Fut>(statement: &str, genesis: &GenesisSet, own_id: &str, own_sig: Option<String>, ask: F,
                             budget: std::time::Duration) -> Collected
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Option<serde_json::Value>>,
{
    use futures::stream::StreamExt;
    let mut out = Collected::default();
    if let Some(sig) = own_sig {
        if genesis.count_valid(statement, &[(own_id.to_string(), sig.clone())]) == 1 { out.sigs.push((own_id.to_string(), sig)); }
    }
    let others: Vec<String> = genesis.members.iter().map(|(id, _)| id.clone()).filter(|id| id != own_id).collect();
    let mut calls = futures::stream::FuturesUnordered::new();
    for id in others {
        let fut = ask(id.clone());
        calls.push(async move { (id, fut.await) });
    }
    let deadline = tokio::time::Instant::now() + budget;
    while !out.is_final() && !out.impossible(genesis.members.len()) {
        let next = match tokio::time::timeout_at(deadline, calls.next()).await {
            Ok(Some(x)) => x,
            Ok(None) | Err(_) => break,
        };
        let (member, answer) = next;
        let Some(a) = answer else { continue; };
        if a.get("success").and_then(|s| s.as_bool()) == Some(true) {
            let (gid, sig) = (a["genesis_id"].as_str().unwrap_or(""), a["sig"].as_str().unwrap_or(""));
            if gid == member && out.sigs.iter().all(|(m, _)| m != gid)
                && genesis.count_valid(statement, &[(gid.to_string(), sig.to_string())]) == 1 {
                out.sigs.push((gid.to_string(), sig.to_string()));
            }
        } else if let Some(r) = a.get("reason").and_then(|r| r.as_str()) {
            out.refusals.push((member, r.chars().take(40).collect()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_refusal_most_attestors_gave_is_the_answer() {
        let mut c = Collected::default();
        c.refusals = vec![("a".into(), "device_key_in_use".into()), ("b".into(), "device_key_in_use".into()),
                          ("c".into(), "stale_seq".into())];
        assert_eq!(c.refusal(), Some(refuse(DeviceReason::KeyInUse)));
        assert!(c.impossible(5), "three refusals of five leave no quorum of four");
        c.refusals.truncate(1);
        assert!(!c.impossible(5));
        c.refusals = vec![("a".into(), "stale_seq".into())];
        assert_eq!(c.refusal(), Some(StepRefusal::Binding(Refusal::StaleSeq)));
    }
}
