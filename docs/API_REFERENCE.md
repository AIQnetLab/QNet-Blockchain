# QNet API Reference v2.19.12

## 📡 Base URL

```
Production: http://{node_ip}:8001/api/v1
Genesis Nodes:
  - 154.38.160.39:8001 (Node 001)
  - 62.171.157.44:8001 (Node 002)
  - 161.97.86.81:8001 (Node 003)
  - 5.189.130.160:8001 (Node 004)
  - 162.244.25.114:8001 (Node 005)
```

## 🔐 Authentication

Most endpoints are public. Protected endpoints require:
- `Authorization: Bearer {token}` header
- Ed25519 signature verification

> **📚 Cryptography Details**: See [CRYPTOGRAPHY_IMPLEMENTATION.md](../documentation/technical/CRYPTOGRAPHY_IMPLEMENTATION.md) for full cryptographic specifications.

---

## 📊 Blockchain Endpoints

### Get Block Height
```http
GET /api/v1/height
```

**Response:**
```json
{
  "height": 1234567,
  "timestamp": 1700000000
}
```

---

### Get Latest Block
```http
GET /api/v1/block/latest
```

**Response:**
```json
{
  "block_height": 1234567,
  "hash": "abc123...",
  "previous_hash": "def456...",
  "timestamp": 1700000000,
  "producer": "node_001",
  "transaction_count": 150,
  "poh_hash": "ghi789...",
  "poh_count": 500000000
}
```

---

### Get Block by Height
```http
GET /api/v1/block/{height}
```

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| height | u64 | Block number |

---

### Get Block by Hash
```http
GET /api/v1/block/hash/{hash}
```

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| hash | string | Block hash (hex) |

---

### Get Microblock
```http
GET /api/v1/microblock/{height}
```

---

### Get Microblocks Range
```http
GET /api/v1/microblocks?start={start}&end={end}
```

**Query Parameters:**
| Name | Type | Description |
|------|------|-------------|
| start | u64 | Start block height |
| end | u64 | End block height (max 100 blocks) |

---

### Get Macroblock
```http
GET /api/v1/macroblock/{height}
```

---

## 💰 Account Endpoints

### Get Account Info
```http
GET /api/v1/account/{address}
```

**Response:**
```json
{
  "address": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "balance": 1000000000,
  "nonce": 42,
  "node_type": "Light",
  "reputation": 70.0,
  "created_at": 1700000000
}
```

---

### Get Account Balance
```http
GET /api/v1/account/{address}/balance
```

**Response:**
```json
{
  "address": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "balance": 1000000000,
  "balance_formatted": "1.0 QNC"
}
```

---

### Get Account Transactions
```http
GET /api/v1/account/{address}/transactions?page={page}&per_page={per_page}
```

**Query Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| page | u32 | 1 | Page number |
| per_page | u32 | 20 | Items per page (max 100) |

---

## 📝 Transaction Endpoints

### Submit Transaction
```http
POST /api/v1/transaction
Content-Type: application/json
```

**⚠️ MANDATORY Signature Verification (NIST FIPS 186-5):**
- Ed25519 signature - **REQUIRED** for all transactions
- Without signature, transaction will be **REJECTED**

**Request Body:**
```json
{
  "from": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "to": "b2c3d4e5f6g7h8i9j0keonl1m2n3o4p5q6r7s8t9u0v1w2",
  "amount": 1000000000,
  "nonce": 42,
  "gas_price": 100000,
  "gas_limit": 10000,
  "signature": "ed25519_signature_hex",
  "public_key": "ed25519_pubkey_hex"
}
```

**Signature Message Format:**
```
transfer:{from}:{to}:{amount}:{nonce}
```

**Address Format**: `{19 hex}eon{15 hex}{4 hex checksum}` (41 characters total)

**Gas Limits** (QNet-optimized):
| Operation | Gas Limit |
|-----------|-----------|
| Transfer | 10,000 |
| Node Activation | 50,000 |
| Reward Claim | 25,000 |
| Contract Deploy | 500,000 |
| Contract Call | 100,000 |
| Ping | 0 (FREE) |
| Batch Operation | 150,000 |
| Max Limit | 1,000,000 |

