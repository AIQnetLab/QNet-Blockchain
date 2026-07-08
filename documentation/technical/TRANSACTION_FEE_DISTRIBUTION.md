# QNet Transaction Fee Distribution System (v3.18+)

## Overview

QNet v3.18 implements a **direct fee crediting model** where transaction fees go directly to the block producer (Super node). This simplified approach eliminates pooled distribution complexity and provides immediate rewards.

## Node Types (v3.18)

### 1. Light Nodes
- **Transaction fee share**: 0%
- **Role**: Mobile clients, transaction submission
- **Requirements**: Minimal resources
- **Rewards**: Pool 1 (base emission) only

### 2. Super Nodes
- **Transaction fee share**: 100% of block fees
- **Role**: Block production, full validation, API endpoints
- **Requirements**: High-performance hardware, guaranteed uptime
- **Rewards**: Pool 1 + direct transaction fees from produced blocks

> **Note**: Full Nodes were removed in v3.18. The network operates with a two-tier architecture: Light (mobile) and Super (server/validator) nodes.

## Distribution Mechanism (v3.18)

### Direct Producer Crediting
- Transaction fees are calculated during block production
- Fees are credited **immediately** to the block producer's wallet
- No pooled accumulation or delayed distribution

### Fee Calculation
```
Block_Fees = Sum of (effective_gas_price × gas_limit) for all transactions

Where:
- effective_gas_price = gas_price × 1.5 for ML-DSA-65 (Dilithium3, quantum) signatures
- effective_gas_price = gas_price for any non-quantum-signed (legacy/unsigned) transaction
```

> Note: QNet transactions are signed with pure ML-DSA-65 (Dilithium3); the base
> (non-multiplied) tier is a fallback for legacy/unsigned transactions, not a
> classical-signature path.

### Fee Flow
```
1. User submits transaction with gas_price and gas_limit
2. Transaction included in block by Super node producer
3. fees_collected = sum of all transaction fees in block
4. fees_collected credited directly to producer's registered wallet
5. Validators verify fees_collected matches transaction sum
```

## Implementation Details

### MicroBlock Structure
```rust
pub struct MicroBlock {
    pub height: u64,
    pub producer_id: String,
    pub transactions: Vec<Transaction>,
    pub fees_collected: u64,  // Total fees for this block
    // ... other fields
}
```

### Fee Crediting (StateManager)
```rust
pub fn credit_producer_fees(&self, producer_wallet: &str, fees: u64) {
    if fees == 0 { return; }
    
    let mut accounts = self.accounts.write();
    let account = accounts.entry(producer_wallet.to_string())
        .or_insert_with(Account::default);
    account.balance = account.balance.saturating_add(fees);
    
    log::info!("[FEE] Credited {} nanoQNC to producer {}", fees, producer_wallet);
}
```

### Idempotency Protection
```rust
// Only credit fees for new blocks (not during re-sync)
let block_is_new = self.storage.load_microblock(height).is_err();
if block_is_new {
    state.credit_producer_fees(&producer_wallet, fees_collected);
}
```

## Node Eligibility Requirements

### Super Nodes must maintain:
- popcount(on-chain Heartbeat bitmask) ≥ 9 of 10 per 4-hour window (90%, v34: unforgeable on-chain heartbeats; self-reported HBC count no longer trusted)
- Reputation score ≥ 70%
- Full archival blockchain data
- Public API endpoints
- Block production capability

### Light Nodes:
- 1+ valid attestation per 4-hour window (pinged by Genesis nodes)
- Reputation fixed at 70 (immutable)
- Receive Pool 1 only (0% of transaction fees)

## Benefits of Direct Fee Crediting (v3.18)

1. **Immediate Rewards**: Producers receive fees instantly upon block finalization
2. **Simplicity**: No complex pool management or delayed distribution
3. **Transparency**: fees_collected is visible in each block
4. **Incentive Alignment**: Producers motivated to include high-fee transactions
5. **No Trust Required**: Fees are verifiable from on-chain data

## Economic Impact

### Projected Super Node Earnings
Based on network activity:
- **Block Production Fees**: Variable, depends on transaction volume
- **Pool 1 (Base Emission)**: According to halving schedule
- **Total**: Competitive with top L1 blockchains

### Fee Estimation
```
Average transaction fee: 0.00001 QNC (10,000 nanoQNC)
100 TPS × 0.00001 QNC × 86,400 seconds = 86.4 QNC/day in fees
Distributed among ~100 active Super nodes producing blocks
```

## Migration from Pool 2 (v3.17 → v3.18)

### Removed Components
- `Pool2` accumulator and distribution logic
- 4-hour batched distribution cycles
- Full Node type entirely (v3.18)

### New Components
- `fees_collected` field in MicroBlock
- `credit_producer_fees()` method in StateManager
- Direct crediting during block finalization
- Idempotency checks for re-sync safety

## Technical Security

### Deterministic Verification
All validators independently calculate expected fees:
```rust
let expected_fees: u64 = block.transactions.iter()
    .map(|tx| tx.effective_gas_price().saturating_mul(tx.gas_limit))
    .sum();

assert_eq!(block.fees_collected, expected_fees);
```

### No Double-Crediting
- Fees only credited for NEW blocks (height check)
- Re-synced blocks skip fee crediting
- Block hash verification ensures integrity

This system ensures fair compensation for block producers while maintaining simplicity and immediate settlement, aligned with modern L1 blockchain best practices.
