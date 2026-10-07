//! Service-level tests: every row of the lease table (plan-technical 9.2), two strikes with and without
//! corroboration, the hold, reset tickets, outages, gates, limits, replay and the statements, against a
//! scripted vendor side.

use super::*;
use crate::testkit::*;

fn ok(v: Result<Value, ApiError>) -> Value {
    v.unwrap_or_else(|e| panic!("expected success, got {:?}", e))
}

fn refusal(v: Result<Value, ApiError>) -> (Refusal, Option<String>, Option<u64>, Option<u64>) {
    match v {
        Err(ApiError::Refused { reason, reference, until, retry_at }) => (reason, reference, until, retry_at),
        other => panic!("expected a refusal, got {:?}", other.map(|v| v.to_string())),
    }
}

fn lease_of(h: &H, n: &str) -> NodeLease {
    h.o.store.get(Cf::Lease, n).unwrap().unwrap()
}

/// Claims an iOS node on a slot that reads `g` and writes the scripted value.
fn ios_claimed(h: &H, n: &str, key: &DeviceKey, read_g: u8, token: &str) -> Value {
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(read_g));
    ok(h.o.claim(h.ios_claim(n, key, token)))
}

// ---- claim rows ----

#[test]
fn ios_claim_on_a_never_used_slot_counts_now_and_the_statement_verifies() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(1);
    h.gens(&[2]);
    let r = ios_claimed(&h, &n, &key, 0, "dc-1");
    assert_eq!(r["lease"], "claimed_virgin");
    assert_eq!(r["effective"], "now");
    assert_eq!(r["state"], "active");
    assert_eq!(h.last_dc_write(), Some(2));
    let tag = device_tag("1337", Platform::Ios, &key.public);
    let stmt = r["lease_statement"].as_str().unwrap();
    assert_eq!(stmt, format!("qnet_device_lease:v1|1337|{}|{}|claimed_virgin|now|na||{}", n, hex::encode(tag), T0));
    let sig = hex::decode(r["oracle_sig"].as_str().unwrap()).unwrap();
    assert_eq!(sig.len(), 3309);
    assert!(crate::signer::verify(h.o.signer.public_key(), stmt.as_bytes(), &sig));
    let l = lease_of(&h, &n);
    assert_eq!((l.g, l.g_prev, l.state), (2, 0, State::Active));
    assert_eq!(r["lease_valid_until"], T0 + 5 * DAY);
}

#[test]
fn claim_on_another_generation_waits_for_the_next_epoch() {
    let h = H::new(Opts::default());
    let r = ios_claimed(&h, &node(2), &DeviceKey::new(), 3, "dc-2");
    assert_eq!(r["lease"], "claimed_foreign");
    assert_eq!(r["effective"], "next");
    assert_eq!(r["state"], "pending_next_epoch");
    assert_ne!(h.last_dc_write(), Some(3));
}

#[test]
fn a_known_key_on_a_never_used_slot_waits_for_the_next_epoch() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(3);
    ios_claimed(&h, &n, &key, 0, "dc-3a");
    h.at(T0 + 3 * DAY);
    let r = ios_claimed(&h, &n, &key, 0, "dc-3b");
    assert_eq!(r["lease"], "claimed_virgin");
    assert_eq!(r["effective"], "next", "a reinstall loop cannot restart the clock with an old key");
}

#[test]
fn reclaiming_the_nodes_own_generation_is_free_and_current() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(4);
    h.gens(&[1]);
    ios_claimed(&h, &n, &key, 0, "dc-4a");
    h.at(T0 + HOUR);
    let before: Times = h.o.store.get(Cf::Limit, format!("n:{}", n)).unwrap().unwrap();
    let r = ios_claimed(&h, &n, &key, 1, "dc-4b");
    assert_eq!(r["lease"], "self_reclaim");
    assert_eq!(r["effective"], "now");
    let after: Times = h.o.store.get(Cf::Limit, format!("n:{}", n)).unwrap().unwrap();
    assert_eq!(before, after, "a self-reclaim is not counted against the limits");
}

#[test]
fn after_release_the_same_node_self_reclaims_for_30_days() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(5);
    h.gens(&[3]);
    ios_claimed(&h, &n, &key, 0, "dc-5a");
    let rel: ReleaseRequest =
        serde_json::from_value(json!({"node_id": n, "preimage": release_msg(&n)})).unwrap();
    let r = ok(h.o.release(rel));
    assert_eq!(r["state"], "ended");
    assert_eq!(h.o.store.get::<NodeLease>(Cf::Lease, &n).unwrap().unwrap().released_g, 3);
    h.at(T0 + 10 * DAY);
    let r = ios_claimed(&h, &n, &key, 3, "dc-5b");
    assert_eq!(r["lease"], "self_reclaim");
    // Another node reading that value on the same device is foreign.
    let other = ios_claimed(&h, &node(6), &DeviceKey::new(), 3, "dc-5c");
    assert_eq!(other["lease"], "claimed_foreign");
}

#[test]
fn release_with_a_token_rotates_to_an_unrecorded_value_kept_only_for_self_reclaim() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(7);
    h.gens(&[1, 3]);
    ios_claimed(&h, &n, &key, 0, "dc-7a");
    let rel: ReleaseRequest =
        serde_json::from_value(json!({"node_id": n, "preimage": release_msg(&n), "dc_token": "dc-7b"})).unwrap();
    ok(h.o.release(rel));
    assert_eq!(h.last_dc_write(), Some(3), "the slot is rotated, never written as free");
    let l = lease_of(&h, &n);
    assert_eq!((l.g, l.released_g), (0, 3));
    let r = ios_claimed(&h, &n, &key, 3, "dc-7c");
    assert_eq!(r["lease"], "self_reclaim");
}

#[test]
fn a_devicecheck_outage_at_claim_gives_no_lease_and_check_pending() {
    let h = H::new(Opts::default());
    h.http.push("dc.test/v1/query_two_bits", 503, b"");
    let r = ok(h.o.claim(h.ios_claim(&node(8), &DeviceKey::new(), "dc-8")));
    assert_eq!(r["lease"], "none");
    assert_eq!(r["effective"], "next");
    assert_eq!(r["state"], "check_pending");
    assert_eq!(h.http.count("update_two_bits"), 0);
    assert!(r["lease_statement"].as_str().unwrap().contains("|none|next|"));
}

#[test]
fn a_failed_write_stays_pending_and_the_next_refresh_adopts_it() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(9);
    h.gens(&[2]);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(0));
    h.http.push("dc.test/v1/update_two_bits", 500, b"");
    let r = ok(h.o.claim(h.ios_claim(&n, &key, "dc-9a")));
    assert_eq!(r["lease"], "none");
    assert_eq!(r["state"], "check_pending");
    let l = lease_of(&h, &n);
    assert_eq!((l.g, l.pending, l.pending_from), (0, Some(2), 0));
    // The write did land: the refresh reads it as the node's own value.
    h.at(T0 + HOUR);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(2));
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-9b")));
    assert_eq!(r["result"], "pass");
    assert_eq!(r["state"], "active");
    assert_eq!(r["reason"], "check_passed");
    assert_eq!(lease_of(&h, &n).pending, None);
}

#[test]
fn a_device_key_bound_to_another_node_is_refused() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    ios_claimed(&h, &node(10), &key, 0, "dc-10a");
    let r = h.o.claim(h.ios_claim(&node(11), &key, "dc-10b"));
    assert_eq!(refusal(r).0, Refusal::DeviceKeyInUse);
}