**Min Gas Price**: 100,000 nano QNC (0.0001 QNC)
```

**Response:**
```json
{
  "success": true,
  "tx_hash": "abc123...",
  "message": "Transaction submitted"
}
```

---

### Get Transaction
```http
GET /api/v1/transaction/{hash}
```

**Response:**
```json
{
  "hash": "abc123...",
  "from": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "to": "b2c3d4e5f6g7h8i9j0keonl1m2n3o4p5q6r7s8t9u0v1w2",
  "amount": 1000000000,
  "nonce": 42,
  "gas_price": 100000,
  "gas_limit": 10000,
  "timestamp": 1700000000,
  "tx_type": "Transfer"
}
```

---

### Get Transaction History
```http
GET /api/v1/transactions/history?address={address}&page={page}&per_page={per_page}&tx_type={type}&direction={direction}&start_time={start}&end_time={end}
```

**Query Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| address | string | required | Wallet address |
| page | u32 | 1 | Page number |
| per_page | u32 | 20 | Items per page (max 100) |
| tx_type | string | "all" | Filter: "transfer", "activation", "reward", "all" |
| direction | string | "all" | Filter: "sent", "received", "all" |
| start_time | u64 | - | Unix timestamp start |
| end_time | u64 | - | Unix timestamp end |

**Response:**
```json
{
  "success": true,
  "transactions": [...],
  "total": 150,
  "page": 1,
  "per_page": 20,
  "total_pages": 8
}
```

---

## 🔄 Mempool Endpoints

### Get Mempool Status
```http
GET /api/v1/mempool/status
```

**Response:**
```json
{
  "pending_count": 1234,
  "total_gas": 50000000,
  "min_gas_price": 100000,
  "max_gas_price": 500000
}
```

---

### Get Mempool Transactions
```http
GET /api/v1/mempool/transactions?limit={limit}
```

---

## 📦 MEV Bundle Endpoints

### Submit Bundle
```http
POST /api/v1/bundle/submit
Content-Type: application/json
```

**Request Body:**
```json
{
  "transactions": [...],
  "gas_premium": 1.2,
  "max_block_number": 1234600,
  "signature": "dilithium_signature_hex"
}
```

**Response:**
```json
{
  "success": true,
  "bundle_id": "bundle_abc123",
  "expires_at": 1700000060
}
```

---

### Get Bundle Status
```http
GET /api/v1/bundle/{id}/status
```

---

### Cancel Bundle
```http
DELETE /api/v1/bundle/{id}
```

---

## 🤖 Node Activation Endpoints

### Generate Activation Code
```http
POST /api/v1/generate-activation-code
Content-Type: application/json
```

**Request Body:**
```json
{
  "wallet_address": "Solana_or_EON_address",
  "burn_tx_hash": "solana_burn_tx_signature",
  "node_type": "light|full|super",
  "burn_amount": 1350,
  "phase": 1
}
```

**Response:**
```json
{
  "success": true,
  "activation_code": "QNET-XXXXXX-XXXXXX-XXXXXX",
  "node_type": "light",
  "permanent": true
}
```

> **Note**: Activation codes are **permanent** and never expire. They are cryptographically bound to the burn transaction on Solana blockchain.

**Activation Code Format (25 chars):**
```
QNET-{TypeMarker+Timestamp}-{EncryptedWallet1}-{EncryptedWallet2+Entropy}
     └──────6 chars──────┘  └────6 chars────┘  └─────────6 chars─────────┘
