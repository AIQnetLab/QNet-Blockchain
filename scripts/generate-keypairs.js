const { Keypair } = require('@solana/web3.js');

console.log('🚀 GENERATE KEYPAIRS FOR REAL 1DEV TOKEN');
console.log('=========================================\n');

// Generate keypairs
const mintAuthority = Keypair.generate();
const faucetWallet = Keypair.generate();

console.log('🔑 GENERATED KEYPAIRS:');
console.log('======================');
console.log(`Mint Authority: ${mintAuthority.publicKey.toString()}`);
console.log(`Faucet Wallet:  ${faucetWallet.publicKey.toString()}\n`);

console.log('💰 STEP 1: GET SOL FROM FAUCETS');
console.log('===============================');
console.log('Visit these faucets and request SOL for both addresses:\n');

console.log('🌐 WORKING FAUCETS:');
console.log('1. https://faucet.solana.com');
console.log('2. https://solfaucet.com');
console.log('3. https://faucet.quicknode.com/solana/devnet');
console.log('4. https://devnetfaucet.org\n');

console.log('📋 ADDRESSES TO FUND:');
console.log(`Mint Authority: ${mintAuthority.publicKey.toString()}`);
console.log(`Faucet Wallet:  ${faucetWallet.publicKey.toString()}\n`);

console.log('⚠️  REQUEST AT LEAST 1 SOL FOR EACH ADDRESS\n');

console.log('🏭 STEP 2: TOKEN CREATION');
console.log('=========================');
console.log('After getting SOL, come back to us for token creation!');
console.log('We will create script for automatic SPL token creation.');

// Save keypairs
const fs = require('fs');
const keypairs = {
    mintAuthority: {
        publicKey: mintAuthority.publicKey.toString(),
        secretKey: Array.from(mintAuthority.secretKey)
    },
    faucetWallet: {
        publicKey: faucetWallet.publicKey.toString(),
        secretKey: Array.from(faucetWallet.secretKey)
    },
    created: new Date().toISOString()
};

fs.writeFileSync('../infrastructure/config/generated-keypairs.json', JSON.stringify(keypairs, null, 2));
console.log('\n✅ Keypairs saved to: ../infrastructure/config/generated-keypairs.json');
console.log('\n🎯 AFTER GETTING SOL - LET US KNOW!'); 