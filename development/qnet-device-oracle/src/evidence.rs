//! Raw evidence, sealed at rest (AES-256-GCM, key file on the host): 7 days for accepted cases, 90 days
//! for refused, suspect and paused ones, so a person can answer an appeal. Tokens are never stored.

use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::lease::DAY;
use crate::store::{Batch, Cf, Store};

pub const ACCEPTED_KEEP: u64 = 7 * DAY;
pub const REVIEW_KEEP: u64 = 90 * DAY;

pub struct Sealer {
    key: LessSafeKey,
}

impl Sealer {
    pub fn from_bytes(raw: &[u8]) -> Result<Self, String> {
        // The key file holds 32 raw bytes or their 64-character hex form.
        let key = if raw.len() == 32 {
            raw.to_vec()
        } else {
            let t = String::from_utf8_lossy(raw);
            let h = hex::decode(t.trim()).map_err(|_| "evidence key must be 32 bytes or 64 hex characters")?;
            if h.len() != 32 {
                return Err("evidence key must be 32 bytes".into());
            }
            h
        };
        let unbound = UnboundKey::new(&AES_256_GCM, &key).map_err(|_| "evidence key rejected")?;
        Ok(Sealer { key: LessSafeKey::new(unbound) })
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
        Self::from_bytes(&raw)
    }

