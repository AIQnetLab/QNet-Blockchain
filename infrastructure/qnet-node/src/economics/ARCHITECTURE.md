# QNet Economics Architecture

## Overview

The pricing system separates **static configuration** from **dynamic blockchain state**.

## Key Principles

1. **Config.ini is IMMUTABLE**
   - Contains only constants that never change
   - Initial prices (for formula calculation)
   - Minimum prices (floor values)
   - Supply parameters
   - Transition rules

2. **Blockchain is the SOURCE OF TRUTH**
   - Current burn amount
   - Network launch date
   - Real-time state

3. **Prices are CALCULATED, not stored**
   - Use formula with static params + dynamic state
   - Never stored in config
   - Always computed on-demand

## Data Flow

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  config.ini │     │  Blockchain  │     │   Pricing   │
│  (Static)   │────▶│   (Dynamic)  │────▶│ Calculator  │
└─────────────┘     └──────────────┘     └─────────────┘
       │                    │                     │
       │                    │                     ▼
   Initial prices      Burn progress         Current Price
   Min prices         Days elapsed
   Supply params
```

## Components

### 1. Static Configuration (config.ini)
```ini
[Token]
# These NEVER change after deployment
qna_initial_burn_light = 1000000000  # Formula parameter
qna_initial_burn_full = 1500000000   # Formula parameter
qna_initial_burn_super = 2000000000  # Formula parameter
qna_min_burn_light = 100000000      # Floor value
qna_min_burn_full = 150000000       # Floor value
qna_min_burn_super = 200000000      # Floor value
qna_total_supply = 10000000000000000
qna_burn_target_ratio = 0.9
qna_transition_years = 5
```

### 2. Dynamic State (Blockchain)
```python
{
    "total_burned": 2500000000,      # Changes with each burn
    "network_launch_date": "2024-01-01",  # Set at genesis
    "burn_transactions": [...]        # History
}
```

### 3. Price Calculation
```python
# Combines static + dynamic
current_price = calculate_price(
    initial_price=config.initial_burn_light,  # Static
    min_price=config.min_burn_light,         # Static
    total_burned=blockchain.total_burned,     # Dynamic
    total_supply=config.total_supply         # Static
)
```

## Transition Handling

### Before Transition (QNA)
- Check: burned < 90% AND years < 5
- Use: QNA burn model
- Price: Dynamic based on burn progress

### After Transition (QNC)
- Check: burned >= 90% OR years >= 5
- Use: QNC payment model
- Price: Dynamic based on network size

## Why This Architecture?

1. **No Config Updates Needed**
   - Prices change automatically
   - No manual intervention
   - No config file modifications

2. **Blockchain Authority**
   - Single source of truth
   - Verifiable by anyone
   - Tamper-proof

3. **Predictable Behavior**
   - Formula is public
   - Anyone can calculate future prices
   - No surprises

4. **Resilience**
   - Cache for offline operation
   - Graceful degradation
   - No single point of failure

## Implementation Example

```python
# API endpoint
def get_activation_price(node_type):
    # 1. Load static config (never changes)
    config = load_config()
    
    # 2. Get dynamic state from blockchain
    tracker = BurnStateTracker()
    burn_state = tracker.get_current_burn_state()
    
    # 3. Check if we should use QNC
    if burn_state["burn_percentage"] >= 90 or 
       burn_state["days_since_launch"] >= (5 * 365):
        return get_qnc_price(node_type)
    
    # 4. Calculate QNA price
    calculator = QNABurnCalculator()
    return calculator.calculate_burn_requirement(
        node_type,
        burn_state["total_burned"]
    )
```

## Summary

- **Config.ini** = Constants (never change)
- **Blockchain** = State (always current)
- **Calculator** = Logic (combines both)
- **Result** = Current price (always accurate) 