# QNet Node

Full blockchain node implementation with integrated P2P networking.

## Features

- **Complete Node Types**:
  - Light Node: Minimal validation, low resource usage
  - Full Node: Complete validation and state storage
  - Super Node: Full node + additional services

- **Integrated Components**:
  - P2P networking with libp2p
  - Commit-Reveal consensus
  - High-performance state management
  - Lock-free mempool
  - REST/WebSocket API

- **Network Features**:
  - Automatic peer discovery (mDNS + DHT)
  - Block and transaction propagation
  - Blockchain synchronization
  - DDoS protection

## Quick Start

### Run a Full Node

```bash
# Start a full node
cargo run --release

# With custom data directory
cargo run --release -- --data-dir /path/to/data

# Connect to bootstrap nodes
cargo run --release -- --bootstrap "12D3KooWExample@/ip4/1.2.3.4/tcp/9000"
```

### Run a Block Producer

```bash
# Enable block production
cargo run --release -- --producer

# With custom config
cargo run --release -- --config node-config.json --producer
```

## Configuration

### Command Line Options

```
Options:
  -d, --data-dir <PATH>      Data directory [default: ./data]
  -c, --config <FILE>        Config file
      --producer             Enable block producer
      --bootstrap <NODES>    Bootstrap nodes (peer_id@address)
      --listen <ADDR>        Listen address [default: /ip4/0.0.0.0/tcp/9000]
      --api-addr <ADDR>      API address [default: 127.0.0.1:8080]
  -h, --help                 Print help
```

### Configuration File

```json
{
  "data_dir": "./data",
  "node_type": "Full",
  "network": {
    "listen_addresses": ["/ip4/0.0.0.0/tcp/9000"],
    "bootstrap_nodes": [],
    "max_peers": 50,
    "enable_mdns": true,
    "enable_dht": true
  },
  "consensus": {
    "enable_producer": false,
    "block_time_ms": 1000,
    "min_stake": 1000
  },
  "api": {
    "enabled": true,
    "listen_addr": "127.0.0.1:8080",
    "enable_ws": true,
    "ws_addr": "127.0.0.1:8081"
  }
}
```

## Architecture

```
┌─────────────────────────────────────┐
│            QNet Node                │
├─────────────────────────────────────┤
│         Node Manager                │
├──────┬──────┬──────┬──────┬────────┤
│ P2P  │State │Mempool│Consensus│ API │
├──────┴──────┴──────┴──────┴────────┤
│         Event System                │
└─────────────────────────────────────┘
```

## Node Types

### Light Node
- Minimal resource usage
- SPV validation
- No full state storage
- Suitable for wallets

### Full Node
- Complete blockchain validation
- Full state storage
- Can serve light clients
- Participates in consensus

### Super Node
- All full node features
- Additional indexing
- Enhanced API endpoints
- Archive node capabilities

## Networking

The node uses libp2p for P2P communication:

- **Discovery**: mDNS (local) + Kademlia DHT (global)
- **Transport**: TCP with Noise encryption
- **Protocols**: Gossipsub, Request-Response
- **Multiplexing**: Yamux

## API Endpoints

When API is enabled, the node exposes:

- `GET /info` - Node information
- `GET /blocks/{height}` - Get block by height
- `GET /transactions/{hash}` - Get transaction
- `POST /transactions` - Submit transaction
- `WS /subscribe` - Real-time events

## Monitoring

The node exports Prometheus metrics:

- `qnet_peers_connected` - Connected peers count
- `qnet_blocks_height` - Current blockchain height
- `qnet_mempool_size` - Mempool transaction count
- `qnet_consensus_rounds` - Consensus rounds completed

## Development

```bash
# Run tests
cargo test

# Run with debug logging
RUST_LOG=debug cargo run

# Run benchmarks
cargo bench
```

## Production Deployment

1. **System Requirements**:
   - 4+ CPU cores
   - 8GB+ RAM
   - 100GB+ SSD
   - 100Mbps+ network

2. **Recommended Settings**:
   ```bash
   cargo run --release -- \
     --data-dir /var/lib/qnet \
     --producer \
     --bootstrap "boot1@/ip4/boot1.qnet.io/tcp/9000" \
     --bootstrap "boot2@/ip4/boot2.qnet.io/tcp/9000"
   ```

3. **Systemd Service**:
   ```ini
   [Unit]
   Description=QNet Node
   After=network.target

   [Service]
   Type=simple
   User=qnet
   ExecStart=/usr/local/bin/qnet-node --config /etc/qnet/node.json
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   ``` 