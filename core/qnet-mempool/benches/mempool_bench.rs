use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use qnet_mempool::mempool::MempoolConfig;
use qnet_mempool::{Mempool, TxPriority};
use qnet_state::transaction::{Transaction, TransactionType};
use std::sync::Arc;
use tokio::runtime::Runtime;

/// Gas price at the mempool's default admission floor, so benchmarked transactions
/// take the accept path rather than the reject path.
const GAS_PRICE: u64 = 100_000;
const GAS_LIMIT: u64 = 10_000;

fn transfer(from: &str, to: &str, nonce: u64, gas_price: u64) -> Transaction {
    Transaction::new(
        from.to_string(),
        Some(to.to_string()),
        100,
        nonce,
        gas_price,
        GAS_LIMIT,
        1_234_567_890,
        None,
        TransactionType::Transfer {
            from: from.to_string(),
            to: to.to_string(),
            amount: 100,
        },
        None,
    )
}

fn bench_admission(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mempool = Mempool::new_simple(MempoolConfig::default());

    c.bench_function("add_transaction", |b| {
        let mut nonce = 0u64;
        b.iter(|| {
            let tx = transfer(
                &format!("sender_{}", nonce % 100),
                "recipient",
                nonce / 100,
                GAS_PRICE,
            );
            let _ = rt.block_on(mempool.add_transaction(tx));
            nonce += 1;
        });
    });
}

fn bench_lookups(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mempool = Mempool::new_simple(MempoolConfig::default());

    let mut hashes = Vec::with_capacity(1000);
    rt.block_on(async {
        for i in 0..1000u64 {
            let tx = transfer(
                &format!("setup_sender_{}", i % 10),
                "recipient",
                i / 10,
                GAS_PRICE + i % 100,
            );
            hashes.push(tx.hash.clone());
            let _ = mempool.add_transaction(tx).await;
        }
    });

    let mut group = c.benchmark_group("mempool_lookups");

    group.bench_function("get_transaction", |b| {
        let hash = &hashes[0];
        b.iter(|| black_box(mempool.get_transaction(black_box(hash))));
    });

    group.bench_function("get_top_100_transactions", |b| {
        b.iter(|| black_box(mempool.get_top_transactions(black_box(100))));
    });

    group.bench_function("get_sender_transactions", |b| {
        b.iter(|| black_box(mempool.get_sender_transactions(black_box("setup_sender_0"))));
    });

    group.finish();
}

fn bench_priority_queue(c: &mut Criterion) {
    let mut group = c.benchmark_group("priority_queue");

    for size in [100usize, 1000, 10_000] {
        let txs: Vec<Transaction> = (0..size)
            .map(|i| {
                transfer(
                    &format!("sender_{}", i),
                    "recipient",
                    0,
                    GAS_PRICE + (i % 1000) as u64,
                )
            })
            .collect();

        group.bench_with_input(
            BenchmarkId::new("sort_by_gas_price", size),
            &txs,
            |b, txs| {
                b.iter(|| {
                    let mut priorities: Vec<TxPriority> =
                        txs.iter().map(|tx| TxPriority::new(tx, false)).collect();
                    priorities.sort_by(|a, b| b.cmp(a));
                    black_box(priorities.len())
                });
            },
        );
    }

    group.finish();
}

fn bench_concurrent_adds(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mempool = Arc::new(Mempool::new_simple(MempoolConfig::default()));

    c.bench_function("concurrent_adds_10_threads", |b| {
        b.iter(|| {
            let handles: Vec<_> = (0..10)
                .map(|thread_id| {
                    let mempool = Arc::clone(&mempool);
                    let rt_handle = rt.handle().clone();
                    std::thread::spawn(move || {
                        rt_handle.block_on(async {
                            for i in 0..100u64 {
                                let tx = transfer(
                                    &format!("thread_{}_sender_{}", thread_id, i),
                                    "recipient",
                                    0,
                                    GAS_PRICE,
                                );
                                let _ = mempool.add_transaction(tx).await;
                            }
                        });
                    })
                })
                .collect();

            for handle in handles {
                handle.join().unwrap();
            }
        });
    });
}

criterion_group!(
    benches,
    bench_admission,
    bench_lookups,
    bench_priority_queue,
    bench_concurrent_adds
);
criterion_main!(benches);
