//! Device challenges (A1, spec section 5.2): 32 random bytes and a stateless stamp, the issuer's MAC over
//! (issuer, node, purpose, nonce, expiry). Only the issuer can check it; another genesis answers a stamp it
//! did not issue with `device_stale`, and the app then asks for a new challenge. A process-wide random
//! secret: a restart ends the stamps in flight, which costs at most one such retry.

use hmac::{Hmac, Mac};
use sha3::Sha3_256;

use super::{messages, Purpose, CHALLENGE_TTL_SECS, CLOCK_SKEW_SECS};

type HmacSha3 = Hmac<Sha3_256>;

fn stamp_secret() -> &'static [u8; 32] {
    static S: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        use rand::RngCore;
        let mut k = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut k);
        k
    })
}

fn mac(issuer: &str, node: &str, purpose: Purpose, nonce: &str, exp: u64) -> HmacSha3 {
    let mut m = <HmacSha3 as Mac>::new_from_slice(stamp_secret()).expect("any key length");
    m.update(format!("qnet_dev_stamp:v1|{}|{}|{}|{}|{}", issuer, node, purpose.as_str(), nonce, exp).as_bytes());
    m
}

/// What `GET /light-node/device-challenge` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    /// b64url of 32 random bytes.
    pub nonce: String,
    pub stamp: String,
    pub exp: u64,
    pub issuer: String,
}

impl Challenge {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "nonce": self.nonce, "stamp": self.stamp, "exp": self.exp, "issuer": self.issuer })
    }
}

/// A fresh challenge for a device message of `purpose` for `node`, valid `CHALLENGE_TTL_SECS` here.
pub fn issue(issuer: &str, node: &str, purpose: Purpose, now: u64) -> Challenge {
    use rand::RngCore;
    let mut n = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut n);
    let nonce = messages::b64url(&n);
    let exp = now + CHALLENGE_TTL_SECS;
    let tag = mac(issuer, node, purpose, &nonce, exp).finalize().into_bytes();
    Challenge { stamp: format!("v1.{}.{}", exp, hex::encode(&tag[..16])), nonce, exp, issuer: issuer.to_string() }
}

