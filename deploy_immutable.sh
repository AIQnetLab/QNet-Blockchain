#!/bin/bash

export PATH="/root/.cargo/bin:/usr/local/bin:$PATH"

echo "🚀 Deploying NEW IMMUTABLE contract..."

# Set up main wallet
echo '[98,54,150,232,151,114,95,85,54,178,29,20,13,43,209,232,68,64,73,82,48,149,22,59,253,195,246,33,65,247,32,168,84,114,232,9,201,117,109,12,111,218,239,66,214,123,83,48,43,27,78,236,7,237,231,68,120,247,80,1,162,166,118,181]' > /root/deploy_wallet.json

/root/.cargo/bin/solana config set --keypair /root/deploy_wallet.json --url devnet

echo "📋 Wallet address:"
/root/.cargo/bin/solana address

echo "💰 Current balance:"
BALANCE=$(/root/.cargo/bin/solana balance)
echo $BALANCE

# Navigate to contract directory
cd /root/QNet-Blockchain/development/qnet-contracts/1dev-burn-contract

echo "📂 Current directory: $(pwd)"
echo "📋 Contract file:"
ls -la target/deploy/onedev_burn_contract.so

echo ""
echo "🚀 Deploying as IMMUTABLE program (no upgrade authority)..."
echo "⏳ This will create a new Program ID that cannot be changed..."

# Deploy as immutable program (no --upgrade-authority parameter)
DEPLOY_OUTPUT=$(/root/.cargo/bin/solana program deploy target/deploy/onedev_burn_contract.so --keypair /root/deploy_wallet.json --url devnet 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract new program ID
NEW_PROGRAM_ID=$(echo "$DEPLOY_OUTPUT" | grep -E "Program Id: [A-Za-z0-9]{32,}" | sed 's/.*Program Id: \([A-Za-z0-9]*\).*/\1/')

if [ -n "$NEW_PROGRAM_ID" ] && [ ${#NEW_PROGRAM_ID} -eq 44 ]; then
    echo ""
    echo "🎉🎉🎉 IMMUTABLE CONTRACT DEPLOYED SUCCESSFULLY! 🎉🎉🎉"
    echo "✅ New Program ID: $NEW_PROGRAM_ID"
    echo "✅ Contract is IMMUTABLE (cannot be upgraded)"
    echo "✅ Lower deployment cost than upgradeable programs"
    
    echo ""
    echo "💰 Final balance:"
    /root/.cargo/bin/solana balance
    
    echo ""
    echo "🔍 Verify new program on Solscan:"
    echo "https://solscan.io/address/$NEW_PROGRAM_ID?cluster=devnet"
    
    echo ""
    echo "📋 IMPORTANT - UPDATE THESE FILES WITH NEW PROGRAM ID:"
    echo "- README.md"
    echo "- documentation/technical/ECONOMIC_MODEL.md"
    echo "- documentation/technical/NODE_ACTIVATION_ARCHITECTURE.md"
    echo "- infrastructure/config/config.ini"
    echo "- development/qnet-contracts/1dev-burn-contract/src/lib.rs"
    echo "- development/qnet-contracts/simple-burn-tracker/src/lib.rs"
    echo "- development/qnet-integration/src/bin/qnet-node.rs"
    echo "- development/qnet-contracts/production-deploy.bat"
    
    echo ""
    echo "🎯 DEPLOYMENT COMPLETE - IMMUTABLE CONTRACT READY!"
    
    # Show program info
    echo ""
    echo "📋 Program information:"
    /root/.cargo/bin/solana program show $NEW_PROGRAM_ID --url devnet
    
else
    echo ""
    echo "❌ Deployment failed or couldn't extract Program ID!"
    echo "Full deploy output: $DEPLOY_OUTPUT"
    
    echo ""
    echo "🔍 Current balance for troubleshooting:"
    /root/.cargo/bin/solana balance
    
    echo ""
    echo "💡 Possible issues:"
    echo "- Insufficient SOL balance"
    echo "- Network connectivity"
    echo "- Contract compilation issues"
fi

# Cleanup
rm -f /root/deploy_wallet.json

echo ""
echo "✅ Deployment process completed" 