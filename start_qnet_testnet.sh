#!/bin/bash

# QNet Testnet Startup Script
# Production-ready blockchain network deployment

set -e

echo "🚀 QNet Testnet Startup Script"
echo "================================="
echo

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running. Please start Docker first.${NC}"
    exit 1
fi

# Check if Docker Compose is available
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker Compose is not installed.${NC}"
    exit 1
fi

echo -e "${BLUE}📋 Creating necessary directories...${NC}"

# Create data directories
mkdir -p genesis-data genesis-logs genesis-config
mkdir -p validator1-data validator1-logs validator1-config
mkdir -p validator2-data validator2-logs validator2-config
mkdir -p monitoring

# Set proper permissions
chmod 755 genesis-data genesis-logs genesis-config
chmod 755 validator1-data validator1-logs validator1-config
chmod 755 validator2-data validator2-logs validator2-config
chmod 755 monitoring

echo -e "${GREEN}✅ Directories created successfully${NC}"

# Create basic config files if they don't exist
echo -e "${BLUE}📝 Creating configuration files...${NC}"

# Genesis node config
cat > genesis-config/genesis.toml << EOF
[node]
type = "super"
network = "testnet"
data_dir = "/app/data"
log_dir = "/app/logs"

[p2p]
port = 9876
max_connections = 50

[rpc]
port = 8545
cors_allowed_origins = ["*"]

[consensus]
producer_enabled = true
genesis_node = true
free_genesis_activation = true

[logging]
level = "debug"
detailed_logging = true

[metrics]
enabled = true
port = 9090
EOF

# Validator 1 config
cat > validator1-config/validator1.toml << EOF
[node]
type = "full"
network = "testnet"
data_dir = "/app/data"
log_dir = "/app/logs"

[p2p]
port = 9877
max_connections = 50
bootstrap_nodes = ["genesis:9876"]

[rpc]
port = 8546
cors_allowed_origins = ["*"]

[consensus]
validator_enabled = true
free_genesis_activation = true

[logging]
level = "debug"
detailed_logging = true

[metrics]
enabled = true
port = 9091
EOF

# Validator 2 config
cat > validator2-config/validator2.toml << EOF
[node]
type = "full"
network = "testnet"
data_dir = "/app/data"
log_dir = "/app/logs"

[p2p]
port = 9878
max_connections = 50
bootstrap_nodes = ["genesis:9876", "validator1:9877"]

[rpc]
port = 8547
cors_allowed_origins = ["*"]

[consensus]
validator_enabled = true
free_genesis_activation = true

[logging]
level = "debug"
detailed_logging = true

[metrics]
enabled = true
port = 9092
EOF

echo -e "${GREEN}✅ Configuration files created${NC}"

# Stop existing containers
echo -e "${YELLOW}🛑 Stopping existing containers...${NC}"
docker compose -f docker-compose.production.yml down 2>/dev/null || true

# Remove orphaned containers
docker compose -f docker-compose.production.yml rm -f 2>/dev/null || true

echo -e "${BLUE}🔨 Building QNet production images...${NC}"
docker compose -f docker-compose.production.yml build

echo -e "${BLUE}🚀 Starting QNet Testnet...${NC}"
docker compose -f docker-compose.production.yml up -d

echo
echo -e "${GREEN}✅ QNet Testnet started successfully!${NC}"
echo
echo "📊 Network Information:"
echo "======================"
echo -e "${BLUE}Genesis Node (Super):${NC}"
echo "  - RPC API: http://localhost:8545"
echo "  - P2P Port: 9876"
echo "  - Metrics: http://localhost:9090/metrics"
echo
echo -e "${BLUE}Validator 1 (Full):${NC}"
echo "  - RPC API: http://localhost:8546"
echo "  - P2P Port: 9877"
echo "  - Metrics: http://localhost:9091/metrics"
echo
echo -e "${BLUE}Validator 2 (Full):${NC}"
echo "  - RPC API: http://localhost:8547"
echo "  - P2P Port: 9878"
echo "  - Metrics: http://localhost:9092/metrics"
echo
echo -e "${BLUE}Monitoring:${NC}"
echo "  - Prometheus: http://localhost:9093"
echo "  - Grafana: http://localhost:3000 (admin/qnet2025)"
echo
echo "🔍 Useful commands:"
echo "==================="
echo "  docker compose -f docker-compose.production.yml logs -f     # View all logs"
echo "  docker compose -f docker-compose.production.yml logs genesis # View genesis logs"
echo "  docker compose -f docker-compose.production.yml ps          # Check status"
echo "  docker compose -f docker-compose.production.yml down        # Stop testnet"
echo
echo -e "${GREEN}🎉 QNet Testnet is now running!${NC}"

# Wait for nodes to start
echo -e "${YELLOW}⏳ Waiting for nodes to initialize...${NC}"
sleep 30

# Check node status
echo -e "${BLUE}🔍 Checking node status...${NC}"
echo

# Check Genesis node
echo -n "Genesis Node: "
if curl -sf http://localhost:8545/health >/dev/null 2>&1; then
    echo -e "${GREEN}✅ Running${NC}"
else
    echo -e "${RED}❌ Not responding${NC}"
fi

# Check Validator 1
echo -n "Validator 1:  "
if curl -sf http://localhost:8546/health >/dev/null 2>&1; then
    echo -e "${GREEN}✅ Running${NC}"
else
    echo -e "${RED}❌ Not responding${NC}"
fi

# Check Validator 2
echo -n "Validator 2:  "
if curl -sf http://localhost:8547/health >/dev/null 2>&1; then
    echo -e "${GREEN}✅ Running${NC}"
else
    echo -e "${RED}❌ Not responding${NC}"
fi

echo
echo -e "${BLUE}📋 To view detailed logs, run:${NC}"
echo "  tail -f genesis-logs/qnet-node.log"
echo "  tail -f validator1-logs/qnet-node.log"
echo "  tail -f validator2-logs/qnet-node.log"
echo 