    /// `nonce ‖ ciphertext ‖ tag`; `aad` binds the blob to its database key.
    pub fn seal(&self, aad: &[u8], plain: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; 12];
        aws_lc_rs::rand::fill(&mut nonce).expect("system randomness");
        let mut buf = plain.to_vec();
        self.key
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut buf)
            .expect("seal");
        let mut out = nonce.to_vec();
        out.extend(buf);
        out
    }

    pub fn open(&self, aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() < 12 + 16 {
            return None;
        }
        let nonce = Nonce::try_assume_unique_for_key(&sealed[..12]).ok()?;
        let mut buf = sealed[12..].to_vec();
        self.key.open_in_place(nonce, Aad::from(aad), &mut buf).ok().map(|p| p.to_vec())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvClass {
    Accepted,
    Refused,
    Suspect,
    Paused,
}

impl EvClass {
    pub fn keep(self) -> u64 {
        match self {
            EvClass::Accepted => ACCEPTED_KEEP,
            _ => REVIEW_KEEP,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvRecord {
    pub class: EvClass,
    pub created_at: u64,
    pub expires_at: u64,
    pub reference: Option<String>,
    pub sealed: Vec<u8>,
}

/// `node ‖ 0x00 ‖ created (big-endian) ‖ 4 random bytes`: one node's records sort together by time.
pub fn ev_key(node: &str, created: u64) -> Vec<u8> {
    let mut r = [0u8; 4];
    aws_lc_rs::rand::fill(&mut r).expect("system randomness");
    let mut k = node.as_bytes().to_vec();
    k.push(0);
    k.extend_from_slice(&created.to_be_bytes());
    k.extend_from_slice(&r);
    k
}

fn exp_key(expires: u64, key: &[u8]) -> Vec<u8> {
    let mut k = expires.to_be_bytes().to_vec();
    k.extend_from_slice(key);
    k
}

/// Adds a sealed record to `b`; returns its key.
pub fn add(
    b: &mut Batch,
    sealer: &Sealer,
    node: &str,
    class: EvClass,
    reference: Option<String>,
    body: &serde_json::Value,
    now: u64,
) -> Vec<u8> {
    let key = ev_key(node, now);
    let rec = EvRecord {
        class,
        created_at: now,
        expires_at: now + class.keep(),
        reference,
        sealed: sealer.seal(&key, body.to_string().as_bytes()),
    };
    b.put_raw(Cf::EvExp, exp_key(rec.expires_at, &key), vec![]);
    b.put(Cf::Ev, &key, &rec);
    key
}

/// A node became suspect or paused: its records of the last 7 days are kept 90 days for the appeal.
pub fn extend_for_review(store: &Store, b: &mut Batch, node: &str, now: u64) -> Result<(), String> {
    let mut prefix = node.as_bytes().to_vec();
    prefix.push(0);
    for (k, v) in store.scan(Cf::Ev, &prefix, None, 1_000)? {
        let mut rec = bincode::deserialize::<EvRecord>(&v).map_err(|e| format!("decode ev: {}", e))?;
        let target = rec.created_at + REVIEW_KEEP;
        if rec.created_at + ACCEPTED_KEEP < now || rec.expires_at >= target {
            continue;
        }
        b.del(Cf::EvExp, exp_key(rec.expires_at, &k));
        rec.expires_at = target;
        b.put_raw(Cf::EvExp, exp_key(rec.expires_at, &k), vec![]);
        b.put(Cf::Ev, &k, &rec);
    }
    Ok(())
}

/// A sealed record and its body; `Ok(None)` when it is gone (purged). One that does not open is an error.
pub fn open(store: &Store, sealer: &Sealer, key: &[u8]) -> Result<Option<(EvRecord, serde_json::Value)>, String> {
    let Some(rec) = store.get::<EvRecord>(Cf::Ev, key)? else { return Ok(None) };
    let plain = sealer.open(key, &rec.sealed).ok_or("ev: the seal does not open")?;
    let body = serde_json::from_slice(&plain).map_err(|e| format!("ev body: {}", e))?;
    Ok(Some((rec, body)))
}

/// Records one purge call deletes at most.
pub const PURGE_PAGE: usize = 5_000;

/// Deletes up to one page of expired records; returns how many.
pub fn purge(store: &Store, now: u64) -> Result<usize, String> {
    let keys = store.keys_below(Cf::EvExp, &(now + 1).to_be_bytes(), PURGE_PAGE)?;
    if keys.is_empty() {
        return Ok(0);
    }
    let mut b = Batch::default();
    for k in &keys {
        b.del(Cf::EvExp, k);
        b.del(Cf::Ev, &k[8..]);
    }
    store.commit(b, now)?;
    Ok(keys.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sealer() -> Sealer {
        Sealer::from_bytes(&[7u8; 32]).unwrap()
    }

    #[test]
    fn seal_is_bound_to_its_key() {
        let s = sealer();
        let blob = s.seal(b"k1", b"secret");
        assert_eq!(s.open(b"k1", &blob).unwrap(), b"secret");
        assert!(s.open(b"k2", &blob).is_none());
        assert!(Sealer::from_bytes(&hex::encode([7u8; 32]).into_bytes()).is_ok());
        assert!(Sealer::from_bytes(b"short").is_err());
    }

    #[test]
    fn retention_is_7_days_for_accepted_and_90_after_a_review_extension() {
        let d = tempfile::tempdir().unwrap();
        let store = Store::open(d.path()).unwrap();
        let s = sealer();
        let t0 = 1_790_000_000;
        let mut b = Batch::default();
        let k = add(&mut b, &s, "light_mobile_0000000000000001", EvClass::Accepted, None, &serde_json::json!({"a": 1}), t0);
        let k2 = add(&mut b, &s, "light_mobile_0000000000000002", EvClass::Accepted, None, &serde_json::json!({"b": 2}), t0);
        store.commit(b, t0).unwrap();
        let (rec, body) = open(&store, &s, &k).unwrap().unwrap();
        assert_eq!(rec.expires_at, t0 + 7 * DAY);
        assert_eq!(body["a"], 1);

        let mut b = Batch::default();
        extend_for_review(&store, &mut b, "light_mobile_0000000000000001", t0 + DAY).unwrap();
        store.commit(b, t0 + DAY).unwrap();
        assert_eq!(open(&store, &s, &k).unwrap().unwrap().0.expires_at, t0 + 90 * DAY);

        assert_eq!(purge(&store, t0 + 8 * DAY).unwrap(), 1);
        assert!(open(&store, &s, &k2).unwrap().is_none());
        assert!(open(&store, &s, &k).unwrap().is_some());
        assert_eq!(purge(&store, t0 + 91 * DAY).unwrap(), 1);
        assert!(open(&store, &s, &k).unwrap().is_none());
    }
}
