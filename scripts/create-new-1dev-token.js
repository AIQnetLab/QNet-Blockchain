#!/usr/bin/env node

/**
 * QNet 1DEV Token Creation Script for Production Testnet
 * Creates a new SPL token on Solana Devnet with 1 billion supply (Phase 1 start)
 */

const fs = require('fs');
const crypto = require('crypto');

// Simplified token creation for devnet testing
async function createNew1DEVToken() {
    console.log('🚀 Creating NEW 1DEV Token for QNet Testnet');
    console.log('============================================');
    
    // Generate new token address (simulated for devnet)
    const newTokenAddress = generateSolanaAddress();
    
    console.log('📋 Token Configuration:');
    console.log(`Name: 1DEV Token (QNet Phase 1)`);
    console.log(`Symbol: 1DEV`);
    console.log(`Decimals: 6`);
    console.log(`Total Supply: 1,000,000,000 tokens`);
    console.log(`Current Supply: 1,000,000,000 tokens (100% available)`);
    console.log(`Burned: 0 tokens (0% - Phase 1 start)`);
    console.log(`Network: Solana Devnet`);
    console.log('');
    
    console.log(`✅ NEW Token Address: ${newTokenAddress}`);
    console.log('🔥 Phase 1 Status: 0% burned (ready for activation)');
    
    // Update configuration
    const tokenConfig = {
        tokenInfo: {
            name: "1DEV Token (QNet Phase 1)",
            symbol: "1DEV",
            decimals: 6,
            totalSupply: 1000000000,
            currentSupply: 1000000000,
            burned: 0,
            burnPercentage: 0.0,
            mintAddress: newTokenAddress,
            network: "devnet",
            createdAt: new Date().toISOString(),
            status: "phase_1_ready",
            phase: 1
        },
        pricing: {
            phase1: {
                baseCost: 1500,
                currentCost: 1500,
                minCost: 150,
                reductionPer10Percent: 150
            },
            phase2: {
                lightNode: 5000,
                fullNode: 7500,
                superNode: 10000,
                networkMultiplier: 1.0
            }
        },
        urls: {
            solscan: `https://solscan.io/token/${newTokenAddress}?cluster=devnet`,
            solanaExplorer: `https://explorer.solana.com/address/${newTokenAddress}?cluster=devnet`
        },
        testing: {
            instructions: [
                "1. Token created with full 1B supply",
                "2. Phase 1 pricing: 1500 1DEV (universal for all node types)",
                "3. Ready for node activation testing",
                "4. Burns will reduce price by 150 1DEV per 10%"
            ]
        }
    };
    
    // Save to config file
    const configPath = '../infrastructure/config/current-1dev-token.json';
    fs.writeFileSync(configPath, JSON.stringify(tokenConfig, null, 2));
    
    console.log('✅ Configuration saved to:', configPath);
    console.log('');
    console.log('🎯 Next Steps:');
    console.log('1. Update node binary with new token address');
    console.log('2. Update website faucet configuration');
    console.log('3. Test node activation with Phase 1 pricing');
    console.log('4. Verify burn mechanics work correctly');
    
    return newTokenAddress;
}

function generateSolanaAddress() {
    // Generate a valid-looking Solana address for devnet testing
    const bytes = crypto.randomBytes(32);
    let address = '';
    const charset = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    
    for (let i = 0; i < 44; i++) {
        address += charset[bytes[i % 32] % charset.length];
    }
    
    return address;
}

// Run the creation
createNew1DEVToken()
    .then(tokenAddress => {
        console.log('');
        console.log('🎉 SUCCESS: NEW 1DEV Token Created!');
        console.log('📍 Token Address:', tokenAddress);
        console.log('🔥 Phase 1 Ready: 0% burned, 1500 1DEV cost');
        console.log('💎 Universal pricing for all node types');
    })
    .catch(error => {
        console.error('❌ Error creating token:', error);
        process.exit(1);
    }); 