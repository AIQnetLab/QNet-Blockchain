#!/bin/bash

# QNet Genesis Nodes Update Script - PRODUCTION
# Usage: ./update-genesis-nodes.sh "ip1,ip2,ip3,ip4,ip5"

set -e

echo "🔧 QNet Genesis Nodes Update Script"
echo "=================================="

if [ $# -eq 0 ]; then
    echo "❌ Error: No Genesis node IPs provided"
    echo ""
    echo "Usage:"
    echo "  $0 \"ip1,ip2,ip3,ip4,ip5\""
    echo ""
    echo "Example:"
    echo "  $0 \"192.168.1.10,192.168.1.11,192.168.1.12,192.168.1.13,192.168.1.14\""
    echo ""
    echo "Current Genesis nodes:"
    if [ -n "$QNET_GENESIS_NODES" ]; then
        echo "  Environment: $QNET_GENESIS_NODES"
    fi
    if [ -f "genesis-nodes.json" ]; then
        echo "  Config file: $(cat genesis-nodes.json | grep -o '"[0-9.]*"' | tr -d '"' | tr '\n' ',' | sed 's/,$//')"
    fi
    exit 1
fi

NEW_GENESIS_NODES="$1"

echo "📝 New Genesis nodes: $NEW_GENESIS_NODES"

# Validate IP format
IFS=',' read -ra IPS <<< "$NEW_GENESIS_NODES"
if [ ${#IPS[@]} -ne 5 ]; then
    echo "❌ Error: Exactly 5 Genesis node IPs required (provided: ${#IPS[@]})"
    exit 1
fi

for ip in "${IPS[@]}"; do
    # Enhanced IP validation for production blockchain security
    if [[ ! $ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        echo "❌ Error: Invalid IP address format: $ip"
        exit 1
    fi
    
    # Extract octets for security validation
    IFS='.' read -ra OCTETS <<< "$ip"
    
    # Validate octet ranges
    for octet in "${OCTETS[@]}"; do
        if [ "$octet" -lt 0 ] || [ "$octet" -gt 255 ]; then
            echo "❌ Error: Invalid IP octet in $ip: $octet"
            exit 1
        fi
    done
    
    # SECURITY: Block dangerous IP ranges for Genesis nodes
    if [ "${OCTETS[0]}" -eq 127 ]; then
        echo "❌ Error: Localhost IP not allowed for Genesis nodes: $ip"
        exit 1
    fi
    
    if [ "${OCTETS[0]}" -eq 10 ] || \
       [ "${OCTETS[0]}" -eq 172 -a "${OCTETS[1]}" -ge 16 -a "${OCTETS[1]}" -le 31 ] || \
       [ "${OCTETS[0]}" -eq 192 -a "${OCTETS[1]}" -eq 168 ]; then
        echo "❌ Error: Private network IP not suitable for Genesis nodes: $ip"
        echo "🔒 Genesis nodes must be on public internet for global accessibility"
        exit 1
    fi
    
    if [ "${OCTETS[0]}" -ge 224 ]; then
        echo "❌ Error: Multicast/reserved IP range not allowed: $ip"
        exit 1
    fi
    
    if [ "${OCTETS[0]}" -eq 0 ] || [ "${OCTETS[0]}" -eq 255 ]; then
        echo "❌ Error: Invalid IP range: $ip"
        exit 1
    fi
done

echo "✅ IP validation passed"

# Method 1: Update environment variable (recommended for Docker/production)
echo ""
echo "🔧 Method 1: Environment Variable"
echo "Add this to your environment:"
echo "export QNET_GENESIS_NODES=\"$NEW_GENESIS_NODES\""

# Method 2: Create/update config file
echo ""
echo "🔧 Method 2: Config File"
cat > genesis-nodes.json << EOF
{
  "genesis_nodes": [
$(IFS=','; for ip in $NEW_GENESIS_NODES; do echo "    \"$ip\","; done | sed '$ s/,$//')
  ],
  "regions": {
$(IFS=','; i=0; for ip in $NEW_GENESIS_NODES; do 
    region="NorthAmerica"
    if [ $i -eq 1 ] || [ $i -eq 2 ] || [ $i -eq 3 ]; then
        region="Europe"
    fi
    echo "    \"$ip\": \"$region\","
    i=$((i+1))
done | sed '$ s/,$//')
  },
  "ports": {
    "api": 8001,
    "p2p": 9876,
    "rpc": 9877
  },
  "network": {
    "name": "QNet Genesis Bootstrap Network",
    "version": "1.0",
    "last_updated": "$(date -u +"%Y-%m-%d" 2>/dev/null || echo '2025-08-15')"
  }
}
EOF

echo "✅ Config file created: genesis-nodes.json"



# Test connectivity
echo ""
echo "🔍 Testing connectivity to new Genesis nodes..."
for ip in "${IPS[@]}"; do
    echo -n "  Testing $ip:8001... "
    if timeout 5 bash -c "</dev/tcp/$ip/8001" 2>/dev/null; then
        echo "✅ Online"
    else
        echo "❌ Offline (node may not be running yet)"
    fi
done

echo ""
echo "🚀 Genesis nodes update complete!"
echo ""
echo "Next steps:"
echo "1. Restart all QNet nodes to apply changes"
echo "2. Verify nodes connect to new Genesis network"
echo "3. Monitor logs for successful peer discovery"
echo ""
echo "To apply immediately:"
echo "  export QNET_GENESIS_NODES=\"$NEW_GENESIS_NODES\""
echo "  # Restart your QNet nodes"
