# Solana Integration Guide for QNet

## Overview

This guide explains how QNet integrates with 1DEV token burn on Solana for node activation (Phase 1).

## Architecture (v4.7)

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│                 │         │                  │         │                 │
│  Mobile App     │────────▶│  Solana          │────────▶│  QNet Genesis   │
│  (QNet Wallet)  │  Burn   │  Blockchain      │  Verify │  Node (Rust)    │
│                 │  1DEV   │  (SPL Token)     │  feePay │                 │
└─────────────────┘         └──────────────────┘         └─────────────────┘
        │                                                        │
        │  Request activation code                               │
        │───────────────────────────────────────────────────────▶│
        │                                                        │
        │  Return XOR-encrypted code                             │
        │◀───────────────────────────────────────────────────────│
        │                                                        │
        ▼                                                        │
┌─────────────────┐                                              │
│  Light Node:    │  POST /api/v1/light-node/register            │
│  Register via   │─────────────────────────────────────────────▶│
│  mobile API     │  (Ed25519 sig + Dilithium3 sig)              │
└─────────────────┘                                              │
                                                                 │
┌─────────────────┐                                              │
│  Super Node:    │  Docker env vars:                            │
│  Deploy via     │  QNET_ACTIVATION_CODE + QNET_BURN_TX_HASH   │
│  Docker         │  + QNET_BURN_AMOUNT + QNET_WALLET_SEED      │
└─────────────────┘                                              │
```

## Node Activation Flow

### 1. User Burns 1DEV (Solana)
```javascript
// Mobile app burns 1DEV tokens on Solana
// The burn transaction is a standard SPL token transfer to the incinerator address
const burnTx = await sendSolanaTransaction({
    from: userWallet.publicKey,        // Solana Ed25519 public key (feePayer)
    to: "1nc1nerator11111111111111111111111111111111",  // Solana burn address
    amount: dynamicBurnAmount,          // Dynamic price based on % burned (1500-300 1DEV)
    mint: "4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump", // 1DEV SPL token mint
});

// Result: burnTxSignature = "5Kj3xYmN7..." (Solana TX signature)
```

### 2. Request Activation Code from Genesis Node
```javascript
// Mobile app requests activation code from QNet genesis node
const response = await fetch("http://genesis-node:8001/api/v1/generate-activation-code", {
    method: "POST",
    body: JSON.stringify({
        wallet_address: solanaPublicKey,  // Solana address (for XOR encryption)
        burn_tx_hash: burnTxSignature,    // Solana TX signature
        burn_amount: dynamicBurnAmount,   // Exact amount burned
        node_type: "light" | "super",     // Desired node type
    })
});

// Genesis node verifies:
// 1. Fetch burn TX from Solana RPC (getTransaction)
// 2. Check feePayer == wallet_address
// 3. Check burn_amount >= dynamic price
// 4. Generate XOR-encrypted code: XOR(wallet[:5], SHA3(burn_tx:type:amount))
// 5. Return: { activation_code: "QNET-SXXXXX-YYYYYY-ZZZZZZ" }
```

### 3. QNet Node Verification (Actual Implementation)
```rust
// rpc.rs — verify_burn_transaction_exists()
pub async fn verify_burn_transaction_exists(
    burn_tx_hash: &str,
    wallet_address: &str,  // Solana address (burn_wallet)
    min_amount: u64,
) -> Result<bool, Box<dyn std::error::Error>> {
    // 1. Fetch transaction from Solana RPC
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [burn_tx_hash, {"encoding": "json", "maxSupportedTransactionVersion": 0}]
    });
    let result = solana_rpc_call(body).await?;

    // 2. CRITICAL v4.7: Verify feePayer (signer) matches wallet_address
    let fee_payer = result["transaction"]["message"]["accountKeys"][0].as_str();
    if fee_payer != Some(wallet_address) {
        return Ok(false); // Reject: TX was not signed by this wallet
    }

    // 3. Verify burn amount >= minimum required
    // Extract from transaction instructions/logs
    let burn_amount = extract_burn_amount_from_tx(&result)?;
    if burn_amount < min_amount {
        return Ok(false); // Reject: insufficient burn
    }

    // 4. Verify TX was successful (no errors)
    Ok(result["meta"]["err"].is_null())
}
```

## Integration Steps

### Super Node Deployment (Docker)
```bash
# All configuration via environment variables — no config files needed
docker run -d --name qnet-super --restart=always \
  --log-opt max-size=200m --log-opt max-file=50 \
  -e QNET_PRODUCTION=1 \
  -e DOCKER_ENV=1 \
  -e QNET_WALLET_SEED="your twelve word mnemonic phrase here" \
  -e QNET_ACTIVATION_CODE="QNET-SXXXXX-YYYYYY-ZZZZZZ" \
  -e QNET_BURN_TX_HASH="your_solana_burn_transaction_signature" \
  -e QNET_BURN_AMOUNT="1500" \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 -p 10876:10876/udp \
  -v $(pwd)/super_node_data:/app/data \
  qnet-production
