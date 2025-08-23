# QNet Network Load Analysis

## Critical Load Points

### 1. Ping System Load

#### Current Design
- Nodes must ping once every 4 hours
- Rewards distributed every 4 hours
- All nodes ping to claim rewards

#### Problem: Ping Storm
```
Scenario: 1 million nodes
- All nodes want rewards ASAP
- First 5 minutes after distribution: 90% ping
- Load: 900,000 pings / 300 seconds = 3,000 pings/second
- Each ping ~500 bytes = 1.5 MB/s just for pings
```

#### Solution: Randomized Ping Windows
```rust
fn calculate_ping_window(node_id: &str, period_start: u64) -> (u64, u64) {
    // Hash node ID to get deterministic random slot
    let hash = blake3::hash(node_id.as_bytes());
    let slot = u64::from_le_bytes(&hash.as_bytes()[0..8]) % 14400; // 4 hours in seconds
    
    // Each node gets a 60-second window within 4 hours
    let window_start = period_start + slot;
    let window_end = window_start + 60;
    
    (window_start, window_end)
}
```

**Result**: Load spread evenly over 4 hours
- 1M nodes / 14,400 seconds = ~70 pings/second
- Much more manageable!

### 2. Reward Distribution Load

#### Current Design Problem
- Every 4 hours, system must:
  1. Calculate rewards for all nodes
  2. Send transactions to all nodes
  3. Update state for all nodes

#### Bottleneck Analysis
```
1 million nodes scenario:
- State updates: 1M writes
- Transaction creation: 1M transactions
- Network broadcast: 1M * 200 bytes = 200 MB
- If done in 1 minute: 16,667 tx/second needed!
```

#### Solution: Lazy Reward Claims
```rust
struct RewardLedger {
    // Don't send rewards, just track them
    pending_rewards: HashMap<NodeId, u64>,
    
    // Nodes claim when they want
    last_claimed: HashMap<NodeId, u64>,
}

impl RewardLedger {
    fn record_rewards(&mut self, period: u64) {
        // Just update ledger, no transactions
        for node in active_nodes {
            self.pending_rewards[node] += calculate_reward(node);
        }
    }
    
    fn claim_rewards(&mut self, node: NodeId) -> u64 {
        // Node claims accumulated rewards
        let amount = self.pending_rewards[node];
        self.pending_rewards[node] = 0;
        amount
    }
}
```

**Benefits**:
- No mass transactions every 4 hours
- Nodes claim when convenient
- Can batch multiple periods
- Reduces peak load by 99%

### 3. Transaction Processing Load

#### Current Assumptions vs Reality
```
Target: 500,000 TPS
Reality check with 1M nodes:
- Each node monitoring network
- Transaction size: ~200 bytes
- 500K TPS = 100 MB/s of transaction data
- Each node receiving 100 MB/s = 100 TB/s total bandwidth!
```

#### Problem: Full Broadcast Doesn't Scale
Every node seeing every transaction is impossible at scale.

#### Solution: Sharded Transaction Processing
```rust
struct ShardedNetwork {
    // Nodes only see transactions in their shard
    shard_count: u32,  // e.g., 100 shards
    
    // Light nodes don't see transactions at all
    // Full nodes see their shard only
    // Super nodes see multiple shards
}

fn get_node_shards(node_type: NodeType) -> Vec<ShardId> {
    match node_type {
        NodeType::Light => vec![],  // No transaction data
        NodeType::Full => vec![hash(node_id) % shard_count],  // One shard
        NodeType::Super => {
            // Multiple shards based on capacity
            let shard_count = 3;  // See 3 shards
            (0..shard_count).map(|i| (hash(node_id) + i) % total_shards).collect()
        }
    }
}
```

**Result**: 
- Light nodes: 0 bandwidth for transactions
- Full nodes: 1 MB/s (1/100th of total)
- Super nodes: 3 MB/s (3/100th of total)

### 4. Consensus Participation Load

#### Current Design Issue
```
Commit-Reveal with all nodes:
- Phase 1: All nodes send commits
- Phase 2: All nodes send reveals
- With 1M nodes: 2M messages per block!
```

