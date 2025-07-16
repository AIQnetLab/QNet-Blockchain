# QNet Node Activation Architecture - Two-Phase System

## Overview
QNet uses a two-phase activation system transitioning from 1DEV burn on Solana to QNC Pool 3 transfers on QNet.

## **CRITICAL DEVICE RESTRICTIONS**

### Server Deployment (Interactive Menu ONLY)
- **Full Nodes**: ✅ Can be activated on servers via interactive menu
- **Super Nodes**: ✅ Can be activated on servers via interactive menu  
- **Light Nodes**: ❌ CANNOT be activated on servers

### Mobile Device Deployment
- **Light Nodes**: ✅ Can ONLY be activated on mobile devices
- **Full Nodes**: ❌ Cannot be activated on mobile devices
- **Super Nodes**: ❌ Cannot be activated on mobile devices

## Two-Phase Activation System

### Phase 1: 1DEV Token Burn on Solana (Years 0-5)

**Solana Contract Address (Devnet):**
- Contract: `QNETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (Anchor program)
- 1DEV Mint: `1DEVxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

**How Phase 1 Works:**
1. User burns 1DEV tokens on Solana blockchain
2. Solana contract creates PDA (Program Derived Address) activation record
3. QNet monitors Solana for burn transactions
4. User receives activation code from wallet/mobile app
5. Interactive activation on servers OR mobile activation for Light nodes

**Universal Pricing (All Node Types):**
- Base: 1,500 1DEV → 150 1DEV (decreases as tokens burned)
- Every 10% burned reduces cost by 150 1DEV
- Same price for Light/Full/Super nodes

**Phase 1 Solana Integration:**
```rust
// Solana burn verification
pub async fn verify_solana_burn(
    burn_tx: &str,
    node_pubkey: &PublicKey,
) -> Result<BurnRecord, SolanaError> {
    // Verify burn transaction on Solana
    let burn_record = fetch_burn_record_from_solana(burn_tx).await?;
    
    // Validate PDA account
    let pda_seeds = &[
        NODE_ACTIVATION_SEED,
        node_pubkey.as_ref(),
    ];
    let (pda, _bump) = Pubkey::find_program_address(pda_seeds, &PROGRAM_ID);
    
    // Verify activation record
    let activation_record = fetch_activation_record(&pda).await?;
    
    Ok(burn_record)
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
- **Light**: 2,500-15,000 QNC (base: 5,000 × network multiplier)
- **Full**: 3,750-22,500 QNC (base: 7,500 × network multiplier)
- **Super**: 5,000-30,000 QNC (base: 10,000 × network multiplier)

**Network Size Multipliers:**
- 0-100K nodes: 0.5x (early network discount)
- 100K-1M nodes: 1.0x (standard rate)
- 1M-10M nodes: 2.0x (high demand)
- 10M+ nodes: 3.0x (mature network)

## Activation Flow Architecture

### Interactive Server Activation (Full/Super Nodes)
```bash
# Server activation process
cd development/qnet-integration
./target/release/qnet-node

# Interactive prompts:
# 1. Economic phase detection (1 or 2)
# 2. Activation code input: QNET-XXXX-XXXX-XXXX
# 3. Node type validation (Full/Super only)
# 4. Region auto-detection
# 5. Port configuration
# 6. Blockchain sync initiation
# 7. API server launch (Full/Super only)
```

### Mobile Activation (Light Nodes Only)
```javascript
// Mobile app activation
const activationResult = await QNetMobile.activateNode({
    nodeType: 'Light',
    phase: currentPhase,
    activationCode: 'QNET-LXXX-XXXX-XXXX',
    deviceSignature: getDeviceSignature(),
    walletAddress: wallet.address
});

