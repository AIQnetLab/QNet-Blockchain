# QNET Deterministic Reputation System v2.27

## Overview

QNET uses a **deterministic blockchain-based reputation system** that eliminates P2P gossip vulnerabilities.
All nodes compute identical reputation scores from on-chain data.

**NEW in v2.27:** Epoch-based validator sets + QRDS (Quantum-Resistant Deterministic Selection) eliminate gossip race conditions!

**NEW in v2.24:** Reputation snapshots ensure 100% synchronization across all nodes!

**Architecture Comparison:**
| Feature | OLD (P2P Gossip) | NEW (Deterministic) |
|---------|------------------|---------------------|
| Data Source | P2P messages | Blockchain data |
| Sybil Resistance | ❌ Vulnerable | ✅ Resistant |
| Node Agreement | ❌ Can disagree | ✅ Always identical |
| Evidence | ❌ Ephemeral keys | ✅ Cryptographic proof |
| Synchronization | ❌ Gossip lag | ✅ Block-based |
| Long-Range Attack | ❌ Vulnerable | ✅ Finality Checkpoints |
| **Producer Selection** | ❌ Gossip races | ✅ MacroBlock snapshot (v2.27) |

---

## Epoch-Based Validator Set (v2.27)

Producer selection now uses **MacroBlock snapshots** instead of gossip registry:

### Data Structure

```rust
// Stored in MacroBlock.consensus_data.eligible_producers
pub struct EligibleProducer {
    pub node_id: String,      // Node identifier
    pub reputation: f64,      // 0.0 - 1.0 (from reputation system)
}
```

### Epoch Flow

| Blocks | Source | Description |
|--------|--------|-------------|
| 1-90 | `genesis_constants.rs` | Static Genesis nodes |
| 91-180 | MacroBlock #1 | Snapshot from block 90 |
| 181-270 | MacroBlock #2 | Snapshot from block 180 |
| ... | ... | Each epoch uses previous MacroBlock |

### Benefits

1. **Determinism**: All nodes read same snapshot from blockchain
2. **No Race Conditions**: Gossip propagation delays don't affect selection
3. **Scalability**: MAX_VALIDATORS_PER_EPOCH = 1000 with deterministic sampling
4. **Emergency Failover**: Uses same snapshot for consistency

---

## Timing Constants

```
Block interval:        1 second (microblock)
Blocks per rotation:   30 blocks = 30 seconds
Blocks per macroblock: 90 blocks = 90 seconds (1.5 minutes)
Finality depth:        2 macroblocks = 180 blocks = 3 minutes
```

**Macroblock formula:** `macroblock_index = block_height / 90`

Example:
- Block 89 → Macroblock 0
- Block 90 → Macroblock 1  
- Block 180 → Macroblock 2

---

## Constants

```rust
// Thresholds
INITIAL_REPUTATION = 70.0       // Starting reputation (consensus threshold)
MIN_CONSENSUS_REPUTATION = 70.0 // Minimum to participate in consensus
MAX_REPUTATION = 100.0          // Maximum cap
JAIL_THRESHOLD = 10.0           // Below = cannot recover

// Rewards  
REWARD_FULL_ROTATION = +2.0     // Completing FULL 30/30 block rotation as producer
                                // ⚠️ Partial rotation = NO REWARD!
REWARD_CONSENSUS_PARTICIPATION = +1.0  // Participating in macroblock (commit+reveal)

// Penalties
PENALTY_INVALID_BLOCK = -20.0   // Producing invalid block
PENALTY_DOUBLE_SIGN = -50.0     // Signing two blocks at same height
PENALTY_MISSED_BLOCK = -2.0     // Missing assigned block production
PENALTY_MISSED_CONSENSUS = -1.0 // Commit without reveal

// Passive Recovery (for nodes with 10-69% reputation)
PASSIVE_RECOVERY_INTERVAL = 14400  // 4 hours
PASSIVE_RECOVERY_AMOUNT = +1.0     // Per interval
PASSIVE_RECOVERY_MIN = 10.0        // Minimum to recover
PASSIVE_RECOVERY_MAX = 70.0        // Maximum from passive recovery
```

---

## State Transitions

