# QNet Architecture Analysis & Recommendations

## Current Architecture

### Language Distribution
- **Python**: Core blockchain logic, node implementation, APIs
- **Rust**: Performance-critical modules (crypto, validation)
- **Go**: P2P networking layer
- **Rust/WASM**: Native QNet smart contracts — QRC-20 (fungible) and QRC-721 (NFT) are fully on-chain, and a deterministic wasmi WASM VM (fuel = gas) is built and enabled; the 1DEV burn lives on Solana

### Strengths ✅

1. **Hybrid Approach**
   - Python for rapid development and flexibility
   - Rust for performance-critical paths
   - 100x performance improvement achieved

2. **Post-Quantum Ready**
   - ML-DSA-65 signatures
   - ML-KEM-768 (Kyber) key exchange via QUIC TLS 1.3
   - Future-proof security

3. **Modular Design**
   - Clear separation of concerns
   - Easy to upgrade individual components
   - Good for parallel development

4. **Mobile Support (Light role)**
   - Mobile-only pure API client (phones/tablets, Android/iOS, F-Droid)
   - Zero on-device blockchain storage — chain state read via REST API
     on Super nodes; wallet TX list kept in AsyncStorage / localStorage
   - Battery-optimised push protocol (FCM / UnifiedPush / Polling)
   - Earns QNC rewards by responding to Genesis-driven Proof-of-Presence
     pings; does NOT participate in consensus or block production
   - No "progressive sync" — no blocks are downloaded at all

### Weaknesses ⚠️

1. **Python Core Limitations**
   - GIL (Global Interpreter Lock) limits parallelism
   - Memory overhead
   - Type safety concerns

2. **Multiple Languages Complexity**
   - Maintenance overhead
   - FFI (Foreign Function Interface) complexity
   - Debugging across language boundaries

3. **Consensus in Python**
   - Should be in compiled language for security
   - Performance bottleneck potential

## Recommendations for Improvement

### Priority 1: Move Consensus to Rust 🔴
```rust
// qnet-consensus-rust should handle ALL consensus logic
pub struct ConsensusEngine {
    validators: Vec<Validator>,
    current_round: u64,
    state: ConsensusState,
}
```
**Why**: Consensus is security-critical and performance-sensitive

### Priority 2: Rust-based State Machine 🟡
```rust
// State transitions should be in Rust
pub struct StateManager {
    current_state: BlockchainState,
    pending_txs: TransactionPool,
    state_db: RocksDB,
}
```
**Why**: State management needs consistency and speed

### Priority 3: Replace Python APIs with Rust + Actix-web 🟡
```rust
use actix_web::{web, App, HttpServer};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .route("/api/v1/tx/submit", web::post().to(submit_tx))
            .route("/api/v1/blocks/{hash}", web::get().to(get_block))
    })
    .bind("127.0.0.1:5000")?
    .run()
    .await
}
```
**Why**: Better performance, type safety, and async handling

### Priority 4: Unified VM in Rust ✅ (DONE)
> **Status: implemented.** A deterministic WASM VM is built and ENABLED — a `wasmi`
> interpreter with fuel = gas, deploy-time determinism validation (no floats/threads),
> plus deploy + call + cross-contract calls (EIP-2930-style access list). The old
> `pq_evm` was deleted. QRC-20 and QRC-721 are also fully on-chain.

```rust
// Single WASM VM for QNet smart contracts (built + enabled)
pub struct QNetVM {
    wasm_engine: wasmi::Engine,   // deterministic interpreter
    gas_meter: GasMeter,          // fuel = gas
    state_access: StateInterface,
}
```
**Why**: WASM is industry standard, better security

## Proposed Target Architecture

### Core Components (Rust)
1. **qnet-core-rust**
   - Transaction processing
   - Block creation
   - State management
   - Cryptography

2. **qnet-consensus-rust**
   - Full consensus implementation
   - Validator management
   - Fork resolution

3. **qnet-vm-rust**
   - WASM-based VM
   - Gas metering
   - State access control

4. **qnet-api-rust**
   - REST/gRPC APIs
   - WebSocket support
   - Rate limiting

### Network Layer (Keep Go)
- Go is excellent for networking
- libp2p integration
- Good concurrency model

### Node Orchestration (Python)
- Configuration management
- Monitoring/metrics
- Development tools
- Testing framework

## Migration Strategy

### Phase 1: Critical Path (3 months)
1. Move all consensus to Rust
2. Implement state machine in Rust
3. Create Rust API gateway

### Phase 2: Optimization (3 months)
1. Unified WASM VM
2. Rust-based mempool
3. Performance benchmarking

### Phase 3: Polish (2 months)
1. Remove Python from critical path
2. Improve FFI interfaces
3. Documentation update

## Performance Targets

| Component | Current | Target | Language |
|-----------|---------|--------|----------|
| Consensus | 10s/round | 1s/round | Rust |
| TX Validation | 100K TPS | 500K TPS | Rust |
| API Latency | 50ms | 5ms | Rust |
| State Access | 10K ops/s | 100K ops/s | Rust |

## Benefits of Migration

1. **Performance**: 5-10x improvement
2. **Security**: Memory safety, no runtime errors
3. **Maintainability**: Single language for core
4. **Developer Experience**: Better tooling
5. **Industry Standard**: Rust is becoming blockchain standard

## Risks & Mitigation

1. **Development Time**
   - Mitigation: Incremental migration
   
2. **Rust Learning Curve**
   - Mitigation: Training, hiring Rust devs
   
3. **Breaking Changes**
   - Mitigation: Careful API versioning

## Conclusion

QNet has a solid foundation but would benefit from consolidating core components in Rust. The hybrid approach was good for MVP, but for production-grade blockchain, Rust offers better performance, security, and maintainability.

**Recommendation**: Start with consensus migration to Rust, then gradually move other critical components while keeping Python for tooling and non-critical paths. 