#[test]
fn after_stop_the_install_key_serves_another_node_once_a_day_with_one_free_switch_back() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let (a, b, c) = (node(170), node(171), node(172));
    let release = |n: &str| {
        let rel: ReleaseRequest = serde_json::from_value(json!({"node_id": n, "preimage": release_msg(n)})).unwrap();
        ok(h.o.release(rel));
    };
    h.gens(&[1, 2, 3, 1]);
    ios_claimed(&h, &a, &key, 0, "dc-170a");
    assert_eq!(refusal(h.o.claim(h.ios_claim(&b, &key, "dc-170b"))).0, Refusal::DeviceKeyInUse, "a live node holds its key");
    release(&a);
    h.at(T0 + HOUR);
    let r = ios_claimed(&h, &b, &key, 1, "dc-170c");
    assert_eq!((r["lease"].as_str(), r["effective"].as_str()), (Some("claimed_foreign"), Some("next")));
    assert_eq!(h.o.store.get::<KeyOwner>(Cf::Key, key.key_hash()).unwrap().unwrap().node, b);
    // The move counted against the key's daily limit, as a rebind would.
    release(&b);
    h.at(T0 + 2 * HOUR);
    assert_eq!(refusal(h.o.claim(h.ios_claim(&c, &key, "dc-170d"))).0, Refusal::DeviceRateLimited);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(2));
    let r = ok(h.o.claim(h.ios_claim(&a, &key, "dc-170e")));
    assert_eq!(r["effective"], "next", "switching back is free of the limit, not of the epoch rule");
    assert!(lease_of(&h, &a).strikes.is_empty(), "the value the install's last node wrote is no strike");
}

#[test]
fn a_node_moved_to_another_device_frees_the_old_install_key() {
    let h = H::new(Opts::default());
    let (k1, k2) = (DeviceKey::new(), DeviceKey::new());
    let (a, b) = (node(175), node(176));
    ios_claimed(&h, &a, &k1, 0, "dc-175a");
    h.at(T0 + HOUR);
    let r = ios_claimed(&h, &a, &k2, 0, "dc-175b");
    assert_eq!((r["superseded"].as_bool(), r["effective"].as_str()), (Some(true), Some("now")));
    h.at(T0 + 2 * HOUR);
    let r = ios_claimed(&h, &b, &k1, 2, "dc-175c");
    assert_eq!(r["effective"], "next", "a key that served a node before is never new");
    assert_eq!(refusal(h.o.claim(h.ios_claim(&node(177), &k2, "dc-175d"))).0, Refusal::DeviceKeyInUse);
}

#[test]
fn a_pause_is_not_shortened_by_stop_and_relink() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(178);
    ios_claimed(&h, &n, &key, 0, "dc-178a");
    let mut l = lease_of(&h, &n);
    l.state = State::Paused;
    l.paused_until = T0 + 30 * DAY;
    let mut b = Batch::default();
    b.put(Cf::Lease, &n, &l);
    h.o.store.commit(b, T0).unwrap();
    let rel: ReleaseRequest = serde_json::from_value(json!({"node_id": n, "preimage": release_msg(&n)})).unwrap();
    ok(h.o.release(rel));
    h.at(T0 + DAY);
    let (reason, _, until, _) = refusal(h.o.claim(h.ios_claim(&n, &key, "dc-178b")));
    assert_eq!((reason, until), (Refusal::DeviceSlotPaused, Some(T0 + 30 * DAY)));
    let (reason, _, _, _) = refusal(h.o.claim(h.ios_claim(&n, &DeviceKey::new(), "dc-178c")));
    assert_eq!(reason, Refusal::DeviceSlotPaused, "nor by a move to another device");
    h.at(T0 + 30 * DAY);
    let r = ios_claimed(&h, &n, &key, 0, "dc-178d");
    assert_eq!(r["state"], "pending_next_epoch", "the pause over, the node links again");
}

#[test]
fn the_first_slot_read_after_an_outage_claim_completes_it_without_a_strike() {
    let h = H::new(Opts::default());
    let n = node(180);
    h.http.push("dc.test/v1/query_two_bits", 503, b"");
    let r = ok(h.o.claim(h.ios_claim(&n, &DeviceKey::new(), "dc-180a")));
    assert_eq!(r["state"], "check_pending");
    h.at(T0 + HOUR);
    h.gens(&[1]);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(3));
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-180b")));
    assert_eq!((r["result"].as_str(), r["state"].as_str(), r["reason"].as_str()), (Some("pass"), Some("active"), Some("check_passed")));
    assert_eq!(h.last_dc_write(), Some(1));
    let l = lease_of(&h, &n);
    assert!(l.strikes.is_empty() && l.anomalies.is_empty());
    assert_eq!(l.g, 1);
}

#[test]
fn an_invalid_devicecheck_token_is_refused_with_a_reference_and_evidence() {
    let h = H::new(Opts::default());
    let n = node(12);
    h.http.push("dc.test/v1/query_two_bits", 400, b"Missing or badly formatted device token payload");
    let (reason, rf, _, _) = refusal(h.o.claim(h.ios_claim(&n, &DeviceKey::new(), "dc-12-secret-token")));
    assert_eq!(reason, Refusal::DeviceNotGenuine);
    let rf = rf.unwrap();
    let t = ok(h.o.tickets(&rf));
    assert_eq!(t["tickets"][0]["node_id"], n);
    assert_eq!(t["tickets"][0]["evidence"]["class"], "Refused");
    assert!(!t.to_string().contains("dc-12-secret-token"), "tokens are never stored");
}

// ---- Android claims ----

#[test]
fn android_claim_reads_and_writes_device_recall() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(20);
    h.gens(&[3]);
    let r = ok(h.o.claim(h.android_claim(&n, &key, recall_of(0, false), |_| {})));
    assert_eq!(r["lease"], "claimed_virgin");
    assert_eq!(r["effective"], "now");
    assert_eq!(h.last_recall_write(), Some((true, true, false)));
    let jws = r["pi_jws"].as_str().unwrap();
    let payload = b64url_decode_lenient(jws.split('.').nth(1).unwrap()).unwrap();
    assert_eq!(r["pi_digest"], hex::encode(sha256(&payload)));
    assert!(r["lease_statement"].as_str().unwrap().ends_with(&format!("|{}|{}", r["pi_digest"].as_str().unwrap(), T0)));
}

#[test]
fn android_without_device_recall_counts_from_the_next_epoch_on_a_one_day_lease() {
    let h = H::new(Opts::default());
    let r = ok(h.o.claim(h.android_claim(&node(21), &DeviceKey::new(), None, |v| {
        v["accountDetails"]["appLicensingVerdict"] = json!("UNEVALUATED");
    })));
    assert_eq!(r["lease"], "none");
    assert_eq!(r["effective"], "next");
    assert_eq!(r["state"], "pending_next_epoch");
    assert_eq!(r["lease_valid_until"], T0 + DAY);
    assert_eq!(h.http.count("deviceRecall:write"), 0);
}

#[test]
fn factory_provisioned_chains_get_the_one_day_lease() {
    let h = H::new(Opts::default());
    let mut req = h.android_claim(&node(22), &DeviceKey::new(), recall_of(0, false), |_| {});
    req.prov = Prov::Factory;
    let r = ok(h.o.claim(req));
    assert_eq!(r["lease_valid_until"], T0 + DAY);
    assert_eq!(r["gate"], "na");
}

