# QNA Burn Tracker Contract

## Overview

Simple Solana smart contract that tracks QNA token burns. This contract ONLY tracks burn statistics and does NOT handle any business logic.

## Key Features

- **Simple Burn Tracking**: Records amount burned and transaction details
- **No Business Logic**: No node types, pricing, or activation logic
- **Immutable Records**: Each burn creates permanent record on-chain
- **Statistics API**: Query total burned, percentage, and transaction count

## Architecture

```
User burns QNA → Contract records burn → Statistics available on-chain
```

## Contract Functions

### initialize
- Sets up burn tracker with authority and burn address
- Called once during deployment

### record_burn
- Records a burn transaction
- Updates total burned amount
- Creates immutable burn record

### get_burn_stats
- Returns current burn statistics
- Total burned, percentage, days since launch

## Data Structures

### BurnTracker
- Main state tracking total burns
- Authority, burn address, statistics

### BurnRecord
- Individual burn transaction record
- Amount, burner, timestamp, tx signature

## Usage

This contract is a simple, immutable burn counter. All business logic (node types, pricing, activation) should be handled separately.

## Deployment

```bash
anchor build
anchor deploy
```

## Testing

```bash
anchor test
``` 