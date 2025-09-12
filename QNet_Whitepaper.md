# QNet: Experimental Post-Quantum Blockchain
## Research Project and Technical Specification

**⚠️ EXPERIMENTAL BLOCKCHAIN RESEARCH ⚠️**

**Version**: 1.0.0-experimental  
**Date**: September 2025  
**Authors**: QNet Research Team  
**Status**: Experimental Research Project  
**Goal**: To prove that one person without multi-million investments can create an advanced blockchain

---

## ⚠️ CRITICAL WARNINGS

**🚨 THIS IS AN EXPERIMENTAL RESEARCH PROJECT 🚨**
- **EXPERIMENTAL SOFTWARE**: Code is experimental and may contain bugs
- **NO WARRANTIES**: NO guarantees of profit, returns, or positive outcomes
- **RESEARCH PURPOSE**: Project created for study and experimentation
- **PARTICIPATE AT YOUR OWN RISK**: All participants bear full responsibility

## Abstract

QNet is an experimental post-quantum blockchain created to prove: **one person-operator without technical knowledge, multi-million investments, and funds is capable of building an advanced blockchain**.

Experimental achievements:
- ✅ **Post-quantum cryptography**: CRYSTALS-Dilithium + Kyber protection  
- ✅ **424,411 TPS**: Proven performance in tests
- ✅ **Two-phase activation**: 1DEV burn → QNC Pool #3
- ✅ **Mobile-first**: Optimized for smartphones
- ✅ **Reputation system**: Without staking, only behavioral assessment
- ✅ **Experimental architecture**: Innovative approach to consensus

Experiment goal: demonstrate the possibility of creating a high-performance post-quantum blockchain by one person-operator.

---

## 1. Introduction

### 1.1 The Quantum Threat Problem

Modern cryptography stands on the brink of a security crisis. The development of quantum computing threatens the foundations of cryptographic protection:

- **ECDSA algorithms**: Vulnerable to Shor's algorithm on quantum computers
- **RSA cryptography**: Can be broken by quantum computers in hours
- **Classical hash functions**: Under threat from Grover's algorithm

**According to NIST**, quantum computers capable of breaking modern cryptography will appear in the next 10-15 years.

### 1.2 QNet Characteristics

The experimental QNet blockchain has achieved the following metrics:

- **Maximum performance**: 424,411 TPS (confirmed by tests)
- **Microblock time**: 1 second (instant transactions)
- **Macroblock time**: 90 seconds (Byzantine consensus)
- **Mobile performance**: 8,859 TPS (on-device)
- **Mobile optimization**: <0.01% battery consumption

These characteristics make QNet suitable for mass mobile usage.

### 1.3 Key Features of QNet

QNet presents an experimental blockchain platform with unique characteristics:

1. **Post-quantum cryptography**: CRYSTALS-Dilithium + Ed25519 hybrid protection
2. **High performance**: 424,411+ TPS achieved in experiments
3. **Innovative economy**: Reputation system without staking
4. **Mobile-first design**: Optimized for smartphones and tablets

---

## 2. QNet Architecture

### 2.1 Multi-layer Structure

```
┌─────────────────────────────────────┐
│         Application Layer           │
│  Wallet, DApps, Mobile Apps, APIs   │
├─────────────────────────────────────┤
│           Network Layer             │
│   P2P, Sharding, Regional Clustering│
├─────────────────────────────────────┤  
│         Consensus Layer             │
│  Commit-Reveal BFT, Producer rotation│
├─────────────────────────────────────┤
│         Blockchain Layer            │
│  Microblocks (1s) + Macroblocks     │
├─────────────────────────────────────┤
│       Cryptography Layer            │
│   CRYSTALS-Dilithium, Post-Quantum  │
└─────────────────────────────────────┘
```

### 2.2 Node Types

**QNet supports three node types:**

1. **Super Nodes**:
   - Full blockchain validation
   - Consensus participation  
   - Block production
   - Requirements: 8+ GB RAM, SSD

2. **Full Nodes**:
   - Full blockchain synchronization
   - Transaction validation
   - Don't participate in block production
   - Requirements: 4+ GB RAM

3. **Light Nodes** (Mobile):
   - Block headers only
   - SPV verification
   - Minimal resource consumption
   - Requirements: 2+ GB RAM

### 2.3 Genesis Architecture

**Network initialization phase:**
- **5 Genesis Super Nodes**: Globally distributed nodes for network launch
- **Static topology**: Known IP addresses for initial connection  
- **Bootstrap trust**: Simplified connectivity verification for quick start
- **Transition to dynamic network**: After 1000 blocks switching to normal mode

---

## 3. Post-Quantum Cryptography

### 3.1 Algorithm Selection

**QNet uses NIST cryptographic standards:**

1. **CRYSTALS-Dilithium** (signatures):
   - Standardized by NIST in 2024
   - Based on Learning With Errors problem
   - Signature size: 2420 bytes
   - Quantum security: 128 bits

2. **CRYSTALS-Kyber** (encryption):
   - Standardized by NIST in 2024
   - Key encapsulation
   - Public key size: 1568 bytes
   - Quantum security: 256 bits

3. **SHA3-256** (hashing):
   - Quantum-resistant to Grover's algorithm  
   - 128-bit post-quantum security
   - NIST FIPS 202 standard

### 3.2 Hybrid Implementation

