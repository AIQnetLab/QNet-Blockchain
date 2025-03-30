#!/bin/bash
# QNet installation script with enhanced security and storage features

set -e

# Colors for prettier output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}=============================================${NC}"
echo -e "${BLUE}       QNet Node Installation Script        ${NC}"
echo -e "${BLUE}=============================================${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}Note: Not running as root. Some operations might require sudo privileges.${NC}"
else
  echo -e "${GREEN}Running as root.${NC}"
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
    VER=$VERSION_ID
    echo -e "${GREEN}Detected OS: $OS $VER${NC}"
else
    echo -e "${YELLOW}Cannot determine OS, proceeding with generic installation.${NC}"
    OS="Unknown"
fi

# Determine project root directory
PROJECT_ROOT=$(pwd)
echo -e "${GREEN}Project root: $PROJECT_ROOT${NC}"

# Create data directories according to existing structure
echo -e "${BLUE}Creating data directories...${NC}"

# The path structure is based on the GitLab repository structure
DATA_DIR="$PROJECT_ROOT/data"
KEYS_DIR="$PROJECT_ROOT/keys"
SNAPSHOTS_DIR="$PROJECT_ROOT/snapshots"
LOGS_DIR="$PROJECT_ROOT/logs"
CONFIG_DIR="$PROJECT_ROOT/config"
BLOCKCHAIN_DATA_DIR="$PROJECT_ROOT/blockchain_data"

mkdir -p "$DATA_DIR" "$KEYS_DIR" "$SNAPSHOTS_DIR" "$LOGS_DIR" "$CONFIG_DIR" "$BLOCKCHAIN_DATA_DIR"
chmod 700 "$KEYS_DIR" # Secure permissions for keys

# Install system dependencies based on OS
echo -e "${BLUE}Installing system dependencies...${NC}"
if [[ "$OS" == *"Ubuntu"* ]] || [[ "$OS" == *"Debian"* ]]; then
    sudo apt-get update || { echo -e "${YELLOW}Warning: apt-get update failed, continuing...${NC}"; }
    sudo apt-get install -y python3 python3-pip python3-venv libsnappy-dev \
                       build-essential curl git libssl-dev pkg-config \
                       libffi-dev libbz2-dev liblz4-dev || \
    { echo -e "${YELLOW}Warning: Some packages might be missing. Trying to continue...${NC}"; }
    
    # Try to install RocksDB
    sudo apt-get install -y librocksdb-dev || \
    echo -e "${YELLOW}RocksDB package not found, will compile from Python package${NC}"
    
elif [[ "$OS" == *"CentOS"* ]] || [[ "$OS" == *"Red Hat"* ]] || [[ "$OS" == *"Fedora"* ]]; then
    sudo yum install -y python3 python3-pip gcc gcc-c++ make openssl-devel \
                   snappy-devel git curl pkgconfig libffi-devel bzip2-devel || \
    { echo -e "${YELLOW}Warning: Some packages might be missing. Trying to continue...${NC}"; }
    
    # Try to install RocksDB
    sudo yum install -y rocksdb-devel || \
    echo -e "${YELLOW}RocksDB package not found, will compile from Python package${NC}"
    
elif [[ "$OS" == *"Alpine"* ]]; then
    apk add --no-cache python3 py3-pip build-base snappy-dev openssl-dev \
            git curl pkgconfig libffi-dev bzip2-dev linux-headers || \
    { echo -e "${YELLOW}Warning: Some packages might be missing. Trying to continue...${NC}"; }
    
    # Try to install RocksDB
    apk add --no-cache rocksdb-dev || \
    echo -e "${YELLOW}RocksDB package not found, will compile from Python package${NC}"
    
else
    echo -e "${YELLOW}Unsupported OS for automatic dependency installation. Installing Python packages only.${NC}"
fi

# Set up Python virtual environment
echo -e "${BLUE}Setting up Python virtual environment...${NC}"
python3 -m venv venv
source venv/bin/activate

# Upgrade pip
echo -e "${BLUE}Upgrading pip...${NC}"
pip install --upgrade pip

# Install Python dependencies
echo -e "${BLUE}Installing Python dependencies...${NC}"
pip install wheel setuptools cffi # Base requirements for compilation

