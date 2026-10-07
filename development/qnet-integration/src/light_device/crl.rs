//! The Android attestation revocation list (A14, spec section 6.4): the oracle fetches Google's status list
//! and signs one snapshot of it; each genesis takes the snapshot only under the oracle key pinned in the
//! binary, never moves back to an older one, checks every new chain against it (the verifier crate refuses a
//! revoked serial at enrolment and rotation), and once an epoch pauses every live record whose stored chain
//! it names (`revoked`, a signed state change sent to the other four). The check seeks the list's serials in
//! the serial index (`z:{serial}:{N}`); it never walks the records.
//!
//! A snapshot older than `CRL_MAX_AGE_SECS` raises an alert and stays in use: a list only ever refuses.

use qnet_device_attest::revocation::RevocationList;
use serde::{Deserialize, Serialize};

use super::messages;
use super::record::DeviceRecord;
use super::statement::OraclePins;
use super::{Platform, CLOCK_SKEW_SECS};
use crate::storage::Storage;

/// Records one revoked serial may name in one check: a batch certificate of a whole device model.
const MAX_NODES_PER_SERIAL: usize = 1_000_000;

/// `GET /v1/crl` as the oracle serves it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub fetched_at: u64,
    pub serials: Vec<String>,
    pub list_sha3: String,
    pub preimage: String,
    /// hex of the oracle's raw ML-DSA-65 signature over `preimage`.
    pub sig: String,
}

/// A serial in the list's own form (lowercase hex without leading zeros), by the verifier crate's rule.
pub fn normal_serial(s: &str) -> Option<String> {
    RevocationList::from_serials([s]).ok().map(|l| l.canonical_text())
}

/// Why a snapshot is not taken (logged by code; the snapshot carries no secret).
pub fn verify(s: &Snapshot, pins: &OraclePins, epoch: u64, now: u64) -> Result<RevocationList, &'static str> {
    let text = s.serials.join("\n");
    let list = RevocationList::from_canonical_text(&text).map_err(|_| "list_not_canonical")?;
    if hex::encode(messages::sha3_256(text.as_bytes())) != s.list_sha3 { return Err("list_sha3"); }
    if messages::crl_preimage(s.fetched_at, &text) != s.preimage { return Err("preimage"); }
    if s.fetched_at > now.saturating_add(CLOCK_SKEW_SECS) { return Err("from_the_future"); }
    let sig = hex::decode(&s.sig).map_err(|_| "signature")?;
    if !pins.verify(&s.preimage, &sig, epoch) { return Err("signature"); }
    Ok(list)
}