```

---

### Get Activations by Wallet
```http
GET /api/v1/activations/by-wallet/{wallet_address}
```

**Response:**
```json
{
  "success": true,
  "activations": [
    {
      "activation_code_hash": "abc123...",
      "node_type": "light",
      "activated_at": 1700000000,
      "is_active": true
    }
  ]
}
```

---

## 📱 Light Node Endpoints

### Register Light Node
```http
POST /api/v1/light-node/register
Content-Type: application/json
```

**Request Body:**
```json
{
  "node_id": "light_node_abc123",
  "wallet_address": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "fcm_token": "firebase_token_here",
  "push_type": "fcm|unified_push|polling",
  "unified_push_endpoint": "https://ntfy.sh/topic_xyz",
  "public_key": "dilithium_pubkey_hex"
}
```

**Response:**
```json
{
  "success": true,
  "node_id": "light_node_abc123",
  "shard_id": 42,
  "next_ping_slot": 1700003600
}
```

---

### Light Node Ping Response
```http
POST /api/v1/light-node/ping-response
Content-Type: application/json
```

**Request Body:**
```json
{
  "node_id": "light_node_abc123",
  "challenge": "random_challenge_hex",
  "signature": "dilithium_signature_hex",
  "timestamp": 1700000000
}
```

---

### Reactivate Light Node
```http
POST /api/v1/light-node/reactivate
Content-Type: application/json
```

**Request Body:**
```json
{
  "node_id": "light_node_abc123",
  "wallet_address": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "signature": "ed25519_signature_hex"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Node reactivated successfully",
  "next_ping_slot": 1700003600
}
```

---

### Get Light Node Status
```http
GET /api/v1/light-node/status?node_id={node_id}
```

**Response:**
```json
{
  "success": true,
  "node_id": "light_node_abc123",
  "is_active": true,
  "consecutive_failures": 0,
  "last_seen": 1700000000,
  "shard_id": 42,
  "total_pings": 150,
  "successful_pings": 148
}
```

---

### Get Next Ping Time
```http
GET /api/v1/light-node/next-ping?node_id={node_id}
```

**Response:**
```json
{
  "success": true,
  "node_id": "light_node_abc123",
  "next_ping_time": 1700003600,
  "window_number": 42,
  "slot_in_window": 127
}
```

---

### Get Pending Challenge (Smart Polling)

Used by F-Droid users without UnifiedPush. Mobile app uses **smart wake-up** - schedules precise wake ~2 minutes before calculated ping slot (once per 4-hour window), NOT continuous polling.

```http
GET /api/v1/light-node/pending-challenge?node_id={node_id}
```

**Response (challenge available):**
```json
{
  "success": true,
  "node_id": "light_node_abc123",
  "has_challenge": true,
  "challenge": "random_challenge_hex",
  "expires_at": 1700000060
}
```

**Response (not in ping slot):**
```json
{
  "success": true,
  "node_id": "light_node_abc123",
  "has_challenge": false,
  "message": "Not your ping slot yet",
  "next_ping_time": 1700014400
}
```

> **Note**: App receives `next_ping_time` and schedules next wake-up accordingly. This ensures battery-efficient operation (~1 API call per 4 hours instead of continuous polling).

---

## 🖥️ Server Node Endpoints

### Get Server Node Status
```http
GET /api/v1/node/status?activation_code={code}&node_id={id}
```

**Query Parameters (one required):**
| Name | Type | Description |
|------|------|-------------|
| activation_code | string | QNET-XXXXXX-XXXXXX-XXXXXX |
| node_id | string | Node identifier |

**Response:**
```json
{
  "success": true,
  "node_id": "full_node_abc123",
  "node_type": "Full",
  "is_online": true,
  "heartbeat_count": 8,
  "reputation": 85.5,
  "pending_rewards": 1500000000,
  "total_distributed_rewards": 50000000000,
  "last_seen": 1700000000,
  "uptime_percentage": 99.5
}
```

---

## 💎 Rewards Endpoints

### Claim Rewards
```http
POST /api/v1/rewards/claim
Content-Type: application/json
```

**Request Body:**
```json
{
  "node_id": "node_abc123",
  "wallet_address": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "quantum_signature": "ed25519_signature_hex",
  "public_key": "ed25519_pubkey_hex"
}
```

**Response:**
```json
{
  "success": true,
  "claimed_amount": 1500000000,
  "tx_hash": "abc123...",
  "new_balance": 5000000000
}
```

---

### Batch Claim Rewards
```http
POST /api/v1/batch/claim-rewards
Content-Type: application/json
```

**Request Body:**
```json
{
  "node_ids": ["node_1", "node_2", "node_3"],
  "owner_address": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "signature": "ed25519_signature_hex"
}
```

---

### Batch Transfer
```http
POST /api/v1/batch/transfer
Content-Type: application/json
```

**⚠️ MANDATORY Signature Verification (NIST FIPS 186-5):**
- Ed25519 signature - **REQUIRED**
- All transfers in batch must be from the **SAME sender**

**Request Body:**
```json
{
  "transfers": [
    {
      "from": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
      "to_address": "b2c3d4e5f6g7h8i9j0keonl1m2n3o4p5q6r7s8t9u0v1w2",
      "amount": 1000000000,
      "memo": "Payment 1"
    },
    {
      "from": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
      "to_address": "c3d4e5f6g7h8i9j0k1leon2m3n4o5p6q7r8s9t0u1v2w3",
      "amount": 500000000,
      "memo": "Payment 2"
    }
  ],
  "batch_id": "batch_unique_id_123",
  "signature": "ed25519_signature_hex",
  "public_key": "ed25519_pubkey_hex"
}
```

**Signature Message Format:**
```
batch_transfer:{from}:{total_amount}:{transfer_count}:{batch_id}
```

**Response:**
```json
{
  "success": true,
  "batch_id": "batch_unique_id_123",
  "tx_hash": "batch_abc123...",
  "total_amount": 1500000000,
  "transfer_count": 2,
  "from_address": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "message": "Batch transfer submitted with 2 transfers"
}
```

---

### Get Pending Rewards
```http
GET /api/v1/rewards/pending?node_id={node_id}
```

**Response:**
```json
{
  "success": true,
  "node_id": "node_abc123",
  "pending_rewards": 1500000000,
  "pool1_rewards": 1000000000,
  "pool2_rewards": 500000000,
  "pool3_rewards": 0,
  "last_claim_time": 1699913600,
  "next_distribution": 1700000000
}
```

---

## 🌐 Network Endpoints

### Get Peers
```http
GET /api/v1/peers
```

**Response:**
```json
{
  "total_peers": 156,
  "connected_peers": 42,
  "peers": [
    {
      "node_id": "node_001",
      "ip": "154.38.160.39",
      "port": 9876,
      "node_type": "Super",
      "reputation": 95.0,
      "latency_ms": 45
    }
  ]
}
```

---

### Node Discovery
```http
GET /api/v1/nodes/discovery
```

---

### Get Registered Nodes
```http
GET /api/v1/nodes
```

---

### Register Node
```http
POST /api/v1/nodes
Content-Type: application/json
```

**Request Body:**
```json
{
  "node_id": "node_abc123",
  "node_type": "Full",
  "wallet_address": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "public_key": "dilithium_pubkey_hex",
  "api_endpoint": "http://node_ip:8001"
}
```

**Response:**
```json
{
  "success": true,
  "node_id": "node_abc123",
  "registered_at": 1700000000
}

