# QNet Node Activation Architecture - Two-Phase System

## Overview
QNet uses a two-phase activation system transitioning from 1DEV burn on Solana to QNC Pool 3 transfers on QNet.

## **CRITICAL DEVICE RESTRICTIONS (STRICTLY ENFORCED)**

### Server Deployment (Docker Only)
- **Genesis Nodes**: Hardcoded bootstrap nodes with `QNET_BOOTSTRAP_ID` — auto-generated activation
- **Super Nodes**: Activated via Docker environment variables (`QNET_ACTIVATION_CODE` + `QNET_BURN_TX_HASH` + `QNET_BURN_AMOUNT` + `QNET_WALLET_SEED`)
- **Light Nodes**: **ABSOLUTELY BLOCKED** — Cannot be activated on servers (enforced at code level with `std::process::exit(1)`)

### Mobile Device Deployment
- **Light Nodes**: Can ONLY be activated on mobile devices via QNet mobile app
- **Super Nodes**: Cannot be activated on mobile devices (mobile only obtains the activation code)

### **ENFORCEMENT MECHANISMS - FULLY IMPLEMENTED**
- **Code-Level Blocking**: Light node codes (prefix `QNET-L`) cause immediate `std::process::exit(1)` on servers
- **Dual Validation**: Both `validate_server_node_type()` and `decode_activation_code()` block Light nodes
- **No Bypass**: Impossible to circumvent restrictions through configuration or parameters
- **Production Deployment**: Enforcement tested and verified in production environment

### **BLOCKCHAIN CONSENSUS INTEGRATION - PRODUCTION READY**

**Decentralized Architecture:**
- **Consensus Engine Queries**: Direct blockchain state access without RPC dependencies
- **P2P Network Validation**: Multi-node consensus for critical operations
- **Blockchain-Native Storage**: Migration history and activation records on-chain  
- **Genesis Bootstrap Support**: New network deployment without external dependencies

**Performance Optimizations:**
- **Zero-Copy Operations**: Minimal memory allocation during validation
- **LRU Caching**: Aggressive caching for frequently accessed activation records
- **Parallel Validation**: Concurrent processing of multiple activation requests
- **Memory Efficiency**: Optimized data structures for high-throughput scenarios

**Verifiable Time Sequence (VTS) Integration:**
- **Hybrid Hashing**: SHA3-512/Blake3 (25%/75%) for optimal security/performance
- **Performance**: 2.39M hashes/sec verified on Intel Xeon E5-2680v4 @ 2.4GHz
- **Test Results**: 7.2M hashes in 3.01 seconds, 187 entries generated (October 31, 2025)
- **Configuration**: 25,000 hashes per tick, 10ms tick duration, 100 ticks per slot
- **Entropy Source**: 100 updates/sec for producer selection randomness
- **VDF Properties**: SHA3-512 every 4th hash prevents parallelization attacks
- **Persistence**: Checkpoints saved every 1M hashes with zstd compression
- **Recovery**: Automatic checkpoint loading on node restart
- **Clock Drift**: 5-7% measured (excellent for production deployment)
- **Overhead**: 72 bytes per block (poh_hash: 64B + poh_count: 8B) = ~2-3%
- **Monitoring**: Prometheus metrics for hash rate, drift detection, and checkpoint count

## **ACTIVATION CODE ARCHITECTURE (v4.7)**

### **Cryptography Stack**
- **Activation Code Encryption**: XOR with SHA3-256 derived key from `burn_tx_hash:node_type:burn_amount`
- **Node Registration Signatures**: ML-DSA-65 (NIST FIPS 204) — quantum-resistant
- **Wallet Ownership Proof (Light Nodes)**: Ed25519 signature from Solana private key
- **Wallet Ownership Proof (Super Nodes)**: BIP39 mnemonic → SLIP-10 → Solana Ed25519 address derivation, compared with XOR-decrypted prefix
- **Burn Transaction Verification**: Solana RPC `getTransaction` with `feePayer` (signer) check
- **Hash Functions**: SHA3-256 (NIST FIPS 202) for all key material derivation
- **On-Chain Registration**: `NodeRegistration` + `NodeActivation` transaction types with ML-DSA-65 signatures

