# 1DEV Burn Tracker Contract

## Purpose

Simple Solana smart contract that tracks 1DEV token burns. This contract ONLY tracks burn statistics and does NOT handle any business logic.

## Key Features

- **Burn Tracking**: Monitors 1DEV token burns to dead address
- **Statistics**: Provides burn progress and pricing data
- **Security**: Read-only data, no financial operations
- **Lightweight**: Minimal Solana program size

## Architecture

```
User burns 1DEV → Contract records burn → Statistics available on-chain
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