---

### Node Health Check
```http
GET /api/v1/node/health
```

**Response:**
```json
{
  "status": "healthy",
  "node_id": "node_abc123",
  "node_type": "Full",
  "block_height": 1234567,
  "peers_connected": 42,
  "mempool_size": 150,
  "uptime_seconds": 86400
}
```

---

### Network Diagnostics
```http
GET /api/v1/diagnostics/network
```

---

### Network Failovers
```http
GET /api/v1/network/failovers
```

---

## 📈 Statistics Endpoints

### Get Network Stats
```http
GET /api/v1/stats
```

**Response:**
```json
{
  "block_height": 1234567,
  "total_transactions": 50000000,
  "total_accounts": 250000,
  "total_nodes": 15000,
  "light_nodes": 12000,
  "full_nodes": 2500,
  "super_nodes": 500,
  "tps_current": 1250,
  "tps_peak": 424411
}
```

---

### Get Block Stats
```http
GET /api/v1/blocks/stats
```

---

### Get Performance Metrics
```http
GET /api/v1/metrics/performance
```

---

## ⚙️ Advanced Endpoints

### PoH Status
```http
GET /api/v1/poh/status
```

**Response:**
```json
{
  "poh_hash": "abc123...",
  "poh_count": 500000000,
  "current_slot": 1234567,
  "hashes_per_second": 500000,
  "last_checkpoint": 499000000,
  "is_synchronized": true
}
```

---

### Turbine Metrics
```http
GET /api/v1/turbine/metrics
```

---

### Sealevel Metrics
```http
GET /api/v1/sealevel/metrics
```

---

### Pre-Execution Status
```http
GET /api/v1/pre-execution/status
```

---

### Tower BFT Timeouts
```http
GET /api/v1/tower-bft/timeouts
```

---

