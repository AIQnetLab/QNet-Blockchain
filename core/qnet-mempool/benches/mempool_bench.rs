use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use qnet_mempool::prelude::*;
use qnet_state::{StateDB, transaction::{Transaction, TransactionType}};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;

fn bench_mempool_operations(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let state_db = Arc::new(StateDB::new(Arc::new(MockBackend)));
    let config = MempoolConfig::default();
    let mempool = Arc::new(Mempool::new(config, state_db));
    
    let mut group = c.benchmark_group("mempool_operations");
    
    // Benchmark adding transaction
    group.bench_function("add_transaction", |b| {
        let mempool = Arc::clone(&mempool);
        let mut nonce = 0u64;
        
        b.iter(|| {
            rt.block_on(async {
                let tx = Transaction::new(
                    format!("sender_{}", nonce % 100),
                    TransactionType::Transfer {
                        to: "recipient".to_string(),
                        amount: 100,
                    },
                    nonce / 100,
                    10,
                    21000,
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs(),
                );
                
                let _ = mempool.add_transaction(tx).await;
                nonce += 1;
            });
        });
    });
    
    // Setup some transactions
    rt.block_on(async {
        for i in 0..1000 {
            let tx = Transaction::new(
                format!("setup_sender_{}", i % 10),
                TransactionType::Transfer {
                    to: "recipient".to_string(),
                    amount: 100,
                },
                i / 10,
                10 + (i % 100),
                21000,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            );
            let _ = mempool.add_transaction(tx).await;
        }
    });
    
    // Benchmark getting transaction
    group.bench_function("get_transaction", |b| {
        let tx_hash = "dummy_hash";
        b.iter(|| {
            let _ = mempool.get_transaction(black_box(tx_hash));
        });
    });
    
    // Benchmark getting top transactions
    group.bench_function("get_top_100_transactions", |b| {
        b.iter(|| {
            let _ = mempool.get_top_transactions(black_box(100));
        });
    });
    
    // Benchmark getting sender transactions
    group.bench_function("get_sender_transactions", |b| {
        b.iter(|| {
            let _ = mempool.get_sender_transactions(black_box("setup_sender_0"));
        });
    });
    
    group.finish();
}

fn bench_priority_queue(c: &mut Criterion) {
    let mut group = c.benchmark_group("priority_queue");
    
    for size in [100, 1000, 10000].iter() {
        group.bench_with_input(
            BenchmarkId::new("sort_by_gas_price", size),
            size,
            |b, &size| {
                let mut txs = Vec::new();
                for i in 0..size {
                    let tx = Transaction::new(
                        format!("sender_{}", i),
                        TransactionType::Transfer {
                            to: "recipient".to_string(),
                            amount: 100,
                        },
                        0,
                        (i % 1000) as u64,
                        21000,
                        1234567890,
                    );
                    txs.push(tx);
                }
                
                b.iter(|| {
                    let mut priorities: Vec<_> = txs.iter()
                        .map(|tx| TxPriority::new(tx, false))
                        .collect();
                    priorities.sort_by(|a, b| b.cmp(a));
                });
            },
        );
    }
    
    group.finish();
}

fn bench_concurrent_access(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let state_db = Arc::new(StateDB::new(Arc::new(MockBackend)));
    let config = MempoolConfig::default();
    let mempool = Arc::new(Mempool::new(config, state_db));
    
    let mut group = c.benchmark_group("concurrent_access");
    
    group.bench_function("concurrent_adds_10_threads", |b| {
        b.iter(|| {
            let handles: Vec<_> = (0..10).map(|thread_id| {
                let mempool = Arc::clone(&mempool);
                let rt_handle = rt.handle().clone();
                
                std::thread::spawn(move || {
                    rt_handle.block_on(async {
                        for i in 0..100 {
                            let tx = Transaction::new(
                                format!("thread_{}_sender_{}", thread_id, i),
                                TransactionType::Transfer {
                                    to: "recipient".to_string(),
                                    amount: 100,
                                },
                                i as u64,
                                10,
                                21000,
                                SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap()
                                    .as_secs(),
                            );
                            let _ = mempool.add_transaction(tx).await;
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

// Mock backend for benchmarks
struct MockBackend;

#[async_trait::async_trait]
impl qnet_state::StateBackend for MockBackend {
    async fn get_account(&self, _address: &str) -> qnet_state::StateResult<Option<qnet_state::AccountState>> {
        Ok(Some(qnet_state::AccountState::new(1_000_000)))
    }
    
    async fn set_account(&self, _address: &str, _state: &qnet_state::AccountState) -> qnet_state::StateResult<()> {
        Ok(())
    }
    
    async fn get_block(&self, _height: u64) -> qnet_state::StateResult<Option<qnet_state::Block>> {
        Ok(None)
    }
    
    async fn get_block_by_hash(&self, _hash: &str) -> qnet_state::StateResult<Option<qnet_state::Block>> {
        Ok(None)
    }
    
    async fn store_block(&self, _block: &qnet_state::Block) -> qnet_state::StateResult<()> {
        Ok(())
    }
    
    async fn get_receipt(&self, _tx_hash: &str) -> qnet_state::StateResult<Option<qnet_state::TransactionReceipt>> {
        Ok(None)
    }
    
    async fn store_receipt(&self, _receipt: &qnet_state::TransactionReceipt) -> qnet_state::StateResult<()> {
        Ok(())
    }
    
    async fn get_height(&self) -> qnet_state::StateResult<u64> {
        Ok(0)
    }
    
    async fn begin_batch(&self) -> qnet_state::StateResult<()> {
        Ok(())
    }
    
    async fn commit_batch(&self) -> qnet_state::StateResult<()> {
        Ok(())
    }
    
    async fn rollback_batch(&self) -> qnet_state::StateResult<()> {
        Ok(())
    }
}

criterion_group!(
    benches,
    bench_mempool_operations,
    bench_priority_queue,
    bench_concurrent_access
);
criterion_main!(benches); 