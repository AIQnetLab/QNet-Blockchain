# QNet API Server - Decentralized Architecture

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

## QNet Decentralized API Architecture

QNet now implements a **fully decentralized API architecture** where every blockchain node provides complete API functionality.

### **Why Multi-Node API?**
- **Distributed Access**: Multiple nodes provide API access simultaneously
- **High Availability**: If one node goes down, others continue working
- **Scalable**: More nodes = more API capacity

### **Architecture Overview**

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ Web/Mobile Apps │    │   QNet Wallet   │    │   CLI Tools     │
│ (browsers)      │    │   (extension)   │    │   (terminal)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
           ┌─────────────────┐       ┌─────────────────┐
           │   QNet Node 1   │       │   QNet Node 2   │
           │   API: 8001     │       │   API: 8002     │
           │   RPC: 9877     │       │   RPC: 9879     │
           │   P2P: 9876     │       │   P2P: 9878     │
           └─────────────────┘       └─────────────────┘
```

**Each QNet node provides:**
- Full blockchain functionality (consensus, P2P, storage)
- Complete REST API endpoints
- JSON-RPC server for internal communication
- Real-time WebSocket connections
- Prometheus metrics endpoints

### **Node Activation (CRITICAL)**

**⚠️ EXPERIMENTAL**: Node activation requires interactive setup with activation codes

```bash
# Launch node - requires activation code
cd development/qnet-integration
./target/release/qnet-node

# Interactive setup will prompt for:
# - Activation code (format: QNET-XXXX-XXXX-XXXX)
# - Node type (Light/Full/Super)
# - Region (auto-detected)
```

### **API Endpoints (Per Node)**

Each node provides identical API endpoints:

**Account Management:**
- `GET /api/v1/account/{address}` - Get account info
- `GET /api/v1/account/{address}/balance` - Get balance
- `GET /api/v1/account/{address}/transactions` - Get transaction history

**Block Operations:**
- `GET /api/v1/block/latest` - Get latest block
- `GET /api/v1/block/{height}` - Get block by height
- `GET /api/v1/block/hash/{hash}` - Get block by hash

**Transaction Operations:**
- `POST /api/v1/transaction` - Submit transaction
- `GET /api/v1/transaction/{hash}` - Get transaction details

**Mempool Operations:**
- `GET /api/v1/mempool/status` - Get mempool status
- `GET /api/v1/mempool/transactions` - Get pending transactions

**Batch Operations:**
- `POST /api/v1/batch/claim-rewards` - Batch claim rewards
- `POST /api/v1/batch/transfer` - Batch transfer

**Network Operations:**
- `GET /api/v1/nodes/discovery` - Discover available nodes
- `GET /api/v1/node/health` - Check node health
- `GET /api/v1/gas/recommendations` - Get gas price recommendations

### **Client-Side Failover (RECOMMENDED)**

Applications should implement failover between nodes:

```javascript
// EXPERIMENTAL - Use with caution
const qnetNodes = [
    'http://node1.example.com:8001',
    'http://node2.example.com:8002',
    'http://node3.example.com:8003'
];

async function qnetApiCall(endpoint, data) {
    for (const node of qnetNodes) {
        try {
            const response = await fetch(`${node}/api/v1/${endpoint}`, {
                method: data ? 'POST' : 'GET',
                headers: {'Content-Type': 'application/json'},
                body: data ? JSON.stringify(data) : undefined
            });
            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            console.log(`Node ${node} unavailable, trying next...`);
        }
    }
    throw new Error('All nodes unavailable');
}
```

### **Production Deployment**

**⚠️ EXPERIMENTAL DEPLOYMENT**

```bash
# Multiple nodes for redundancy
# Terminal 1
cd development/qnet-integration
./target/release/qnet-node
# Enter activation code: QNET-XXXX-XXXX-XXXX

# Terminal 2
QNET_P2P_PORT=9878 QNET_RPC_PORT=9879 QNET_API_PORT=8002 ./target/release/qnet-node
# Enter activation code: QNET-YYYY-YYYY-YYYY

# Terminal 3
QNET_P2P_PORT=9880 QNET_RPC_PORT=9881 QNET_API_PORT=8003 ./target/release/qnet-node
# Enter activation code: QNET-ZZZZ-ZZZZ-ZZZZ
```

### **API Usage Examples**

**⚠️ EXPERIMENTAL ENDPOINTS**

```bash
# Node discovery
curl http://localhost:8001/api/v1/nodes/discovery

# Account balance
curl http://localhost:8001/api/v1/account/ADDRESS/balance

# Submit transaction
curl -X POST http://localhost:8001/api/v1/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "from": "addr1",
    "to": "addr2",
    "amount": 1000,
    "gas_price": 10,
    "gas_limit": 21000,
    "nonce": 1
  }'

# Get latest block
curl http://localhost:8001/api/v1/block/latest

# Batch operations
curl -X POST http://localhost:8001/api/v1/batch/claim-rewards \
  -H "Content-Type: application/json" \
  -d '{
    "node_ids": ["node_123", "node_456"],
    "owner_address": "owner_address"
  }'
```

### **Development Setup**

**🚀 PRODUCTION DEPLOYMENT (ONLY METHOD)**

```bash
# Clone and build production node 
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet

# Build Rust binary first
cd development/qnet-integration
cargo build --release
cd ../../

# Build production Docker image
docker build -t qnet-production -f Dockerfile.production .

# Run production node with interactive activation
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

### **Monitoring**

Each node provides metrics:
- Prometheus metrics: `http://localhost:PORT/metrics`
- Node health: `http://localhost:8001/api/v1/node/health`
- Network status: `http://localhost:8001/api/v1/nodes/discovery`

### **Security Considerations**

**⚠️ EXPERIMENTAL SECURITY**
- All endpoints are experimental and may have vulnerabilities
- No authentication/authorization implemented
- Use at your own risk in production
- Monitor for unexpected behavior
- Implement proper security measures before production use

### **Production Architecture**

QNet uses a distributed API architecture where every Full/Super node provides complete REST API functionality. This ensures maximum availability and performance for all applications.

**⚠️ EXPERIMENTAL SOFTWARE - USE AT YOUR OWN RISK ⚠️** 