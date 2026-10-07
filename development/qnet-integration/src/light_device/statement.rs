//! Device statements (A3, A4, A6): what four of the five genesis sign, the proof bundle the genesis nodes
//! send each other, the signed state change, and the keys every check rests on - the genesis consensus
//! keys and the device oracle's ML-DSA-65 key, both pinned in the binary.

use serde::{Deserialize, Serialize};

use super::messages::{self, LeaseStatement, StatementFields};
use super::record::{DeviceRecord, LeaseSummary, StateChange};
use super::{DeviceState, Effective, LeaseKind, Op, Trust, ROTATION_PERIOD_EPOCHS, STATEMENT_QUORUM};

const MLDSA65_SIG: usize = 3309;
const MLDSA65_PK: usize = 1952;

/// The device oracle's public keys, pinned (`qnet-device-oracle pubkey`). The current key has
/// `retired_at_epoch = u64::MAX`; after a rotation the previous one stays, with the epoch it was retired
/// at, and signs for `ORACLE_PREVIOUS_KEY_EPOCHS` more. Empty until the owner generates the oracle key
/// (`scripts/deploy-oracle.sh keys`): with no pin no lease verifies, and every enrolment waits in
/// `check_pending`, never counted.
pub const ORACLE_KEYS: &[(&str, u64)] = &[];

/// The Play Integrity verification key of the app (Play Console, developer-managed keys), hex of the
/// uncompressed P-256 point. With it the attestors check the verdict inside a lease themselves; empty until
/// the owner places the key.
pub const PLAY_VERIFICATION_KEYS: &[&str] = &[];

/// Verify a raw ML-DSA-65 signature (exactly 3309 bytes, empty context) over `msg`.
pub fn verify_raw(pk: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    use pqcrypto_mldsa::mldsa65 as d3;
    use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};
    if sig.len() != MLDSA65_SIG || pk.len() != MLDSA65_PK { return false; }
    let (Ok(pk), Ok(sig)) = (d3::PublicKey::from_bytes(pk), d3::DetachedSignature::from_bytes(sig)) else { return false; };
    d3::verify_detached_signature(&sig, msg, &pk).is_ok()
}

/// The raw signature inside a consensus signature envelope (`dilithium_sig_{id}_{base64}`: the signed
/// message, then the signer's key), when the envelope names `signer`, embeds `pk` and signs exactly `msg`.
/// Statements keep the 3309 raw bytes, not the ~7 KB envelope.
pub fn raw_from_envelope(signer: &str, envelope: &str, msg: &str, pk: &[u8]) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let part = envelope.strip_prefix("dilithium_sig_")?;
    let sep = part.rfind('_')?;
    if &part[..sep] != signer { return None; }
    let bytes = base64::engine::general_purpose::STANDARD.decode(&part[sep + 1..]).ok()?;
    if bytes.len() < 8 { return None; }
    let signed_len = u32::from_le_bytes(bytes[0..4].try_into().ok()?) as usize;
    if signed_len != MLDSA65_SIG + msg.len() || 4 + signed_len + 4 > bytes.len() { return None; }
    let signed = &bytes[4..4 + signed_len];
    let pk_len = u32::from_le_bytes(bytes[4 + signed_len..8 + signed_len].try_into().ok()?) as usize;
    let embedded = &bytes[8 + signed_len..];
    if pk_len != MLDSA65_PK || embedded.len() != pk_len || embedded != pk { return None; }
    let (sig, body) = signed.split_at(MLDSA65_SIG);
    (body == msg.as_bytes() && verify_raw(pk, msg.as_bytes(), sig)).then(|| sig.to_vec())
}

/// The genesis nodes whose signatures count, with their pinned consensus keys.
#[derive(Debug, Clone)]
pub struct GenesisSet {
    pub members: Vec<(String, Vec<u8>)>,
}

