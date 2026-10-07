//! Writing device records (A5, A6): a final statement from any source - this node's own collection, a
//! peer's push, a pull - goes through one function, as do state changes and the ingress's provisional
//! record. Every write holds `device_write_lock`, so each check-and-write is atomic here.

use super::record::{newer, DeviceRecord, KeyEntry, KnownKey, StateChange};
use super::statement::{self, GenesisSet, StatementBundle};
use super::{device_write_lock, DeviceState, Op};
use crate::storage::{DeviceWrite, Storage};

/// What a final statement did here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applied {
    /// Recorded: the node's current device from now on.
    Recorded(Box<DeviceRecord>),
    /// This very statement is already the record.
    Same,
    /// The record holds a newer statement.
    Older,
}

/// Record a final statement after checking it end to end. `own_id`: this genesis; the bundle's full proof
/// is kept only by its ingress. A running pause carries over to the new record (pauses never move
/// backwards). The device key moves to this node: another node whose live record held it ends
/// (`rebound` for a rebind, else `superseded`), and this node's previous key and attestation key are freed.
pub fn apply_final(storage: &Storage, bundle: &StatementBundle, own_id: Option<&str>, genesis: &GenesisSet, mainnet: bool,
                   now: u64, epoch: u64) -> Result<Applied, &'static str> {
    let (f, lease) = statement::verify_bundle(bundle, genesis, mainnet)?;
    let mut rec = statement::record_from_bundle(bundle, &f, lease.as_ref(), now);
    let _g = device_write_lock();
    let cur = storage.device_record(&f.node);
    rec.rotation_due_epoch = key_rotation_due(storage, &rec, cur.as_ref());
    let mut w = DeviceWrite::default();
    if let Some(c) = cur.as_ref().filter(|c| !c.provisional) {
        if c.stmt_hash == rec.stmt_hash {
            if own_id == Some(bundle.ingress.as_str()) && storage.device_bundle(&f.node).is_none() {
                w.bundles.push((f.node.clone(), Some(bundle.clone())));
                storage.device_write(w).map_err(|_| "storage")?;
            }
            return Ok(Applied::Same);
        }
        if !newer(&rec, c) { return Ok(Applied::Older); }
        // A timed pause carries over, whatever the record's state: a Stop ends the record and keeps its pause
        // (`pause_until`), which still binds the node's next statement. A revocation does not: the new
        // statement's chain was checked against the list (a later snapshot naming it pauses the new record at
        // the next check).
        if c.pause_until(epoch) > 0 {
            rec.state = DeviceState::Paused;
            rec.until_epoch = c.until_epoch;
            // An ended record's reason is its end's (`released`); the pause it kept is what carries.
            rec.reason = if c.state == DeviceState::Paused { c.reason.clone() } else { "paused".to_string() };
        }
        if c.hw_key == rec.hw_key {
            rec.last_counter = rec.last_counter.max(c.last_counter);
        } else {
            if storage.device_key_entry(&c.hw_key).map_or(false, |e| e.node_id == f.node) {
                w.keys.push((c.hw_key.clone(), None));
                w.counters.push((c.hw_key.clone(), None));
            }
            // A rotation retires the old key for good: every later binding attests a new one (R7).
            if rec.op == Op::Rotate {
                w.retired_key_ids.push(c.key_id.clone());
            }
            if let Some(a) = c.att_key.as_ref().filter(|a| rec.att_key.as_ref() != Some(*a)) {
                if storage.device_attkey_entry(a).map_or(false, |e| e.node_id == f.node) { w.attkeys.push((a.clone(), None)); }
            }
        }
    }
    // The device key, or the one app instance behind a remotely provisioned attestation key, moves here.
    let reason = if rec.op == Op::Rebind { "rebound" } else { "superseded" };
    let mut ended: Vec<String> = Vec::new();
    let others = [storage.device_key_entry(&rec.hw_key), rec.att_key.as_ref().and_then(|a| storage.device_attkey_entry(a))];
    for e in others.into_iter().flatten().filter(|e| e.node_id != f.node) {
        if ended.contains(&e.node_id) { continue; }
        if let Some(mut other) = storage.device_record(&e.node_id).filter(|o| o.live() && !o.provisional) {
            if let Some(a) = other.att_key.as_ref().filter(|a| rec.att_key.as_ref() != Some(*a)) {
                if storage.device_attkey_entry(a).map_or(false, |x| x.node_id == other.node_id) { w.attkeys.push((a.clone(), None)); }
            }
            if other.hw_key != rec.hw_key && storage.device_key_entry(&other.hw_key).map_or(false, |x| x.node_id == other.node_id) {
                w.keys.push((other.hw_key.clone(), None));
                w.counters.push((other.hw_key.clone(), None));
            }
            other.state = DeviceState::Ended;
            other.reason = reason.to_string();
            other.updated_at = now;
            ended.push(other.node_id.clone());
            w.records.push(other);
        }
    }
    // The final entry takes over from this node's reservation of the key (an end of the record later
    // frees the key at once, not a day after the enrolment).
    let entry = KeyEntry { node_id: f.node.clone(), seq: rec.seq, final_: true, at: now };
    w.keys.push((rec.hw_key.clone(), Some(entry.clone())));
    if storage.device_key_reservation(&rec.hw_key).map_or(false, |e| e.node_id == f.node) {
        w.key_reservations.push((rec.hw_key.clone(), None));
    }
    if let Some(a) = &rec.att_key {
        w.attkeys.push((a.clone(), Some(entry)));
        if storage.device_attkey_reservation(a).map_or(false, |e| e.node_id == f.node) {
            w.attkey_reservations.push((a.clone(), None));
        }
    }
    w.key_ids.push((rec.key_id.clone(), KnownKey { hw_pub: rec.hw_pub.clone(), node_id: f.node.clone(), platform: rec.platform,
                                                prov: rec.prov, trust: rec.trust, rotation_due_epoch: rec.rotation_due_epoch }));
    if own_id == Some(bundle.ingress.as_str()) {
        w.bundles.push((f.node.clone(), Some(bundle.clone())));
    } else if cur.as_ref().map_or(false, |c| own_id == Some(c.ingress.as_str())) {
        // This genesis took the node's previous enrolment; that proof is no longer the current one.
        w.bundles.push((f.node.clone(), None));
    }
    w.records.push(rec.clone());
    storage.device_write(w).map_err(|_| "storage")?;
    // The ended node and why, never the node that took the key: the pair would link two wallets to one device
    // in every operator's log.
    for n in &ended {
        if crate::node::is_info() {
            println!("[INFO][DEVICE] record_ended node={} reason={}", n, reason);
        }
    }
    Ok(Applied::Recorded(Box::new(rec)))
}

