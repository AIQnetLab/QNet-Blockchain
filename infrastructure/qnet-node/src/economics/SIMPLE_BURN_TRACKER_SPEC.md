# Simple Burn Tracker Specification

## Overview

The Solana smart contract is a **simple burn counter** that tracks QNA burns.
No business logic, no pricing, no node types - just counting.

## Contract Purpose

```
Solana Contract = Burn Counter
QNet Blockchain = All Business Logic
```

## What It Does

✅ **Tracks total QNA burned**
✅ **Records burn transactions**
✅ **Provides burn statistics**

## What It Does NOT Do

❌ **No pricing logic**
❌ **No node types**
❌ **No activation logic**
❌ **No transition rules**
❌ **No whitelist/discounts**

## Contract Interface

```rust
// Initialize tracker
initialize(burn_address: Pubkey)

// Record a burn
record_burn(amount: u64, tx_signature: String)

// Get statistics
get_burn_stats() -> BurnStats {
    total_burned: u64,
    burn_percentage: f64,
    days_since_launch: u64,
    total_transactions: u64
}
```

## Usage

1. User burns QNA tokens on Solana
2. Contract records the burn with `record_burn()`
3. Anyone can query statistics with `get_burn_stats()`
4. Total burned amount is publicly verifiable

## Benefits

- **Simple** - Easy to audit and verify
- **Immutable** - No complex logic to change
- **Transparent** - All burns are recorded on-chain
- **Secure** - Minimal attack surface 