#!/bin/bash
# Enhanced build and run script for QNet with improved error handling

set -e

# Colors for prettier output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}=============================================${NC}"
echo -e "${GREEN}QNet is now running!${NC}"
echo -e "${BLUE}API: https://localhost/api/${NC}"
echo -e "${BLUE}Dashboard: https://localhost/dashboard/${NC}"
echo -e "${BLUE}Explorer: https://localhost/${NC}"
echo -e "${BLUE}=============================================${NC}"
echo -e "${YELLOW}Note: Using self-signed certificates. You may see browser warnings.${NC}"
echo -e "${BLUE}To view logs: docker-compose logs -f${NC}"
echo -e "${BLUE}To stop: docker-compose down${NC}"
echo -e "${BLUE}=============================================${NC}"
NC}"
echo -e "${BLUE}     QNet Node Build and Run Script         ${NC}"
echo -e "${BLUE}=============================================${NC}"

# Determine project root directory
PROJECT_ROOT=$(pwd)
echo -e "${GREEN}Project root: $PROJECT_ROOT${NC}"

# Check if docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

# Check if docker-compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}Docker Compose is not installed. Please install Docker Compose first.${NC}"
    exit 1
fi

# Create necessary directories if they don't exist
echo -e "${BLUE}Creating necessary directories...${NC}"
mkdir -p data blockchain_data keys snapshots logs config

# Check if patches directory exists
if [ ! -d "patches" ]; then
    echo -e "${YELLOW}Patches directory not found. Creating it...${NC}"
    mkdir -p patches
fi

# Check if required patch files exist
if [ ! -f "patches/crypto.rs" ] || [ ! -f "patches/merkle.rs" ]; then
    echo -e "${YELLOW}Required patch files not found in patches directory.${NC}"
    echo -e "${YELLOW}Please ensure patches/crypto.rs and patches/merkle.rs exist.${NC}"
fi

# Copy storage_factory.py to the appropriate directory if available
if [ -f "storage_factory.py" ]; then
    mkdir -p src/storage
    cp storage_factory.py src/storage/
    echo -e "${GREEN}Copied storage_factory.py to src/storage/${NC}"
fi

# Check if docker directory exists, create if not
if [ ! -d "docker" ]; then
    echo -e "${YELLOW}Docker directory not found. Creating it...${NC}"
    mkdir -p docker/nginx/conf.d docker/nginx/ssl
fi

# Create nginx configuration if needed
if [ ! -f "docker/nginx/conf.d/qnet.conf" ]; then
    echo -e "${BLUE}Creating NGINX configuration...${NC}"
    cat > docker/nginx/conf.d/qnet.conf << EOF
# Default NGINX configuration for QNet
server {
    listen 80;
    server_name localhost;

    # Redirect HTTP to HTTPS
    location / {
        return 301 https://\$host\$request_uri;
    }

    # Health check endpoint
    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }
}

