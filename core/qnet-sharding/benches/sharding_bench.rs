use criterion::{black_box, criterion_group, criterion_main, Criterion};
use qnet_sharding::{ParallelValidator, ShardCoordinator, TransactionData};

fn transaction(i: usize) -> TransactionData {
    TransactionData {
        from: format!("address_{}", i),
        to: format!("address_{}", i + 1),
        amount: 100,
        nonce: i as u64,
        signature: format!("signature_{}", i),
        data: Vec::new(),
    }
}

fn benchmark_shard_assignment(c: &mut Criterion) {
    let coordinator = ShardCoordinator::new();

    c.bench_function("shard_assignment_1k", |b| {
        b.iter(|| {
            for i in 0..1000 {
                let address = format!("address_{}", i);
                black_box(coordinator.get_shard(&address));
            }
        });
    });
}

fn benchmark_parallel_validation(c: &mut Criterion) {
    let validator = ParallelValidator::new(8);
    let txs: Vec<TransactionData> = (0..10_000).map(transaction).collect();

    c.bench_function("parallel_validation_10k", |b| {
        b.iter(|| {
            black_box(validator.validate_batch(black_box(txs.clone())));
        });
    });
}

criterion_group!(benches, benchmark_shard_assignment, benchmark_parallel_validation);
criterion_main!(benches);