### **Activation Code Format**

**Format**: `QNET-XXXXXX-XXXXXX-XXXXXX` (25 characters total)

```
Segment 1 (6 chars): NodeType marker (L/S) + Timestamp (5 hex chars)
Segment 2 (6 chars): XOR-encrypted Solana wallet address part 1
Segment 3 (6 chars): XOR-encrypted Solana wallet address part 2 + entropy
```

```python
# XOR-encryption based code generation (rpc.rs / bridge-server)
def generate_activation_code(burn_tx_hash: str, wallet_address: str, 
                              node_type: str, burn_amount: int) -> str:
    # Step 1: Create encryption key from burn transaction
    # CRITICAL: burn_amount must match exactly for decryption!
    # Using SHA3-256 for NIST SP 800-186 compliance
    key_material = f"{burn_tx_hash}:{node_type}:{burn_amount}"
    encryption_key = sha3_256(key_material.encode()).hexdigest()[:32]
    
    # Step 2: XOR encrypt Solana wallet address (first 5 bytes -> 10 hex chars)
    # NOTE: wallet_address is the SOLANA address (base58), NOT the QNet EON address
    encrypted_wallet = xor_encrypt(wallet_address[:5], encryption_key)
    encrypted_wallet_hex = encrypted_wallet.hex().upper()  # 10 chars
    
    # Step 3: Generate entropy for additional security
    entropy = sha3_256(f"{burn_tx_hash}:{timestamp}".encode()).hexdigest()[:4]
    
    # Step 4: Build segments
    # v3.18: Only Light and Super nodes (Full removed)
    node_type_marker = {'light': 'L', 'super': 'S'}[node_type]
    timestamp_hex = hex(int(time.time()) % 0x100000)[2:].zfill(5)
    
    segment1 = f"{node_type_marker}{timestamp_hex}"[:6].upper()  # 6 chars
    segment2 = encrypted_wallet_hex[:6]                          # 6 chars
    segment3 = f"{encrypted_wallet_hex[6:10]}{entropy}"[:6].upper()  # 6 chars
    
    # Format: QNET-XXXXXX-XXXXXX-XXXXXX (25 chars)
    return f"QNET-{segment1}-{segment2}-{segment3}"
```

### **Stateless Decryption Process** (quantum_crypto.rs / rpc.rs):
1. Parse segments from activation code
2. Reconstruct `key_material = "{burn_tx_hash}:{node_type}:{burn_amount}"`
3. Derive encryption key via SHA3-256
4. XOR-decrypt Solana wallet prefix from segments 2+3
5. Verify decrypted prefix matches the Solana address of the registering wallet
6. **No in-memory registry needed** — verification is fully stateless

### **Multi-Layer Wallet Ownership Verification (v4.7)**

```
Layer 1: XOR Verification (stateless)
  Code = XOR(solana_wallet_prefix, SHA3(burn_tx:type:amount))
  → Only the holder of burn_tx_hash + burn_amount can reconstruct the key
  → Decrypted prefix MUST match the provided Solana address

Layer 2: Solana feePayer Check
  → verify_burn_transaction_exists() fetches the burn TX from Solana RPC
  → Extracts accountKeys[0] (feePayer/signer) from the transaction
  → Compares with the provided burn_wallet (Solana address)
  → Rejects if feePayer != burn_wallet

Layer 3a: Ed25519 Signature (Light Nodes — mobile registration)
  → Mobile app signs message: "qnet_register:{nodeId}:{timestamp}"
  → Signed with Solana Ed25519 private key (derived from mnemonic via BIP44)
  → Server verifies signature against burn_wallet public key

Layer 3b: Mnemonic-to-Solana Derivation (Super Nodes — server registration)
  → Server derives Solana address from QNET_WALLET_SEED via BIP39+SLIP-10+Ed25519
  → Compares derived address with XOR-decrypted prefix from activation code
  → Ensures the mnemonic entered in Docker matches the wallet that burned tokens

Layer 4: Dynamic Pricing Check
  → Burned amount >= current required price (dynamic based on % burned)
  → Prevents underpaying for activation

Layer 5: 1 Wallet = 1 Node (RocksDB persistent check)
  → check_wallet_registered_in_blocks() scans blockchain for existing NodeRegistration
  → Prevents duplicate registrations from same wallet (ANY node type)
  → Persistent across node restarts (not in-memory)
```