# Check if requirements.txt exists
if [ -f "requirements.txt" ]; then
    pip install -r requirements.txt || {
        echo -e "${YELLOW}Some packages failed to install. Trying alternative approach...${NC}"
        
        # Try installing RocksDB with specific version if it failed
        pip install python-rocksdb || pip install python-rocksdb==0.7.0 || {
            echo -e "${YELLOW}RocksDB installation failed. Will use memory storage by default.${NC}"
            export QNET_STORAGE_TYPE=memory
        }
        
        # Continue with the rest of the requirements
        grep -v "python-rocksdb" requirements.txt > requirements_no_rocksdb.txt
        pip install -r requirements_no_rocksdb.txt
        rm requirements_no_rocksdb.txt
    }
else
    echo -e "${YELLOW}requirements.txt not found. Installing core dependencies...${NC}"
    # Install minimal dependencies
    pip install Flask Werkzeug gunicorn requests pycryptodome PyJWT cryptography sortedcontainers psutil
    
    # Try to install RocksDB
    pip install python-rocksdb || {
        echo -e "${YELLOW}RocksDB installation failed. Will use memory storage by default.${NC}"
        export QNET_STORAGE_TYPE=memory
    }
fi

# Build Rust components if they exist
RUST_DIR="$PROJECT_ROOT/src/crypto/rust"
if [ -d "$RUST_DIR" ]; then
    echo -e "${BLUE}Building Rust components...${NC}"
    
    # Check if Rust is installed
    if command -v rustc &> /dev/null; then
        echo -e "${GREEN}Rust already installed.${NC}"
    else
        echo -e "${BLUE}Installing Rust...${NC}"
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        source $HOME/.cargo/env
    fi
    
    # Check if we have patches directory
    if [ -d "patches" ]; then
        # Apply patches if they exist
        if [ -f "patches/crypto.rs" ]; then
            cp "patches/crypto.rs" "$RUST_DIR/src/crypto.rs"
            echo -e "${GREEN}Applied crypto.rs patch${NC}"
        fi
        
        if [ -f "patches/merkle.rs" ]; then
            cp "patches/merkle.rs" "$RUST_DIR/src/merkle.rs"
            echo -e "${GREEN}Applied merkle.rs patch${NC}"
        fi
    fi
    
    # Build the Rust components
    cd "$RUST_DIR"
    if [ -f "build.sh" ]; then
        chmod +x build.sh
        ./build.sh || {
            echo -e "${RED}Error building Rust components.${NC}"
            echo -e "${YELLOW}Trying backup build method...${NC}"
            cd src
            rustc --crate-type=dylib crypto.rs
            rustc --crate-type=dylib merkle.rs
            rustc --crate-type=dylib -L . lib.rs
            mv *.so ../
            cd ..
        }
    else
        echo -e "${YELLOW}build.sh not found. Trying direct compilation...${NC}"
        cd src
        rustc --crate-type=dylib crypto.rs
        rustc --crate-type=dylib merkle.rs
        rustc --crate-type=dylib -L . lib.rs
        mv *.so ../
    fi
    
    cd "$PROJECT_ROOT"
else
    echo -e "${YELLOW}Rust components directory not found, skipping Rust build.${NC}"
fi

# Create default configuration if it doesn't exist
if [ ! -f "$CONFIG_DIR/config.ini" ]; then
    echo -e "${BLUE}Creating default configuration...${NC}"
    cat > "$CONFIG_DIR/config.ini" << EOF
[network]
network = testnet
external_ip = auto
port = 8000
dashboard_port = 8080

[storage]
storage_type = ${QNET_STORAGE_TYPE:-rocksdb}
data_dir = ${BLOCKCHAIN_DATA_DIR}
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
fi

# Set permissions
echo -e "${BLUE}Setting secure permissions...${NC}"
chmod -R 755 "$PROJECT_ROOT"
chmod -R 700 "$KEYS_DIR"
chmod 600 "$CONFIG_DIR/config.ini"

# Create startup script
echo -e "${BLUE}Creating startup script...${NC}"
cat > "$PROJECT_ROOT/start.sh" << 'EOF'
#!/bin/bash
source venv/bin/activate

# Check if we should start specific component
if [ "$1" == "node" ]; then
    python src/node/node.py
elif [ "$1" == "explorer" ]; then
    python src/website/app.py
else
    # Default: start node
    python src/node/node.py
fi
EOF
chmod +x "$PROJECT_ROOT/start.sh"

echo -e "${GREEN}Installation completed successfully!${NC}"
echo -e "${BLUE}=============================================${NC}"
echo -e "${BLUE}To start the node, run: ./start.sh${NC}"
echo -e "${BLUE}To start the explorer, run: ./start.sh explorer${NC}"
echo -e "${BLUE}or if using Docker: docker-compose up -d${NC}"
echo -e "${BLUE}=============================================${NC}"