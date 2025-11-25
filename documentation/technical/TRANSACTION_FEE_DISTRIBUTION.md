# QNet Transaction Fee Distribution System

## Overview

QNet implements a unique transaction fee distribution model that rewards Full Nodes and Super Nodes for their contribution to network security and infrastructure.

## Node Types and Rewards

### 1. Light Nodes
- **Transaction fee share**: 0%
- **Role**: Basic validation, personal use
- **Requirements**: Minimal resources

### 2. Full Nodes
- **Transaction fee share**: 30% of total fees
- **Role**: Full blockchain validation, network relay
- **Requirements**: Complete blockchain storage, reliable uptime

### 3. Super Nodes
- **Transaction fee share**: 70% of total fees (2.33x Full Node fee rewards)
- **Role**: Full validation + additional services (indexing, archival, API endpoints)
- **Requirements**: High-performance hardware, guaranteed uptime, additional services

## Distribution Mechanism

### Collection Period: 4 Hours
- Transaction fees accumulate in a fee pool
- Every 4 hours, accumulated fees are distributed
- This balances between immediate rewards and gas efficiency

### Distribution Schedule
```
00:00 UTC - Distribution cycle 1
04:00 UTC - Distribution cycle 2
08:00 UTC - Distribution cycle 3
12:00 UTC - Distribution cycle 4
16:00 UTC - Distribution cycle 5
20:00 UTC - Distribution cycle 6
```

### Distribution Formula

For each 4-hour period:
```
Total_Fees = All transaction fees collected
Full_Node_Pool = Total_Fees × 0.3
Super_Node_Pool = Total_Fees × 0.7

Per_Full_Node_Reward = Full_Node_Pool / Number_of_Full_Nodes
Per_Super_Node_Reward = Super_Node_Pool / Number_of_Super_Nodes
```

### Example Calculation
```
Assumptions:
- Total fees collected in 4 hours: 10,000 QNC
- Active Full Nodes: 800
- Active Super Nodes: 200

Distribution:
- Full Node Pool: 10,000 × 0.3 = 3,000 QNC
- Super Node Pool: 10,000 × 0.7 = 7,000 QNC

Per Node Rewards:
- Each Full Node: 3,000 / 800 = 3.75 QNC
- Each Super Node: 7,000 / 200 = 35 QNC
```

## Implementation Details

### Fee Accumulator Contract
```rust
pub struct FeeAccumulator {
    /// Current period's accumulated fees
    pub current_fees: u64,
    
    /// Last distribution timestamp
    pub last_distribution: u64,
    
    /// Distribution interval (4 hours in seconds)
    pub distribution_interval: u64, // 14,400 seconds
    
    /// Node registry
    pub full_nodes: Vec<NodeInfo>,
    pub super_nodes: Vec<NodeInfo>,
}
```

### Distribution Process
1. **Fee Collection**: All transaction fees are sent to the fee accumulator
2. **Period Check**: Every block checks if 4 hours have passed
3. **Snapshot**: Take snapshot of active nodes at distribution time
4. **Calculate Shares**: Compute rewards based on node type
5. **Batch Distribution**: Send rewards in a single transaction to minimize overhead
6. **Reset Accumulator**: Start new collection period

### Node Eligibility Requirements (v2.19.4)

**Full Nodes must maintain:**
- 8+ heartbeats per 4-hour window (80% success rate of 10 heartbeats)
- Reputation score ≥ 70%
- Full blockchain sync (within 10 blocks of tip)
- Open P2P ports for network connectivity

**Super Nodes must maintain:**
- 9+ heartbeats per 4-hour window (90% success rate of 10 heartbeats)
- Reputation score ≥ 70%
- Full archival blockchain data
- Public API endpoints
- Block production capability

**Light Nodes:**
- 1+ attestation per 4-hour window (pinged by Full/Super nodes)
- Reputation fixed at 70 (immutable)
- Receive Pool 1 only (0% of transaction fees)

### Heartbeat System (v2.19.4)
```rust
pub struct FullNodeHeartbeat {
    node_id: String,
    node_type: String,      // "full" or "super"
    heartbeat_index: u8,    // 0-9 (10 per 4-hour window)
    timestamp: u64,
    dilithium_signature: String,
}

// Eligibility check
const HEARTBEATS_PER_WINDOW: u8 = 10;
const FULL_NODE_MIN_HEARTBEATS: u8 = 8;   // 80%
const SUPER_NODE_MIN_HEARTBEATS: u8 = 9;  // 90%
```

## Benefits of 4-Hour Distribution

1. **Predictable Income**: Node operators can expect rewards 6 times daily
2. **Gas Efficiency**: Batching reduces transaction costs vs. per-block distribution
3. **Fair Participation**: New nodes can join and start earning within 4 hours
4. **Network Stability**: Encourages consistent uptime rather than intermittent participation

## Future Enhancements

### Dynamic Reward Adjustment
- Increase Super Node rewards if fewer than 100 are active
- Bonus multipliers for nodes in underserved geographic regions
- Performance-based bonuses for exceptional service quality

### Slashing Conditions
- Nodes providing invalid data: 24-hour reward suspension
- Nodes with repeated downtime: Graduated penalties
- Malicious behavior: Permanent ban from rewards

## Economic Impact

### Projected Daily Earnings
Based on estimated network activity:
- **Full Node**: 50-200 QNC/day
- **Super Node**: 300-1,200 QNC/day

### ROI Calculation
```
Full Node Setup Cost: ~$500 (VPS + storage)
Daily Earnings: ~100 QNC
ROI Period: Depends on QNC price

Super Node Setup Cost: ~$2,000 (Dedicated server)
Daily Earnings: ~600 QNC
ROI Period: Faster due to 1.5x rewards
```

## Technical Implementation

### Smart Contract Functions
```rust
// Called by any transaction
pub fn collect_fee(amount: u64) {
    self.current_fees += amount;
    self.check_distribution_time();
}

// Automated distribution
pub fn distribute_fees() {
    require!(current_time() >= self.last_distribution + self.distribution_interval);
    
    let full_node_pool = self.current_fees * 30 / 100;
    let super_node_pool = self.current_fees * 70 / 100;
    
    // Distribute to eligible nodes
    self.batch_transfer_full_nodes(full_node_pool);
    self.batch_transfer_super_nodes(super_node_pool);
    
    // Reset for next period
    self.current_fees = 0;
    self.last_distribution = current_time();
}
```

This system ensures sustainable network growth by properly incentivizing infrastructure providers while maintaining decentralization through accessible Full Node requirements. 