// Result: Light node activated with no API server
```

## Data Storage Architecture

### Phase 1 Storage
- **Solana PDA**: Activation records on Solana blockchain
- **QNet Blockchain**: Mirrored activation transactions
- **DHT Network**: Distributed node registry

### Phase 2 Storage  
- **QNet Smart Contract**: Native activation records
- **Pool 3 Contract**: QNC redistribution tracking
- **Node Registry**: Real-time active node list

## Implementation Files

### Phase 1 (1DEV Burn)
- `development/qnet-contracts/1dev-burn-contract/` - Solana burn contract
- `applications/qnet-wallet/src/integration/SolanaIntegration.js` - Browser wallet
- `applications/qnet-mobile/src/screens/ActivationScreen.jsx` - Mobile activation
- `infrastructure/qnet-node/src/economics/onedev_phase_handler.py` - QNet handler

### Phase 2 (QNC Pool 3)
- `development/qnet-contracts/qnet-native/node_activation_qnc.py` - QNC contract
- `core/qnet-state/src/transaction.rs` - Pool 3 transactions
- `core/qnet-consensus/src/reward_integration.rs` - Pool 3 redistribution

### Activation Validation
- `development/qnet-integration/src/activation_validation.rs` - Code validation
- `development/qnet-integration/src/bin/qnet-node.rs` - Interactive setup
- `applications/qnet-mobile/src/services/BridgeService.js` - Mobile bridge

## Node Type API Capabilities

### Full Nodes (Server Only)
- ✅ Full blockchain validation
- ✅ Complete REST API endpoints
- ✅ JSON-RPC server
- ✅ Microblock production
- ✅ P2P networking
- ✅ Prometheus metrics

### Super Nodes (Server Only)
- ✅ All Full node capabilities
- ✅ Enhanced validation
- ✅ Maximum reward distribution
- ✅ Priority transaction processing
- ✅ Advanced monitoring

### Light Nodes (Mobile Only)
- ✅ Basic blockchain sync
- ✅ Wallet functionality
- ✅ Transaction submission
- ❌ NO API server
- ❌ NO public endpoints
- ❌ NO metrics endpoints

## Security Architecture

### Phase 1 Security
- **Solana Burn Verification**: Real-time transaction validation
- **PDA Account Validation**: Cryptographic proof of burn
- **One-Time Use**: Each burn transaction used only once
- **Device Limits**: Maximum 3 Light nodes per wallet

### Phase 2 Security
- **QNC Pool 3 Verification**: Smart contract validation
- **Node Type Enforcement**: Activation codes tied to node types
- **Network Size Validation**: Dynamic pricing enforcement
- **Redistribution Auditing**: Transparent Pool 3 distribution

## Device Migration Support

### Same Wallet, Different Device
```rust
pub async fn migrate_device(
    &self,
    activation_code: &str,
    new_device_signature: &str,
    wallet_signature: &str,
) -> Result<(), MigrationError> {
    // Verify wallet ownership
    self.verify_wallet_ownership(activation_code, wallet_signature).await?;
    
    // Update device signature
    self.update_device_signature(activation_code, new_device_signature).await?;
    
    // Maintain node activation
    Ok(())
}
```

### Transfer Between Wallets (Not Supported)
- Node activations are permanently bound to wallet addresses
- No transfer mechanism available
- Prevents activation code trading

## Alternative Activation Methods

### CLI Activation (Servers)
```bash
# Direct server activation
qnet-node --activation-code QNET-XXXX-XXXX-XXXX --node-type full
```

### Environment Variables (Production)
```bash
# Production deployment
export QNET_ACTIVATION_CODE=QNET-XXXX-XXXX-XXXX
export QNET_NODE_TYPE=full
./target/release/qnet-node
```

### Mobile App (Light Nodes)
```javascript
// Mobile-only activation
const result = await QNetMobile.activateNode({
    nodeType: 'Light',
    phase: getCurrentPhase(),
    activationCode: userCode
});
```

## Benefits of Two-Phase Architecture

### Phase 1 Benefits
- **Simple Integration**: Direct Solana burn tracking
- **Universal Pricing**: Same cost for all node types
- **Proven Technology**: Solana blockchain reliability
- **External Funding**: No QNet token required

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

### Phase Transition Monitoring
- **Burn Threshold**: Monitor 90% burn progress
- **Time Threshold**: Track 5-year countdown
- **Transition Readiness**: QNC contract deployment status
- **Migration Stats**: Phase 1 to Phase 2 transitions

**⚠️ EXPERIMENTAL SOFTWARE - USE AT YOUR OWN RISK ⚠️** 