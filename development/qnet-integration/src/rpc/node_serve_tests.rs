//! ServeCert and serve-proof (encoding, signatures, domain separation, budget, plane-only), the
//! committed-endpoint hints, and whoami with its connect-back.

use super::*;
use super::super::wallet_plane::{certified_key, serve, server_config, CertStore, EgressBudget, Installed, Limits, PlaneCtx, PlaneRoutes};
use std::sync::atomic::{AtomicUsize, Ordering};

const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_PHRASE: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const IP: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);
const T0: u64 = 1_800_000_000;

fn wallet_of(phrase: &str) -> (String, String) {
    let (pk, _) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(phrase);
    let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(&pk).unwrap();
    let node_id = generate_super_node_pseudonym(&wallet);
    (wallet, node_id)
}

/// A serving key from a fixed seed, so the golden body is reproducible.
fn fixed_serving_key() -> ServingKey {
    let (pk, sk) = crate::crypto::genesis_key::derive_mldsa65_from_xi(&[9u8; 32]);
    ServingKey { created_at: T0, pk, sk }
}

fn issued() -> (SignedServeCert, ServingKey) {
    let (_, node_id) = wallet_of(PHRASE);
    let key = fixed_serving_key();
    (issue_serve_cert(&node_id, IP, &key, PHRASE, T0).unwrap(), key)
}

fn challenge(byte: u8) -> String {
    hex::encode([byte; 32])
}

fn certs_for(ip: Ipv4Addr, not_after: u64) -> CertStore {
    let store = CertStore::new();
    let cert = rcgen::generate_simple_self_signed(vec!["unused.test".to_string()]).unwrap();
    let key = certified_key(vec![cert.serialize_der().unwrap()], &cert.serialize_private_key_der()).unwrap();
    store.install(Installed { key, ip, not_before: 0, not_after });
    store
}

fn ready(cert: &SignedServeCert, key: ServingKey) -> ServeStatus {
    ServeStatus::Ready { cert: cert.clone(), key: Arc::new(key) }
}

