// QNet PoH Performance Benchmarks
// Tests actual hash throughput on different hardware

use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};
use sha3::{Sha3_512, Digest};

fn benchmark_sha3_512_sequential(c: &mut Criterion) {
    let mut group = c.benchmark_group("poh_throughput");
    
    // Test different hash counts
    for count in [1000, 10000, 100000].iter() {
        group.throughput(Throughput::Elements(*count as u64));
        group.bench_with_input(format!("sha3_512_{}_hashes", count), count, |b, &count| {
            b.iter(|| {
                let mut hash = vec![0u8; 64];
                for i in 0..count {
                    let mut hasher = Sha3_512::new();
                    hasher.update(&hash);
                    hasher.update(&(i as u64).to_le_bytes());
                    hash = hasher.finalize().to_vec();
                }
                black_box(hash)
            });
        });
    }
    
    group.finish();
}

fn benchmark_vdf_property(c: &mut Criterion) {
    c.bench_function("vdf_sequential_requirement", |b| {
        b.iter(|| {
            // Verify that each hash depends on previous
            let mut hash = vec![0u8; 64];
            for i in 0..1000 {
                let mut hasher = Sha3_512::new();
                hasher.update(&hash); // MUST use previous hash
                hasher.update(&(i as u64).to_le_bytes());
                hash = hasher.finalize().to_vec();
            }
            black_box(hash)
        });
    });
}

criterion_group!(benches, benchmark_sha3_512_sequential, benchmark_vdf_property);
criterion_main!(benches);
