# Two-Phase Node Activation Architecture

## Overview

QNet uses a two-phase system for node activation that transitions from external token burns (1DEV on Solana) to native token burns (QNC on QNet).

## Phase 1: 1DEV Burns on Solana (Years 0-5)

### How it works:
1. Users burn 1DEV tokens on Solana blockchain
2. QNet monitors Solana for burn transactions
3. QNet activates nodes based on verified burns
4. NO smart contract needed on QNet during this phase

### Components:
- **Solana Burn Tracker**: Simple contract that counts burns
- **1DEV Phase Handler**: QNet module that reads Solana data
- **Transition Monitor**: Watches for transition conditions

### Pricing:
- Dynamic pricing based on burn progress  
- Universal pricing: 1,500 1DEV for ALL node types (Light/Full/Super)
- Every 10% burned reduces cost by 150 1DEV
- Minimum cost: 150 1DEV at 90% burned

## Phase 2: QNC Transfer to Pool 3 on QNet (After transition)

### Transition triggers when:
- 90% of 1DEV supply is burned (900 million)
- OR 5 years have passed since the first block (genesis block)
- Whichever comes first

### How it works:
1. QNC smart contract activates on QNet
2. Users TRANSFER QNC tokens to Pool 3 (not burned!)
3. Direct activation through QNet contract
4. All transferred QNC redistributed equally to active nodes
5. Solana no longer used

### Components:
- **QNC Pool 3 Contract**: Native QNet smart contract
- **Migration Handler**: Free migration for 1DEV-era nodes

### Pricing:
- Different base prices: Light 5,000 / Full 7,500 / Super 10,000 QNC
- Network size multipliers: 0.5x (0-100k) / 1.0x (100k-1M) / 2.0x (1M-10M) / 3.0x (10M+)
- All QNC transferred to Pool 3 for equal daily distribution

## Architecture Diagram

```
PHASE 1 (1DEV):
User → Burns 1DEV on Solana → Solana Burn Tracker
                                       ↓
                               QNet reads burns
                                       ↓
                             1DEV Phase Handler
                                       ↓
                               Node Activated

PHASE 2 (QNC):
User → Burns QNC on QNet → QNC Smart Contract → Node Activated
```

## Key Design Decisions

### Why separate contracts?
1. **Simplicity**: Each contract does one thing well
2. **Security**: Minimal logic on Solana = fewer vulnerabilities
3. **Flexibility**: Can update QNet logic without touching Solana
4. **Gas costs**: Simple Solana contract = lower fees

### Why no connection between contracts?
1. **No bridge needed**: QNet just reads public Solana data
2. **Deterministic transition**: Both chains know the rules
3. **Independent operation**: Each phase is self-contained

### Transition handling:
1. **Automatic detection**: QNet monitors burn % and time
2. **One-way switch**: Cannot go back to 1DEV after transition
3. **Free migration**: 1DEV nodes move to QNC at no cost

## Implementation Files

### Phase 1 (1DEV):
- `qnet-contracts/1dev-burn-contract/` - Solana burn tracker
- `qnet-node/src/economics/1dev_phase_handler.py` - QNet handler
- `qnet-node/src/economics/transition_monitor.py` - Transition logic

### Phase 2 (QNC):
- `qnet-contracts/qnet-native/node_activation_qnc.py` - QNC contract
- Contract dormant until transition triggers

### Shared:
- `qnet-dao/contracts/governance.py` - DAO can trigger transition
- `qnet-node/src/economics/1dev_burn_model.py` - Pricing calculations

## Security Considerations

1. **Burn verification**: Must verify Solana burns are real
2. **Double-spend protection**: Each burn TX used only once
3. **Migration security**: Cryptographic proof of 1DEV activation
4. **Transition safety**: Cannot be reversed or manipulated

## Benefits of This Architecture

1. **Clear phases**: Users know exactly how system works
2. **No complexity**: Each phase is independent
3. **Future-proof**: QNC phase designed for long-term
4. **Fair transition**: Free migration rewards early adopters 