//! The Android attestation certificate status list: serials Google marks REVOKED or SUSPENDED.
//!
//! The oracle fetches Google's list and signs its canonical text (spec section 6.4); every genesis
//! checks the stored chain serials against it each epoch.

use crate::Refusal;
use std::collections::BTreeSet;

const M: Refusal = Refusal::Malformed("status list");

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RevocationList {
    serials: BTreeSet<String>,
}

/// Lowercase hex without leading zeros; `None` for anything else.
fn normalize(serial: &str) -> Option<String> {
    let s = serial.trim();
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    let trimmed = lower.trim_start_matches('0');
    Some(if trimmed.is_empty() { "0".to_string() } else { trimmed.to_string() })
}

impl RevocationList {
    pub fn from_serials<'a>(serials: impl IntoIterator<Item = &'a str>) -> Result<Self, Refusal> {
        let mut out = BTreeSet::new();
        for s in serials {
            out.insert(normalize(s).ok_or(M)?);
        }
        Ok(RevocationList { serials: out })
    }

    /// Google's status JSON: `{"entries": {"<serial hex>": {"status": "REVOKED" | "SUSPENDED", ...}}}`.
    pub fn from_status_json(json: &[u8]) -> Result<Self, Refusal> {
        let v: serde_json::Value = serde_json::from_slice(json).map_err(|_| M)?;
        let entries = v.get("entries").and_then(|e| e.as_object()).ok_or(M)?;
        let mut out = BTreeSet::new();
        for (serial, entry) in entries {
            let status = entry.get("status").and_then(|s| s.as_str()).ok_or(M)?;
            if status.eq_ignore_ascii_case("REVOKED") || status.eq_ignore_ascii_case("SUSPENDED") {
                out.insert(normalize(serial).ok_or(M)?);
            }
        }
        Ok(RevocationList { serials: out })
    }

    /// The canonical list text of the signed snapshot: sorted serials joined by `\n`.
    pub fn from_canonical_text(text: &str) -> Result<Self, Refusal> {
        if text.is_empty() {
            return Ok(RevocationList::default());
        }
        let list = RevocationList::from_serials(text.split('\n'))?;
        if list.canonical_text() != text {
            return Err(M);
        }
        Ok(list)
    }

    pub fn canonical_text(&self) -> String {
        self.serials.iter().map(String::as_str).collect::<Vec<_>>().join("\n")
    }

    pub fn contains(&self, serial_hex: &str) -> bool {
        normalize(serial_hex).is_some_and(|s| self.serials.contains(&s))
    }

    pub fn len(&self) -> usize {
        self.serials.len()
    }

    pub fn is_empty(&self) -> bool {
        self.serials.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_json_keeps_revoked_and_suspended() {
        let json = br#"{"entries": {
            "2C8CDDDFD5E03BFC": {"status": "REVOKED", "reason": "KEY_COMPROMISE"},
            "00c8966fcb2fbb0d7a": {"status": "SUSPENDED", "reason": "SOFTWARE_FLAW"},
            "abc": {"status": "OK"}
        }}"#;
        let list = RevocationList::from_status_json(json).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.contains("2c8cdddfd5e03bfc"));
        assert!(list.contains("c8966fcb2fbb0d7a"));
        assert!(!list.contains("abc"));
        assert_eq!(list.canonical_text(), "2c8cdddfd5e03bfc\nc8966fcb2fbb0d7a");
        assert_eq!(RevocationList::from_canonical_text(&list.canonical_text()).unwrap(), list);
    }

    #[test]
    fn refuses_malformed_lists() {
        assert!(RevocationList::from_status_json(b"{}").is_err());
        assert!(RevocationList::from_status_json(br#"{"entries": {"xyz": {"status": "REVOKED"}}}"#).is_err());
        assert!(RevocationList::from_status_json(br#"{"entries": {"ab": {}}}"#).is_err());
        assert!(RevocationList::from_canonical_text("b\na").is_err()); // not sorted
        assert!(RevocationList::from_canonical_text("0a").is_err()); // leading zero
        assert!(RevocationList::from_canonical_text("a\n").is_err()); // trailing newline
        assert!(RevocationList::from_canonical_text("").unwrap().is_empty());
    }
}