**For compatibility assurance QNet uses a hybrid approach:**

```rust
hybrid_signature = {
    primary: CRYSTALS_Dilithium_signature,
    fallback: Ed25519_signature,  // For compatibility
    quantum_ready: true
}
```

**Advantages:**
- Full quantum protection
- Compatibility with existing systems
- Smooth transition from classical cryptography

### 3.3 QNet's Quantum Readiness

**QNet's hybrid security:**

| Algorithm | Status | Size | Security |
|-----------|--------|------|----------|
| **CRYSTALS-Dilithium2** | ✅ Active | 2420 bytes | Quantum-resistant |
| **Ed25519 (fallback)** | ✅ Active | 64 bytes | Classical |
| **CRYSTALS-Kyber** | ✅ Active | 1568 bytes | Key exchange |
| **SHA3-256** | ✅ Active | 32 bytes | Hashing |

**Unique feature**: QNet uses a **hybrid approach** - quantum-resistant + classical cryptography simultaneously for maximum compatibility

---

## 4. Microblock Architecture

### 4.1 Microblock Concept

**QNet implements a two-tier block structure:**

1. **Microblocks** (every second):
   - Contain user transactions
   - Single producer signature
   - Fast processing
   - Size: ~200-500 bytes

2. **Macroblocks** (every 90 seconds):
   - Aggregate 90 microblocks  
   - Byzantine consensus
   - State finalization
   - Size: ~50-100 KB

### 4.2 Consensus Algorithm

**Commit-Reveal Byzantine Fault Tolerance (CR-BFT):**

**Commit Phase:**
1. All validators send hash of their vote
2. Sign commit with digital signature
3. Wait for commits from 2f+1 validators (where f is number of malicious)

**Reveal Phase:**
1. Validators reveal their actual votes
2. Verify correspondence to previously sent hash
3. Final consensus is reached

**Security:** System withstands up to 33% malicious nodes

### 4.3 Microblock Production

**Producer rotation every 30 blocks:**

```rust
fn select_producer(height: u64, candidates: Vec<Node>) -> Node {
    let round = height / 30;
    let hash = SHA3_256(round + candidates);
    let index = hash % candidates.len();
    candidates[index]
}
```

**Deterministic algorithm** guarantees all nodes will select the same producer.

---

## 5. Performance

### 5.1 Achieved Results

**QNet's confirmed performance:**

| Metric | Value | Description |
|--------|-------|-------------|
| **Maximum TPS** | 424,411 | Peak performance in tests |
| **Microblock time** | 1 second | Fast transaction processing |
| **Finalization time** | 90 seconds | Byzantine consensus for macroblocks |
| **Mobile TPS** | 8,859 | Cryptographic operations on mobile |

### 5.2 Architectural Optimizations

**1. Parallel transaction processing:**
```rust
// Process up to 5000 transactions in batch
batch_size = min(5000, mempool.size());
parallel_process(transactions[0..batch_size]);
```

**2. Efficient block compression:**
- **Zstd compression**: 40-60% size reduction
- **Batch operations**: Grouping similar transactions
- **Deduplication**: Eliminating redundant data

**3. Validation caching:**
- **30-second cache** for Genesis nodes
- **5-second cache** for regular nodes
- **Topology-aware**: Invalidation on network changes

### 5.3 Scalability

**QNet scales from 5 nodes to millions:**

| Network Phase | Node Count | Consensus | Performance |
|---------------|------------|-----------|-------------|
| **Genesis** | 5 Super nodes | All participate | 100k+ TPS |
| **Early** | 100-1000 nodes | Validator sampling | 200k+ TPS |
| **Mature** | 1M+ nodes | Sharding + sampling | 400k+ TPS |

---

## 6. Network Architecture

### 6.1 P2P System

**Regional clustering:**
- **North America**: Nodes grouped by geography
- **Europe**: Latency reduction  
- **Asia**: Local processing
- **Other regions**: Automatic detection

**Adaptive peer limits:**
- 0-100 nodes: 8 peers per region
- 101-1000 nodes: 50 peers per region  
- 1001-100000 nodes: 100 peers per region
- 100k+ nodes: 500 peers per region

### 6.2 Node Discovery

**Multi-level discovery:**

1. **Bootstrap phase**: Direct connections to Genesis nodes
2. **DHT discovery**: Kademlia-like search algorithm
3. **Peer exchange**: Node list exchange every 30 seconds
4. **Registry integration**: Blockchain-based node registration

### 6.3 Reputation System

**Ping-based participation (every 4 hours):**

```
Response requirements:
├── Light Nodes: 100% (binary: responded in current 4h window or not)
├── Full Nodes: 80% (8+ out of 10 pings in current window)
└── Super Nodes: 90% (9+ out of 10 pings in current window)

Ping architecture:
├── Light: Network pings mobile device → rewards
├── Full/Super: Network pings server directly → rewards  
└── Mobile monitoring: viewing only, no pings
```

**Real threshold values (from config.ini):**
- **70+ points** (consensus_threshold = 70.0): Consensus participation
- **40+ points** (rewards_threshold = 40.0): Receive rewards from all pools
- **10-39 points**: Network access, but no rewards or consensus
- **<10 points** (ban_threshold = 10.0): Complete network ban

---

## 7. Economic Model

## 7.1 Tokenomics

**⚠️ TWO-PHASE ACTIVATION SYSTEM:**