## **SECURITY ENHANCEMENTS**

### **1. Burn Transaction feePayer Verification (v4.7)**
Prevents using someone else's burn transaction:

```rust
// rpc.rs — verify_burn_transaction_exists()
// CRITICAL: Extract feePayer (signer) from Solana transaction
if let Some(fee_payer) = result_value["transaction"]["message"]["accountKeys"][0].as_str() {
    if fee_payer != wallet_address {
        println!("[SECURITY] Transaction feePayer ({}) does not match wallet_address ({})",
            fee_payer, wallet_address);
        return Ok(false);
    }
    println!("[INFO] Transaction feePayer verified: {}", fee_payer);
} else {
    println!("[ERROR] Could not determine transaction feePayer");
    return Ok(false);
}
```

### **2. Solana Address Derivation on Server (v4.7)**
For super node mnemonic ownership verification:

```rust
// crypto/solana_derivation.rs — derive_solana_address_from_mnemonic()
// BIP39 mnemonic -> BIP44 seed -> SLIP-10 derivation -> Ed25519 keypair -> base58 address
// Derivation path: m/44'/501'/0'/0' (standard Solana path, matches Phantom/Solflare)
pub fn derive_solana_address_from_mnemonic(mnemonic_phrase: &str) -> Result<String, String> {
    let mnemonic = Mnemonic::from_phrase(mnemonic_phrase, Language::English)?;
    let seed = mnemonic.to_seed("");
    // SLIP-10 hardened derivation for Ed25519
    let derived_key = slip10_derive_ed25519(&seed, &[44, 501, 0, 0])?;
    let public_key = PublicKey::from(&SecretKey::from_bytes(&derived_key)?);
    Ok(bs58::encode(public_key.as_bytes()).into_string())
}
```

### **3. Ed25519 Wallet Ownership Proof (v4.7)**
For light node registration from mobile:

```rust
// rpc.rs — handle_light_node_register()
// Verify Ed25519 signature proving ownership of burn_wallet (Solana key)
if let Some(sig_hex) = &request.ed25519_signature {
    let message = format!("qnet_register:{}:{}", request.node_id, timestamp);
    let sig_bytes = hex::decode(sig_hex)?;
    let pubkey_bytes = bs58::decode(&request.burn_wallet)?.into_vec();
    let signature = ed25519_dalek::Signature::from_bytes(&sig_bytes)?;
    let public_key = ed25519_dalek::PublicKey::from_bytes(&pubkey_bytes)?;
    public_key.verify(message.as_bytes(), &signature)?;
    // Signature valid — burn_wallet ownership confirmed
}
```

### **4. Automatic Node Replacement** 
Seamless server migration with quantum security:

```rust
// Automatic replacement on new activation
pub async fn register_activation_on_blockchain(
    &self, 
    code: &str, 
    node_info: NodeInfo
) -> Result<(), IntegrationError> {
    // Check for existing active node of same type
    self.check_and_replace_existing_node(&node_info).await?;
    
    // Register new node activation
    let record = ActivationRecord {
        wallet_address: node_info.wallet_address.clone(),
        node_type: node_info.node_type.clone(),
        is_active: true,
        // ... other fields
    };
    
    self.submit_activation_to_blockchain(record).await?;
    Ok(())
}
```

## Two-Phase Activation System

### Phase 1: 1DEV Token Burn on Solana (Years 0-5)

**Solana Contract Address (Devnet):**
- Contract: `CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw` (Anchor program)
- 1DEV Mint: `62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ`

**How Phase 1 Works:**
1. User burns 1DEV tokens on Solana blockchain (via mobile app or wallet extension)
2. Mobile app requests activation code from QNet genesis node, passing `burn_tx_hash`, `wallet_address` (Solana), `node_type`, `burn_amount`
3. Genesis node verifies burn via Solana RPC (`getTransaction`), checks `feePayer` matches wallet
4. Genesis node generates XOR-encrypted activation code bound to Solana wallet
5. User receives code + burn_tx_hash + burn_amount in mobile app
6. **For Light Nodes**: Mobile app registers directly via `/api/v1/light-node/register` with Ed25519 signature
7. **For Super Nodes**: User enters code + burn data + mnemonic into Docker container on server

