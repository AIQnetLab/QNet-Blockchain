# QNet API Server

### **CRITICAL WARNINGS**
- **EXPERIMENTAL SOFTWARE**: All code is experimental and may contain critical bugs or security vulnerabilities
- **TOTAL LOSS RISK**: You may lose ALL data, funds, or value associated with usage
- **NO GUARANTEES**: NO functionality, security, or performance guarantees provided
- **AI-ASSISTED DEVELOPMENT**: This project uses AI assistance which may introduce unforeseen issues
- **NETWORK FAILURE**: The API server may fail, crash, or be compromised without notice
- **SECURITY RISKS**: Experimental API endpoints may have unknown security vulnerabilities

### **BY USING THIS SOFTWARE YOU ACKNOWLEDGE:**
1. This is experimental research software, NOT a commercial product
2. Anything can happen including data loss, security breaches, or system failure
3. You use this software entirely at your own risk and responsibility
4. We (developers and AI) are doing maximum effort to prevent issues but cannot guarantee anything

**⚠️ IF YOU DO NOT ACCEPT THESE RISKS, DO NOT USE THIS SOFTWARE ⚠️**

---

## Features

High-performance REST API server for QNet experimental blockchain with WebSocket support.

- **RESTful API endpoints** for blockchain interaction (experimental implementation)
- **WebSocket support** for real-time updates (experimental)
- **Prometheus metrics** integration (research monitoring)
- **CORS support** for web applications (experimental security)
- **Request validation** and rate limiting (experimental protection)
- **Comprehensive error handling** (research-focused)

## Building
**⚠️ Warning**: This builds experimental research software. Use at your own risk.

## Running

```bash
# Run with default settings (experimental)
cargo run --release

# Run with custom settings (experimental)
QNET_API_HOST=0.0.0.0 QNET_API_PORT=5000 cargo run --release
```

**⚠️ Warning**: Running experimental API server. Monitor for unexpected behavior.

High-performance REST API server for QNet experimental blockchain with WebSocket support.

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   QNet CLI      │────│   API Server    │────│   QNet Node     │
│   (client)      │    │   (port 5000)   │    │   (port 9877)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │
                                └─────────────────────────────────┐
                                                                  │
                                                         ┌─────────────────┐
                                                         │   QNet P2P      │
                                                         │   (port 9876)   │
                                                         └─────────────────┘
```

## Port Configuration

- **QNet Node P2P**: 9876 (peer-to-peer networking)
- **QNet Node RPC**: 9877 (blockchain RPC calls)
- **API Server**: 5000 (REST API for wallets/CLI)
- **Metrics**: 9878 (monitoring/prometheus)

## Quick Start

```bash
# Build the project
cargo build --release

# Run with default settings
cargo run --release

# Run with custom settings
QNET_API_HOST=0.0.0.0 QNET_API_PORT=5000 cargo run --release
```

## Configuration

Environment variables:
- `QNET_API_HOST` - Server host (default: 127.0.0.1)
- `QNET_API_PORT` - Server port (default: 5000)
- `QNET_NETWORK_ID` - Network identifier (default: qnet-mainnet)
- `QNET_STATE_DB_PATH` - State database path (default: ./data/state)
- `QNET_ENABLE_WEBSOCKET` - Enable WebSocket support (default: true)
- `QNET_NODE_RPC_URL` - QNet Node RPC URL (default: http://localhost:9877)

## API Endpoints

### Account Endpoints

- `GET /api/v1/account/{address}` - Get account information
- `GET /api/v1/account/{address}/balance` - Get account balance
- `GET /api/v1/account/{address}/transactions` - Get account transactions

### Block Endpoints

- `GET /api/v1/block/latest` - Get latest block
- `GET /api/v1/block/{height}` - Get block by height
- `GET /api/v1/block/hash/{hash}` - Get block by hash

### Transaction Endpoints

- `POST /api/v1/transaction` - Submit new transaction
- `GET /api/v1/transaction/{hash}` - Get transaction by hash
- `GET /api/v1/transaction/{hash}/receipt` - Get transaction receipt

### Batch Operations

- `POST /api/v1/batch/claim-rewards` - Batch claim rewards
- `POST /api/v1/batch/activate-nodes` - Batch activate nodes
- `POST /api/v1/batch/transfer` - Batch transfer QNC
- `GET /api/v1/batch/metrics` - Get batch metrics

### Mobile API

- `GET /api/v1/mobile/gas-recommendations` - Get gas recommendations
- `GET /api/v1/mobile/network-status` - Get network status

### WebSocket

Connect to `/ws` for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:5000/ws');

// Subscribe to events
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['blocks', 'transactions']
}));

// Handle messages
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};
```

### Metrics

Prometheus metrics available at `/metrics`

## Example Requests

### Get Account Balance

```bash
curl http://localhost:5000/api/v1/account/7a9bk4f2eon8x3m5z1c7/balance
```

### Submit Transaction

```bash
curl -X POST http://localhost:5000/api/v1/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "from": "7a9bk4f2eon8x3m5z1c7",
    "to": "5n2j8k9deonb7f3x4m6q",
    "amount": 1000000,
    "gas_price": 10,
    "gas_limit": 10000
  }'
```

### Get Latest Block

```bash
curl http://localhost:5000/api/v1/block/latest
```

### Batch Claim Rewards

```bash
curl -X POST http://localhost:5000/api/v1/batch/claim-rewards \
  -H "Content-Type: application/json" \
  -d '{
    "node_ids": ["node_123", "node_456"],
    "owner_address": "7a9bk4f2eon8x3m5z1c7"
  }'
```

## Development

### Running Tests

```bash
cargo test
```

### Running with Logging

```bash
RUST_LOG=qnet_api=debug cargo run
```

## Production Deployment

### With Docker

```bash
# Build image
docker build -t qnet-api .

# Run container
docker run -d \
  --name qnet-api \
  -p 5000:5000 \
  -e QNET_NODE_RPC_URL=http://qnet-node:9877 \
  qnet-api
```

### With systemd

```ini
[Unit]
Description=QNet API Server
After=network.target

[Service]
Type=simple
User=qnet
WorkingDirectory=/opt/qnet-api
ExecStart=/opt/qnet-api/target/release/qnet-api
Restart=always
Environment=QNET_API_HOST=0.0.0.0
Environment=QNET_API_PORT=5000
Environment=QNET_NODE_RPC_URL=http://localhost:9877

[Install]
WantedBy=multi-user.target
```

## Architecture

The API server acts as a bridge between:
- **Frontend applications** (wallets, explorers, mobile apps)
- **QNet blockchain node** (Rust implementation)
- **External services** (monitoring, analytics)

This separation provides:
- **Security**: Filtered access to blockchain node
- **Performance**: Caching and request optimization
- **Scalability**: Load balancing and horizontal scaling
- **Flexibility**: Version management and feature flags 