/// The epoch the statement's device key must rotate by (R7). The clock follows the key, not the statement: a
/// fresh attestation (a key these genesis never recorded, or a rotation to a new one) starts a period at the
/// statement's epoch; any other statement over a key already attested (a re-enrolment with its assertion, a
/// rebind, a re-link) keeps the period the key runs, so no statement resets it and a key cannot dodge rotation
/// by re-enrolling (ND-2). The key's period comes from its known-key entry, else from the record that held it.
fn key_rotation_due(storage: &Storage, rec: &DeviceRecord, cur: Option<&DeviceRecord>) -> u64 {
    let fresh_period = rec.issued_epoch.saturating_add(super::ROTATION_PERIOD_EPOCHS);
    let known = storage.device_known_key(&rec.key_id);
    if rec.op == Op::Rotate || known.is_none() {
        return fresh_period;
    }
    let held_by = |node: &str| storage.device_record(node).filter(|r| r.hw_key == rec.hw_key).map(|r| r.rotation_due_epoch);
    let inherited = known.as_ref().map(|k| k.rotation_due_epoch).filter(|d| *d > 0)
        .or_else(|| cur.filter(|c| c.hw_key == rec.hw_key).map(|c| c.rotation_due_epoch))
        .or_else(|| known.as_ref().and_then(|k| held_by(&k.node_id)))
        .or_else(|| rec.rebind_from.as_deref().and_then(held_by));
    inherited.map_or(fresh_period, |d| d.min(fresh_period))
}

