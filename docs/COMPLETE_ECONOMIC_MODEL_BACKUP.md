# QNet Complete Economic Model - January 2025 (Production Ready)

## Overview

QNet has a unique economic model that combines token burning for network participation with reward distribution every 4 hours.

**Status Update (January 2025)**: With QNet's unified P2P architecture and production-ready CLI, the economic model is fully integrated with burn-to-join activation, automatic reward claiming, and enterprise-grade monitoring. The system supports 275,418+ microblocks with 1-second intervals and automatic regional optimization.

**CRITICAL DISCOVERY**: Current mempool limitation (50k per node) artificially constrains network throughput. Economic model designed for unlimited scale, but performance limited by this configuration bottleneck.

**SHARP DROP INNOVATION**: After 20 years of high rewards, QNet implements a dramatic sustainability mechanism where the 5th halving reduces emissions by 10x instead of 2x, creating eternal rewards while preserving long-term network value.

## 1. Node Activation (One-time Burn)

### Phase 1: QNA Burns (Years 0-5)
- **Purpose**: Activate node by burning QNA on Solana
- **Prices**: Dynamic, decreasing as more QNA burns
  - Light: 1,000 → 100 QNA
  - Full: 1,500 → 150 QNA
  - Super: 2,000 → 200 QNA
- **Result**: Permanent node activation

### Phase 2: QNC Burns (After transition)
- **Trigger**: 90% QNA burned OR 5 years
- **Prices**: Based on network size
  - Light: 2,500-15,000 QNC (base: 5,000)
  - Full: 3,750-22,500 QNC (base: 7,500)
  - Super: 5,000-30,000 QNC (base: 10,000)
- **Migration**: Free for QNA-activated nodes

**Network Size Multipliers**:
- 0-100K nodes: 0.5x (early discount)
- 100K-1M nodes: 1.0x (standard)
- 1M-10M nodes: 2.0x (high demand)
- 10M+ nodes: 3.0x (mature network)

## 2. Reward Distribution System

### Reward Pool
- **Total Daily**: 1,470,604 QNC (initial emission)
- **Distribution**: Every 4 hours (6 times per day)
- **Per Distribution**: 245,100.67 QNC (initial)
- **Source**: New token emission
- **Halving**: Every 4 years emission is cut in half

### Halving Schedule with Sharp Drop Innovation
| Year | Daily Emission | Per 4 Hours | Per Year | Halving Factor |
|------|----------------|-------------|----------|----------------|
| 0-4 | 1,470,604 QNC | 245,100.67 | 536,670,460 | Initial |
| 4-8 | 735,302 QNC | 122,550.33 | 268,335,230 | ÷2 |
| 8-12 | 367,651 QNC | 61,275.17 | 134,167,615 | ÷2 |
| 12-16 | 183,825.5 QNC | 30,637.58 | 67,083,807 | ÷2 |
| 16-20 | 91,912.75 QNC | 15,318.79 | 33,541,904 | ÷2 |
| **20-24** | **9,191.28 QNC** | **1,531.88** | **3,354,190** | **÷10 SHARP DROP!** |
| 24-28 | 4,595.64 QNC | 765.94 | 1,677,095 | ÷2 |
| 28-32 | 2,297.82 QNC | 382.97 | 838,547 | ÷2 |
| 32+ | Continues halving every 4 years | Forever | Eternal | ÷2 |

### Base Distribution (Equal for all active nodes)
```
Reward per 4 hours = (Current 4-hour emission) / Number of Active Nodes
Daily Reward = (Current 4-hour emission / Number of Active Nodes) × 6
```

Example with 10,000 nodes:
- **Years 0-4**: 24.51 QNC per 4 hours (147.06 QNC/day)
- **Years 4-8**: 12.26 QNC per 4 hours (73.53 QNC/day)
- **Years 8-12**: 6.13 QNC per 4 hours (36.77 QNC/day)
- **Years 12-16**: 3.06 QNC per 4 hours (18.38 QNC/day)

### Ping Requirements
- Nodes must ping at least once every 4 hours to receive rewards
- Randomized ping slots prevent network congestion
- Mobile nodes can ping when convenient within window

### Transaction Fee Bonuses (Only for Super/Full nodes)
- **Super Nodes**: Get 70% of all transaction fees
- **Full Nodes**: Get 30% of all transaction fees
- **Light Nodes**: Only base rewards (no fee share)

### Microblock & Sharding Impact
**Current System:**
- **Microblock Interval**: 1s default, 500ms with `QNET_HIGH_FREQUENCY=1`
- **Transactions per Microblock**: Up to 50,000 (high throughput mode)
- **Theoretical Network TPS**: 100,000+ (50k tx × 2 blocks/sec per node)

**Economic Scaling:**
- More transactions = more fees for Full/Super nodes
- Reward frequency remains 4 hours regardless of microblock speed
- Higher TPS = higher fee income between reward distributions

**Bottleneck Issue:**
- Current mempool limit: 50,000 transactions per node
- Network max: 8 nodes × 50k = 400k total transactions
- This limits fee generation and constrains economic benefits of microblocks

## 3. Leader Selection & Block Production

