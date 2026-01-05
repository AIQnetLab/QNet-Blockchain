# QNet Mempool v2.25

High-performance transaction mempool for QNet blockchain, written in Rust.

## Features

- **Lock-free concurrent operations** using DashMap
- **Priority-based ordering** by gas price (highest first)
- **Binary storage** with bincode (10-20x faster than JSON)
- **100K+ TX/block support** (up from 50K)
- **10M mempool capacity** (up from 5M)
- **Dual format**: bincode (new) + JSON (legacy fallback)
- **Prometheus metrics** for monitoring

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

### SimpleMempool (v2.25 - bincode)

```rust
use qnet_mempool::{SimpleMempool, SimpleMempoolConfig};

// Create mempool
let config = SimpleMempoolConfig { max_size: 10_000_000 };
let mempool = SimpleMempool::new(config);

// Add binary transaction (bincode - RECOMMENDED)
let tx_bytes = bincode::serialize(&tx)?;
let tx_hash = format!("{:x}", sha3::Sha3_256::digest(&tx_bytes));
mempool.add_binary_transaction(tx_bytes, tx_hash, tx.gas_price);

// Get binary transactions for block building
let tx_bytes_list = mempool.get_pending_binary_transactions(100_000);
for tx_bytes in tx_bytes_list {
    let tx: Transaction = bincode::deserialize(&tx_bytes)?;
    // Process transaction
}

// Remove after inclusion in block
mempool.remove_transaction(&tx_hash);
```

### Legacy JSON (backward compatible)

```rust
// Add JSON transaction (legacy)
let tx_json = serde_json::to_string(&tx)?;
let tx_hash = format!("{:x}", sha3::Sha3_256::digest(tx_json.as_bytes()));
mempool.add_raw_transaction(tx_json, tx_hash, tx.gas_price);

// Get JSON transactions
let tx_jsons = mempool.get_pending_transactions(1000);
```

## Configuration

```rust
let config = SimpleMempoolConfig {
    max_size: 10_000_000,  // 10M transactions (v2.25)
};

// For high TPS (> 100K tx/block), use binary storage:
// Automatically enabled when max_size > 100,000
```

## API Reference

### Binary Methods (v2.25 - RECOMMENDED)

| Method | Description | Performance |
|--------|-------------|-------------|
| `add_binary_transaction(bytes, hash, gas_price)` | Add bincode TX | ~10 µs |
| `get_binary_transaction(hash)` | Get single TX | ~100 ns |
| `get_pending_binary_transactions(limit)` | Get TXs for block | ~1 ms for 100K |

### JSON Methods (Legacy)

| Method | Description | Performance |
|--------|-------------|-------------|
| `add_raw_transaction(json, hash, gas_price)` | Add JSON TX | ~50 µs |
| `get_raw_transaction(hash)` | Get single TX | ~500 ns |
| `get_pending_transactions(limit)` | Get TXs for block | ~10 ms for 100K |

### Common Methods

| Method | Description |
|--------|-------------|
| `remove_transaction(hash)` | Remove TX after block inclusion |
| `len()` | Current mempool size |
| `clear()` | Clear all transactions |

## Performance v2.25

### Benchmarks

| Operation | JSON (v2.19) | bincode (v2.25) | Improvement |
|-----------|--------------|-----------------|-------------|
| Serialize TX | ~50 µs | ~5 µs | **10x** |
| Deserialize TX | ~50 µs | ~3 µs | **16x** |
| Add to mempool | ~50 µs | ~10 µs | **5x** |
| Get 100K TXs | ~100 ms | ~5 ms | **20x** |
| Block building | ~200 ms | ~10 ms | **20x** |

### Throughput

| Metric | v2.19 | v2.25 | Notes |
|--------|-------|-------|-------|
| TX/block limit | 50K | **100K** | 2x increase |
| Mempool capacity | 5M | **10M** | 2x increase |
| Block building | ~200 ms | ~10 ms | bincode + parallel |
| Expected TPS | 10-20K | **50-100K+** | Gulf Stream + bincode |

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

### With QNet Node v2.25

The mempool integrates with:
- `qnet-state` for account validation
- `qnet-consensus` for block production
- **Gulf Stream** for direct TX forwarding to producer
- **QUIC transport** for binary TX broadcast
- **bincode** serialization for high TPS

```rust
// BlockchainNode integration (node.rs)
// All TX methods now use bincode:

// Submit transaction (client API)
pub async fn submit_transaction(&self, tx: Transaction) -> Result<String> {
    let tx_bytes = bincode::serialize(&tx)?;
    mempool.add_binary_transaction(tx_bytes.clone(), hash, gas_price);
    p2p.broadcast_transaction(tx_bytes);  // Gulf Stream
    Ok(hash)
}

// Block building
let tx_bytes_list = mempool.get_pending_binary_transactions(100_000);
for tx_bytes in tx_bytes_list {
    let tx: Transaction = bincode::deserialize(&tx_bytes)?;
    block.transactions.push(tx);
}
```

## License

MIT 