**Universal Pricing (All Node Types):**
- Base: 1,500 1DEV -> 300 1DEV minimum (decreases as tokens burned, min at 80-90%)
- Every 10% burned reduces cost by 150 1DEV
- Same price for Light and Super nodes
- At 90% burned: Transition to Phase 2 (QNC activation)

**Phase 1 Solana Verification (Actual Implementation):**
```rust
// rpc.rs — verify_burn_transaction_exists()
pub async fn verify_burn_transaction_exists(
    burn_tx_hash: &str,
    wallet_address: &str,  // Solana address (burn_wallet)
    min_amount: u64,
) -> Result<bool, Box<dyn std::error::Error>> {
    // 1. Fetch transaction from Solana RPC (getTransaction)
    let result = solana_rpc_request("getTransaction", burn_tx_hash).await?;
    
    // 2. CRITICAL: Verify feePayer matches provided wallet
    let fee_payer = result["transaction"]["message"]["accountKeys"][0].as_str();
    if fee_payer != wallet_address { return Ok(false); }
    
    // 3. Verify burn amount >= minimum required
    let burn_amount = extract_burn_amount(&result)?;
    if burn_amount < min_amount { return Ok(false); }
    
    // 4. Verify transaction was successful
    if result["meta"]["err"].is_null() { Ok(true) } else { Ok(false) }
}
```

### Phase 2: QNC Pool 3 Transfer (After Transition)

**Transition Triggers:**
- 90% of 1DEV supply burned (900 million tokens)
- OR 5 years since genesis block
- Whichever comes first

**How Phase 2 Works:**
1. User TRANSFERS QNC tokens to Pool 3 (not burned!)
2. Native QNet smart contract processes activation
3. All transferred QNC redistributed equally to active nodes
4. Direct activation through QNet blockchain

**Dynamic Pricing by Node Type:**
- **Light**: 5,000-30,000 QNC (base: 10,000 x network multiplier)
- **Super**: 3,750-22,500 QNC (base: 7,500 x network multiplier)
NOTE: Full Node type removed in v3.18

**Network Size Multipliers:**
- 0-100K nodes: 0.5x (early network discount)
- 100K-300K nodes: 1.0x (standard rate)
- 300K-1M nodes: 2.0x (high demand)
- 1M+ nodes: 3.0x (mature network)

## Activation Flow Architecture

### Super Node — Docker Deployment (Production)

**Step 1: Obtain activation code via mobile app**
1. Install QNet mobile app, create/import wallet (12/24-word BIP39 mnemonic)
2. Purchase and burn 1DEV tokens (dynamic price based on burn %)
3. App automatically requests activation code from genesis node
4. App saves: activation code, burn TX hash, burn amount

**Step 2: Deploy Docker container on server**
```bash
# Build production image
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain && git checkout testnet
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# Configure firewall
sudo ufw allow 9876,9877,8001/tcp
sudo ufw allow 10876/udp
sudo ufw reload

# Launch super node (detached mode)
docker run -d --name qnet-super --restart=always \
  --log-opt max-size=200m --log-opt max-file=50 \
  -e QNET_PRODUCTION=1 \
  -e DOCKER_ENV=1 \
  -e QNET_WALLET_SEED="<SAME 12-WORD MNEMONIC AS IN MOBILE APP>" \
  -e QNET_ACTIVATION_CODE="QNET-SXXXXX-YYYYYY-ZZZZZZ" \
  -e QNET_BURN_TX_HASH="<SOLANA TX SIGNATURE FROM MOBILE APP>" \
  -e QNET_BURN_AMOUNT="1500" \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 -p 10876:10876/udp \
  -v $(pwd)/super_node_data:/app/data \
  qnet-production
```

**Environment variables explained:**

