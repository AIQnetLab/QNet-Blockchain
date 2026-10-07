//! Device-layer records (A5): operational state of the five genesis, never consensus and never in a
//! snapshot.
//!
//! - `light_device`: `r:{N}` the device record (JSON), `v:{N}:{seq}` an attestor's vote, `s:{N}` the full
//!   proof of the node's current statement (zstd JSON), kept by the genesis that took the enrolment,
//!   `c:{hex(sha3(hw_pub))}` the last iOS assertion counter or Android `hw_seq` this genesis took from a
//!   device key (its own row, so a reply rewrites a few bytes, not the record).
//! - `light_device_key`: `ldk_{hex(sha3(hw_pub))}` which node a device key serves (a final statement's record),
//!   `ldkr_{…}` an attestor's reservation of it for the node it signed a statement for, `lki_{hex(key_id)}` the
//!   device key an iOS key identifier names (an assertion carries only the identifier).
//! - `light_device_attkey`: `ldak_{hex(sha3(attestation key))}` and `ldakr_{…}` the same for remotely
//!   provisioned Android attestation keys.
//! - `light_device` also keeps `z:{serial}:{N}` for each certificate serial of a live Android record's chain
//!   (the revocation check of every epoch seeks the list's serials, it never walks the records),
//!   `g:{N}` for a record a multiplicity gate holds in `check_pending` (its ingress rechecks it daily), and
//!   `crl` the last revocation snapshot this genesis verified. `device_write` keeps both indices in step
//!   with the records it writes.

use super::*;
use crate::light_device::record::{DeviceRecord, KeyEntry, KnownKey, Vote};
use crate::light_device::statement::StatementBundle;
use crate::light_device::{DeviceState, Platform};

/// The serials an index row names for a record: a final, live Android record's chain, each in the list's
/// own form (lowercase hex without leading zeros).
fn indexed_serials(r: &DeviceRecord) -> Vec<String> {
    if r.provisional || !r.live() || r.platform != Platform::Android { return Vec::new(); }
    let mut out: Vec<String> = r.serials.iter().filter_map(|s| crate::light_device::crl::normal_serial(s)).collect();
    out.sort();
    out.dedup();
    out
}

/// A record a multiplicity gate holds: its ingress asks the oracle again every day.
fn gate_held(r: &DeviceRecord) -> bool {
    !r.provisional && r.state == DeviceState::CheckPending && r.lease.as_ref().map_or(false, |l| l.gate.is_high())
}

const CF_DEVICE: &str = "light_device";
const CF_KEY: &str = "light_device_key";
const CF_ATTKEY: &str = "light_device_attkey";

/// One atomic write of device-layer rows; `None` deletes.
#[derive(Debug, Default)]
pub struct DeviceWrite {
    pub records: Vec<DeviceRecord>,
    pub keys: Vec<(String, Option<KeyEntry>)>,
    pub attkeys: Vec<(String, Option<KeyEntry>)>,
    pub key_reservations: Vec<(String, Option<KeyEntry>)>,
    pub attkey_reservations: Vec<(String, Option<KeyEntry>)>,
    /// (hex key id, the key it names)
    pub key_ids: Vec<(String, KnownKey)>,
    /// Key ids of keys a rotation retired: an assertion by one names no device any more.
    pub retired_key_ids: Vec<String>,
    pub votes: Vec<(String, u64, Vote)>,
    pub bundles: Vec<(String, Option<StatementBundle>)>,
    /// (hex(sha3(hw_pub)), the key's last counter here)
    pub counters: Vec<(String, Option<u64>)>,
}

impl Storage {
    fn device_get<T: serde::de::DeserializeOwned>(&self, cf: &str, key: &str) -> Option<T> {
        let cf = self.persistent.db.cf_handle(cf)?;
        let raw = self.persistent.db.get_cf(&cf, key.as_bytes()).ok()??;
        serde_json::from_slice(&raw).ok()
    }

    pub fn device_record(&self, node_id: &str) -> Option<DeviceRecord> {
        self.device_get(CF_DEVICE, &format!("r:{}", node_id))
    }

    pub fn device_key_entry(&self, hw_key: &str) -> Option<KeyEntry> {
        self.device_get(CF_KEY, &format!("ldk_{}", hw_key))
    }

    pub fn device_attkey_entry(&self, att_key: &str) -> Option<KeyEntry> {
        self.device_get(CF_ATTKEY, &format!("ldak_{}", att_key))
    }

