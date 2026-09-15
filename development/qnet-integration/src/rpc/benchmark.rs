//! Benchmark endpoints and the load generators behind them.

use super::*;

/// Handle POST /api/v1/benchmark/start
/// SECURITY: Only Genesis/Bootstrap nodes can run benchmarks
pub(super) async fn handle_benchmark_start(
    request: BenchmarkStartRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use crate::benchmark::{BENCHMARK_MANAGER, BenchmarkConfig};

    // v10.0: Rate limit benchmark start
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "benchmark") {
        return Ok(rate_limit_response);
    }

    // SECURITY: Only allow benchmark on Genesis/Bootstrap nodes or with valid secret
    let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
    let benchmark_secret = std::env::var("QNET_BENCHMARK_SECRET").ok();

    if !is_genesis_node && benchmark_secret.is_none() {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Benchmark only available on Genesis nodes or with QNET_BENCHMARK_SECRET"
        })));
    }

    // v10.0: Validate the secret value, not just its existence
    if let Some(expected_secret) = &benchmark_secret {
        let provided_secret = request.secret.as_deref().unwrap_or("");
        if provided_secret != expected_secret.as_str() {
            println!("[WARN][RPC] benchmark_auth_failed reason=invalid_secret");
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "unauthorized"
            })));
        }
    }
    
    // Build config from preset or custom values
    let use_pq = request.use_pq.unwrap_or(false);
    let config = if let Some(preset) = request.preset {
        let mut cfg = BenchmarkConfig::from_preset(preset);
        if let Some(shards) = request.shards { cfg.shards = shards.min(256).max(1); }
        if let Some(total) = request.total { cfg.total_transactions = total; }
        if let Some(tps) = request.target_tps { cfg.target_tps = tps; }
        if let Some(accounts) = request.num_accounts { cfg.num_accounts = accounts; }
        cfg.use_pq_sig = use_pq;
        cfg
    } else if request.shards.is_some() || request.total.is_some() || request.target_tps.is_some() {
        let shards = request.shards.unwrap_or(256).min(256).max(1);
        let tps_per_shard = 100_000u64;
        BenchmarkConfig {
            preset: crate::benchmark::BenchmarkPreset::Custom,
            shards,
            total_transactions: request.total.unwrap_or(shards as u64 * tps_per_shard),
            target_tps: request.target_tps.unwrap_or(shards as u64 * tps_per_shard),
            num_accounts: request.num_accounts.unwrap_or(shards * 40),
            initial_balance: 1_000_000 * crate::benchmark::ONE_QNC,
            use_pq_sig: use_pq,
        }
    } else {
        let mut cfg = BenchmarkConfig::default();
        cfg.use_pq_sig = use_pq;
        cfg
    };
    
    println!("[BENCHMARK] 🔐 Genesis node authorized. Starting {:?} benchmark...", config.preset);
    
    // Start benchmark
    match BENCHMARK_MANAGER.start(config.clone()).await {
        Ok(_) => {
            // Spawn transaction generator task
            let blockchain_clone = blockchain.clone();
            let total = config.total_transactions;
            let target_tps = config.target_tps;
            
            let is_progressive = config.is_progressive();
            let is_pq = config.use_pq_sig;
            tokio::spawn(async move {
                if is_progressive {
                    run_progressive_benchmark(blockchain_clone, total).await;
                } else if is_pq {
                    run_pq_benchmark_generator(blockchain_clone, total, target_tps).await;
                } else {
                    run_benchmark_generator(blockchain_clone, total, target_tps).await;
                }
            });

            Ok(warp::reply::json(&json!({
                "success": true,
                "message": "Benchmark started",
                "config": {
                    "total_transactions": config.total_transactions,
                    "target_tps": config.target_tps,
                    "num_accounts": config.num_accounts,
                    "use_pq_sig": config.use_pq_sig,
                    "sig_type": if config.use_pq_sig { "Dilithium3 (ML-DSA-65)" } else { "none (unsigned throughput)" }
                }
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": e
            })))
        }
    }
}