| Variable | Required | Description |
|----------|----------|-------------|
| `QNET_PRODUCTION` | Yes | Enable production security checks |
| `DOCKER_ENV` | Yes | Confirms running inside Docker |
| `QNET_WALLET_SEED` | Yes | BIP39 mnemonic (12 or 24 words) — MUST match mobile app wallet |
| `QNET_ACTIVATION_CODE` | Yes | Code from mobile app (format: `QNET-SXXXXX-YYYYYY-ZZZZZZ`) |
| `QNET_BURN_TX_HASH` | Yes | Solana burn transaction signature (from mobile app) |
| `QNET_BURN_AMOUNT` | Yes | Amount of 1DEV burned (must match exactly) |
| `QNET_AGGRESSIVE_PRUNING` | No | `0` = keep full history (default for super nodes) |
| `QNET_MAX_STORAGE_GB` | No | Maximum storage limit in GB |

**Startup verification flow (qnet-node.rs):**
```
1. QNET_BOOTSTRAP_ID set? → NO (not genesis)
2. QNET_ACTIVATION_CODE set? → YES
3. Read QNET_BURN_TX_HASH and QNET_BURN_AMOUNT from env
4. Return (NodeType::Super, code) to main()

5. save_activation_code():
   a) Derive Solana address from QNET_WALLET_SEED via BIP39+SLIP-10
   b) XOR-decrypt wallet prefix from code using SHA3(burn_tx:super:amount)
   c) Compare decrypted prefix with derived Solana address
   d) MATCH → activation proceeds
   e) MISMATCH → REJECT: "Code does not belong to this mnemonic"

6. verify_burn_transaction_exists():
   a) Fetch burn TX from Solana RPC
   b) Check feePayer == derived Solana address
   c) Check burn_amount >= dynamic price
   d) Any failure → REJECT registration

7. check_wallet_registered_in_blocks():
   a) Scan blockchain for existing NodeRegistration from this wallet
   b) If found → REJECT: "Wallet already has a registered node"

8. Register on-chain via NodeRegistration + NodeActivation TX with ML-DSA-65 signature
```

### Genesis Node — Docker Deployment (Bootstrap Only)

```bash
# Genesis Node (hardcoded bootstrap — no activation code needed)
docker run -d --name qnet-genesis-001 --restart=always \
  --log-opt max-size=200m --log-opt max-file=50 \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=001 \
  -e QNET_WALLET_SEED="<12-word mnemonic for this genesis node>" \
  -e DOCKER_ENV=1 \
  -e QNET_AGGRESSIVE_PRUNING=0 \
  -e QNET_MAX_STORAGE_GB=2000 \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 -p 10876:10876/udp \
  -v $(pwd)/genesis_001_data:/app/data \
  qnet-production
```

**Genesis-specific variables:**

| Variable | Description |
|----------|-------------|
| `QNET_BOOTSTRAP_ID` | Genesis node ID (`001`-`005`) — triggers auto-activation |
| `QNET_BENCHMARK_MODE` | Optional: enable benchmarking |
| `QNET_API_KEY_EXPLORER` | Optional: API key for explorer access (Node 005) |
| `QNET_API_KEY_ADMIN` | Optional: Admin API key (Node 005) |
| `QNET_WHITELIST_IPS` | Optional: IP whitelist for API access (Node 005) |

### Light Node — Mobile Activation Only

```
1. User opens QNet mobile app
2. Creates/imports wallet (BIP39 mnemonic)
3. Burns 1DEV tokens on Solana (dynamic price)
4. App requests activation code from genesis node
5. App saves code + burn_tx_hash + burn_amount
6. User taps "Activate Light Node"

7. Mobile app sends POST /api/v1/light-node/register:
   {
     node_id: "light_QNET-LXXXXX-...",
     wallet_address: "a3f8b2...eon...",     // EON address for rewards
     burn_wallet: "7Qx9vN3...",             // Solana address for verification
     burn_tx_hash: "7Ab9zKj3x...",          // Solana TX signature
     burn_amount: 1500,                     // Must match exactly
     ed25519_signature: "a1b2c3d4...",      // Signed with Solana private key
     signature_timestamp: 1739721600,       // Replay protection
     quantum_pubkey: "...",                 // ML-DSA-65 public key
     quantum_signature: "..."              // ML-DSA-65 registration signature
   }

8. Server verifies:
   a) XOR decrypt code → Solana wallet prefix matches burn_wallet
   b) Solana RPC: feePayer of burn_tx == burn_wallet
   c) Ed25519 signature valid for burn_wallet public key
   d) burn_amount >= current dynamic price
   e) No existing node for this wallet (RocksDB scan)
   f) ML-DSA-65 signature valid

9. Server creates NodeRegistration + NodeActivation on-chain TX
10. Light node registered, begins receiving rewards
```