    pub fn device_key_reservation(&self, hw_key: &str) -> Option<KeyEntry> {
        self.device_get(CF_KEY, &format!("ldkr_{}", hw_key))
    }

    pub fn device_attkey_reservation(&self, att_key: &str) -> Option<KeyEntry> {
        self.device_get(CF_ATTKEY, &format!("ldakr_{}", att_key))
    }

    pub fn device_known_key(&self, key_id_hex: &str) -> Option<KnownKey> {
        self.device_get(CF_KEY, &format!("lki_{}", key_id_hex))
    }

    pub fn device_hw_pub_by_key_id(&self, key_id_hex: &str) -> Option<String> {
        self.device_known_key(key_id_hex).map(|k| k.hw_pub)
    }

    pub fn device_vote(&self, node_id: &str, seq: u64) -> Option<Vote> {
        self.device_get(CF_DEVICE, &format!("v:{}:{}", node_id, seq))
    }

    /// The last counter this genesis took from the device key `hw_key`; 0 when none.
    pub fn device_counter(&self, hw_key: &str) -> u64 {
        self.device_get(CF_DEVICE, &format!("c:{}", hw_key)).unwrap_or(0)
    }

    pub fn device_bundle(&self, node_id: &str) -> Option<StatementBundle> {
        let cf = self.persistent.db.cf_handle(CF_DEVICE)?;
        let raw = self.persistent.db.get_cf(&cf, format!("s:{}", node_id).as_bytes()).ok()??;
        let json = zstd::decode_all(&raw[..]).ok()?;
        serde_json::from_slice(&json).ok()
    }