#[test]
fn android_verdict_failures_are_refused_at_claim() {
    let h = H::new(Opts::default());
    let r = h.o.claim(h.android_claim(&node(23), &DeviceKey::new(), None, |v| {
        v["deviceIntegrity"]["deviceRecognitionVerdict"] = json!(["MEETS_VIRTUAL_INTEGRITY"]);
    }));
    assert_eq!(refusal(r).0, Refusal::DeviceEmulator);
    let r = h.o.claim(h.android_claim(&node(33), &DeviceKey::new(), None, |v| {
        v["deviceIntegrity"]["deviceRecognitionVerdict"] = json!([]);
    }));
    assert_eq!(refusal(r).0, Refusal::DeviceCompromised);
    let r = h.o.claim(h.android_claim(&node(34), &DeviceKey::new(), None, |v| {
        v["environmentDetails"] = json!({});
    }));
    assert_eq!(refusal(r).0, Refusal::DeviceDesktop, "a licensed store install must carry the phone-or-tablet signal");
    let r = h.o.claim(h.android_claim(&node(24), &DeviceKey::new(), None, |v| {
        v["accountDetails"]["appLicensingVerdict"] = json!("UNLICENSED");
    }));
    assert_eq!(refusal(r).0, Refusal::DeviceUnlicensed);
    let r = h.o.claim(h.android_claim(&node(25), &DeviceKey::new(), None, |v| {
        v["requestDetails"]["nonce"] = json!("not-this-request");
    }));
    assert_eq!(refusal(r).0, Refusal::DeviceStale);
}

#[test]
fn upload_key_builds_run_on_testnet_as_test_builds_and_never_on_mainnet() {
    let upload = [0x22u8; 32];
    let set_upload = |v: &mut Value| {
        v["appIntegrity"]["appRecognitionVerdict"] = json!("UNRECOGNIZED_VERSION");
        v["appIntegrity"]["certificateSha256Digest"] = json!([b64url(&upload)]);
        v["accountDetails"]["appLicensingVerdict"] = json!("UNLICENSED");
    };
    let h = H::new(Opts { test_digests: vec![upload], ..Opts::default() });
    let mut req = h.android_claim(&node(26), &DeviceKey::new(), None, set_upload);
    req.trust = Trust::Test;
    let r = ok(h.o.claim(req));
    assert_eq!(r["state"], "pending_next_epoch");
    let mut req = h.android_claim(&node(27), &DeviceKey::new(), None, set_upload);
    req.trust = Trust::Store;
    assert_eq!(refusal(h.o.claim(req)).0, Refusal::DeviceAppUnrecognized, "a test build cannot claim store trust");

    let m = H::new(Opts { network: Network::Mainnet, test_digests: vec![upload], ..Opts::default() });
    let mut req = m.android_claim(&node(28), &DeviceKey::new(), None, set_upload);
    req.trust = Trust::Test;
    assert_eq!(refusal(m.o.claim(req)).0, Refusal::DeviceAppUnrecognized);
    let mut ios = m.ios_claim(&node(29), &DeviceKey::new(), "dc-29");
    ios.trust = Trust::Test;
    assert_eq!(refusal(m.o.claim(ios)).0, Refusal::DeviceAppUnrecognized);
}

// ---- refresh rows ----

#[test]
fn refresh_passes_on_the_own_value_and_ios_rotates_it() {
    let h = H::new(Opts::default());
    let n = node(30);
    h.gens(&[1, 3]);
    ios_claimed(&h, &n, &DeviceKey::new(), 0, "dc-30a");
    h.at(T0 + 2 * DAY);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(1));
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-30b")));
    assert_eq!(r["result"], "pass");
    assert_eq!(r["reason"], "refresh_ok");
    assert_eq!(h.last_dc_write(), Some(3));
    let l = lease_of(&h, &n);
    assert_eq!((l.g, l.g_prev), (3, 1));
    assert_eq!(r["lease_valid_until"], T0 + 2 * DAY + 5 * DAY);
}

#[test]
fn refresh_reading_the_nodes_previous_value_is_a_lost_write() {
    let h = H::new(Opts::default());
    let n = node(31);
    h.gens(&[1, 2, 3]);
    ios_claimed(&h, &n, &DeviceKey::new(), 0, "dc-31a");
    h.at(T0 + DAY);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(1));
    ok(h.o.refresh(h.ios_refresh(&n, "dc-31b")));
    assert_eq!((lease_of(&h, &n).g, lease_of(&h, &n).g_prev), (2, 1));
    // The write of 2 did not persist: the slot still holds the node's own previous value.
    h.at(T0 + 2 * DAY);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(1));
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-31c")));
    assert_eq!(r["result"], "lost_write");
    assert_eq!(r["state"], "active");
    assert!(lease_of(&h, &n).strikes.is_empty());
}

#[test]
fn refresh_reading_zero_is_an_anomaly_and_two_in_90_days_make_suspect() {
    let h = H::new(Opts::default());
    let n = node(32);
    h.gens(&[1, 2, 3, 1]);
    ios_claimed(&h, &n, &DeviceKey::new(), 3, "dc-32a");
    h.at(T0 + DAY);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(0));
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-32b")));
    assert_eq!(r["result"], "anomaly");
    assert_eq!(r["state"], "active");
    h.at(T0 + 40 * DAY);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(0));
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-32c")));
    assert_eq!(r["result"], "anomaly");
    assert_eq!(r["state"], "suspect");
    assert_eq!(r["lease_valid_until"], T0 + 40 * DAY + 12 * HOUR);
}

#[test]
fn ios_second_strike_pauses_only_with_a_high_metric() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(33);
    h.gens(&[1, 2, 1, 2, 1]);
    // Claim with an attestation receipt: the exchange measures a metric of 1.
    let attest = h.receipt(&key, true, T0, None, None);
    let fresh = h.receipt(&key, false, T0, Some(1), Some(T0 + DAY));
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(0));
    h.http.push("aa.test/v1/attestationData", 200, fresh.as_bytes());
    let mut req = h.ios_claim(&n, &key, "dc-33a");
    req.receipt = Some(attest.clone());
    let r = ok(h.o.claim(req));
    assert_eq!(r["metric"], 1);
    // Strike one.
    h.at(T0 + 2 * DAY);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(3));
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-33b")));
    assert_eq!((r["result"].as_str(), r["state"].as_str()), (Some("strike"), Some("suspect")));
    // Strike two, but the fresh metric is 2: no corroboration, still suspect.
    h.at(T0 + 3 * DAY);
    let m2 = h.receipt(&key, false, T0 + 3 * DAY, Some(2), Some(T0 + 4 * DAY));
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(3));
    h.http.push("aa.test/v1/attestationData", 200, m2.as_bytes());
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-33c")));
    assert_eq!((r["result"].as_str(), r["state"].as_str()), (Some("strike"), Some("suspect")));
    // Strike three inside the window with a metric of 3: paused for 30 days, no hold on iOS.
    h.at(T0 + 4 * DAY);
    let m3 = h.receipt(&key, false, T0 + 4 * DAY, Some(3), Some(T0 + 5 * DAY));
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(3));
    h.http.push("aa.test/v1/attestationData", 200, m3.as_bytes());
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-33d")));
    assert_eq!(r["result"], "two_strikes");
    assert_eq!(r["state"], "paused");
    assert_eq!(r["paused_until"], T0 + 34 * DAY);
    assert!(h.o.store.get::<u64>(Cf::Hold, key.key_hash()).unwrap().is_none());
    // Paused: the node's refreshes and claims wait; nothing is asked of the vendor.
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-33e")));
    assert_eq!(r["result"], "paused");
    let (reason, _, until, _) = refusal(h.o.claim(h.ios_claim(&n, &key, "dc-33f")));
    assert_eq!((reason, until), (Refusal::DeviceSlotPaused, Some(T0 + 34 * DAY)));
}