/// The ingress's record while its enrolment waits for the oracle or the quorum: `check_pending`, never
/// counted and never sent on. Written only over nothing, another provisional record, or an older binding;
/// a final record of this or a later binding stays.
pub fn write_provisional(storage: &Storage, rec: &DeviceRecord) -> bool {
    let _g = device_write_lock();
    let writable = match storage.device_record(&rec.node_id) {
        None => true,
        Some(c) if c.provisional => true,
        Some(c) => c.seq < rec.seq,
    };
    if !writable { return false; }
    let mut p = rec.clone();
    p.provisional = true;
    p.state = DeviceState::CheckPending;
    let mut w = DeviceWrite::default();
    w.records.push(p);
    storage.device_write(w).is_ok()
}

/// An enrolment that ended after its answer was sent: the provisional record keeps waiting, with why.
pub fn note_provisional(storage: &Storage, node: &str, nonce: &str, reason: &str, now: u64) {
    let _g = device_write_lock();
    if let Some(mut c) = storage.device_record(node).filter(|c| c.provisional && c.nonce == nonce) {
        c.reason = reason.to_string();
        c.updated_at = now;
        let mut w = DeviceWrite::default();
        w.records.push(c);
        let _ = storage.device_write(w);
    }
}

/// Apply a signed state change to the record it names, as of `epoch`. An end frees the record's keys, except
/// while a timed pause it keeps still runs: the device's key moves to no other node until the pause's epoch
/// (`attest::admit` reads the pause through the key's entry); a lighter state never lifts a pause still
/// running (`statement::lifts_running_pause`).
pub fn apply_change(storage: &Storage, c: &StateChange, genesis: &GenesisSet, now: u64, epoch: u64) -> Result<bool, &'static str> {
    if !statement::verify_state_change(c, genesis) { return Err("bad_signature"); }
    let _g = device_write_lock();
    let Some(mut r) = storage.device_record(&c.node_id) else { return Err("no_record"); };
    if !statement::state_change_applies(&r, c) || statement::lifts_running_pause(&r, c, epoch) { return Ok(false); }
    statement::apply_state_change(&mut r, c, now);
    let mut w = DeviceWrite::default();
    if r.state == DeviceState::Ended && r.pause_until(epoch) == 0 {
        if storage.device_key_entry(&r.hw_key).map_or(false, |e| e.node_id == r.node_id) {
            w.keys.push((r.hw_key.clone(), None));
            w.counters.push((r.hw_key.clone(), None));
        }
        if let Some(a) = &r.att_key {
            if storage.device_attkey_entry(a).map_or(false, |e| e.node_id == r.node_id) { w.attkeys.push((a.clone(), None)); }
        }
    }
    w.records.push(r);
    storage.device_write(w).map_err(|_| "storage")?;
    Ok(true)
}

/// A signed change names a statement this node never recorded as the node's record: none here, a
/// provisional one, or another statement's. `apply_change` takes nothing from it; a pull of the sender's
/// record does.
pub fn names_unknown_statement(storage: &Storage, c: &StateChange) -> bool {
    storage.device_record(&c.node_id).map_or(true, |r| r.provisional || r.stmt_hash != c.stmt_hash)
}

/// The last counter this genesis took from the record's key: its enrolment's, or a later reply's.
pub fn last_counter(storage: &Storage, r: &DeviceRecord) -> u64 {
    r.last_counter.max(storage.device_counter(&r.hw_key))
}