/// The stamp was issued here, for this node, purpose and nonce, and has not expired.
pub fn verify(issuer: &str, node: &str, purpose: Purpose, nonce: &str, stamp: &str, now: u64) -> bool {
    if stamp.len() > 64 { return false; }
    let mut parts = stamp.split('.');
    let (Some("v1"), Some(exp), Some(tag), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if !messages::is_decimal(exp) || tag.len() != 32 { return false; }
    let Ok(exp) = exp.parse::<u64>() else { return false; };
    // Expired, or later than any stamp this issuer writes (a forged far expiry).
    if exp < now || exp > now + CHALLENGE_TTL_SECS + CLOCK_SKEW_SECS { return false; }
    let Ok(tag) = hex::decode(tag) else { return false; };
    mac(issuer, node, purpose, nonce, exp).verify_truncated_left(&tag).is_ok()
}

/// The answers given to device messages, by (node, nonce), for as long as their challenge lives: a replay
/// of a message (the app's retry after a lost answer, or anyone who saw it) gets the first answer again and
/// costs no vendor call and no attestor round.
pub struct Answers {
    map: std::sync::OnceLock<dashmap::DashMap<String, (u64, serde_json::Value)>>,
    cap: usize,
}

impl Answers {
    pub const fn new(cap: usize) -> Self {
        Answers { map: std::sync::OnceLock::new(), cap }
    }

    fn map(&self) -> &dashmap::DashMap<String, (u64, serde_json::Value)> {
        self.map.get_or_init(dashmap::DashMap::new)
    }

    pub fn get(&self, node: &str, nonce: &str, now: u64) -> Option<serde_json::Value> {
        let key = format!("{}|{}", node, nonce);
        let hit = self.map().get(&key).map(|e| e.value().clone());
        match hit {
            Some((exp, v)) if exp >= now => Some(v),
            Some(_) => { self.map().remove(&key); None }
            None => None,
        }
    }

    pub fn put(&self, node: &str, nonce: &str, answer: serde_json::Value, now: u64) {
        let m = self.map();
        if m.len() >= self.cap {
            m.retain(|_, (exp, _)| *exp >= now);
            if m.len() >= self.cap { return; }
        }
        m.insert(format!("{}|{}", node, nonce), (now + CHALLENGE_TTL_SECS + CLOCK_SKEW_SECS, answer));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_holds_only_at_its_issuer_for_its_node_purpose_and_nonce_until_it_expires() {
        let now = 1_800_000_000;
        let c = issue("genesis_node_001", "light_mobile_6526ab8fd00ff8ca", Purpose::Enrol, now);
        assert_eq!(messages::nonce32(&c.nonce).map(|n| n.len()), Some(32));
        assert_eq!(c.exp, now + CHALLENGE_TTL_SECS);
        assert!(c.stamp.len() <= 512 && !c.stamp.is_empty(), "the app takes 1..512 characters");
        let ok = |issuer: &str, node: &str, p: Purpose, nonce: &str, stamp: &str, t: u64| verify(issuer, node, p, nonce, stamp, t);
        assert!(ok("genesis_node_001", "light_mobile_6526ab8fd00ff8ca", Purpose::Enrol, &c.nonce, &c.stamp, now));
        assert!(ok("genesis_node_001", "light_mobile_6526ab8fd00ff8ca", Purpose::Enrol, &c.nonce, &c.stamp, c.exp),
                "valid through its last second");
        assert!(!ok("genesis_node_001", "light_mobile_6526ab8fd00ff8ca", Purpose::Enrol, &c.nonce, &c.stamp, c.exp + 1),
                "the TTL is ten minutes");
        assert!(!ok("genesis_node_002", "light_mobile_6526ab8fd00ff8ca", Purpose::Enrol, &c.nonce, &c.stamp, now),
                "another issuer");
        assert!(!ok("genesis_node_001", "light_mobile_dacc1355d21394a2", Purpose::Enrol, &c.nonce, &c.stamp, now),
                "another node");
        assert!(!ok("genesis_node_001", "light_mobile_6526ab8fd00ff8ca", Purpose::Rotate, &c.nonce, &c.stamp, now),
                "another purpose");
        let other = issue("genesis_node_001", "light_mobile_6526ab8fd00ff8ca", Purpose::Enrol, now);
        assert!(!ok("genesis_node_001", "light_mobile_6526ab8fd00ff8ca", Purpose::Enrol, &other.nonce, &c.stamp, now),
                "another nonce");
        // A forged expiry changes the MAC; a far one is refused before it.
        let parts: Vec<&str> = c.stamp.split('.').collect();
        let forged = format!("v1.{}.{}", c.exp + 3600, parts[2]);
        assert!(!ok("genesis_node_001", "light_mobile_6526ab8fd00ff8ca", Purpose::Enrol, &c.nonce, &forged, now));
        for junk in ["", "v1", "v1.1.2", "v2.1800000600.00", &format!("{}.x", c.stamp)] {
            assert!(!ok("genesis_node_001", "light_mobile_6526ab8fd00ff8ca", Purpose::Enrol, &c.nonce, junk, now), "{junk}");
        }
    }

    #[test]
    fn a_replayed_message_gets_its_first_answer_while_its_challenge_lives() {
        let a = Answers::new(2);
        let now = 1_800_000_000;
        a.put("n1", "x", serde_json::json!({"success": true}), now);
        assert_eq!(a.get("n1", "x", now + 10), Some(serde_json::json!({"success": true})));
        assert_eq!(a.get("n1", "y", now), None);
        assert_eq!(a.get("n1", "x", now + CHALLENGE_TTL_SECS + CLOCK_SKEW_SECS + 1), None, "gone with its challenge");
        a.put("n2", "x", serde_json::json!(1), now);
        a.put("n3", "x", serde_json::json!(2), now);
        a.put("n4", "x", serde_json::json!(3), now);
        assert!(a.map().len() <= 2, "bounded");
    }
}
