//! The device layer's upkeep (A13-A16, A20) with the five genesis of the enrolment tests: the revocation
//! snapshot and the pause it causes, the daily recheck of a gate-held node, every stated refusal, and the
//! check that none of it touches what the chain replays.

use super::*;
use crate::light_device::crl;
use qnet_device_attest::revocation::RevocationList;

/// The three column families of the device layer: operational state of the five genesis, never consensus.
const DEVICE_CFS: [&str; 3] = ["light_device", "light_device_key", "light_device_attkey"];

#[test]
fn a_revoked_chain_pauses_its_node_everywhere_until_a_new_enrolment() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Lease(LeaseKind::SelfReclaim, "active"));
    let b = enrol(&net, Platform::Android, o, "203.0.113.60");
    let serial = fake_serial(&[3u8; 65]);
    let r = net.stores[0].device_record(&b.w.node).unwrap();
    assert_eq!(r.serials, vec![serial.clone()]);
    assert_eq!(net.stores[3].device_nodes_by_serial(&crl::normal_serial(&serial).unwrap(), 10), vec![b.w.node.clone()],
               "every genesis indexes the chain it recorded");
    let ctx = net.ctx(0, Some(o), &[1, 2, 3, 4]);
    // A list that names another chain pauses nothing; the chain's own serial, in the list's form, pauses it once.
    assert_eq!(pause_revoked(&ctx, &RevocationList::from_serials(["abc"]).unwrap()), 0);
    let list = RevocationList::from_serials([serial.as_str()]).unwrap();
    assert_eq!(pause_revoked(&ctx, &list), 1);
    assert_eq!(pause_revoked(&ctx, &list), 0, "once");
    let r = net.stores[0].device_record(&b.w.node).unwrap();
    assert_eq!((r.state, r.reason.as_str(), r.until_epoch), (DeviceState::Paused, ld::record::REVOKED, 0));
    // The signed change reaches the other four as its push does, and holds there too.
    let change = r.last_change.clone().unwrap();
    for (j, s) in net.stores.iter().enumerate().skip(1) {
        let got = apply_sync(s, net.genesis, false, &DeviceSync { bundle: None, change: Some(change.clone()) }, Some(&net.id(j)), now(), net.epoch);
        assert_eq!(got, Ok("changed"));
    }
    let c = anchor_at(&net, H);
    let t = now() * 1000;
    assert_eq!(verify(&net, 2, &b.w.node, &c, &hw_reply(&net, &b, &b.kp, &c, t), Route::Ingress, H + 5), Err(ReplyRefusal::NotCounted));
    assert!(!crate::rpc::device_pushable_at(&net.stores[2], &b.w.node, net.epoch, now()), "not pushed");
    // A later lighter change never lifts it, whatever its sequence.
    let held = net.stores[1].device_record(&b.w.node).unwrap();
    let mut lift = StateChange::of(&held, DeviceState::Active, 0, "refresh_ok", &net.id(3));
    lift.sig = raw_sign(&net.secrets[3].1, &lift.preimage());
    assert_eq!(apply_sync(&net.stores[1], net.genesis, false, &DeviceSync { bundle: None, change: Some(lift) }, None, now(), net.epoch),
               Ok("not_newer"));
    // A refresh answers the pause, with no epoch, and asks the oracle nothing; a rotation is refused.
    let ch = ld::stamp::issue(&net.id(0), &b.w.node, Purpose::Refresh, now());
    let sig = device_sign(&net, &b, &b.kp, &messages::refresh_preimage(&b.w.node, &ch.nonce), 0);
    let calls = o.paths().len();
    let req = RefreshRequest { node_id: b.w.node.clone(), nonce: ch.nonce, stamp: ch.stamp, sig: messages::b64url(&sig),
                               token: Some("pi".into()) };
    let a = block_on(run_refresh(&ctx, &req, now()));
    assert_eq!((a["reason"].as_str(), a["device_state"].as_str(), a.get("paused_until")), (Some("device_slot_paused"), Some("paused"), None),
               "{a}");
    assert_eq!(o.paths().len(), calls);
    let (new_hw, _) = device_key();
    let rot = block_on(run_rotation(&ctx, &rotation(&net, &b, &b.hw_key(), &new_hw, &b.kp, 0), now()));
    assert_eq!(rot["reason"], json!("device_slot_paused"), "{rot}");
    // The paused device does not move to another wallet's node by a rebind.
    let v = wallet();
    net.register(&v);
    let (vpp, _) = ping_pair();
    let seq_v = now();
    let ch = ld::stamp::issue(&net.id(0), &v.node, Purpose::Enrol, now());
    let rb = messages::rebind_preimage(&b.w.node, &v.node, seq_v, &ch.nonce);
    let block = json!({ "platform": "android", "rebind_from": b.w.node, "sig": messages::b64url(&device_sign(&net, &b, &b.kp, &rb, 0)),
                        "wallet_sig": sign_hex(&v.sk, &rb), "nonce": ch.nonce, "stamp": ch.stamp });
    match net.prepare(0, &bind(&v, &vpp, seq_v, block, Some(("pi_token", "r"))), "203.0.113.61") {
        Err(StepRefusal::Device(d)) => assert_eq!((d.reason, d.paused_until), (DeviceReason::SlotPaused, None)),
        other => panic!("{other:?}"),
    }
    // A new enrolment of the node with a new key - a chain the list does not name - is taken, and the
    // revocation does not carry over to it.
    let (hw2, _) = device_key();
    let (pp2, _) = ping_pair();
    let seq2 = b.seq + 10;
    let block = android_block(&net, 0, &b.w, &pp2, seq2, &hw2, &[4u8; 65], b"rkp");
    let p = net.prepare(0, &bind(&b.w, &pp2, seq2, block, Some(("pi_token", "t2"))), "203.0.113.61").unwrap().unwrap();
    let fresh = match run(net.ctx(0, Some(o), &[1, 2, 3, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert_eq!((fresh.state, fresh.seq), (DeviceState::Active, seq2));
    assert_ne!(fresh.reason, ld::record::REVOKED);
    assert!(net.stores[0].device_nodes_by_serial(&crl::normal_serial(&serial).unwrap(), 10).is_empty(), "the old chain's row went");
    assert_eq!(pause_revoked(&net.ctx(0, Some(o), &[1, 2, 3, 4]), &list), 0, "the new chain is not on the list");
}

#[test]
fn a_snapshot_is_taken_only_newer_under_the_pinned_key_and_kept_for_a_restart() {
    let net = Net::new(false);
    let s = &net.stores[0];
    let t = now();
    // A serial no other test's chain carries: the list this genesis holds is process-wide.
    let snap = crl::tests::snapshot(&["abcdef123457"], t - 10, &net.oracle_sk);
    let (_, other) = d3::keypair();
    assert_eq!(adopt_crl(s, &crl::tests::snapshot(&["abcdef123457"], t, &other), net.pins, net.epoch, t), Err("signature"));
    assert!(!ld::evidence::revoked_any(&["0ABCDEF123457".to_string()]));
    assert_eq!(adopt_crl(s, &snap, net.pins, net.epoch, t), Ok(true));
    assert!(ld::evidence::revoked_any(&["0ABCDEF123457".to_string()]), "the list's own form, whatever the chain's spelling");
    assert_eq!(adopt_crl(s, &snap, net.pins, net.epoch, t), Ok(false), "the same one again");
    assert_eq!(adopt_crl(s, &crl::tests::snapshot(&[], t - 20, &net.oracle_sk), net.pins, net.epoch, t), Ok(false), "never back");
    assert!(ld::evidence::revoked_any(&["abcdef123457".to_string()]));
    let kept: crl::Snapshot = serde_json::from_value(s.device_crl().unwrap()).unwrap();
    assert_eq!(kept, snap, "a restart takes it again from here");
    // A record whose chain the held list names reads paused at once, before any signed change.
    let mut r = crate::light_device::record::tests::rec(1, net.epoch, DeviceState::Active);
    r.platform = Platform::Android;
    r.serials = vec!["abcdef123457".into()];
    assert_eq!(r.state_now(true, net.epoch, t), DeviceState::Paused);
    assert_eq!(r.state_at(true, net.epoch, t), DeviceState::Active, "the pure view knows no list");
}

#[test]
fn a_gate_held_node_is_rechecked_by_its_ingress_until_the_oracle_lets_it_go() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    *o.gate.lock() = Gate::MetricHigh;
    let b = enrol(&net, Platform::Ios, o, "203.0.113.63");
    let r = net.stores[0].device_record(&b.w.node).unwrap();
    assert_eq!((r.state, r.reason.as_str()), (DeviceState::CheckPending, "metric_high"));
    assert_eq!(net.stores[0].device_gate_held(None, 10), vec![b.w.node.clone()]);
    let ctx = net.ctx(0, Some(o), &[1, 2, 3, 4]);
    let t = now();
    let mut due = HashMap::new();
    // Still over the bound: asked again at the oracle's next check time, not before.
    *o.recheck.lock() = json!({ "state": "check_pending", "reason": null, "check": "metric_high", "next_check_at": t + 7_200 });
    assert_eq!(block_on(recheck_held(&ctx, o, &mut due, t)), 0);
    assert_eq!(due.get(&b.w.node), Some(&(t + 7_200)));
    let (path, body) = o.calls.lock().last().cloned().unwrap();
    assert_eq!((path.as_str(), body), ("/v1/recheck", json!({ "node_id": b.w.node })));
    let calls = o.paths().len();
    block_on(recheck_held(&ctx, o, &mut due, t + 60));
    assert_eq!(o.paths().len(), calls, "not due yet");
    // Another genesis leaves it to the ingress while the record is fresh.
    let mut other_due = HashMap::new();
    block_on(recheck_held(&net.ctx(1, Some(o), &[0, 2, 3, 4]), o, &mut other_due, t));
    assert_eq!(o.paths().len(), calls);
    // The gate lets it go: the record counts again, and it leaves the list of held records.
    *o.recheck.lock() = json!({ "state": "active", "reason": "check_passed", "next_check_at": t + 86_400 });
    assert_eq!(block_on(recheck_held(&ctx, o, &mut due, t + 7_200)), 1);
    let r = net.stores[0].device_record(&b.w.node).unwrap();
    assert_eq!((r.state_at(true, net.epoch, now()), r.reason.as_str()), (DeviceState::Active, "check_passed"));
    assert!(net.stores[0].device_gate_held(None, 10).is_empty());
    // Its signed change reaches the other genesis like any other.
    let c = r.last_change.clone().unwrap();
    assert_eq!(apply_sync(&net.stores[2], net.genesis, false, &DeviceSync { bundle: None, change: Some(c) }, None, now(), net.epoch),
               Ok("changed"));
    assert!(net.stores[2].device_gate_held(None, 10).is_empty());
}

/// Every one of the twelve `device_*` reasons is a stated refusal of `/bind`'s device step, each from the
/// check that owns it: the stamp, the vendor's verdicts, the key index, and the oracle's two refusals.
#[test]
fn every_device_reason_is_a_stated_refusal_of_the_device_step() {
    let net = Net::new(false);
    let w = wallet();
    net.register(&w);
    let (pp, seq) = (ping_key(), now());
    let addr = "198.51.100.212";
    let mut seen = std::collections::BTreeSet::new();
    let mut note = |r: StepRefusal| {
        if let StepRefusal::Device(d) = r {
            assert!(DeviceReason::parse(d.reason.as_str()).is_some());
            seen.insert(d.reason.as_str());
        }
    };
    for r in ["unsupported", "not_genuine", "app_unrecognized", "emulator", "compromised", "desktop", "secondary_user", "unlicensed"] {
        let c = ld::stamp::issue(&net.id(0), &w.node, Purpose::Enrol, now());
        let att = format!("refuse:{}", r);
        let block = json!({ "platform": "ios", "key_id": messages::b64url(&[1u8; 32]), "attestation": messages::b64url(att.as_bytes()),
                            "flags": IOS_FLAGS, "nonce": c.nonce, "stamp": c.stamp });
        note(net.prepare(0, &bind(&w, &pp, seq, block, None), addr).expect_err(r));
    }
    let (hw, _) = device_key();
    note(net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 1, &w, &pp, seq, &hw, &[]), None), addr).expect_err("another issuer"));
    // The key another node's live record holds.
    let (taken, _) = device_key();
    let mut other = crate::light_device::record::tests::rec(1, net.epoch, DeviceState::Active);
    other.node_id = "light_mobile_dacc1355d21394a2".into();
    other.hw_key = hex::encode(messages::sha3_256(&taken));
    let mut dw = crate::storage::DeviceWrite::default();
    dw.keys.push((other.hw_key.clone(), Some(KeyEntry { node_id: other.node_id.clone(), seq: 1, final_: true, at: now() })));
    dw.records.push(other);
    net.stores[0].device_write(dw).unwrap();
    note(net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &taken, &[]), None), addr).expect_err("key in use"));
    // The oracle's refusals, with the wait it names.
    for reason in ["device_slot_paused", "device_rate_limited"] {
        let (k, _) = device_key();
        let p = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &k, &[]), Some(("dc_token", "t"))), addr).unwrap().unwrap();
        match run(net.ctx(0, Some(net.oracle(Mode::Refuse(reason, 60))), &[1, 2, 3, 4]), p) {
            StepAnswer::Refused(StepRefusal::Device(d)) => {
                assert!(d.retry_after.is_some(), "{reason}");
                note(StepRefusal::Device(d));
            }
            other => panic!("{other:?}"),
        }
    }
    let all: std::collections::BTreeSet<&str> = ["device_unsupported", "device_not_genuine", "device_app_unrecognized", "device_emulator",
        "device_compromised", "device_desktop", "device_secondary_user", "device_unlicensed", "device_stale", "device_key_in_use",
        "device_slot_paused", "device_rate_limited"].into_iter().collect();
    assert_eq!(seen, all, "the twelve reasons of spec section 8");
    // `check_pending` is a state: a binding with no vendor token is taken, not refused.
    let (k, _) = device_key();
    let p = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &k, &[]), None), addr).unwrap().unwrap();
    match run(net.ctx(0, Some(net.oracle(Mode::Down)), &[1, 2, 3, 4]), p) {
        StepAnswer::Final(r) => assert_eq!(r.state, DeviceState::CheckPending),
        other => panic!("{other:?}"),
    }
}

