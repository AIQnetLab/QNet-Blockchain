# QNet Correct ROI Analysis

## Complete ROI Calculation (Base Rewards + Fees)

### Important: ROI includes ALL rewards, not just fees!

## Scenario 1: Early Network (Year 1)
**Assumptions:**
- 10,000 active nodes
- 100,000 transactions/day
- Transaction fee: 0.01 QNC per tx
- Total daily fees: 1,000 QNC

### Daily Income Breakdown:
```
Light Node (1,000 QNA investment):
- Base rewards: 147.06 QNC/day
- Fee share: 0 QNC/day
- Total: 147.06 QNC/day
- Daily ROI: 147.06/1,000 = 14.7%

Full Node (1,500 QNA investment):
- Base rewards: 147.06 QNC/day
- Fee share: (1,000 × 0.30) / 3,000 full nodes = 0.1 QNC/day
- Total: 147.16 QNC/day
- Daily ROI: 147.16/1,500 = 9.8%

Super Node (2,000 QNA investment):
- Base rewards: 147.06 QNC/day
- Fee share: (1,000 × 0.70) / 1,000 super nodes = 0.7 QNC/day
- Total: 147.76 QNC/day
- Daily ROI: 147.76/2,000 = 7.4%
```

**Result: Light nodes have BEST ROI in early days!**

## Scenario 2: Growing Network (Year 5)
**Assumptions:**
- 50,000 active nodes (post-halving)
- 1,000,000 transactions/day
- Transaction fee: 0.01 QNC per tx
- Total daily fees: 10,000 QNC

### Daily Income Breakdown:
```
Light Node:
- Base rewards: 14.71 QNC/day (halved)
- Fee share: 0 QNC/day
- Total: 14.71 QNC/day
- Daily ROI: 14.71/1,000 = 1.47%

Full Node (assuming 15,000 full nodes):
- Base rewards: 14.71 QNC/day
- Fee share: (10,000 × 0.30) / 15,000 = 0.2 QNC/day
- Total: 14.91 QNC/day
- Daily ROI: 14.91/1,500 = 0.99%

Super Node (assuming 5,000 super nodes):
- Base rewards: 14.71 QNC/day
- Fee share: (10,000 × 0.70) / 5,000 = 1.4 QNC/day
- Total: 16.11 QNC/day
- Daily ROI: 16.11/2,000 = 0.81%
```

**Still Light nodes lead, but gap narrows!**

## Scenario 3: Mature Network (Year 10)
**Assumptions:**
- 100,000 active nodes (2 halvings)
- 10,000,000 transactions/day
- Transaction fee: 0.01 QNC per tx
- Total daily fees: 100,000 QNC

### Daily Income Breakdown:
```
Light Node (60,000 nodes):
- Base rewards: 3.68 QNC/day
- Fee share: 0 QNC/day
- Total: 3.68 QNC/day
- Daily ROI: 3.68/1,000 = 0.37%

Full Node (30,000 nodes):
- Base rewards: 3.68 QNC/day
- Fee share: (100,000 × 0.30) / 30,000 = 1.0 QNC/day
- Total: 4.68 QNC/day
- Daily ROI: 4.68/1,500 = 0.31%

Super Node (10,000 nodes):
- Base rewards: 3.68 QNC/day
- Fee share: (100,000 × 0.70) / 10,000 = 7.0 QNC/day
- Total: 10.68 QNC/day
- Daily ROI: 10.68/2,000 = 0.53%
```

**Finally Super nodes take the lead!**

## Key Insights

### 1. ROI Evolution Over Time
- **Years 0-4**: Light nodes have best ROI (lowest entry cost)
- **Years 4-8**: Gap narrows as fees grow
- **Years 8+**: Super nodes dominate as fees exceed base rewards

### 2. Break-even Points
When do Super nodes become more profitable than Light nodes?

```
Super ROI > Light ROI when:
(Base + 70% fees/Super_count) / 2,000 > Base / 1,000

This happens when:
70% fees / Super_count > Base rewards
```

### 3. Real ROI Factors
The actual ROI depends on:
1. **Burn cost** (investment)
2. **Base rewards** (decreases with halvings)
3. **Transaction volume** (increases over time)
4. **Number of competing nodes** (dilutes rewards)
5. **Node type distribution** (affects fee share)

## Corrected ROI Formula

```
Daily ROI = (Base Rewards + Fee Share) / Burn Cost × 100%

Where:
- Base Rewards = Daily Emission / Total Active Nodes
- Fee Share (Full) = (Daily Fees × 0.30) / Active Full Nodes
- Fee Share (Super) = (Daily Fees × 0.70) / Active Super Nodes
- Fee Share (Light) = 0
```

## Investment Strategy Based on Timeline

### Short-term (0-4 years)
- **Best ROI**: Light nodes
- **Strategy**: Low cost, maximum nodes

### Medium-term (4-8 years)
- **Best ROI**: Depends on network growth
- **Strategy**: Monitor fee growth, consider upgrading

### Long-term (8+ years)
- **Best ROI**: Super nodes
- **Strategy**: Infrastructure investment pays off

## Conclusion

The 70/30 fee split creates a dynamic where:
1. **Early adopters** benefit most from Light nodes
2. **Infrastructure providers** benefit long-term from Super nodes
3. **Full nodes** provide middle-ground option

This encourages:
- Mass adoption early (Light nodes attractive)
- Infrastructure growth later (Super nodes profitable)
- Natural progression as network matures 