## Data Storage Architecture

### Phase 1 Storage
- **RocksDB**: Persistent node registration data (`node_registrations` column family)
- **QNet Blockchain**: On-chain `NodeRegistration` and `NodeActivation` transactions
- **DashMap Cache**: In-memory `node_registration_cache` for O(1) lookups
- **P2P Registry**: In-memory `light_node_registry` synchronized via gossip

### Phase 2 Storage  
- **QNet Smart Contract**: Native activation records with cryptographic binding
- **Pool 3 Contract**: QNC redistribution tracking
- **Node Registry**: Real-time active node list with security metadata

## Implementation Files

### Phase 1 (1DEV Burn) - v4.7
- `development/qnet-integration/src/rpc.rs` — API endpoints: `handle_light_node_register`, `handle_register_node`, `verify_burn_transaction_exists`, `handle_generate_activation_code`
- `development/qnet-integration/src/node.rs` — `save_activation_code` (super node mnemonic verification)
- `development/qnet-integration/src/bin/qnet-node.rs` — `get_activation_with_auto_genesis` (startup flow, env var reading)
- `development/qnet-integration/src/crypto/solana_derivation.rs` — BIP39/SLIP-10/Ed25519 Solana address derivation
- `development/qnet-integration/src/crypto/quantum_crypto.rs` — XOR encryption/decryption, stateless verification
- `development/qnet-integration/src/activation_validation.rs` — Dynamic pricing, validation rules
- `development/qnet-integration/src/storage.rs` — RocksDB persistence for node registrations
- `applications/qnet-mobile/src/components/WalletManager.js` — Mobile activation, Ed25519 signing
- `applications/qnet-mobile/src/services/PushService.js` — `registerLightNode` API call

### Phase 2 (QNC Pool 3)
- `development/qnet-contracts/qnet-native/node_activation_qnc.py` — QNC contract
- `core/qnet-state/src/transaction.rs` — Pool 3 transactions
- `core/qnet-consensus/src/reward_integration.rs` — Pool 3 redistribution

## Node Type API Capabilities

### Super Nodes (Server Only)
- Full blockchain validation
- Complete REST API endpoints
- Consensus participation (microblock production + macroblock voting)
- Maximum reward distribution
- Priority transaction processing
- Advanced monitoring

### Light Nodes (Mobile Only)
- Basic blockchain sync
- Wallet functionality
- Transaction submission
- Direct node connections via `getRandomBootstrapNode()`
- `PhaseAwareRewardManager` integration for rewards
- `LightNodeDevice` registration with `quantum_pubkey`
- NO API server
- NO public endpoints  
- NO metrics endpoints
- **STRICTLY BLOCKED on servers** — Code-level enforcement

## Security Architecture

### **Multi-Layer Security (v4.7)**

#### **Quantum Resistance**
- **Consensus Signatures**: ML-DSA-65 (NIST FIPS 204) — 3309-byte signatures
- **P2P Message Signatures**: pure ML-DSA-65 — the ephemeral Ed25519 leg was removed; the Dilithium key signature is the sole authenticator (certificate binding)
- **Hash Functions**: SHA3-256 (NIST FIPS 202) for all derivations
- **Key Storage**: AES-256-GCM encrypted ML-DSA-65 keypairs
- **P2P Key Exchange**: ML-KEM-768 (Kyber) active in QUIC TLS 1.3 hybrid handshake (X25519Kyber768Draft00, v4.8)

#### **Anti-Fraud Mechanisms**
- **1 Wallet = 1 Node**: Enforced via persistent RocksDB scan (any node type)
- **Wallet Binding**: XOR encryption + feePayer check + Ed25519/mnemonic verification
- **Code Theft Prevention**: Stolen code useless without matching Solana private key
- **XOR Brute-Force Prevention**: Dynamic burn amount is part of key material
- **Race Condition Prevention**: Solana RPC verification is mandatory (no bypass on error)