#[test]
fn android_two_strikes_with_high_activity_pause_and_set_the_hold_until_support_resets() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(40);
    h.gens(&[1, 2, 1, 2, 1, 2]);
    ok(h.o.claim(h.android_claim(&n, &key, recall_of(0, false), |_| {})));
    // Strike one: another generation, low activity.
    h.at(T0 + DAY);
    let r = ok(h.o.refresh(h.android_refresh(&n, recall_of(3, false), |_| {})));
    assert_eq!(r["result"], "strike");
    // Second foreign read without corroboration.
    h.at(T0 + 2 * DAY);
    let l = lease_of(&h, &n);
    let foreign = (1..=3).find(|&g| g != l.g && g != l.g_prev).unwrap();
    let r = ok(h.o.refresh(h.android_refresh(&n, recall_of(foreign, false), |_| {})));
    assert_eq!((r["result"].as_str(), r["state"].as_str()), (Some("strike"), Some("suspect")));
    // Third, with recent device activity at level 3: paused, hold written with the rotation.
    h.at(T0 + 3 * DAY);
    let l = lease_of(&h, &n);
    let foreign = (1..=3).find(|&g| g != l.g && g != l.g_prev).unwrap();
    let r = ok(h.o.refresh(h.android_refresh(&n, recall_of(foreign, false), |v| {
        v["deviceIntegrity"]["recentDeviceActivity"]["deviceActivityLevel"] = json!("LEVEL_3");
    })));
    assert_eq!(r["result"], "two_strikes");
    assert_eq!(r["state"], "paused");
    let rf = r["ref"].as_str().unwrap().to_string();
    assert!(h.last_recall_write().unwrap().2, "the hold bit is set with the pause");
    assert_eq!(h.o.store.get::<u64>(Cf::Hold, key.key_hash()).unwrap(), Some(T0 + 3 * DAY));
    let tickets = ok(h.o.tickets(&rf));
    assert_eq!(tickets["tickets"][0]["reason"], "two_strikes");
    assert_eq!(tickets["tickets"][0]["evidence"]["class"], "Paused");

    // Another node on the same device sees the hold and is refused, with its own reference.
    let other = node(41);
    let (reason, other_ref, until, _) = refusal(h.o.claim(h.android_claim(&other, &DeviceKey::new(), recall_of(2, true), |v| {
        v["deviceIntegrity"]["deviceRecall"]["writeDates"]["yyyymmThird"] = json!(202609);
    })));
    assert_eq!(reason, Refusal::DeviceSlotPaused);
    assert_eq!(until, Some(crate::civil::month_start(2026, 9) + 30 * DAY), "a dated hold lasts at most 30 days");
    let other_ref = other_ref.unwrap();

    // Support approves that reference; the next claim carrying it clears the slot and the hold.
    let approved = ok(h.o.approve(ApproveRequest { reference: other_ref.clone(), node_id: None, operator: "support-1".into() }));
    assert_eq!(approved["node_id"], other);
    let mut req = h.android_claim(&other, &DeviceKey::new(), recall_of(2, true), |_| {});
    req.reset_ref = Some(other_ref.clone());
    let r = ok(h.o.claim(req));
    assert_eq!(r["lease"], "claimed_virgin");
    assert_eq!(r["reset"], true);
    let w = h.last_recall_write().unwrap();
    assert!(!w.2, "the hold is cleared with the claim");
    assert_ne!(g_of(w), 2);
    let mut again = h.android_claim(&other, &DeviceKey::new(), recall_of(2, true), |_| {});
    again.reset_ref = Some(other_ref);
    assert_eq!(refusal(h.o.claim(again)).0, Refusal::DeviceSlotPaused, "a ticket is used once");
}

#[test]
fn an_exact_hold_expires_after_30_days_for_the_install_that_carries_it() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(42);
    ok(h.o.claim(h.android_claim(&n, &key, recall_of(0, false), |_| {})));
    let mut b = Batch::default();
    b.put(Cf::Hold, key.key_hash(), &(T0 + DAY));
    h.o.store.commit(b, T0).unwrap();
    h.at(T0 + 20 * DAY);
    let r = ok(h.o.refresh(h.android_refresh(&n, recall_of(1, true), |_| {})));
    assert_eq!(r["result"], "hold");
    assert_eq!(r["paused_until"], T0 + 31 * DAY);
    h.at(T0 + 32 * DAY);
    let own = lease_of(&h, &n).g;
    let r = ok(h.o.refresh(h.android_refresh(&n, recall_of(own, true), |_| {})));
    assert_eq!(r["result"], "pass");
    assert!(!h.last_recall_write().unwrap().2, "the expired hold is cleared");
    assert!(h.o.store.get::<u64>(Cf::Hold, key.key_hash()).unwrap().is_none());
}

#[test]
fn android_refresh_rotates_every_second_time_and_a_failed_verdict_is_a_check() {
    let h = H::new(Opts::default());
    let n = node(43);
    h.gens(&[1, 3]);
    ok(h.o.claim(h.android_claim(&n, &DeviceKey::new(), recall_of(0, false), |_| {})));
    let writes = h.http.count("deviceRecall:write");
    h.at(T0 + DAY);
    ok(h.o.refresh(h.android_refresh(&n, recall_of(1, false), |_| {})));
    assert_eq!(h.http.count("deviceRecall:write"), writes, "first refresh: no write");
    h.at(T0 + 2 * DAY);
    ok(h.o.refresh(h.android_refresh(&n, recall_of(1, false), |_| {})));
    assert_eq!(h.http.count("deviceRecall:write"), writes + 1, "second refresh rotates");
    h.at(T0 + 3 * DAY);
    let r = ok(h.o.refresh(h.android_refresh(&n, recall_of(3, false), |v| {
        v["deviceIntegrity"]["deviceRecognitionVerdict"] = json!([]);
    })));
    assert_eq!(r["result"], "check_pending");
    assert_eq!(r["reason"], "verdict_failed");
    assert_eq!(lease_of(&h, &n).state, State::CheckPending);
}

// ---- outages ----

#[test]
fn an_outage_extends_clean_leases_up_to_seven_days_and_never_suspect_ones() {
    let h = H::new(Opts::default());
    let n = node(50);
    ios_claimed(&h, &n, &DeviceKey::new(), 0, "dc-50a");
    let base = lease_of(&h, &n).lease_base;
    h.at(base - HOUR);
    h.http.push("dc.test/v1/query_two_bits", 503, b"");
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-50b")));
    assert_eq!(r["result"], "deferred");
    assert_eq!(r["extended"], true);
    assert_eq!(r["lease_valid_until"], base + HOUR);
    h.at(base + 20 * DAY);
    h.http.push("dc.test/v1/query_two_bits", 503, b"");
    let r = ok(h.o.refresh(h.ios_refresh(&n, "dc-50c")));
    assert_eq!(r["lease_valid_until"], base + 7 * DAY, "capped at seven days");

    let s = node(51);
    h.at(T0);
    h.gens(&[1, 2]);
    ios_claimed(&h, &s, &DeviceKey::new(), 0, "dc-51a");
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(3));
    h.at(T0 + HOUR);
    ok(h.o.refresh(h.ios_refresh(&s, "dc-51b")));
    h.http.push("dc.test/v1/query_two_bits", 503, b"");
    let r = ok(h.o.refresh(h.ios_refresh(&s, "dc-51c")));
    assert_eq!(r["extended"], false);
}

