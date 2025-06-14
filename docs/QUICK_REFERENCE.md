# QNet Quick Reference

## Main Documentation
See [QNET_COMPLETE_GUIDE.md](QNET_COMPLETE_GUIDE.md) for complete information.

## Quick Start
```bash
# Build and run node
cargo build --release --bin qnet-node
./target/release/qnet-node

# Start blockchain explorer
cd qnet-explorer && npm start
# Open http://localhost:3000
```

## Key Features
- **Target Performance**: 100,000 TPS (Realistic quantum blockchain!)
- **Block Time**: 10 seconds (optimal for global consensus)
- **Consensus**: Commit-reveal
- **Storage**: RocksDB
- **Languages**: Rust (core), Go (P2P), JavaScript (explorer)
- **Mobile Support**: Yes! Light nodes use only 50-250 MB

## QNet Explorer
Professional web interface at http://localhost:3000
- Real-time block monitoring
- Transaction explorer
- Network statistics
- Beautiful dark theme UI

## Token Economics
- **QNA**: 1 billion on Solana (access token)
- **QNC**: 2^32 = 4,294,967,296 (native token)
- **No premine**: Fair launch
- **Halving**: Every 4 years

## Node Types & Requirements
| Type | Storage | RAM | For |
|------|---------|-----|-----|
| Super | 1+ TB | 32 GB | Data centers |
| Full | 100+ GB | 8 GB | VPS/Home |
| Light | 250 MB | 2 GB | Laptops |
| Mobile | 50 MB | 1 GB | Phones |

## Development Status
- Core modules: ✅
- RocksDB storage: ✅
- Node executable: ✅
- Web explorer: ✅
- Multi-node network: 🚧
- Reward system: ❌
- Smart contracts: 📅 (Phase 4, 18-24 months)

## Future Roadmap
- **Phase 4**: Smart contracts (WASM VM)
- **Phase 5**: DeFi ecosystem (DEX, bridges)
- **Phase 6**: Mass adoption (mobile dApps)

For detailed information, see the complete guide. 