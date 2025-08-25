# File: QNet-Project/qnet-node/scripts/install/install.sh
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

# Determine project root directory (assuming script is run from project root)
PROJECT_ROOT=$(pwd)
echo -e "${GREEN}Project root: $PROJECT_ROOT${NC}"

# Create data directories based on structure (align with config.ini defaults)
echo -e "${BLUE}Creating necessary directories...${NC}"
DATA_DIR="$PROJECT_ROOT/data"                 # General data for node/explorer
KEYS_DIR="$PROJECT_ROOT/keys"                 # Node cryptographic keys
SNAPSHOTS_DIR="$PROJECT_ROOT/snapshots"         # Blockchain snapshots / Memory checkpoints
LOGS_DIR="$PROJECT_ROOT/logs"                 # Log files
CONFIG_DIR="$PROJECT_ROOT/config"               # Config files
BLOCKCHAIN_DATA_DIR="$PROJECT_ROOT/blockchain_data" # Actual chain data (RocksDB/SQLite)

mkdir -p "$DATA_DIR" "$KEYS_DIR" "$SNAPSHOTS_DIR" "$LOGS_DIR" "$CONFIG_DIR" "$BLOCKCHAIN_DATA_DIR"
chmod 700 "$KEYS_DIR" # Secure permissions for keys

# Install system dependencies based on OS
echo -e "${BLUE}Installing system dependencies...${NC}"
if [[ "$OS" == *"Ubuntu"* ]] || [[ "$OS" == *"Debian"* ]]; then
    sudo apt-get update || { echo -e "${YELLOW}Warning: apt-get update failed, continuing...${NC}"; }
    # Added librocksdb-dev
    sudo apt-get install -y python3 python3-pip python3-venv libsnappy-dev \
                       build-essential curl git libssl-dev pkg-config \
                       libffi-dev libbz2-dev liblz4-dev librocksdb-dev || \
    { echo -e "${YELLOW}Warning: Some system packages might be missing or failed to install. Trying to continue...${NC}"; }
elif [[ "$OS" == *"CentOS"* ]] || [[ "$OS" == *"Red Hat"* ]] || [[ "$OS" == *"Fedora"* ]]; then
    # Added rocksdb-devel
    sudo yum install -y python3 python3-pip gcc gcc-c++ make openssl-devel \
                   snappy-devel git curl pkgconfig libffi-devel bzip2-devel rocksdb-devel || \
    { echo -e "${YELLOW}Warning: Some system packages might be missing or failed to install. Trying to continue...${NC}"; }
elif [[ "$OS" == *"Alpine"* ]]; then
    # Added rocksdb-dev
    apk add --no-cache python3 py3-pip build-base snappy-dev openssl-dev \
            git curl pkgconfig libffi-dev bzip2-dev linux-headers rocksdb-dev || \
    { echo -e "${YELLOW}Warning: Some system packages might be missing or failed to install. Trying to continue...${NC}"; }
else
    echo -e "${YELLOW}Unsupported OS for automatic dependency installation. You may need to install dependencies manually (python3, pip, venv, git, build tools, librocksdb, etc.).${NC}"
fi

# Set up Python virtual environment
echo -e "${BLUE}Setting up Python virtual environment (./venv)...${NC}"
python3 -m venv venv
source venv/bin/activate

# Upgrade pip
echo -e "${BLUE}Upgrading pip...${NC}"
pip install --upgrade pip

# Install Python dependencies
echo -e "${BLUE}Installing Python dependencies...${NC}"
pip install wheel setuptools cffi # Base requirements for compilation

# Correct path to requirements.txt inside qnet-node
REQUIREMENTS_FILE="$PROJECT_ROOT/qnet-node/requirements.txt"
QNET_STORAGE_TYPE_DEFAULT="memory" # Default to memory if rocksdb fails

