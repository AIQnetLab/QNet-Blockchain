use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use qnet_state::prelude::*;
use qnet_state::account::{NodeType, ActivationPhase};
use qnet_state::transaction::TransactionType;
use qnet_state::block::{BlockHeader, ConsensusProof};
use tempfile::TempDir;
use tokio::runtime::Runtime;
use std::sync::Arc;

fn bench_account_operations(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let temp_dir = TempDir::new().unwrap();
    let state_db = rt.block_on(async {
        StateDB::with_rocksdb(temp_dir.path()).unwrap()
    });
    
    let mut group = c.benchmark_group("account_operations");
    
    // Benchmark account creation
    group.bench_function("create_account", |b| {
        b.iter(|| {
            rt.block_on(async {
                let address = format!("account_{}", rand::random::<u32>());
                let state = AccountState::new(1000);
                state_db.set_account(&address, &state).await.unwrap();
            });
        });
    });
    
    // Benchmark account retrieval
    let test_address = "test_account";
    rt.block_on(async {
        let state = AccountState::new(1000);
        state_db.set_account(test_address, &state).await.unwrap();
    });
    
    group.bench_function("get_account", |b| {
        b.iter(|| {
            rt.block_on(async {
                let _ = state_db.get_account(black_box(test_address)).await.unwrap();
            });
        });
    });
    
    // Benchmark batch operations
    group.bench_function("batch_update_100_accounts", |b| {
        b.iter(|| {
            rt.block_on(async {
                state_db.backend.begin_batch().await.unwrap();
                
                for i in 0..100 {
                    let address = format!("batch_account_{}", i);
                    let state = AccountState::new(1000 + i as u64);
                    state_db.set_account(&address, &state).await.unwrap();
                }
                
                state_db.backend.commit_batch().await.unwrap();
            });
        });
    });
    
    group.finish();
}

fn bench_transaction_execution(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let temp_dir = TempDir::new().unwrap();
    let state_db = rt.block_on(async {
        StateDB::with_rocksdb(temp_dir.path()).unwrap()
    });
    
    let mut group = c.benchmark_group("transaction_execution");
    
    // Setup accounts
    rt.block_on(async {
        for i in 0..1000 {
            let address = format!("tx_account_{}", i);
            let state = AccountState::new(1_000_000);
            state_db.set_account(&address, &state).await.unwrap();
        }
    });
    
    // Benchmark simple transfer
    group.bench_function("simple_transfer", |b| {
        let mut nonce = 0u64;
        b.iter(|| {
            rt.block_on(async {
                let from = "tx_account_0";
                let to = format!("tx_account_{}", (nonce % 999) + 1);
                
                let tx = Transaction::new(
                    from.to_string(),
                    TransactionType::Transfer {
                        to: to.clone(),
                        amount: 100,
                    },
                    nonce,
                    10,
                    21000,
                    1234567890,
                );
                
                let _ = state_db.execute_transaction(&tx, 1, 0).await.unwrap();
                nonce += 1;
            });
        });
    });
    
    // Benchmark node activation
    group.bench_function("node_activation", |b| {
        let mut account_idx = 100u32;
        b.iter(|| {
            rt.block_on(async {
                let address = format!("tx_account_{}", account_idx);
                
                let tx = Transaction::new(
                    address.clone(),
                    TransactionType::NodeActivation {
                        node_type: NodeType::Light,
                        burn_amount: 1000,
                        phase: ActivationPhase::Phase2,
                    },
                    0,
                    10,
                    50000,
                    1234567890,
                );
                
                let _ = state_db.execute_transaction(&tx, 1, 0).await.unwrap();
                account_idx += 1;
            });
        });
    });
    
    group.finish();
}

fn bench_block_operations(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let temp_dir = TempDir::new().unwrap();
    let state_db = rt.block_on(async {
        StateDB::with_rocksdb(temp_dir.path()).unwrap()
    });
    
    let mut group = c.benchmark_group("block_operations");
    
    // Create test blocks
    let blocks: Vec<Block> = (0..100).map(|i| {
        let header = BlockHeader::new(
            i,
            format!("prev_hash_{}", i),
            format!("tx_root_{}", i),
            format!("state_root_{}", i),
            1234567890 + i * 10,
            format!("producer_{}", i),
            i,
        );
        
        let consensus_proof = ConsensusProof {
            commits: vec![],
            reveals: vec![],
            random_beacon: format!("beacon_{}", i),
            leader_proof: format!("proof_{}", i),
        };
        
        Block::new(header, vec![], consensus_proof)
    }).collect();
    
    // Store blocks
    rt.block_on(async {
        for block in &blocks {
            state_db.store_block(block).await.unwrap();
        }
    });
    
    // Benchmark block retrieval
    group.bench_function("get_block_by_height", |b| {
        b.iter(|| {
            rt.block_on(async {
                let height = rand::random::<u64>() % 100;
                let _ = state_db.get_block(black_box(height)).await.unwrap();
            });
        });
    });
    
    // Benchmark latest block retrieval
    group.bench_function("get_latest_block", |b| {
        b.iter(|| {
            rt.block_on(async {
                let _ = state_db.get_latest_block().await.unwrap();
            });
        });
    });
    
    group.finish();
}

fn bench_concurrent_access(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let temp_dir = TempDir::new().unwrap();
    let state_db = Arc::new(rt.block_on(async {
        StateDB::with_rocksdb(temp_dir.path()).unwrap()
    }));
    
    let mut group = c.benchmark_group("concurrent_access");
    
    // Benchmark concurrent reads
    group.bench_function("concurrent_reads_10_threads", |b| {
        b.iter(|| {
            let handles: Vec<_> = (0..10).map(|i| {
                let state_db = Arc::clone(&state_db);
                let rt_handle = rt.handle().clone();
                std::thread::spawn(move || {
                    rt_handle.block_on(async {
                        for j in 0..100 {
                            let address = format!("account_{}_{}", i, j);
                            let _ = state_db.get_account(&address).await;
                        }
                    });
                })
            }).collect();
            
            for handle in handles {
                handle.join().unwrap();
            }
        });
    });
    
    group.finish();
}

criterion_group!(
    benches,
    bench_account_operations,
    bench_transaction_execution,
    bench_block_operations,
    bench_concurrent_access
);
criterion_main!(benches); 