/// The chain replays as it did (plan 12.3): the device layer writes its three column families and nothing
/// else - no block, account, registry, reward or snapshot row - on any genesis, through a whole life of a
/// device: enrolment, statement sync, replies, a refresh, a revocation, a release, the revocation snapshot,
/// the bitmap monitor and the status.
#[test]
fn the_device_layer_leaves_every_other_column_family_as_it_was() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let w = wallet();
    net.register(&w);
    let (pp, ping_sk) = ping_pair();
    let seq = now();
    bind_everywhere(&net, &w, &pp, seq);
    let c = anchor_at(&net, H);
    let before: Vec<_> = net.stores.iter().map(|s| s.cf_digests_except(&DEVICE_CFS)).collect();

    let (hw, kp) = device_key();
    let block = android_block(&net, 0, &w, &pp, seq, &hw, &[6u8; 65], b"rkp");
    let p = net.prepare(0, &bind(&w, &pp, seq, block, Some(("pi_token", "t"))), "203.0.113.64").unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, Some(o), &[1, 2, 3, 4]), p), StepAnswer::Final(_)));
    net.sync_from(0, &w.node);
    let b = Bound { w, seq, pp, ping_sk, hw, kp, platform: Platform::Android };
    assert_eq!(verify(&net, 1, &b.w.node, &c, &hw_reply(&net, &b, &b.kp, &c, now() * 1000), Route::Ingress, H + 5), Ok(()));
    let ctx = net.ctx(0, Some(o), &[1, 2, 3, 4]);
    *o.refresh.lock() = json!({ "result": "pass", "state": "active", "reason": "refresh_ok", "lease_valid_until": now() + 9 * 86_400,
                                "refresh_at": now() + 8 * 86_400, "paused_until": 0 });
    let ch = ld::stamp::issue(&net.id(0), &b.w.node, Purpose::Refresh, now());
    let sig = device_sign(&net, &b, &b.kp, &messages::refresh_preimage(&b.w.node, &ch.nonce), 0);
    let a = block_on(run_refresh(&ctx, &RefreshRequest { node_id: b.w.node.clone(), nonce: ch.nonce, stamp: ch.stamp,
                                                          sig: messages::b64url(&sig), token: Some("pi".into()) }, now()));
    assert_eq!(a["success"], json!(true), "{a}");
    let serial = net.stores[0].device_record(&b.w.node).unwrap().serials[0].clone();
    assert_eq!(pause_revoked(&ctx, &RevocationList::from_serials([serial.as_str()]).unwrap()), 1);
    let ch = ld::stamp::issue(&net.id(0), &b.w.node, Purpose::Release, now());
    let sig = device_sign(&net, &b, &b.kp, &messages::release_preimage(&b.w.node, b.seq, &ch.nonce), 0);
    block_on(async {
        release_step(&ctx, &b.w.node, b.seq, &json!({ "nonce": ch.nonce, "stamp": ch.stamp, "sig": messages::b64url(&sig) }), now()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    });
    net.stores[0].device_put_crl(&serde_json::to_value(crl::tests::snapshot(&[serial.as_str()], now(), &net.oracle_sk)).unwrap()).unwrap();
    let _ = ld::monitor::check_epoch(&net.stores[0], 0, net.epoch - 1, Vec::new);
    let r = net.stores[0].device_record(&b.w.node).unwrap();
    let _ = crate::rpc::device_status_of(&r, false, true, net.epoch, now(), ld::record::Local::default());

    let after: Vec<_> = net.stores.iter().map(|s| s.cf_digests_except(&DEVICE_CFS)).collect();
    for (i, (x, y)) in before.iter().zip(&after).enumerate() {
        for ((name, h1), (_, h2)) in x.iter().zip(y) {
            assert_eq!(h1, h2, "genesis {i}: the device layer wrote to `{name}`");
        }
    }
}