### No Leader Privileges
- **Block Producer**: Selected by reputation + randomness
- **Reward**: NONE - being leader gives no extra rewards
- **Purpose**: Fair distribution, prevents centralization

### Why No Leader Rewards?
1. **Fairness**: All nodes contribute equally to security
2. **Decentralization**: No incentive to dominate block production
3. **Simplicity**: Easier to calculate rewards
4. **Mobile-friendly**: Light nodes aren't disadvantaged

## 4. Complete Reward Structure

### Light Nodes (Mobile)
- **Activation**: Burn 100-1,000 QNA (one-time)
- **Rewards**: Base pool share every 4 hours
- **Requirements**: Ping once per 4-hour window
- **No fees**: Don't process transactions
- **Example**: 24.51 QNC per 4 hours (10k nodes)

### Full Nodes
- **Activation**: Burn 150-1,500 QNA (one-time)
- **Rewards**: Base pool share + 30% fee share
- **Requirements**: Validate transactions, ping every 4 hours
- **Process**: Validate transactions
- **Example**: 24.51 QNC + ~3 QNC fees per 4 hours

### Super Nodes
- **Activation**: Burn 200-2,000 QNA (one-time)
- **Rewards**: Base pool share + 70% fee share
- **Requirements**: Consensus participation, ping every 4 hours
- **Process**: Validate + consensus participation
- **Example**: 24.51 QNC + ~7 QNC fees per 4 hours

## 5. Economic Balance

### Token Flow
```
Burned (Removed Forever):
- QNA for activation (Phase 1)
- QNC for activation (Phase 2)

Created (New Emission):
- 245,100.67 QNC every 4 hours (years 0-4)
- 122,550.33 QNC every 4 hours (years 4-8)
- Halving every 4 years
- Maximum emission: ~2 billion QNC over all time

Recycled:
- Transaction fees → Super/Full nodes (70%/30%)
```

### Sustainability Through Halving
- **Deflation**: Burning removes tokens forever
- **Controlled Inflation**: Halving every 4 years
- **Market Commissions**: More activity = more commissions for validators
- **Long-term Stability**: Emission tends towards zero

### Total Supply Schedule with Sharp Drop Innovation
| Period | New Emission | Total Supply | Halving Factor |
|--------|---------------|--------------|----------------|
| Year 0 | 0 | 1,000,000,000 QNC | Genesis |
| Year 4 | 536,670,460 | 1,536,670,460 QNC | ÷2 |
| Year 8 | 268,335,230 | 1,805,005,690 QNC | ÷2 |
| Year 12 | 134,167,615 | 1,939,173,305 QNC | ÷2 |
| Year 16 | 67,083,807 | 2,006,257,112 QNC | ÷2 |
| Year 20 | 33,541,904 | 2,039,799,016 QNC | ÷2 |
| **Year 24** | **3,354,190** | **2,043,153,206 QNC** | **÷10 SHARP DROP!** |
| Year 28 | 1,677,095 | 2,044,830,301 QNC | ÷2 |
| Year 32 | 838,547 | 2,045,668,848 QNC | ÷2 |
| Year 100 | ~107M saved | ~2,039M QNC | Long-term |
| Year ∞ | → 0 | ~2,073M QNC max | Eternal rewards |

**Key Innovation**: Sharp drop saves 107M QNC over 100 years while maintaining eternal rewards and early adopter incentives.

## 6. Example Scenarios

### Scenario 1: Early Network (1,000 nodes, Year 1)
Per 4-hour distribution:
- Light Node: 245.1 QNC (just base)
- Full Node: 245.1 + 30 fees = 275.1 QNC
- Super Node: 245.1 + 70 fees = 315.1 QNC

### Scenario 2: After 4th Halving (1,000 nodes, Year 17)
Per 4-hour distribution:
- Light Node: 15.32 QNC (just base)
- Full Node: 15.32 + 30 fees = 45.32 QNC
- Super Node: 15.32 + 70 fees = 85.32 QNC

### Scenario 3: After Sharp Drop (1,000 nodes, Year 22)
Per 4-hour distribution:
- Light Node: 1.53 QNC (just base after sharp drop)
- Full Node: 1.53 + 30 fees = 31.53 QNC (fees now dominate!)
- Super Node: 1.53 + 70 fees = 71.53 QNC (fee income critical!)

### Scenario 4: Mature Fee Economy (100,000 nodes, Year 30)
Per 4-hour distribution with high transaction volume:
- Light Node: 0.004 QNC (tiny base after sharp drop + normal halvings)
- Full Node: 0.004 + 15 fees = 15.004 QNC (almost pure fee income)
- Super Node: 0.004 + 35 fees = 35.004 QNC (pure fee economy achieved)

## 7. Key Principles

1. **One-time Entry Cost**: Burn once, earn forever
2. **Frequent Rewards**: Every 4 hours (6x daily)
3. **Equal Base Rewards**: Every active node gets same base
4. **Merit-based Bonuses**: Only nodes doing work get fees
5. **No Leader Privileges**: Block production gives no extra rewards
6. **Reputation Matters**: For selection, not rewards

## 8. Why This Model Works