    /// Apply `w` in one batch.
    pub fn device_write(&self, w: DeviceWrite) -> IntegrationResult<()> {
        let handle = |name: &str| self.persistent.db.cf_handle(name)
            .ok_or_else(|| IntegrationError::StorageError(format!("{} column family not found", name)));
        let (dev, key, att) = (handle(CF_DEVICE)?, handle(CF_KEY)?, handle(CF_ATTKEY)?);
        let mut batch = WriteBatch::default();
        let mut written: std::collections::HashMap<&str, &DeviceRecord> = std::collections::HashMap::new();
        for r in &w.records {
            // The indices follow the record: the rows of the chain it held before go, its own come.
            let before = match written.get(r.node_id.as_str()) {
                Some(prev) => indexed_serials(prev),
                None => self.device_record(&r.node_id).map(|p| indexed_serials(&p)).unwrap_or_default(),
            };
            let after = indexed_serials(r);
            for s in before.iter().filter(|s| !after.contains(s)) {
                batch.delete_cf(&dev, format!("z:{}:{}", s, r.node_id).as_bytes());
            }
            for s in &after {
                batch.put_cf(&dev, format!("z:{}:{}", s, r.node_id).as_bytes(), b"");
            }
            let g = format!("g:{}", r.node_id);
            if gate_held(r) { batch.put_cf(&dev, g.as_bytes(), b""); } else { batch.delete_cf(&dev, g.as_bytes()); }
            batch.put_cf(&dev, format!("r:{}", r.node_id).as_bytes(), json(r)?);
            written.insert(&r.node_id, r);
        }
        for (k, e) in &w.keys {
            let id = format!("ldk_{}", k);
            match e { Some(e) => batch.put_cf(&key, id.as_bytes(), json(e)?), None => batch.delete_cf(&key, id.as_bytes()) }
        }
        for (k, e) in &w.attkeys {
            let id = format!("ldak_{}", k);
            match e { Some(e) => batch.put_cf(&att, id.as_bytes(), json(e)?), None => batch.delete_cf(&att, id.as_bytes()) }
        }
        for (k, e) in &w.key_reservations {
            let id = format!("ldkr_{}", k);
            match e { Some(e) => batch.put_cf(&key, id.as_bytes(), json(e)?), None => batch.delete_cf(&key, id.as_bytes()) }
        }
        for (k, e) in &w.attkey_reservations {
            let id = format!("ldakr_{}", k);
            match e { Some(e) => batch.put_cf(&att, id.as_bytes(), json(e)?), None => batch.delete_cf(&att, id.as_bytes()) }
        }
        for (key_id, known) in &w.key_ids {
            batch.put_cf(&key, format!("lki_{}", key_id).as_bytes(), json(known)?);
        }
        for key_id in &w.retired_key_ids {
            batch.delete_cf(&key, format!("lki_{}", key_id).as_bytes());
        }
        for (node, seq, v) in &w.votes {
            batch.put_cf(&dev, format!("v:{}:{}", node, seq).as_bytes(), json(v)?);
        }
        for (node, b) in &w.bundles {
            let id = format!("s:{}", node);
            match b {
                Some(b) => {
                    let raw = serde_json::to_vec(b).map_err(|e| IntegrationError::StorageError(e.to_string()))?;
                    let packed = zstd::encode_all(&raw[..], 3).map_err(|e| IntegrationError::StorageError(e.to_string()))?;
                    batch.put_cf(&dev, id.as_bytes(), packed);
                }
                None => batch.delete_cf(&dev, id.as_bytes()),
            }
        }
        for (k, c) in &w.counters {
            let id = format!("c:{}", k);
            match c { Some(c) => batch.put_cf(&dev, id.as_bytes(), json(c)?), None => batch.delete_cf(&dev, id.as_bytes()) }
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// The nodes whose record's chain holds the certificate `serial` (the list's form), at most `max`.
    pub fn device_nodes_by_serial(&self, serial: &str, max: usize) -> Vec<String> {
        let prefix = format!("z:{}:", serial);
        self.device_scan_keys(&prefix, max)
    }

    /// Records a multiplicity gate holds in `check_pending`, at most `max`, from the node after `after`.
    pub fn device_gate_held(&self, after: Option<&str>, max: usize) -> Vec<String> {
        let Some(cf) = self.persistent.db.cf_handle(CF_DEVICE) else { return Vec::new(); };
        let start = match after { Some(n) => format!("g:{}\u{0}", n), None => "g:".to_string() };
        let mut out = Vec::new();
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(start.as_bytes(), rocksdb::Direction::Forward)) {
            let Ok((k, _)) = item else { break };
            let Some(node) = k.strip_prefix(b"g:") else { break };
            out.push(String::from_utf8_lossy(node).to_string());
            if out.len() >= max { break; }
        }
        out
    }

    /// Queue what this genesis sent `ip` and it did not take (a statement's bundle, `kind` "b", or a state
    /// change, "c"), keyed by (ip, node, kind): a newer one for the same node replaces the older, which it
    /// supersedes (a newer statement, a higher state sequence). Kept across restarts until `ip` takes it.
    pub fn device_outbox_put(&self, ip: &str, node: &str, kind: &str, body: &serde_json::Value, at: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle(CF_DEVICE)
            .ok_or_else(|| IntegrationError::StorageError(format!("{} column family not found", CF_DEVICE)))?;
        let raw = serde_json::to_vec(&serde_json::json!({ "at": at, "body": body }))
            .map_err(|e| IntegrationError::StorageError(e.to_string()))?;
        self.persistent.db.put_cf(&cf, format!("o:{}:{}:{}", ip, node, kind).as_bytes(), raw)?;
        Ok(())
    }

    /// Drop a queued delivery once taken, only while it is still the one sent (`at`): a newer one queued
    /// meanwhile stays.
    pub fn device_outbox_done(&self, key: &str, at: u64) {
        let Some(cf) = self.persistent.db.cf_handle(CF_DEVICE) else { return };
        let same = self.persistent.db.get_cf(&cf, key.as_bytes()).ok().flatten()
            .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
            .map_or(false, |v| v["at"].as_u64() == Some(at));
        if same {
            let _ = self.persistent.db.delete_cf(&cf, key.as_bytes());
        }
    }

    /// Queued deliveries, at most `max`, in key order (per ip and node, the bundle before its change):
    /// (row key, ip, queued at, body).
    pub fn device_outbox(&self, max: usize) -> Vec<(String, String, u64, serde_json::Value)> {
        let Some(cf) = self.persistent.db.cf_handle(CF_DEVICE) else { return Vec::new(); };
        let mut out = Vec::new();
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(b"o:", rocksdb::Direction::Forward)) {
            let Ok((k, v)) = item else { break };
            if !k.starts_with(b"o:") { break; }
            let key = String::from_utf8_lossy(&k).to_string();
            let ip = key[2..].split(':').next().unwrap_or("").to_string();
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&v) {
                out.push((key, ip, v["at"].as_u64().unwrap_or(0), v["body"].clone()));
            }
            if out.len() >= max { break; }
        }
        out
    }

    /// The node ids of the `{prefix}{node}` rows, in key order.
    fn device_scan_keys(&self, prefix: &str, max: usize) -> Vec<String> {
        let Some(cf) = self.persistent.db.cf_handle(CF_DEVICE) else { return Vec::new(); };
        let mut out = Vec::new();
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward)) {
            let Ok((k, _)) = item else { break };
            let Some(node) = k.strip_prefix(prefix.as_bytes()) else { break };
            out.push(String::from_utf8_lossy(node).to_string());
            if out.len() >= max { break; }
        }
        out
    }

    /// Keep the revocation snapshot this genesis verified last (the oracle's own JSON form).
    pub fn device_put_crl(&self, snapshot: &serde_json::Value) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle(CF_DEVICE)
            .ok_or_else(|| IntegrationError::StorageError(format!("{} column family not found", CF_DEVICE)))?;
        let raw = serde_json::to_vec(snapshot).map_err(|e| IntegrationError::StorageError(e.to_string()))?;
        let packed = zstd::encode_all(&raw[..], 3).map_err(|e| IntegrationError::StorageError(e.to_string()))?;
        self.persistent.db.put_cf(&cf, b"crl", packed)?;
        Ok(())
    }

    pub fn device_crl(&self) -> Option<serde_json::Value> {
        let cf = self.persistent.db.cf_handle(CF_DEVICE)?;
        let raw = self.persistent.db.get_cf(&cf, b"crl").ok()??;
        serde_json::from_slice(&zstd::decode_all(&raw[..]).ok()?).ok()
    }

    /// Votes older than `before` (Unix seconds): they bind nothing after `VOTE_TTL_SECS`, so the sweep that
    /// removes them changes no decision. Bounded per call.
    pub fn device_prune_votes(&self, before: u64, max: usize) -> usize {
        let Some(cf) = self.persistent.db.cf_handle(CF_DEVICE) else { return 0; };
        let mut stale = Vec::new();
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(b"v:", rocksdb::Direction::Forward)) {
            let Ok((k, v)) = item else { break };
            if !k.starts_with(b"v:") { break; }
            if serde_json::from_slice::<Vote>(&v).map_or(true, |x| x.at < before) { stale.push(k.to_vec()); }
            if stale.len() >= max { break; }
        }
        let mut batch = WriteBatch::default();
        for k in &stale { batch.delete_cf(&cf, k); }
        let _ = self.persistent.db.write(batch);
        stale.len()
    }
}