/// And statically: no file of the block apply, the state and reward derivation or the snapshot names the
/// device layer, so no validator's verdict can depend on a device record.
#[test]
fn no_block_apply_state_reward_or_snapshot_source_names_the_device_layer() {
    let sources = [
        ("node/state_apply.rs", include_str!("../node/state_apply.rs")),
        ("node/production.rs", include_str!("../node/production.rs")),
        ("node/registration.rs", include_str!("../node/registration.rs")),
        ("node/rewards.rs", include_str!("../node/rewards.rs")),
        ("node/transactions.rs", include_str!("../node/transactions.rs")),
        ("block_pipeline.rs", include_str!("../block_pipeline.rs")),
        ("reward_epoch.rs", include_str!("../reward_epoch.rs")),
        ("storage/blocks.rs", include_str!("../storage/blocks.rs")),
        ("storage/snapshots.rs", include_str!("../storage/snapshots.rs")),
        ("storage/snapshot_index.rs", include_str!("../storage/snapshot_index.rs")),
        ("storage/boundary_snapshot.rs", include_str!("../storage/boundary_snapshot.rs")),
        ("storage/registry.rs", include_str!("../storage/registry.rs")),
        ("storage/roster.rs", include_str!("../storage/roster.rs")),
        ("storage/reward_store.rs", include_str!("../storage/reward_store.rs")),
    ];
    for (name, src) in sources {
        for word in ["light_device", "device_record", "DeviceWrite", "device_write", "DeviceRecord"] {
            assert!(!src.contains(word), "{name} names `{word}`");
        }
    }
}