### Producer Status
```http
GET /api/v1/producer/status
```

---

### Sync Status
```http
GET /api/v1/sync/status
```

**Response:**
```json
{
  "is_synced": true,
  "current_height": 1234567,
  "target_height": 1234567,
  "sync_progress": 100.0,
  "peers_syncing_from": 5
}
```

---

### Gas Recommendations
```http
GET /api/v1/gas/recommendations
```

**Response:**
```json
{
  "slow": 100000,
  "standard": 150000,
  "fast": 250000,
  "instant": 500000,
  "base_fee": 100000
}
```

---

### Reputation History
```http
GET /api/v1/reputation/history?node_id={node_id}
```

---

## 🔒 Consensus Endpoints

### Consensus Commit
```http
POST /api/v1/consensus/commit
```

---

### Consensus Reveal
```http
POST /api/v1/consensus/reveal
```

---

### Get Consensus Round Status
```http
GET /api/v1/consensus/round/{round_number}
```

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| round_number | u64 | Consensus round number |

**Response:**
```json
{
  "round": 12345,
  "status": "committed",
  "participants": 850,
  "threshold_met": true,
  "block_hash": "abc123..."
}
```

---

### Consensus Sync
```http
POST /api/v1/consensus/sync
```

---

## 📜 Smart Contract Endpoints

### Deploy Contract
```http
POST /api/v1/contract/deploy
Content-Type: application/json
```

**⚠️ MANDATORY Hybrid Signatures (like consensus):**
- Ed25519 signature (NIST FIPS 186-5) - **REQUIRED**
- Dilithium signature (NIST FIPS 204) - **REQUIRED** (post-quantum security)
- SHA3-256 hash (NIST FIPS 202) - For code hash

> Smart contracts are critical operations. Like node consensus, they require BOTH classical and post-quantum signatures.

**Request Body:**
```json
{
  "from": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "code": "base64_encoded_wasm_bytecode",
  "constructor_args": {
    "name": "MyToken",
    "symbol": "MTK",
    "initial_supply": 1000000
  },
  "gas_limit": 500000,
  "gas_price": 150000,
  "nonce": 1,
  "signature": "ed25519_signature_hex",
  "public_key": "ed25519_pubkey_hex",
  "dilithium_signature": "dilithium_signature_hex",
  "dilithium_public_key": "dilithium_pubkey_hex"
}
```

**Signature Message Format:**
```
contract_deploy:{from}:{code_hash}:{nonce}
```

**Response:**
```json
{
  "success": true,
  "contract_address": "c1d2e3f4g5h6i7j8k9leon0m1n2o3p4q5r6s7t8u9v0w1",
  "code_hash": "sha3_256_hash_of_wasm",
  "code_size": 45678,
  "gas_limit": 500000,
  "deployer": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "message": "Contract deployment submitted to mempool",
  "security": {
    "ed25519_verified": true,
    "dilithium_verified": true,
    "quantum_secure": true,
    "nist_standards": {
      "signature": "FIPS 186-5 (Ed25519)",
      "hash": "FIPS 202 (SHA3-256)",
      "post_quantum": "FIPS 204 (Dilithium)"
    }
  }
}
```

**Gas Limits for Deployment:**
| Code Size | Recommended Gas |
|-----------|-----------------|
| < 10 KB | 100,000 |
| 10-50 KB | 250,000 |
| 50-100 KB | 500,000 |
| > 100 KB | 1,000,000 |

---

### Call Contract Method
```http
POST /api/v1/contract/call
Content-Type: application/json
```

**⚠️ MANDATORY Hybrid Signatures for State-Changing Calls:**
- Ed25519 signature (NIST FIPS 186-5) - **REQUIRED**
- Dilithium signature (NIST FIPS 204) - **REQUIRED**
- View calls (read-only) require NO signatures

**Request Body (State-Changing Call - BOTH signatures required):**
```json
{
  "from": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "contract_address": "c1d2e3f4g5h6i7j8k9leon0m1n2o3p4q5r6s7t8u9v0w1",
  "method": "transfer",
  "args": {
    "to": "b2c3d4e5f6g7h8i9j0keonl1m2n3o4p5q6r7s8t9u0v1w2",
    "amount": 1000000000
  },
  "gas_limit": 100000,
  "gas_price": 150000,
  "nonce": 2,
  "signature": "ed25519_signature_hex",
  "public_key": "ed25519_pubkey_hex",
  "dilithium_signature": "dilithium_signature_hex",
  "dilithium_public_key": "dilithium_pubkey_hex",
  "is_view": false
}
```