impl GenesisSet {
    /// The five genesis keys of the binary (`GENESIS_CONSENSUS_PKS`).
    pub fn production() -> &'static GenesisSet {
        static G: std::sync::OnceLock<GenesisSet> = std::sync::OnceLock::new();
        G.get_or_init(|| GenesisSet {
            members: crate::genesis_constants::GENESIS_CONSENSUS_PKS.iter()
                .filter_map(|(id, pk)| hex::decode(pk).ok().filter(|b| b.len() == MLDSA65_PK).map(|b| (id.to_string(), b)))
                .collect(),
        })
    }

    pub fn key(&self, id: &str) -> Option<&[u8]> {
        self.members.iter().find(|(m, _)| m == id).map(|(_, k)| k.as_slice())
    }

    pub fn contains(&self, id: &str) -> bool {
        self.key(id).is_some()
    }

    /// Distinct members whose raw signature over `msg` verifies.
    pub fn count_valid(&self, msg: &str, sigs: &[(String, String)]) -> usize {
        let mut seen: Vec<&str> = Vec::new();
        for (id, sig) in sigs {
            if seen.contains(&id.as_str()) { continue; }
            let (Some(pk), Ok(raw)) = (self.key(id), hex::decode(sig)) else { continue; };
            if verify_raw(pk, msg.as_bytes(), &raw) { seen.push(id); }
        }
        seen.len()
    }
}

/// The oracle's pinned keys: (public key, epoch the key was retired or `u64::MAX`).
#[derive(Debug, Clone, Default)]
pub struct OraclePins {
    pub keys: Vec<(Vec<u8>, u64)>,
}

impl OraclePins {
    pub fn production() -> &'static OraclePins {
        static P: std::sync::OnceLock<OraclePins> = std::sync::OnceLock::new();
        P.get_or_init(|| OraclePins {
            keys: ORACLE_KEYS.iter()
                .filter_map(|(pk, retired)| hex::decode(pk).ok().filter(|b| b.len() == MLDSA65_PK).map(|b| (b, *retired)))
                .collect(),
        })
    }

    /// The lease statement's signature verifies under a key current at `epoch`.
    pub fn verify(&self, lease: &str, sig: &[u8], epoch: u64) -> bool {
        self.keys.iter().any(|(pk, retired)| {
            let usable = *retired == u64::MAX || epoch <= retired.saturating_add(super::ORACLE_PREVIOUS_KEY_EPOCHS);
            usable && verify_raw(pk, lease.as_bytes(), sig)
        })
    }
}

/// The app's pinned Play Integrity verification key, if the owner placed one.
pub fn play_verification_key() -> Option<qnet_device_attest::DevicePublicKey> {
    PLAY_VERIFICATION_KEYS.iter().find_map(|k| hex::decode(k).ok().and_then(|b| qnet_device_attest::DevicePublicKey::from_sec1(&b).ok()))
}

/// The state a statement records, from its lease (R5): no lease or no slot read, or a multiplicity gate
/// over its bound, waits in `check_pending`; otherwise the current epoch (`now`) counts at once and every
/// other case, a rebind among them, from the next epoch. A node the chain has not registered yet waits in
/// `awaiting_registration`, which each genesis reads forward when the registration applies.
pub fn derive_state(lease: Option<&LeaseStatement>, op: Op, registered: bool) -> DeviceState {
    let Some(l) = lease else { return DeviceState::CheckPending; };
    if l.gate.is_high() { return DeviceState::CheckPending; }
    if op == Op::Rotate { return rotated_state(registered); }
    if l.lease == LeaseKind::None { return DeviceState::CheckPending; }
    if !registered { return DeviceState::AwaitingRegistration; }
    if l.effective == Effective::Now && op != Op::Rebind { DeviceState::Active } else { DeviceState::PendingNextEpoch }
}

/// A rotation keeps the device counting: the old key, which the record holds, signed the move to the new
/// one in the same install, so the slot read decides nothing here (a foreign read is the oracle's strike,
/// a missing one its outage). Only a multiplicity gate over its bound holds the new key back.
fn rotated_state(registered: bool) -> DeviceState {
    if registered { DeviceState::Active } else { DeviceState::AwaitingRegistration }
}