#[test]
fn repeated_vendor_failures_raise_one_outage_alert_and_a_recovery() {
    let h = H::new(Opts::default());
    for i in 0..4 {
        h.http.push("dc.test/v1/query_two_bits", 503, b"");
        ok(h.o.claim(h.ios_claim(&node(60 + i), &DeviceKey::new(), &format!("dc-60-{}", i))));
    }
    ios_claimed(&h, &node(70), &DeviceKey::new(), 0, "dc-70");
    let kinds: Vec<String> = h.o.alerts.raised.lock().iter().map(|(_, k)| k.clone()).collect();
    assert_eq!(kinds.iter().filter(|k| *k == "vendor_outage_devicecheck").count(), 1);
    assert!(kinds.contains(&"vendor_recovered_devicecheck".to_string()));
}

// ---- gates ----

#[test]
fn android_certificate_gate_is_log_only_until_enforced() {
    let key_a = DeviceKey::new();
    let h = H::new(Opts::default());
    let mut req = h.android_claim(&node(80), &key_a, recall_of(0, false), |_| {});
    req.certs_issued = Some(500);
    let r = ok(h.o.claim(req));
    assert_eq!((r["gate"].as_str(), r["gate_observed"].as_str(), r["state"].as_str()), (Some("ok"), Some("certs_high"), Some("active")));
    assert!(r["lease_statement"].as_str().unwrap().contains("|now|ok|"));

    let e = H::new(Opts { enforce: true, ..Opts::default() });
    let mut req = e.android_claim(&node(81), &DeviceKey::new(), recall_of(0, false), |_| {});
    req.certs_issued = Some(500);
    let r = ok(e.o.claim(req));
    assert_eq!((r["gate"].as_str(), r["state"].as_str(), r["check"].as_str()), (Some("certs_high"), Some("check_pending"), Some("certs_high")));
    assert!(r["lease_statement"].as_str().unwrap().contains("|certs_high|"));
}

#[test]
fn ios_metric_gate_holds_back_until_a_daily_recheck_sees_it_fall() {
    let h = H::new(Opts { enforce: true, ..Opts::default() });
    let key = DeviceKey::new();
    let n = node(82);
    let attest = h.receipt(&key, true, T0, None, None);
    let high = h.receipt(&key, false, T0, Some(6), Some(T0 + DAY));
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(0));
    h.http.push("aa.test/v1/attestationData", 200, high.as_bytes());
    let mut req = h.ios_claim(&n, &key, "dc-82a");
    req.receipt = Some(attest.clone());
    let r = ok(h.o.claim(req));
    assert_eq!((r["gate"].as_str(), r["state"].as_str()), (Some("metric_high"), Some("check_pending")));
    // Before the receipt's not-before nothing is asked of Apple.
    let r = ok(h.o.recheck(NodeRequest { node_id: n.clone() }));
    assert_eq!(r["state"], "check_pending");
    assert_eq!(r["next_check_at"], T0 + DAY);
    h.at(T0 + DAY + 60);
    let low = h.receipt(&key, false, T0 + DAY, Some(2), Some(T0 + 2 * DAY));
    h.http.push("aa.test/v1/attestationData", 200, low.as_bytes());
    let r = ok(h.o.recheck(NodeRequest { node_id: n.clone() }));
    assert_eq!((r["state"].as_str(), r["reason"].as_str(), r["metric"].as_u64()), (Some("active"), Some("check_passed"), Some(2)));
}

#[test]
fn a_receipt_for_another_key_or_app_is_refused() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let other = DeviceKey::new();
    let attest = h.receipt(&other, true, T0, None, None);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(0));
    let mut req = h.ios_claim(&node(83), &key, "dc-83");
    req.receipt = Some(attest.clone());
    assert_eq!(refusal(h.o.claim(req)).0, Refusal::DeviceNotGenuine);
}

#[test]
fn a_stale_or_wrongly_signed_metric_receipt_is_not_trusted() {
    let h = H::new(Opts { enforce: true, ..Opts::default() });
    let key = DeviceKey::new();
    let attest = h.receipt(&key, true, T0, None, None);
    let stale = h.receipt(&key, false, T0 - 3600, Some(1), None);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(0));
    h.http.push("aa.test/v1/attestationData", 200, stale.as_bytes());
    let mut req = h.ios_claim(&node(84), &key, "dc-84");
    req.receipt = Some(attest.clone());
    let r = ok(h.o.claim(req));
    assert_eq!(r["state"], "check_pending", "an unusable metric keeps an enforced gate pending");
    assert!(h.o.alerts.raised.lock().iter().any(|(_, k)| k == "receipt_invalid"));
}

// ---- limits ----

#[test]
fn node_bindings_are_limited_to_six_a_day() {
    let h = H::new(Opts::default());
    let n = node(90);
    for i in 0..6 {
        h.at(T0 + i * 60);
        ios_claimed(&h, &n, &DeviceKey::new(), 3, &format!("dc-90-{}", i));
    }
    h.at(T0 + 400);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(3));
    let (reason, _, _, retry) = refusal(h.o.claim(h.ios_claim(&n, &DeviceKey::new(), "dc-90-x")));
    assert_eq!((reason, retry), (Refusal::DeviceRateLimited, Some(T0 + DAY)));
}

#[test]
fn a_counted_claim_over_the_node_limit_is_refused_before_any_vendor_call() {
    let h = H::new(Opts::default());
    let n = node(95);
    for i in 0..6 {
        h.at(T0 + i * 60);
        h.http.push("dc.test/v1/query_two_bits", 503, b"");
        ok(h.o.claim(h.ios_claim(&n, &DeviceKey::new(), &format!("dc-95-{}", i))));
    }
    let calls = h.http.count("query_two_bits");
    h.at(T0 + 400);
    let (reason, _, _, retry) = refusal(h.o.claim(h.ios_claim(&n, &DeviceKey::new(), "dc-95-x")));
    assert_eq!((reason, retry), (Refusal::DeviceRateLimited, Some(T0 + DAY)));
    assert_eq!(h.http.count("query_two_bits"), calls, "the limit guards vendor quota");
}

#[test]
fn a_rebind_moves_the_key_once_a_day_with_one_free_switch_back() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let (a, b, c) = (node(91), node(92), node(93));
    h.gens(&[1, 2, 3, 1]);
    ios_claimed(&h, &a, &key, 0, "dc-91a");
    let rebind = |from: &str, to: &str, token: &str| -> ClaimRequest {
        serde_json::from_value(json!({
            "node_id": to, "platform": "ios", "op": "rebind", "preimage": rebind_msg(from, to), "hw_pub": key.hex(),
            "prov": "na", "trust": "store", "dc_token": token,
        }))
        .unwrap()
    };
    h.at(T0 + HOUR);
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(1));
    let r = ok(h.o.claim(rebind(&a, &b, "dc-91b")));
    assert_eq!((r["lease"].as_str(), r["effective"].as_str()), (Some("claimed_foreign"), Some("next")));
    assert_eq!(r["rebound_from"], a);
    assert_eq!(lease_of(&h, &a).state, State::Ended);
    h.at(T0 + 2 * HOUR);
    let calls = h.http.count("query_two_bits");
    assert_eq!(refusal(h.o.claim(rebind(&b, &c, "dc-91c"))).0, Refusal::DeviceRateLimited);
    assert_eq!(h.http.count("query_two_bits"), calls, "refused before any vendor call");
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(2));
    let r = ok(h.o.claim(rebind(&b, &a, "dc-91d")));
    assert_eq!(r["effective"], "next", "switching back is free of the limit, not of the epoch rule");
    assert_eq!(lease_of(&h, &b).state, State::Ended);
    assert!(lease_of(&h, &a).strikes.is_empty(), "a switch back inside the install is no strike");
}