### Node States

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        NODE STATE DIAGRAM                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│    ┌──────────────┐                                                     │
│    │   NEW NODE   │──────────────────────────────────────┐              │
│    │   (70%)      │                                      │              │
│    └──────┬───────┘                                      │              │
│           │                                              │              │
│           │ Block production / Consensus                 │              │
│           ▼                                              │              │
│    ┌──────────────┐    Slashing     ┌──────────────┐    │              │
│    │   ACTIVE     │◄───────────────►│  PENALIZED   │    │              │
│    │  (70-100%)   │   (-20%)        │  (50-69%)    │    │              │
│    └──────┬───────┘                 └──────┬───────┘    │              │
│           │                                │              │              │
│           │ +2% per rotation              │ Passive      │              │
│           │ +1% per consensus             │ Recovery     │              │
│           │                               │ +1%/4h       │              │
│           ▼                               ▼              │              │
│    ┌──────────────┐                ┌──────────────┐     │              │
│    │    MAX       │                │  RECOVERING  │     │              │
│    │   (100%)     │                │  (10-69%)    │     │              │
│    └──────────────┘                └──────┬───────┘     │              │
│                                           │              │              │
│                                           │ Multiple     │              │
│                                           │ offenses     │              │
│                                           ▼              │              │
│    ┌──────────────┐    Jail        ┌──────────────┐     │              │
│    │  PERMANENT   │◄───────────────│   JAILED     │     │              │
│    │    BAN       │  (5+ offenses  │   (0%)       │     │              │
│    │   (0%)       │   or critical) └──────┬───────┘     │              │
│    └──────────────┘                       │              │              │
│                                           │ Jail expires │              │
│                                           ▼              │              │
│                                    ┌──────────────┐     │              │
│                                    │ POST-JAIL    │◄────┘              │
│                                    │  (10-30%)    │                     │
│                                    └──────────────┘                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Jail System

### Jail Durations (Progressive)

| Offense # | Duration | Exit Reputation |
|-----------|----------|-----------------|
| 1st | 1 hour | 30% |
| 2nd | 24 hours | 25% |
| 3rd | 7 days | 20% |
| 4th | 30 days | 15% |
| 5th | 90 days | 12% |
| 6+ | 1 year | 10% |

### How Nodes Exit Jail

```rust
// In process_macroblock():
if current_timestamp >= jail_end {
    // 1. Remove from active_jails
    self.active_jails.remove(&node_id);
    
    // 2. Restore reputation based on offense count
    let restore_rep = match offense_count {
        1 => 30.0,
        2 => 25.0,
        3 => 20.0,
        4 => 15.0,
        5 => 12.0,
        _ => 10.0,
    };
    self.reputations.insert(node_id, restore_rep);
    
    // 3. Reset passive recovery timer
    self.last_passive_recovery.insert(node_id, current_timestamp);
}
```

---

## Recovery Mechanisms

### 1. Passive Recovery (10-69% → 70%)

**Who qualifies:**
- Reputation between 10% and 69%
- Not jailed
- Not permanently banned
- Online (connected via P2P with recent heartbeat)

**IMPORTANT:** "Online" ≠ "in consensus"!
- Nodes with rep < 70% **cannot** participate in consensus (commit/reveal)
- But they **can** stay connected via P2P and respond to heartbeats
- This allows them to passively recover by proving they're online

**How it works:**
```rust
// Get online nodes from P2P (connected with heartbeat in last 5 min)
let online_nodes = p2p.get_online_node_ids();

// Every macroblock, check online nodes with 10-69%:
for node_id in online_nodes {
    if current_rep >= 10.0 && current_rep < 70.0 {
        if current_timestamp >= last_recovery + 14400 { // 4 hours
            new_rep = (current_rep + 1.0).min(70.0);
        }
    }
}
```

**Recovery Time Examples:**
| Exit Reputation | Time to 70% |
|-----------------|-------------|
| 30% (1st offense) | 160 hours (6.7 days) |
| 25% (2nd offense) | 180 hours (7.5 days) |
| 20% (3rd offense) | 200 hours (8.3 days) |
| 15% (4th offense) | 220 hours (9.2 days) |
| 12% (5th offense) | 232 hours (9.7 days) |
| 10% (6+ offense) | 240 hours (10 days) |

### 2. Active Recovery (70%+ → 100%)

Once at 70%, nodes can grow reputation through:
- **Block Production:** +2% per FULL 30/30 block rotation
  - ⚠️ **CRITICAL:** Partial rotation (failover) = NO REWARD!
  - Producer must complete ALL 30 blocks without failover
- **Consensus Participation:** +1% per macroblock (commit + reveal)

