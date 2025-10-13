# Final $1DEV Burn Model for Node Activation

## Key Parameters

### Starting Prices (0% burned)
- **Light node**: 1,500 $1DEV
- **Full node**: 1,500 $1DEV  
- **Super node**: 1,500 $1DEV

### Minimum Prices (at 80-90% burned)
- **Light node**: 300 $1DEV
- **Full node**: 300 $1DEV
- **Super node**: 300 $1DEV

### QNC Transition Conditions
- When 90% of $1DEV supply is burned (900 million out of 1 billion)
- OR after 5 years from launch (whichever comes first)

## Price Schedule by Burn Progress

| Burned | % of Supply | Light | Full | Super | Note |
|--------|-------------|-------|------|-------|------|
| 0 | 0% | 1,500 | 1,500 | 1,500 | Network launch |
| 100M | 10% | 1,350 | 1,350 | 1,350 | |
| 200M | 20% | 1200 | 1200 | 1200 | |
| 300M | 30% | 1050 | 1050 | 1050 | |
| 400M | 40% | 900 | 900 | 900 | |
| 500M | 50% | 750 | 750 | 750 | Halfway point |
| 600M | 60% | 600 | 600 | 600 | |
| 700M | 70% | 450 | 450 | 450 | |
| 800M | 80% | 300 | 300 | 300 | Minimum Phase 1 price |
| 900M | 90% | - | - | - | **Transition to Phase 2 (QNC)** |

## Genesis Whitelist

### Free Activations (only 4 addresses)
1. **Genesis Validator 1** - Primary (1 free activation)
2. **Genesis Validator 2** - Secondary (1 free activation)
3. **Genesis Validator 3** - Backup 1 (1 free activation)
4. **Genesis Validator 4** - Backup 2 (1 free activation)
4. **Genesis Validator 5** - Backup 3 (1 free activation)

### All Other Participants
- Pay full price according to current burn progress
- No discounts or privileges
- Equal access for everyone

### Important: No Transition Benefits
- **No grace period** when switching from $1DEV to QNC
- **No special benefits** for $1DEV holders
- **No discounts** during transition
- Simple transition from $1DEV burn to QNC payment when transition occurs



### Deflationary Effect
- Each burn reduces total $1DEV supply
- Creates natural scarcity
- Incentivizes holding remaining $1DEV

## Technical Details

### Price Calculation Formula
```
Price = Minimum + (Starting_price - Minimum) × e^(-progress × 3.0)
where progress = burned / (1_000_000_000 × 0.9)
```

### Rounding
- All prices rounded to nearest 50 $1DEV
- Minimum thresholds always respected

### Burn Address
- Solana: `1nc1nerator11111111111111111111111111111111`
- Transactions are irreversible

## Model Advantages

1. **Accessibility**: Starting price of 1,500 $1DEV makes participation affordable
2. **Fairness**: Everyone pays the same (except 4 genesis nodes)
3. **Predictability**: Clear formula with no hidden parameters
4. **Reliability**: 4 free nodes guarantee network operation
5. **Simplicity**: No complex discounts or privileges

This model provides a balance between participant accessibility and network sustainability. 