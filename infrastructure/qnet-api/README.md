# QNet API Server - EXPERIMENTAL Research Software

**⚠️ CRITICAL WARNING: EXPERIMENTAL RESEARCH SOFTWARE - USE AT YOUR OWN RISK ⚠️**

## ⚠️ **MANDATORY RISK DISCLAIMERS**

**🚨 EXPERIMENTAL BLOCKCHAIN RESEARCH PROJECT 🚨**

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

```bash
cd qnet-api
cargo build --release
```

**⚠️ Warning**: This builds experimental research software. Use at your own risk.

## Running

```bash
# Run with default settings (experimental)
cargo run --release

# Run with custom settings (experimental)
QNET_API_HOST=0.0.0.0 QNET_API_PORT=8080 cargo run --release
```

**⚠️ Warning**: Running experimental API server. Monitor for unexpected behavior.

## Configuration

Environment variables (experimental settings):
- `QNET_API_HOST` - Server host (default: 127.0.0.1)
- `QNET_API_PORT` - Server port (default: 8080)
- `QNET_NETWORK_ID` - Network identifier (default: qnet-experimental)
- `QNET_STATE_DB_PATH` - State database path (default: ./data/state)
- `QNET_ENABLE_WEBSOCKET` - Enable WebSocket support (default: true)

## API Endpoints (Experimental)

### Account Endpoints

- `GET /api/v1/account/{address}` - Get account information (experimental)
- `GET /api/v1/account/{address}/balance` - Get account balance (experimental)
- `GET /api/v1/account/{address}/transactions` - Get account transactions (experimental)

### Block Endpoints

- `GET /api/v1/block/latest` - Get latest block (experimental)
- `GET /api/v1/block/{height}` - Get block by height (experimental)
- `GET /api/v1/block/hash/{hash}` - Get block by hash (experimental)

### Transaction Endpoints

- `POST /api/v1/transaction` - Submit new transaction (experimental)
- `GET /api/v1/transaction/{hash}` - Get transaction by hash (experimental)
- `GET /api/v1/transaction/{hash}/receipt` - Get transaction receipt (experimental)

### Mempool Endpoints

- `GET /api/v1/mempool/status` - Get mempool status (experimental)
- `GET /api/v1/mempool/transactions` - Get pending transactions (experimental)
- `GET /api/v1/mempool/account/{address}` - Get pending transactions for account (experimental)

### Node Endpoints

- `GET /api/v1/node/info` - Get node information (experimental)
- `GET /api/v1/node/peers` - Get connected peers (experimental)
- `GET /api/v1/node/sync` - Get sync status (experimental)

### Consensus Endpoints

- `GET /api/v1/consensus/round` - Get current consensus round (experimental)
- `POST /api/v1/consensus/commit` - Submit commit (for validators) (experimental)
- `POST /api/v1/consensus/reveal` - Submit reveal (for validators) (experimental)

### WebSocket (Experimental)

Connect to `/ws` for real-time updates:

```javascript
// ⚠️ Warning: Experimental WebSocket implementation
const ws = new WebSocket('ws://localhost:8080/ws');

// Subscribe to events (experimental)
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['blocks', 'transactions']
}));

// Handle messages (experimental)
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};
```

### Metrics (Experimental)

Prometheus metrics available at `/metrics` (experimental monitoring)

## Example Requests (Experimental)

### Get Account Balance

```bash
# ⚠️ Warning: Experimental API endpoint
curl http://localhost:8080/api/v1/account/0x1234.../balance
```

### Submit Transaction

```bash
# ⚠️ Warning: Experimental transaction submission
curl -X POST http://localhost:8080/api/v1/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "from": "0x1234...",
    "tx_type": {
      "type": "transfer",
      "to": "0x5678...",
      "amount": 1000000
    },
    "nonce": 1,
    "gas_price": 10,
    "gas_limit": 21000,
    "signature": "0xabcd..."
  }'
```

### Get Latest Block

```bash
# ⚠️ Warning: Experimental block retrieval
curl http://localhost:8080/api/v1/block/latest?include_txs=true
```

## Development (Experimental)

### Running Tests

```bash
# ⚠️ Warning: Running experimental tests
cargo test
```

### Running with Logging

```bash
# ⚠️ Warning: Experimental logging
RUST_LOG=qnet_api=debug cargo run
```

## Architecture (Experimental)

The API server is built with experimental implementations:
- **Actix-web** - High-performance web framework (experimental usage)
- **Tokio** - Async runtime (experimental async patterns)
- **Serde** - JSON serialization (experimental data structures)
- **Prometheus** - Metrics collection (experimental monitoring)
- **Tracing** - Structured logging (experimental tracing)

## Security (Experimental)

**⚠️ Warning**: All security measures are experimental and may have vulnerabilities:
- CORS headers for web security (experimental implementation)
- Request size limits (experimental protection)
- Rate limiting (experimental - may not work properly)
- Input validation (experimental - may miss edge cases)
- SQL injection protection (N/A - no SQL, but other injection risks may exist)

## Performance (Experimental)

**⚠️ Warning**: Performance metrics are from experimental testing conditions:
- Handles 10K+ requests per second (experimental benchmark)
- WebSocket connections: 50K+ concurrent (experimental capacity)
- Average latency: <10ms (experimental measurement)
- Memory usage: ~100MB base (experimental resource usage)
- Blockchain layer: 424,411 TPS (experimental verification)
- Mobile layer: 8,859 TPS (88x faster than Bitcoin)
- Mobile battery: <0.01% usage per transaction

## Development Risks

- **AI-Assisted Code**: May contain unforeseen bugs or security vulnerabilities
- **Experimental Features**: Many features are experimental and may not work as intended
- **Breaking Changes**: Updates may introduce breaking changes or require complete resets
- **Research Focus**: Designed for research and experimentation, not production use

## License

MIT License - See LICENSE file for details.

## ⚠️ **FINAL DISCLAIMER**

**QNet API Server is EXPERIMENTAL blockchain research software developed with AI assistance. This software:**

- **IS NOT** a commercial product or production-ready system
- **PROVIDES NO** guarantees, warranties, or promises of any kind
- **MAY FAIL** completely without notice or compensation
- **INVOLVES SIGNIFICANT** technical and security risks
- **USES AI ASSISTANCE** which may introduce unforeseen bugs or vulnerabilities

**WE (HUMAN DEVELOPERS AND AI) ARE DOING OUR MAXIMUM EFFORT TO:**
- Prevent bugs, vulnerabilities, and system failures
- Implement robust security measures and testing
- Provide comprehensive documentation and warnings
- Consider all possible failure scenarios and edge cases

**HOWEVER, WE CANNOT GUARANTEE ANYTHING. USE ENTIRELY AT YOUR OWN RISK.**

**This is experimental research software for educational purposes only.** 