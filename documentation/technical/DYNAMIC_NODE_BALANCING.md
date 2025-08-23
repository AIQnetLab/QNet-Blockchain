# QNet Dynamic Node Balancing System

## Problem

With fixed reward ratios (40% full nodes, 60% super nodes), imbalances may occur:
- Too many super nodes → excessive infrastructure
- Too few super nodes → insufficient API endpoints

## Solution: Dynamic Adjustment

### 1. Network Target Metrics
```
Optimal ratios:
- Super nodes: 10-20% of total
- Full nodes: 30-40% of total  
- Light nodes: 40-60% of total
```

### 2. Reward Adjustment Algorithm

```rust
fn calculate_fee_distribution() -> (f64, f64) {
    let total_nodes = light_nodes + full_nodes + super_nodes;
    let super_ratio = super_nodes as f64 / total_nodes as f64;
    
    // Base distribution
    let mut full_share = 0.4;  // 40%
    let mut super_share = 0.6; // 60%
    
    // Adjustment for excess super nodes
    if super_ratio > 0.2 {  // More than 20%
        let excess = super_ratio - 0.2;
        super_share -= excess * 0.5;  // Decrease share
        full_share += excess * 0.5;   // Increase full node share
    }
    
    // Adjustment for super node deficit
    if super_ratio < 0.1 {  // Less than 10%
        let deficit = 0.1 - super_ratio;
        super_share += deficit * 0.3;  // Increase incentive
        full_share -= deficit * 0.3;
    }
    
    (full_share, super_share)
}
```

### 3. System Operation Examples

**Scenario 1: Too many super nodes (30%)**
```
Before adjustment:
- Full nodes: 40% of fees
- Super nodes: 60% of fees

After adjustment:
- Full nodes: 45% of fees (+5%)
- Super nodes: 55% of fees (-5%)

Effect: More profitable to run full nodes
```

**Scenario 2: Few super nodes (5%)**
```
Before adjustment:
- Full nodes: 40% of fees
- Super nodes: 60% of fees

After adjustment:
- Full nodes: 38.5% of fees (-1.5%)
- Super nodes: 61.5% of fees (+1.5%)

Effect: More incentives for super nodes
```

### 4. Manipulation Protection

**Problem**: Operators may switch between node types to maximize profit

**Solutions**:
1. **Lock period**: 7 days after changing node type
2. **Averaging**: Calculation based on 24-hour average
3. **Reputation**: Bonuses for stable operation

### 5. Performance Limits

**To prevent network slowdown:**

```rust
struct NetworkLimits {
    // Maximum active validators per round
    max_validators_per_round: u32,  // e.g., 1000
    
    // Validator rotation
    microblock_rotation_interval: u64, // every 30 blocks (QNet optimization)
    macroblock_consensus_interval: u64, // every 90 blocks
    
    // Simple qualification requirements (NO WEIGHTS)
    min_reputation_threshold: f64,  // 0.70 (70% minimum for participation)
    node_type_filter: String,      // "full_and_super" (Light nodes excluded from microblock production)
    emergency_failover_timeout: u64, // 5s for microblocks, 30s for macroblocks
}
```

### 6. QNet Validator Selection Mechanism (Updated 2025)

```rust
fn select_microblock_producer(round: u64, current_height: u64) -> String {
    // QNet PRODUCTION: Simple reputation-based selection (NO WEIGHTS)
    
    // 1. Filter qualified candidates: Only Full and Super nodes
    let qualified_candidates: Vec<Node> = all_nodes.iter()
        .filter(|node| {
            matches!(node.node_type, NodeType::Full | NodeType::Super) &&
            node.reputation >= 0.70 // 70% minimum reputation threshold
        })
        .cloned()
        .collect();
    
    // 2. Rotation every 30 blocks (3 producers per macroblock)
    let rotation_interval = 30u64;
    let leadership_round = current_height / rotation_interval;
    
    // 3. Deterministic but fair selection using SHA3-256
    use sha3::{Sha3_256, Digest};
    let mut hasher = Sha3_256::new();
    hasher.update(format!("microblock_producer_selection_{}", leadership_round).as_bytes());
    for node in &qualified_candidates {
        hasher.update(node.id.as_bytes());
    }
    
    let selection_hash = hasher.finalize();
    let selection_number = u64::from_le_bytes([
        selection_hash[0], selection_hash[1], selection_hash[2], selection_hash[3],
        selection_hash[4], selection_hash[5], selection_hash[6], selection_hash[7],
    ]);
    
    // 4. Simple modular selection (same algorithm as macroblock consensus)
    let selection_index = (selection_number as usize) % qualified_candidates.len();
    qualified_candidates[selection_index].id.clone()
}

fn select_macroblock_leader(participants: &[String]) -> String {
    // QNet PRODUCTION: Same simple algorithm for macroblock leaders
    // NO WEIGHTS - simple random from qualified participants (reputation ≥ 70%)
    
    use sha3::{Sha3_256, Digest};
    let mut hasher = Sha3_256::new();
    hasher.update(b"macroblock_leader_selection");
    for participant in participants {
        hasher.update(participant.as_bytes());
    }
    
    let hash = hasher.finalize();
    let selection_number = u64::from_le_bytes([
        hash[0], hash[1], hash[2], hash[3],
        hash[4], hash[5], hash[6], hash[7],
    ]);
    
    let selection_index = (selection_number as usize) % participants.len();
    participants[selection_index].clone()
}
```

## System Advantages

1. **Self-regulation**: Market finds optimal balance
2. **Flexibility**: Adapts to network needs
3. **Fairness**: Rewards match contribution
4. **Performance**: Limited active validators

## Monitoring and Metrics

```rust
struct NetworkBalance {
    // Current distribution
    light_nodes_count: u32,
    full_nodes_count: u32,
    super_nodes_count: u32,
    
    // Efficiency
    avg_block_time: f64,
    api_availability: f64,
    network_latency: f64,
    
    // Economics
    avg_reward_per_type: HashMap<NodeType, f64>,
    roi_per_type: HashMap<NodeType, f64>,
}
```

## Fine-tuning Parameters

1. **correction_factor**: Adjustment strength (0.1-1.0)
2. **target_ratios**: Target node type ratios
3. **min_max_shares**: Minimum/maximum reward shares
4. **smoothing_period**: Averaging period for stability

This system ensures automatic network balancing without manual intervention, maintaining optimal node type ratios and performance. 