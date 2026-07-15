# QNet API Reference v2.61.0

## 📡 Base URL

```
REST API:     http://{node_ip}:8001/api/v1  (for Light nodes & external clients)
P2P (QUIC):   quic://{node_ip}:10876        (for Super nodes - internal)

Genesis Nodes:
  - 154.38.160.39:8001 (REST API) / :10876/udp (QUIC P2P)
  - 62.171.157.44:8001 (REST API) / :10876/udp (QUIC P2P)
  - 161.97.86.81:8001 (REST API) / :10876/udp (QUIC P2P)
  - 5.189.130.160:8001 (REST API) / :10876/udp (QUIC P2P)
  - 162.244.25.114:8001 (REST API) / :10876/udp (QUIC P2P)

Note: Light nodes use REST API (HTTP). Super nodes use QUIC for P2P.
```

## 🔐 Authentication

Most endpoints are public. Protected endpoints require:
- `Authorization: Bearer {token}` header
- ML-DSA-65 signature verification

> **📚 Cryptography Details**: See [CRYPTOGRAPHY_IMPLEMENTATION.md](../documentation/technical/CRYPTOGRAPHY_IMPLEMENTATION.md) for full cryptographic specifications.

### Signature Types

| Context | Algorithm | Notes |
|---------|-----------|-------|
| **User Transactions** | ML-DSA-65 | Pure post-quantum wallet signatures (NIST FIPS 204) |
| **Node-to-Node (P2P)** | ML-DSA-65 | Pure post-quantum; transport uses X25519Kyber768 hybrid TLS key exchange |
| **Block Signatures** | ML-DSA-65 | Quantum-resistant, FIPS 204 |

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

**⚠️ MANDATORY Signature Verification (NIST FIPS 204):**
- ML-DSA-65 signature - **REQUIRED** for all transactions
- The `dilithium_public_key` must derive to `from` (address = hash of the Dilithium public key)
- Without a valid Dilithium signature, transaction will be **REJECTED**
- Ed25519 is **not accepted** on any QNet path (it is Solana-only, used for the 1DEV burn on Solana)

**Request Body (Standard TX - pure ML-DSA-65):**
```json
{
  "from": "a1b2c3d4e5f6g7h8i9jeon0k1l2m3n4o5p6q7r8s9a1b2",
  "to": "b2c3d4e5f6g7h8i9j0keonl1m2n3o4p5q6r7s8t9u0v1w2",
  "amount": 1000000000,
  "nonce": 42,
  "gas_price": 100000,
  "gas_limit": 10000,
  "dilithium_signature": "mldsa65_signature_hex",
  "dilithium_public_key": "mldsa65_pubkey_hex"
}
```

**Signature Message Format:**
```
transfer:{from}:{to}:{amount}:{nonce}
```

**Address Format**: `{19 hex}eon{15 hex}{8 hex SHA3-256 checksum}` (45 characters total)

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
  "node_type": "light|super",  // v3.18: full removed
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
  "signature": "mldsa65_signature_hex"
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
  "node_id": "super_node_abc123",
  "node_type": "Super",
  "is_online": true,
  "heartbeat_count": 9,
  "reputation": 85.5,
  "pending_rewards": 1500000000,
  "total_distributed_rewards": 50000000000,
  "last_seen": 1700000000,
  "uptime_percentage": 99.5
}
```

---

## 💎 Rewards Endpoints

### Reward System Overview (v2.43.1)

**Reward Rounds (Epochs):**
- 1 epoch = 14,400 blocks = 4 hours (at 1 block/second)
- Rewards distributed at blocks 14400, 28800, 43200, etc.

**Two Reward Pools (v3.18):**
| Pool | Source | Distribution | Phase |
|------|--------|--------------|-------|
| Pool 1 | Base Emission | Equal to ALL eligible nodes | Both |
| Pool 3 | Activation Payments | Equal to ALL eligible nodes | Phase 2 only |

> **v3.18**: Pool 2 removed - transaction fees go directly to block producer.

**Dynamic Emission (Pool 1):**
- Initial: ~251,432 QNC per epoch
- Halving: every 4 years
- Sharp drop: 10x reduction at year 20

**Eligibility Requirements:**
| Node Type | Pings Required | Timing |
|-----------|----------------|--------|
| Light | 1/1 attestation | Once per 4h window (sharded, pinged by Genesis) |
| Super / Genesis | 9/10 on-chain Heartbeat TXs | One per ~1440-block subwindow |

> **v34:** Super/Genesis reward eligibility is decided by an **on-chain Heartbeat counter**, not the self-reported `heartbeat_count`. Each node emits ~10 Dilithium-signed `Heartbeat` TXs per epoch, each anchored to a recent canonical block hash and included within ~90 blocks of its anchor. A per-node subwindow bitmask in account-state (part of `state_root`) is recomputed identically by every node; eligibility = `popcount(bitmask) >= 9` of 10. The `required_heartbeats` field is therefore **9** for Super/Genesis (Light = 1).

**Ping Window Calculation:**
```
window_start = timestamp - (timestamp % (4 * 60 * 60))
window_end = window_start + (4 * 60 * 60)

