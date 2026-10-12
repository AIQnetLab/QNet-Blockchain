//! `GET /api/v1/galc/capsule`: the GALC v2 wallet capsule (docs/protocols/galc-capsule-v2.md, section 6).
//! Served only while it binds to this node's own chain: macroblocks K and K-1 decode here to the
//! checkpoints it names, and K is at most the finalized macroblock. Typed refusals; the body is cached by
//! (K, cpA) under its ETag.

use super::*;
use warp::http::{header, HeaderValue, StatusCode};

pub(crate) const GALC_CAPSULE_BUCKET: &str = "galc_capsule";
pub(crate) const WALLET_GALC_CAPSULE_BUCKET: &str = "wallet_galc_capsule";
const CACHE_CAPSULE: &str = "public, max-age=60";
/// How long a capsule's binding is taken as read before macroblocks K and K-1 are read again.
const REBIND_SECS: u64 = 60;

/// The body served for one (K, cpA) and the last reading of its binding.
pub(crate) struct Served {
    k: u64,
    cp_a: [u8; 32],
    body: bytes::Bytes,
    etag: String,
    checked_at: u64,
    bound: bool,
}

static SERVED: Lazy<parking_lot::Mutex<Option<Served>>> = Lazy::new(|| parking_lot::Mutex::new(None));

pub(super) async fn handle_galc_capsule(
    if_none_match: Option<String>,
    remote_addr: Option<std::net::SocketAddr>,
    plane: Option<WalletPlane>,
    blockchain: Arc<BlockchainNode>,
) -> Result<warp::reply::Response, Rejection> {
    if let Err(r) = route_limit(remote_addr, plane, GALC_CAPSULE_BUCKET, WALLET_GALC_CAPSULE_BUCKET, true) {
        return Ok(r);
    }
    let storage = blockchain.get_storage();
    let finalized_mb = crate::node::LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst)
        / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    let now = wallet_plane::mono_ms() / 1000;
    Ok(capsule_reply(crate::galc::held_v2(), &storage, finalized_mb, if_none_match.as_deref(), &SERVED, now))
}

/// Whether this node's certified checkpoints of K and K-1 are the ones the capsule names.
fn binds(storage: &crate::storage::Storage, c: &crate::galc::GenesisCheckpointV2) -> bool {
    crate::galc::own_checkpoint_hash(storage, c.mb_index) == Some(c.cp_hash_anchor)
        && crate::galc::own_checkpoint_hash(storage, c.mb_index.saturating_sub(1)) == Some(c.cp_hash_pred)
}

/// An If-None-Match list that names `etag` (weak or strong) or any.
fn etag_matches(if_none_match: &str, etag: &str) -> bool {
    if_none_match.split(',').map(str::trim).any(|t| t == "*" || t.trim_start_matches("W/") == etag)
}