**Signature Message Format:**
```
contract_call:{from}:{contract_address}:{method}:{nonce}
```

**Request Body (View Call - No Signatures Required):**
```json
{
  "from": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "contract_address": "c1d2e3f4g5h6i7j8k9leon0m1n2o3p4q5r6s7t8u9v0w1",
  "method": "balanceOf",
  "args": {
    "account": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2"
  },
  "gas_limit": 10000,
  "gas_price": 100000,
  "nonce": 0,
  "is_view": true
}
```

**Response (State-Changing):**
```json
{
  "success": true,
  "tx_hash": "abc123...",
  "contract_address": "c1d2e3f4g5h6i7j8k9leon0m1n2o3p4q5r6s7t8u9v0w1",
  "method": "transfer",
  "gas_limit": 100000,
  "message": "Contract call submitted to mempool",
  "security": {
    "ed25519_verified": true,
    "dilithium_verified": true,
    "quantum_secure": true
  }
}
```

---

### Get Contract Info
```http
GET /api/v1/contract/{address}
```

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| address | string | Contract EON address |

**Response:**
```json
{
  "success": true,
  "contract": {
    "address": "c1d2e3f4g5h6i7j8k9leon0m1n2o3p4q5r6s7t8u9v0w1",
    "deployer": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
    "deployed_at": 1700000000,
    "code_hash": "sha3_256_hash",
    "version": "1.0.0",
    "total_gas_used": 5000000,
    "call_count": 150,
    "is_active": true
  }
}
```

---

### Get Contract State
```http
GET /api/v1/contract/{address}/state?key={key}
```

**Query Parameters:**
| Name | Type | Description |
|------|------|-------------|
| key | string | Single state key to query |
| keys | string | Comma-separated list of keys |

**Example:**
```http
GET /api/v1/contract/c1d2e3f4.../state?key=total_supply
GET /api/v1/contract/c1d2e3f4.../state?keys=name,symbol,decimals
```

**Response:**
```json
{
  "success": true,
  "contract_address": "c1d2e3f4g5h6i7j8k9leon0m1n2o3p4q5r6s7t8u9v0w1",
  "state": {
    "total_supply": "1000000000000000000",
    "name": "MyToken",
    "symbol": "MTK"
  }
}
```

---

### Estimate Gas
```http
POST /api/v1/contract/estimate-gas
Content-Type: application/json
```

**Request Body:**
```json
{
  "operation": "deploy|call|view",
  "code_size": 45678,
  "args": { "param1": "value1" }
}
```

**Response:**
```json
{
  "success": true,
  "operation": "deploy",
  "estimated_gas": 150000,
  "gas_prices": {
    "slow": 100000,
    "standard": 150000,
    "fast": 250000
  },
  "estimated_cost": {
    "slow": 15000000000,
    "standard": 22500000000,
    "fast": 37500000000
  },
  "estimated_cost_qnc": {
    "slow": "0.015000000 QNC",
    "standard": "0.022500000 QNC",
    "fast": "0.037500000 QNC"
  }
}
```

---

## 🔗 P2P Endpoints

### P2P Message
```http
POST /api/v1/p2p/message
Content-Type: application/json
```

**Request Body:**
```json
{
  "message_type": "BlockAnnouncement|Transaction|PeerDiscovery|...",
  "payload": "base64_encoded_data",
  "sender_id": "node_abc123",
  "signature": "dilithium_signature_hex"
}
```

---

### Ping
```http
GET /api/v1/ping
```

**Response:**
```json
{
  "status": "pong",
  "timestamp": 1700000000,
  "node_id": "node_abc123"
}
```

---

## 🔐 Authentication Endpoints

### Get Auth Challenge
```http
GET /api/v1/auth/challenge?address={address}
```

**Response:**
```json
{
  "challenge": "random_challenge_hex",
  "expires_at": 1700000060
}
```

---

## 🛑 Admin Endpoints

