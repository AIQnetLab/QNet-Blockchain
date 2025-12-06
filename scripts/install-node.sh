#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# QNET Node Installer for Full & Super Nodes
# Version: 2.19.22
# ═══════════════════════════════════════════════════════════════════════════════
#
# This script installs Full or Super nodes (NOT Genesis nodes).
# Requirements:
#   - Activation code (purchased via 1DEV token burn)
#   - Docker installed
#   - Server with public IP
#
# Usage: ./install-node.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

clear
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}${BOLD}                    🚀 QNET NODE INSTALLER v2.19.22                           ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}This installer will set up a Full or Super node on your server.${NC}"
echo -e "${CYAN}You need an activation code from https://qnet.io${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Pre-flight checks
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}📋 Pre-flight Checks${NC}"
echo ""

# Check if running as root or with sudo
if [ "$EUID" -ne 0 ]; then
    echo -e "${YELLOW}⚠️  Some operations require root privileges${NC}"
    echo -e "${YELLOW}   You may be prompted for sudo password${NC}"
    echo ""
fi

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed!${NC}"
    echo ""
    echo "Install Docker first:"
    echo "  curl -fsSL https://get.docker.com | sh"
    echo "  sudo usermod -aG docker \$USER"
    echo ""
    exit 1
else
    echo -e "${GREEN}✅ Docker installed${NC}"
fi

# Check Docker is running
if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Docker daemon is not running!${NC}"
    echo "Start Docker: sudo systemctl start docker"
    exit 1
else
    echo -e "${GREEN}✅ Docker daemon running${NC}"
fi

# Check qnet-production image exists
if ! docker images | grep -q "qnet-production"; then
    echo -e "${YELLOW}⚠️  qnet-production image not found${NC}"
    echo ""
    read -p "Do you want to build the image now? (y/N): " BUILD_IMAGE
    if [[ "$BUILD_IMAGE" =~ ^[Yy]$ ]]; then
        echo "Building qnet-production image..."
        if [ -f "development/qnet-integration/Dockerfile.production" ]; then
            docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .
        else
            echo -e "${RED}❌ Dockerfile.production not found!${NC}"
            echo "Please run this script from QNet project root directory"
            exit 1
        fi
    else
        echo -e "${RED}❌ Cannot continue without qnet-production image${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✅ qnet-production image found${NC}"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: Select Node Type
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}📋 Step 1: Select Node Type${NC}"
echo ""
echo -e "${BOLD}Available node types:${NC}"
echo ""
echo "  ${CYAN}1) Full Node${NC}"
echo "     • Validates and stores blockchain"
echo "     • Participates in consensus"
echo "     • Medium hardware requirements"
echo "     • Lower activation cost"
echo ""
echo "  ${CYAN}2) Super Node${NC}"
echo "     • Full blockchain validation"
echo "     • Block production eligible"
echo "     • High hardware requirements (8+ cores, 32GB+ RAM)"
echo "     • Higher rewards, higher activation cost"
echo ""

while true; do
    read -p "Select node type (1 or 2): " NODE_TYPE_CHOICE
    case $NODE_TYPE_CHOICE in
        1)
            NODE_TYPE="full"
            NODE_TYPE_DISPLAY="Full Node"
            break
            ;;
        2)
            NODE_TYPE="super"
            NODE_TYPE_DISPLAY="Super Node"
            break
            ;;
        *)
            echo -e "${RED}Invalid choice. Please enter 1 or 2${NC}"
            ;;
    esac
done

echo ""
echo -e "${GREEN}✅ Selected: ${NODE_TYPE_DISPLAY}${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2: Enter Activation Code
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}📋 Step 2: Enter Activation Code${NC}"
echo ""
echo -e "${CYAN}Your activation code should look like: QNET-XXXXXX-XXXXXX-XXXXXX${NC}"
echo -e "${CYAN}You can get one at: https://qnet.io/activate${NC}"
echo ""

while true; do
    read -p "Activation Code: " ACTIVATION_CODE
    
    # Validate format (basic check)
    if [[ "$ACTIVATION_CODE" =~ ^QNET-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$ ]]; then
        echo -e "${GREEN}✅ Activation code format valid${NC}"
        break
    else
        echo -e "${RED}❌ Invalid format. Expected: QNET-XXXXXX-XXXXXX-XXXXXX${NC}"
        echo ""
    fi
done

echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3: Configure Node Name
# ═══════════════════════════════════════════════════════════════════════════════
# NOTE: Wallet address is automatically extracted from the activation code!
# The code contains encrypted: wallet, burn_tx, node_type, phase
# Same mnemonic for SOL and QNET → wallet is already linked to the code
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}📋 Step 3: Node Configuration${NC}"
echo ""

# Generate default node name
DEFAULT_NODE_NAME="qnet-${NODE_TYPE}-$(hostname | cut -c1-8)"
read -p "Node name (default: $DEFAULT_NODE_NAME): " NODE_NAME
NODE_NAME=${NODE_NAME:-$DEFAULT_NODE_NAME}

# Sanitize node name (remove special chars, lowercase)
NODE_NAME=$(echo "$NODE_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')

echo -e "${GREEN}✅ Node name: $NODE_NAME${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 4: Data Directory
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}📋 Step 4: Data Directory${NC}"
echo ""

