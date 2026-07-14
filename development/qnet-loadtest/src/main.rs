//! QNet external load-test harness — confirmed-TPS + finality-latency measurement.
//!
//! Real path only: every tx is an ML-DSA-65-signed `Transfer` submitted via the
//! production `POST /api/v1/transaction` between real key-derived accounts that
//! were pre-funded at genesis (deterministic pool; see genesis.rs
//! `QNET_LOADTEST_ACCOUNTS`). Load generation runs OFF the validators.
//!
//! Measures: confirmed on-chain TPS, inclusion (soft) latency, macroblock-QC
//! (hard) finality latency p50/p95/p99, success rate — plus optional P3b
//! cryptographic logs-inclusion proof sampling.
#![allow(dead_code)]

mod derive;
mod net;
mod proof;

use clap::Parser;
use rand::Rng;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// An accepted tx still un-included past this is treated as mempool-dropped and its account reclaimed.
const STALE_INFLIGHT: Duration = Duration::from_secs(30);

#[derive(Parser, Debug)]
#[command(name = "qnet-loadtest", about = "QNet real-/transaction confirmed-TPS + finality-latency harness")]
struct Args {
    /// Comma-separated node base URLs, e.g. http://127.0.0.1:8001,http://1.2.3.4:8001
    #[arg(long, default_value = "http://127.0.0.1:8001")]
    nodes: String,
    /// Number of pre-funded loadtest accounts (MUST match genesis QNET_LOADTEST_ACCOUNTS).
    #[arg(long, default_value_t = 1000)]
    accounts: u64,
    /// Target aggregate submit rate (tx/s). 0 = as fast as free accounts allow.
    #[arg(long, default_value_t = 0)]
    target_tps: u64,
    /// Active submission duration (seconds).
    #[arg(long, default_value_t = 60)]
    duration: u64,
    /// Extra tracking time after submission stops, to finalize the tail (seconds).
    #[arg(long, default_value_t = 200)]
    drain: u64,
    /// Transfer amount per tx (nanoQNC). Tiny by default so senders never drain.
    #[arg(long, default_value_t = 1)]
    amount: u64,
    /// Gas price (nanoQNC/gas). Must be >= 10 (node MIN_GAS_PRICE).
    #[arg(long, default_value_t = 10)]
    gas_price: u64,
    /// Gas limit.
    #[arg(long, default_value_t = 10_000)]
    gas_limit: u64,
    /// Verify the logs-inclusion merkle proof for up to N confirmed txs (P3b).
    #[arg(long, default_value_t = 0)]
    proof_sample: u64,
    /// Finality tracker poll interval (ms).
    #[arg(long, default_value_t = 400)]
    poll_ms: u64,
    /// JSON report output path.
    #[arg(long, default_value = "loadtest_report.json")]
    out: String,
}

struct Acct {
    addr: String,
    pk_hex: String,
    pk_bytes: Vec<u8>,
    sk_bytes: Vec<u8>,
}

struct InFlight {
    idx: usize,
    nonce: u64,
    submit: Instant,
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() { return 0.0; }
    let i = ((p / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[i.min(sorted.len() - 1)]
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    eprintln!("[loadtest] deriving {} accounts…", args.accounts);

    let accounts: Arc<Vec<Acct>> = Arc::new(
        (0..args.accounts).map(|i| {
            let (pk, sk) = derive::keypair_from_xi(&derive::loadtest_xi(i));
            Acct { addr: derive::eon_from_pubkey(&pk), pk_hex: hex::encode(&pk), pk_bytes: pk, sk_bytes: sk }
        }).collect(),
    );
    let n = accounts.len();
    if n < 2 { eprintln!("[loadtest] need >= 2 accounts"); std::process::exit(1); }
    eprintln!("[loadtest] account[0] = {}", accounts[0].addr);

    let clients: Arc<Vec<net::NodeClient>> = Arc::new(
        args.nodes.split(',').filter(|s| !s.is_empty()).map(net::NodeClient::new).collect(),
    );
    if clients.is_empty() { eprintln!("[loadtest] no nodes"); std::process::exit(1); }

    // Shared state.
    let committed: Arc<Vec<AtomicU64>> = Arc::new((0..n).map(|_| AtomicU64::new(0)).collect());
    let inflight: Arc<Mutex<HashMap<String, InFlight>>> = Arc::new(Mutex::new(HashMap::new()));
    let incl_lat: Arc<Mutex<Vec<f64>>> = Arc::new(Mutex::new(Vec::new()));
    let hard_lat: Arc<Mutex<Vec<f64>>> = Arc::new(Mutex::new(Vec::new()));
    let pending_final: Arc<Mutex<Vec<(String, u64, Instant)>>> = Arc::new(Mutex::new(Vec::new()));
    let confirmed_hashes: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let submitted = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(AtomicU64::new(0));
    let included = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0)); // accepted-but-never-included (mempool-dropped), reclaimed
    let rr = Arc::new(AtomicU64::new(0)); // node round-robin cursor