**Time to 100%:**
- Consistent producer: ~15 rotations = 450 blocks = ~7.5 minutes
- Consensus only: ~30 macroblocks = ~45 minutes

---

## Light Nodes

**Fixed 70% reputation** - Light nodes:
- ✅ Always have 70% reputation
- ❌ Never participate in consensus (excluded by `NodeType::Light`)
- ✅ Can receive rewards via ping service
- ✅ Pings tracked for uptime rewards

### Light Node Ping System (1 ping per 4 hours)

Light nodes are **pinged by Full/Super nodes** once per 4-hour window:

**How it works:**
1. Full/Super nodes run `start_light_node_ping_service()` (see `rpc.rs:5557`)
2. Service checks every 60 seconds for Light nodes to ping
3. Light nodes are assigned to **shards** (0-255) based on node_id hash
4. Each Full/Super node only pings Light nodes in **its shard** (1/256 of total)
5. **Deterministic pinger selection:** Primary + 2 Backups per Light node
6. Light node responds to ping → creates `LightNodeAttestation`
7. Attestation is gossiped to all nodes

**Timing:**
- Slot duration: 1 minute (240 slots per 4h window)
- Each Light node has 1 deterministic slot for ping
- FCM/UnifiedPush/Polling methods supported

```rust
// PingRequirements for Light nodes:
NodeType::Light => Self {
    pings_per_4h_window: 1,      // 1 ping per 4 hours
    success_rate_threshold: 1.0, // 100% (binary: respond or not)
    timeout_seconds: 60,         // 60 seconds to respond
}
```

**Reward eligibility:**
- ✅ At least 1 successful attestation in 4h window → eligible for QNC reward
- ❌ No attestation → no reward for that window

```rust
// In can_produce_blocks():
match node_type {
    NodeType::Light => false, // Never produce blocks
    NodeType::Full | NodeType::Super => reputation >= 70.0,
}
```

---

## QNC Token Rewards (v2.21.1)

### Full Heartbeat System Audit (A to Z)

#### Step 1: Service Start
**Location:** `rpc.rs:1890`
```rust
// In start_rpc_server(), after all routes setup:
p2p.start_heartbeat_service(move || {
    blockchain_for_heartbeat.get_height().await
});
```

#### Step 2: Heartbeat Service Loop
**Location:** `unified_p2p.rs:10097` - `start_heartbeat_service()`

```rust
// Thread with infinite loop, checks every 30 seconds
std::thread::spawn(move || {
    loop {
        // Calculate 10 deterministic heartbeat times for this node
        let heartbeat_times = calculate_heartbeat_times_for_node(&node_id);
        
        for (index, heartbeat_time) in heartbeat_times.iter().enumerate() {
            // Check if heartbeat is due (within 60 second window)
            if now >= *heartbeat_time && now < *heartbeat_time + 60 {
                // v2.21.1 FIX: Check reputation before sending!
                if our_reputation < 70.0 {
                    continue; // Skip - not eligible
                }
                // Send heartbeat...
            }
        }
        std::thread::sleep(Duration::from_secs(30));
    }
});
```

#### Step 3: Deterministic Timing
**Location:** `unified_p2p.rs:11192` - `calculate_heartbeat_times_for_node()`

```rust
// Each node has 10 deterministic times based on node_id hash
// Spread evenly across 4h window (every 24 minutes on average)
fn calculate_heartbeat_times_for_node(node_id: &str) -> Vec<u64> {
    let hash = DefaultHasher::new().hash(node_id);
    let current_4h_window = now - (now % (4 * 60 * 60));
    
    // 10 times, each offset by hash + index
    (0..10).map(|i| {
        let slot = (hash + i as u64) % 240; // 240 minutes in 4h
        current_4h_window + slot * 60
    }).collect()
}
```

#### Step 4: Heartbeat Message
**Location:** `unified_p2p.rs:10170`

```rust
NetworkMessage::NodeHeartbeat {
    node_id: String,           // Who is sending
    node_type: String,         // "full" or "super"
    timestamp: u64,            // Unix timestamp
    block_height: u64,         // Current blockchain height
    signature: String,         // Ed25519 ephemeral signature
    heartbeat_index: u8,       // 0-9 (which of 10 heartbeats)
    gossip_hop: u8,            // TTL counter (max 3)
}
```