```

### Light Node Registration (Mobile API)
```javascript
// Mobile app sends registration with Ed25519 + Dilithium3 signatures
const response = await fetch("http://genesis-node:8001/api/v1/light-node/register", {
    method: "POST",
    body: JSON.stringify({
        node_id: activationCode,
        wallet_address: eonAddress,      // QNet EON address for rewards
        burn_wallet: solanaAddress,       // Solana address for verification
        burn_tx_hash: burnTxHash,
        burn_amount: burnAmount,
        ed25519_signature: signature,     // Solana private key signature
        signature_timestamp: timestamp,
        quantum_pubkey: dilithiumPubkey,
        quantum_signature: dilithiumSig,
    })
});
```

## Monitoring and Analytics

### Query Burn Progress
```bash
# Check burn status via QNet node API
curl http://localhost:8001/api/v1/burn-status
# Returns: { total_burned, burn_percentage, current_price, transition_completed }
```

### Dynamic Pricing
```
Dynamic 1DEV burn pricing (Phase 1):
├── 0-10% burned:  1,500 1DEV
├── 10-20% burned: 1,350 1DEV (-10%)
├── 20-30% burned: 1,200 1DEV (-20%)
├── 30-40% burned: 1,050 1DEV (-30%)
├── 40-50% burned:   900 1DEV (-40%)
├── 50-60% burned:   750 1DEV (-50%)
├── 60-70% burned:   600 1DEV (-60%)
├── 70-80% burned:   450 1DEV (-70%)
├── 80-90% burned:   300 1DEV (-80%, minimum)
└── 90%+ burned:   Transition to Phase 2 (QNC)
```

## Post-Transition Migration

After 90% burn or 5 years, the system transitions to Phase 2:
- New activations use QNC tokens (transferred to Pool 3, not burned)
- Existing nodes maintain their status automatically
- No manual migration required for active nodes

## Security Considerations (v4.7)

1. **Multi-Layer Wallet Verification**
   - XOR decryption: code is cryptographically bound to Solana address
   - feePayer check: burn TX signer must match registering wallet
   - Ed25519 signature: light nodes prove Solana private key ownership
   - Mnemonic derivation: super nodes derive Solana address from seed

2. **1 Wallet = 1 Node**
   - Enforced via persistent RocksDB blockchain scan
   - Prevents duplicate registrations (any node type)
   - Survives node restarts

3. **Solana RPC Reliability**
   - Multiple Solana RPC endpoints supported
   - Registration REJECTED if Solana RPC unavailable (no bypass)
   - Burn data cached locally after verification

4. **Anti-Theft Protection**
   - Stolen activation code useless without matching Solana private key
   - XOR brute-force prevented by dynamic burn_amount in key material
   - feePayer verification prevents using another user's burn TX

## Contract Addresses

```
[Solana Devnet]
burn_contract = "CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw"
1dev_mint     = "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ"
burn_address  = "1nc1nerator11111111111111111111111111111111"

[Solana Mainnet]
1dev_mint     = "4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump"
```

## Testing

### Devnet Testing
```bash
# Switch to devnet
solana config set --url devnet

# Airdrop SOL for gas
solana airdrop 2

# Test burn and verify via QNet node API
```

## Support

- Documentation: https://docs.qnet.network
- Discord: https://discord.gg/qnet
- GitHub: https://github.com/AIQnetLab/QNet-Blockchain
