# QNet Smart Contracts

## Overview

This directory contains smart contracts for the QNet ecosystem:

1. **1DEV Token Contract (Solana)** - Token burning and node activation
2. **QNet Core Contracts (Native)** - Main blockchain functionality

## 1DEV Token Contract (Solana)

### Purpose
- Manage 1DEV token burning for node activation
- Track burn progress and pricing
- Store node activation records in PDA accounts
- Handle transition to QNC after 90% burn or 5 years

### Key Features
- Dynamic pricing based on burn percentage
- Burn tracking and statistics
- Node activation records via PDA accounts
- Time-based transition mechanism
- Integration with QNet for node verification

### Contract Structure
```
1dev-burn-contract/
├── src/
│   ├── lib.rs              # Main contract logic
│   ├── state.rs            # Contract state definitions
│   ├── instructions/       # Contract instructions
│   │   ├── initialize.rs   # Initialize contract
│   │   ├── burn_for_node.rs # Burn 1DEV for node activation
│   │   ├── update_price.rs  # Update pricing oracle
│   │   └── check_transition.rs # Check if transition needed
│   └── errors.rs           # Custom error types
├── Cargo.toml
└── README.md
```

## Node Activation Process

1. User calls `burn_for_node` with desired node type
2. Contract calculates required 1DEV amount based on current burn %
3. 1DEV tokens are burned from user's account
4. PDA account is created to store activation record
5. User receives activation confirmation (can query PDA)
6. QNet node software verifies activation via PDA

## Development Setup

### Prerequisites
- Rust 1.70+
- Solana CLI 1.17+
- Anchor Framework 0.29+

### Installation
```bash
# Install Solana
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Install Anchor
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked

# Build contracts
cd 1dev-burn-contract
anchor build
```

### Testing
```bash
# Run tests
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

## Contract Addresses

### Mainnet
- 1DEV Burn Contract: `TBD`

### Devnet
- 1DEV Burn Contract: `TBD` 