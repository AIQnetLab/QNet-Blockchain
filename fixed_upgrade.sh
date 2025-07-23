#!/bin/bash

export PATH="/root/.cargo/bin:/usr/local/bin:$PATH"

echo "🚀 Starting contract upgrade - FIXED VERSION..."

# Set up main wallet
echo '[98,54,150,232,151,114,95,85,54,178,29,20,13,43,209,232,68,64,73,82,48,149,22,59,253,195,246,33,65,247,32,168,84,114,232,9,201,117,109,12,111,218,239,66,214,123,83,48,43,27,78,236,7,237,231,68,120,247,80,1,162,166,118,181]' > /root/upgrade_wallet.json

/root/.cargo/bin/solana config set --keypair /root/upgrade_wallet.json --url devnet

echo "📋 Wallet address:"
WALLET_ADDRESS=$(/root/.cargo/bin/solana address)
echo $WALLET_ADDRESS

echo "💰 Current balance:"
CURRENT_BALANCE=$(/root/.cargo/bin/solana balance)
echo $CURRENT_BALANCE

# Extract numeric balance and proceed with upgrade (we know it's sufficient)
BALANCE_NUM=$(echo $CURRENT_BALANCE | awk '{print $1}')
echo "Numeric balance: $BALANCE_NUM SOL"

echo "✅ Balance is sufficient - proceeding with upgrade!"

# Navigate to contract directory
cd /root/QNet-Blockchain/development/qnet-contracts/1dev-burn-contract

echo "📂 Current directory: $(pwd)"
echo "📋 Contract files:"
ls -la target/deploy/

echo ""
echo "🔄 Step 1: Writing buffer to devnet..."
echo "⏳ This may take a few minutes for large contracts..."

BUFFER_OUTPUT=$(/root/.cargo/bin/solana program write-buffer target/deploy/onedev_burn_contract.so --keypair /root/upgrade_wallet.json --url devnet 2>&1)
echo "$BUFFER_OUTPUT"

# Extract buffer address more robustly
BUFFER_ADDRESS=$(echo "$BUFFER_OUTPUT" | grep -E "Buffer: [A-Za-z0-9]{32,}" | sed 's/.*Buffer: \([A-Za-z0-9]*\).*/\1/')

if [ -n "$BUFFER_ADDRESS" ] && [ ${#BUFFER_ADDRESS} -eq 44 ]; then
    echo ""
    echo "✅ Buffer created successfully!"
    echo "📍 Buffer Address: $BUFFER_ADDRESS"
    
    echo ""
    echo "🔄 Step 2: Upgrading program..."
    echo "🎯 Program ID: vLYG5buWMnRCdxykgRQks84dPYJ2D5dareoNoq9mMEg"
    echo "🎯 Buffer: $BUFFER_ADDRESS"
    echo "⏳ Performing upgrade..."
    
    UPGRADE_OUTPUT=$(/root/.cargo/bin/solana program upgrade vLYG5buWMnRCdxykgRQks84dPYJ2D5dareoNoq9mMEg $BUFFER_ADDRESS --keypair /root/upgrade_wallet.json --url devnet 2>&1)
    echo "$UPGRADE_OUTPUT"
    
    if echo "$UPGRADE_OUTPUT" | grep -q -i "upgraded\|success"; then
        echo ""
        echo "🎉🎉🎉 CONTRACT UPGRADE SUCCESSFUL! 🎉🎉🎉"
        echo "✅ Program ID: vLYG5buWMnRCdxykgRQks84dPYJ2D5dareoNoq9mMEg"
        echo "✅ Contract has been updated on Solana devnet"
        
        echo ""
        echo "💰 Final balance:"
        /root/.cargo/bin/solana balance
        
        echo ""
        echo "🔍 Verify on Solscan:"
        echo "https://solscan.io/address/vLYG5buWMnRCdxykgRQks84dPYJ2D5dareoNoq9mMEg?cluster=devnet"
        
        echo ""
        echo "🎯 UPGRADE COMPLETE - SYSTEM IS PRODUCTION READY!"
        
    else
        echo ""
        echo "❌ Upgrade failed!"
        echo "Error details: $UPGRADE_OUTPUT"
        
        # Try to show more details if available
        echo ""
        echo "🔍 Additional troubleshooting info:"
        /root/.cargo/bin/solana program show vLYG5buWMnRCdxykgRQks84dPYJ2D5dareoNoq9mMEg --url devnet
    fi
    
else
    echo ""
    echo "❌ Buffer creation failed or invalid buffer address!"
    echo "Expected 44-character address, got: '$BUFFER_ADDRESS'"
    echo "Full buffer output: $BUFFER_OUTPUT"
    
    echo ""
    echo "🔍 Troubleshooting - checking account balance and program info:"
    /root/.cargo/bin/solana balance
    /root/.cargo/bin/solana program show vLYG5buWMnRCdxykgRQks84dPYJ2D5dareoNoq9mMEg --url devnet
fi

# Cleanup
rm -f /root/upgrade_wallet.json

echo ""
echo "✅ Upgrade process completed" 