/// The epoch from which a statement's device counts. A rotation's device counted before it and goes on.
pub fn effective_epoch(lease: Option<&LeaseStatement>, op: Op, issued_epoch: u64) -> u64 {
    match lease {
        Some(_) if op == Op::Rotate => issued_epoch,
        Some(l) if l.effective == Effective::Now && op != Op::Rebind && l.lease != LeaseKind::None => issued_epoch,
        _ => issued_epoch + 1,
    }
}

/// The states an attestor signs for a proposed statement: the derived one whether or not the chain has
/// registered the node yet (the attestors' views of the chain may differ by a block), and `suspect` where
/// `active` is derived (the oracle carries strikes over; both count).
pub fn state_admissible(proposed: DeviceState, lease: Option<&LeaseStatement>, op: Op) -> bool {
    let registered = derive_state(lease, op, true);
    let unregistered = derive_state(lease, op, false);
    proposed == registered || proposed == unregistered
        || (registered == DeviceState::Active && proposed == DeviceState::Suspect)
}

/// The lease that goes with a statement: the oracle's statement and raw signature, and the lease window
/// the oracle answered with (not signed; the ingress's word, trusted as one genesis).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseProof {
    pub statement: String,
    /// hex of the raw ML-DSA-65 signature.
    pub oracle_sig: String,
    #[serde(default)]
    pub lease_valid_until: u64,
    #[serde(default)]
    pub refresh_at: u64,
}

/// A final device statement with everything a genesis needs to check it and record the device: sent by
/// the ingress to the other four when it becomes final, and served to a genesis that pulls it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementBundle {
    pub statement: String,
    #[serde(default)]
    pub lease: Option<LeaseProof>,
    /// (genesis id, hex raw signature over `statement`)
    pub sigs: Vec<(String, String)>,
    /// hex of the device key; its hash and tag are in the statement.
    pub hw_pub: String,
    /// The binding sequence the enrolment signed.
    pub seq: u64,
    #[serde(default)]
    pub att_key: Option<String>,
    #[serde(default)]
    pub certs_issued: Option<u64>,
    #[serde(default)]
    pub serials: Vec<String>,
    #[serde(default)]
    pub counter: u64,
    #[serde(default)]
    pub rebind_from: Option<String>,
    pub ingress: String,
    /// b64url of the enrolment challenge nonce.
    pub nonce: String,
    /// Why a statement without a lease waits (`token_missing`, `service_unavailable`).
    #[serde(default)]
    pub reason: String,
}

/// Check a bundle end to end: the statement text, four distinct genesis signatures under the pinned keys,
/// the device key against its hash and tag, and the lease against the statement's last field. A `test`
/// statement is refused on mainnet.
pub fn verify_bundle(b: &StatementBundle, genesis: &GenesisSet, mainnet: bool)
    -> Result<(StatementFields, Option<LeaseStatement>), &'static str>
{
    let f = StatementFields::parse(&b.statement).ok_or("statement")?;
    let hw_pub = hex::decode(&b.hw_pub).ok().filter(|k| k.len() == 65 && k[0] == 4).ok_or("hw_pub")?;
    if hex::encode(messages::sha3_256(&hw_pub)) != f.hw_key { return Err("hw_key"); }
    if messages::device_tag(f.platform, &hw_pub) != f.device_tag { return Err("device_tag"); }
    if mainnet && f.trust == Trust::Test { return Err("test_build"); }
    if b.seq == 0 || messages::nonce32(&b.nonce).is_none() { return Err("seq_or_nonce"); }
    match (&b.rebind_from, f.op) {
        (Some(from), Op::Rebind) if messages::is_device_node_id(from) && *from != f.node => {}
        (None, Op::Enrol) | (None, Op::Rotate) => {}
        _ => return Err("rebind"),
    }
    let lease = match &b.lease {
        Some(p) => {
            let sig = hex::decode(&p.oracle_sig).map_err(|_| "oracle_sig")?;
            if messages::lease_hash(&p.statement, &sig) != f.lease_hash { return Err("lease_hash"); }
            let l = LeaseStatement::parse(&p.statement).ok_or("lease")?;
            if l.node != f.node || l.device_tag != f.device_tag { return Err("lease_names_another_device"); }
            Some(l)
        }
        None => {
            if f.lease_hash != messages::no_lease_hash() || f.state != DeviceState::CheckPending { return Err("no_lease"); }
            None
        }
    };
    if genesis.count_valid(&b.statement, &b.sigs) < STATEMENT_QUORUM { return Err("quorum"); }
    Ok((f, lease))
}