/// The live, final Android records whose stored chain `list` names and that no pause holds in `epoch`: the
/// ones this check pauses. A timed pause runs out first (the list's view reads the record paused meanwhile,
/// `record::Local`), so its epoch is never lost to a pause that has none. A serial's index rows are hints;
/// each record is read and checked itself.
pub fn revoked_records(storage: &Storage, list: &RevocationList, epoch: u64) -> Vec<DeviceRecord> {
    let text = list.canonical_text();
    if text.is_empty() { return Vec::new(); }
    let mut out: std::collections::BTreeMap<String, DeviceRecord> = std::collections::BTreeMap::new();
    for serial in text.split('\n') {
        for node in storage.device_nodes_by_serial(serial, MAX_NODES_PER_SERIAL) {
            if out.contains_key(&node) { continue; }
            let Some(r) = storage.device_record(&node) else { continue; };
            if r.provisional || !r.live() || r.platform != Platform::Android || r.paused_at(epoch) { continue; }
            if !r.serials.iter().any(|s| list.contains(s)) { continue; }
            out.insert(node, r);
        }
    }
    out.into_values().collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::light_device::record::tests::rec;
    use crate::light_device::record::REVOKED;
    use crate::light_device::statement::tests::raw_sign;
    use crate::light_device::DeviceState;
    use crate::storage::DeviceWrite;

    pub(crate) fn snapshot(serials: &[&str], fetched_at: u64, sk: &pqcrypto_mldsa::mldsa65::SecretKey) -> Snapshot {
        let list = RevocationList::from_serials(serials.iter().copied()).unwrap();
        let text = list.canonical_text();
        let preimage = messages::crl_preimage(fetched_at, &text);
        Snapshot {
            fetched_at,
            serials: if text.is_empty() { vec![] } else { text.split('\n').map(str::to_string).collect() },
            list_sha3: hex::encode(messages::sha3_256(text.as_bytes())),
            sig: raw_sign(sk, &preimage),
            preimage,
        }
    }

    #[test]
    fn a_snapshot_is_taken_only_as_the_pinned_oracle_signed_it() {
        use pqcrypto_traits::sign::PublicKey as _;
        let (pk, sk) = pqcrypto_mldsa::mldsa65::keypair();
        let pins = OraclePins { keys: vec![(pk.as_bytes().to_vec(), u64::MAX)] };
        let now = 1_800_000_000;
        let s = snapshot(&["c0ffee", "1a2b", "7"], now - 60, &sk);
        let list = verify(&s, &pins, 155, now).unwrap();
        assert!(list.contains("C0FFEE") && list.contains("0007") && !list.contains("8"));
        // The protocol vector's list: the same text, hash and preimage as the oracle's.
        assert_eq!(s.serials, vec!["1a2b", "7", "c0ffee"]);
        let (_, other) = pqcrypto_mldsa::mldsa65::keypair();
        assert_eq!(verify(&snapshot(&["7"], now, &other), &pins, 155, now), Err("signature"), "another key");
        let mut t = s.clone();
        t.serials.pop();
        assert_eq!(verify(&t, &pins, 155, now), Err("list_sha3"), "a serial dropped");
        let mut t = s.clone();
        t.serials.swap(0, 1);
        assert_eq!(verify(&t, &pins, 155, now), Err("list_not_canonical"));
        let mut t = s.clone();
        t.fetched_at += 1;
        assert_eq!(verify(&t, &pins, 155, now), Err("preimage"));
        assert_eq!(verify(&snapshot(&["7"], now + 3_600, &sk), &pins, 155, now), Err("from_the_future"));
        assert!(verify(&snapshot(&[], now, &sk), &pins, 155, now).unwrap().is_empty(), "an empty list is a list");
        assert_eq!(verify(&s, &OraclePins::default(), 155, now), Err("signature"), "no pinned key, no snapshot");
        assert_eq!(normal_serial("00C0FFEE").as_deref(), Some("c0ffee"));
        assert_eq!(normal_serial("xyz"), None);
    }

    #[test]
    fn the_check_names_each_live_android_record_its_list_revokes_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let mut w = DeviceWrite::default();
        let mut a = rec(1, 100, DeviceState::Active);
        a.platform = Platform::Android;
        a.serials = vec!["00c0ffee".into(), "1a2b".into()];
        let mut b = a.clone();
        b.node_id = "light_mobile_dacc1355d21394a2".into();
        b.serials = vec!["1a2b".into(), "99".into()];
        let mut done = a.clone();
        done.node_id = "light_mobile_0123456789abcdef".into();
        done.state = DeviceState::Paused;
        done.reason = REVOKED.into();
        let mut timed = a.clone();
        timed.node_id = "light_mobile_fedcba9876543210".into();
        timed.state = DeviceState::Paused;
        timed.until_epoch = 120;
        timed.reason = "two_strikes".into();
        w.records.extend([a.clone(), b.clone(), done, timed.clone()]);
        s.device_write(w).unwrap();
        let list = RevocationList::from_serials(["c0ffee", "1a2b"]).unwrap();
        let hit: Vec<String> = revoked_records(&s, &list, 100).into_iter().map(|r| r.node_id).collect();
        assert_eq!(hit, vec![a.node_id.clone(), b.node_id.clone()], "each once; the paused ones left alone");
        let later: Vec<String> = revoked_records(&s, &list, 120).into_iter().map(|r| r.node_id).collect();
        assert!(later.contains(&timed.node_id), "once its timed pause ran out");
        assert!(revoked_records(&s, &RevocationList::from_serials(["99"]).unwrap(), 100).iter().all(|r| r.node_id == b.node_id));
        assert!(revoked_records(&s, &RevocationList::default(), 100).is_empty());
        // An index row the record no longer backs names nothing.
        let mut moved = b.clone();
        moved.serials = vec!["55".into()];
        let mut w = DeviceWrite::default();
        w.records.push(moved);
        s.device_write(w).unwrap();
        assert!(revoked_records(&s, &RevocationList::from_serials(["99"]).unwrap(), 100).is_empty());
    }
}
