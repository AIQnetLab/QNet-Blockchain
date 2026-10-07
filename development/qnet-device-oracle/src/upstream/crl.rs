//! The Android attestation revocation list, fetched per its cache lifetime and served as one snapshot
//! signed by the oracle, so all five genesis nodes pause the same revoked keys (section 6.4). Parsing and
//! the canonical list text belong to `qnet-device-attest`, which the genesis nodes check it with.

use qnet_device_attest::revocation::RevocationList;
use serde::Serialize;

use super::{classify_status, HttpClient, HttpRequest, Method, VendorError};
use crate::lease::{DAY, HOUR};
use crate::messages::{crl_preimage, sha3_256};
use crate::signer::Signer;

/// Refetch interval from `Cache-Control: max-age`, between one hour and one day.
pub fn refetch_after(cache_control: Option<&str>) -> u64 {
    let age = cache_control
        .and_then(|c| c.split(',').find_map(|d| d.trim().strip_prefix("max-age=")?.trim().parse::<u64>().ok()))
        .unwrap_or(DAY);
    age.clamp(HOUR, DAY)
}

pub fn fetch(http: &dyn HttpClient, url: &str) -> Result<(RevocationList, u64), VendorError> {
    let req = HttpRequest { method: Method::Get, url: url.to_string(), headers: vec![], body: vec![] };
    let resp = http.send(&req).map_err(|e| VendorError::Unavailable(format!("crl {}", e)))?;
    if resp.status != 200 {
        return Err(match classify_status(resp.status, "crl") {
            VendorError::Rejected(m) => VendorError::Unavailable(m),
            other => other,
        });
    }
    let list = RevocationList::from_status_json(&resp.body)
        .map_err(|e| VendorError::Unavailable(format!("crl list: {}", e)))?;
    Ok((list, refetch_after(resp.header("cache-control"))))
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub fetched_at: u64,
    pub serials: Vec<String>,
    pub list_sha3: String,
    pub preimage: String,
    pub sig: String,
}

pub fn snapshot(list: &RevocationList, fetched_at: u64, signer: &Signer) -> Snapshot {
    let text = list.canonical_text();
    let preimage = crl_preimage(fetched_at, &text);
    let sig = hex::encode(signer.sign(preimage.as_bytes()));
    let serials = if text.is_empty() { vec![] } else { text.split('\n').map(str::to_string).collect() };
    Snapshot { fetched_at, serials, list_sha3: hex::encode(sha3_256(text.as_bytes())), preimage, sig }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream::fake::FakeHttp;

    #[test]
    fn snapshot_matches_the_protocol_vector() {
        let signer = Signer::generate();
        let list = RevocationList::from_serials(["c0ffee", "1a2b", "7"]).unwrap();
        let s = snapshot(&list, 1_790_000_000, &signer);
        assert_eq!(s.serials, vec!["1a2b", "7", "c0ffee"]);
        assert_eq!(s.list_sha3, "7c9a5b54a1153a13532c0c92a5492136246e90c1ed274f7511de411ca2896ae3");
        assert_eq!(s.preimage, "qnet_crl:v1|1790000000|7c9a5b54a1153a13532c0c92a5492136246e90c1ed274f7511de411ca2896ae3");
        assert!(crate::signer::verify(signer.public_key(), s.preimage.as_bytes(), &hex::decode(&s.sig).unwrap()));
    }

    #[test]
    fn refetch_follows_cache_control_within_bounds() {
        assert_eq!(refetch_after(Some("public, max-age=7200")), 7200);
        assert_eq!(refetch_after(Some("max-age=60")), HOUR);
        assert_eq!(refetch_after(Some("max-age=999999")), DAY);
        assert_eq!(refetch_after(None), DAY);
    }

    #[test]
    fn fetch_classifies_failures_as_unavailable() {
        let http = FakeHttp::default();
        http.push("status", 404, b"");
        http.push("status", 200, b"not json");
        assert!(matches!(fetch(&http, "https://x/status"), Err(VendorError::Unavailable(_))));
        assert!(matches!(fetch(&http, "https://x/status"), Err(VendorError::Unavailable(_))));
    }
}
