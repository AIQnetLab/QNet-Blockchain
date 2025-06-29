import { type NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// Node prices in 1DEV tokens - UNIVERSAL PRICING
const NODE_PRICES = {
  light: 1500,
  full: 1500,
  super: 1500
};

// QNet salt for deterministic generation
const QNET_SALT = "QNET_NODE_ACTIVATION_V1";

interface ActivationRequest {
  burnTx: string;
  wallet: string;
  nodeType: 'light' | 'full' | 'super';
}

export async function POST(request: NextRequest) {
  try {
    const body: ActivationRequest = await request.json();
    const { burnTx, wallet, nodeType } = body;

    // Validate input
    if (!burnTx || !wallet || !nodeType) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    if (!NODE_PRICES[nodeType]) {
      return NextResponse.json(
        { error: 'Invalid node type' },
        { status: 400 }
      );
    }

    // TODO: Verify burn transaction on Solana
    // For now, we'll skip this in development
    const burnAmount = NODE_PRICES[nodeType];
    
    // Generate deterministic seed (same as Python implementation)
    const entropyData = `${burnTx}:${wallet}:${nodeType}:${burnAmount}:${QNET_SALT}`;
    const fullHash = crypto.createHash('sha512').update(entropyData).digest();
    
    // Use first 32 bytes for entropy
    const entropy = fullHash.slice(0, 32);
    
    // Generate node ID from remaining bytes
    const nodeIdData = fullHash.slice(32);
    const nodeId = crypto.createHash('sha256').update(nodeIdData).digest('hex').slice(0, 16);
    
    // Note: For production, we would generate BIP39 mnemonic here
    // For now, return mock data
    const mockMnemonic = "quantum pulse energy ocean miracle sunset robot dance victory shield matrix code";
    
    // Generate installation script
    const installScript = generateInstallScript(burnTx, wallet, nodeType, nodeId);
    
    // Generate Docker command
    const dockerCommand = `docker run -e BURN_TX=${burnTx} -e WALLET=${wallet} -e NODE_TYPE=${nodeType} -e NODE_ID=${nodeId} qnet/node:latest`;
    
    // Return activation data
    // Note: In production, the mnemonic would be generated client-side
    return NextResponse.json({
      success: true,
      activationToken: burnTx, // Using burn tx as token for simplicity
      installScript,
      dockerCommand,
      nodeId,
      nodeType,
      // Don't send mnemonic from server in production!
      warning: "In production, seed phrase will be generated client-side for security"
    });

  } catch (error) {
    console.error('Activation error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

function generateInstallScript(burnTx: string, wallet: string, nodeType: string, nodeId: string): string {
  return `#!/bin/bash
# QNet Node Installation Script
# Generated for: ${wallet}
# Node Type: ${nodeType}
# Node ID: ${nodeId}

set -e

echo "🚀 QNet Node Installer"
echo "====================="
echo "Node Type: ${nodeType}"
echo "Node ID: ${nodeId}"
echo ""

# Check system requirements
echo "Checking system requirements..."
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    echo "Visit: https://docs.docker.com/get-docker/"
    exit 1
fi

# Create QNet directory
QNET_DIR="$HOME/.qnet"
mkdir -p "$QNET_DIR"
cd "$QNET_DIR"

# Save activation info
cat > activation.json << EOF
{
  "burnTx": "${burnTx}",
  "wallet": "${wallet}",
  "nodeType": "${nodeType}",
  "nodeId": "${nodeId}",
  "activatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# Pull latest QNet image
echo "Pulling QNet node image..."
docker pull qnet/node:latest

# Create docker-compose.yml
cat > docker-compose.yml << EOF
version: '3.8'
services:
  qnet-node:
    image: qnet/node:latest
    container_name: qnet-${nodeType}-${nodeId}
    restart: unless-stopped
    environment:
      - NODE_TYPE=${nodeType}
      - NODE_ID=${nodeId}
      - BURN_TX=${burnTx}
      - WALLET_ADDRESS=${wallet}
    volumes:
      - ./data:/data
      - ./logs:/logs
    ports:
      - "9876:9876"  # P2P port
      - "8545:8545"  # RPC port
      - "8546:8546"  # WebSocket port
    networks:
      - qnet
    
networks:
  qnet:
    driver: bridge
EOF

# Start the node
echo "Starting QNet node..."
docker-compose up -d

# Wait for node to start
echo "Waiting for node to initialize..."
sleep 10

# Check node status
if docker ps | grep -q "qnet-${nodeType}-${nodeId}"; then
    echo "✅ QNet node is running!"
    echo ""
    echo "Node ID: ${nodeId}"
    echo "Type: ${nodeType}"
    echo ""
    echo "View logs: docker logs qnet-${nodeType}-${nodeId}"
    echo "Stop node: cd $QNET_DIR && docker-compose down"
    echo ""
    echo "🎉 Installation complete!"
else
    echo "❌ Failed to start node. Check logs with:"
    echo "docker logs qnet-${nodeType}-${nodeId}"
    exit 1
fi
`;
} 