#### Step 5: Gossip to Network
**Location:** `unified_p2p.rs:10184`
```rust
// Send to K closest peers by XOR distance (DHT routing)
p2p.gossip_to_k_neighbors(heartbeat_msg, 3);
```

#### Step 6: Receive & Validate
**Location:** `unified_p2p.rs:8988` - `NodeHeartbeat` handler

```rust
// Validation checks:
// 1. Gossip TTL: max 3 hops
// 2. Timestamp: within ±5 minutes
// 3. Dedupe: not already received for this 4h window
// 4. v2.21.1 FIX: Reputation >= 70%
// 5. Ed25519 signature verification
```

#### Step 7: Store in RAM
**Location:** `unified_p2p.rs:9108`

```rust
// Storage structure:
heartbeat_history: Arc<RwLock<HashMap<String, HeartbeatRecord>>>

// Key format: "{node_id}:{heartbeat_index}" (e.g., "node_001:5")
// Value:
pub struct HeartbeatRecord {
    pub node_id: String,
    pub timestamp: u64,
    pub heartbeat_index: u8,      // 0-9
    pub signature: String,
    pub verified: bool,           // Always true after validation
}
```

#### Step 8: Count for Rewards
**Location:** `unified_p2p.rs:11099` - `get_heartbeats_for_window()`

```rust
// Filter heartbeats by 4h window
pub fn get_heartbeats_for_window(&self, window_start: u64) -> Vec<(String, u8, u64)> {
    let window_end = window_start + (4 * 60 * 60);
    heartbeats.values()
        .filter(|h| h.timestamp >= window_start && h.timestamp < window_end)
        .map(|h| (h.node_id.clone(), h.heartbeat_index, h.timestamp))
        .collect()
}
```

#### Step 9: Eligibility Check
**Location:** `unified_p2p.rs:11131` - `get_eligible_full_super_nodes()`

```rust
// Count heartbeats per node, then filter:
.filter(|(node_id, node_type, count)| {
    // v2.21.1 FIX: Check reputation!
    let reputation = self.get_node_reputation(node_id);
    if reputation < 70.0 {
        return false;
    }
    
    // Eligibility thresholds:
    match node_type.as_str() {
        "super" => *count >= 9,  // 90% success rate
        "full" => *count >= 8,   // 80% success rate
        _ => false,
    }
})
```

#### Step 10: Process Rewards
**Location:** `node.rs:622` - `process_reward_window()`

```rust
// Called every 4 hours by system
// 1. Get eligible Full/Super nodes
let eligible_full_super = p2p.get_eligible_full_super_nodes(window_start);

// 2. Register and record pings for each
for (node_id, node_type, count) in eligible_full_super {
    reward_manager.register_node(node_id, reward_type, wallet);
    for _ in 0..count {
        reward_manager.record_ping_attempt(&node_id, true, 0);
    }
}

// 3. Calculate and emit rewards
reward_manager.force_process_window();
```

#### Step 11: Cleanup
**Location:** `unified_p2p.rs:10393` - `cleanup_old_heartbeats()`

```rust
// Remove heartbeats older than 24 hours
let cutoff = now - (24 * 60 * 60);
history.retain(|_, record| record.timestamp >= cutoff);
```

### Requirements Summary

| Node Type | Pings/4h | Required | Success Rate | Timeout | Reputation |
|-----------|----------|----------|--------------|---------|------------|
| Super | 10 heartbeats | 9+ | 90% | 30 sec | >= 70% |
| Full | 10 heartbeats | 8+ | 80% | 30 sec | >= 70% |
| Light | 1 ping (by server) | 1 | 100% | 60 sec | Fixed 70% |

### Scalability Analysis

**Heartbeat loop (30 sec interval):**
- Loop only CHECKS timer, doesn't send every 30 sec
- Real heartbeat sent only when `now >= heartbeat_time`
- 10 heartbeats spread across 4h = every ~24 minutes
- CPU cost: ~0% (just comparing timestamps)

**Network load for heartbeats:**
| Nodes | Heartbeats/4h | Rate | Bandwidth |
|-------|---------------|------|-----------|
| 1,000 | 10,000 | 0.7/sec | 2.8 Kbit/s |
| 10,000 | 100,000 | 7/sec | 28 Kbit/s |
| 100,000 | 1,000,000 | 70/sec | 280 Kbit/s |

**Light node sharding (256 shards):**
- Each Full/Super pings only 1/256 of Light nodes
- 1M Light nodes → each server pings ~3,906 nodes
- 3,906 / 240 slots = ~16 pings/minute per server