    let (free_tx, mut free_rx) = tokio::sync::mpsc::unbounded_channel::<usize>();
    for i in 0..n { free_tx.send(i).ok(); }

    let start = Instant::now();
    let submit_deadline = start + Duration::from_secs(args.duration);
    let track_deadline = submit_deadline + Duration::from_secs(args.drain);

    // ── Finality tracker ────────────────────────────────────────────────────
    let tracker = {
        let clients = clients.clone();
        let inflight = inflight.clone();
        let incl_lat = incl_lat.clone();
        let hard_lat = hard_lat.clone();
        let pending_final = pending_final.clone();
        let committed = committed.clone();
        let confirmed_hashes = confirmed_hashes.clone();
        let included = included.clone();
        let dropped = dropped.clone();
        let free_tx = free_tx.clone();
        let poll = Duration::from_millis(args.poll_ms);
        let sample_cap = args.proof_sample as usize;
        tokio::spawn(async move {
            let c = &clients[0];
            let mut next_h = c.get_height().await.unwrap_or(0) + 1;
            let mut last_final_macro: u64 = 0;
            loop {
                let now = Instant::now();
                if now >= track_deadline { break; }
                // Inclusion scan.
                if let Ok(cur) = c.get_height().await {
                    while next_h <= cur {
                        match c.microblock_tx_hashes(next_h).await {
                            Ok(hashes) => {
                                if !hashes.is_empty() {
                                    let mut fl = inflight.lock().await;
                                    for h in &hashes {
                                        if let Some(inf) = fl.remove(h) {
                                            let lat = inf.submit.elapsed().as_secs_f64() * 1000.0;
                                            incl_lat.lock().await.push(lat);
                                            committed[inf.idx].store(inf.nonce, Ordering::SeqCst);
                                            included.fetch_add(1, Ordering::SeqCst);
                                            pending_final.lock().await.push((h.clone(), next_h, inf.submit));
                                            if confirmed_hashes.lock().await.len() < sample_cap {
                                                confirmed_hashes.lock().await.push(h.clone());
                                            }
                                            free_tx.send(inf.idx).ok(); // account is free again
                                        }
                                    }
                                }
                                next_h += 1;
                            }
                            Err(_) => break, // retry this height next poll
                        }
                    }
                }
                // Hard-finality advance: walk finalized macroblocks forward.
                loop {
                    match c.macroblock_hard_final(last_final_macro + 1).await {
                        Ok(true) => last_final_macro += 1,
                        _ => break,
                    }
                }
                if last_final_macro > 0 {
                    let mut pf = pending_final.lock().await;
                    let mut still = Vec::with_capacity(pf.len());
                    for (h, height, submit) in pf.drain(..) {
                        if net::finalizing_macroblock(height) <= last_final_macro {
                            hard_lat.lock().await.push(submit.elapsed().as_secs_f64() * 1000.0);
                        } else {
                            still.push((h, height, submit));
                        }
                    }
                    *pf = still;
                }
                // Reclaim accounts whose accepted tx was mempool-dropped without inclusion (in-flight past
                // STALE_INFLIGHT). The tracker scans every height and never lags that long, so a still-present
                // entry was dropped, not applied → free it (resubmits the same nonce) to keep the pool full.
                {
                    let mut fl = inflight.lock().await;
                    let stale: Vec<(String, usize)> = fl.iter()
                        .filter(|(_, inf)| inf.submit.elapsed() > STALE_INFLIGHT)
                        .map(|(h, inf)| (h.clone(), inf.idx)).collect();
                    for (h, idx) in stale {
                        fl.remove(&h);
                        dropped.fetch_add(1, Ordering::SeqCst);
                        free_tx.send(idx).ok();
                    }
                }
                tokio::time::sleep(poll).await;
            }
        })
    };

