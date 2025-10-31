// QNet Comprehensive Benchmark Harness
// Tests all critical components for production readiness

use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId, Throughput};
use qnet_integration::{
    quantum_poh::QuantumPoH,
    vrf::{QNetVrf, select_producer_with_vrf},
    storage::PersistentStorage,
    node::NodeType,
};
use sha3::{Sha3_512, Sha3_256, Digest};
use std::time::Duration;

// Benchmark PoH throughput with optimizations
fn benchmark_poh_throughput(c: &mut Criterion) {
    let mut group = c.benchmark_group("poh_performance");
    group.measurement_time(Duration::from_secs(10));
    
    // Test different batch sizes
    for batch_size in [1000, 10000, 100000].iter() {
        group.throughput(Throughput::Elements(*batch_size as u64));
        group.bench_with_input(
            BenchmarkId::new("sha3_512_optimized", batch_size),
            batch_size,
            |b, &size| {
                b.iter(|| {
                    let mut hash = [0u8; 64];
                    hash[0] = 0x42; // Initial seed
                    
                    for i in 0..size {
                        let mut hasher = Sha3_512::new();
                        hasher.update(&hash);
                        let counter = (i as u64).to_le_bytes();
                        hasher.update(&counter);
                        let result = hasher.finalize();
                        hash.copy_from_slice(&result);
                    }
                    black_box(hash)
                });
            },
        );
    }
    
    group.finish();
}

// Benchmark VRF operations
fn benchmark_vrf_operations(c: &mut Criterion) {
    let mut group = c.benchmark_group("vrf_performance");
    
    // VRF initialization
    group.bench_function("vrf_init", |b| {
        b.iter(|| {
            let mut vrf = QNetVrf::new();
            vrf.initialize("test_node_001").unwrap();
            black_box(vrf)
        });
    });
    
    // VRF evaluation
    let mut vrf = QNetVrf::new();
    vrf.initialize("test_node_001").unwrap();
    let input = b"test_input_for_vrf_evaluation";
    
    group.bench_function("vrf_evaluate", |b| {
        b.iter(|| {
            let output = vrf.evaluate(input).unwrap();
            black_box(output)
        });
    });
    
    // VRF verification
    let output = vrf.evaluate(input).unwrap();
    let public_key = vrf.get_public_key().unwrap();
    
    group.bench_function("vrf_verify", |b| {
        b.iter(|| {
            let verified = QNetVrf::verify(&public_key, input, &output).unwrap();
            black_box(verified)
        });
    });
    
    group.finish();
}

// Benchmark producer selection with different network sizes
fn benchmark_producer_selection(c: &mut Criterion) {
    let mut group = c.benchmark_group("producer_selection");
    
    // Test with different numbers of candidates (simulating network growth)
    for num_candidates in [5, 100, 1000, 10000].iter() {
        let candidates: Vec<(String, f64)> = (0..*num_candidates)
            .map(|i| (format!("node_{:06}", i), 0.70 + (i as f64) * 0.001))
            .collect();
        
        group.bench_with_input(
            BenchmarkId::new("select_with_vrf", num_candidates),
            &candidates,
            |b, candidates| {
                b.to_async(tokio::runtime::Runtime::new().unwrap()).iter(|| async {
                    let entropy = [0x42u8; 32];
                    let result = select_producer_with_vrf(
                        1,
                        candidates,
                        "test_node",
                        &entropy
                    ).await.unwrap();
                    black_box(result)
                });
            },
        );
    }
    
    group.finish();
}

// Benchmark consensus operations
fn benchmark_consensus(c: &mut Criterion) {
    let mut group = c.benchmark_group("consensus");
    
    // Benchmark commit generation
    group.bench_function("generate_commit", |b| {
        b.iter(|| {
            let data = b"test_consensus_data";
            let mut hasher = Sha3_256::new();
            hasher.update(data);
            hasher.update(b"nonce_12345");
            let commit = hasher.finalize();
            black_box(commit)
        });
    });
    
    // Benchmark reveal verification
    group.bench_function("verify_reveal", |b| {
        let commit_hash = [0x42u8; 32];
        let reveal_data = b"test_consensus_data_nonce_12345";
        
        b.iter(|| {
            let mut hasher = Sha3_256::new();
            hasher.update(reveal_data);
            let computed = hasher.finalize();
            let valid = computed.as_slice() == &commit_hash[..32];
            black_box(valid)
        });
    });
    
    group.finish();
}

// Benchmark storage operations
fn benchmark_storage(c: &mut Criterion) {
    let mut group = c.benchmark_group("storage");
    
    // Create temp storage for testing
    let temp_dir = tempfile::tempdir().unwrap();
    let storage = PersistentStorage::new(temp_dir.path().to_str().unwrap()).unwrap();
    
    // Benchmark block save
    let test_block = vec![0x42u8; 1024]; // 1KB block
    group.bench_function("save_block_1kb", |b| {
        let mut height = 0u64;
        b.iter(|| {
            storage.save_microblock(height, &test_block, "test_hash").unwrap();
            height += 1;
            black_box(height)
        });
    });
    
    // Benchmark block load
    storage.save_microblock(999999, &test_block, "test_hash").unwrap();
    group.bench_function("load_block", |b| {
        b.iter(|| {
            let block = storage.load_microblock(999999).unwrap();
            black_box(block)
        });
    });
    
    group.finish();
}

// Benchmark network scalability
fn benchmark_scalability(c: &mut Criterion) {
    let mut group = c.benchmark_group("scalability");
    
    // Simulate validator sampling for different network sizes
    for network_size in [1000, 10000, 100000, 1000000].iter() {
        group.bench_with_input(
            BenchmarkId::new("validator_sampling", network_size),
            network_size,
            |b, &size| {
                b.iter(|| {
                    // Simulate weighted random selection
                    const MAX_VALIDATORS: usize = 1000;
                    let mut selected = Vec::with_capacity(MAX_VALIDATORS);
                    let mut rng = 0x42u64;
                    
                    for _ in 0..MAX_VALIDATORS.min(size) {
                        // Simple LCG for deterministic randomness
                        rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
                        let index = (rng as usize) % size;
                        selected.push(index);
                    }
                    
                    black_box(selected)
                });
            },
        );
    }
    
    group.finish();
}

// Benchmark cryptographic operations
fn benchmark_crypto(c: &mut Criterion) {
    let mut group = c.benchmark_group("cryptography");
    
    // SHA3-512 performance
    group.bench_function("sha3_512_single", |b| {
        let data = b"test_data_for_hashing";
        b.iter(|| {
            let mut hasher = Sha3_512::new();
            hasher.update(data);
            let result = hasher.finalize();
            black_box(result)
        });
    });
    
    // SHA3-256 performance
    group.bench_function("sha3_256_single", |b| {
        let data = b"test_data_for_hashing";
        b.iter(|| {
            let mut hasher = Sha3_256::new();
            hasher.update(data);
            let result = hasher.finalize();
            black_box(result)
        });
    });
    
    // Ed25519 signing simulation
    group.bench_function("ed25519_sign_simulate", |b| {
        use ed25519_dalek::{SigningKey, Signer};
        let key = SigningKey::from_bytes(&[0x42u8; 32]);
        let message = b"test_message_to_sign";
        
        b.iter(|| {
            let signature = key.sign(message);
            black_box(signature)
        });
    });
    
    group.finish();
}

criterion_group!(
    benches,
    benchmark_poh_throughput,
    benchmark_vrf_operations,
    benchmark_producer_selection,
    benchmark_consensus,
    benchmark_storage,
    benchmark_scalability,
    benchmark_crypto
);

criterion_main!(benches);