### For Light Nodes (Mobile)
- Low entry cost (100 QNA minimum)
- Rewards every 4 hours
- Flexible ping timing within window
- No pressure to upgrade
- Perfect for passive income

### For Full/Super Nodes
- Higher entry shows commitment
- Fee income rewards infrastructure
- Consistent 4-hour payouts
- Not dependent on being selected as leader
- Predictable returns

### For Network
- **Scalable**: Economic model works with 100k+ TPS
- **Sharding-Ready**: Rewards distributed across all shards
- **Regional Optimization**: P2P efficiency reduces costs
- **Parallel Processing**: Higher throughput = more fee revenue
- **Enterprise Storage**: Efficient operations reduce overhead

## 9. Scaling Economics (June 2025 Update)

### 100k TPS Economic Impact
With QNet's advanced architecture achieving 100k TPS:

**Increased Transaction Volume:**
- 100,000 TPS = 8.64 billion transactions/day
- At 0.001 QNC average fee = 8.64 million QNC daily fees
- Super nodes: 6.048 million QNC (70%)
- Full nodes: 2.592 million QNC (30%)

**Sharded Reward Distribution:**
- Rewards distributed across all active shards
- Cross-shard coordination ensures fair distribution
- Regional P2P optimizes reward propagation
- Parallel processing enables efficient calculations

**Example: Mature 100k TPS Network (100,000 nodes, Year 5)**
Per 4-hour distribution with high transaction volume:
- Light Node: 1.23 QNC (base only)
- Full Node: 1.23 + 432 fees = 433.23 QNC
- Super Node: 1.23 + 1,008 fees = 1,009.23 QNC

**Network Benefits:**
- Higher TPS = More fee revenue for validators
- Sharding enables efficient reward processing
- Regional P2P reduces distribution costs
- Parallel validation increases network capacity
- Ensures decentralization
- Prevents validator monopolies
- Rewards actual work (tx processing)
- Sustainable long-term
- Smooth load distribution

## 9. Sharp Drop Impact on Long-term Economics

### Why Sharp Drop is Revolutionary
1. **Early Adopter Protection**: First 20 years identical to normal system
2. **Forced Maturation**: Network must develop fee economy by year 20
3. **Sustainability**: Reduces long-term inflation while maintaining eternal rewards
4. **Value Preservation**: Creates scarcity that supports token appreciation

### Economic Transition Timeline
- **Years 0-10**: Network bootstrapping with high rewards
- **Years 10-20**: Growth and maturation phase
- **Years 20-24**: Sharp transition to fee-dependent economy
- **Years 24+**: Sustainable operation with minimal base emission

### Network Adaptation Requirements
**Before Year 20, network must develop:**
1. **High Transaction Volume**: To generate substantial fee income
2. **DeFi Ecosystem**: Additional income sources for node operators
3. **Enterprise Services**: Premium services with fee revenue
4. **Efficient Operations**: Lower costs to maintain profitability

### Comparison: 100-Year Projection

**Total Emission Saved by Sharp Drop:**
- Normal system (100 years): ~2,146M QNC
- Sharp drop system (100 years): ~2,039M QNC
- **Savings: 107M QNC (5% reduction while maintaining eternal rewards)**

**Key Benefits:**
- Same early adoption incentives (years 0-20)
- Dramatic long-term sustainability improvement
- Forces healthy transition to fee-dependent economy
- Maintains eternal rewards (never goes to zero)
- Creates long-term token value support through scarcity

## Summary

QNet's economic model is designed for fairness and sustainability:
- **Burn to join**: One-time cost for permanent membership
- **Rewards every 4 hours**: 6 distributions daily
- **Equal base rewards**: All active nodes share pool equally
- **Work-based bonuses**: Transaction fees for Full/Super nodes only (70%/30% split)
- **No leader privileges**: Being block producer gives no extra rewards

This creates a system where everyone can participate profitably, from mobile phones to data centers, without creating centralization pressures.

## 9. Halving Impact on Economics

### Why Halving is Essential
1. **Control Inflation**: Prevents infinite emission
2. **Price Appreciation**: Deficit increases QNC value
3. **Transition to Commissions**: Commissions become main income over time
4. **Stability**: Model works decades (like Bitcoin)

### Long-term Vision
- **Years 0-4**: High rewards attract early participants
- **Years 4-8**: First halving, growth importance of commissions
- **Years 8-12**: Commissions become significant part of income
- **Years 12+**: Commissions exceed base rewards

### Compensation Mechanisms
As emission decreases, node incomes are compensated:
1. **Price Increase**: Deficit → higher price → same incomes in USD
2. **More Transactions**: Network growth → more commissions
3. **Higher Commissions**: Competition for block space
4. **DeFi Integration**: Additional income sources

### Example: Bitcoin Model Success
- 2009: 50 BTC per block (~$0)
- 2024: 3.125 BTC per block (~$200,000)
- Halvings didn't kill mining, they made it more profitable!

QNet follows proven model with improvements:
- More frequent payouts (4 hours vs 10 minutes)
- Equal base distribution (fairness)
- Mobile mining (accessibility)
- No stake loss risk (safety) 