DEFAULT_DATA_DIR="$(pwd)/${NODE_NAME}_data"
read -p "Data directory (default: $DEFAULT_DATA_DIR): " DATA_DIR
DATA_DIR=${DATA_DIR:-$DEFAULT_DATA_DIR}

mkdir -p "$DATA_DIR"
echo -e "${GREEN}✅ Data directory: $DATA_DIR${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 5: Open Firewall Ports
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}📋 Step 5: Firewall Configuration${NC}"
echo ""
echo "Opening required ports..."

# Check if iptables is available
if command -v iptables &> /dev/null; then
    # TCP ports (use -C to check if rule exists, add only if not)
    sudo iptables -C INPUT -p tcp --dport 8001 -j ACCEPT 2>/dev/null || sudo iptables -A INPUT -p tcp --dport 8001 -j ACCEPT
    sudo iptables -C INPUT -p tcp --dport 9876 -j ACCEPT 2>/dev/null || sudo iptables -A INPUT -p tcp --dport 9876 -j ACCEPT
    sudo iptables -C INPUT -p tcp --dport 9877 -j ACCEPT 2>/dev/null || sudo iptables -A INPUT -p tcp --dport 9877 -j ACCEPT
    
    # UDP port for QUIC (CRITICAL!)
    sudo iptables -C INPUT -p udp --dport 10876 -j ACCEPT 2>/dev/null || sudo iptables -A INPUT -p udp --dport 10876 -j ACCEPT
    
    echo -e "${GREEN}✅ Firewall ports opened:${NC}"
    echo "   TCP: 8001 (API), 9876 (P2P), 9877 (Gossip)"
    echo "   UDP: 10876 (QUIC) - ${BOLD}CRITICAL for block sync!${NC}"
else
    echo -e "${YELLOW}⚠️  iptables not found. Please manually open ports:${NC}"
    echo "   TCP: 8001, 9876, 9877"
    echo "   UDP: 10876"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 6: Stop existing container if running
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}📋 Step 6: Container Setup${NC}"
echo ""

if docker ps -a --format '{{.Names}}' | grep -q "^${NODE_NAME}$"; then
    echo "Found existing container: $NODE_NAME"
    read -p "Stop and remove it? (Y/n): " REMOVE_EXISTING
    REMOVE_EXISTING=${REMOVE_EXISTING:-Y}
    
    if [[ "$REMOVE_EXISTING" =~ ^[Yy]$ ]]; then
        docker stop "$NODE_NAME" 2>/dev/null || true
        docker rm "$NODE_NAME" 2>/dev/null || true
        echo -e "${GREEN}✅ Old container removed${NC}"
    else
        echo -e "${RED}❌ Cannot continue with existing container${NC}"
        exit 1
    fi
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 7: Review and Confirm
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}📋 Configuration Summary${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Node Type:        ${CYAN}${NODE_TYPE_DISPLAY}${NC}"
echo -e "  Node Name:        ${CYAN}${NODE_NAME}${NC}"
echo -e "  Activation Code:  ${CYAN}${ACTIVATION_CODE:0:10}...${NC}"
echo -e "  Wallet:           ${CYAN}(extracted from activation code)${NC}"
echo -e "  Data Directory:   ${CYAN}${DATA_DIR}${NC}"
echo ""
echo -e "  Ports:"
echo -e "    API:     ${CYAN}8001${NC}"
echo -e "    P2P:     ${CYAN}9876${NC}"
echo -e "    Gossip:  ${CYAN}9877${NC}"
echo -e "    QUIC:    ${CYAN}10876/udp${NC}"
echo ""

read -p "Start the node with these settings? (Y/n): " CONFIRM
CONFIRM=${CONFIRM:-Y}

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Installation cancelled.${NC}"
    exit 0
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 8: Launch Container
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}📋 Step 8: Launching Node${NC}"
echo ""

docker run -d \
    --name "$NODE_NAME" \
    --restart=always \
    -e QNET_PRODUCTION=1 \
    -e DOCKER_ENV=1 \
    -e QNET_ACTIVATION_CODE="$ACTIVATION_CODE" \
    -e QNET_NODE_TYPE="$NODE_TYPE" \
    -p 8001:8001 \
    -p 9876:9876 \
    -p 9877:9877 \
    -p 10876:10876/udp \
    -v "$DATA_DIR":/app/data \
    qnet-production

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}✅ NODE INSTALLATION COMPLETE!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Container:  ${CYAN}$NODE_NAME${NC}"
echo -e "  Type:       ${CYAN}$NODE_TYPE_DISPLAY${NC}"
echo -e "  Data:       ${CYAN}$DATA_DIR${NC}"
echo ""
echo -e "${YELLOW}📊 Useful Commands:${NC}"
echo ""
echo "  View logs:         docker logs -f $NODE_NAME"
echo "  Check status:      docker ps | grep $NODE_NAME"
echo "  Health check:      curl http://localhost:8001/api/v1/node/health"
echo "  Node info:         curl http://localhost:8001/api/v1/node/info"
echo "  Stop node:         docker stop $NODE_NAME"
echo "  Start node:        docker start $NODE_NAME"
echo "  Restart node:      docker restart $NODE_NAME"
echo ""
echo -e "${YELLOW}⏳ The node will take 30-60 seconds to initialize and connect to the network.${NC}"
echo ""
echo -e "${CYAN}Need help? Visit: https://x.com/AIQnetLab${NC}"
echo ""