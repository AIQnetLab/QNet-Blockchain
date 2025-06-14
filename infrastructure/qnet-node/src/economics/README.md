# QNet Economics Module

This module contains the economic models and pricing mechanisms for the QNet blockchain.

## Components

### 1. QNA Burn Model (`qna_burn_model.py`)
Implements the dynamic pricing for node activation using QNA tokens:
- Starting prices: 1,500 / 1,500 / 1,500 $1DEV (light/full/super - all same price)
- Minimum prices: 150 / 150 / 150 $1DEV (all same minimum)
- Exponential decay curve based on burn progress
- Automatic transition to QNC at 90% burned or 5 years

### 2. Dynamic Pricing (`dynamic_pricing.py`)
Post-transition QNC pricing based on network size:
- Base prices: 5,000 / 7,500 / 10,000 QNC (light/full/super)
- Price range: 0.5x-3x based on network size (2,500-30,000 QNC max)
- Target equilibrium: 100,000 nodes
- Smooth quadratic curves to prevent manipulation

### 3. Transition Protection (`transition_protection.py`)
Mechanisms to prevent price shocks during QNA→QNC transition:
- Maximum 10% daily price change
- 90-day smoothing period
- Emergency brake for high volatility

### 4. Genesis Whitelist (`genesis_whitelist.py`)
Manages privileged addresses for network bootstrap:
- 4 genesis validators with free activation
- No other discounts or privileges
- Fair access for all participants

## Usage

```python
from economics.qna_burn_model import QNABurnCalculator, NodeType

calculator = QNABurnCalculator()
burn_requirement = calculator.calculate_burn_requirement(
    NodeType.LIGHT,  # All node types have same price in Phase 1
    total_burned=2_500_000_000  # 25% burned
)
print(f"Price: {burn_requirement['amount']} {burn_requirement['token']}")
# Expected output: Price: ~1125 $1DEV (25% burned = reduced from 1500)
```

## Configuration

See `config/config.ini` for economic parameters:
- `[Token]` section for QNA settings
- `[NodeRewards]` section for reward multipliers
- `[SmartContracts]` section for gas pricing

## Testing

Run visualizations:
```bash
python burn_model_visualization.py
python genesis_whitelist.py
```

## Key Economic Principles

1. **Accessibility**: Equal pricing for all node types (1,500 $1DEV)
2. **Fairness**: No special privileges (except 4 genesis nodes)
3. **Predictability**: Clear formulas, no hidden parameters
4. **Sustainability**: Deflationary model with controlled supply
5. **Decentralization**: Minimal privileged addresses 