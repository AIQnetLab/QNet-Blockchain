# Ping Randomization Strategy for Millions of Nodes

**Updated**: November 25, 2025 (v2.19.4)

> **NOTE**: This document describes the legacy time-slot approach. QNet v2.19.4 implements a **256-shard deterministic ping system** instead. See `ARCHITECTURE_v2.19.md` for current implementation.

## Current Implementation (v2.19.4): 256-Shard System

```rust
// Light node assignment to shard (deterministic)
let shard_id = sha3_256(light_node_id)[0]; // First byte = 0-255

// Each shard is assigned to specific Full/Super nodes
// Pinger rotates every 4-hour window based on block entropy
```

**Key differences from time-slot approach**:
- **Sharding**: Nodes divided into 256 shards (not time slots)
- **Push-based**: Full/Super nodes ping Light nodes via FCM (not Light nodes pinging)
- **Attestations**: Dual-signed (Light Ed25519 + Pinger Dilithium)
- **Heartbeats**: Full/Super nodes self-attest (10 per 4-hour window)

---

## 🚨 Legacy: The Problem: Synchronized Ping Storm

If all nodes ping at exact intervals:
- 1 million nodes × ping every 4 hours = **1 million simultaneous pings** 💥
- Network spike every 4 hours could crash the system
- Full nodes can't handle millions of connections at once

## 🎲 Legacy Solution: Randomized Time Slots

### 1. Time Window Division

Divide the 4-hour window into manageable slots:

```rust
const REWARD_WINDOW: Duration = Duration::from_secs(14400); // 4 hours
const SLOT_DURATION: Duration = Duration::from_secs(60);    // 1 minute
const TOTAL_SLOTS: u32 = 240; // 4 hours / 1 minute = 240 slots

pub struct RandomizedPing {
    node_id: [u8; 32],
    assigned_slot: u32,
    slot_offset: u32, // Additional randomization within slot
}

impl RandomizedPing {
    pub fn new(node_id: [u8; 32]) -> Self {
        // Deterministic slot assignment based on node ID
        let hash = sha256::hash(&node_id);
        let assigned_slot = u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]]) % TOTAL_SLOTS;
        
        // Random offset within the slot (0-59 seconds)
        let slot_offset = u32::from_le_bytes([hash[4], hash[5], hash[6], hash[7]]) % 60;
        
        Self {
            node_id,
            assigned_slot,
            slot_offset,
        }
    }
    
    pub fn next_ping_time(&self) -> Instant {
        let current_window_start = self.get_current_window_start();
        let slot_start = current_window_start + (self.assigned_slot as u64 * 60);
        let ping_time = slot_start + self.slot_offset as u64;
        
        Instant::now() + Duration::from_secs(ping_time)
    }
}
```

### 2. Load Distribution Analysis

With 10 million nodes and 240 slots:
- **Per slot**: 10M / 240 = ~41,667 nodes
- **Per second**: 41,667 / 60 = ~694 pings/second
- **Manageable load** compared to 10M pings at once!

### 3. Mining Node Special Handling

For nodes that need rewards, ensure they ping within the 4-hour window:

```rust
pub struct MiningNodeScheduler {
    is_mining: bool,
    last_ping: Instant,
    randomized_ping: RandomizedPing,
}

impl MiningNodeScheduler {
    pub fn should_ping_now(&self) -> bool {
        if !self.is_mining {
            // Non-mining nodes use relaxed schedule
            return self.last_ping.elapsed() > Duration::from_secs(3600);
        }
        
        // Mining nodes MUST ping within reward window
        let time_until_window_end = self.time_until_reward_window_closes();
        
        if time_until_window_end < Duration::from_secs(300) {
            // Less than 5 minutes until window closes - ping now!
            return true;
        }
        
        // Otherwise use assigned slot
        self.is_my_slot_now()
    }
}
```

### 4. Progressive Backoff for Failed Pings

To prevent retry storms:

```rust
pub struct PingBackoff {
    attempt: u32,
    base_delay: Duration,
}

impl PingBackoff {
    pub fn next_retry(&mut self) -> Duration {
        // Exponential backoff with jitter
        let delay = self.base_delay * 2u32.pow(self.attempt.min(5)); // Cap at 32x
        let jitter = thread_rng().gen_range(0..1000); // 0-1 second jitter
        
        self.attempt += 1;
        delay + Duration::from_millis(jitter)
    }
}
```

## 📊 Scalability Tiers

Different strategies for different network sizes:

| Network Size | Strategy | Slots | Load per Slot | Pings/Second |
|-------------|----------|-------|---------------|--------------|
| < 10K nodes | Direct ping | N/A | All at once (OK) | ~166/sec |
| 10K - 100K | 60 slots | 60 | ~1,667 nodes | ~28/sec |
| 100K - 1M | 120 slots | 120 | ~8,333 nodes | ~139/sec |
| 1M - 10M | 240 slots | 240 | ~41,667 nodes | ~694/sec |
| > 10M | 480 slots | 480 | ~20,833 nodes | ~347/sec |

**SCALABILITY TESTING NEEDED**: Load testing required to verify 10M+ node performance

## 🔧 Implementation Status

```rust
pub struct NetworkScheduler {
    node_count_estimate: AtomicU64,
    current_slot_count: AtomicU32,
}

impl NetworkScheduler {
    pub fn adjust_slots(&self) {
        let count = self.node_count_estimate.load(Ordering::Relaxed);
        
        let optimal_slots = match count {
            0..=10_000 => 1,
            10_001..=100_000 => 60,
            100_001..=1_000_000 => 120,
            1_000_001..=10_000_000 => 240,
            _ => 480,
        };
        
        self.current_slot_count.store(optimal_slots, Ordering::Relaxed);
    }
    
    pub fn assign_node_slot(&self, node_id: [u8; 32]) -> u32 {
        let slots = self.current_slot_count.load(Ordering::Relaxed);
        let hash = sha256::hash(&node_id);
        u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]]) % slots
    }
}
```

## 🎯 Benefits

1. **No ping storms** - Load spread evenly across time
2. **Predictable load** - Estimated 700-1000 pings/second maximum
3. **Fair distribution** - All nodes get equal chance
4. **Deterministic** - Nodes always use same slot (stable)
5. **Scalable** - Automatically adjusts to network size

## ⚡ Additional Optimizations

### Geographic Sharding
```rust
// Nodes in same region use same time window but different slots
let region_offset = match node_region {
    Region::NorthAmerica => 0,
    Region::Europe => 60,    // 1 hour offset
    Region::Asia => 120,     // 2 hour offset
    Region::Oceania => 180,  // 3 hour offset
};
```

### Priority Lanes
```rust
// Super nodes get priority slots (first 10% of window)
if node_type == NodeType::SuperNode {
    slot = slot % 24; // First 24 slots only
}
```

## 📈 Expected Results

With proper randomization at 10M+ nodes:
- **Peak load**: ~347 pings/second Light nodes + server pings (estimated)
- **Average load**: ~347 pings/second for Light nodes (4-hour windows)
- **Server load**: Continuous ~41,667 pings/second for Full/Super (estimated)
- **Total system load**: ~42,014 pings/second (requires testing)
- **No spikes**: Smooth, predictable traffic with 480 randomized slots
- **Automated routing**: Network automatically determines ping target (server vs mobile)
- **No network overload**: Node detection is O(1) complexity, only at registration
- **CORRECTED: Network Exclusion Logic**: Inactivity → EXCLUSION (not permanent ban!)
- **Return timeouts**: Light=1 year free, Full=90 days free, Super=30 days free
- **Accumulated rewards**: Always withdrawable regardless of node status
- **Reward fairness**: Binary success for Light nodes, percentage for servers (current 4-hour window)
- **Battery friendly**: Light nodes ping only 1 time per 4-hour reward window
- **Smart Polling**: F-Droid users without UnifiedPush use battery-efficient smart wake-up (~2 min before slot, not continuous polling)
- **Privacy compliant**: All device IDs and IPs hashed, no personal data collection
- **Hash security**: SHA-256 truncated - irreversible even if compromised
- **✅ PRODUCTION DEPLOYED**: Performance validated with 50/50 cross-shard success rate achieved
- **🗳️ DAO INTEGRATION**: Planned for 2026 (progressive governance unlock)
- **📱 WEB INTERFACE**: DAO interface ready (voting disabled until 2026)
- **🔒 MULTISIG FORMATION**: 9-month founder period with automatic fallback selection
- **⚖️ BALANCE REQUIREMENTS**: QNC balance-based governance (no staking required)
- **🏛️ SMART CONTRACTS**: Production-ready governance contracts deployed with hybrid integration
- **🛡️ SECURITY AUDIT**: Emergency proposal validation and founder veto power implemented
- **🔗 HYBRID COMPATIBILITY**: DAO contracts fully integrated with existing Post-Quantum EVM system 