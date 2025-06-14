# File: QNet-Project/qnet-node/scripts/build_rust.sh
#!/bin/bash
# Script to build Rust components for QNet core

set -e

# Determine project root directory assuming script is in qnet-node/scripts
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
NODE_DIR=$(dirname "$SCRIPT_DIR") # Should be qnet-node
PROJECT_ROOT=$(dirname "$NODE_DIR") # Should be QNet-Project

# Correct path to Rust directory relative to PROJECT_ROOT
RUST_DIR="$PROJECT_ROOT/qnet-core/src/crypto/rust"

if [ ! -d "$RUST_DIR" ]; then
    echo "ERROR: Rust source directory not found at $RUST_DIR"
    exit 1
fi

echo "Changing directory to Rust source: $RUST_DIR"
# Use pushd/popd for safer directory changes
pushd "$RUST_DIR" > /dev/null || { echo "ERROR: Failed to change directory to $RUST_DIR"; exit 1; }

# Check for cargo
if ! command -v cargo &> /dev/null; then
    echo "Installing Rust via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # Source Cargo environment, handle potential path issues
    if [ -f "$HOME/.cargo/env" ]; then
        source "$HOME/.cargo/env"
    elif [ -f "$HOME/.profile" ]; then
        source "$HOME/.profile" # Fallback for some shells
    else
         echo "WARNING: Could not automatically source Rust environment."
         echo "You may need to run 'source \$HOME/.cargo/env' or restart your terminal before running the node."
    fi
    # Verify cargo is now available
    if ! command -v cargo &> /dev/null; then
        echo "ERROR: cargo command not found even after attempting install."
        popd > /dev/null # Return to original dir before exiting
        exit 1
    fi
fi

# Build in release mode
echo "Building QNet core Rust library (release mode)..."
cargo build --release || { echo "ERROR: cargo build failed."; popd > /dev/null; exit 1; }

# Copy library to the correct Python directory
# Destination should be accessible by Python's ctypes/cffi, typically near bindings
DEST_DIR="$PROJECT_ROOT/qnet-core/src/crypto"
echo "Copying compiled library to $DEST_DIR ..."
mkdir -p "$DEST_DIR"

# Find the compiled library file dynamically (handle .so, .dylib, .dll)
# Assuming library name is defined in Cargo.toml's [lib] section, e.g., 'qnet_core'
# Use the name from Cargo.toml if possible, otherwise assume 'qnet_core'
LIB_NAME=$(grep '^name *=' Cargo.toml | head -n 1 | sed 's/name *= *"\(.*\)"/\1/')
if [ -z "$LIB_NAME" ]; then
    LIB_NAME="qnet_core" # Fallback name
    echo "WARNING: Could not determine library name from Cargo.toml, assuming '$LIB_NAME'"
fi

# Search for the library file using the determined name
LIB_FILE=$(find target/release -maxdepth 1 \( -name "lib${LIB_NAME}.so" -o -name "lib${LIB_NAME}.dylib" -o -name "${LIB_NAME}.dll" \) -print -quit)

if [ -n "$LIB_FILE" ] && [ -f "$LIB_FILE" ]; then
     cp "$LIB_FILE" "$DEST_DIR/"
     echo "Successfully copied $(basename "$LIB_FILE") to $DEST_DIR"
else
     echo "ERROR: Compiled library (expected 'lib${LIB_NAME}.*' or similar) not found in target/release"
     ls -l target/release # List contents for debugging
     popd > /dev/null # Return to original dir before exiting
     exit 1
fi

echo "Rust build completed successfully!"

# Return to original directory
popd > /dev/null