#### Solution: Sampling-Based Consensus
```rust
struct ConsensusRound {
    // Only select subset for each round
    validator_count: u32,  // e.g., 1,000
    
    // Selection based on reputation + randomness
    selected_validators: Vec<NodeId>,
}

fn select_validators(eligible_nodes: &[Node]) -> Vec<NodeId> {
    // QNet PRODUCTION: Simple reputation-based selection (NO WEIGHTS)
    let mut selected = Vec::new();
    
    // Filter qualified candidates: Only Full and Super nodes with reputation ≥ 70%
    let qualified_nodes: Vec<&Node> = eligible_nodes.iter()
        .filter(|node| {
            matches!(node.node_type, NodeType::Full | NodeType::Super) &&
            node.reputation >= 0.70
        })
        .collect();
    
    // Simple random selection from qualified candidates
    selected.extend(simple_random_sample(qualified_nodes, 1000));
    
    selected
}

fn simple_random_sample(nodes: Vec<&Node>, count: usize) -> Vec<NodeId> {
    // QNet approach: Simple selection from qualified candidates (same as consensus)
    use sha3::{Sha3_256, Digest};
    let mut selected = Vec::new();
    
    for i in 0..count.min(nodes.len()) {
        let mut hasher = Sha3_256::new();
        hasher.update(format!("selection_{}", i).as_bytes());
        for node in &nodes {
            hasher.update(node.id.as_bytes());
        }
        
        let hash = hasher.finalize();
        let selection_index = u64::from_le_bytes([
            hash[0], hash[1], hash[2], hash[3],
            hash[4], hash[5], hash[6], hash[7],
        ]) as usize % nodes.len();
        
        selected.push(nodes[selection_index].id.clone());
    }
    
    selected
}
```

**Benefits**:
- Only 1,000 nodes participate per round
- Rotates every round for fairness
- Reduces consensus messages by 99.9%

### 5. State Synchronization Load

#### Problem: New Nodes Syncing
```
Full blockchain sync:
- 1 TB of data after 1 year
- 1,000 new nodes/day syncing
- Total bandwidth: 1 PB/day!
```

#### Solution: State Snapshots + Light Sync
```rust
struct SyncStrategy {
    // Light nodes: No sync needed
    // Full nodes: Snapshot + recent blocks
    // Super nodes: Full history
    
    snapshot_interval: u64,  // Every 10,000 blocks
    snapshot_retention: u32,  // Keep last 10 snapshots
}

impl Node {
    fn sync_strategy(&self) -> SyncMethod {
        match self.node_type {
            NodeType::Light => SyncMethod::None,
            NodeType::Full => SyncMethod::Snapshot {
                blocks_back: 10_000,  // Only recent history
            },
            NodeType::Super => SyncMethod::Full,
        }
    }
}
```

### 6. Critical Weaknesses Identified

#### 1. Ping Concentration
**Problem**: Even with randomization, popular times exist
**Solution**: Dynamic window sizing based on network load

#### 2. Reward Calculation Overhead
**Problem**: Calculating rewards for 1M nodes every 4 hours
**Solution**: Merkle tree of balances, only update changed nodes

#### 3. Network Partition Risk
**Problem**: If too many nodes offline, consensus fails
**Solution**: Minimum online validator set (e.g., 100 super nodes)

#### 4. DDoS on Reward Distribution
**Problem**: Attackers claim rewards repeatedly
**Solution**: Rate limiting, one claim per period

#### 5. State Bloat
**Problem**: Tracking 1M nodes + history
**Solution**: Archive old data, prune inactive nodes

## Recommended Architecture Changes

### 1. Hierarchical Network Structure
```
Super Nodes (Tier 1)
├── Full Nodes (Tier 2)
└── Light Nodes (Tier 3)

- Light nodes connect to Full nodes only
- Full nodes connect to Super nodes
- Super nodes form core mesh network
```

### 2. Lazy Everything
- Lazy reward claims (not push)
- Lazy state sync (on demand)
- Lazy transaction propagation (pull model)

### 3. Aggressive Pruning
- Inactive nodes removed after 30 days
- Old state archived after 90 days
- Transaction history compressed

### 4. Load Balancing
- Multiple API endpoints per region
- GeoDNS for node discovery
- Automatic failover

## Capacity Planning

### Network at 100K Nodes
- Ping load: 7 pings/second ✅
- Consensus: 1,000 validators ✅
- State size: ~100 GB ✅
- Bandwidth: ~10 MB/s per super node ✅

### Network at 1M Nodes
- Ping load: 70 pings/second ✅ (with randomization)
- Consensus: Still 1,000 validators ✅
- State size: ~1 TB ⚠️ (needs pruning)
- Bandwidth: ~30 MB/s per super node ✅

### Network at 10M Nodes
- Ping load: 700 pings/second ⚠️ (needs sharding)
- Consensus: Still 1,000 validators ✅
- State size: ~10 TB ❌ (needs major optimization)
- Bandwidth: ~100 MB/s per super node ⚠️

## Conclusion

The network can handle up to 1M nodes with the proposed optimizations:
1. **Randomized ping windows** - Prevents storms
2. **Lazy reward claims** - Reduces peak load
3. **Sharded transactions** - Scales bandwidth
4. **Sampled consensus** - Keeps consensus fast
5. **Hierarchical structure** - Reduces connection overhead

Beyond 1M nodes, additional sharding and optimization required. 