/// The record a verified bundle makes.
pub fn record_from_bundle(b: &StatementBundle, f: &StatementFields, lease: Option<&LeaseStatement>, now: u64) -> DeviceRecord {
    let hw_pub = hex::decode(&b.hw_pub).unwrap_or_default();
    DeviceRecord {
        node_id: f.node.clone(),
        platform: f.platform,
        hw_pub: b.hw_pub.clone(),
        hw_key: f.hw_key.clone(),
        key_id: hex::encode(messages::sha256(&hw_pub)),
        device_tag: hex::encode(f.device_tag),
        prov: f.prov,
        trust: f.trust,
        op: f.op,
        seq: b.seq,
        issued_epoch: f.issued_epoch,
        effective_epoch: f.effective_epoch,
        state: f.state,
        state_seq: 0,
        until_epoch: 0,
        reason: b.reason.clone(),
        lease: lease.map(|l| LeaseSummary { kind: l.lease, effective: l.effective, gate: l.gate, issued_at: l.issued_at,
                                            pi_digest: l.pi_digest.clone() }),
        // Unsigned beside the signed lease: clamped to the longest window the oracle grants from the lease's
        // signed issue time, so a rewritten window cannot outlive what the oracle could have granted.
        lease_valid_until: clamp_lease_window(b.lease.as_ref().map_or(0, |p| p.lease_valid_until), lease.map(|l| l.issued_at)),
        refresh_at: clamp_lease_window(b.lease.as_ref().map_or(0, |p| p.refresh_at), lease.map(|l| l.issued_at)),
        rotation_due_epoch: f.issued_epoch + ROTATION_PERIOD_EPOCHS,
        last_counter: b.counter,
        att_key: b.att_key.clone(),
        certs_issued: b.certs_issued,
        serials: b.serials.clone(),
        stmt_hash: f.hash(),
        ingress: b.ingress.clone(),
        nonce: b.nonce.clone(),
        rebind_from: b.rebind_from.clone(),
        provisional: false,
        created_at: now,
        updated_at: now,
        last_change: None,
    }
}

/// An unsigned lease-window time (`lease_valid_until`, `refresh_at`) at most `LEASE_WINDOW_MAX_SECS` past `from`
/// (the lease's signed issue time, or this genesis's clock for a refresh); 0 with nothing to measure from.
pub fn clamp_lease_window(t: u64, from: Option<u64>) -> u64 {
    from.map_or(0, |f| t.min(f.saturating_add(super::LEASE_WINDOW_MAX_SECS)))
}

/// A state change verifies under the pinned key of the genesis it names.
pub fn verify_state_change(c: &StateChange, genesis: &GenesisSet) -> bool {
    let (Some(pk), Ok(sig)) = (genesis.key(&c.signer), hex::decode(&c.sig)) else { return false; };
    messages::is_device_node_id(&c.node_id) && c.reason.len() <= 32
        && c.reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        && verify_raw(pk, c.preimage().as_bytes(), &sig)
}

/// Whether a verified state change moves `r` forward: it changes this very statement's record, at a higher
/// `state_seq`; at the same sequence only toward a more severe state. A lower sequence never applies, so a
/// late copy of an older change cannot undo a pause or an end.
pub fn state_change_applies(r: &DeviceRecord, c: &StateChange) -> bool {
    if c.node_id != r.node_id || c.stmt_hash != r.stmt_hash || r.provisional { return false; }
    if c.state_seq > r.state_seq { return true; }
    c.state_seq == r.state_seq && c.state_seq > 0 && c.state.severity() > r.state.severity()
}