#[test]
fn an_attestation_key_allows_two_foreign_claims_a_day() {
    let h = H::new(Opts::default());
    for i in 0..2 {
        ok(h.o.claim(h.android_claim(&node(100 + i), &DeviceKey::new(), recall_of(3, false), |_| {})));
    }
    let r = h.o.claim(h.android_claim(&node(102), &DeviceKey::new(), recall_of(3, false), |_| {}));
    assert_eq!(refusal(r).0, Refusal::DeviceRateLimited);
    ok(h.o.claim(h.android_claim(&node(103), &DeviceKey::new(), recall_of(0, false), |_| {})));
}

#[test]
fn a_factory_attestation_key_is_shared_by_a_batch_and_carries_no_per_key_limit_or_signal() {
    let h = H::new(Opts::default());
    for i in 0..3 {
        let n = node(105 + i);
        let mut req = h.android_claim(&n, &DeviceKey::new(), recall_of(3, false), |_| {});
        req.prov = Prov::Factory;
        req.att_key_multi = true;
        let r = ok(h.o.claim(req));
        assert_eq!((r["lease"].as_str(), r["lease_valid_until"].as_u64()), (Some("claimed_foreign"), Some(T0 + DAY)));
        let l = lease_of(&h, &n);
        assert_eq!((l.att_key, l.att_key_multi), (None, false));
    }
}

#[test]
fn the_per_ip_limit_is_thirty_an_hour() {
    let h = H::new(Opts::default());
    for i in 0..30 {
        let mut req = h.android_claim(&node(200 + i), &DeviceKey::new(), recall_of(0, false), |_| {});
        req.client_ip = Some("198.51.100.4".into());
        req.att_key = None;
        ok(h.o.claim(req));
    }
    let mut req = h.android_claim(&node(300), &DeviceKey::new(), recall_of(0, false), |_| {});
    req.client_ip = Some("198.51.100.4".into());
    assert_eq!(refusal(h.o.claim(req)).0, Refusal::DeviceRateLimited);
}

// ---- replay ----

#[test]
fn a_retry_gets_the_first_answer_and_a_replay_is_refused() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(110);
    let req = h.ios_claim(&n, &key, "dc-110");
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(0));
    let first = ok(h.o.claim(req.clone()));
    let again = ok(h.o.claim(req.clone()));
    assert_eq!(first, again);
    assert_eq!(h.http.count("query_two_bits"), 1);
    h.at(T0 + 3600);
    assert_eq!(refusal(h.o.claim(req)).0, Refusal::DeviceStale);
    h.at(T0 + DAY + 1);
    h.o.maintain();
    assert!(h.o.store.get::<u64>(Cf::Replay, sha256(b"dc-110")).unwrap().is_none(), "token hashes are kept 24 hours");
}

#[test]
fn unbound_tokens_raise_the_quota_burn_alarm() {
    let h = H::new(Opts { bad_tokens_hourly: 3, ..Opts::default() });
    for i in 0..3 {
        let r = h.o.claim(h.android_claim(&node(120 + i), &DeviceKey::new(), None, |v| {
            // A well-formed nonce of another request.
            v["requestDetails"]["nonce"] = json!(fresh_nonce());
        }));
        assert_eq!(refusal(r).0, Refusal::DeviceStale);
    }
    assert!(h.o.alerts.raised.lock().iter().any(|(_, k)| k == "quota_burn"));
}

// ---- rotation ----

#[test]
fn rotation_moves_the_node_to_the_new_key_and_keeps_its_slot() {
    let h = H::new(Opts::default());
    let old = DeviceKey::new();
    let new = DeviceKey::new();
    let n = node(130);
    h.gens(&[2, 1]);
    ios_claimed(&h, &n, &old, 0, "dc-130a");
    // Rows of the old key: its receipt, the install's hold record and its rebind history.
    let mut b = Batch::default();
    let old_receipt = StoredReceipt { der: vec![1], not_before: T0, expires: T0 + 90 * DAY, metric: Some(1), measured_at: T0 };
    b.put(Cf::Receipt, old.key_hash(), &old_receipt);
    b.put(Cf::Hold, old.key_hash(), &(T0 + 5));
    let mut rebinds = KeyRebinds::default();
    rebinds.record(&node(1), &node(2), false, T0);
    b.put(Cf::Limit, format!("k:{}", old.key_hash()), &rebinds);
    h.o.store.commit(b, T0).unwrap();
    h.at(T0 + 30 * DAY);
    let attest = h.receipt(&new, true, T0 + 30 * DAY, None, None);
    let fresh = h.receipt(&new, false, T0 + 30 * DAY, Some(2), Some(T0 + 31 * DAY));
    h.http.push("dc.test/v1/query_two_bits", 200, &dc_bits(2));
    h.http.push("aa.test/v1/attestationData", 200, fresh.as_bytes());
    let req: RotateRequest = serde_json::from_value(json!({
        "node_id": n, "preimage": rotate_msg(&n, &old.key_hash()), "hw_pub": new.hex(), "prov": "na", "trust": "store",
        "receipt": attest, "dc_token": "dc-130b",
    }))
    .unwrap();
    let r = ok(h.o.rotate(req));
    assert_eq!((r["lease"].as_str(), r["effective"].as_str(), r["state"].as_str()), (Some("self_reclaim"), Some("now"), Some("active")));
    let tag = device_tag("1337", Platform::Ios, &new.public);
    assert_eq!(r["device_tag"], hex::encode(tag));
    let l = lease_of(&h, &n);
    assert_eq!(l.hw_key, new.key_hash());
    assert_eq!(l.metric, Some(2));
    assert_eq!(h.o.store.get::<KeyOwner>(Cf::Key, new.key_hash()).unwrap().unwrap().node, n);
    assert!(h.o.store.get::<StoredReceipt>(Cf::Receipt, old.key_hash()).unwrap().is_none(), "the retired key's receipt is dropped");
    assert!(h.o.store.get::<StoredReceipt>(Cf::Receipt, new.key_hash()).unwrap().is_some());
    assert_eq!(h.o.store.get::<u64>(Cf::Hold, new.key_hash()).unwrap(), Some(T0 + 5));
    assert!(h.o.store.get::<u64>(Cf::Hold, old.key_hash()).unwrap().is_none());
    let moved: Option<KeyRebinds> = h.o.store.get(Cf::Limit, format!("k:{}", new.key_hash())).unwrap();
    assert_eq!(moved, Some(rebinds), "a rotation does not reset the key's rebind limit");
    // The old key cannot be rotated from again, and the new key cannot join another node.
    let stale: RotateRequest = serde_json::from_value(json!({
        "node_id": n, "preimage": rotate_msg(&n, &old.key_hash()), "hw_pub": DeviceKey::new().hex(), "prov": "na",
        "trust": "store", "dc_token": "dc-130c",
    }))
    .unwrap();
    assert_eq!(h.o.rotate(stale), Err(ApiError::Conflict("key_mismatch")));
    assert_eq!(refusal(h.o.claim(h.ios_claim(&node(131), &new, "dc-131"))).0, Refusal::DeviceKeyInUse);
}

