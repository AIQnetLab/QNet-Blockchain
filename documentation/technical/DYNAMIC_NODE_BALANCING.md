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
    validator_rotation_interval: u64, // every 100 blocks
    
    // Priority by node type
    super_node_weight: f64,  // 3.0 (higher selection chance)
    full_node_weight: f64,   // 2.0
    light_node_weight: f64,  // 1.0
}
```

### 6. Validator Selection Mechanism

```rust
fn select_validators(round: u64) -> Vec<NodeId> {
    let mut validators = Vec::new();
    
    // Guaranteed slots for super nodes (minimum 10%)
    let guaranteed_super = max_validators * 0.1;
    validators.extend(select_random_super_nodes(guaranteed_super));
    
    // Remaining slots - weighted random selection
    let remaining = max_validators - validators.len();
    validators.extend(weighted_random_selection(remaining));
    
    validators
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