/// A change that would lift a pause still running at `epoch` to a lighter state: refused whatever its
/// sequence or reason. A timed pause ends by its own epoch (`DeviceRecord::state_at`), a revocation by a new
/// enrolment's statement, never by a later message (pauses and revocations never move backwards). A support
/// reset had an exemption here that one genesis's signature alone could claim (no node path produces that
/// reason): it goes until a reset is signed under the statement quorum (ND-4).
pub fn lifts_running_pause(r: &DeviceRecord, c: &StateChange, epoch: u64) -> bool {
    r.paused_at(epoch) && c.state.severity() < DeviceState::Paused.severity()
}

/// `r` after the change `c` (already checked with `state_change_applies`).
pub fn apply_state_change(r: &mut DeviceRecord, c: &StateChange, now: u64) {
    r.state = c.state;
    r.state_seq = c.state_seq;
    r.until_epoch = c.until_epoch;
    r.reason = c.reason.clone();
    // The renewed window rides unsigned beside the signed change: clamped to what the oracle could grant now.
    if let Some(t) = c.lease_valid_until { r.lease_valid_until = clamp_lease_window(t, Some(now)); }
    if let Some(t) = c.refresh_at { r.refresh_at = clamp_lease_window(t, Some(now)); }
    r.updated_at = now;
    r.last_change = Some(c.clone());
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::light_device::Gate;
    use pqcrypto_mldsa::mldsa65 as d3;
    use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};

    /// Five test genesis keys and their secret halves.
    pub(crate) fn test_genesis() -> (GenesisSet, Vec<(String, d3::SecretKey)>) {
        let mut members = Vec::new();
        let mut secrets = Vec::new();
        for i in 1..=5 {
            let (pk, sk) = d3::keypair();
            let id = format!("genesis_node_00{}", i);
            members.push((id.clone(), pk.as_bytes().to_vec()));
            secrets.push((id, sk));
        }
        (GenesisSet { members }, secrets)
    }

    pub(crate) fn raw_sign(sk: &d3::SecretKey, msg: &str) -> String {
        hex::encode(d3::detached_sign(msg.as_bytes(), sk).as_bytes())
    }

    #[test]
    fn a_raw_signature_is_taken_from_its_envelope_only_for_its_signer_key_and_message() {
        let (pk, sk) = d3::keypair();
        let msg = "qnet_device_stmt:v1|x";
        let signed = d3::sign(msg.as_bytes(), &sk);
        let sm = pqcrypto_traits::sign::SignedMessage::as_bytes(&signed).to_vec();
        let mut combined = (sm.len() as u32).to_le_bytes().to_vec();
        combined.extend_from_slice(&sm);
        combined.extend_from_slice(&(pk.as_bytes().len() as u32).to_le_bytes());
        combined.extend_from_slice(pk.as_bytes());
        use base64::Engine as _;
        let env = format!("dilithium_sig_genesis_node_001_{}", base64::engine::general_purpose::STANDARD.encode(&combined));
        let raw = raw_from_envelope("genesis_node_001", &env, msg, pk.as_bytes()).expect("raw");
        assert!(verify_raw(pk.as_bytes(), msg.as_bytes(), &raw));
        assert!(raw_from_envelope("genesis_node_002", &env, msg, pk.as_bytes()).is_none(), "another signer");
        assert!(raw_from_envelope("genesis_node_001", &env, "qnet_device_stmt:v1|y", pk.as_bytes()).is_none(), "another message");
        let (other, _) = d3::keypair();
        assert!(raw_from_envelope("genesis_node_001", &env, msg, other.as_bytes()).is_none(), "another key");
    }

    #[test]
    fn the_state_follows_the_lease() {
        let l = |lease, effective, gate| LeaseStatement { node: "light_mobile_6526ab8fd00ff8ca".into(), device_tag: [0; 32],
            lease, effective, gate, pi_digest: String::new(), issued_at: 1 };
        use DeviceState::*;
        // The R5 matrix: never-used slot and self-reclaim now, another generation next, no read pending.
        assert_eq!(derive_state(Some(&l(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok)), Op::Enrol, true), Active);
        assert_eq!(derive_state(Some(&l(LeaseKind::SelfReclaim, Effective::Now, Gate::Ok)), Op::Enrol, true), Active);
        assert_eq!(derive_state(Some(&l(LeaseKind::ClaimedForeign, Effective::Next, Gate::Ok)), Op::Enrol, true), PendingNextEpoch);
        assert_eq!(derive_state(Some(&l(LeaseKind::None, Effective::Next, Gate::Ok)), Op::Enrol, true), CheckPending);
        assert_eq!(derive_state(None, Op::Enrol, true), CheckPending);
        assert_eq!(derive_state(Some(&l(LeaseKind::ClaimedVirgin, Effective::Now, Gate::MetricHigh)), Op::Enrol, true), CheckPending);
        assert_eq!(derive_state(Some(&l(LeaseKind::ClaimedVirgin, Effective::Now, Gate::CertsHigh)), Op::Enrol, true), CheckPending);
        // A rebind counts from the next epoch, whatever the slot read.
        assert_eq!(derive_state(Some(&l(LeaseKind::SelfReclaim, Effective::Now, Gate::Ok)), Op::Rebind, true), PendingNextEpoch);
        assert_eq!(effective_epoch(Some(&l(LeaseKind::SelfReclaim, Effective::Now, Gate::Ok)), Op::Rebind, 7), 8);
        assert_eq!(effective_epoch(Some(&l(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok)), Op::Enrol, 7), 7);
        // Not registered yet: awaiting, and every attestor signs either view.
        let virgin = l(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok);
        assert_eq!(derive_state(Some(&virgin), Op::Enrol, false), AwaitingRegistration);
        assert!(state_admissible(Active, Some(&virgin), Op::Enrol));
        assert!(state_admissible(AwaitingRegistration, Some(&virgin), Op::Enrol));
        assert!(state_admissible(Suspect, Some(&virgin), Op::Enrol));
        assert!(!state_admissible(PendingNextEpoch, Some(&virgin), Op::Enrol));
        assert!(!state_admissible(Active, None, Op::Enrol), "no lease never counts");
        assert!(state_admissible(CheckPending, None, Op::Enrol));
    }

    #[test]
    fn a_state_change_moves_forward_only() {
        let (g, secrets) = test_genesis();
        let mut r = crate::light_device::record::tests::rec(5, 100, DeviceState::Active);
        let (node, stmt) = (r.node_id.clone(), r.stmt_hash.clone());
        let change = |state, seq, signer: usize| {
            let mut c = StateChange { node_id: node.clone(), state, state_seq: seq, until_epoch: 0, reason: "strike".into(),
                                      signer: secrets[signer].0.clone(), sig: String::new(), stmt_hash: stmt.clone(),
                                      lease_valid_until: None, refresh_at: None };
            c.sig = raw_sign(&secrets[signer].1, &c.preimage());
            c
        };
        let c1 = change(DeviceState::Suspect, 1, 0);
        assert!(verify_state_change(&c1, &g));
        let mut forged = c1.clone();
        forged.state = DeviceState::Active;
        assert!(!verify_state_change(&forged, &g), "the signature covers the state");
        let mut outsider = c1.clone();
        outsider.signer = "genesis_node_009".into();
        assert!(!verify_state_change(&outsider, &g));
        assert!(state_change_applies(&r, &c1));
        apply_state_change(&mut r, &c1, 1);
        let paused = change(DeviceState::Paused, 2, 1);
        assert!(state_change_applies(&r, &paused));
        apply_state_change(&mut r, &paused, 2);
        // A late copy of the older change, or a lighter one at the same sequence, never undoes the pause.
        assert!(!state_change_applies(&r, &c1));
        assert!(!state_change_applies(&r, &change(DeviceState::Active, 2, 2)));
        assert!(state_change_applies(&r, &change(DeviceState::Ended, 2, 2)), "a more severe one at the same sequence");
        // A change for another statement's record does nothing.
        let mut other = change(DeviceState::Ended, 9, 0);
        other.stmt_hash = "ff".repeat(32);
        assert!(!state_change_applies(&r, &other));
    }
}