if [ -f "$REQUIREMENTS_FILE" ]; then
    pip install -r "$REQUIREMENTS_FILE" || {
        echo -e "${YELLOW}Some packages failed to install from $REQUIREMENTS_FILE.${NC}"
        # Specifically check rocksdb
        if ! pip show python-rocksdb &> /dev/null; then
             echo -e "${YELLOW}Attempting to install python-rocksdb separately...${NC}"
             pip install python-rocksdb || pip install python-rocksdb==0.7.0 || {
                 echo -e "${RED}python-rocksdb installation failed.${NC}"
                 echo -e "${YELLOW}Ensure system library 'librocksdb-dev' or 'rocksdb-devel' is installed.${NC}"
                 echo -e "${YELLOW}Falling back to memory storage.${NC}"
                 QNET_STORAGE_TYPE_DEFAULT="memory"
             }
        fi
        # Optionally try installing others again if needed
    }
    # Check if rocksdb was installed successfully, otherwise set default
    if pip show python-rocksdb &> /dev/null; then
        QNET_STORAGE_TYPE_DEFAULT="rocksdb"
    fi
else
    echo -e "${RED}ERROR: $REQUIREMENTS_FILE not found! Cannot install Python dependencies.${NC}"
    echo -e "${YELLOW}Attempting to install minimal core dependencies...${NC}"
    pip install Flask Werkzeug requests pycryptodome psutil cryptography sortedcontainers
    # Still try rocksdb, but default to memory if it fails
    pip install python-rocksdb || { echo -e "${YELLOW}python-rocksdb failed, defaulting storage to memory.${NC}"; QNET_STORAGE_TYPE_DEFAULT="memory"; }
    if pip show python-rocksdb &> /dev/null; then QNET_STORAGE_TYPE_DEFAULT="rocksdb"; fi
fi

# Build Rust components if they exist
# Correct path to Rust source directory
RUST_DIR="$PROJECT_ROOT/qnet-core/src/crypto/rust"
if [ -d "$RUST_DIR" ]; then
    echo -e "${BLUE}Building Rust components in $RUST_DIR...${NC}"

    # Check if Rust is installed
    if ! command -v cargo &> /dev/null; then
        echo -e "${YELLOW}Rust (cargo) not found. Attempting to install Rust via rustup...${NC}"
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        # Source Cargo environment, handle potential path issues
        if [ -f "$HOME/.cargo/env" ]; then
            source "$HOME/.cargo/env"
        elif [ -f "$HOME/.profile" ]; then
            source "$HOME/.profile" # Fallback for some shells
        else
             echo -e "${YELLOW}WARNING: Could not automatically source Rust environment.${NC}"
             echo -e "${YELLOW}You may need to run 'source \$HOME/.cargo/env' or restart your terminal before running the node.${NC}"
        fi
        # Verify cargo is now available
        if ! command -v cargo &> /dev/null; then
            echo -e "${RED}ERROR: cargo command not found even after attempting install.${NC}"
            exit 1
        fi
    else
         echo -e "${GREEN}Rust (cargo) found.${NC}"
    fi

    # Build the Rust components using Cargo
    cd "$RUST_DIR"
    if [ -f "Cargo.toml" ]; then
        echo "Running cargo build --release..."
        cargo build --release || {
            echo -e "${RED}Cargo build failed.${NC}"
            exit 1
        }
        # Determine expected library name based on Cargo.toml (usually based on [lib] name=...)
        # Assuming libqnet_core as the library name defined in Cargo.toml
        LIB_NAME="qnet_core" # Adjust if lib name in Cargo.toml is different
        # Find the compiled library file (handle .so, .dylib, .dll)
        LIB_FILE=$(find target/release -maxdepth 1 \( -name "lib${LIB_NAME}.so" -o -name "lib${LIB_NAME}.dylib" -o -name "${LIB_NAME}.dll" \) -print -quit)

        if [ -n "$LIB_FILE" ] && [ -f "$LIB_FILE" ]; then
             # Correct destination: Place it alongside the core Python crypto bindings
             DEST_LIB_DIR="$PROJECT_ROOT/qnet-core/src/crypto"
             mkdir -p "$DEST_LIB_DIR"
             cp "$LIB_FILE" "$DEST_LIB_DIR/"
             echo -e "${GREEN}Copied Rust library $(basename $LIB_FILE) to $DEST_LIB_DIR ${NC}"
        else
             echo -e "${RED}Could not find compiled Rust library (expected lib${LIB_NAME}.*) in target/release${NC}"
             # List contents for debugging, but don't exit unless Rust is mandatory
             ls -l target/release
             # exit 1 # Make this optional?
        fi
    else
         echo -e "${RED}Cargo.toml not found in $RUST_DIR. Cannot build Rust components.${NC}"
         # exit 1 # Make this optional?
    fi
    cd "$PROJECT_ROOT" # Return to project root
