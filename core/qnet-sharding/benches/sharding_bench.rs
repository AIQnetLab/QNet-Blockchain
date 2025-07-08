use criterion::{black_box, criterion_group, criterion_main, Criterion};
use qnet_sharding::{ShardCoordinator, ParallelValidator};

fn benchmark_shard_assignment(c: &mut Criterion) {
    let coordinator = ShardCoordinator::new();
    
    c.bench_function("shard_assignment", |b| {
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
    let txs = vec![vec![1, 2, 3]; 10000];
    
    c.bench_function("parallel_validation_10k", |b| {
        b.iter(|| {
            black_box(validator.validate_batch(txs.clone()));
        });
    });
}

criterion_group!(benches, benchmark_shard_assignment, benchmark_parallel_validation);
criterion_main!(benches);
