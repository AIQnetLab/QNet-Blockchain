# QNet Sharding Implementation Plan

> Status (2026-07): future option, OFF today. QNet runs SINGLE-shard by design —
> a single shard already reaches ~50k TPS, and the auto-arm is gated OFF. This
> document is a forward-looking design plan; sharding is not active on the live
> network. Treat the config/`enabled` snippets below as illustrative future
> settings, not current defaults.

## Overview

Sharding is a future scalability option that would let QNet raise throughput further by dividing the network state and transaction processing across multiple shards. It is deferred by design and disabled today.

## Current Status

- **Base Performance**: single-shard, ~50k TPS (no sharding)
- **Target with Sharding (future)**: higher TPS via added shards
- **Sharding Status**: ❌ Deferred by design — single-shard today, auto-arm gated OFF

## Sharding Architecture

### 1. State Sharding
```rust
pub struct ShardedState {
    shard_id: u32,
    shard_count: u32,
    local_state: StateDB,
    cross_shard_queue: CrossShardQueue,
}

impl ShardedState {
    pub fn is_local_account(&self, address: &str) -> bool {
        let hash = sha256(address);
        let shard = u32::from_le_bytes(hash[0..4]) % self.shard_count;
        shard == self.shard_id
    }
}
```

### 2. Transaction Sharding
- **Intra-shard**: Transactions within same shard (fast)
- **Cross-shard**: Transactions between shards (slower, requires coordination)

### 3. Network Sharding
- Each shard maintains its own P2P network
- Cross-shard communication via dedicated relay nodes

## Implementation Phases

### Phase 1: Foundation (3 months)
- [ ] Design shard assignment algorithm
- [ ] Implement shard state separation
- [ ] Create cross-shard communication protocol
- [ ] Add shard discovery mechanism

### Phase 2: Core Sharding (3 months)
- [ ] Implement transaction routing
- [ ] Add cross-shard transaction handling
- [ ] Create shard synchronization protocol
- [ ] Implement shard rebalancing

### Phase 3: Optimization (2 months)
- [ ] Optimize cross-shard latency
- [ ] Implement adaptive sharding
- [ ] Add shard merge/split operations
- [ ] Performance tuning

### Phase 4: Production (2 months)
- [ ] Security audit
- [ ] Load testing with 16+ shards
- [ ] Monitoring and metrics
- [ ] Deployment tools

## Technical Details

### Shard Assignment
```rust
fn calculate_shard(address: &str, shard_count: u32) -> u32 {
    let hash = blake3::hash(address.as_bytes());
    u32::from_le_bytes(hash.as_bytes()[0..4].try_into().unwrap()) % shard_count
}
```

### Cross-Shard Transactions
```rust
pub struct CrossShardTx {
    source_shard: u32,
    dest_shard: u32,
    tx_hash: String,
    status: CrossShardStatus,
}

pub enum CrossShardStatus {
    Pending,
    Locked,
    Committed,
    Aborted,
}
```

### Shard Configuration
```toml
# Illustrative future config — sharding is deferred and OFF today (enabled = false).
[sharding]
enabled = false
shard_count = 16
min_validators_per_shard = 100
cross_shard_timeout_ms = 5000
rebalance_interval_hours = 24
```

## Performance Projections

| Shards | Expected TPS | Latency (ms) | Storage/Shard |
|--------|--------------|--------------|---------------|
| 1      | 100K         | 10           | 100%          |
| 4      | 350K         | 15           | 25%           |
| 16     | 1.2M         | 20           | 6.25%         |
| 64     | 4M           | 30           | 1.56%         |

## Challenges & Solutions

### 1. Cross-Shard Complexity
- **Challenge**: Coordinating transactions across shards
- **Solution**: Two-phase commit with optimistic locking

### 2. Data Availability
- **Challenge**: Ensuring all shards have necessary data
- **Solution**: Merkle proofs and light client verification

### 3. Shard Security
- **Challenge**: Preventing shard takeover attacks
- **Solution**: Random validator assignment and rotation

### 4. Network Overhead
- **Challenge**: Increased communication between shards
- **Solution**: Efficient gossip protocol and data compression

## Integration with Existing Modules

### qnet-state
```rust
// Add sharding support
impl StateDB {
    pub fn with_sharding(path: &Path, shard_config: ShardConfig) -> Result<Self> {
        // Initialize sharded state
    }
}
```

### qnet-consensus
```rust
// Shard-aware consensus (Checkpoint-BFT v2)
impl CheckpointConsensus {
    pub fn for_shard(shard_id: u32, config: ConsensusConfig) -> Self {
        // Create shard-specific consensus
    }
}
```

### qnet-mempool
```rust
// Shard-local mempool
impl Mempool {
    pub fn route_transaction(&self, tx: Transaction) -> ShardRoute {
        // Determine target shard
    }
}
```

## Benefits

1. **Linear Scalability**: Add shards to increase throughput
2. **Reduced Storage**: Each node stores only shard data
3. **Parallel Processing**: Multiple shards process simultaneously
4. **Geographic Distribution**: Shards can be region-specific

## Conclusion

Sharding is a future scaling lever for QNet, not a current requirement: a single shard already serves ~50k TPS and the auto-arm is gated OFF by design. The architecture is nonetheless designed to support sharding from the ground up, and the modular Rust implementation makes adding it straightforward without major refactoring should throughput demand ever exceed the single-shard ceiling. 