else
    echo -e "${YELLOW}Rust components directory not found ($RUST_DIR), skipping Rust build.${NC}"
fi


# Create default configuration if it doesn't exist
# Correct path to config.ini
CONFIG_FILE="$CONFIG_DIR/config.ini"
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${BLUE}Creating default configuration at $CONFIG_FILE...${NC}"
    # Use determined default storage type
    cat > "$CONFIG_FILE" << EOF
[System]
log_level = INFO

[App]
version = 0.1.0

[Node]
node_id = qnode-$(hostname)-$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 4)
mining_enabled = true
mining_threads = 1
max_pending_tx = 5000
max_block_size_kb = 500
min_fee = 0.0001

[Network]
network = testnet
external_ip = auto
port = 8000
dashboard_port = 8080
bootstrap_nodes = 95.164.7.199:8000,173.212.219.226:8000
max_peers = 50
min_peers = 3
auto_discovery = true
use_upnp = false
use_broadcast = true
discovery_interval = 300
connection_timeout = 5
behind_proxy = false

[Storage]
storage_type = ${QNET_STORAGE_TYPE_DEFAULT}
data_dir = ${BLOCKCHAIN_DATA_DIR} # Use variable defined earlier
memory_limit_mb = 512
use_compression = true

[Consensus]
commit_window_seconds = 60
reveal_window_seconds = 30
min_reveals_ratio = 0.67
target_round_time_seconds = 60
difficulty_adjustment_window = 10
min_participants = 3

[Security]
flask_secret_key = $(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 24)
key_rotation_days = 90
tls_required = false
validate_hostnames = true
sybil_resistance_enabled = true
# database_key = GENERATE_A_SECURE_KEY_HERE

[Authentication]
verification_enabled = true
test_mode = true
wallet_address = test_wallet1
# solana_network = devnet
# receiver_address = YOUR_SOLANA_RECEIVER_ADDRESS
# token_contract = YOUR_SPL_TOKEN_ADDRESS
# min_balance = 1

[Reputation]
default_reputation = 70.0
history_size = 100
min_data_points = 5
weight_participation = 0.4
weight_response_time = 0.3
weight_block_quality = 0.3
decay_factor = 0.95
penalty_invalid_reveal = 0.2
penalty_mining_failure = 0.1
reward_participation = 0.05
reward_leader = 0.1
regression_factor = 0.95
smoothing_factor = 0.2

[EnhancedConsensus]
# enabled = true # Set by activate script if used
reputation_influence = 0.7
adaptive_timing = true
partition_detection = true
safety_factor = 1.5
detection_interval = 300
recovery_cooldown = 600

[Monitoring]
enabled = true
metrics_interval_seconds = 10
prometheus_enabled = false
prometheus_port = 9090
# webhook_url = YOUR_ALERT_WEBHOOK_URL

[Sync]
sync_mode = full
checkpoint_verification = true
max_parallel_downloads = 5
fast_sync_threshold = 1000
sync_batch_size = 100
headers_batch_size = 500
blocks_batch_size = 50
# trusted_checkpoints = 0:GENESIS_HASH_HERE,10000:HASH_HERE

[Snapshots]
auto_snapshot_enabled = true
retention_days = 7
min_keep_count = 3
cleanup_frequency_sec = 86400

[Checkpoints]
auto_create_enabled = true
creation_interval_blocks = 1000
check_frequency_sec = 3600
EOF
    echo -e "${GREEN}Created default configuration file.${NC}"
else
    echo -e "${YELLOW}Config file $CONFIG_FILE already exists, skipping creation.${NC}"
fi


# Set permissions
echo -e "${BLUE}Setting permissions...${NC}"
# Ensure correct ownership if run with sudo
if [ "$EUID" -eq 0 ] && [ -n "$SUDO_USER" ]; then
    OWNER_GROUP="$SUDO_USER:$SUDO_GROUP"
    chown -R $OWNER_GROUP "$PROJECT_ROOT"
    echo -e "${YELLOW}Changed ownership to $OWNER_GROUP ${NC}"