async fn body_of(r: warp::reply::Response) -> (StatusCode, warp::http::HeaderMap, Value) {
    let status = r.status();
    let headers = r.headers().clone();
    let b = warp::hyper::body::to_bytes(r.into_body()).await.unwrap();
    (status, headers, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

fn q(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

// ─── ServeCert ──────────────────────────────────────────────────────────────────────────────────

#[test]
fn serve_cert_signature_binds_every_field() {
    let (c, _) = issued();
    let (wallet, node_id) = wallet_of(PHRASE);
    assert_eq!((c.cert.node_id.as_str(), c.cert.wallet.as_str()), (node_id.as_str(), wallet.as_str()));
    assert_eq!((c.cert.issued_at, c.cert.not_after, c.cert.seq), (T0, T0 + 7 * 86_400, T0));
    // The body's layout: version, the two names, the mapped IP, three u64, the two keys; ~7.3 KB with the signature.
    assert_eq!(c.body.len(), 1 + 1 + node_id.len() + 1 + 45 + 16 + 24 + 2 * MLDSA65_PK_BYTES);
    assert_eq!(c.body[0], 1);
    assert_eq!(&c.body[2 + node_id.len() + 1 + 45..][..16], &IP.to_ipv6_mapped().octets());
    assert_eq!(c.wire().len(), c.body.len() + MLDSA65_SIG_BYTES);
    assert!((7000..7600).contains(&c.wire().len()));
    assert_eq!(ServeCert::decode_body(&c.body).unwrap(), c.cert, "strict round trip");
    let (back, hash) = verify_serve_cert(&c.wire(), T0 + 10).expect("verifies");
    assert_eq!((back, hash), (c.cert.clone(), c.hash));
    // Golden values shared with the clients (docs/protocols/serve-cert.vectors.json): the phrase, the
    // serving key's FIPS 204 seed, the fields, and what a client must compute from them.
    let ch = challenge(0x5a);
    let expected = json!({
        "description": "ServeCert v1 and serve-proof preimages. The wallet key is the wallet ML-DSA-65 key of `phrase`; the serving key is the FIPS 204 ML-DSA-65 key generated from `serve_key_seed_hex`. Signatures are randomized and not fixed: verify them, do not compare them.",
        "phrase": PHRASE,
        "serve_key_seed_hex": hex::encode([9u8; 32]),
        "wallet": wallet,
        "node_id": node_id,
        "ip": IP.to_string(),
        "issued_at": T0,
        "not_after": T0 + 7 * 86_400,
        "seq": T0,
        "serve_pk_sha3": hex::encode(Sha3_256::digest(&c.cert.serve_pk)),
        "wallet_pk_sha3": hex::encode(Sha3_256::digest(&c.cert.wallet_pk)),
        "body_sha3": hex::encode(c.hash),
        "body_len": c.body.len(),
        "body_head_hex": hex::encode(&c.body[..c.body.len() - 2 * MLDSA65_PK_BYTES]),
        "cert_hash": hex::encode(c.hash),
        "cert_preimage": serve_cert_preimage(&c.hash),
        "challenge": ch,
        "proof_preimage": serve_proof_preimage(&ch, &c.hash, IP),
    });
    let file: Value = serde_json::from_str(include_str!("../../../../docs/protocols/serve-cert.vectors.json")).unwrap();
    assert_eq!(file, expected, "docs/protocols/serve-cert.vectors.json must hold exactly:\n{}", serde_json::to_string_pretty(&expected).unwrap());
    // Flipping any byte of the body, or of the signature, fails verification.
    let wire = c.wire();
    for i in (0..wire.len()).step_by(7).chain([wire.len() - 1]) {
        let mut w = wire.clone();
        w[i] ^= 0x01;
        assert!(verify_serve_cert(&w, T0 + 10).is_err(), "byte {} flipped", i);
    }
    // Lifetime, sequence and clock rules.
    let mut long = c.cert.clone();
    long.not_after = long.issued_at + 7 * 86_400 + 1;
    assert_eq!(ServeCert::decode_body(&long.encode_body()), Err("lifetime"));
    let mut seq = c.cert.clone();
    seq.seq += 1;
    assert_eq!(ServeCert::decode_body(&seq.encode_body()), Err("seq"));
    assert_eq!(verify_serve_cert(&wire, T0 + 7 * 86_400 + 1).unwrap_err(), "not_current");
    assert!(verify_serve_cert(&wire, T0 - 3600).is_ok(), "an hour of clock slack before issue");
    assert_eq!(verify_serve_cert(&wire, T0 - 3601).unwrap_err(), "not_current");
    let mut trailing = c.body.clone();
    trailing.push(0);
    assert_eq!(ServeCert::decode_body(&trailing), Err("trailing_bytes"));
    assert_eq!(ServeCert::decode_body(&c.body[..c.body.len() - 1]), Err("truncated"));
    // A phrase whose wallet does not own the node id signs nothing.
    let (_, other_id) = wallet_of(OTHER_PHRASE);
    assert!(issue_serve_cert(&other_id, IP, &fixed_serving_key(), PHRASE, T0).is_err());
    // A certificate re-signed by another wallet for this node id is refused (pseudonym and key).
    let (other_pk, other_sk) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(OTHER_PHRASE);
    let mut forged = c.cert.clone();
    forged.wallet_pk = other_pk;
    let body = forged.encode_body();
    let mut w = body.clone();
    w.extend(sign_serve_cert(&forged, &other_sk).unwrap());
    assert_eq!(verify_serve_cert(&w, T0).unwrap_err(), "wallet_key");
}

#[test]
fn serve_proof_binds_challenge_cert_and_ip() {
    let (c, key) = issued();
    let ch = challenge(0x5a);
    let pre = serve_proof_preimage(&ch, &c.hash, IP);
    assert_eq!(pre, format!("q1337|node_serve_proof:{}:{}:203.0.113.7", ch, hex::encode(c.hash)));
    assert_eq!(serve_cert_preimage(&c.hash), format!("q1337|node_serve_cert:{}", hex::encode(c.hash)));
    let sig = key.sign(pre.as_bytes()).unwrap();
    assert!(verify_serve_proof(&c.cert, &c.hash, &ch, &sig));
    // Replay: the answer to one challenge is no answer to another; a moved IP or another cert fails too.
    assert!(!verify_serve_proof(&c.cert, &c.hash, &challenge(0x5b), &sig));
    let mut moved = c.cert.clone();
    moved.ip = Ipv4Addr::new(203, 0, 113, 8);
    assert!(!verify_serve_proof(&moved, &c.hash, &ch, &sig));
    assert!(!verify_serve_proof(&c.cert, &[0u8; 32], &ch, &sig));
    // The wallet's cert signature is no serving signature, and the serving key cannot pose as the wallet.
    assert!(!verify_serve_proof(&c.cert, &c.hash, &ch, &c.wallet_sig));
    let mut posed = c.body.clone();
    posed.extend(key.sign(serve_cert_preimage(&c.hash).as_bytes()).unwrap());
    assert_eq!(verify_serve_cert(&posed, T0).unwrap_err(), "wallet_signature");
}

#[tokio::test]
async fn serve_proof_answers_and_refusals() {
    let (c, key) = issued();
    let status = ready(&c, key);
    let certs = certs_for(IP, T0 + 86_400);
    let sigs = PerSecond::new(20);
    let ch = challenge(0x11);
    let (s, h, v) = body_of(serve_proof_reply(&status, &certs, &sigs, &ch, None, 31234, T0 + 5)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h.get("cache-control").unwrap(), "no-store");
    assert_eq!((v["v"].clone(), v["newest_certified_index"].clone()), (json!(1), json!(31234)));
    let b64 = base64::engine::general_purpose::STANDARD;
    let wire = b64.decode(v["cert"].as_str().unwrap()).unwrap();
    let (cert, hash) = verify_serve_cert(&wire, T0 + 5).unwrap();
    assert_eq!(v["cert_hash"], json!(hex::encode(hash)));
    let sig = b64.decode(v["sig"].as_str().unwrap()).unwrap();
    assert!(verify_serve_proof(&cert, &hash, &ch, &sig), "a client's full check passes");
    // `have` the current hash: the cert is left out.
    let (_, _, v2) = body_of(serve_proof_reply(&status, &certs, &sigs, &ch, Some(&hex::encode(hash)), 1, T0 + 5)).await;
    assert!(v2.get("cert").is_none() && v2["cert_hash"] == json!(hex::encode(hash)));
    let (_, _, v3) = body_of(serve_proof_reply(&status, &certs, &sigs, &ch, Some(&challenge(0)), 1, T0 + 5)).await;
    assert!(v3["cert"].is_string(), "a stale `have` gets the cert");
    // 503 reasons.
    for (st, reason) in [(ServeStatus::NoCertificate, "no_certificate"), (ServeStatus::NotRegistered, "not_registered"), (ServeStatus::NoWalletKey, "no_wallet_key")] {
        let (s, h, v) = body_of(serve_proof_reply(&st, &certs, &sigs, &ch, None, 1, T0 + 5)).await;
        assert_eq!((s, v["error"].clone(), v["reason"].clone()), (StatusCode::SERVICE_UNAVAILABLE, json!("serve_unavailable"), json!(reason)));
        assert_eq!(v["proof_format"], json!(2));
        assert!(h.get("retry-after").is_some());
    }
    // The TLS certificate must be valid now and for the ServeCert's IP.
    for other in [certs_for(Ipv4Addr::new(203, 0, 113, 9), T0 + 86_400), certs_for(IP, T0 + 1), CertStore::new()] {
        let (_, _, v) = body_of(serve_proof_reply(&status, &other, &sigs, &ch, None, 1, T0 + 5)).await;
        assert_eq!(v["reason"], json!("no_certificate"));
    }
}

#[tokio::test]
async fn serve_proof_budget_and_plane_only() {
    let (c, key) = issued();
    let status = ready(&c, key);
    let certs = certs_for(IP, T0 + 86_400);
    // 20 signatures per second node-wide; the 21st waits for the next second.
    let sigs = PerSecond::new(20);
    for i in 0..20 {
        assert_eq!(serve_proof_reply(&status, &certs, &sigs, &challenge(i), None, 1, T0 + 100).status(), StatusCode::OK, "{}", i);
    }
    let (s, _, v) = body_of(serve_proof_reply(&status, &certs, &sigs, &challenge(21), None, 1, T0 + 100)).await;
    assert_eq!((s, v["reason"].clone()), (StatusCode::SERVICE_UNAVAILABLE, json!("busy")));
    assert_eq!(serve_proof_reply(&status, &certs, &sigs, &challenge(22), None, 1, T0 + 101).status(), StatusCode::OK);
    // Off the plane the route does not exist.
    let ch = challenge(1);
    let off = serve_proof_route(&q(&[("challenge", &ch)]), Some(SocketAddr::new("198.51.100.40".parse().unwrap(), 0)), None,
                                &status, &certs, &sigs, T0 + 102, || 1);
    assert!(off.unwrap_err().is_not_found());
    // 6 per minute per source on the plane, typed.
    let src = Some(SocketAddr::new("198.51.100.41".parse().unwrap(), 0));
    let mut statuses = Vec::new();
    for i in 0..7u8 {
        let r = serve_proof_route(&q(&[("challenge", &challenge(i))]), src, Some(WalletPlane), &status, &certs, &PerSecond::new(100), T0 + 200 + i as u64, || 1).unwrap();
        statuses.push(r.status());
    }
    assert_eq!(statuses[..6], [StatusCode::OK; 6]);
    assert_eq!(statuses[6], StatusCode::TOO_MANY_REQUESTS);
    // The challenge must be fresh-looking: exactly 64 lowercase hex, once; `have` likewise; nothing else.
    let src = Some(SocketAddr::new("198.51.100.42".parse().unwrap(), 0));
    let upper = challenge(0xab).to_uppercase();
    let short = &challenge(1)[..63];
    let two = challenge(2);
    let bad: Vec<Vec<(String, String)>> = vec![
        q(&[]), q(&[("challenge", &upper)]), q(&[("challenge", short)]), q(&[("challenge", &two), ("challenge", &two)]),
        q(&[("challenge", &two), ("x", "1")]), q(&[("challenge", &two), ("have", "zz")]),
    ];
    for query in &bad[..5] {
        let r = serve_proof_route(query, src, Some(WalletPlane), &status, &certs, &PerSecond::new(100), T0 + 300, || 1).unwrap();
        let (s, _, v) = body_of(r).await;
        assert_eq!((s, v["error"].clone()), (StatusCode::BAD_REQUEST, json!("bad_parameter")), "{:?}", query);
    }
    assert_eq!(serve_query(&bad[5]), Err("have"));
}

#[test]
fn serve_preimages_are_no_transaction_preimage() {
    // No transaction preimage builder emits either kind: they live in this file alone.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![root.clone()];
    let mut found = Vec::new();
    while let Some(p) = files.pop() {
        for e in std::fs::read_dir(&p).unwrap().flatten() {
            let path = e.path();
            if path.is_dir() {
                files.push(path);
            } else if path.extension().map_or(false, |x| x == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                if text.contains("node_serve_cert:") || text.contains("node_serve_proof:") {
                    found.push(path.file_name().unwrap().to_string_lossy().to_string());
                }
            }
        }
    }
    found.sort();
    assert_eq!(found, vec!["node_serve.rs".to_string(), "node_serve_tests.rs".to_string()]);
    assert!(!crate::node::node_sources().contains("node_serve_"), "the node's transaction preimages never name a serving kind");
    let state_src = include_str!("../../../../core/qnet-state/src/transaction.rs");
    assert!(!state_src.contains("node_serve"));
    // Sample transaction preimages of the wallet and the node: none begins with a serving kind.
    let (wallet, node_id) = wallet_of(PHRASE);
    let tag = qnet_state::transaction::chain_tag();
    let txs = vec![
        qnet_state::Transaction::new(wallet.clone(), Some(wallet.clone()), 5, 1, 1, 10_000, T0, None,
            qnet_state::TransactionType::Transfer { from: wallet.clone(), to: wallet.clone(), amount: 5 }, None),
        crate::node::BlockchainNode::create_node_reactivation_tx(&node_id, 100, &"ab".repeat(32), 2, "https://44.1.2.3"),
        crate::node::BlockchainNode::create_node_registration_tx_with_endpoint(&node_id, qnet_state::NodeType::Super, &wallet, "burn", "https://44.1.2.3"),
    ];
    for tx in &txs {
        let m = crate::node::BlockchainNode::build_canonical_verify_message(tx);
        assert!(m.starts_with(&tag) && !m[tag.len()..].starts_with("node_serve_"), "{}", m);
    }
    // Every verifier refuses a serving signature placed on a transaction.
    let (c, key) = issued();
    let (wpk, _) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(PHRASE);
    let mut transfer = txs[0].clone();
    transfer.dilithium_signature = Some(c.wallet_sig.clone());
    transfer.dilithium_public_key = Some(wpk.clone());
    assert!(!crate::node::BlockchainNode::verify_user_tx_dilithium_at(&transfer, 1), "a ServeCert signature is no transfer signature");
    let mut react = txs[1].clone();
    react.dilithium_signature = Some(key.sign(serve_proof_preimage(&challenge(1), &c.hash, IP).as_bytes()).unwrap());
    react.dilithium_public_key = Some(key.pk.clone());
    assert!(!crate::node::BlockchainNode::verify_node_lifecycle_dilithium(&react));
    let mut reg = txs[2].clone();
    reg.dilithium_signature = Some(c.wallet_sig.clone());
    reg.dilithium_public_key = Some(wpk);
    assert!(!crate::node::BlockchainNode::verify_node_lifecycle_dilithium(&reg));
    // And the wallet key's only preimage here is a hash of a node-composed body: no client input.
    let src = include_str!("node_serve.rs").replace("\r\n", "\n");
    let signer = &src[src.find("pub(crate) fn sign_serve_cert").unwrap()..];
    let signer = &signer[..signer.find("\n}\n").unwrap()];
    assert!(signer.contains("serve_cert_preimage(&cert_hash(&cert.encode_body()))"));
    assert_eq!(src.matches("wallet_sk").filter(|_| true).count() >= 1, true);
    for line in src.lines().filter(|l| l.contains("mldsa_sign(") && !l.contains("fn mldsa_sign")) {
        assert!(line.contains("serve_cert_preimage") || line.contains("&self.sk"), "every signing call is one of the two kinds: {}", line);
    }
}

#[test]
fn serving_key_persists_and_rotates() {
    let dir = std::env::temp_dir().join(format!("qnet-serve-key-{}-{}", std::process::id(), rand::random::<u64>()));
    std::fs::create_dir_all(&dir).unwrap();
    let a = ServingKey::load_or_rotate(&dir, T0);
    let b = ServingKey::load_or_rotate(&dir, T0 + 86_400);
    assert_eq!(a.pk, b.pk, "kept within 30 days");
    let c = ServingKey::load_or_rotate(&dir, T0 + SERVE_KEY_ROTATE_SECS);
    assert_ne!(a.pk, c.pk, "rotated after 30 days");
    let sig = c.sign(b"m").unwrap();
    assert_eq!(sig.len(), MLDSA65_SIG_BYTES);
    // The held ServeCert is reloaded only while it verifies, and re-issued on schedule.
    let (cert, key) = issued();
    save_serve_cert(&dir, &cert);
    assert_eq!(load_serve_cert(&dir, T0 + 10).map(|c| c.hash), Some(cert.hash));
    assert!(load_serve_cert(&dir, T0 + 8 * 86_400).is_none());
    let (_, node_id) = wallet_of(PHRASE);
    let (_, other_node) = wallet_of(OTHER_PHRASE);
    assert!(!serve_cert_due(Some(&cert), &node_id, IP, &key, T0 + 71 * 3600));
    assert!(serve_cert_due(Some(&cert), &node_id, IP, &key, T0 + 72 * 3600), "every 72 h");
    assert!(serve_cert_due(Some(&cert), &node_id, Ipv4Addr::new(203, 0, 113, 8), &key, T0 + 10), "on an IP change");
    assert!(serve_cert_due(Some(&cert), &node_id, IP, &c, T0 + 10), "on a key rotation");
    assert!(serve_cert_due(Some(&cert), &other_node, IP, &key, T0 + 10), "a volume kept under a new phrase");
    assert!(serve_cert_due(None, &node_id, IP, &key, T0));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn signing_wipes_the_libraries_key_copy() {
    // The library's secret-key struct has no wipe of its own; the node overwrites it after signing.
    let (_, sk) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(PHRASE);
    let mut key = pqcrypto_mldsa::mldsa65::SecretKey::from_bytes(&sk).unwrap();
    assert_eq!(std::mem::size_of_val(&key), MLDSA65_SK_BYTES, "one byte array, nothing else");
    assert!(key.as_bytes().iter().any(|b| *b != 0));
    wipe_secret_key(&mut key);
    assert!(key.as_bytes().iter().all(|b| *b == 0));
    // Signing through the wiping path still verifies.
    let (pk, sk) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(PHRASE);
    let sig = mldsa_sign(&sk, b"msg").unwrap();
    assert!(mldsa_verify(&pk, b"msg", &sig));
    // The issue path holds the phrase in a wiping buffer.
    let src = include_str!("../node/public_rpc.rs");
    assert!(src.contains("load_wallet_seed(\"QNET_WALLET_SEED\").map(zeroize::Zeroizing::new)"));
}

// ─── Hints ──────────────────────────────────────────────────────────────────────────────────────

#[test]
fn nodes_rpc_lists_only_committed_https_ipv4() {
    let ids: Vec<String> = (0..12).map(|i| format!("super_node_{:016x}", i)).collect();
    let rows: HashMap<String, String> = [
        (0, "https://44.1.2.3"), (1, "http://44.1.2.4:8001"), (2, "https://44.1.2.5:8443"), (3, "https://44.1.2.6:443"),
        (4, "https://44.1.2.7/x"), (5, "https://10.1.2.3"), (6, "https://node.example.test"), (7, ""), (8, "https://044.1.2.9"),
        (9, "https://203.0.113.7"), (10, "https://[2001:db8::1]"),
    ].into_iter().map(|(i, v)| (ids[i].clone(), v.to_string())).collect();
    let listed = nodes_rpc_entries(&ids, |id| rows.get(id).cloned());
    assert_eq!(listed, vec![
        json!({ "node_id": ids[0], "ip": "44.1.2.3" }),
        json!({ "node_id": ids[3], "ip": "44.1.2.6" }),
    ]);
    // It follows the committed row: a refreshed endpoint (registration or reactivation apply) is what it lists.
    let dir = std::env::temp_dir().join(format!("qnet-nodes-rpc-{}-{}", std::process::id(), rand::random::<u64>()));
    let storage = crate::storage::Storage::new(dir.to_str().unwrap()).unwrap();
    storage.save_node_endpoint(&ids[0], "http://44.1.2.3:8001").unwrap();
    let read = |s: &crate::storage::Storage| nodes_rpc_entries(&ids[..1], |id| s.load_node_endpoint(id).ok().flatten());
    assert!(read(&storage).is_empty());
    storage.save_node_endpoint(&ids[0], "https://44.1.2.3").unwrap();
    assert_eq!(read(&storage), vec![json!({ "node_id": ids[0], "ip": "44.1.2.3" })]);
    storage.save_node_endpoint(&ids[0], "http://44.1.2.3:8001").unwrap();
    assert!(read(&storage).is_empty(), "a lapse back to the plain form drops it");
    drop(storage);
    let _ = std::fs::remove_dir_all(dir);
    // The query: 1 to 64 ids, each a super node id; duplicates collapse; nothing else.
    let many: Vec<String> = (0..65).map(|i| format!("super_node_{:016x}", i)).collect();
    assert_eq!(nodes_rpc_ids(&q(&[("ids", &many[..64].join(","))])).unwrap().len(), 64);
    assert_eq!(nodes_rpc_ids(&q(&[("ids", &many.join(","))])), Err("ids"));
    assert_eq!(nodes_rpc_ids(&q(&[("ids", &format!("{0},{0}", many[0]))])).unwrap(), vec![many[0].clone()]);
    for bad in ["", "super_node_123", "genesis_node_001", "super_node_ABCDEF0123456789", "light_mobile_0011223344556677", "super_node_0011223344556677,"] {
        assert_eq!(nodes_rpc_ids(&q(&[("ids", bad)])), Err("ids"), "{}", bad);
    }
    assert_eq!(nodes_rpc_ids(&q(&[("ids", &many[0]), ("ids", &many[1])])), Err("ids"));
    assert_eq!(nodes_rpc_ids(&q(&[("sample", "16")])), Err("ids"), "no sampling mode");
}

#[test]
fn strict_public_ipv4_ranges() {
    for ok in ["44.1.2.3", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.0.1.1", "192.169.0.1",
               "198.17.255.255", "198.20.0.0", "223.255.255.255", "45.10.20.30"] {
        assert!(is_public_unicast_v4(ok.parse().unwrap()), "{}", ok);
    }
    for bad in ["0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.2", "169.254.9.9", "172.16.0.1", "172.31.255.255",
                "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.7",
                "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255"] {
        assert!(!is_public_unicast_v4(bad.parse().unwrap()), "{}", bad);
    }
    assert_eq!(parse_https_ipv4_endpoint("https://44.1.2.3"), Some(Ipv4Addr::new(44, 1, 2, 3)));
    assert_eq!(parse_https_ipv4_endpoint("https://44.1.2.3:443"), Some(Ipv4Addr::new(44, 1, 2, 3)));
    for bad in ["http://44.1.2.3", "https://44.1.2.3:8001", "https://44.1.2.3/", "https://44.1.2.3:443/x", "https://044.1.2.3", "https://a.b",
                "https://44.1.2.3.4", "HTTPS://44.1.2.3", "https:// 44.1.2.3"] {
        assert_eq!(parse_https_ipv4_endpoint(bad), None, "{}", bad);
    }
}

// ─── whoami ─────────────────────────────────────────────────────────────────────────────────────

/// A wallet plane on loopback (its certificate store returned) with an ephemeral port.
async fn plane_on_loopback() -> (SocketAddr, Arc<CertStore>) {
    let certs = Arc::new(CertStore::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let routes: PlaneRoutes = warp::any().map(|| warp::Reply::into_response("ok")).boxed();
    let ctx = PlaneCtx::new(routes, server_config(Arc::clone(&certs) as Arc<dyn rustls::server::ResolvesServerCert>).unwrap(),
                            Limits::production(), EgressBudget::new(1e9, 1e9));
    tokio::spawn(serve(listener, ctx));
    (addr, certs)
}

#[tokio::test]
async fn whoami_probe_connects_only_to_the_caller() {
    let loopback: IpAddr = "127.0.0.1".parse().unwrap();
    // Plain answer: the caller's address, unwrapped from IPv4-mapped form.
    let (s, h, v) = body_of(whoami_reply("::ffff:44.1.2.3".parse().unwrap(), true, &q(&[]), 443, false).await).await;
    assert_eq!((s, v), (StatusCode::OK, json!({ "ip": "44.1.2.3" })));
    assert_eq!(h.get("cache-control").unwrap(), "no-store");
    // The caller's own process answers with the marker: tls443 true.
    let (plane, certs) = plane_on_loopback().await;
    let marker = hex::encode([0x42u8; 16]);
    certs.arm_probe(&marker, Duration::from_secs(30)).unwrap();
    let (_, _, v) = body_of(whoami_reply(loopback, true, &q(&[("probe", "443"), ("marker", &marker)]), plane.port(), true).await).await;
    assert_eq!(v, json!({ "ip": "127.0.0.1", "tcp443": true, "tls443": true }));
    // Something else on that port (here: the same listener without the marker armed): tcp true, tls false.
    certs.disarm_probe(&marker);
    let cert = rcgen::generate_simple_self_signed(vec!["other.server.test".to_string()]).unwrap();
    let key = certified_key(vec![cert.serialize_der().unwrap()], &cert.serialize_private_key_der()).unwrap();
    certs.install(Installed { key, ip: Ipv4Addr::LOCALHOST, not_before: 0, not_after: u64::MAX });
    let (_, _, v) = body_of(whoami_reply(loopback, true, &q(&[("probe", "443"), ("marker", &marker)]), plane.port(), true).await).await;
    assert_eq!(v, json!({ "ip": "127.0.0.1", "tcp443": true, "tls443": false }), "another server on 443 is not this node");
    // Without a marker only the TCP connect is reported.
    let (_, _, v) = body_of(whoami_reply(loopback, true, &q(&[("probe", "443")]), plane.port(), true).await).await;
    assert_eq!(v, json!({ "ip": "127.0.0.1", "tcp443": true }));
    // The connect-back goes to the caller and nowhere else: a listener counting its connections sees
    // the probe for its own address and none for another caller's.
    let counter = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = counter.local_addr().unwrap().port();
    let seen = Arc::new(AtomicUsize::new(0));
    let s2 = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((_s, _)) = counter.accept().await {
            s2.fetch_add(1, Ordering::SeqCst);
        }
    });
    let (_, _, v) = body_of(whoami_reply(loopback, true, &q(&[("probe", "443")]), port, true).await).await;
    assert_eq!(v["tcp443"], json!(true));
    // The accept is counted on the listener's own task.
    for _ in 0..100 {
        if seen.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(seen.load(Ordering::SeqCst), 1);
    let (_, _, v) = body_of(whoami_reply("192.0.2.1".parse().unwrap(), true, &q(&[("probe", "443")]), port, true).await).await;
    assert_eq!(v["tcp443"], json!(false));
    assert_eq!(seen.load(Ordering::SeqCst), 1, "another caller's probe never reaches this listener");
    // A caller that is not a public address is never probed (the route's rule).
    let (_, _, v) = body_of(whoami_reply(loopback, true, &q(&[("probe", "443"), ("marker", &marker)]), port, false).await).await;
    assert_eq!(v, json!({ "ip": "127.0.0.1", "tcp443": false, "tls443": false, "probe": "caller_not_public" }));
    assert_eq!(seen.load(Ordering::SeqCst), 1);
    // One probe at a time per caller.
    PROBES_INFLIGHT.insert("198.51.100.99".parse().unwrap());
    let r = whoami_reply("198.51.100.99".parse().unwrap(), true, &q(&[("probe", "443")]), port, true).await;
    assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(PROBES_INFLIGHT.contains(&"198.51.100.99".parse::<IpAddr>().unwrap()), "a refused caller does not free the holder's slot");
    PROBES_INFLIGHT.remove(&"198.51.100.99".parse::<IpAddr>().unwrap());
    // The query.
    for bad in [q(&[("marker", &marker)]), q(&[("probe", "80")]), q(&[("probe", "443"), ("marker", "ABC")]), q(&[("x", "1")]),
                q(&[("probe", "443"), ("probe", "443")])] {
        let (s, _, v) = body_of(whoami_reply(loopback, true, &bad, port, true).await).await;
        assert_eq!((s, v["error"].clone()), (StatusCode::BAD_REQUEST, json!("bad_parameter")), "{:?}", bad);
    }
    // 2 per minute per source.
    let src = SocketAddr::new("198.51.100.98".parse().unwrap(), 0);
    let r: Vec<bool> = (0..3).map(|_| api_rate_limit_retry(Some(src), WHOAMI_BUCKET).is_ok()).collect();
    assert_eq!(r, vec![true, true, false]);
}

#[tokio::test]
async fn whoami_probes_only_an_address_the_socket_gave() {
    let gw: IpAddr = "172.17.0.1".parse().unwrap();
    let plane = WalletPeer { peer: "44.7.7.7:5000".parse().unwrap(), key: "44.7.7.7".parse().unwrap() };
    // The socket's own peer is the probe target; a loopback or gateway peer speaks for someone else.
    assert_eq!(socket_client_ip(Some(&plane), Some("127.0.0.1:1".parse().unwrap()), Some(gw)), Some("44.7.7.7".parse().unwrap()));
    assert_eq!(socket_client_ip(None, Some("44.7.7.8:9".parse().unwrap()), Some(gw)), Some("44.7.7.8".parse().unwrap()));
    assert_eq!(socket_client_ip(None, Some("[::ffff:44.7.7.8]:9".parse().unwrap()), Some(gw)), Some("44.7.7.8".parse().unwrap()));
    for peer in ["127.0.0.1:9", "[::1]:9", "[::ffff:127.0.0.1]:9", "172.17.0.1:9", "[::ffff:172.17.0.1]:9"] {
        assert_eq!(socket_client_ip(None, Some(peer.parse().unwrap()), Some(gw)), None, "{}", peer);
    }
    assert_eq!(socket_client_ip(None, None, Some(gw)), None);
    // Through the route: a loopback peer carrying X-Forwarded-For (a terminator, or the runtime's proxy
    // passing on what a client wrote) reports that address but connects nowhere.
    let counter = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let accepts = Arc::new(AtomicUsize::new(0));
    let a2 = Arc::clone(&accepts);
    tokio::spawn(async move {
        while let Ok((_s, _)) = counter.accept().await {
            a2.fetch_add(1, Ordering::SeqCst);
        }
    });
    let loopback_peer: SocketAddr = "127.0.0.1:40001".parse().unwrap();
    for victim in ["44.6.6.6", "44.6.6.5"] {
        let remote = super::super::forwarded_client(Some(loopback_peer), Some(victim));
        let marker = hex::encode([0x24u8; 16]);
        let r = handle_whoami(q(&[("probe", "443"), ("marker", &marker)]), remote, None, Some(loopback_peer)).await.unwrap();
        let (s, _, v) = body_of(r).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["probe"], json!("caller_not_socket"), "{}", victim);
        assert!(v.get("tcp443").is_none() && v.get("tls443").is_none(), "no probe result: none was made: {}", v);
    }
    let (_, _, v) = body_of(whoami_reply("44.6.6.6".parse().unwrap(), false, &q(&[("probe", "443")]), 1, true).await).await;
    assert_eq!(v, json!({ "ip": "44.6.6.6", "probe": "caller_not_socket" }));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(accepts.load(Ordering::SeqCst), 0, "a header-only caller is never connected to");
    // Without probe=443 the header-derived address is still reported (a hint).
    let remote = super::super::forwarded_client(Some(loopback_peer), Some("44.6.6.7"));
    let (_, _, v) = body_of(handle_whoami(q(&[]), remote, None, Some(loopback_peer)).await.unwrap()).await;
    assert_eq!(v, json!({ "ip": "44.6.6.7" }));
}

#[tokio::test]
async fn a_dropped_probe_frees_its_caller() {
    let caller: IpAddr = "198.51.100.77".parse().unwrap();
    // The client goes away mid-probe: its request future is dropped while the connect-back waits.
    let query = q(&[("probe", "443")]);
    let stalled = whoami_reply_with(caller, true, &query, true, |_, _| std::future::pending::<(bool, Option<bool>)>());
    assert!(tokio::time::timeout(Duration::from_millis(50), stalled).await.is_err());
    assert!(!PROBES_INFLIGHT.contains(&caller), "the slot is freed with the dropped request");
    // The next probe from that caller is admitted.
    let r = whoami_reply_with(caller, true, &q(&[("probe", "443")]), true, |ip, _| async move {
        assert_eq!(ip, "198.51.100.77".parse::<IpAddr>().unwrap());
        (true, None)
    }).await;
    let (s, _, v) = body_of(r).await;
    assert_eq!((s, v), (StatusCode::OK, json!({ "ip": "198.51.100.77", "tcp443": true })));
    assert!(!PROBES_INFLIGHT.contains(&caller));
}

#[test]
fn node_wide_gates_hold_per_second() {
    let g = PerSecond::new(3);
    assert_eq!((0..4).map(|_| g.admit_at(10)).collect::<Vec<_>>(), vec![true, true, true, false]);
    assert!(g.admit_at(11));
    assert_eq!((SERVE_SIGS.per_sec, PROBES.per_sec), (20, 20));
}
