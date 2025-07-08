# QNet Mempool

High-performance transaction mempool for QNet blockchain, written in Rust.

## Features

- **Lock-free concurrent operations** using DashMap
- **Priority-based ordering** by gas price
- **Nonce tracking** per sender
- **Transaction validation** with state checks
- **Automatic eviction** of old/low-priority transactions
- **Prometheus metrics** for monitoring
- **Support for 50K+ transactions**

## Architecture

### Components

1. **Mempool** - Main transaction pool
   - Concurrent HashMap for O(1) lookups
   - Priority queue for transaction ordering
   - Per-sender nonce tracking

2. **Priority System**
   - Gas price as primary factor
   - Boost for priority senders (validators)
   - Age-based adjustment to prevent starvation

3. **Validation**
   - Basic checks (gas, size, timestamp)
   - State validation (balance, nonce)
   - Transaction type specific rules

4. **Eviction Policies**
   - Time-based (default: 1 hour)
   - Priority-based when full
   - Configurable strategies

## Usage

```rust
use qnet_mempool::prelude::*;
use qnet_state::StateDB;
use std::sync::Arc;

// Create mempool with default config
let config = MempoolConfig::default();
let state_db = Arc::new(StateDB::with_rocksdb("./state")?);
let mempool = Mempool::new(config, state_db);

// Add transaction
let tx = create_transaction();
mempool.add_transaction(tx).await?;

// Get top transactions for block
let txs = mempool.get_top_transactions(1000);

// Remove executed transactions
mempool.remove_sender_transactions("sender", Some(executed_nonce));
```

## Configuration

```rust
let config = MempoolConfig {
    max_size: 50_000,              // Maximum transactions
    max_per_account: 100,          // Per-account limit
    min_gas_price: 1,              // Minimum gas price
    tx_expiry: Duration::from_secs(3600),  // 1 hour
    eviction_interval: Duration::from_secs(60),
    enable_priority_senders: true,
};
```

## Performance

### Benchmarks (on typical hardware)

| Operation | Performance | Notes |
|-----------|-------------|-------|
| Add Transaction | ~50 µs | With validation |
| Get Transaction | ~100 ns | From cache |
| Get Top 100 | ~100 µs | Sorted by priority |
| Remove Transaction | ~1 µs | With index updates |
| Concurrent Adds | ~10K TPS | 10 threads |

### Run Benchmarks

```bash
cargo bench
```

## Metrics

Available Prometheus metrics:

- `qnet_mempool_tx_operations_total` - Transaction operations
- `qnet_mempool_size` - Current size and unique senders
- `qnet_mempool_gas_price` - Gas price distribution
- `qnet_mempool_tx_age_seconds` - Transaction age
- `qnet_mempool_evictions_total` - Eviction counts

## Testing

```bash
# Run all tests
cargo test

# Run specific test
cargo test test_priority_ordering

# Run with logging
RUST_LOG=debug cargo test
```

## Integration

### With Python

Python bindings coming soon:

```python
import qnet_mempool_rust

mempool = qnet_mempool_rust.Mempool(config)
await mempool.add_transaction(tx)
top_txs = mempool.get_top_transactions(100)
```

### With QNet Node

The mempool integrates with:
- `qnet-state` for account validation
- `qnet-consensus` for block production
- API server for transaction submission

## License

MIT 