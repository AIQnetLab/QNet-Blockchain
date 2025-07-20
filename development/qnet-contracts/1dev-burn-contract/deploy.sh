#!/bin/bash

# 1DEV Burn Contract Deployment Script
# This script deploys the burn tracking contract to Solana

echo "🚀 Deploying 1DEV Burn Contract to Solana..."

# Check if Solana CLI is installed
if ! command -v solana &> /dev/null; then
    echo "❌ Solana CLI is not installed. Please install it first:"
    echo "   curl -sSf https://release.solana.com/stable/install | sh"
    exit 1
fi

# Check if Anchor CLI is installed
if ! command -v anchor &> /dev/null; then
    echo "❌ Anchor CLI is not installed. Please install it first:"
    echo "   cargo install --git https://github.com/coral-xyz/anchor avm --locked"
    echo "   avm install latest"
    echo "   avm use latest"
    exit 1
fi

# Set cluster to devnet
echo "🔧 Setting cluster to devnet..."
solana config set --url https://api.devnet.solana.com

# Check wallet balance
echo "💰 Checking wallet balance..."
BALANCE=$(solana balance --lamports)
MIN_BALANCE=1000000000  # 1 SOL in lamports

if [ "$BALANCE" -lt "$MIN_BALANCE" ]; then
    echo "❌ Insufficient balance. You need at least 1 SOL for deployment."
    echo "   Request airdrop: solana airdrop 2"
    echo "   Current balance: $(solana balance)"
    exit 1
fi

# Build the contract
echo "🔨 Building contract..."
anchor build

if [ $? -ne 0 ]; then
    echo "❌ Build failed. Please check the code."
    exit 1
fi

# Deploy the contract
echo "🚀 Deploying contract..."
anchor deploy

if [ $? -eq 0 ]; then
    echo "✅ Contract deployed successfully!"
    echo "📋 Program ID: $(anchor keys list | grep onedev_burn_contract | cut -d' ' -f2)"
    echo ""
    echo "🔧 Next steps:"
    echo "1. Update BURN_TRACKER_PROGRAM_ID environment variable"
    echo "2. Update all config files with the new program ID"
    echo "3. Initialize the contract with:"
    echo "   anchor run initialize"
else
    echo "❌ Deployment failed. Please check the logs."
    exit 1
fi

echo "🎉 Deployment completed!" 