#[test]
fn a_rotation_during_an_outage_changes_nothing() {
    let h = H::new(Opts::default());
    let old = DeviceKey::new();
    let n = node(132);
    ios_claimed(&h, &n, &old, 0, "dc-132a");
    h.http.push("dc.test/v1/query_two_bits", 503, b"");
    let req: RotateRequest = serde_json::from_value(json!({
        "node_id": n, "preimage": rotate_msg(&n, &old.key_hash()), "hw_pub": DeviceKey::new().hex(), "prov": "na",
        "trust": "store", "dc_token": "dc-132b",
    }))
    .unwrap();
    assert!(matches!(h.o.rotate(req), Err(ApiError::Unavailable(_))));
    assert_eq!(lease_of(&h, &n).hw_key, old.key_hash());
}

// ---- revocation snapshot, refusals filed by the genesis, replication ----

#[test]
fn the_revocation_snapshot_is_signed_and_a_stale_one_alerts() {
    let h = H::new(Opts::default());
    assert!(h.o.crl_snapshot().is_err());
    h.http.push("crl.test", 200, br#"{"entries":{"0A":{"status":"REVOKED"},"b":{"status":"SUSPENDED"},"c":{"status":"FINE"}}}"#);
    let next = h.o.refresh_crl();
    assert_eq!(next, DAY);
    let s = ok(h.o.crl_snapshot());
    assert_eq!(s["serials"], json!(["a", "b"]));
    let sig = hex::decode(s["sig"].as_str().unwrap()).unwrap();
    assert!(crate::signer::verify(h.o.signer.public_key(), s["preimage"].as_str().unwrap().as_bytes(), &sig));
    h.at(T0 + 2 * DAY);
    h.http.push("crl.test", 503, b"");
    h.o.refresh_crl();
    assert!(h.o.alerts.raised.lock().iter().any(|(_, k)| k == "crl_stale"));
    assert!(h.o.crl_snapshot().is_ok(), "the last snapshot is still served");
}

#[test]
fn a_refusal_filed_by_the_genesis_gets_the_reference_the_device_shows() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let nonce = fresh_nonce();
    let n = node(140);
    let r = ok(h.o.file_refusal(RefusalRequest {
        node_id: n.clone(),
        platform: Platform::Android,
        hw_pub: key.hex(),
        nonce: nonce.clone(),
        reason: "device_desktop".into(),
        evidence: Some(json!({"chain": ["..."]})),
    }));
    let tag = device_tag("1337", Platform::Android, &key.public);
    let expect = reference(&b64url_decode(&nonce).unwrap().try_into().unwrap(), &tag);
    assert_eq!(r["ref"], expect);
    let t = ok(h.o.tickets(&expect));
    assert_eq!(t["tickets"][0]["reason"], "device_desktop");
    assert_eq!(t["tickets"][0]["evidence"]["body"]["evidence"]["chain"][0], "...");
}

#[test]
fn maintenance_drops_tickets_after_90_days() {
    let h = H::new(Opts::default());
    let filed = |n: u64| {
        let r = ok(h.o.file_refusal(RefusalRequest {
            node_id: node(n),
            platform: Platform::Ios,
            hw_pub: DeviceKey::new().hex(),
            nonce: fresh_nonce(),
            reason: "device_desktop".into(),
            evidence: None,
        }));
        r["ref"].as_str().unwrap().to_string()
    };
    let (a, b) = (filed(142), filed(143));
    let count = |rf: &str| ok(h.o.tickets(rf))["tickets"].as_array().unwrap().len();
    h.at(T0 + 89 * DAY);
    h.o.maintain();
    assert_eq!((count(&a), count(&b)), (1, 1));
    h.at(T0 + 91 * DAY);
    h.o.maintain();
    assert_eq!((count(&a), count(&b)), (0, 0));
}

#[test]
fn a_standby_catches_up_from_the_log_and_from_a_full_dump() {
    let h = H::new(Opts::default());
    ios_claimed(&h, &node(150), &DeviceKey::new(), 0, "dc-150");
    let d = tempfile::tempdir().unwrap();
    let standby = Store::open(d.path()).unwrap();
    // Full dump, page by page.
    let status = h.o.replica_status();
    for cf in Cf::ALL {
        let mut after: Option<String> = None;
        loop {
            let p = ok(h.o.replica_dump(cf.name(), after.as_deref(), 2));
            let page: Vec<(Vec<u8>, Vec<u8>)> = bincode::deserialize(&b64_decode(p["page"].as_str().unwrap()).unwrap()).unwrap();
            if page.is_empty() {
                break;
            }
            standby.put_snapshot_page(cf, &page).unwrap();
            after = p["last"].as_str().map(str::to_string);
        }
    }
    standby.finish_sync(status["seq"].as_u64().unwrap()).unwrap();
    // New writes flow through the log.
    ios_claimed(&h, &node(151), &DeviceKey::new(), 0, "dc-151");
    let log = ok(h.o.replica_log(standby.seq(), 100));
    let entries: Vec<crate::store::LogEntry> = bincode::deserialize(&b64_decode(log["entries"].as_str().unwrap()).unwrap()).unwrap();
    for e in &entries {
        standby.apply_replica(e).unwrap();
    }
    for n in [node(150), node(151)] {
        assert_eq!(standby.get::<NodeLease>(Cf::Lease, &n).unwrap(), h.o.store.get::<NodeLease>(Cf::Lease, &n).unwrap());
    }
}

#[test]
fn preimages_that_do_not_match_the_request_are_bad_requests() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let mut req = h.ios_claim(&node(160), &key, "dc-160");
    req.node_id = node(161);
    assert!(matches!(h.o.claim(req), Err(ApiError::BadRequest(_))));
    let mut req = h.ios_claim(&node(162), &key, "dc-162");
    req.preimage = refresh_msg(&node(162));
    assert!(matches!(h.o.claim(req), Err(ApiError::BadRequest(_))));
    let mut req = h.ios_claim(&node(163), &key, "dc-163");
    req.prov = Prov::Rkp;
    assert!(matches!(h.o.claim(req), Err(ApiError::BadRequest(_))));
    let mut req = h.ios_claim(&node(165), &key, "dc-165");
    req.preimage = enrol_android(&node(165));
    assert!(matches!(h.o.claim(req), Err(ApiError::BadRequest(_))), "Android flags on an iOS claim");
    let req = h.ios_refresh(&node(164), "dc-164");
    assert_eq!(h.o.refresh(req), Err(ApiError::NotFound("unknown_node")));
}

// ---- a claim by the install that already holds the node's value ----