### 3-Layer Reputation Protection (v2.21.1)

| Layer | Location | Check | Attack Prevented |
|-------|----------|-------|------------------|
| 1️⃣ Sender | `start_heartbeat_service` | Own rep >= 70% | Low-rep node flooding |
| 2️⃣ Receiver | `NodeHeartbeat` handler | Sender rep >= 70% | Sybil replay attacks |
| 3️⃣ Reward | `get_eligible_full_super_nodes` | Node rep >= 70% | Edge cases, races |

---

## Failover Helpers

**No special reputation bonus** for failover participation:
- Emergency producer selection based on existing reputation
- Reward comes via normal block production (+2% per rotation)
- Prevents gaming of failover system

---

## Slashing Events

### Types

| Type | Penalty | Evidence Required |
|------|---------|-------------------|
| DoubleSign | -50% + Permanent Ban | Both signed blocks |
| InvalidBlock | -20% | Invalid block data |
| ChainFork | -100% + Permanent Ban | Conflicting chain data |
| MissedBlocks | -2% per block | List of missed heights |

### Collection Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Detect Offense │────►│ report_invalid_ │────►│ slashing_       │
│  (validation)   │     │ block() / etc   │     │ collector       │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         │ Macroblock
                                                         │ creation
                                                         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ All nodes apply │◄────│ drain_slashing_ │◄────│ MacroBlock      │
│ same penalties  │     │ events()        │     │ ConsensusData   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

---

## Network Impact

### Storage
- Reputation: `HashMap<node_id, f64>` (~100 bytes/node)
- Jails: `HashMap<node_id, (timestamp, count)>` (~50 bytes/node)
- Bans: `HashSet<node_id>` (~30 bytes/node)
- **1000 nodes ≈ 180 KB RAM**

### Network Traffic
- **ZERO** for reputation queries (local blockchain data)
- SlashingEvent: ~200 bytes in macroblock
- Overhead: <1% of macroblock size

### Performance
- `get_reputation()`: O(1)
- `process_block()`: O(1)
- `process_macroblock()`: O(n) where n = participants (~5-20)
- `apply_passive_recovery()`: O(m) where m = online nodes

---

## Initialization

### Genesis Nodes
```rust
fn init_genesis_nodes(&mut self, genesis_ids: &[String]) {
    for id in genesis_ids {
        self.reputations.insert(id.clone(), INITIAL_REPUTATION); // 70%
    }
}
```

### New Nodes
- Start with 70% (INITIAL_REPUTATION)
- Immediately eligible for consensus if Full/Super type

---

## Finality Checkpoints (v2.1)

**Protection against long-range attacks:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    FINALITY TIMELINE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Block 0────────Block 90────────Block 180────────Block 270      │
│         │               │                │                │      │
│         ▼               ▼                ▼                ▼      │
│    Macroblock 0    Macroblock 1    Macroblock 2    Macroblock 3 │
│         │               │                │                │      │
│         │               │                ▼                │      │
│         │               │          FINAL (2/3+)           │      │
│         │               ▼                                 │      │
│         │         Checkpoint created                      │      │
│         ▼         (collecting sigs)                       │      │
│    NOT FINAL                                              │      │
│                                                                  │
│  After 2 macroblocks with 2/3+ signatures = IRREVERSIBLE        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key structures:**
```rust
pub const FINALITY_DEPTH: u64 = 2;        // 2 macroblocks = 180 blocks = 3 min
pub const FINALITY_THRESHOLD: f64 = 0.67; // 2/3+1 signatures required

pub struct FinalityCheckpoint {
    pub macroblock_index: u64,
    pub macroblock_hash: [u8; 32],
    pub signatures: HashMap<String, Vec<u8>>,  // 2/3+ validators
    pub is_final: bool,
}
```

**Usage:**
```rust
// Check if block is finalized
let is_final = finality_manager.is_height_finalized(block_height);

// Get last finalized height
let final_height = finality_manager.last_finalized_height();
```

---

## Full Reputation Snapshot (v2.24)

### Problem: Reputation Drift

Before v2.24, nodes could have different reputation values due to:
- Out-of-order block processing
- Failed deserialization of some blocks
- Different blockchain heights

### Solution: Deterministic Snapshots

Every macroblock now contains a **FULL reputation snapshot** stored in blockchain:

```rust
/// Complete reputation snapshot (stored in ConsensusData)
pub struct FullReputationSnapshot {
    pub reputations: HashMap<String, f64>,       // Node reputations (0-100%)
    pub active_jails: HashMap<String, (u64, u32)>, // Jail end time + offense count
    pub permanent_bans: HashSet<String>,          // Permanently banned nodes
    pub offense_counts: HashMap<String, u32>,     // Progressive jail counter
    pub last_passive_recovery: HashMap<String, u64>, // Recovery timers
    pub processed_rotations: HashSet<u64>,        // Duplicate protection
}
```

### How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SNAPSHOT FLOW                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Producer creates macroblock:                                        │
│    → rep_state.create_snapshot()                                    │
│    → Serialize ALL reputation state to bincode                       │
│    → Store in ConsensusData.reputation_snapshot                     │
│                                                                      │
│  All nodes receive macroblock:                                       │
│    → rep_state.apply_snapshot(snapshot_data)                        │
│    → OVERWRITE local state with blockchain values                   │
│    → All nodes now have IDENTICAL reputation!                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Security: Cannot Forge Reputation

| Attack Vector | Protection |
|--------------|------------|
| Modify snapshot | Macroblock signed by 2/3+ validators |
| Fake jails | Evidence verified in SlashingEvent |
| Skip bans | permanent_bans in snapshot are authoritative |
| Inflate reputation | Snapshot overwrites any local manipulation |

### Storage Impact

| Nodes | Snapshot Size | Per Macroblock |
|-------|--------------|----------------|
| 100 | ~15 KB | Negligible |
| 1,000 | ~150 KB | 0.1% overhead |
| 10,000 | ~1.5 MB | 1% overhead |

---

## Scalability (1000+ nodes)

**Built-in chunked processing for 10,000+ nodes:**

```rust
// Constants for scalability
pub const PROCESSING_CHUNK_SIZE: usize = 1000;           // Chunk size
pub const MAX_SLASHING_EVENTS_PER_MACROBLOCK: usize = 100; // DoS protection
pub const MAX_AUTO_JAILS_PER_MACROBLOCK: usize = 50;       // Spam protection
```

| Operation | 100 nodes | 1,000 nodes | 10,000 nodes | 100,000 nodes |
|-----------|-----------|-------------|--------------|---------------|
| `get_reputation()` | O(1) ~1μs | O(1) ~1μs | O(1) ~1μs | O(1) ~1μs |
| `process_block()` | O(1) ~5μs | O(1) ~5μs | O(1) ~5μs | O(1) ~5μs |
| `process_macroblock()` | ~1ms | ~10ms | ~50ms | ~500ms (chunked) |
| `apply_passive_recovery()` | ~0.5ms | ~5ms | ~25ms | ~250ms (chunked) |
| RAM usage | ~10 KB | ~100 KB | ~1 MB | ~10 MB |

**Chunked processing:**
```rust
// All operations process in chunks of 1000
pub fn apply_passive_recovery(&mut self, online_nodes: &[String], ts: u64) {
    for chunk in online_nodes.chunks(PROCESSING_CHUNK_SIZE) {
        self.apply_passive_recovery_chunk(chunk, ts);
    }
}
```

**Statistics API:**
```rust
let stats = rep_state.get_stats();
// ReputationStats {
//     total_nodes: 10000,
//     consensus_eligible: 8500,  // rep >= 70%
//     recovering: 1200,          // rep 10-69%
//     low_rep: 300,              // rep < 10%
//     active_jails: 50,
//     permanent_bans: 10,
// }

let memory = rep_state.estimate_memory_bytes(); // ~1MB for 10K nodes
```

---

## Comparison with Other Blockchains

| Blockchain | Slashing | Recovery | On-Chain | Finality |
|------------|----------|----------|----------|----------|
| Ethereum 2.0 | ✅ Yes | ✅ Withdrawal queue | ✅ Yes | ✅ 2 epochs |
| Cosmos/Tendermint | ✅ Yes | ✅ Unjail tx | ✅ Yes | ✅ Instant |
| Polkadot | ✅ Yes | ✅ Unbonding | ✅ Yes | ✅ GRANDPA |
| Solana | ❌ Soft | ❌ N/A | ❌ No | ❌ Probabilistic |
| **QNET** | ✅ Yes | ✅ Passive + Active | ✅ Yes | ✅ 2 macroblocks |