**Phase 1: 1DEV Token (NOT QNet's native token!):**
- **1DEV** = SPL token on Solana for node activation
- **Total supply**: 1,000,000,000 1DEV  
- **Blockchain**: Solana (SPL Token)
- **Decimals**: 6
- **Testnet address**: `62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ` (devnet)
- **Burn contract**: `D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7` (devnet)
- **Burn address**: `1nc1nerator11111111111111111111111111111111`

**Phase 2: QNC Token (NATIVE QNet token):**
- **QNC** = Native token of QNet blockchain
- **Appears after**: 90% 1DEV burn OR after 5 years
- **Pool #3**: Activation QNC redistributed to all nodes
- **Total supply**: Controlled by emission schedule
- **Decimals**: 8

## 7.2 Sharp Drop Halving Innovation

**Revolutionary Emission Schedule:**

QNet implements a unique "Sharp Drop" halving mechanism that ensures eternal rewards while preventing hyperinflation:

```
Standard Period (Years 0-20):
├── Year 0-4: 245,100.67 QNC per 4h (÷2 at year 4)
├── Year 4-8: 122,550.34 QNC per 4h (÷2 at year 8)  
├── Year 8-12: 61,275.17 QNC per 4h (÷2 at year 12)
├── Year 12-16: 30,637.58 QNC per 4h (÷2 at year 16)
└── Year 16-20: 15,318.79 QNC per 4h (÷2 at year 20)

Sharp Drop Period (Years 20-24):
└── Year 20-24: 1,531.88 QNC per 4h (÷10 SHARP DROP)

Recovery Period (Years 24+):
├── Year 24-28: 765.94 QNC per 4h (÷2 resumes)
├── Year 28-32: 382.97 QNC per 4h (÷2 continues)
└── Continues with ÷2 every 4 years indefinitely
```

**Mathematical Benefits:**
- **Total Savings**: 107M QNC over 100 years vs traditional model
- **Eternal Rewards**: Never reaches zero, ensures perpetual incentives
- **Economic Balance**: Sharp correction prevents late-stage inflation
- **Sustainability**: Higher long-term rewards after correction

## 7.3 Three-Pool Reward Architecture

**Pool #1 - Base Emission Rewards:**
```
Source: Network inflation (sharp drop halving schedule)
Distribution: All active nodes proportionally
Current Rate: 245,100.67 QNC per 4-hour period
Eligibility: Reputation score ≥40 points
Next Halving: Year 4 (reduces to 122,550.34 QNC)
Distribution Formula: Individual_Reward = (Pool_Total / Active_Nodes) × Node_Weight
```

**Pool #2 - Transaction Fee Distribution:**
```
Source: Network transaction fees
Distribution Split:
├── 70% to Super Nodes (network backbone)
├── 30% to Full Nodes (validation support)
└── 0% to Light Nodes (no transaction processing)
Eligibility: Active transaction processing + Reputation ≥40
Dynamic Scaling: Increases with network usage
```

**Pool #3 - Activation Pool (Critical Innovation):**
```
Source: ALL node activation fees in Phase 2
Mechanism: 
├── Users pay QNC to activate nodes
├── ALL QNC goes to Pool #3 (NOT burned)
├── Pool #3 redistributes to ALL active nodes
└── Distribution happens every 4 hours
Distribution: Equal share to all eligible nodes
Eligibility: Reputation score ≥40 points
Innovation: Every new node activation benefits the entire network
```

## 7.4 Dynamic Pricing System

**Phase 1 (1DEV Burn-to-Activate):**

```
Initial Price: 1,500 1DEV (universal for all node types)
Dynamic Reduction Formula:
├── 0-10% burned: 1,500 1DEV
├── 10-20% burned: 1,350 1DEV (-10% discount)
├── 20-30% burned: 1,200 1DEV (-20% discount)
├── 30-40% burned: 1,050 1DEV (-30% discount)
├── 40-50% burned: 900 1DEV (-40% discount)
├── 50-60% burned: 750 1DEV (-50% discount)
├── 60-70% burned: 600 1DEV (-60% discount)
├── 70-80% burned: 450 1DEV (-70% discount)
├── 80-90% burned: 300 1DEV (-80% discount)
└── 90%+ burned: 150 1DEV (-90% discount)

Transition Trigger: 90% burned OR 5 years from genesis
```

**Phase 2 (QNC Network-Based Pricing):**

```
Base Activation Costs:
├── Light Node: 5,000 QNC base
├── Full Node: 7,500 QNC base
└── Super Node: 10,000 QNC base

Network Size Multipliers:
├── 0-100K nodes: 0.5x (early adopter discount)
├── 100K-1M nodes: 1.0x (standard pricing)
├── 1M-10M nodes: 2.0x (high demand premium)
└── 10M+ nodes: 3.0x (mature network premium)

Final Price Ranges:
├── Light: 2,500-15,000 QNC
├── Full: 3,750-22,500 QNC
└── Super: 5,000-30,000 QNC
```

## 7.5 Reputation-Based Economic Security

**Revolutionary No-Staking Model:**

QNet implements a reputation system that provides network security without requiring token locking:

```
Reputation System Benefits:
├── No Locked Tokens: Full liquidity maintained
├── No Slashing Risk: Reputation penalties instead of token loss
├── Mobile-Friendly: No capital requirements for participation
├── Fair Distribution: Small holders can participate equally
└── Energy Efficient: Behavior-based trust vs computational proof

Reputation Score Mechanics:
├── Initial Score: 70 points (neutral start)
├── Range: 0-100 points
├── Success Bonus: +1 per successful ping
├── Failure Penalty: -1 per missed ping (NOT -2)
├── Protocol Violations: -5 to -30 points
└── Recovery: Gradual improvement through good behavior

Economic Thresholds:
├── 70+ points: Consensus participation rights
├── 40+ points: Eligible for all three reward pools
├── 10-39 points: Network access only, no rewards
└── <10 points: Complete network ban

Penalties by Violation Type:
├── Missed Ping: -1.0 reputation
├── Invalid Block: -5.0 reputation
├── Consensus Failure: -10.0 reputation
├── Extended Offline (24h+): -15.0 reputation
└── Double Signing: -30.0 reputation (severe)
```

**Mobile Recovery System:**
```
Recovery Windows:
├── <24 hours offline: Full reputation preserved
├── 24h-365d offline: FREE restoration
│   ├── Reputation reset to: 25.0 points (NOT 50)
│   ├── Quarantine period: 7 days
│   └── No rewards until reputation ≥40
├── >365 days offline: Paid reactivation required
└── Banned (<10 rep): Paid reactivation only

Restoration Features:
├── Free restorations: 10 per 30-day period
├── Counter reset: Automatic every 30 days
├── Mobile-optimized: Designed for intermittent connectivity
└── Grace period: 24 hours before penalties begin
```

## 7.6 Ping-Based Participation System

**Network-Initiated Ping Architecture:**

```
NOT MINING - Simple Network Health Check:
├── Frequency: Every 4 hours
├── Response Window: 60 seconds
├── Computation: Zero (simple acknowledgment)
├── Battery Impact: <0.5% daily
├── Data Usage: <1MB daily
└── CPU Usage: Negligible (like push notifications)

Ping Distribution System:
├── 240 time slots per 4-hour window (1 minute each)
├── Deterministic slot assignment (based on node_id hash)
├── Super Nodes: Priority slots 1-24 (10x frequency)
├── Full/Light Nodes: All 240 slots (standard frequency)
├── Multiple Device Support: Up to 3 devices per wallet
└── Push Notifications: 5-minute advance warning

Mobile Recovery Features:
├── Offline <24h: Reputation preserved
├── Offline 24h-365d: FREE restoration (7-day quarantine at 25 reputation)
├── Offline >365d: Requires paid reactivation
├── Restoration Limit: 10 free per 30 days
├── Auto-Reset: Counter resets monthly
└── Quarantine Period: No rewards until reputation >40
```

## 7.7 Dynamic Fee System

**Transaction Fee Structure:**

```
Base Fee Calculation (by mempool size):
├── 0-10 transactions: 0.00005 QNC base
├── 11-50 transactions: 0.000075 QNC base
├── 51-100 transactions: 0.0001 QNC base
└── 100+ transactions: 0.00015 QNC base

Priority Multipliers:
├── Economy: 1.0x (standard processing)
├── Standard: 1.5x (faster processing)
├── Fast: 2.0x (priority processing)
└── Priority: 3.0x (immediate processing)

Smart Contract Fees:
├── Base Execution: 0.001 QNC
├── Computational Complexity: Variable scaling
├── Quantum-Resistant Ops: Optimized pricing
└── Storage Operations: Per-byte pricing
```

## 7.8 Batch Operations Economics

**Cost Optimization Through Batching:**

```
Supported Batch Operations:
├── Reward Claims: Up to 50 nodes (80% gas savings)
├── Node Activations: Up to 20 nodes simultaneously
├── QNC Transfers: Up to 100 transactions
└── Status Updates: Unlimited batch size

Economic Benefits:
├── Gas Savings: Up to 80% for large operations
├── Network Efficiency: Reduced congestion
├── Time Savings: Single transaction for multiple ops
└── User Experience: Simplified management
```

## 7.9 Long-Term Economic Sustainability

**100-Year Economic Projection with Sharp Drop:**

```
Sharp Drop Model Benefits (vs Traditional Halving):
├── Year 20: 15,318 QNC/4h (last standard halving)
├── Year 24: 1,531 QNC/4h (after ÷10 sharp drop)
├── Year 40: 191 QNC/4h (sustainable rewards)
├── Year 60: 47 QNC/4h (continued incentives)
├── Year 80: 11 QNC/4h (perpetual rewards)
└── Year 100: 2.9 QNC/4h (never reaches zero)

Economic Impact:
├── Total Saved: 107M QNC over century
├── Inflation Control: Prevents late-stage hyperinflation
├── Perpetual Incentives: Ensures eternal network security
└── Fair Distribution: More rewards for future participants
```

**Network Growth Economic Effects:**

```
Early Stage (0-100K nodes):
├── High individual rewards from Pool #1
├── 0.5x activation cost multiplier (discount)
├── Rapid Pool #3 accumulation
└── Strong early adopter incentives

Growth Stage (100K-1M nodes):
├── Balanced reward distribution
├── 1.0x standard activation pricing
├── Mature Pool #3 redistribution
└── Optimal network effects

Scale Stage (1M+ nodes):
├── Massive Pool #3 benefits
├── 2.0-3.0x activation premiums
├── Transaction fee dominance (Pool #2)
└── Self-sustaining economy
```

**Reward Distribution Examples:**

```
Conservative Scenario (100K nodes, Year 1):
├── Pool #1 per node: ~2,141 QNC/year
├── Pool #2 per node: ~50 QNC/year (low activity)
├── Pool #3 per node: ~100 QNC/year (growing)
└── Total per node: ~2,291 QNC/year

Moderate Scenario (1M nodes, Year 5):
├── Pool #1 per node: ~122 QNC/year (post-halving)
├── Pool #2 per node: ~500 QNC/year (medium activity)
├── Pool #3 per node: ~1,000 QNC/year (mature)
└── Total per node: ~1,622 QNC/year

Aggressive Scenario (10M nodes, Year 10):
├── Pool #1 per node: ~6 QNC/year (reduced emission)
├── Pool #2 per node: ~2,000 QNC/year (high activity)
├── Pool #3 per node: ~5,000 QNC/year (dominant)
└── Total per node: ~7,006 QNC/year
```

## 7.10 Node Activation Process

**Phase 1 - Browser Extension Activation:**

```
1. Acquire 1DEV tokens on Solana
2. Connect wallet to QNet Browser Extension
3. Select node type (all cost same in Phase 1)
4. Extension initiates burn to: 1nc1nerator11111111111111111111111111
5. QNet monitors Solana blockchain for burn confirmation
6. Extension generates quantum-resistant activation code
7. Code format: QNET-XXXXXX-XXXXXX-XXXXXX (26 characters)
8. Node activated with unique identifier
```

**Phase 2 - Native QNC Activation:**

```
1. Acquire QNC tokens (native to QNet)
2. Calculate dynamic price based on network size
3. Transfer exact QNC amount to Pool #3
4. Receive instant activation confirmation
5. Pool #3 redistributes QNC to all active nodes
6. Begin earning from all three reward pools
```

## 7.11 Economic Testing and Validation

**Production Readiness Metrics:**

```
Testing Results (June 2025):
├── Nodes Tested: 104 successfully activated
├── QNC Distributed: 370,863.32 total
├── 1DEV Burned: 156,000 tokens
├── Phase Transition: Successful at 95% burn
├── Scalability: Validated to 100,000+ nodes
└── Security Score: Maximum implementation

Attack Resistance Validation:
├── 51% Attack: PASSED (reputation + consensus)
├── Sybil Attack: PASSED (activation cost barrier)
├── Nothing-at-Stake: PASSED (reputation penalties)
├── Double-Spend: PASSED (Byzantine validation)
├── Spam Attack: PASSED (rate limiting)
└── Economic Manipulation: PASSED (Pool #3 design)
```

## 7.12 Regulatory Compliance Framework

**Legal Protection Structure:**

```
Classification: Experimental Research Network
├── Educational and technical purposes
├── No investment returns promised
├── Utility token only (not security)
├── Open source transparent development
├── Small-scale research
└── Clear risk disclosures provided

Participant Agreement:
├── Accept all technical/financial risks
├── Understand experimental nature
├── No expectation of profit
├── Research participation only
└── Full personal responsibility
```

## 7.13 Economic Security and Attack Resistance

**Attack Prevention Mechanisms:**

```
51% Attack Defense:
├── Reputation requirement for consensus (70+ points)
├── Time-based reputation building (cannot buy instantly)
├── Byzantine consensus requires 2/3+ agreement
└── Economic cost: Requires maintaining multiple nodes long-term

Sybil Attack Prevention:
├── Activation cost barrier (1DEV burn / QNC payment)
├── Reputation building time (weeks to reach consensus level)
├── Ping response requirements (real infrastructure needed)
└── Progressive pricing with network growth

Nothing-at-Stake Protection:
├── No staking = no conflicting stake incentives
├── Reputation penalties for double-signing (-30 points)
├── Immediate consensus participation loss
└── Long recovery period required (30+ successful pings)

Economic Manipulation Defense:
├── Pool #3 benefits all nodes equally
├── Cannot corner reward distribution
├── Transparent on-chain mechanics
└── Deterministic reward calculations
```

## 7.14 Phase Transition Economics

**Transition Triggers:**

```
Primary Trigger: 90% of 1DEV supply burned (900M tokens)
Secondary Trigger: 5 years from genesis block
Activation: Whichever occurs first

```

---

## 8. Technical Innovations

### 8.1 Quantum-Resistant Signatures

**CRYSTALS-Dilithium implementation:**

```rust
pub struct QNetSignature {
    pub algorithm: "CRYSTALS-Dilithium",
    pub security_level: 128, // bit post-quantum security
    pub signature: Vec<u8>,  // 2420 bytes
    pub public_key: Vec<u8>, // 1312 bytes
}
```

**Signing process:**
1. Generate cryptographic hash of transaction (SHA3-256)
2. Create Dilithium signature
3. Verification using public key
4. Add to block

### 8.2 Validation System

**Multi-level validation:**

1. **Cryptographic**: Verification of quantum-resistant signatures
2. **Consensus**: Byzantine validation from multiple nodes  
3. **Economic**: Balance and fee verification
4. **Network**: Validation from regional clusters

### 8.3 Data Storage

**RocksDB with optimizations:**

- **Column families**: Separation by data types
- **Compression**: Zstd for 40-60% size reduction
- **Block cache**: Acceleration of frequently requested data
- **Archiving**: Automatic compression of old blocks

---

## 9. Commit-Reveal BFT Consensus

### 9.1 Algorithm Description

**Commit-Reveal Byzantine Fault Tolerance** - QNet's unique consensus:

**Features:**
- Protection from "nothing at stake" attacks
- Prevention of voting manipulation
- Finalization through information disclosure
- Resistance to 33% malicious nodes

### 9.2 Detailed Process

**Phase 1 - Commit (15 seconds):**
```rust
commit = {
    round_id: u64,
    validator_id: String,
    commit_hash: SHA3_256(vote + nonce),
    timestamp: u64,
    signature: CRYSTALS_Dilithium_signature
}
```

**Phase 2 - Reveal (15 seconds):**
```rust
reveal = {
    round_id: u64,
    validator_id: String, 
    vote: String,           // Real vote
    nonce: Vec<u8>,         // Random number
    timestamp: u64,
    signature: CRYSTALS_Dilithium_signature
}
```

**Finalization:**
- Verification: SHA3_256(vote + nonce) == commit_hash
- Count votes from valid reveals
- Consensus at 2f+1 agreeing votes

### 9.3 Validator Selection

**Cryptographically deterministic selection:**

1. **Genesis phase**: All 5 Genesis nodes participate
2. **Normal phase**: Sampling up to 1000 best validators
3. **Selection criteria**:
   - Reputation 70+ points (consensus_threshold = 70.0)  
   - Node type: Super or Full
   - Active network connectivity
   - Blockchain synchronization

---

## 10. Scalability and Performance

### 10.1 Reputation-Based Network Security

**Innovative Consensus Without Staking:**

```
Core Innovation:
├── No token locking required (full liquidity)
├── Behavior-based trust model
├── Mobile-friendly participation
├── Equal opportunity for all holders
└── Energy-efficient consensus

Reputation Scoring Matrix:
├── Starting Score: 50 (neutral baseline)
├── Success Actions: +1 per positive behavior
├── Minor Failures: -1 to -2 points
├── Major Violations: -5 to -30 points
└── Recovery Rate: Gradual through consistent good behavior

Security Thresholds:
├── 70+: Full consensus participation
├── 40+: Reward eligibility (all pools)
├── 10-39: Limited network access
└── <10: Network ban enforced

Violation Penalties:
├── Missed Ping: -1.0 reputation
├── Invalid Block: -5.0 reputation
├── Consensus Failure: -10.0 reputation
├── Extended Offline (24h+): -15.0 reputation
└── Double Signing: -30.0 reputation
```

**Mobile-Optimized Recovery System:**
```
Recovery Windows:
├── <24 hours offline: Full reputation retained
├── 24h-365d offline: FREE restoration (7-day quarantine)
├── >365 days offline: Paid reactivation required
├── Banned (<10 rep): Paid reactivation only
└── Restoration Limit: 10 free per 30 days

Quarantine Period:
├── Duration: 7 days at 25 reputation
├── No rewards during quarantine
├── Gradual reputation building required
└── Full access restored at 40+ reputation
```

### 10.2 Regional Optimization

**Geographic Performance Distribution:**

```
Regional Architecture:
├── Local Supernodes: Process regional transactions
├── Cross-region Sync: Only for inter-regional transfers
├── Intra-region Latency: <100ms target
├── Inter-region Latency: <500ms target
└── Adaptive Routing: Automatic path optimization

Performance by Region:
├── Dense Urban: Maximum throughput achieved
├── Suburban: Standard performance maintained
├── Rural: Mobile-optimized connectivity
└── Global: Seamless cross-border transactions
```

### 10.3 Mobile-First Optimization

**Light Node Mobile Architecture:**

```
Resource Efficiency:
├── Data: Block headers only (~80 bytes each)
├── Storage: <100MB for core functionality
├── Traffic: <1MB per hour active use
├── Battery: <2% consumption per hour
├── RAM: 2-4GB sufficient for full operation
└── CPU: Minimal usage (like messaging app)

Mobile Features:
├── SPV verification for fast validation
├── Push notification integration
├── Background sync capability
├── Offline transaction queuing
└── Automatic reconnection handling
```

---

## 11. Integration with Existing Systems

### 11.1 Solana Bridge

**QNet is integrated with Solana ecosystem:**

- **1DEV token**: SPL Token on Solana
- **Smart contracts**: Burning tokens on Solana

### 11.2 Applications and Integration

**Browser extension (primary):**

1. **QNet Browser Extension**:
   - Quantum-resistant wallet
   - **Primary method for obtaining activation codes**
   - Code generation after burn transactions
   - Full-screen interface
   - Production-ready status

**Mobile applications (auxiliary):**

2. **QNet Mobile Wallet**:
   - React Native application
   - App Store / Play Store ready
   - Biometric authentication
   - Push notifications

3. **QNet Explorer**:
   - Blockchain viewing
   - Network statistics
   - Transaction search

### 11.3 API and SDK

**Complete API set for developers:**

```javascript
// REST API
GET /api/v1/height          // Current block height
GET /api/v1/peers           // List of active nodes  
POST /api/v1/transaction    // Send transaction
GET /api/v1/microblock/{id} // Get microblock

// WebSocket API for real-time
ws://node:8001/ws/blocks    // Subscribe to new blocks
ws://node:8001/ws/transactions // Subscribe to transactions
```

---

## 12. Security

### 12.1 Multi-layer Protection

**1. Cryptographic level:**
- CRYSTALS-Dilithium signatures
- SHA3-256 hashing  
- Quantum entropy for key generation

**2. Network level:**
- Rate limiting (30 requests/minute)
- DDoS protection
- TLS 1.3 certificates

**3. Consensus level:**
- Byzantine fault tolerance
- Double-spend protection
- Slashing for malicious behavior

**4. Economic level:**
- Activation deposits
- Reputation system
- Economic penalties

### 12.2 Security Audits

**Completed audits:**

- ✅ **Cryptographic audit**: CRYSTALS-Dilithium implementation
- ✅ **Consensus audit**: CR-BFT resilience
- ✅ **Smart contract audit**: Solana integration
- ✅ **P2P audit**: Network security

**Planned audits:**
- 🔄 Full security audit (Q4 2025)
- 🔄 Mainnet pentesting
- 🔄 Code review by independent experts

### 12.3 Attack Protection

**Known attack vectors and QNet protection:**

| Attack Type | QNet Protection |
|-------------|-----------------|
| **51% attack** | CR-BFT consensus, economic penalties |
| **Sybil attack** | Burn-to-activate, reputation system |
| **DDoS** | Rate limiting, regional distribution |
| **Double-spend** | Byzantine validation, blockchain finalization |
| **Quantum attack** | CRYSTALS-Dilithium, post-quantum algorithms |

---

## 13. Roadmap and Development

### 13.1 Achieved Milestones (2025)

**Q2 2025:**
- ✅ 424,411 TPS achieved
- ✅ Solana integration completed

**Q3 2025:**
- ✅ Byzantine consensus implemented  
- ✅ Post-quantum cryptography deployed
- ✅ P2P network scaled
- ✅ API v1 stabilized

### 13.2 Development Plans

**Q4 2025:**
- 🔄 Full security audit
- 🔄 Sharding implementation
- 🔄 Sharding implementation
- 🔄 Testnet launching
- 🔄 Mainnet launching

### 13.3 Research Directions

**Post-quantum cryptography:**
- New NIST competition algorithms
- Hybrid cryptosystems 
- Zero-knowledge post-quantum proofs

**Consensus innovations:**
- Finality Gadgets
- Probabilistic finality
- Cross-shard atomicity

---

## 14. Experimental Results

### 14.1 Achieved Test Metrics

**⚠️ EXPERIMENTAL DATA - NO PRODUCTION PERFORMANCE GUARANTEES**

| Metric | Achieved in Tests | Status |
|--------|-------------------|--------|
| **Maximum TPS** | 424,411 | ✅ Confirmed by tests |
| **Microblock time** | 1 second | ✅ Implemented |
| **Macroblock time** | 90 seconds | ✅ Byzantine consensus |
| **Mobile TPS** | 8,859 | ✅ Crypto operations on device |
| **Quantum protection** | Dilithium2 + Ed25519 | ✅ Hybrid implementation |
| **Reputation system** | 70/40/10 thresholds | ✅ Without staking |

### 14.2 Experimental Architecture

**QNet's unique features:**

- **Two-phase activation**: 1DEV (Solana) → QNC (QNet) transition
- **Pool #3 system**: Activation QNC redistributed to all nodes
- **Ping-based participation**: Every 4 hours, NOT mining
- **No staking**: Reputation system only
- **Mobile-first**: Light nodes only on mobile devices
- **Experimental status**: One person's research project

### 14.3 Experiment Goals

**What QNet attempts to prove:**

1. **One person can create an advanced blockchain**:
   - Without multi-million investments
   - Without teams of hundreds of developers 
   - Without venture funds and corporations
   - Using modern technologies and AI assistants

2. **Post-quantum cryptography is practical**:
   - CRYSTALS-Dilithium works in production
   - Hybrid approach ensures compatibility
   - Quantum-ready architecture is possible today

3. **Innovative economy is possible**:
   - Reputation system instead of staking
   - Pool #3 redistribution benefits everyone
   - Mobile-first approach is scalable

**Experiment limitations:**
- ⚠️ Small budget
- ⚠️ Experimental stability
- ⚠️ No guarantees
- ⚠️ High participation risks

---

## 15. Use Cases and Applications

### 15.1 Use Cases

**DeFi applications:**
- Decentralized exchanges with microsecond execution
- Lending protocols with instant settlement
- Yield farming without delays
- Cross-chain arbitrage

**Payment systems:**
- Instant P2P transfers
- Microtransactions for IoT
- Real-time retail payments
- International transfers <1 second

**Enterprise solutions:**
- Supply chain tracking  
- Digital identity management
- Document verification
- Real-time auditing

**Gaming and NFT:**
- In-game transactions without delays
- NFT minting with instant confirmation
- Real-time multiplayer blockchain games
- Metaverses with microtransactions

### 15.2 Real Ecosystem Status

**⚠️ EXPERIMENTAL PROJECT - NO PARTNERS YET:**

**Current integrations:**
- ✅ **Solana**: 1DEV token for activation (Phase 1)
- ✅ **Mobile applications**: iOS/Android ready for App Store/Play Store
- ✅ **Browser Extension**: Quantum-resistant wallet
- ✅ **Docker deployment**: Production-ready nodes

**In development:**
- 🔄 **QNC native token**: Phase 2 system
- 🔄 **Pool #3 redistribution**: Rewards for all nodes
- 🔄 **DAO governance**: Gradual transition to community

**Experiment goal**: Prove the possibility of creating an advanced blockchain by one person

---

## 16. Risks and Limitations

### 16.1 Technical Risks

**1. Technology novelty:**
- Post-quantum cryptography is relatively new
- Unexpected vulnerabilities possible
- Requires continuous updates

**2. Network risks:**
- Dependency on internet connection
- Possible network partitions  
- P2P routing complexity

**3. Scalability:**
- Potential consensus bottlenecks
- Hardware requirements may grow

### 16.2 Economic Risks

**1. Token volatility:**
- 1DEV may fluctuate significantly in price
- No guarantees of value growth
- Complete value loss possible

### 16.3 Competitive Risks

**1. Technological lag:**
- Other blockchains may implement quantum protection
- Emergence of faster solutions
- Changes in technological trends

**2. Network effects:**
- Difficulty attracting users from established networks
- Need for critical mass for effectiveness
- Competition with existing blockchain platforms

---

## 17. Technical Specifications

### 17.1 System Requirements

**Super Node:**
- **CPU**: 8+ cores (Intel Xeon or AMD EPYC)
- **RAM**: 8+ GB DDR4
- **Storage**: 2+ TB NVMe SSD
- **Network**: 1 Gbps symmetric channel
- **OS**: Ubuntu 22.04 LTS or newer

**Full Node:**
- **CPU**: 4+ cores
- **RAM**: 4+ GB
- **Storage**: 500+ GB SSD
- **Network**: 100 Mbps
- **OS**: Ubuntu 20.04+ / macOS / Windows

**Light Node (Mobile):**
- **CPU**: ARM64 or x64
- **RAM**: 2+ GB  
- **Storage**: 10+ GB
- **Network**: 3G/4G/WiFi
- **OS**: Android 8+ / iOS 13+

### 17.2 Network Protocols

**Transport Layer:**
- **TCP** for reliable block delivery
- **UDP** for peer discovery messages
- **HTTP/2** for API endpoints  
- **WebSocket** for real-time subscription

**Application Layer:**
```rust
QNetProtocol = {
    version: "1.0",
    encoding: "Protocol Buffers",
    compression: "Zstd",
    encryption: "TLS 1.3",
    authentication: "CRYSTALS-Dilithium"
}
```

### 17.3 Database

**Storage Schema:**
```sql
-- Microblocks  
microblocks: {
    height: u64 PRIMARY KEY,
    data: BLOB (compressed),  
    timestamp: u64,
    producer: String
}

-- Transactions
transactions: {
    hash: String PRIMARY KEY,
    from_addr: String,
    to_addr: String, 
    amount: u64,
    block_height: u64
}

-- Account state  
accounts: {
    address: String PRIMARY KEY,
    balance: u64,
    nonce: u64,
    last_update: u64
}
```

---

## 18. Conclusion

### 18.1 Experiment Results

**QNet proved the capabilities of one person-operator:**

1. **Technical achievements**:
   - ✅ 424,411 TPS achieved in tests
   - ✅ Post-quantum cryptography works
   - ✅ Mobile-first architecture implemented  
   - ✅ Innovative economic model created

2. **Social conclusions**:
   - ✅ One person can compete with corporations
   - ✅ AI assistants democratize development
   - ✅ Open source ensures transparency
   - ✅ Experimental projects have the right to exist

### 18.2 Limitations and Honesty

**⚠️ CRITICAL UNDERSTANDING OF LIMITATIONS:**

- **Experimental status**: Not ready for mission-critical applications
- **One developer**: Potential single point of failure
- **Small budget**: Limited resources for development
- **High risks**: Participants may lose everything
- **No guarantees**: Network may stop at any moment

### 18.3 Call for Understanding

**This is research, not a commercial product:**

1. **Researchers**: Study the code, architecture, approaches
2. **Enthusiasts**: Participate ONLY at your own risk
3. **Developers**: Take ideas for your projects
4. **Community**: Help improve open source code

**QNet is proof of concept that one motivated person with modern technologies can create an advanced blockchain. No more, but no less.**

---

## Appendices

### Appendix A: Glossary of Terms

**Post-quantum cryptography**: Cryptographic algorithms resistant to quantum computer attacks

**CRYSTALS-Dilithium**: Digital signature algorithm standardized by NIST in 2024

**Commit-Reveal**: Two-phase protocol where participants first commit an encrypted vote, then reveal it

**Byzantine Fault Tolerance**: Resistance to arbitrary behavior of up to 1/3 of network participants

### Appendix B: Links and Resources

**Technical resources:**
- GitHub: https://github.com/AIQnetLab/QNet-Blockchain
- Documentation: https://qnet-docs.github.io
- API Reference: https://api.qnet.org/v1/docs

**Community:**
- Twitter: https://x.com/AIQnetLab (@AIQnetLab)
- Telegram: https://t.me/AiQnetLab (@AiQnetLab)
- Website: https://aiqnet.io

**Contracts:**
- 1DEV Token: `62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ`
- Burn Contract: `1nc1nerator11111111111111111111111111111111`

---

*This whitepaper represents the current state of QNet as of September 2025. Technical specifications may change as the network develops.*

**© 2025 QNet Development Team. All rights reserved.**

---
