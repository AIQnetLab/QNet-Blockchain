# QNet Performance Benchmarks

Comprehensive benchmark suite for all QNet blockchain components.

## 📊 Benchmark Suite

### 1. PoH Performance (`poh_benchmark.rs`)
Tests Proof of History throughput and VDF properties.

**Metrics:**
- SHA3-512 sequential hashing performance
- Different batch sizes (1K, 10K, 100K hashes)
- VDF verification

**Expected Results:**
- 25M+ hashes/second on Intel Xeon E5-2680v4 @ 2.4GHz
- 30-40M hashes/second on modern CPUs (AMD Ryzen 9 5950X, Intel i9-12900K)
- 5-10M hashes/second on ARM devices (Raspberry Pi 4, mobile processors)
- **Note:** Results vary significantly based on CPU architecture and clock speed

### 2. Full Benchmark (`full_benchmark.rs`)
Complete system performance testing.

#### Components Tested:

**PoH Throughput:**
- Optimized SHA3-512 implementation
- Fixed-size arrays, zero Vec allocations
- Batch processing (1K-100K hashes)

**VRF Operations:**
- Initialization time
- Proof generation (<1ms target)
- Proof verification (<500μs target)

**Producer Selection:**
- 5 nodes (Genesis phase)
- 100 nodes
- 1,000 nodes
- 10,000 nodes

**Consensus:**
- Commit generation
- Reveal verification
- Byzantine agreement simulation

**Storage:**
- Block save/load operations
- 1KB block persistence
- Database read/write performance

**Scalability:**
- Validator sampling (1K to 1M nodes)
- DashMap performance
- Lock-free operations

**Cryptography:**
- SHA3-512 vs SHA3-256 comparison
- Ed25519 signing performance
- Signature verification

## 🚀 Running Benchmarks

### Local Testing (Quick Check)
```bash
# Run specific benchmark
cargo bench --bench poh_benchmark

# Run full suite
cargo bench --bench full_benchmark

# Run specific group
cargo bench --bench full_benchmark -- poh_performance
cargo bench --bench full_benchmark -- vrf_operations
cargo bench --bench full_benchmark -- producer_selection
```

### Production Testing (Server)
```bash
# SSH to server
ssh user@your-server

# Run benchmarks with baseline
cargo bench --bench full_benchmark -- --save-baseline production_v1

# Compare against baseline
cargo bench --bench full_benchmark -- --baseline production_v1

# Generate HTML reports
cargo bench --bench full_benchmark
# Reports saved to: target/criterion/
```

### Viewing Results

**Terminal Output:**
```
PoH Throughput/sha3_512_optimized/10000
                        time:   [399.23 μs 401.15 μs 403.27 μs]
                        thrpt:  [24.80 Melem/s 24.93 Melem/s 25.05 Melem/s]
```

**HTML Reports:**
```bash
# Open in browser (Linux/Mac)
open target/criterion/report/index.html

# Windows
start target/criterion/report/index.html
```

## 📈 Performance Targets

| Component | Metric | Target | Notes |
|-----------|--------|--------|-------|
| **PoH** | Hashes/sec | 25M+ | Intel Xeon E5-2680v4 |
| **VRF Eval** | Time | <1ms | Per candidate |
| **VRF Verify** | Time | <500μs | Per proof |
| **Producer Select (1K)** | Time | <10ms | 1000 candidates |
| **Producer Select (10K)** | Time | <50ms | 10000 candidates |
| **Validator Sampling (1M)** | Time | <50ms | Sampling to 1000 |
| **Block Save** | Time | <5ms | 1KB block |
| **Block Load** | Time | <1ms | From RocksDB |
| **Consensus Commit** | Time | <100μs | SHA3-256 hash |

## 🎯 Hardware Recommendations

### Development:
- **CPU**: Modern multi-core (4+ cores)
- **RAM**: 8GB minimum
- **Storage**: SSD (NVMe preferred)
- **OS**: Any (Windows/Linux/macOS)

### Production:
- **CPU**: Intel Xeon or AMD EPYC (8+ cores)
- **RAM**: 16GB minimum, 32GB+ recommended
- **Storage**: NVMe SSD with high IOPS
- **OS**: Linux (Ubuntu 22.04 LTS or newer)
- **Network**: 1Gbps+ connection

## 📊 Interpreting Results

### Good Performance:
```
time:   [398.23 μs 401.15 μs 404.27 μs]
        ↑ Lower is better

thrpt:  [24.74 Melem/s 24.93 Melem/s 25.11 Melem/s]
        ↑ Higher is better

change: [-2.5% +0.1% +2.8%]
        ↑ ±5% is acceptable variance
```

### Performance Issues:
- **>10% degradation**: Investigate code changes
- **High variance (>20%)**: System under load, retry on idle system
- **Increasing over time**: Possible memory leak or resource exhaustion

## 🔍 Troubleshooting

### Benchmark Fails to Compile:
```bash
# Check Rust version
rustc --version  # Should be 1.70+

# Update dependencies
cargo update

# Clean build
cargo clean
cargo bench --bench full_benchmark
```

### Inconsistent Results:
```bash
# Close background applications
# Disable CPU frequency scaling (Linux)
sudo cpupower frequency-set --governor performance

# Run multiple iterations
cargo bench --bench full_benchmark -- --sample-size 100
```

### Permission Denied (Linux):
```bash
# Benchmark needs write access to target/criterion/
chmod -R u+w target/
```

## 📝 Adding New Benchmarks

1. **Create new benchmark file:**
```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion};

fn my_benchmark(c: &mut Criterion) {
    c.bench_function("my_test", |b| {
        b.iter(|| {
            // Your code here
            black_box(my_function())
        });
    });
}

criterion_group!(benches, my_benchmark);
criterion_main!(benches);
```

2. **Add to Cargo.toml:**
```toml
[[bench]]
name = "my_benchmark"
harness = false
```

3. **Run:**
```bash
cargo bench --bench my_benchmark
```

## 🔗 Related Documentation

- [QNet Whitepaper](../../../QNet_Whitepaper.md) - Architecture overview
- [Performance Guide](../../../documentation/technical/QNET_COMPLETE_GUIDE.md) - Optimization techniques
- [Criterion.rs Docs](https://bheisler.github.io/criterion.rs/book/) - Benchmarking framework

## 🤝 Contributing

When adding benchmarks:
1. Use `black_box()` to prevent compiler optimizations
2. Test with realistic data sizes
3. Document expected results
4. Include both best and worst cases
5. Add to CI/CD if possible

## 📄 License

Same as QNet project (Apache 2.0)

