# Blockchain Performance Comparison

## Current State vs Potential

| Blockchain | Core Language | Current TPS | Theoretical Max | Consensus | Smart Contracts |
|------------|---------------|-------------|-----------------|-----------|-----------------|
| **QNet (Now)** | Python + Rust | 100K | 150K | Checkpoint-BFT + Reputation | WASM |
| **QNet (Future)** | Rust | 500K+ | 1M+ | Checkpoint-BFT + Reputation | WASM |
| Solana | Rust | 65K | 710K | PoH + PoS | Rust/C |
| Aptos | Rust | 160K | 160K | AptosBFT | Move |
| Sui | Rust | 120K | 297K | Narwhal/Tusk | Move |
| Ethereum | Go | 30 | 100K (L2) | PoS | EVM |
| Avalanche | Go | 4.5K | 20K | Avalanche | EVM |
| Near | Rust | 100K | 100K | Nightshade | WASM |
| Polkadot | Rust | 1K | 1M (parachains) | GRANDPA | WASM |

## QNet's Consensus: Checkpoint-BFT + Reputation

### How It Works:

1. **Microblocks (production)**:
   - A single VRF-selected leader produces one microblock per second
   - ML-DSA-65-signed; the leader rotates every block

2. **Macroblock Checkpoint (finality)**:
   - Every 90 blocks a VRF-sampled committee signs one checkpoint
   - The checkpoint binds the window: 90 microblock hashes + state_root + VRF beacon + epoch commitment
   - content_ok fail-stop: a node signs only if it independently reproduces the content
   - Final once ≥ 2f+1 committee signatures form the Quorum Certificate (no commit/reveal phases)

3. **Leader Selection**:
   - Deterministic selection using SHA3-256
   - Simple qualification: reputation ≥ 70% threshold
   - Equal chance for all qualified nodes (NO WEIGHTING)

4. **Reputation System**:
   - Binary consensus reputation: **70 (qualified) or 0 (not qualified)** — no graduated scores
   - The ≥70 threshold is the single gate for producer/committee eligibility
   - Real-time tracking and updates
   - (Graduated scores, jail, decay, and tiered rewards/penalties are not used)

### Advantages Over Traditional Consensus:

- **Deterministic Finality**: every committee node reproduces the window content (content_ok) before signing the 2f+1 QC
- **Adaptive Performance**: Dynamic timing adjusts to network conditions
- **Fair Leader Selection**: Simple qualification threshold (≥70% reputation), equal chances
- **Sybil Resistance**: Reputation threshold prevents low-quality nodes from participating

## QNet Performance Analysis

### Current Architecture (Rust core)
- **Achieved**: 100K TPS with Rust optimization modules
- **Latency**: 50ms API response time
- **Finality**: ~60 seconds (Checkpoint-BFT v2 two-chain macroblock finality)

### After Full Rust Migration
- **Target**: 500K+ TPS base, 1M+ with sharding
- **Improvements**:
  - Consensus: 10x faster (10s → 1s)
  - State access: 10x faster
  - API latency: 10x faster (50ms → 5ms)
  - Memory usage: 5x reduction

## Why QNet Can Achieve 500K+ TPS

### 1. Architecture Advantages
- **Hierarchical node structure**: Super/Full/Light nodes
- **Optimized consensus**: Only super nodes validate
- **Parallel transaction processing**: Rust's fearless concurrency
- **Single-shard today**: sufficient for target throughput; sharding is a deferred future option (auto-arm off)

### 2. Technical Innovations
- **Post-quantum crypto**: Hardware accelerated
- **Custom mempool**: Priority-based ordering
- **Adaptive block size**: Dynamic based on load
- **Zero-copy networking**: Direct memory access

### 3. Mobile Optimization
- **Light nodes**: Don't slow down consensus
- **Progressive sync**: Only recent state needed
- **Batch validation**: Efficient proof verification

## Realistic Performance Targets

### Phase 1 (Current - Rust Core)
- **TPS**: 100,000 (achieved)
- **Finality**: ~60 seconds (Checkpoint-BFT v2, two-chain)
- **Nodes**: 10,000

### Phase 2 (Rust Core Migration)
- **TPS**: 250,000
- **Finality**: 3 seconds
- **Nodes**: 100,000

### Phase 3 (Full Optimization)
- **TPS**: 500,000+
- **Finality**: 1 second
- **Nodes**: 1,000,000+

### Phase 4 (With Sharding)
- **TPS**: 1,000,000+
- **Finality**: Sub-second
- **Nodes**: 10,000,000+

## Comparison Details

### vs Solana
- **Solana**: Centralized validators, high hardware requirements
- **QNet**: Decentralized, mobile-friendly light nodes
- **Advantage**: Better decentralization, lower barriers

### vs Aptos/Sui
- **Aptos/Sui**: New Move language, learning curve
- **QNet**: WASM - use any language
- **Advantage**: Developer friendly, mature tooling

### vs Ethereum
- **Ethereum**: Legacy architecture, slow base layer
- **QNet**: Built for speed from day one
- **Advantage**: 16,000x faster base layer

## Key Differentiators

1. **Post-Quantum Security**: First production blockchain with quantum resistance
2. **Mobile-First Design**: Millions of light nodes on phones
3. **Language Agnostic**: WASM supports all major languages
4. **Fair Launch**: No VC allocation, community driven
5. **Unique Consensus**: Checkpoint-BFT (2f+1 QC) + Reputation prevents manipulation

## Conclusion

QNet is positioned to be one of the fastest blockchains:
- **Current**: Already achieving 100K TPS (faster than most)
- **Near-term**: 250K TPS with partial Rust migration
- **Long-term**: 500K-1M TPS with full optimization

The combination of hierarchical architecture, Rust performance, and innovative consensus gives QNet a unique advantage in the blockchain space. 