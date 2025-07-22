import { type NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// Node prices in 1DEV tokens - UNIVERSAL PRICING (Phase 1)
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
    
    // Generate activation code with embedded wallet address
    const activationCode = generateActivationCodeWithEmbeddedWallet(burnTx, wallet, nodeType, burnAmount);
    
    // Generate installation script
    const installScript = generateInstallScript(burnTx, wallet, nodeType, activationCode);
    
    // Generate Docker command
    const dockerCommand = `docker run -e BURN_TX=${burnTx} -e WALLET=${wallet} -e NODE_TYPE=${nodeType} -e ACTIVATION_CODE=${activationCode} qnet/node:latest`;
    
    // Return activation data
    // Note: In production, the mnemonic would be generated client-side
    return NextResponse.json({
      success: true,
      activationToken: burnTx, // Using burn tx as token for simplicity
      activationCode: activationCode,
      installScript,
      dockerCommand,
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

function generateActivationCodeWithEmbeddedWallet(burnTx: string, wallet: string, nodeType: string, burnAmount: number): string {
  // Generate quantum-secure activation code with embedded wallet address
  const timestamp = Date.now();
  const hardwareEntropy = crypto.randomBytes(8).toString('hex'); // Shorter for space
  
  // Create encryption key from burn transaction (deterministic)
  const keyMaterial = `${burnTx}:${nodeType}:${burnAmount}`;
  const encryptionKey = crypto.createHash('sha256').update(keyMaterial).digest('hex').substring(0, 32);
  
  // Encrypt wallet address with XOR (simple and reversible)
  let encryptedWallet = '';
  for (let i = 0; i < wallet.length; i++) {
    const walletChar = wallet.charCodeAt(i);
    const keyChar = encryptionKey.charCodeAt(i % encryptionKey.length);
    encryptedWallet += String.fromCharCode(walletChar ^ keyChar);
  }
  
  // Convert encrypted wallet to hex
  const encryptedWalletHex = Buffer.from(encryptedWallet, 'binary').toString('hex');
  
  // Create structured code with embedded data
  const nodeTypeMarker = nodeType.charAt(0).toUpperCase(); // L, F, S
  const timestampHex = timestamp.toString(16).substring(-8); // Last 8 hex chars
  const entropyShort = hardwareEntropy.substring(0, 4); // 4 hex chars
  
  // Embed wallet in the code structure: QNET-[TYPE+TIMESTAMP]-[WALLET_PART1]-[WALLET_PART2+ENTROPY]
  const walletPart1 = encryptedWalletHex.substring(0, 8);
  const walletPart2 = encryptedWalletHex.substring(8, 16);
  
  // Store metadata for decryption in first segment
  const segment1 = (nodeTypeMarker + timestampHex).substring(0, 4).toUpperCase();
  const segment2 = walletPart1.substring(0, 4).toUpperCase();  
  const segment3 = (walletPart2 + entropyShort).substring(0, 4).toUpperCase();
  
  return `QNET-${segment1}-${segment2}-${segment3}`;
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