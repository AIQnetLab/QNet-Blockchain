# QNet Project Structure

## Directory Layout

```
QNet-Project/
├── Core Modules (Rust)
│   ├── qnet-state/          # State management & accounts
│   ├── qnet-mempool/        # Transaction pool
│   ├── qnet-consensus/      # Commit-reveal consensus
│   └── qnet-sharding/       # Advanced sharding (NEW)
│
├── Network & API (Go)
│   ├── qnet-network/        # P2P networking (libp2p)
│   └── qnet-api/           # REST API server
│
├── Frontend
│   ├── qnet-wallet/        # Browser extension
│   └── qnet-explorer/      # Block explorer (TODO)
│
├── Smart Contracts
│   └── qnet-contracts/     # Solana contracts
│
├── Documentation
│   ├── docs/               # Technical docs
│   ├── ROADMAP_TO_1M_TPS.md
│   ├── COMPLETE_ECONOMIC_MODEL.md
│   ├── PROJECT_COMPLETE_ANALYSIS.md (THIS FILE)
│   └── PROJECT_STRUCTURE.md
│
├── Scripts & Tools
│   ├── scripts/            # Utility scripts
│   ├── load_test.py        # Load testing
│   ├── benchmark_rust_modules.py
│   └── performance_dashboard.py
│
└── Configuration
    ├── Cargo.toml          # Rust workspace
    ├── docker-compose.yml  # Docker setup
    └── config/             # Config files
```

## Module Dependencies

```
qnet-wallet (JS)
    ↓
qnet-api (Go)
    ↓
qnet-network (Go) ←→ qnet-consensus (Rust)
                          ↓
                     qnet-mempool (Rust)
                          ↓
                     qnet-state (Rust)
                          ↓
                     qnet-sharding (Rust)
```

## Key Files by Purpose

### Consensus Implementation
- `qnet-consensus/src/commit_reveal.rs` - Core consensus logic
- `qnet-consensus/src/reputation.rs` - Node reputation
- `qnet-consensus/src/leader_selection.rs` - Leader selection

### State Management
- `qnet-state/src/state_db.rs` - In-memory database
- `qnet-state/src/account.rs` - Account management
- `qnet-state/src/transaction.rs` - Transaction structure

### Transaction Processing
- `qnet-mempool/src/mempool.rs` - Pool management
- `qnet-mempool/src/validation.rs` - Validation logic
- `qnet-mempool/src/priority.rs` - Priority queue

### Networking
- `qnet-network/main.go` - P2P implementation
- `qnet-api/main.go` - REST endpoints

### Performance
- `qnet-sharding/src/lib.rs` - Sharding logic
- `qnet-mempool/src/validation.rs` - Parallel validation

## Data Flow

1. **Transaction Creation**
   - Wallet creates transaction
   - Sends to API server

2. **Transaction Processing**
   - API validates format
   - Sends to mempool
   - Mempool validates signatures
   - Adds to priority queue

3. **Block Production**
   - Consensus selects leader
   - Leader picks transactions
   - Creates block
   - Broadcasts to network

4. **State Update**
   - Block validated
   - State updated
   - Rewards distributed

## Configuration Files

### Rust Modules
- `Cargo.toml` - Dependencies
- `benches/` - Benchmarks
- `tests/` - Unit tests

### Go Modules
- `go.mod` - Dependencies
- `main.go` - Entry point

### Python Bindings
- `pyproject.toml` - Build config
- `python_bindings.rs` - FFI interface

## Development Workflow

1. **Make Changes**
   - Edit relevant module
   - Run tests locally
   - Check benchmarks

2. **Build & Test**
   ```bash
   cargo test --all
   cargo bench --all
   go test ./...
   ```

3. **Integration**
   - Test Python bindings
   - Test API endpoints
   - Run load tests

## Important Notes

### Performance
- Current: ~5,000 TPS
- Target: 1,000,000 TPS
- Sharding: 10,000 shards planned

### Security
- Ed25519 signatures
- 256-bit entropy
- Replay protection
- Memory encryption

### Economics
- 1DEV → QNC transition
- 4-hour reward cycles
- Halving every 4 years
- No leader rewards

### Consensus
- Commit-reveal mechanism
- 5s commit, 5s reveal
- Reputation-based selection
- Fork resolution by weight 