#### **Attack Surface Minimization**
- **Device Restrictions**: Light nodes physically cannot run on servers
- **Stateless Verification**: No in-memory registry needed for code validation
- **Solana RPC Mandatory**: Registration rejected if Solana RPC unavailable
- **Temporal Validation**: Timestamp-based replay attack prevention

### Phase 1 Security
- **feePayer Verification**: Burn TX signer must match registering wallet
- **Ed25519 Ownership Proof**: Light node registration requires Solana key signature
- **Mnemonic Derivation Proof**: Super node registration derives Solana address from seed
- **Dynamic Pricing Enforcement**: Burned amount must meet current price requirement
- **1 Wallet = 1 Node**: Persistent blockchain scan prevents duplicates
- **Solana RPC Error = Rejection**: No fallback if Solana verification fails

### Phase 2 Security  
- **QNC Pool 3 Verification**: Smart contract validation with quantum signatures
- **Node Type Enforcement**: Activation codes tied to node types via prefix (L/S)
- **Network Size Validation**: Dynamic pricing enforcement 
- **Redistribution Auditing**: Transparent Pool 3 distribution

## Automatic Node Replacement System

### **Node Transfer**
QNet implements automatic node replacement when activating on a new server:

```rust
pub async fn check_and_replace_existing_node(
    &self,
    new_node_info: &NodeInfo
) -> Result<(), IntegrationError> {
    // Check blockchain for existing active node of same wallet+type
    let active_nodes = self.active_nodes.read().await;
    
    for (device_sig, existing_node) in active_nodes.iter() {
        if existing_node.wallet_address == new_node_info.wallet_address 
            && existing_node.node_type == new_node_info.node_type {
            
            // Send shutdown signal to previous node
            self.send_blockchain_shutdown_signal(existing_node).await?;
            
            // Mark as replaced in blockchain immediately
            self.mark_node_replaced_in_blockchain(existing_node).await?;
            
            break;
        }
    }
    
    Ok(())
}
```

### **Super Node Server Migration (v4.9)**

User super nodes support **seamless server migration** — same activation code on a new server, old server shuts down automatically.

**Migration Flow:**
1. User starts Docker container on **new server** with same `QNET_ACTIVATION_CODE`, `QNET_BURN_TX_HASH`, `QNET_BURN_AMOUNT`, `QNET_WALLET_SEED`
2. New server calls `save_activation_code` → XOR + mnemonic verification passes (same wallet)
3. New server POSTs `device_id` to genesis node via `POST /api/v1/register-device`
4. Genesis node stores new `device_id` in RocksDB (`device_{node_id}` key)
5. `handle_register_node` on genesis detects existing node_id → `is_migration = true`
6. **No duplicate on-chain TX** — existing `NodeRegistration` preserved, reputation preserved
7. Old server polls `GET /api/v1/node-device?node_id=...` every 30 seconds
8. Old server sees `device_id ≠ my_device_id` → **graceful shutdown** (QUIC stop, clear activation, `exit(0)`)

**Rate Limiting:** Max 1 migration per 24 hours per wallet (`SUPER_NODE_MIGRATION_TIMESTAMPS` DashMap)

**Genesis Nodes Excluded:** Genesis nodes use `QNET_BOOTSTRAP_ID` + IP-based authentication. Migration system does **not** apply to genesis nodes.

### **Light Node Device Management**
- Up to **3 mobile devices** per Light node (round-robin attestation)
- Managed via `handle_light_node_register` with `LightNodeDevice` slots
- No server migration concept — Light nodes are mobile-only

### **Automatic Replacement Features**
- **1 Wallet = 1 Active Node**: Only one node (any type) per wallet — enforced via RocksDB reverse index
- **Persistent Device Tracking**: `device_id` stored in RocksDB on genesis nodes (survives restarts)
- **Graceful Shutdown**: Old server detects migration via HTTP polling → stops QUIC → clears activation → exits
- **Zero Manual Migration**: Start same Docker command on new server → old shuts down automatically
- **Scalable**: O(1) device_id lookup via RocksDB key