### Shutdown Node
```http
POST /api/v1/shutdown
Authorization: Bearer {admin_token}
```

---

### Trigger Failover
```http
POST /api/v1/failovers
Authorization: Bearer {admin_token}
```

---

### Get Secure Node Info
```http
GET /api/v1/node/secure-info
Authorization: Bearer {admin_token}
```

---

## 📋 Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Invalid/missing auth |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource doesn't exist |
| 429 | Too Many Requests - Rate limited |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Node syncing |

---

## 📊 Rate Limits

| Endpoint Type | Limit | Window |
|---------------|-------|--------|
| Public Read | 100 req | 1 min |
| Transaction Submit | 30 req | 1 min |
| Bundle Submit | 10 req | 1 min |
| Admin | 10 req | 1 min |

---

## 🔄 WebSocket - Real-time Events

### Connection
```
ws://{node_ip}:8001/ws/subscribe?channels=blocks,account:ADDRESS,contract:ADDRESS
```

### Rate Limiting (DDoS Protection)

| Limit | Value | Description |
|-------|-------|-------------|
| **Per IP** | 5 connections | Maximum simultaneous WebSocket connections per IP address |
| **Total** | 10,000 connections | Maximum total WebSocket connections per node |
| **Exceeded** | HTTP 429 | Returns "Too Many Requests" if limit exceeded |

> **Note:** Connection count is automatically decremented when client disconnects.

### Available Channels

| Channel | Format | Description |
|---------|--------|-------------|
| `blocks` | `blocks` | All new blocks |
| `account` | `account:EON_ADDRESS` | Balance updates for specific address |
| `contract` | `contract:EON_ADDRESS` | Events from specific contract |
| `mempool` | `mempool` | Pending transactions |
| `tx` | `tx:TX_HASH` | Specific transaction confirmation |

### Example Connection
```javascript
const ws = new WebSocket('ws://154.38.160.39:8001/ws/subscribe?channels=blocks,account:a1b2c3...');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Event:', data.type, data.data);
};
```

### Event Types

**NewBlock:**
```json
{
  "type": "NewBlock",
  "data": {
    "height": 1234567,
    "hash": "abc123...",
    "timestamp": 1700000000,
    "tx_count": 150,
    "producer": "node_001"
  }
}
```

**BalanceUpdate:**
```json
{
  "type": "BalanceUpdate",
  "data": {
    "address": "a1b2c3d4e5f6g7h8i9jeon...",
    "new_balance": 1500000000,
    "change": 100000000,
    "tx_hash": "tx_abc123..."
  }
}
```

**ContractEvent:**
```json
{
  "type": "ContractEvent",
  "data": {
    "contract_address": "c1d2e3f4g5h6i7j8k9leon...",
    "event_name": "Transfer",
    "data": {"from": "...", "to": "...", "amount": 100},
    "block_height": 1234567,
    "tx_hash": "tx_xyz789..."
  }
}
```

**TxConfirmed:**
```json
{
  "type": "TxConfirmed",
  "data": {
    "tx_hash": "tx_abc123...",
    "block_height": 1234567,
    "status": "confirmed"
  }
}
```

**PendingTx:**
```json
{
  "type": "PendingTx",
  "data": {
    "tx_hash": "tx_pending123...",
    "from": "a1b2c3...",
    "to": "b2c3d4...",
    "amount": 1000000000
  }
}
```

### Connection Messages

**Welcome (on connect):**
```json
{
  "type": "connected",
  "message": "WebSocket connected to QNet node",
  "subscribed_channels": 2,
  "timestamp": 1700000000
}
```

**Warning (if client lags):**
```json
{
  "type": "warning",
  "message": "Missed 5 events due to slow connection"
}
```

---

---

## 🪙 QRC-20 Token Endpoints (NEW v2.19.12)

### Deploy QRC-20 Token
```http
POST /api/v1/token/deploy
```

**Request Body:**
```json
{
  "from": "EON_creator_address...",
  "name": "MyToken",
  "symbol": "MTK",
  "decimals": 18,
  "initial_supply": 1000000000000000000,
  "signature": "base64_ed25519_signature",
  "public_key": "base64_ed25519_pubkey"
}
```