/// ND-5: a pause or an end a genesis missed past the last resend was never learned (only a refusal triggers a
/// pull). A delivery a genesis did not take waits in a persisted outbox, sent again until taken: a newer one
/// for the same node replaces the older, one taken leaves, and one nobody takes for a week is dropped.
#[tokio::test]
async fn a_missed_device_delivery_waits_in_the_outbox_until_taken() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
    let now = 1_800_000_000;
    let body = |n: u64| serde_json::json!({ "change": { "n": n } });
    s.device_outbox_put("10.0.0.2", "light_mobile_a", "c", &body(1), now - 100).unwrap();
    s.device_outbox_put("10.0.0.2", "light_mobile_a", "c", &body(2), now - 50).unwrap();
    s.device_outbox_put("10.0.0.3", "light_mobile_a", "c", &body(2), now - 50).unwrap();
    s.device_outbox_put("10.0.0.3", "light_mobile_b", "b", &body(9), now - OUTBOX_KEEP_SECS - 1).unwrap();
    let queued = s.device_outbox(10);
    assert_eq!(queued.len(), 3, "a newer delivery for the same node replaced the older");
    assert_eq!(queued[0].3, body(2));
    // 10.0.0.2 takes it, 10.0.0.3 is still down; the week-old one goes.
    let sent = std::sync::Mutex::new(Vec::new());
    let (taken, dropped) = resend_outbox(&s, now, |ip: String, b: serde_json::Value| {
        sent.lock().unwrap().push((ip.clone(), b));
        async move { ip == "10.0.0.2" }
    }).await;
    assert_eq!((taken, dropped), (1, 1));
    let left = s.device_outbox(10);
    assert_eq!(left.len(), 1);
    assert_eq!((left[0].1.as_str(), left[0].3.clone()), ("10.0.0.3", body(2)), "kept until its genesis takes it");
    // A delivery replaced after it was sent is not dropped by the older one's success.
    s.device_outbox_put("10.0.0.3", "light_mobile_a", "c", &body(3), now).unwrap();
    s.device_outbox_done("o:10.0.0.3:light_mobile_a:c", now - 50);
    assert_eq!(s.device_outbox(10)[0].3, body(3));
}