Heartbeat included if: timestamp >= window_start && timestamp < window_end
```

**⚠️ Nodes Joining Mid-Round:**
Nodes that start in the middle of a 4-hour window will NOT be eligible for rewards in that round (not enough heartbeats). Rewards begin from the NEXT complete round.

---

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
  "quantum_signature": "mldsa65_signature_hex",
  "public_key": "mldsa65_pubkey_hex"
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
  "signature": "mldsa65_signature_hex"
}
```

---

### Batch Transfer
```http
POST /api/v1/batch/transfer
Content-Type: application/json
```

**⚠️ MANDATORY Signature Verification (NIST FIPS 204):**
- ML-DSA-65 signature - **REQUIRED**
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
  "signature": "mldsa65_signature_hex",
  "public_key": "mldsa65_pubkey_hex"
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
  "node_type": "Super",  // v3.18: Full removed
  "pending_rewards": 1.5,
  "pools": {
    "pool1_base_emission": 1.0,
    "pool2_tx_fees": 0,  // v3.18: Pool 2 removed
    "pool3_activation_bonus": 0.0
  },
  "ping_status": {
    "heartbeat_count": 10,
    "required_heartbeats": 9,
    "is_eligible": true
  },
  "current_phase": "Phase1",
  "current_window_start": 1700000000,
  "current_block_height": 14500,
  "needs_attention": false
}
```

> **v34:** For Super/Genesis nodes, `is_eligible` reflects the **on-chain Heartbeat counter** (subwindow bitmask `popcount >= 9` of 10), not the self-reported `heartbeat_count`. The `heartbeat_count`/`required_heartbeats` fields still exist (`required_heartbeats` = 9 for Super/Genesis, 1 for Light) but the on-chain counter is authoritative for eligibility.

---

### Get Reward History (NEW v2.43.1)
```http
GET /api/v1/rewards/history/{node_id}?offset={offset}&limit={limit}
```

**Query Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| offset | u64 | 0 | Number of epochs to skip (for pagination) |
| limit | u64 | 10 | Number of epochs to return (max 100) |

**Response:**
```json
{
  "success": true,
  "node_id": "node_abc123",
  "current_epoch": 25,
  "history": [
    {
      "epoch": 24,
      "status": "claimed",
      "total_qnc": 1.5,
      "pool1_qnc": 1.0,
      "pool2_qnc": 0,  // v3.18: Pool 2 removed - fees direct to producer
      "pool3_qnc": 0.0,
      "claim_time": 1700100000,
      "tx_hash": "abc123..."
    },
    {
      "epoch": 23,
      "status": "unclaimed",
      "estimated_qnc": 1.4
    }
  ],
  "pagination": {
    "offset": 0,
    "limit": 10,
    "has_more": true
  }
}
```

---

### Get Reward Pools Detail (NEW v2.43.1)
```http
GET /api/v1/rewards/pools/{node_id}
```

**Description:** Returns detailed breakdown of all reward pools for a specific node, including dynamic emission rates with halving schedule.

**Response:**
```json
{
  "success": true,
  "node_id": "node_abc123",
  "pools": {
    "pool1_base_emission": {
      "current_epoch_qnc": 1.0,
      "description": "Base emission divided equally among all eligible nodes"
    },
    "pool2_transaction_fees": {  // v3.18: DEPRECATED - fees go direct to producer
      "current_epoch_qnc": 0,  // Always 0 in v3.18+
      "description": "DEPRECATED in v3.18 - fees go direct to producer"
    },
    "pool3_activation_bonus": {
      "current_epoch_qnc": 0.0,
      "description": "Share of activation pool (Phase 2 only)"
    }
  },
  "emission_rate": {
    "pool1_base_per_epoch_qnc": 251432.34,
    "pool1_base_per_year_qnc": 551643145.56,
    "current_phase": "Phase1",
    "phase_description": "Phase1: 1DEV burn for activation, Pool3 disabled",
    "halving_schedule": {
      "period_years": 4,
      "sharp_drop_year": 20,
      "sharp_drop_multiplier": 10
    }
  },
  "eligibility": {
    "is_eligible": true,
    "heartbeats": 10,
    "required": 9,
    "node_type": "Super"  // v3.18: Full removed
  },
  "cached_at": 1700000000,
  "cache_ttl_seconds": 10
}
```

---

### Get Rewards by Wallet (NEW v2.43.1)
```http
GET /api/v1/rewards/by-wallet/{wallet_address}
```

**Description:** Returns all nodes owned by a specific wallet address with their pending rewards. Uses inverted index for O(1) lookup.

**Response:**
```json
{
  "success": true,
  "wallet_address": "a1b2c3d4e5f6g7h8i9jeon...",
  "nodes": [
    {  // v3.18: Full nodes removed - example shows Super
      "node_id": "super_node_001",
      "node_type": "Super",
      "pending_qnc": 1.5,
      "is_eligible": true,
      "heartbeats": 10
    },
    {
      "node_id": "light_node_002",
      "node_type": "Light",
      "pending_qnc": 0.5,
      "is_eligible": true,
      "attestations": 1
    }
  ],
  "total_pending_qnc": 2.0,
  "node_count": 2
}
```

---

### Batch Get Pending Rewards (NEW v2.43.1)
```http
POST /api/v1/rewards/pending/batch
Content-Type: application/json
```

**Description:** Get pending rewards for multiple nodes in a single request. Max 100 nodes per batch.

**Request Body:**
```json
{
  "node_ids": ["node_001", "node_002", "node_003"]
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "node_id": "node_001",
      "pending_qnc": 1.5,
      "is_eligible": true
    },
    {
      "node_id": "node_002",
      "pending_qnc": 0.8,
      "is_eligible": true
    },
    {
      "node_id": "node_003",
      "error": "Node not found"
    }
  ],
  "total_pending_qnc": 2.3,
  "successful": 2,
  "failed": 1
}
```

---

### Get Network Reward Stats (NEW v2.43.1)
```http
GET /api/v1/rewards/network/stats
```

**Description:** Returns network-wide reward statistics. Cached for 30 seconds.

**Response:**
```json
{
  "success": true,
  "network_stats": {
    "total_claims_all_time": 15000,
    "total_distributed_qnc": 1500000.0,
    "recent_epochs_scanned": 50
  },
  "current_epoch": 25,
  "current_block_height": 360000,
  "emission_rate": {
    "pool1_base_per_epoch_qnc": "dynamic - use /api/v1/rewards/pools for current value",
    "initial_rate_qnc_per_epoch": 251432.34,
    "halving_period_years": 4,
    "sharp_drop_at_year": 20,
    "sharp_drop_multiplier": 10
  },
  "phases": {
    "current": "Phase1",
    "phase1_description": "1DEV burn, Pool3=0",
    "phase2_description": "QNC activation, Pool3 enabled"
  },
  "cached_at": 1700000000,
  "cache_ttl_seconds": 30
}
```

---

### Get Reward Summary (NEW v2.43.1)
```http
GET /api/v1/rewards/summary/{node_id}
```

**Description:** Returns lifetime aggregated reward statistics for a node. Useful for displaying total earnings in wallet UI. Cached for 60 seconds.

**Response:**
```json
{
  "success": true,
  "node_id": "node_abc123",
  "lifetime_stats": {
    "total_claimed_qnc": 150.5,
    "total_pool1_qnc": 100.0,
    "total_pool2_qnc": 0,  // v3.18: Pool 2 removed
    "total_pool3_qnc": 5.5,
    "epochs_participated": 100,
    "epochs_claimed": 95,
    "epochs_missed": 5,
    "first_claim_epoch": 1,
    "last_claim_epoch": 95,
    "average_per_epoch_qnc": 1.58
  },
  "current_pending": {
    "pending_qnc": 1.5,
    "is_eligible": true,
    "current_epoch": 100
  },
  "cached_at": 1700000000,
  "cache_ttl_seconds": 60
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
  "node_type": "Super",  // v3.18: Full removed
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
  "node_type": "Super",  // v3.18: Full removed
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
  "full_nodes": 0,  // v3.18: Full nodes removed
  "super_nodes": 2500,
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

## 🌍 Public Endpoints (Cached)

These endpoints are optimized for public consumption (websites, dashboards). Data is cached on the server for 10 minutes to prevent spam and ensure consistent responses.

### Get Public Stats
```http
GET /api/v1/public/stats
```

**Description:** Returns cached network statistics. Safe to call frequently - same data for all clients. Server updates cache every 10 minutes.

**Response:**
```json
{
  "active_nodes": 85000,
  "light_nodes": 50000,
  "full_nodes": 0,  // v3.18: Full nodes removed
  "super_nodes": 35000,
  "height": 1234567,
  "phase": 1,
  "burn_percentage": 45.5,
  "cached_at": "2025-11-28T12:00:00Z",
  "cache_ttl_seconds": 600
}
```

| Field | Type | Description |
|-------|------|-------------|
| active_nodes | u64 | Total active nodes (Light + Super) |
| light_nodes | u64 | Active Light nodes |
| full_nodes | u64 | Always 0 (v3.18: removed) |
| super_nodes | u64 | Active Super nodes |
| height | u64 | Current blockchain height |
| phase | u8 | Current phase (1 = 1DEV burn, 2 = QNC) |
| burn_percentage | f64 | Percentage of 1DEV supply burned |
| cached_at | string | ISO 8601 timestamp of cache update |
| cache_ttl_seconds | u64 | Cache lifetime in seconds |

---

### Get Activation Price
```http
GET /api/v1/activation/price?type={node_type}
```

**Description:** Returns server-calculated activation price. Server knows burn percentage and network size - client cannot manipulate pricing.

**Query Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| type | string | No | Node type: `light`, `super`. Default: `light` |

**Phase 1 Response (1DEV Burn):**
```json
{
  "phase": 1,
  "node_type": "super",
  "cost": 1050,
  "currency": "1DEV",
  "base_cost": 1500,
  "min_cost": 300,
  "burn_percentage": 30.0,
  "savings": 450,
  "savings_percent": 30,
  "mechanism": "burn",
  "universal_price": true
}
```

**Phase 2 Response (QNC Transfer):**
```json
{
  "phase": 2,
  "node_type": "super",
  "cost": 5000,
  "currency": "QNC",
  "base_cost": 10000,
  "multiplier": 0.5,
  "mechanism": "transfer_to_pool3",
  "universal_price": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| phase | u8 | Current activation phase |
| node_type | string | Requested node type |
| cost | u64 | Final activation cost |
| currency | string | Token to use (1DEV or QNC) |
| base_cost | u64 | Base price before discounts |
| multiplier | f64 | Network size multiplier (Phase 2 only) |
| mechanism | string | `burn` (Phase 1) or `transfer_to_pool3` (Phase 2) |
| universal_price | bool | True if same price for all node types |

**Phase 1 Pricing Formula:**
```
price = max(1500 - floor(burn% / 10) × 150, 300)
```

**Phase 2 Network Multipliers:**
| Network Size | Multiplier |
|--------------|------------|
| ≤100K nodes | 0.5x (early adopter discount) |
| ≤300K nodes | 1.0x (base price) |
| ≤1M nodes | 2.0x (high demand) |
| >1M nodes | 3.0x (maximum) |

---

## ⚙️ Advanced Endpoints

### VTS Status
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

### Shred Protocol Metrics
```http
GET /api/v1/shred-protocol/metrics
```

---

### Parallel Executor Metrics
```http
GET /api/v1/parallel-executor/metrics
```

---

### Pre-Execution Status
```http
GET /api/v1/pre-execution/status
```

---

### Adaptive BFT Timeouts
```http
GET /api/v1/adaptive-bft/timeouts
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

> Macroblock finality (Checkpoint-BFT v2) is reached over internal P2P consensus,
> not via HTTP. There are no `consensus/commit` or `consensus/reveal` endpoints —
> a VRF-sampled committee signs one checkpoint per 90-block window (2f+1 QC).

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

**⚠️ MANDATORY Signature (pure post-quantum):**
- ML-DSA-65 signature (NIST FIPS 204) - **REQUIRED**
- SHA3-256 hash (NIST FIPS 202) - For code hash

> Smart contracts are critical operations and are authorised with a pure ML-DSA-65 signature, like all other QNet transactions. Ed25519 is not used on any QNet path.

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
  "dilithium_signature": "mldsa65_signature_hex",
  "dilithium_public_key": "mldsa65_pubkey_hex"
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
    "dilithium_verified": true,
    "quantum_secure": true,
    "nist_standards": {
      "signature": "FIPS 204 (ML-DSA-65)",
      "hash": "FIPS 202 (SHA3-256)"
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

**⚠️ MANDATORY Signature for State-Changing Calls (pure post-quantum):**
- ML-DSA-65 signature (NIST FIPS 204) - **REQUIRED**
- View calls (read-only) require NO signatures

**Request Body (State-Changing Call - Dilithium signature required):**
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
  "dilithium_signature": "mldsa65_signature_hex",
  "dilithium_public_key": "mldsa65_pubkey_hex",
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

> **Note (v2.19.22)**: Super nodes use QUIC (UDP 10876) for P2P communication.
> These HTTP endpoints are for Light nodes and legacy compatibility only.

### P2P Message (Light Nodes Only)
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

| Endpoint Type | Limit | Window | Block Duration |
|---------------|-------|--------|----------------|
| Public Read | 100 req | 1 min | 30 sec |
| Transaction Submit | 30 req | 1 min | 60 sec |
| Bundle Submit | 10 req | 1 min | 120 sec |
| Reward Read | 300 req | 1 min | 30 sec |
| Reward Claim | 60 req | 1 min | 60 sec |
| Admin | 10 req | 1 min | 300 sec |

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
| `rewards` | `rewards:NODE_ID` | Reward updates for specific node (NEW v2.43.1) |

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

**RewardClaimed (NEW v2.43.1):**
```json
{
  "type": "RewardClaimed",
  "data": {
    "node_id": "node_abc123",
    "wallet_address": "a1b2c3d4e5f6g7h8i9jeon...",
    "amount_qnc": 1.5,
    "tx_hash": "abc123...",
    "epoch": 25
  }
}
```

**RewardUpdate (NEW v2.43.1):**
```json
{
  "type": "RewardUpdate",
  "data": {
    "node_id": "node_abc123",
    "pending_qnc": 1.5,
    "pool1_qnc": 1.0,
    "pool2_qnc": 0,  // v3.18: Pool 2 removed
    "pool3_qnc": 0.0,
    "is_eligible": true,
    "heartbeats": 10
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
  "decimals": 9,
  "initial_supply": 1000000000000000000,
  "signature": "base64_mldsa65_signature",
  "public_key": "base64_mldsa65_pubkey"
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
    "decimals": 9,
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
    "decimals": 9,
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
  "decimals": 9
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
      "decimals": 9
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

> **Note (2026-07): superseded on signatures.** Any earlier entry describing a HYBRID (Ed25519 + Dilithium) signature for transactions, heartbeats, or block/consensus signing is legacy. QNet now signs all transactions, consensus, node identity, and P2P gossip with pure ML-DSA-65; Ed25519 is Solana-only (1DEV burn). "Hybrid" applies only to the QUIC/TLS 1.3 X25519Kyber768 key exchange.

### v2.43.1 (December 2025)

**🎁 REWARDS API OVERHAUL**
- **NEW**: `GET /api/v1/rewards/history/{node_id}` - Paginated reward history by epoch
- **NEW**: `GET /api/v1/rewards/pools/{node_id}` - Detailed pool breakdown with dynamic emission
- **NEW**: `GET /api/v1/rewards/by-wallet/{wallet}` - All nodes for a wallet (O(1) inverted index)
- **NEW**: `POST /api/v1/rewards/pending/batch` - Batch pending rewards (max 100 nodes)
- **NEW**: `GET /api/v1/rewards/network/stats` - Network-wide reward statistics
- **NEW**: `GET /api/v1/rewards/summary/{node_id}` - Lifetime aggregated stats for node
- **NEW**: WebSocket events: `RewardClaimed`, `RewardUpdate`
- **NEW**: WebSocket channel: `rewards:NODE_ID`
- **IMPROVED**: Rate limiting for all reward endpoints (300 req/min read, 60 req/min write)
- **IMPROVED**: Caching: Pool data (10s), Network stats (30s), Summary (60s)
- **FIX**: Off-by-one bug in reward window calculation (v2.43.1)
- **FIX**: Pool 1 dynamic emission with halving schedule
- **FIX**: Pool 3 correctly shows 0 in Phase 1, enabled in Phase 2

**🔧 CONSENSUS IMPROVEMENTS**
- **FIX**: `prev_hash_mismatch` now triggers `FORK_DETECTED` for proper reorg
- **NEW**: Height validation in heartbeats (max +100 jump, +50 ahead of local)
- **NEW**: Backpressure for block broadcasts (max 3 pending, 500ms wait)
- **IMPROVED**: Heartbeat service now uses `tokio::spawn` (was `std::thread`)
- **IMPROVED**: `sign_heartbeat_dilithium` uses `spawn_blocking` (no runtime panic)

### v2.19.20 (November 2025)
- **OPTIMIZATION**: Fire-and-forget Shred Protocol broadcast (1 block/sec production guaranteed)
- **OPTIMIZATION**: 30-second Genesis startup wait (prevents race conditions)
- **OPTIMIZATION**: Emergency timeout increased to 10s (was 2s)
- **RELIABILITY**: Pseudo-infinite retries for blocks (never discard critical data)
- **RELIABILITY**: Exponential backoff: 10s (0-9) → 30s → 60s → 120s → 240s → 300s max
- **MEMORY**: Adaptive buffer: Super 500 blocks (~50MB), Light 100 blocks (~10MB)
- **SYNC**: Background re-request every 30s with exponential backoff

### v2.23 (December 2025)
- **SECURITY**: Heartbeat signed with pure ML-DSA-65
- **OPTIMIZATION**: RAW bytes signatures (88% size reduction)
- **OPTIMIZATION**: Shred Protocol block propagation for ALL network sizes
- **OPTIMIZATION**: Kademlia K-neighbors for heartbeat routing (K=3)
- **OPTIMIZATION**: Exponential backoff for failover (3s → 6s → 12s → 24s → 30s max)
- **NEW**: `gossip_to_k_neighbors()` method for DHT-based message propagation
- **SECURITY**: Heartbeat validation via active_super_nodes registry (NIST FIPS 204 compliant)

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
- Added VTS status endpoint
- Added Shred Protocol/Parallel Executor metrics

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

