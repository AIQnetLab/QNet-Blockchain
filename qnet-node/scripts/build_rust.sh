#!/bin/bash
# Script to build Rust components for QNet

set -e

cd rust

# Check for cargo
if ! command -v cargo &> /dev/null; then
    echo "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source $HOME/.cargo/env
fi

# Build in release mode
echo "Building QNet core library..."
cargo build --release

# Copy library to the right location
echo "Copying library..."
mkdir -p ../
cp target/release/libqnet_core.* ../

echo "Rust build completed!"