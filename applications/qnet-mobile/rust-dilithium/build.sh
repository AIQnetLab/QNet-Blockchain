#!/bin/bash
# Build Dilithium WASM module for React Native

set -e

echo "🦀 Building QNet Dilithium3 WASM module..."

# Install wasm-pack if not present
if ! command -v wasm-pack &> /dev/null; then
    echo "📦 Installing wasm-pack..."
    cargo install wasm-pack
fi

# Build for web (React Native will use via Hermes)
echo "🔨 Building WASM module..."
wasm-pack build --target web --out-dir ../src/crypto/wasm --release

# Optimize WASM binary
if command -v wasm-opt &> /dev/null; then
    echo "⚡ Optimizing WASM binary..."
    wasm-opt -Oz -o ../src/crypto/wasm/qnet_dilithium_wasm_bg.wasm \
        ../src/crypto/wasm/qnet_dilithium_wasm_bg.wasm
fi

echo "✅ WASM module built successfully!"
echo "📦 Output: applications/qnet-mobile/src/crypto/wasm/"
echo ""
echo "Sizes:"
ls -lh ../src/crypto/wasm/qnet_dilithium_wasm_bg.wasm