**Response:**
```json
{
  "success": true,
  "token": {
    "contract_address": "EON_contract_abc123...",
    "name": "MyToken",
    "symbol": "MTK",
    "decimals": 18,
    "total_supply": 1000000000000000000,
    "creator": "EON_creator_address..."
  }
}
```

---

### Get Token Info
```http
GET /api/v1/token/{contract_address}
```

**Response:**
```json
{
  "success": true,
  "token": {
    "contract_address": "EON_contract_abc123...",
    "name": "MyToken",
    "symbol": "MTK",
    "decimals": 18,
    "total_supply": 1000000000000000000
  }
}
```

---

### Get Token Balance
```http
GET /api/v1/token/{contract_address}/balance/{holder_address}
```

**Response:**
```json
{
  "success": true,
  "contract_address": "EON_contract_abc123...",
  "holder_address": "EON_holder...",
  "balance": 500000000000000000,
  "token_name": "MyToken",
  "token_symbol": "MTK",
  "decimals": 18
}
```

---

### Get All Tokens for Address
```http
GET /api/v1/account/{address}/tokens
```

**Response:**
```json
{
  "success": true,
  "address": "EON_holder...",
  "tokens": [
    {
      "contract_address": "EON_token1...",
      "balance": 500000000000000000,
      "name": "MyToken",
      "symbol": "MTK",
      "decimals": 18
    }
  ],
  "token_count": 1
}
```

---

## 📸 Snapshot Endpoints (NEW v2.19.12)

### Get Latest Snapshot
```http
GET /api/v1/snapshot/latest
```

**Response:**
```json
{
  "success": true,
  "height": 1234500,
  "ipfs_cid": "Qm...",
  "state_root": "abc123...",
  "timestamp": 1732712345
}
```

---

### Download Snapshot
```http
GET /api/v1/snapshot/{height}
```

**Response:** Binary snapshot data or redirect to IPFS

---

## 📝 Changelog

### v2.19.12 (November 2025)
- **NEW**: QRC-20 Token endpoints:
  - `POST /api/v1/token/deploy` - Deploy QRC-20 token
  - `GET /api/v1/token/{address}` - Get token info
  - `GET /api/v1/token/{address}/balance/{holder}` - Get token balance
  - `GET /api/v1/account/{address}/tokens` - Get all tokens for address
- **NEW**: Snapshot endpoints for fast sync:
  - `GET /api/v1/snapshot/latest` - Latest snapshot info
  - `GET /api/v1/snapshot/{height}` - Download snapshot
- **FIX**: Global token registry (persists across requests)
- **FIX**: Contract info returns error for non-existent contracts
- **FIX**: Peer validation logic corrected

### v2.19.5 (November 2025)
- **NEW**: WebSocket real-time event subscriptions:
  - `ws://node:8001/ws/subscribe` - Real-time events
  - Channels: blocks, account, contract, mempool, tx
- **NEW**: Smart Contract API endpoints:
  - `POST /api/v1/contract/deploy` - Deploy WASM contracts
  - `POST /api/v1/contract/call` - Call contract methods
  - `GET /api/v1/contract/{address}` - Get contract info
  - `GET /api/v1/contract/{address}/state` - Query contract state
  - `POST /api/v1/contract/estimate-gas` - Estimate gas costs
- Added IP-based rate limiting for DDoS protection
- Added CORS whitelist for production security
- Added EON address validation with checksum

### v2.19.4 (November 2025)
- Added `/api/v1/transactions/history` with pagination and filtering
- Added `/api/v1/light-node/reactivate` endpoint
- Added `/api/v1/node/status` for server node monitoring
- Updated activation code format to 25 chars (QNET-XXXXXX-XXXXXX-XXXXXX)
- Added UnifiedPush support for F-Droid compatibility
- Added polling fallback for Light nodes without push support

### v2.19.3 (October 2025)
- Added MEV bundle endpoints
- Added PoH status endpoint
- Added Turbine/Sealevel metrics

### v2.19.0 (September 2025)
- Initial API release
- Core blockchain endpoints
- Node activation system
- Reward claiming

---

## 📞 Support

- **GitHub**: https://github.com/AIQnetLab/QNet-Blockchain
- **X/Twitter**: https://x.com/AIQnetLab
- **Issues**: https://github.com/AIQnetLab/QNet-Blockchain/issues