fi
# Executable scripts
chmod 755 "$PROJECT_ROOT/scripts/start.sh" "$PROJECT_ROOT/scripts/build_rust.sh" "$PROJECT_ROOT/scripts/build_and_run.sh"
# Python source files (read/write for owner, read for group/others)
find "$PROJECT_ROOT/qnet-core/src" -type f -name "*.py" -exec chmod 644 {} \;
find "$PROJECT_ROOT/qnet-node/src" -type f -name "*.py" -exec chmod 644 {} \;
find "$PROJECT_ROOT/qnet-explorer/src" -type f -name "*.py" -exec chmod 644 {} \;
# Secure directories/files
chmod 700 "$KEYS_DIR"
chmod 600 "$CONFIG_FILE"

# Create startup script (assuming it's placed in project root)
echo -e "${BLUE}Creating startup script (start.sh)...${NC}"
cat > "$PROJECT_ROOT/start.sh" << 'EOF'
# File: QNet-Project/start.sh
#!/bin/bash
# Starts the QNet node or explorer

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$SCRIPT_DIR"

# Activate virtual environment if it exists
VENV_DIR="$PROJECT_ROOT/venv"
if [ -d "$VENV_DIR" ]; then
    echo "Activating virtual environment..."
    source "$VENV_DIR/bin/activate"
else
    echo "WARNING: Virtual environment not found at $VENV_DIR. Running with system Python."
fi

# Set PYTHONPATH to include the src directories
# This helps Python find modules like config_loader, qnet-core components etc.
export PYTHONPATH="${PYTHONPATH}:$PROJECT_ROOT/qnet-node/src:$PROJECT_ROOT/qnet-core/src:$PROJECT_ROOT/qnet-explorer/src"
echo "PYTHONPATH set to: $PYTHONPATH"

# Determine which component to start
COMPONENT="node" # Default to node
if [ "$1" == "explorer" ]; then
    COMPONENT="explorer"
fi

# Correct paths to main scripts
NODE_SCRIPT="$PROJECT_ROOT/qnet-node/src/node/node.py"
EXPLORER_SCRIPT="$PROJECT_ROOT/qnet-explorer/src/app.py"

if [ "$COMPONENT" == "node" ]; then
    if [ -f "$NODE_SCRIPT" ]; then
        echo "Starting QNet Node..."
        # Optional: Run ip_fix before starting node if needed locally
        # IP_FIX_SCRIPT="$PROJECT_ROOT/qnet-node/src/node/ip_fix.py"
        # if [ -f "$IP_FIX_SCRIPT" ]; then
        #      echo "Determining external IP..."
        #      python "$IP_FIX_SCRIPT"
        # fi
        python "$NODE_SCRIPT" "${@:2}" # Pass any additional arguments after 'node'
    else
        echo "ERROR: Node script not found at $NODE_SCRIPT"
        exit 1
    fi
elif [ "$COMPONENT" == "explorer" ]; then
    if [ -f "$EXPLORER_SCRIPT" ]; then
        echo "Starting QNet Explorer..."
        # Use Flask's run for development or gunicorn for production
        # For development:
        export FLASK_APP="$EXPLORER_SCRIPT"
        export FLASK_ENV=development # or production
        flask run --host=0.0.0.0 --port=5000 "${@:2}" # Example port, pass args
        # For production (requires gunicorn installed):
        # gunicorn --bind 0.0.0.0:5000 "app:create_app()" # Check app:create_app() pattern in your app.py
    else
        echo "ERROR: Explorer script not found at $EXPLORER_SCRIPT"
        exit 1
    fi
else
     echo "Usage: ./start.sh [node|explorer] [additional arguments]"
     exit 1
fi
EOF
chmod +x "$PROJECT_ROOT/start.sh"

echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}Installation completed successfully!${NC}"
echo -e "${GREEN}Activate the virtual environment with: source venv/bin/activate${NC}"
echo -e "${GREEN}To start the node, run: ./start.sh node${NC}"
echo -e "${GREEN}To start the explorer (if applicable), run: ./start.sh explorer${NC}"
echo -e "${GREEN}=============================================${NC}"