/// Take `counter` as the key's last one, if it is above the last one taken (atomically with every other
/// device write here). False when another reply took an equal or higher one first.
pub fn take_counter(storage: &Storage, hw_key: &str, counter: u64) -> bool {
    let _g = device_write_lock();
    if counter <= storage.device_counter(hw_key) { return false; }
    let mut w = DeviceWrite::default();
    w.counters.push((hw_key.to_string(), Some(counter)));
    storage.device_write(w).is_ok()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::light_device::messages::{self, LeaseStatement, StatementFields};
    use crate::light_device::statement::tests::{raw_sign, test_genesis};
    use crate::light_device::statement::LeaseProof;
    use crate::light_device::{Effective, Gate, LeaseKind, Platform, Prov, Trust};

    pub(crate) fn storage() -> (Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        let s = Storage::new(dir.path().to_str().unwrap()).unwrap();
        (s, dir)
    }

    /// A final bundle for `node` and the device key `hw_pub`, signed by the first `signers` test genesis.
    pub(crate) fn bundle(node: &str, hw_pub: &[u8; 65], platform: Platform, seq: u64, epoch: u64, state: DeviceState,
                         op: Op, secrets: &[(String, pqcrypto_mldsa::mldsa65::SecretKey)], signers: usize,
                         oracle: Option<&pqcrypto_mldsa::mldsa65::SecretKey>) -> StatementBundle {
        let tag = messages::device_tag(platform, hw_pub);
        let (lease, lease_hash) = match oracle {
            Some(sk) => {
                let l = LeaseStatement { node: node.into(), device_tag: tag, lease: LeaseKind::ClaimedVirgin,
                    effective: Effective::Now, gate: Gate::Ok, pi_digest: String::new(), issued_at: 1_800_000_000 };
                let text = l.preimage();
                let sig = raw_sign(sk, &text);
                let h = messages::lease_hash(&text, &hex::decode(&sig).unwrap());
                (Some(LeaseProof { statement: text, oracle_sig: sig, lease_valid_until: 1_800_000_000 + 7 * 86_400,
                                   refresh_at: 1_800_000_000 + 6 * 86_400 }), h)
            }
            None => (None, messages::no_lease_hash()),
        };
        let f = StatementFields { node: node.into(), device_tag: tag, hw_key: hex::encode(messages::sha3_256(hw_pub)), platform,
            prov: if platform == Platform::Ios { Prov::Na } else { Prov::Rkp }, trust: Trust::Store, op, issued_epoch: epoch,
            effective_epoch: epoch, state, lease_hash };
        let text = f.preimage();
        StatementBundle {
            sigs: secrets.iter().take(signers).map(|(id, sk)| (id.clone(), raw_sign(sk, &text))).collect(),
            statement: text, lease, hw_pub: hex::encode(hw_pub), seq, att_key: None, certs_issued: None, serials: vec![],
            counter: 0, rebind_from: (op == Op::Rebind).then(|| "light_mobile_dacc1355d21394a2".to_string()),
            ingress: "genesis_node_001".into(), nonce: messages::b64url(&[9u8; 32]), reason: String::new(),
        }
    }

    pub(crate) fn key(b: u8) -> [u8; 65] {
        let mut k = [b; 65];
        k[0] = 4;
        k
    }

    #[test]
    fn a_final_statement_is_recorded_once_and_a_newer_one_moves_the_device() {
        let (s, _d) = storage();
        let (g, secrets) = test_genesis();
        let (_, oracle_sk) = pqcrypto_mldsa::mldsa65::keypair();
        let n1 = "light_mobile_6526ab8fd00ff8ca";
        let now = 1_800_000_000;
        // Three signatures are not a statement.
        let weak = bundle(n1, &key(1), Platform::Ios, 10, 100, DeviceState::Active, Op::Enrol, &secrets, 3, Some(&oracle_sk));
        assert_eq!(apply_final(&s, &weak, None, &g, true, now, 100), Err("quorum"));
        let b1 = bundle(n1, &key(1), Platform::Ios, 10, 100, DeviceState::Active, Op::Enrol, &secrets, 4, Some(&oracle_sk));
        let rec = match apply_final(&s, &b1, Some("genesis_node_001"), &g, true, now, 100).unwrap() {
            Applied::Recorded(r) => *r, other => panic!("{other:?}"),
        };
        assert_eq!((rec.state, rec.seq, rec.lease.as_ref().map(|l| l.kind)), (DeviceState::Active, 10, Some(LeaseKind::ClaimedVirgin)));
        assert_eq!(s.device_key_entry(&rec.hw_key).map(|e| (e.node_id, e.final_)), Some((n1.to_string(), true)));
        assert_eq!(s.device_hw_pub_by_key_id(&rec.key_id), Some(rec.hw_pub.clone()));
        assert!(s.device_bundle(n1).is_some(), "the ingress keeps the proof");
        assert_eq!(apply_final(&s, &b1, Some("genesis_node_001"), &g, true, now, 100), Ok(Applied::Same));
        // A newer binding with another device key replaces it and frees the old key.
        let mut b2 = bundle(n1, &key(2), Platform::Ios, 11, 100, DeviceState::Active, Op::Enrol, &secrets, 5, Some(&oracle_sk));
        b2.ingress = "genesis_node_003".into();
        assert!(matches!(apply_final(&s, &b2, Some("genesis_node_001"), &g, true, now, 100), Ok(Applied::Recorded(_))));
        assert!(s.device_key_entry(&rec.hw_key).is_none(), "the old key is free");
        assert!(s.device_bundle(n1).is_none(), "another genesis took the new enrolment");
        // The older one never comes back.
        assert_eq!(apply_final(&s, &b1, None, &g, true, now, 100), Ok(Applied::Older));
        // A test build is refused on mainnet.
        let mut t = bundle(n1, &key(3), Platform::Ios, 12, 100, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        let mut f = StatementFields::parse(&t.statement).unwrap();
        f.trust = Trust::Test;
        t.statement = f.preimage();
        t.sigs = secrets.iter().take(4).map(|(id, sk)| (id.clone(), raw_sign(sk, &t.statement))).collect();
        assert_eq!(apply_final(&s, &t, None, &g, true, now, 100), Err("test_build"));
        assert!(matches!(apply_final(&s, &t, None, &g, false, now, 100), Ok(Applied::Recorded(_))), "testnet takes it");
    }

    #[test]
    fn a_device_key_serves_one_node_and_a_pause_carries_over() {
        let (s, _d) = storage();
        let (g, secrets) = test_genesis();
        let (n1, n2) = ("light_mobile_6526ab8fd00ff8ca", "light_mobile_dacc1355d21394a2");
        let now = 1_800_000_000;
        let b1 = bundle(n2, &key(7), Platform::Ios, 10, 100, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        apply_final(&s, &b1, None, &g, true, now, 100).unwrap();
        // The same key moves to n1 by a rebind from n2: n2's record ends.
        let b2 = bundle(n1, &key(7), Platform::Ios, 20, 100, DeviceState::CheckPending, Op::Rebind, &secrets, 4, None);
        apply_final(&s, &b2, None, &g, true, now, 100).unwrap();
        let old = s.device_record(n2).unwrap();
        assert_eq!((old.state, old.reason.as_str()), (DeviceState::Ended, "rebound"));
        assert_eq!(s.device_key_entry(&old.hw_key).map(|e| e.node_id), Some(n1.to_string()));
        // A pause on n1 survives a newer statement until its epoch.
        let mut r = s.device_record(n1).unwrap();
        r.state = DeviceState::Paused;
        r.until_epoch = 300;
        let mut w = DeviceWrite::default();
        w.records.push(r);
        s.device_write(w).unwrap();
        let b3 = bundle(n1, &key(8), Platform::Ios, 21, 101, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        apply_final(&s, &b3, None, &g, true, now, 101).unwrap();
        let r = s.device_record(n1).unwrap();
        assert_eq!((r.state, r.until_epoch), (DeviceState::Paused, 300));
        // ND-6: a Stop during the pause ends the record and keeps the pause's epoch; the next statement still
        // lands paused until it.
        let mut r = s.device_record(n1).unwrap();
        r.state = DeviceState::Ended;
        r.reason = "released".into();
        let mut w = DeviceWrite::default();
        w.records.push(r);
        s.device_write(w).unwrap();
        let b4 = bundle(n1, &key(9), Platform::Ios, 22, 102, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        apply_final(&s, &b4, None, &g, true, now, 102).unwrap();
        let r = s.device_record(n1).unwrap();
        assert_eq!((r.state, r.until_epoch, r.reason.as_str()), (DeviceState::Paused, 300, "paused"));
        // Past its epoch nothing carries.
        let b5 = bundle(n1, &key(10), Platform::Ios, 23, 300, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        apply_final(&s, &b5, None, &g, true, now, 300).unwrap();
        assert_eq!(s.device_record(n1).unwrap().state, DeviceState::CheckPending);
    }

    /// ND-2 (R7): the rotation clock follows the key. A re-enrolment with a key already attested and a rebind
    /// keep the key's period; only a fresh key or a rotation starts a new one, so re-enrolling every 50 days
    /// never dodges rotation.
    #[test]
    fn the_rotation_clock_follows_the_key_not_the_statement() {
        let (s, _d) = storage();
        let (g, secrets) = test_genesis();
        let (n1, n2) = ("light_mobile_6526ab8fd00ff8ca", "light_mobile_dacc1355d21394a2");
        let now = 1_800_000_000;
        let period = crate::light_device::ROTATION_PERIOD_EPOCHS;
        let due = |n: &str| s.device_record(n).unwrap().rotation_due_epoch;
        let b1 = bundle(n2, &key(11), Platform::Ios, 10, 100, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        apply_final(&s, &b1, None, &g, true, now, 100).unwrap();
        assert_eq!(due(n2), 100 + period, "a fresh key starts its period");
        let b2 = bundle(n2, &key(11), Platform::Ios, 11, 150, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        apply_final(&s, &b2, None, &g, true, now, 150).unwrap();
        assert_eq!(due(n2), 100 + period, "a re-enrolment with the same key keeps it");
        let b3 = bundle(n1, &key(11), Platform::Ios, 12, 200, DeviceState::CheckPending, Op::Rebind, &secrets, 4, None);
        apply_final(&s, &b3, None, &g, true, now, 200).unwrap();
        assert_eq!(due(n1), 100 + period, "a rebind keeps it");
        assert_eq!(s.device_known_key(&s.device_record(n1).unwrap().key_id).map(|k| k.rotation_due_epoch), Some(100 + period));
        let b4 = bundle(n1, &key(12), Platform::Ios, 13, 250, DeviceState::CheckPending, Op::Rotate, &secrets, 4, None);
        apply_final(&s, &b4, None, &g, true, now, 250).unwrap();
        assert_eq!(due(n1), 250 + period, "a rotation starts a new period");
    }

    #[test]
    fn a_provisional_record_never_displaces_a_final_one() {
        let (s, _d) = storage();
        let (g, secrets) = test_genesis();
        let n1 = "light_mobile_6526ab8fd00ff8ca";
        let now = 1_800_000_000;
        let b = bundle(n1, &key(1), Platform::Ios, 10, 100, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        let (f, _) = statement::verify_bundle(&b, &g, true).unwrap();
        let mut p = statement::record_from_bundle(&b, &f, None, now);
        p.stmt_hash.clear();
        assert!(write_provisional(&s, &p));
        assert!(s.device_record(n1).unwrap().provisional);
        note_provisional(&s, n1, &p.nonce, "quorum_unavailable", now);
        assert_eq!(s.device_record(n1).unwrap().reason, "quorum_unavailable");
        // The final statement replaces the provisional record; a provisional one never replaces it back.
        apply_final(&s, &b, None, &g, true, now, 100).unwrap();
        assert!(!s.device_record(n1).unwrap().provisional);
        assert!(!write_provisional(&s, &p));
        assert!(write_provisional(&s, &DeviceRecord { seq: 11, ..p.clone() }), "a later binding's provisional record");
    }

    #[test]
    fn an_end_by_state_change_frees_the_key() {
        let (s, _d) = storage();
        let (g, secrets) = test_genesis();
        let n1 = "light_mobile_6526ab8fd00ff8ca";
        let now = 1_800_000_000;
        let b = bundle(n1, &key(4), Platform::Ios, 10, 100, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        apply_final(&s, &b, None, &g, true, now, 100).unwrap();
        let r = s.device_record(n1).unwrap();
        let mut c = StateChange { node_id: n1.into(), state: DeviceState::Ended, state_seq: 1, until_epoch: 0, reason: "released".into(),
            signer: secrets[2].0.clone(), sig: String::new(), stmt_hash: r.stmt_hash.clone(), lease_valid_until: None, refresh_at: None };
        c.sig = raw_sign(&secrets[2].1, &c.preimage());
        assert_eq!(apply_change(&s, &c, &g, now, 100), Ok(true));
        assert_eq!(apply_change(&s, &c, &g, now, 100), Ok(false), "once");
        assert!(s.device_key_entry(&r.hw_key).is_none());
        assert_eq!(s.device_record(n1).unwrap().state, DeviceState::Ended);
        let mut forged = c.clone();
        forged.state_seq = 2;
        assert_eq!(apply_change(&s, &forged, &g, now, 100), Err("bad_signature"));
    }

    #[test]
    fn a_running_pause_is_never_lifted_by_a_lighter_change_and_the_lease_window_travels_with_a_refresh() {
        let (s, _d) = storage();
        let (g, secrets) = test_genesis();
        let n1 = "light_mobile_6526ab8fd00ff8ca";
        let now = 1_800_000_000;
        let b = bundle(n1, &key(5), Platform::Ios, 10, 100, DeviceState::CheckPending, Op::Enrol, &secrets, 4, None);
        apply_final(&s, &b, None, &g, true, now, 100).unwrap();
        let signed = |r: &DeviceRecord, state, until, reason: &str, signer: usize| {
            let mut c = StateChange::of(r, state, until, reason, &secrets[signer].0);
            c.sig = raw_sign(&secrets[signer].1, &c.preimage());
            c
        };
        // A refresh renews the lease window; it rides unsigned beside the signed change.
        let r = s.device_record(n1).unwrap();
        let mut ok = StateChange::of(&r, DeviceState::Active, 0, "refresh_ok", &secrets[0].0);
        ok.lease_valid_until = Some(now + 7 * 86_400);
        ok.refresh_at = Some(now + 6 * 86_400);
        ok.sig = raw_sign(&secrets[0].1, &ok.preimage());
        assert_eq!(apply_change(&s, &ok, &g, now, 100), Ok(true));
        let r = s.device_record(n1).unwrap();
        assert_eq!((r.state, r.lease_valid_until, r.refresh_at), (DeviceState::Active, now + 7 * 86_400, now + 6 * 86_400));
        // Two strikes pause it until epoch 280.
        let pause = signed(&r, DeviceState::Paused, 280, "two_strikes", 1);
        assert_eq!(apply_change(&s, &pause, &g, now, 100), Ok(true));
        let r = s.device_record(n1).unwrap();
        // A later refresh_ok at a higher sequence does not lift it while it runs, nor does a "reset" one genesis
        // signs alone (ND-4)...
        assert_eq!(apply_change(&s, &signed(&r, DeviceState::Active, 0, "refresh_ok", 2), &g, now, 279), Ok(false));
        assert_eq!(apply_change(&s, &signed(&r, DeviceState::Active, 0, "reset", 2), &g, now, 279), Ok(false));
        assert_eq!(s.device_record(n1).unwrap().state, DeviceState::Paused);
        // ...an end does (a Stop keeps the pause's epoch in the change), and after its epoch a refresh does.
        assert_eq!(apply_change(&s, &signed(&r, DeviceState::Active, 0, "refresh_ok", 2), &g, now, 280), Ok(true));
        let r = s.device_record(n1).unwrap();
        assert!(take_counter(&s, &r.hw_key, 7));
        let end = signed(&r, DeviceState::Ended, 0, "released", 3);
        assert_eq!(apply_change(&s, &end, &g, now, 280), Ok(true));
        assert!(s.device_key_entry(&r.hw_key).is_none() && s.device_counter(&r.hw_key) == 0, "the key and its counter go");
    }

    /// ND-3: the lease window rides unsigned beside a statement and a refresh change. A rewritten window is
    /// clamped to the longest the oracle grants: from the lease's signed issue time, or from now for a refresh.
    #[test]
    fn an_unsigned_lease_window_is_clamped_to_what_the_oracle_could_grant() {
        let (s, _d) = storage();
        let (g, secrets) = test_genesis();
        let (_, oracle_sk) = pqcrypto_mldsa::mldsa65::keypair();
        let n1 = "light_mobile_6526ab8fd00ff8ca";
        let now = 1_800_000_000;
        let max = crate::light_device::LEASE_WINDOW_MAX_SECS;
        let mut b = bundle(n1, &key(13), Platform::Ios, 10, 100, DeviceState::Active, Op::Enrol, &secrets, 4, Some(&oracle_sk));
        if let Some(l) = b.lease.as_mut() { l.lease_valid_until = u64::MAX; l.refresh_at = u64::MAX; }
        apply_final(&s, &b, None, &g, true, now, 100).unwrap();
        let r = s.device_record(n1).unwrap();
        assert_eq!((r.lease_valid_until, r.refresh_at), (now + max, now + max), "issued_at is the signed lease time");
        let mut c = StateChange::of(&r, DeviceState::Active, 0, "refresh_ok", &secrets[0].0);
        c.lease_valid_until = Some(u64::MAX);
        c.sig = raw_sign(&secrets[0].1, &c.preimage());
        assert_eq!(apply_change(&s, &c, &g, now + 10, 100), Ok(true));
        assert_eq!(s.device_record(n1).unwrap().lease_valid_until, now + 10 + max);
    }

    /// ND-8: the log of a record another statement ended names that node and the reason, never the node that
    /// took the key: the pair would link two wallets to one device in every operator's log.
    #[test]
    fn an_ended_record_is_logged_without_the_node_that_took_its_key() {
        let src = include_str!("store.rs");
        let line = src.lines().find(|l| l.contains("[INFO][DEVICE] record_ended")).expect("the log line");
        assert!(line.contains("node={} reason={}\"") && !line.contains("by="), "{line}");
    }

    #[test]
    fn a_counter_is_taken_once_and_only_upward() {
        let (s, _d) = storage();
        let k = "ab".repeat(32);
        assert!(take_counter(&s, &k, 5));
        assert!(!take_counter(&s, &k, 5), "the same counter again");
        assert!(!take_counter(&s, &k, 4));
        assert!(take_counter(&s, &k, 6));
        let mut r = crate::light_device::record::tests::rec(1, 100, DeviceState::Active);
        r.hw_key = k.clone();
        r.last_counter = 3;
        assert_eq!(last_counter(&s, &r), 6);
        r.last_counter = 9;
        assert_eq!(last_counter(&s, &r), 9, "the enrolment's counter when it is the higher");
    }
}