server {
    listen 443 ssl;
    server_name localhost;

    ssl_certificate /etc/nginx/ssl/qnet.crt;
    ssl_certificate_key /etc/nginx/ssl/qnet.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # API proxy
    location /api/ {
        proxy_pass http://qnet-node:8000/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Dashboard proxy
    location /dashboard/ {
        proxy_pass http://qnet-node:8080/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Explorer proxy
    location / {
        proxy_pass http://qnet-explorer:5000/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Health check endpoint
    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }
}
EOF
    echo -e "${GREEN}Created NGINX configuration${NC}"
fi

# Check for HTTPS configuration
if [ ! -f "docker/nginx/ssl/qnet.crt" ] || [ ! -f "docker/nginx/ssl/qnet.key" ]; then
    echo -e "${YELLOW}SSL certificates not found. Creating self-signed certificates for HTTPS...${NC}"
    
    # Create OpenSSL configuration with proper SAN
    cat > docker/nginx/ssl_config.cnf << EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
ST = State
L = City
O = QNet
CN = localhost

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
EOF

    # Create certificates
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout docker/nginx/ssl/qnet.key -out docker/nginx/ssl/qnet.crt \
        -config docker/nginx/ssl_config.cnf
    
    # Clean up
    rm docker/nginx/ssl_config.cnf
    
    echo -e "${GREEN}Created self-signed certificates${NC}"
fi

# Check if config exists, create default if not
if [ ! -f "config/config.ini" ]; then
    echo -e "${BLUE}Creating default configuration...${NC}"
    cat > config/config.ini << EOF
[network]
network = testnet
external_ip = auto
port = 8000
dashboard_port = 8080

[storage]
storage_type = rocksdb
data_dir = /app/blockchain_data
memory_limit_mb = 512
use_compression = true

[consensus]
commit_window_seconds = 60
reveal_window_seconds = 30
min_reveals_ratio = 0.67
token_verification_required = true

[security]
key_rotation_days = 90
tls_required = true
validate_hostnames = true

[monitoring]
enabled = true
metrics_interval_seconds = 10
prometheus_enabled = false
prometheus_port = 9090

[node]
mining_enabled = true
mining_threads = 1
auto_discovery = true
max_peers = 50
EOF
    echo -e "${GREEN}Created default configuration in config/config.ini${NC}"
fi

# Check for Docker Compose file
if [ ! -f "docker-compose.yml" ]; then
    echo -e "${YELLOW}docker-compose.yml not found. Using default configuration...${NC}"
    if [ -f "docker_compose_adapted" ]; then
        cp docker_compose_adapted docker-compose.yml
        echo -e "${GREEN}Copied adapted docker-compose.yml${NC}"
    else
        echo -e "${RED}No docker-compose.yml template found. Please create one.${NC}"
        exit 1
    fi
fi

# Check for Dockerfile
if [ ! -f "docker/Dockerfile" ]; then
    echo -e "${YELLOW}docker/Dockerfile not found. Using default configuration...${NC}"
    mkdir -p docker
    if [ -f "dockerfile_adapted" ]; then
        cp dockerfile_adapted docker/Dockerfile
        echo -e "${GREEN}Copied adapted Dockerfile${NC}"
    else
        echo -e "${RED}No Dockerfile template found. Please create one.${NC}"
        exit 1
    fi
fi

# Build and start the containers
echo -e "${BLUE}Building and starting QNet containers...${NC}"
docker-compose build
if [ $? -ne 0 ]; then
    echo -e "${RED}Error building containers.${NC}"
    exit 1
fi

docker-compose up -d
if [ $? -ne 0 ]; then
    echo -e "${RED}Error starting containers.${NC}"
    exit 1
fi

# Check container status
echo -e "${BLUE}Checking container status...${NC}"
sleep 5  # Give containers time to start

# Check if containers are running
for container in qnet-node qnet-explorer nginx; do
    if [ "$(docker-compose ps -q $container)" ] && [ "$(docker inspect -f {{.State.Running}} $(docker-compose ps -q $container))" = "true" ]; then
        echo -e "${GREEN}$container is running.${NC}"
    else
        echo -e "${RED}$container failed to start properly. Check logs:${NC}"
        docker-compose logs $container
    fi
done

echo -e "${BLUE}=============================================${NC}"
echo -e "${GREEN}QNet is now running!${NC}"
echo -e "${BLUE}API: https://localhost/api/${NC}"
echo -e "${BLUE}Dashboard: https://localhost/dashboard/${NC}"
echo -e "${BLUE}Explorer: https://localhost/${NC}"
echo -e "${BLUE}=============================================${NC}"
echo -e "${YELLOW}Note: Using self-signed certificates. You may see browser warnings.${NC}"
echo -e "${BLUE}To view logs: docker-compose logs -f${NC}"
echo -e "${BLUE}To stop: docker-compose down${NC}"
echo -e "${BLUE}=============================================${