/// Run benchmark transaction generator - ADAPTIVE with EARLY BACKPRESSURE
/// Uses multiple worker tasks to generate and submit transactions concurrently
/// v2.41.2: Adaptive workers/batch based on target_tps + early backpressure = STABLE!
pub(super) async fn run_benchmark_generator(
    blockchain: Arc<BlockchainNode>,
    total_transactions: u64,
    target_tps: u64,
) {
    use crate::benchmark::{BENCHMARK_MANAGER, BenchmarkManager};
    use std::time::Instant;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc as StdArc;
    
    // v2.47: ADAPTIVE workers based on target TPS
    // Balanced for stability - more workers at high TPS but with rate limiting
    let num_workers = match target_tps {
        0..=10_000 => 2,           // 5K-10K TPS: 2 workers
        10_001..=30_000 => 4,      // 10K-30K TPS: 4 workers
        30_001..=60_000 => 8,      // 30K-60K TPS: 8 workers
        60_001..=100_000 => 12,    // v4.1: 60K-100K TPS: 12 workers
        100_001..=200_000 => 16,   // v4.1: 100K-200K TPS: 16 workers
        _ => 20,                    // v4.1: 200K+ TPS: 20 workers
    };
    
    // v2.47: ADAPTIVE batch size based on target TPS
    // Optimized for stability at ALL TPS levels
    let batch_size = match target_tps {
        0..=10_000 => 500,          // Low TPS: small batches
        10_001..=30_000 => 1_000,   // Medium TPS: medium batches
        30_001..=60_000 => 2_000,   // High TPS: larger batches
        60_001..=100_000 => 4_000,  // v4.1: Very high TPS: 4K batches
        100_001..=200_000 => 6_000, // v4.1: 100K-200K TPS: 6K batches
        _ => 8_000,                  // v4.1: 200K+ TPS: 8K batches
    };
    
    // v2.47: RATE LIMITING delay between batches
    // CRITICAL: Always have SOME delay to prevent network saturation!
    // This prevents overwhelming the mempool and QUIC transport!
    let batch_delay_ms = match target_tps {
        0..=10_000 => 50,           // 50ms delay = controlled flow
        10_001..=30_000 => 20,      // 20ms delay
        30_001..=60_000 => 10,      // 10ms delay
        60_001..=100_000 => 3,      // v4.1: 3ms delay for 100K TPS
        100_001..=200_000 => 2,     // v4.1: 2ms delay for 200K TPS
        _ => 1,                      // v4.1: 1ms minimum (NEVER 0!)
    };
    
    println!("[BENCHMARK] 🔧 ADAPTIVE MODE v2.47 - target: {} TPS", target_tps);
    println!("[BENCHMARK] 🛡️ Early backpressure + rate limiting + ALWAYS delay = STABLE!");
    println!("[BENCHMARK] ⚙️ Workers: {}, Batch: {}, Delay: {}ms (NEVER 0!)", num_workers, batch_size, batch_delay_ms);
    
    let tx_per_worker = total_transactions / num_workers as u64;
    // Yield every N transactions to allow block production
    let yield_interval = 50usize;
    
    println!("[BENCHMARK] 🚀 STABLE generator v2.47: {} tx at {} TPS target", total_transactions, target_tps);
    println!("[BENCHMARK] ⚡ Workers: {}, TX/worker: {}, Batch: {}, Yield every: {} TX", 
             num_workers, tx_per_worker, batch_size, yield_interval);
    
    // v2.41.2: Store batch_delay_ms for workers
    let batch_delay = std::time::Duration::from_millis(batch_delay_ms);
    
    // v2.26.3: Get accounts snapshot ONCE - eliminates ALL lock contention!
    // Each worker gets its own clone - no RwLock during TX generation
    let accounts_snapshot = BENCHMARK_MANAGER.get_accounts_snapshot().await;
    if accounts_snapshot.len() < 2 {
        println!("[BENCHMARK] ❌ Not enough accounts! Need at least 2, have {}", accounts_snapshot.len());
        return;
    }
    println!("[BENCHMARK] 📋 Accounts snapshot: {} accounts cloned for workers", accounts_snapshot.len());
    
    let start = Instant::now();
    let global_sent = StdArc::new(AtomicU64::new(0));
    let global_confirmed = StdArc::new(AtomicU64::new(0));
    let global_errors = StdArc::new(AtomicU64::new(0));
    
    // Spawn parallel workers
    let mut handles = Vec::with_capacity(num_workers);
    
    for worker_id in 0..num_workers {
        let blockchain_clone = blockchain.clone();
        let sent_counter = global_sent.clone();
        let confirmed_counter = global_confirmed.clone();
        let error_counter = global_errors.clone();
        let batch_delay = batch_delay; // Copy for this worker
        
        // v2.26.3: PARTITION accounts between workers to avoid nonce collision!
        // Each worker gets a SLICE of accounts - no shared nonces
        let accounts_per_worker = accounts_snapshot.len() / num_workers;
        let start_idx = worker_id * accounts_per_worker;
        let end_idx = if worker_id == num_workers - 1 {
            accounts_snapshot.len()  // Last worker gets remainder
    } else {
            start_idx + accounts_per_worker
    };
        let worker_accounts: Vec<_> = accounts_snapshot[start_idx..end_idx].to_vec();
        
        let handle = tokio::spawn(async move {
            let mut local_sent = 0u64;
            let mut local_confirmed = 0u64;
            let mut local_errors = 0u64;
            let mut latencies = Vec::with_capacity(1000);
            let mut yield_counter = 0usize;
            
            while local_sent < tx_per_worker && BENCHMARK_MANAGER.is_running() {
                // Generate batch of transactions using SNAPSHOT (NO LOCK!)
                let mut batch_txs = Vec::with_capacity(batch_size);
                
        for _ in 0..batch_size {
                    if local_sent >= tx_per_worker || !BENCHMARK_MANAGER.is_running() {
                break;
            }
            
                    // v2.26.3: Generate from snapshot - NO async, NO lock!
                    if let Some(tx) = BenchmarkManager::generate_transaction_from_snapshot(&worker_accounts) {
                        batch_txs.push(tx);
                        local_sent += 1;
                        yield_counter += 1;
                        
                        // v2.26.3: Yield every N TX to allow block production
                        // This is CRITICAL - prevents runtime starvation
                        if yield_counter >= yield_interval {
                            yield_counter = 0;
                            tokio::task::yield_now().await;
                        }
                    }
                }
                
                if batch_txs.is_empty() {
                    tokio::task::yield_now().await;
                    continue;
                }
                
                // v2.41.2: EARLY BACKPRESSURE - prevent crash BEFORE it happens!
                let mempool_size = blockchain_clone.get_mempool_size().await.unwrap_or(0);
                
                // v4.1: Increased mempool capacity for higher TPS target
                let mempool_capacity = 200_000usize;
                let mempool_fill_ratio = mempool_size as f64 / mempool_capacity as f64;
                
                // v2.41.2: EARLY backpressure thresholds (50/70/90, not 90/95!)
                if mempool_fill_ratio > 0.90 {
                    // CRITICAL: mempool >90%, long pause
                    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                    if local_sent % 10_000 == 0 {
                        println!("[BENCHMARK] 🔴 Mempool {:.0}% ({} TX) - CRITICAL pause 200ms", 
                                 mempool_fill_ratio * 100.0, mempool_size);
                    }
                } else if mempool_fill_ratio > 0.70 {
                    // HIGH: mempool >70%, medium pause
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                    if local_sent % 20_000 == 0 {
                        println!("[BENCHMARK] 🟠 Mempool {:.0}% ({} TX) - pause 100ms", 
                                 mempool_fill_ratio * 100.0, mempool_size);
                    }
                } else if mempool_fill_ratio > 0.50 {
                    // MEDIUM: mempool >50%, short pause
                    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                } else if mempool_fill_ratio > 0.30 {
                    // LOW: mempool >30%, tiny pause
                    tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
                }
                // Below 30%: proceed with configured batch_delay
                
                // Submit batch to mempool
                let batch_start = Instant::now();
                let batch_len = batch_txs.len();
                
                match blockchain_clone.submit_benchmark_batch(batch_txs).await {
                    Ok(confirmed) => {
                        local_confirmed += confirmed as u64;
                        local_errors += (batch_len - confirmed) as u64;
                        let latency = batch_start.elapsed().as_secs_f64() * 1000.0 / batch_len as f64;
                        latencies.push(latency);
                        
                        // v2.26.4: Update global counter IMMEDIATELY for live progress
                        sent_counter.fetch_add(batch_len as u64, Ordering::SeqCst);
                        confirmed_counter.fetch_add(confirmed as u64, Ordering::SeqCst);
                    }
                    Err(_) => {
                        local_errors += batch_len as u64;
                        error_counter.fetch_add(batch_len as u64, Ordering::SeqCst);
                        
                        // PROTECTION: If batch failed, brief wait then retry
                        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
                    }
                }
                
                // v2.41.2: Rate limiting delay after batch (configured per TPS level)
                if batch_delay.as_millis() > 0 {
                    tokio::time::sleep(batch_delay).await;
                } else {
                    tokio::task::yield_now().await;
                }
            }
            
            // Final counters already updated per-batch, just log
            
            // Record latencies
            for lat in latencies {
                BENCHMARK_MANAGER.record_latency(lat).await;
                    }
            
            println!("[BENCHMARK] Worker {} finished: {} TX sent, {} confirmed, {} errors", 
                     worker_id, local_sent, local_confirmed, local_errors);
            
            (worker_id, local_sent, local_confirmed)
        });
        
        handles.push(handle);
        }
        
    // Progress reporter task
    let progress_sent = global_sent.clone();
    let progress_handle = tokio::spawn(async move {
        let report_start = Instant::now();
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            
            if !BENCHMARK_MANAGER.is_running() {
                break;
            }
            
            let sent = progress_sent.load(Ordering::SeqCst);
            let elapsed = report_start.elapsed().as_secs_f64();
            let current_tps = if elapsed > 0.0 { sent as f64 / elapsed } else { 0.0 };
            
            println!("[BENCHMARK] 📊 Progress: {}/{} ({:.0} submit/s)", sent, total_transactions, current_tps);
            
            // FIXED v2.26.2: Direct atomic update instead of async loop
            // Previous version caused async deadlock with get_status().await in tight loop
            let manager_sent = BENCHMARK_MANAGER.transactions_sent.load(Ordering::SeqCst);
            let delta = sent.saturating_sub(manager_sent);
            if delta > 0 {
                // Track SUBMITTED only. Never fabricate `confirmed` from `sent` — this endpoint measures
                // submission/admission, not on-chain confirmation. Real confirmed-TPS = qnet-loadtest.
                BENCHMARK_MANAGER.transactions_sent.fetch_add(delta, Ordering::SeqCst);
            }
            
            // Update peak TPS directly
            {
                let mut peak = BENCHMARK_MANAGER.peak_tps.write().await;
                if current_tps > *peak {
                    *peak = current_tps;
                }
            }
        }
    });
    
    // Wait for all workers to complete
    let mut total_by_workers = 0u64;
    for handle in handles {
        if let Ok((worker_id, sent, confirmed)) = handle.await {
            total_by_workers += sent;
            if worker_id == 0 || worker_id == num_workers - 1 {
                println!("[BENCHMARK] ✅ Worker {} completed: {} sent, {} confirmed", worker_id, sent, confirmed);
            }
        }
    }
    
    // Stop progress reporter
    progress_handle.abort();
    println!("[BENCHMARK] ✅ All workers done, total_by_workers={}", total_by_workers);
    
    // Final stats update
    let final_sent = global_sent.load(Ordering::SeqCst);
    let final_confirmed = global_confirmed.load(Ordering::SeqCst);
    let final_errors = global_errors.load(Ordering::SeqCst);
    
    // Sync with benchmark manager
    let current_stats = BENCHMARK_MANAGER.get_status().await;
    let remaining_sent = final_sent.saturating_sub(current_stats.transactions_sent);
    let remaining_confirmed = final_confirmed.saturating_sub(current_stats.transactions_confirmed);
    
    for _ in 0..remaining_sent {
        BENCHMARK_MANAGER.record_sent();
        }
    for _ in 0..remaining_confirmed {
        BENCHMARK_MANAGER.record_confirmed();
    }
    for _ in 0..final_errors {
        BENCHMARK_MANAGER.record_error();
    }
    
    // Stop benchmark
    BENCHMARK_MANAGER.stop().await;
    
    let elapsed = start.elapsed().as_secs_f64();
    let final_tps = final_sent as f64 / elapsed;
    
    println!("[BENCHMARK] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("[BENCHMARK] 🏁 PARALLEL BENCHMARK COMPLETED");
    println!("[BENCHMARK] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("[BENCHMARK] ⚡ Workers used:    {}", num_workers);
    println!("[BENCHMARK] 📦 Total sent:      {}", final_sent);
    println!("[BENCHMARK] 📥 Admitted (mempool, NOT on-chain): {}", final_confirmed);
    println!("[BENCHMARK] ❌ Errors:          {}", final_errors);
    println!("[BENCHMARK] ⏱️  Duration:        {:.2}s", elapsed);
    println!("[BENCHMARK] 🚀 Submission rate (tx/s): {:.0}", final_tps);
    println!("[BENCHMARK] ℹ️  Submission/admission only — confirmed on-chain TPS: use qnet-loadtest.");
    println!("[BENCHMARK] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

/// PQ BENCHMARK GENERATOR — pure ML-DSA-65 (ML-DSA-65) signing.
///
/// Every TX is ML-DSA-65-signed on the generator side and verified on the node side.
/// This measures REAL post-quantum throughput — no shortcuts.
///
/// Design mirrors run_benchmark_generator but:
///   - Uses PqBenchmarkAccount (ML-DSA-65 keypairs)
///   - Calls generate_pq_transaction_from_snapshot() for each TX
///   - Submits via submit_benchmark_batch_pq() (ML-DSA-65 verify gate)
///
/// Scale horizontally across cores with multiple worker tasks.
pub(super) async fn run_pq_benchmark_generator(
    blockchain: Arc<BlockchainNode>,
    total_transactions: u64,
    target_tps: u64,
) {
    use crate::benchmark::{BENCHMARK_MANAGER, generate_pq_transaction_from_snapshot};
    use std::time::Instant;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc as StdArc;

    // ML-DSA-65 is ~50× slower → fewer workers and smaller batches are more efficient
    let num_workers = match target_tps {
        0..=2_000  => 2,
        2_001..=5_000 => 4,
        _ => 8,
    };
    let batch_size = 100usize; // Small batches — ML-DSA-65 verify is expensive
    let batch_delay = std::time::Duration::from_millis(10);

    println!("[BENCHMARK-PQ] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("[BENCHMARK-PQ] 🔐 Pure Dilithium3 (ML-DSA-65) sign mode");
    println!("[BENCHMARK-PQ] ⚙️  Workers: {}, Batch: {}, Target TPS: {}", num_workers, batch_size, target_tps);
    println!("[BENCHMARK-PQ] ⚠️  ~50× slower than Ed25519-only — real PQ overhead");
    println!("[BENCHMARK-PQ] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    let accounts_snapshot = BENCHMARK_MANAGER.get_pq_accounts_snapshot().await;
    if accounts_snapshot.len() < 2 {
        println!("[BENCHMARK-PQ] ❌ Not enough PQ accounts! Aborting.");
        BENCHMARK_MANAGER.stop().await;
        return;
    }
    println!("[BENCHMARK-PQ] 📋 {} PQ accounts cloned for workers", accounts_snapshot.len());

    let start = Instant::now();
    let global_sent      = StdArc::new(AtomicU64::new(0));
    let global_confirmed = StdArc::new(AtomicU64::new(0));
    let global_errors    = StdArc::new(AtomicU64::new(0));

    let tx_per_worker = total_transactions / num_workers as u64;
    let mut handles = Vec::with_capacity(num_workers);

    for worker_id in 0..num_workers {
        let blockchain_clone    = blockchain.clone();
        let sent_counter        = global_sent.clone();
        let confirmed_counter   = global_confirmed.clone();
        let error_counter       = global_errors.clone();

        // Partition accounts to avoid nonce collision between workers
        let accounts_per_worker = accounts_snapshot.len() / num_workers;
        let start_idx = worker_id * accounts_per_worker;
        let end_idx = if worker_id == num_workers - 1 {
            accounts_snapshot.len()
        } else {
            start_idx + accounts_per_worker
        };
        let worker_accounts: Vec<_> = accounts_snapshot[start_idx..end_idx].to_vec();

        let handle = tokio::spawn(async move {
            let mut local_sent = 0u64;

            while local_sent < tx_per_worker && BENCHMARK_MANAGER.is_running() {
                let mut batch = Vec::with_capacity(batch_size);

                for _ in 0..batch_size {
                    if local_sent >= tx_per_worker || !BENCHMARK_MANAGER.is_running() {
                        break;
                    }
                    // ML-DSA-65 sign happens inside generate_pq_transaction_from_snapshot
                    if let Some(tx) = generate_pq_transaction_from_snapshot(&worker_accounts) {
                        batch.push(tx);
                        local_sent += 1;
                    }
                    // Yield more often — ML-DSA-65 is CPU-heavy
                    tokio::task::yield_now().await;
                }

                if batch.is_empty() {
                    tokio::task::yield_now().await;
                    continue;
                }

                let batch_len = batch.len();
                // Verify gate: pure ML-DSA-65
                match blockchain_clone.submit_benchmark_batch_pq(batch).await {
                    Ok(confirmed) => {
                        sent_counter.fetch_add(batch_len as u64, Ordering::SeqCst);
                        confirmed_counter.fetch_add(confirmed as u64, Ordering::SeqCst);
                        for _ in 0..batch_len { BENCHMARK_MANAGER.record_sent(); }
                        for _ in 0..confirmed { BENCHMARK_MANAGER.record_confirmed(); }
                    }
                    Err(_) => {
                        error_counter.fetch_add(batch_len as u64, Ordering::SeqCst);
                        for _ in 0..batch_len { BENCHMARK_MANAGER.record_error(); }
                    }
                }

                tokio::time::sleep(batch_delay).await;
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        let _ = handle.await;
    }

    let elapsed = start.elapsed().as_secs_f64();
    let final_sent      = global_sent.load(Ordering::SeqCst);
    let final_confirmed = global_confirmed.load(Ordering::SeqCst);
    let final_errors    = global_errors.load(Ordering::SeqCst);
    let final_tps       = final_sent as f64 / elapsed.max(0.001);

    // Final sync with BENCHMARK_MANAGER (same pattern as the non-PQ generator)
    let current_stats = BENCHMARK_MANAGER.get_status().await;
    let remaining_sent = final_sent.saturating_sub(current_stats.transactions_sent);
    let remaining_confirmed = final_confirmed.saturating_sub(current_stats.transactions_confirmed);
    for _ in 0..remaining_sent { BENCHMARK_MANAGER.record_sent(); }
    for _ in 0..remaining_confirmed { BENCHMARK_MANAGER.record_confirmed(); }
    for _ in 0..final_errors { BENCHMARK_MANAGER.record_error(); }

    // Update peak TPS
    {
        let mut peak = BENCHMARK_MANAGER.peak_tps.write().await;
        if final_tps > *peak { *peak = final_tps; }
    }

    println!("[BENCHMARK-PQ] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("[BENCHMARK-PQ] 🏁 PQ BENCHMARK COMPLETED");
    println!("[BENCHMARK-PQ] 📦 Sent:      {}", final_sent);
    println!("[BENCHMARK-PQ] ✅ Confirmed: {} (Dilithium3 verified)", final_confirmed);
    println!("[BENCHMARK-PQ] ❌ Errors:    {}", final_errors);
    println!("[BENCHMARK-PQ] ⏱️  Duration:  {:.2}s", elapsed);
    println!("[BENCHMARK-PQ] ⚡ Actual TPS: {:.0} (PQ-honest)", final_tps);
    println!("[BENCHMARK-PQ] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    BENCHMARK_MANAGER.stop().await;
}

/// v2.41.2: PROGRESSIVE BENCHMARK - automatically find node's maximum TPS!
/// Starts at 5K TPS and increases by 5K every 10 seconds until node can't keep up
pub(super) async fn run_progressive_benchmark(
    blockchain: Arc<BlockchainNode>,
    max_transactions: u64,
) {
    use crate::benchmark::{BENCHMARK_MANAGER, BenchmarkManager};
    use std::time::Instant;
    use std::sync::atomic::{AtomicU64, AtomicBool, Ordering};
    use std::sync::Arc as StdArc;
    
    println!("[BENCHMARK] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("[BENCHMARK] 🔬 PROGRESSIVE MAX TEST v2.41.2");
    println!("[BENCHMARK] 🎯 Goal: Find maximum sustainable TPS for this node");
    println!("[BENCHMARK] 📈 Starting at 5K TPS, +5K every 10 seconds");
    println!("[BENCHMARK] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
    let accounts_snapshot = BENCHMARK_MANAGER.get_accounts_snapshot().await;
    if accounts_snapshot.len() < 2 {
        println!("[BENCHMARK] ❌ Not enough accounts!");
        return;
    }
    
    let start = Instant::now();
    let global_sent = StdArc::new(AtomicU64::new(0));
    let global_confirmed = StdArc::new(AtomicU64::new(0));
    let should_stop = StdArc::new(AtomicBool::new(false));
    let current_target_tps = StdArc::new(AtomicU64::new(5_000)); // Start at 5K
    let max_achieved_tps = StdArc::new(AtomicU64::new(0));
    
    // Single adaptive worker that respects current_target_tps
    let blockchain_clone = blockchain.clone();
    let sent_counter = global_sent.clone();
    let confirmed_counter = global_confirmed.clone();
    let stop_flag = should_stop.clone();
    let target_tps = current_target_tps.clone();
    let max_tps = max_achieved_tps.clone();
    
    let worker_handle = tokio::spawn(async move {
        let mut local_sent = 0u64;
        let mut phase_start = Instant::now();
        let mut phase_sent = 0u64;
        
        while !stop_flag.load(Ordering::SeqCst) && local_sent < max_transactions {
            let current_target = target_tps.load(Ordering::SeqCst);
            
            // Adaptive batch size based on current target
            let batch_size = (current_target / 100).max(100).min(2000) as usize;
            
            // Rate limiting: calculate delay to achieve target TPS
            let target_per_batch = batch_size as f64;
            let target_batch_time_ms = (target_per_batch / current_target as f64) * 1000.0;
            
            // Generate batch
            let mut batch_txs = Vec::with_capacity(batch_size);
            for _ in 0..batch_size {
                if let Some(tx) = BenchmarkManager::generate_transaction_from_snapshot(&accounts_snapshot) {
                    batch_txs.push(tx);
                }
            }
            
            if batch_txs.is_empty() {
                tokio::task::yield_now().await;
                continue;
            }
            
            // Backpressure check
            let mempool_size = blockchain_clone.get_mempool_size().await.unwrap_or(0);
            if mempool_size > 50_000 {
                // Mempool overloaded - we found the limit!
                println!("[BENCHMARK] ⚠️ Mempool overload at {} TPS (mempool: {})", current_target, mempool_size);
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                continue;
            }
            
            let batch_start = Instant::now();
            let batch_len = batch_txs.len();
            
            match blockchain_clone.submit_benchmark_batch(batch_txs).await {
                Ok(confirmed) => {
                    local_sent += batch_len as u64;
                    phase_sent += batch_len as u64;
                    sent_counter.fetch_add(batch_len as u64, Ordering::SeqCst);
                    confirmed_counter.fetch_add(confirmed as u64, Ordering::SeqCst);
                }
                Err(_) => {
                    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                }
            }
            
            // Calculate actual TPS for this phase
            let phase_elapsed = phase_start.elapsed().as_secs_f64();
            if phase_elapsed >= 10.0 {
                let actual_tps = phase_sent as f64 / phase_elapsed;
                let prev_max = max_tps.load(Ordering::SeqCst);
                if actual_tps as u64 > prev_max {
                    max_tps.store(actual_tps as u64, Ordering::SeqCst);
                }
                
                println!("[BENCHMARK] 📊 Phase complete: target={}K, actual={:.0} TPS", 
                         current_target / 1000, actual_tps);
                
                // Reset phase
                phase_start = Instant::now();
                phase_sent = 0;
            }
            
            // Rate limiting delay
            let batch_elapsed = batch_start.elapsed().as_millis() as f64;
            if batch_elapsed < target_batch_time_ms {
                let delay = (target_batch_time_ms - batch_elapsed) as u64;
                if delay > 0 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;
                }
            }
        }
        
        local_sent
    });
    
    // TPS escalation controller - increases target every 10 seconds
    let escalation_stop = should_stop.clone();
    let escalation_tps = current_target_tps.clone();
    let escalation_max = max_achieved_tps.clone();
    let escalation_sent = global_sent.clone();
    
    let escalation_handle = tokio::spawn(async move {
        let mut last_sent = 0u64;
        let mut stall_count = 0u32;
        
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
            
            if escalation_stop.load(Ordering::SeqCst) {
                break;
            }
            
            let current_sent = escalation_sent.load(Ordering::SeqCst);
            let current_target = escalation_tps.load(Ordering::SeqCst);
            
            // Check if we're actually achieving the target
            let delta = current_sent - last_sent;
            let actual_tps = delta / 10; // 10 second window
            
            if actual_tps < current_target * 8 / 10 {
                // Not achieving 80% of target - we found the limit!
                stall_count += 1;
                if stall_count >= 2 {
                    println!("[BENCHMARK] 🏁 MAX TPS FOUND: ~{} TPS (target {} couldn't sustain)", 
                             escalation_max.load(Ordering::SeqCst), current_target);
                    escalation_stop.store(true, Ordering::SeqCst);
                    break;
                }
            } else {
                stall_count = 0;
                // Increase target by 5K
                let new_target = current_target + 5_000;
                if new_target <= 150_000 { // Cap at 150K
                    println!("[BENCHMARK] 📈 Increasing target: {}K → {}K TPS", 
                             current_target / 1000, new_target / 1000);
                    escalation_tps.store(new_target, Ordering::SeqCst);
                } else {
                    println!("[BENCHMARK] 🏆 REACHED 150K TPS - TEST COMPLETE!");
                    escalation_stop.store(true, Ordering::SeqCst);
                    break;
                }
            }
            
            last_sent = current_sent;
        }
    });
    
    // Wait for completion
    let _ = worker_handle.await;
    should_stop.store(true, Ordering::SeqCst);
    escalation_handle.abort();
    
    BENCHMARK_MANAGER.stop().await;
    
    let elapsed = start.elapsed().as_secs_f64();
    let final_sent = global_sent.load(Ordering::SeqCst);
    let max_tps = max_achieved_tps.load(Ordering::SeqCst);
    
    println!("[BENCHMARK] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("[BENCHMARK] 🏁 PROGRESSIVE TEST COMPLETED");
    println!("[BENCHMARK] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("[BENCHMARK] 📦 Total sent:       {}", final_sent);
    println!("[BENCHMARK] ⏱️  Duration:         {:.2}s", elapsed);
    println!("[BENCHMARK] 🚀 MAX STABLE TPS:   {} ({:.0}K)", max_tps, max_tps as f64 / 1000.0);
    println!("[BENCHMARK] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}