#[test]
fn a_same_key_reclaim_over_another_installs_value_is_a_strike_with_the_suspect_window() {
    let h = H::new(Opts { background_tokens: false, ..Opts::default() });
    let key = DeviceKey::new();
    let n = node(185);
    h.gens(&[1, 3]);
    ios_claimed(&h, &n, &key, 0, "dc-185a");
    // Another install on the device wrote 2; the node claims again instead of refreshing.
    h.at(T0 + DAY);
    let r = ios_claimed(&h, &n, &key, 2, "dc-185b");
    assert_eq!((r["lease"].as_str(), r["effective"].as_str()), (Some("claimed_foreign"), Some("next")));
    assert_eq!(lease_of(&h, &n).strikes, vec![T0 + DAY]);
    assert_eq!(r["lease_valid_until"], T0 + DAY + 12 * HOUR, "not the 21-day window of a fresh claim");
    // Its own value is still a free self-reclaim, suspect while the strike lives.
    h.at(T0 + DAY + HOUR);
    let r = ios_claimed(&h, &n, &key, 3, "dc-185c");
    assert_eq!((r["lease"].as_str(), r["state"].as_str()), (Some("self_reclaim"), Some("suspect")));
    assert_eq!(r["lease_valid_until"], T0 + DAY + HOUR + 12 * HOUR);
}

#[test]
fn two_installs_that_reclaim_instead_of_refreshing_are_struck_and_paused() {
    let h = H::new(Opts::default());
    let (ka, kb) = (DeviceKey::new(), DeviceKey::new());
    let (a, b) = (node(186), node(187));
    h.gens(&[1, 2, 3, 1, 2]);
    ok(h.o.claim(h.android_claim(&a, &ka, recall_of(0, false), |_| {})));
    let r = ok(h.o.claim(h.android_claim(&b, &kb, recall_of(1, false), |_| {})));
    assert_eq!(r["lease"], "claimed_foreign");
    assert!(lease_of(&h, &b).strikes.is_empty(), "a new node on a used slot is no strike");
    // Next day each claims again over the value the other wrote.
    h.at(T0 + DAY);
    let r = ok(h.o.claim(h.android_claim(&a, &ka, recall_of(2, false), |_| {})));
    assert_eq!(r["lease"], "claimed_foreign");
    assert_eq!(lease_of(&h, &a).strikes, vec![T0 + DAY]);
    ok(h.o.claim(h.android_claim(&b, &kb, recall_of(3, false), |_| {})));
    assert_eq!(lease_of(&h, &b).strikes, vec![T0 + DAY]);
    // A second foreign read inside the window, with high device activity: paused, the hold on the slot.
    h.at(T0 + 2 * DAY);
    let (reason, rf, until, _) = refusal(h.o.claim(h.android_claim(&a, &ka, recall_of(1, false), |v| {
        v["deviceIntegrity"]["recentDeviceActivity"]["deviceActivityLevel"] = json!("LEVEL_3");
    })));
    assert_eq!((reason, until), (Refusal::DeviceSlotPaused, Some(T0 + 32 * DAY)));
    let l = lease_of(&h, &a);
    assert_eq!((l.state, l.paused_until, l.strikes.len(), l.hold_set_at), (State::Paused, T0 + 32 * DAY, 2, T0 + 2 * DAY));
    assert!(h.last_recall_write().unwrap().2, "the pause writes the hold");
    assert_eq!(h.o.store.get::<u64>(Cf::Hold, ka.key_hash()).unwrap(), Some(T0 + 2 * DAY));
    assert_eq!(ok(h.o.tickets(&rf.unwrap()))["tickets"][0]["reason"], "two_strikes");
    let r = ok(h.o.refresh(h.android_refresh(&a, recall_of(2, true), |_| {})));
    assert_eq!(r["result"], "paused");
}

#[test]
fn stop_and_a_same_key_reclaim_over_another_installs_value_is_a_strike() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(188);
    h.gens(&[1]);
    ios_claimed(&h, &n, &key, 0, "dc-188a");
    let rel: ReleaseRequest = serde_json::from_value(json!({"node_id": n, "preimage": release_msg(&n)})).unwrap();
    ok(h.o.release(rel));
    h.at(T0 + DAY);
    let r = ios_claimed(&h, &n, &key, 2, "dc-188b");
    assert_eq!((r["lease"].as_str(), r["effective"].as_str()), (Some("claimed_foreign"), Some("next")));
    assert_eq!(lease_of(&h, &n).strikes, vec![T0 + DAY], "Stop and re-link does not skip the slot check");
}

// ---- unreadable records ----

#[test]
fn an_unreadable_record_answers_an_internal_error_and_never_a_fresh_claim() {
    let h = H::new(Opts::default());
    let key = DeviceKey::new();
    let n = node(189);
    let mut b = Batch::default();
    b.put_raw(Cf::Lease, &n, vec![7]);
    h.o.store.commit(b, T0).unwrap();
    assert!(matches!(h.o.claim(h.ios_claim(&n, &key, "dc-189a")), Err(ApiError::Internal(_))));
    assert_eq!(h.http.count("query_two_bits"), 0, "no vendor call on a record the oracle cannot read");
    assert!(matches!(h.o.refresh(h.ios_refresh(&n, "dc-189b")), Err(ApiError::Internal(_))));
    // An unreadable key owner is not a free key either.
    let mut b = Batch::default();
    b.put_raw(Cf::Key, key.key_hash(), vec![7]);
    h.o.store.commit(b, T0).unwrap();
    assert!(matches!(h.o.claim(h.ios_claim(&node(190), &key, "dc-190")), Err(ApiError::Internal(_))));
}

// ---- a gate hold and fresh evidence ----

#[test]
fn an_android_certificate_hold_asks_for_a_rotation_and_the_rotation_releases_it() {
    let h = H::new(Opts { enforce: true, ..Opts::default() });
    let old = DeviceKey::new();
    let n = node(191);
    let mut req = h.android_claim(&n, &old, recall_of(0, false), |_| {});
    req.certs_issued = Some(500);
    let r = ok(h.o.claim(req));
    assert_eq!((r["state"].as_str(), r["check"].as_str()), (Some("check_pending"), Some("certs_high")));
    // The stored count never falls: the daily recheck says a new chain is needed.
    h.at(T0 + DAY);
    let r = ok(h.o.recheck(NodeRequest { node_id: n.clone() }));
    assert_eq!((r["state"].as_str(), r["needs"].as_str()), (Some("check_pending"), Some("rotation")));
    let rotate = |key: &DeviceKey, from: &str, certs: u32| -> RotateRequest {
        let pre = rotate_msg(&n, from);
        let token = h.pi_token(&play_nonce(&pre), recall_of(lease_of(&h, &n).g, false), |_| {});
        serde_json::from_value(json!({"node_id": n, "preimage": pre, "hw_pub": key.hex(), "prov": "rkp", "trust": "store",
                                      "pi_token": token, "att_key": "bb".repeat(32), "certs_issued": certs}))
        .unwrap()
    };
    // A new chain that still counts too many keeps the hold.
    h.at(T0 + 2 * DAY);
    let k2 = DeviceKey::new();
    let r = ok(h.o.rotate(rotate(&k2, &old.key_hash(), 300)));
    assert_eq!(r["state"], "check_pending");
    assert_eq!(lease_of(&h, &n).check, Some(Reason::CertsHigh));
    // One that passes ends it with the rotation, and the node keeps counting at its next refresh.
    h.at(T0 + 3 * DAY);
    let k3 = DeviceKey::new();
    let r = ok(h.o.rotate(rotate(&k3, &k2.key_hash(), 20)));
    assert_eq!((r["state"].as_str(), r["gate"].as_str()), (Some("active"), Some("ok")));
    h.at(T0 + 4 * DAY);
    let own = lease_of(&h, &n).g;
    let r = ok(h.o.refresh(h.android_refresh(&n, recall_of(own, false), |_| {})));
    assert_eq!(r["state"], "active");
    assert!(ok(h.o.recheck(NodeRequest { node_id: n.clone() }))["needs"].is_null());
}