    // ── Submitter ───────────────────────────────────────────────────────────
    eprintln!("[loadtest] submitting for {}s (target_tps={}, nodes={})…",
        args.duration, args.target_tps, clients.len());
    let mut ticker = if args.target_tps > 0 {
        Some(tokio::time::interval(Duration::from_secs_f64(1.0 / args.target_tps as f64)))
    } else { None };

    loop {
        if Instant::now() >= submit_deadline { break; }
        let idx = tokio::select! {
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(submit_deadline)) => break,
            v = free_rx.recv() => match v { Some(i) => i, None => break },
        };
        if let Some(t) = ticker.as_mut() { t.tick().await; }

        let accounts = accounts.clone();
        let clients = clients.clone();
        let inflight = inflight.clone();
        let committed = committed.clone();
        let submitted = submitted.clone();
        let errors = errors.clone();
        let free_tx = free_tx.clone();
        let rr = rr.clone();
        let (amount, gas_price, gas_limit) = (args.amount, args.gas_price, args.gas_limit);

        tokio::spawn(async move {
            let to_idx = {
                let mut r = rand::thread_rng();
                let mut j = r.gen_range(0..accounts.len());
                if j == idx { j = (j + 1) % accounts.len(); }
                j
            };
            let from = &accounts[idx];
            let to = &accounts[to_idx];
            let nonce = committed[idx].load(Ordering::SeqCst) + 1;
            let msg = derive::transfer_message(&from.addr, &to.addr, amount, nonce, gas_price, gas_limit);
            let sig = match derive::sign_wire(msg.as_bytes(), &from.sk_bytes, &from.pk_bytes) {
                Ok(s) => s,
                Err(_) => { errors.fetch_add(1, Ordering::SeqCst); free_tx.send(idx).ok(); return; }
            };
            let req = net::TxRequest {
                from: from.addr.clone(),
                to: to.addr.clone(),
                amount, gas_price, gas_limit, nonce,
                dilithium_signature: sig,
                dilithium_public_key: from.pk_hex.clone(),
            };
            let ci = (rr.fetch_add(1, Ordering::Relaxed) as usize) % clients.len();
            match clients[ci].submit_tx(&req).await {
                Ok(hash) => {
                    inflight.lock().await.insert(hash, InFlight { idx, nonce, submit: Instant::now() });
                    submitted.fetch_add(1, Ordering::SeqCst);
                }
                Err(_) => {
                    errors.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    free_tx.send(idx).ok(); // free to retry
                }
            }
        });
    }
    let active_secs = start.elapsed().as_secs_f64();
    eprintln!("[loadtest] submission window closed; draining/finalizing tail for up to {}s…", args.drain);
    let _ = tracker.await;

    // ── Metrics ─────────────────────────────────────────────────────────────
    let submitted_n = submitted.load(Ordering::SeqCst);
    let included_n = included.load(Ordering::SeqCst);
    let errors_n = errors.load(Ordering::SeqCst);
    let mut incl = incl_lat.lock().await.clone();
    let mut hard = hard_lat.lock().await.clone();
    incl.sort_by(|a, b| a.partial_cmp(b).unwrap());
    hard.sort_by(|a, b| a.partial_cmp(b).unwrap());

    // Soft = microblock inclusion; hard = macroblock-QC finalized (hard.len()). Reported separately.
    let included_tps = included_n as f64 / active_secs.max(0.001);
    let finalized_n = hard.len() as u64;
    let finalized_tps = finalized_n as f64 / active_secs.max(0.001);
    let dropped_n = dropped.load(Ordering::SeqCst);
    let success = if submitted_n > 0 { included_n as f64 / submitted_n as f64 * 100.0 } else { 0.0 };

    // ── P3b proof sampling (optional; needs logs_root deployed) ──────────────
    let mut proof_checked = 0u64;
    let mut proof_ok = 0u64;
    let mut proof_note = String::from("skipped (proof_sample=0)");
    if args.proof_sample > 0 {
        let hashes = confirmed_hashes.lock().await.clone();
        let c = &clients[0];
        proof_note = String::from("attempted");
        for h in hashes.iter().take(args.proof_sample as usize) {
            match c.logs_proof(h, 0).await {
                Ok((leaf, l1, block_root, l2, root)) => {
                    proof_checked += 1;
                    // 2-level: leaf → block_root (level 1) AND block_root → logs_root (level 2).
                    if proof::verify_logs_merkle_proof(&leaf, &l1, &hex::encode(block_root))
                        && proof::verify_logs_window_proof(&block_root, &l2, &root) { proof_ok += 1; }
                }
                Err(e) => { proof_note = format!("endpoint error (logs_root deployed?): {e}"); break; }
            }
        }
    }

    let report = serde_json::json!({
        "config": {
            "nodes": args.nodes, "accounts": args.accounts, "target_tps": args.target_tps,
            "active_duration_s": active_secs, "amount": args.amount,
            "gas_price": args.gas_price, "gas_limit": args.gas_limit,
        },
        "throughput": {
            "submitted": submitted_n, "errors": errors_n, "dropped": dropped_n,
            "included_onchain": included_n, "included_tps": included_tps,
            "finalized": finalized_n, "finalized_tps": finalized_tps,
            "success_rate_pct": success,
        },
        "inclusion_latency_ms": {
            "count": incl.len(), "mean": mean(&incl),
            "p50": pct(&incl, 50.0), "p95": pct(&incl, 95.0), "p99": pct(&incl, 99.0),
        },
        "hard_finality_latency_ms_upper_bound": {
            "count": hard.len(), "mean": mean(&hard),
            "p50": pct(&hard, 50.0), "p95": pct(&hard, 95.0), "p99": pct(&hard, 99.0),
        },
        "proof_p3b": { "checked": proof_checked, "verified": proof_ok, "note": proof_note },
    });

    println!("\n================ QNet load test — real /transaction ================");
    println!("submitted={} included={} finalized={} errors={} dropped={} success={:.2}%",
        submitted_n, included_n, finalized_n, errors_n, dropped_n, success);
    println!("INCLUDED (soft/microblock) TPS = {:.0}   FINALIZED (hard/macroblock-QC) TPS = {:.0}  (over {:.1}s)",
        included_tps, finalized_tps, active_secs);
    println!("inclusion (soft) latency ms:  p50={:.0} p95={:.0} p99={:.0} (n={})",
        pct(&incl, 50.0), pct(&incl, 95.0), pct(&incl, 99.0), incl.len());
    println!("hard finality latency ms (upper bound): p50={:.0} p95={:.0} p99={:.0} (n={})",
        pct(&hard, 50.0), pct(&hard, 95.0), pct(&hard, 99.0), hard.len());
    if args.proof_sample > 0 {
        println!("P3b merkle inclusion proofs: {}/{} verified ({})", proof_ok, proof_checked, proof_note);
    }
    println!("====================================================================");

    if let Err(e) = std::fs::write(&args.out, serde_json::to_string_pretty(&report).unwrap()) {
        eprintln!("[loadtest] could not write {}: {e}", args.out);
    } else {
        eprintln!("[loadtest] JSON report → {}", args.out);
    }
}
