#!/bin/bash

export PATH="/root/.cargo/bin:/usr/local/bin:$PATH"

echo "🔍 Checking current program and deploying new upgradeable version..."

# Set up main wallet
echo '[98,54,150,232,151,114,95,85,54,178,29,20,13,43,209,232,68,64,73,82,48,149,22,59,253,195,246,33,65,247,32,168,84,114,232,9,201,117,109,12,111,218,239,66,214,123,83,48,43,27,78,236,7,237,231,68,120,247,80,1,162,166,118,181]' > /root/deploy_wallet.json

/root/.cargo/bin/solana config set --keypair /root/deploy_wallet.json --url devnet

echo "📋 Wallet address:"
/root/.cargo/bin/solana address

echo "💰 Current balance:"
/root/.cargo/bin/solana balance

echo ""
echo "🔍 Checking existing program vLYG5buWMnRCdxykgRQks84dPYJ2D5dareoNoq9mMEg..."
PROGRAM_INFO=$(/root/.cargo/bin/solana program show vLYG5buWMnRCdxykgRQks84dPYJ2D5dareoNoq9mMEg --url devnet 2>&1)
echo "$PROGRAM_INFO"

echo ""
echo "🔍 Checking if it's deployed with BPF Loader 2 or BPF Loader Upgradeable..."

# Navigate to contract directory
cd /root/QNet-Blockchain/development/qnet-contracts/1dev-burn-contract

echo "📂 Current directory: $(pwd)"

echo ""
echo "🚀 Deploying NEW UPGRADEABLE program..."
echo "⏳ This will create a new Program ID with upgrade authority..."

# Deploy as new upgradeable program
DEPLOY_OUTPUT=$(/root/.cargo/bin/solana program deploy target/deploy/onedev_burn_contract.so --keypair /root/deploy_wallet.json --url devnet --program-id /root/deploy_wallet.json --upgrade-authority /root/deploy_wallet.json 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract new program ID
NEW_PROGRAM_ID=$(echo "$DEPLOY_OUTPUT" | grep -o 'Program Id: [A-Za-z0-9]*' | sed 's/Program Id: //')

if [ -n "$NEW_PROGRAM_ID" ] && [ ${#NEW_PROGRAM_ID} -eq 44 ]; then
    echo ""
    echo "🎉🎉🎉 NEW UPGRADEABLE CONTRACT DEPLOYED! 🎉🎉🎉"
    echo "✅ New Program ID: $NEW_PROGRAM_ID"
    echo "✅ Upgrade Authority: $(solana address)"
    echo "✅ Contract is now upgradeable!"
    
    echo ""
    echo "💰 Final balance:"
    /root/.cargo/bin/solana balance
    
    echo ""
    echo "🔍 Verify new program on Solscan:"
    echo "https://solscan.io/address/$NEW_PROGRAM_ID?cluster=devnet"
    
    echo ""
    echo "📋 NEXT STEPS:"
    echo "1. Update all config files with new Program ID: $NEW_PROGRAM_ID"
    echo "2. Update documentation"
    echo "3. Test the new contract"
    
    echo ""
    echo "🎯 NEW PROGRAM DEPLOYED - READY FOR FUTURE UPGRADES!"
    
else
    echo ""
    echo "❌ Deployment failed or couldn't extract Program ID!"
    echo "Full deploy output: $DEPLOY_OUTPUT"
    
    echo ""
    echo "🔄 Trying alternative deployment method..."
    
    # Alternative: generate new keypair for program
    /root/.cargo/bin/solana-keygen new --outfile /root/new_program_keypair.json --no-bip39-passphrase
    
    ALT_DEPLOY_OUTPUT=$(/root/.cargo/bin/solana program deploy target/deploy/onedev_burn_contract.so --keypair /root/deploy_wallet.json --url devnet --program-id /root/new_program_keypair.json --upgrade-authority /root/deploy_wallet.json 2>&1)
    echo "$ALT_DEPLOY_OUTPUT"
    
    ALT_PROGRAM_ID=$(echo "$ALT_DEPLOY_OUTPUT" | grep -o 'Program Id: [A-Za-z0-9]*' | sed 's/Program Id: //')
    
    if [ -n "$ALT_PROGRAM_ID" ]; then
        echo "✅ Alternative deployment successful!"
        echo "✅ New Program ID: $ALT_PROGRAM_ID"
    else
        echo "❌ Both deployment methods failed"
    fi
    
    rm -f /root/new_program_keypair.json
fi

# Cleanup
rm -f /root/deploy_wallet.json

echo ""
echo "✅ Deployment process completed" 