### **Node Replacement Scenarios**
1. **Server Migration**: Start same Docker on new server → old automatically shuts down within 30 seconds
2. **Hardware Upgrade**: New server activation → seamless replacement with reputation preserved
3. **Recovery**: Lost server access → reactivate on new hardware with same mnemonic + activation code

### **Security & Limitations**
- **Wallet Binding**: Node activations permanently bound to wallet addresses
- **No Wallet Transfer**: Prevents activation code trading
- **ML-DSA-65 Signatures**: All blockchain transactions use ML-DSA-65
- **Blockchain Authority**: Blockchain records are source of truth for active nodes
- **Rate Limiting**: 1 migration per 24 hours prevents abuse

## Activation Methods Summary

| Method | Node Type | Environment Variables |
|--------|-----------|----------------------|
| **Genesis (auto)** | Super | `QNET_BOOTSTRAP_ID` + `QNET_WALLET_SEED` |
| **Docker detached** | Super | `QNET_ACTIVATION_CODE` + `QNET_BURN_TX_HASH` + `QNET_BURN_AMOUNT` + `QNET_WALLET_SEED` |
| **Mobile app** | Light | Via API call with Ed25519 signature |

**NOTE**: Node type is determined from activation code prefix (`QNET-S` = Super, `QNET-L` = Light). No separate `QNET_NODE_TYPE` variable needed.

## Benefits of Two-Phase Architecture

### Phase 1 Benefits
- **Simple Integration**: Direct Solana burn tracking
- **Universal Pricing**: Same cost for all node types  
- **Proven Technology**: Solana blockchain reliability
- **External Funding**: No QNet token required
- **Stateless Verification**: XOR-based, no in-memory state needed

### Phase 2 Benefits
- **Native Integration**: QNet blockchain control
- **Fair Redistribution**: Pool 3 rewards all nodes
- **Dynamic Pricing**: Node type differentiation
- **Network Growth**: Existing nodes benefit from new activations

## Monitoring and Statistics

### Real-Time Metrics
- **Burn Progress**: 1DEV tokens burned percentage
- **Network Size**: Active nodes by type and region
- **Pool 3 Balance**: QNC available for redistribution
- **Activation Rate**: New nodes per day
- **Node replacement statistics and blockchain coordination metrics**
- **Security event monitoring (failed activations, blocked attempts)**

### Security Monitoring
- **Failed Activations**: Track attempted Light node server activations
- **feePayer Mismatches**: Monitor Solana wallet verification failures
- **Ed25519 Signature Failures**: Track wallet ownership proof failures
- **Mnemonic Derivation Mismatches**: Track super node mnemonic verification failures
- **Duplicate Wallet Attempts**: Track 1-wallet-1-node enforcement

### Phase Transition Monitoring
- **Burn Threshold**: Monitor 90% burn progress
- **Time Threshold**: Track 5-year countdown
- **Transition Readiness**: QNC contract deployment status

## **SECURITY COMPLIANCE**

### **Quantum Readiness**  
- ML-DSA-65 (NIST FIPS 204) for all on-chain signatures
- SHA3-256 (NIST FIPS 202) for all hash operations
- AES-256-GCM (NIST FIPS 197) for key storage encryption
- Pure ML-DSA-65 for P2P message authentication (ephemeral Ed25519 leg removed)
- ML-KEM-768 (Kyber) active for P2P key exchange via QUIC TLS 1.3 hybrid handshake (X25519Kyber768Draft00)

### **Anti-Fraud Measures**
- Wallet ownership cryptographically verified (Ed25519 + mnemonic derivation)
- feePayer verification prevents stolen burn TX usage
- 1 wallet = 1 node enforced via persistent blockchain scan
- Light node server blocking (code-level `std::process::exit(1)`)
- Dynamic pricing verified at registration time

### **Production Security**
- Stateless activation code verification (no in-memory registries)
- Solana RPC errors cause registration rejection (no bypass)
- ML-DSA-65 signatures on all blockchain transactions
- Comprehensive audit trails via structured logging

**PRODUCTION-READY WITH v4.7 SECURITY ARCHITECTURE**