/// The answer for the held capsule: 404 `no_capsule` without one, 503 `capsule_unbound` while it does not
/// bind here, 304 for a matching If-None-Match, else 200 with the compact HTTP body.
pub(crate) fn capsule_reply(
    held: Option<crate::galc::GenesisCheckpointV2>,
    storage: &crate::storage::Storage,
    finalized_mb: u64,
    if_none_match: Option<&str>,
    served: &parking_lot::Mutex<Option<Served>>,
    now_secs: u64,
) -> warp::reply::Response {
    let c = match held {
        Some(c) => c,
        None => return error_response(StatusCode::NOT_FOUND, "no_capsule", serde_json::Map::new(), None),
    };
    let mut g = served.lock();
    let same = g.as_ref().map_or(false, |s| s.k == c.mb_index && s.cp_a == c.cp_hash_anchor);
    if !same || g.as_ref().map_or(true, |s| now_secs.saturating_sub(s.checked_at) >= REBIND_SECS) {
        let body = match g.as_ref() {
            Some(s) if same => s.body.clone(),
            _ => bytes::Bytes::from(c.to_json(true).to_string()),
        };
        *g = Some(Served { k: c.mb_index, cp_a: c.cp_hash_anchor, body, etag: c.etag(), checked_at: now_secs, bound: binds(storage, &c) });
    }
    let s = match g.as_ref() {
        Some(s) if s.bound && c.mb_index <= finalized_mb => s,
        _ => return error_response(StatusCode::SERVICE_UNAVAILABLE, "capsule_unbound",
                                   fields(&[("mb_index", json!(c.mb_index))]), Some(REBIND_SECS)),
    };
    let not_modified = if_none_match.map_or(false, |v| etag_matches(v, &s.etag));
    let mut r = warp::reply::Response::new(if not_modified { warp::hyper::Body::empty() } else { warp::hyper::Body::from(s.body.clone()) });
    if not_modified { *r.status_mut() = StatusCode::NOT_MODIFIED; }
    let h = r.headers_mut();
    if !not_modified { h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json")); }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(CACHE_CAPSULE));
    if let Ok(v) = HeaderValue::from_str(&s.etag) { h.insert(header::ETAG, v); }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::galc::test_support::{seal_pair, temp_storage};

    const K: u64 = 38_960;

    fn capsule(cp_a: [u8; 32], cp_p: [u8; 32]) -> crate::galc::GenesisCheckpointV2 {
        crate::galc::GenesisCheckpointV2 {
            version: 2, network_id: [9u8; 32], mb_index: K, mb_hash: [5u8; 32], committee_digest_anchor: [6u8; 32],
            committee_digest_pred: [7u8; 32], minted_at_height: K * 90, cp_hash_anchor: cp_a, cp_hash_pred: cp_p,
            sigs: (1..=4).map(|i| (format!("genesis_node_00{}", i), format!("dilithium_sig_genesis_node_00{}_AAAA", i))).collect(),
        }
    }

    async fn parts(r: warp::reply::Response) -> (StatusCode, warp::http::HeaderMap, Vec<u8>) {
        let (status, headers) = (r.status(), r.headers().clone());
        (status, headers, warp::hyper::body::to_bytes(r.into_body()).await.unwrap().to_vec())
    }

    fn served() -> parking_lot::Mutex<Option<Served>> { parking_lot::Mutex::new(None) }

    /// 404 before a capsule exists; 200 with the capsule's JSON, its ETag and a 60 s cache; the same ETag
    /// on every read; 304 for it.
    #[tokio::test]
    async fn galc_capsule_route_serves_the_bound_capsule() {
        let (st, _d) = temp_storage();
        let cache = served();
        let (s, h, b) = parts(capsule_reply(None, &st, K, None, &cache, 0)).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let v: Value = serde_json::from_slice(&b).unwrap();
        assert_eq!(v["error"], json!("no_capsule"));
        assert_eq!(h.get(header::CACHE_CONTROL).unwrap(), "no-store");

        let (pred, anchor) = seal_pair(&st, K).await;
        let c = capsule(anchor.hash(), pred.hash());
        let (s, h, b) = parts(capsule_reply(Some(c.clone()), &st, K, None, &cache, 0)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(h.get(header::CACHE_CONTROL).unwrap(), "public, max-age=60");
        assert_eq!(h.get(header::CONTENT_TYPE).unwrap(), "application/json");
        let etag = h.get(header::ETAG).unwrap().to_str().unwrap().to_string();
        assert_eq!(etag, format!("\"2-{}-{}\"", K, &hex::encode(anchor.hash())[..8]));
        let v: Value = serde_json::from_slice(&b).unwrap();
        assert_eq!(v, c.to_json(true));
        for k in ["version", "network_id", "mb_index", "mb_hash", "committee_digest_anchor", "committee_digest_pred",
                  "minted_at_height", "cp_hash_anchor", "cp_hash_pred", "sigs"] {
            assert!(v.get(k).is_some(), "{}", k);
        }
        assert_eq!(v["sigs"].as_array().unwrap().len(), 4);
        assert!(b.len() <= 64 * 1024, "within the clients' body cap");

        let (_, h2, b2) = parts(capsule_reply(Some(c.clone()), &st, K + 5, None, &cache, 61)).await;
        assert_eq!(h2.get(header::ETAG).unwrap().to_str().unwrap(), etag, "stable ETag");
        assert_eq!(b2, b, "the same bytes");
        let (s, h, b) = parts(capsule_reply(Some(c.clone()), &st, K, Some(&etag), &cache, 62)).await;
        assert_eq!(s, StatusCode::NOT_MODIFIED);
        assert!(b.is_empty());
        assert_eq!(h.get(header::ETAG).unwrap().to_str().unwrap(), etag);
        assert_eq!(parts(capsule_reply(Some(c), &st, K, Some("\"2-1-00000000\""), &cache, 62)).await.0, StatusCode::OK);
    }

    /// 503 `capsule_unbound`: K above the finalized macroblock, a capsule naming other checkpoints, and a
    /// rollback that took K away (seen at the next binding read).
    #[tokio::test]
    async fn galc_capsule_route_refuses_an_unbound_capsule() {
        let (st, _d) = temp_storage();
        let (pred, anchor) = seal_pair(&st, K).await;
        let c = capsule(anchor.hash(), pred.hash());
        let cache = served();
        let (s, h, b) = parts(capsule_reply(Some(c.clone()), &st, K - 1, None, &cache, 0)).await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE, "K above the finalized macroblock");
        assert_eq!(serde_json::from_slice::<Value>(&b).unwrap()["error"], json!("capsule_unbound"));
        assert_eq!(h.get(header::RETRY_AFTER).unwrap(), "60");

        let other = capsule([0xAA; 32], pred.hash());
        assert_eq!(parts(capsule_reply(Some(other), &st, K, None, &served(), 0)).await.0, StatusCode::SERVICE_UNAVAILABLE);
        let other_pred = capsule(anchor.hash(), [0xAA; 32]);
        assert_eq!(parts(capsule_reply(Some(other_pred), &st, K, None, &served(), 0)).await.0, StatusCode::SERVICE_UNAVAILABLE);

        assert_eq!(parts(capsule_reply(Some(c.clone()), &st, K, None, &cache, 0)).await.0, StatusCode::OK);
        st.retract_chain_position_above((K - 1) * 90);
        assert_eq!(parts(capsule_reply(Some(c.clone()), &st, K, None, &cache, 30)).await.0, StatusCode::OK,
                   "the binding is re-read once a minute");
        let (s, _, b) = parts(capsule_reply(Some(c), &st, K, None, &cache, 61)).await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE, "K is gone after the rollback");
        assert_eq!(serde_json::from_slice::<Value>(&b).unwrap()["mb_index"], json!(K));
    }

    /// Its own buckets, and on the wallet plane a typed 429 once the plane's is spent.
    #[tokio::test]
    async fn galc_capsule_route_has_its_own_buckets() {
        for b in [GALC_CAPSULE_BUCKET, WALLET_GALC_CAPSULE_BUCKET] {
            let c = &API_RATE_LIMITER.configs[b];
            assert_eq!((c.max_requests, c.window_seconds), (120, 60), "{}", b);
        }
        let key = std::net::SocketAddr::new("198.51.100.91".parse().unwrap(), 0);
        let mut refused = None;
        for _ in 0..=120 {
            if let Err(r) = route_limit(Some(key), Some(WalletPlane), GALC_CAPSULE_BUCKET, WALLET_GALC_CAPSULE_BUCKET, true) {
                refused = Some(r);
                break;
            }
        }
        let r = refused.expect("the plane bucket refuses past 120 a minute");
        assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
        let route = include_str!("mod.rs").replace("\r\n", "\n");
        let at = route.find(".and(warp::path(\"galc\"))").expect("galc route");
        let tail: String = route[at..].chars().take(600).collect();
        assert!(tail.contains(".and(warp::path(\"capsule\"))") && tail.contains(".and(warp::ext::optional::<WalletPlane>())")
                && tail.contains("galc_api::handle_galc_capsule"));
        assert!(route.contains(".or(galc_capsule)"));
    }
}
