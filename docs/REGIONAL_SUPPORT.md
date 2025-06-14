# QNet Regional Support Documentation

## Overview

QNet implements geographic regional support to optimize network performance and ensure global decentralization. The system automatically detects node locations and optimizes connections based on geographic proximity.

## Supported Regions

QNet divides the world into 7 major regions:

1. **North America** (`north_america`, `na`)
   - United States, Canada, Mexico
   - Estimated nodes: High concentration expected

2. **South America** (`south_america`, `sa`)
   - Brazil, Argentina, Chile, Colombia, etc.
   - Growing crypto adoption

3. **Europe** (`europe`, `eu`)
   - UK, Germany, France, Italy, Spain, etc.
   - Expected high concentration of cloud nodes

4. **Africa** (`africa`, `af`)
   - South Africa, Nigeria, Kenya, etc.
   - Emerging market with growing potential

5. **Asia Pacific** (`asia_pacific`, `ap`)
   - China, Japan, Korea, India, Singapore, etc.
   - Large population, diverse infrastructure

6. **Middle East** (`middle_east`, `me`)
   - UAE, Saudi Arabia, Israel, Turkey, etc.
   - Strategic location between continents

7. **Oceania** (`oceania`, `oc`)
   - Australia, New Zealand, Fiji
   - Isolated but important for global coverage

## Configuration

Add to your `config.ini`:

```ini
[Regional]
; Regional settings for geographic distribution
node_region = auto
; Options: auto, north_america, south_america, europe, africa, asia_pacific, middle_east, oceania
; Can also use shortcuts: na, sa, eu, af, ap, me, oc
; Or country codes: us, uk, de, jp, cn, au, etc.

prefer_regional_peers = true
; Prioritize connections to peers in the same or nearby regions

max_inter_regional_connections = 10
; Maximum connections to nodes outside your region

regional_latency_threshold_ms = 150
; Consider regions "nearby" if latency is below this threshold

enable_regional_sharding = true
; Enable regional optimization for transaction sharding

regional_backup_count = 2
; Number of backup regions to maintain connections with
```

## How It Works

### 1. **Automatic Region Detection**
- When `node_region = auto`, the system detects your region based on IP
- Uses multiple GeoIP services for accuracy
- Falls back to manual configuration if detection fails

### 2. **Connection Optimization**
- Nodes prefer connecting to peers in the same region
- Maintains some inter-regional connections for resilience
- Automatically balances local vs global connectivity

### 3. **Latency-Based Routing**
Estimated inter-regional latencies (milliseconds):
- North America ↔ Europe: 80ms
- North America ↔ Asia Pacific: 150ms
- Europe ↔ Asia Pacific: 180ms
- Europe ↔ Africa: 60ms
- Asia Pacific ↔ Oceania: 100ms

### 4. **Regional Sharding**
- Transactions can be processed regionally when possible
- Reduces global synchronization overhead
- Improves transaction throughput

## Benefits

### For Node Operators
1. **Lower Latency**: Connect to nearby nodes for faster communication
2. **Better Rewards**: Serve local users more efficiently
3. **Reduced Bandwidth**: Less inter-continental traffic

### For the Network
1. **True Decentralization**: Prevents concentration in one region
2. **Resilience**: Regional failures don't affect global network
3. **Scalability**: Regional processing reduces global load

## Monitoring Regional Distribution

Check your node's regional status:
```bash
curl http://localhost:5000/api/node/status
```

Response includes:
```json
{
  "region": {
    "name": "europe",
    "prefer_regional_peers": true,
    "max_inter_regional": 10,
    "regional_sharding": true,
    "network_distribution": {
      "total_nodes": 10000,
      "regions_active": 7,
      "distribution": {
        "europe": {"count": 4000, "percentage": 40.0},
        "north_america": {"count": 3000, "percentage": 30.0},
        "asia_pacific": {"count": 2000, "percentage": 20.0}
      },
      "concentration_index": 0.35
    }
  }
}
```

## Cloud Provider Detection

The system detects if nodes are running on major cloud providers:
- AWS
- Google Cloud
- Azure
- DigitalOcean

This helps monitor datacenter concentration and encourage home/office nodes.

## Best Practices

### For Optimal Performance
1. **Set your region explicitly** if auto-detection is incorrect
2. **Run nodes in underserved regions** for better rewards potential
3. **Use regional backup nodes** for redundancy

### For Network Health
1. **Monitor concentration index** (0 = perfect distribution, 1 = all in one region)
2. **Encourage geographic diversity** in your community
3. **Report regional connectivity issues** to help improve routing

## Future Enhancements

1. **Dynamic Regional Boundaries**: Adjust regions based on actual latency
2. **Regional Consensus Groups**: Faster finality for regional transactions
3. **Cross-Region Bridges**: Specialized nodes for inter-regional communication
4. **Regional Governance**: Allow regions to set local parameters

## Troubleshooting

### Region Not Detected
- Check if your IP is private/local
- Manually set region in config.ini
- Ensure firewall allows outbound HTTPS

### High Inter-Regional Latency
- Normal for distant regions (e.g., South America ↔ Asia)
- Consider running additional nodes in strategic locations
- Use regional sharding for local transactions

### Concentration Warnings
- If concentration index > 0.7, network is too centralized
- Encourage nodes in underserved regions
- Consider regional incentives (community-driven) 