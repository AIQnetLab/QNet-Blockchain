#!/bin/bash
# Build script for QNet Rust components

set -e

# Check for rustc
if ! command -v rustc &> /dev/null; then
    echo "Rust compiler not found. Please install Rust from https://rustup.rs/"
    exit 1
fi

# Check for cargo
if ! command -v cargo &> /dev/null; then
    echo "Cargo not found. Please install Rust from https://rustup.rs/"
    exit 1
fi

# Build in release mode
echo "Building QNet core library..."
cargo build --release

# Copy library to Python directory
echo "Copying library to Python directory..."
mkdir -p ../python
cp target/release/libqnet_core.* ../python/

echo "Build completed successfully!"