#[cfg(test)]
impl Storage {
    /// SHA3-256 of every row of every column family but `skip`, per family: what a test compares to show a
    /// path writes nothing outside the families it names.
    pub(crate) fn cf_digests_except(&self, skip: &[&str]) -> Vec<(String, [u8; 32])> {
        use sha3::Digest as _;
        super::ALL_CF_NAMES.iter().filter(|n| !skip.contains(n)).map(|name| {
            let mut h = sha3::Sha3_256::new();
            if let Some(cf) = self.persistent.db.cf_handle(name) {
                for (k, v) in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start).flatten() {
                    h.update((k.len() as u64).to_le_bytes());
                    h.update(&k);
                    h.update((v.len() as u64).to_le_bytes());
                    h.update(&v);
                }
            }
            (name.to_string(), h.finalize().into())
        }).collect()
    }
}

fn json<T: serde::Serialize>(v: &T) -> IntegrationResult<Vec<u8>> {
    serde_json::to_vec(v).map_err(|e| IntegrationError::StorageError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::light_device::record::tests::rec;
    use crate::light_device::DeviceState;

    #[test]
    fn device_rows_round_trip_in_one_batch() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let r = rec(3, 10, DeviceState::Active);
        let e = KeyEntry { node_id: r.node_id.clone(), seq: 3, final_: true, at: 5 };
        let v = Vote { hw_key: r.hw_key.clone(), stmt_hash: r.stmt_hash.clone(), at: 7 };
        let b = StatementBundle { statement: "s".into(), lease: None, sigs: vec![("g".into(), "ab".repeat(3309))],
            hw_pub: r.hw_pub.clone(), seq: 3, att_key: None, certs_issued: None, serials: vec![], counter: 0,
            rebind_from: None, ingress: "genesis_node_001".into(), nonce: String::new(), reason: String::new() };
        let mut w = DeviceWrite::default();
        w.records.push(r.clone());
        w.keys.push((r.hw_key.clone(), Some(e.clone())));
        w.attkeys.push(("aa".repeat(32), Some(e.clone())));
        w.key_ids.push((r.key_id.clone(), KnownKey { hw_pub: r.hw_pub.clone(), node_id: r.node_id.clone(), platform: r.platform,
                                                   prov: r.prov, trust: r.trust, rotation_due_epoch: r.rotation_due_epoch }));
        w.votes.push((r.node_id.clone(), 3, v.clone()));
        w.bundles.push((r.node_id.clone(), Some(b.clone())));
        w.counters.push((r.hw_key.clone(), Some(41)));
        s.device_write(w).unwrap();
        assert_eq!(s.device_counter(&r.hw_key), 41);
        assert_eq!(s.device_counter("ff"), 0, "no row: 0");
        assert_eq!(s.device_record(&r.node_id), Some(r.clone()));
        assert_eq!(s.device_key_entry(&r.hw_key), Some(e.clone()));
        assert_eq!(s.device_attkey_entry(&"aa".repeat(32)), Some(e.clone()));
        assert_eq!(s.device_hw_pub_by_key_id(&r.key_id), Some(r.hw_pub.clone()));
        assert_eq!(s.device_vote(&r.node_id, 3), Some(v));
        assert_eq!(s.device_bundle(&r.node_id), Some(b));
        let mut del = DeviceWrite::default();
        del.keys.push((r.hw_key.clone(), None));
        del.bundles.push((r.node_id.clone(), None));
        del.counters.push((r.hw_key.clone(), None));
        s.device_write(del).unwrap();
        assert!(s.device_key_entry(&r.hw_key).is_none() && s.device_bundle(&r.node_id).is_none());
        assert_eq!(s.device_counter(&r.hw_key), 0);
        assert_eq!(s.device_prune_votes(8, 100), 1);
        assert!(s.device_vote(&r.node_id, 3).is_none());
    }

    #[test]
    fn the_serial_and_gate_indices_follow_the_records() {
        use crate::light_device::record::LeaseSummary;
        use crate::light_device::{Effective, Gate, LeaseKind};
        let dir = tempfile::TempDir::new().unwrap();
        let s = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let write = |r: &DeviceRecord| { let mut w = DeviceWrite::default(); w.records.push(r.clone()); s.device_write(w).unwrap(); };
        let mut r = rec(3, 10, DeviceState::Active);
        r.platform = Platform::Android;
        r.serials = vec!["00C0FFEE".into(), "1a2b".into()];
        write(&r);
        assert_eq!(s.device_nodes_by_serial("c0ffee", 10), vec![r.node_id.clone()], "the list's form");
        assert_eq!(s.device_nodes_by_serial("1a2b", 10), vec![r.node_id.clone()]);
        // A rotation's new chain: the old serial's row goes, the new one's comes.
        r.serials = vec!["1a2b".into(), "7".into()];
        write(&r);
        assert!(s.device_nodes_by_serial("c0ffee", 10).is_empty());
        assert_eq!(s.device_nodes_by_serial("7", 10), vec![r.node_id.clone()]);
        // An ended record holds no chain any more.
        r.state = DeviceState::Ended;
        write(&r);
        assert!(s.device_nodes_by_serial("7", 10).is_empty() && s.device_nodes_by_serial("1a2b", 10).is_empty());
        // iOS and provisional records are never indexed.
        let mut ios = rec(4, 10, DeviceState::Active);
        ios.node_id = "light_mobile_dacc1355d21394a2".into();
        ios.serials = vec!["abc".into()];
        write(&ios);
        assert!(s.device_nodes_by_serial("abc", 10).is_empty());
        // A gate over its bound holds the record in check_pending: listed until the record moves on.
        let mut held = rec(5, 10, DeviceState::CheckPending);
        held.lease = Some(LeaseSummary { kind: LeaseKind::ClaimedVirgin, effective: Effective::Now, gate: Gate::MetricHigh,
                                         issued_at: 1, pi_digest: String::new() });
        write(&held);
        assert_eq!(s.device_gate_held(None, 10), vec![held.node_id.clone()]);
        assert!(s.device_gate_held(Some(&held.node_id), 10).is_empty(), "the page after it");
        held.state = DeviceState::Active;
        write(&held);
        assert!(s.device_gate_held(None, 10).is_empty());
        // The snapshot row round-trips.
        let snap = serde_json::json!({"fetched_at": 1, "serials": ["7"]});
        s.device_put_crl(&snap).unwrap();
        assert_eq!(s.device_crl(), Some(snap));
    }
}
