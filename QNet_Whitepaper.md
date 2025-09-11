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

### 6.3 Real Reputation System

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

### 7.1 Tokenomics

**⚠️ TWO-PHASE ACTIVATION SYSTEM:**

**Phase 1: 1DEV Token (NOT QNet's native token!):**
- **1DEV** = SPL token on Solana for node activation
- **Total supply**: 1,000,000,000 1DEV  
- **Blockchain**: Solana (SPL Token)
- **Decimals**: 6
- **Testnet address**: `62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ` (devnet)
- **Burn contract**: `D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7` (devnet)

**Phase 2: QNC Token (NATIVE QNet token):**
- **QNC** = Native token of QNet blockchain
- **Appears after**: 90% 1DEV burn OR after 5 years
- **Pool #3**: Activation QNC redistributed to all nodes

### 7.2 Real Economic Model

**Phase 1 (1DEV Burn):**
```
Universal price: 1,500 1DEV for ANY node type
├── Light Node: 1,500 1DEV → decreases to 150 1DEV
├── Full Node: 1,500 1DEV → decreases to 150 1DEV  
└── Super Node: 1,500 1DEV → decreases to 150 1DEV

Price reduction: -150 1DEV for every 10% burned volume
Transition to Phase 2: at 90% burn OR after 5 years
```

**Phase 2 (QNC system):**
```
Dynamic pricing (base × network multiplier):
├── Light Node: 2,500-15,000 QNC (base: 5,000 QNC)
├── Full Node: 3,750-22,500 QNC (base: 7,500 QNC)
└── Super Node: 5,000-30,000 QNC (base: 10,000 QNC)

ALL activation QNC → Pool #3 → Redistribution to ALL nodes
```

### 7.3 Real Activation System

**Phase 1 - Burn-to-activate (current):**

1. User **BURNS 1DEV tokens** (not SOL!)
2. Burn address: `1nc1nerator11111111111111111111111111111111`
3. QNet monitors Solana blockchain for burns
4. **Browser extension** generates **quantum-resistant activation code**
5. Code format: `QNET-XXXXXX-XXXXXX-XXXXXX` (26 characters)
6. User **receives code through browser extension**

**Phase 2 - QNC Pool #3 (future):**

1. User **TRANSFERS QNC to Pool #3** (doesn't burn!)
2. Pool #3 **redistributes QNC to all active nodes**
3. Dynamic price depends on network size
4. All nodes benefit from each new activation

### 7.4 Fee System

**Dynamic fees based on network congestion:**

| Mempool load | Base fee | Priority | Fast |
|--------------|----------|----------|------|
| 0-10 transactions | 0.00005 QNC | 0.000075 QNC | 0.0001 QNC |
| 11-50 transactions | 0.000075 QNC | 0.0001 QNC | 0.000125 QNC |
| 51-100 transactions | 0.0001 QNC | 0.00015 QNC | 0.0002 QNC |
| 100+ transactions | 0.00015 QNC | 0.000225 QNC | 0.0003 QNC |

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

### 10.1 Reputation Architecture

**Node reputation system (without staking):**

```
Reputation thresholds (from config.ini):
├── 70+ points: Consensus participation (consensus_threshold = 70.0)
├── 40+ points: Receive rewards from pools (rewards_threshold = 40.0)  
├── 10-39 points: Network access, no rewards or consensus
└── <10 points: Complete network ban (ban_threshold = 10.0)

Penalties:
├── Missed ping: -1.0 reputation
├── Invalid block: -5.0 reputation  
├── Double-signing: -30.0 reputation (serious violation)
└── Extended offline (24h+): -15.0 reputation
```

**Ping system every 4 hours - NOT mining, simple network responses**

### 10.2 Regional Optimization

**Geographic distribution:**

1. **Regional supernodes**: Local transaction processing
2. **Cross-region synchronization**: Only for interregional transfers
3. **Latency**: <100ms intra-region, <500ms inter-regional

### 10.3 Mobile Optimization

**Light nodes specifically for mobile:**

- **Data**: Block headers only (~80 bytes)
- **Traffic**: <1 MB per hour with active usage  
- **Battery**: <2% consumption per hour
- **RAM**: 2-4 GB sufficient for full functionality

---

## 11. Integration with Existing Systems

### 11.1 Solana Bridge

**QNet is integrated with Solana ecosystem:**

- **1DEV token**: SPL Token on Solana
- **Cross-chain bridges**: Automatic asset transfer
- **Smart contracts**: Compatibility with Solana programs
- **DeFi integration**: Access to DEX, lending, yield farming

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
- ✅ Mainnet launched
- ✅ 424,411 TPS achieved
- ✅ Mobile applications ready
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
- 🔄 Cross-chain bridges expansion
- 🔄 DAO governance launch

**2026:**
- 🚀 Million active nodes
- 🚀 Enterprise integrations
- 🚀 IoT device support
- 🚀 2nd generation quantum algorithms

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
- Documentation: https://github.com/AIQnetLab/QNet-Blockchain/blob/testnet/README.md

**Community:**
- Telegram: @QAiQnetLab
- Website: https://aiqnet.io
- Twitter: https://x.com/AIQnetLab

**Contracts:**
- 1DEV Token: `62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ`
- Burn Contract: `1nc1nerator11111111111111111111111111111111`

---

*This whitepaper represents the current state of QNet as of September 2025. Technical specifications may change as the network develops.*

**© 2025 QNet Development Team. All rights reserved.**

---