---

## Code Locations

| Component | File | Function |
|-----------|------|----------|
| State | `deterministic_reputation.rs` | `DeterministicReputationState` |
| Block Processing | `node.rs` | `process_received_blocks()` |
| Macroblock | `node.rs` | line ~2920 |
| Slashing Collector | `unified_p2p.rs` | `slashing_collector` |
| Report Invalid | `unified_p2p.rs` | `report_invalid_block()` |
| Finality | `macro_consensus.rs` | `FinalityManager` |

---

## Tests

Run audit: `python tests/reputation_audit.py`

| Test | Status |
|------|--------|
| Initial Reputation | ✅ |
| Block Production Reward | ✅ |
| Consensus Participation | ✅ |
| Commit Without Reveal | ✅ |
| Slashing Invalid Block | ✅ |
| Double Sign Ban | ✅ |
| Automatic Jail | ✅ |
| Jail Exit & Recovery | ✅ |
| Progressive Jail | ✅ |
| Reputation Caps | ✅ |
| Finality Checkpoint | ✅ |
| Invalid Evidence | ✅ |
| Deterministic Consistency | ✅ |
| Memory Efficiency | ✅ |
| Light Nodes | ✅ |
| **SHRED Protocol Retransmit** | ✅ |

---

## SHRED Protocol Retransmit (v2.21.3)

### Overview

The SHRED Protocol Retransmit mechanism enables efficient recovery of missing block chunks
without downloading entire blocks. This significantly reduces bandwidth usage and improves
block propagation reliability.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SHRED RETRANSMIT FLOW                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. Node receives chunks for block #100                                 │
│     └── Got: 9/12 data chunks + 3/6 parity                              │
│     └── Missing: chunks 3, 7, 11                                        │
│                                                                         │
│  2. After 3 seconds timeout:                                            │
│     └── RequestMissingChunks { block: 100, indices: [3, 7, 11] }        │
│     └── Sent to 3-10 peers (adaptive based on network size)             │
│                                                                         │
│  3. Peers with cached chunks respond:                                   │
│     └── MissingChunksResponse { block: 100, chunks: [...] }             │
│                                                                         │
│  4. Node reconstructs block:                                            │
│     └── Reed-Solomon if needed                                          │
│     └── Block saved to storage                                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Constants

```rust
SHRED_CHUNK_TIMEOUT_SECS = 3    // Timeout before requesting missing chunks
SHRED_CHUNK_CACHE_SIZE = 100   // Cache last 100 blocks' chunks for retransmit
SHRED_CHUNK_MAX_RETRIES = 2    // Maximum retransmit attempts per block
```

### Adaptive Peer Selection

The number of peers to request chunks from scales with network size:

| Network Size | Request Peers | Success Probability* |
|--------------|---------------|---------------------|
| 5-10 nodes | 3 | 87.5% |
| 11-100 nodes | 5 | 96.9% |
| 101-1,000 nodes | 6 | 98.4% |
| 1,001-10,000 nodes | 7 | 99.2% |
| 10,001-100,000 nodes | 8 | 99.6% |
| >100,000 nodes | 10 | 99.9% |

*Assuming 50% of peers have the chunk cached

### Bandwidth Savings

| Scenario | Full Block Download | Retransmit | Savings |
|----------|---------------------|------------|---------|
| 2 missing chunks | 12KB | 2KB | 83% |
| 3 missing chunks | 12KB | 3KB | 75% |
| 5 missing chunks | 12KB | 5KB | 58% |

### NetworkMessage Types

```rust
// Request missing chunks
RequestMissingChunks {
    block_height: u64,
    missing_indices: Vec<usize>,
    requester_id: String,
    timestamp: u64,
}

// Response with chunks
MissingChunksResponse {
    block_height: u64,
    chunks: Vec<(usize, Vec<u8>, bool)>,  // (index, data, is_parity)
    original_block_size: usize,
    is_macroblock: bool,
    sender_id: String,
}
```

### Macroblock Support

✅ Retransmit works for both microblocks and macroblocks:
- `is_macroblock` flag preserved in cache and responses
- Larger macroblock chunks handled correctly
- Reed-Solomon parity works for both block types

### Privacy

All peer addresses in logs use pseudonyms via `get_privacy_id_for_addr()`:
- Real IPs are never logged
- Pseudonyms generated from hash of IP address
- Genesis node IDs preserved for identification


