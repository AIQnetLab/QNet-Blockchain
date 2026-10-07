#!/usr/bin/env node

/**
 * QNet 1DEV Test Token Creation Script
 * Creates a new SPL token on Solana Devnet with 1 billion supply
 */

const {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');

const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

const fs = require('fs');
const path = require('path');

// Configuration
const DEVNET_RPC = 'https://api.devnet.solana.com';
const TOKEN_NAME = '1DEV Test Token';
const TOKEN_SYMBOL = '1DEV-TEST';
const TOKEN_DECIMALS = 6;
const TOTAL_SUPPLY = 1_000_000_000; // 1 billion tokens
const FAUCET_AMOUNT = 100_000_000; // 100M tokens for faucet (10% of supply)

async function createTestToken() {
  console.log('🚀 Creating 1DEV Test Token on Solana Devnet');
  console.log('============================================');
  
  // Connect to devnet
  const connection = new Connection(DEVNET_RPC, 'confirmed');
  
  // Create keypairs
  const mintAuthority = Keypair.generate();
  const faucetWallet = Keypair.generate();
  
  console.log('📋 Token Configuration:');
  console.log(`Name: ${TOKEN_NAME}`);
  console.log(`Symbol: ${TOKEN_SYMBOL}`);
  console.log(`Decimals: ${TOKEN_DECIMALS}`);
  console.log(`Total Supply: ${TOTAL_SUPPLY.toLocaleString()} tokens`);
  console.log(`Faucet Amount: ${FAUCET_AMOUNT.toLocaleString()} tokens`);
  console.log('');
  
  // Request airdrops for gas fees
  console.log('💰 Requesting SOL airdrops for gas fees...');
  
  try {
    const mintAuthorityAirdrop = await connection.requestAirdrop(
      mintAuthority.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(mintAuthorityAirdrop);
    
    const faucetAirdrop = await connection.requestAirdrop(
      faucetWallet.publicKey,
      1 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(faucetAirdrop);
    
    console.log('✅ Airdrops completed');
  } catch (error) {
    console.error('❌ Airdrop failed:', error.message);
    console.log('ℹ️ Continuing with existing SOL balance...');
  }
  
  // Create mint
  console.log('🏭 Creating token mint...');
  const mint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey,
    null, // No freeze authority
    TOKEN_DECIMALS,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  
  console.log(`✅ Token mint created: ${mint.toString()}`);
  
  // Create faucet token account
  console.log('🪣 Creating faucet token account...');
  const faucetTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    faucetWallet,
    mint,
    faucetWallet.publicKey
  );
  
  console.log(`✅ Faucet token account: ${faucetTokenAccount.address.toString()}`);
  
  // Mint tokens to faucet
  console.log('⚡ Minting tokens to faucet...');
  const mintAmount = FAUCET_AMOUNT * Math.pow(10, TOKEN_DECIMALS); // Convert to atomic units
  
  const mintTx = await mintTo(
    connection,
    mintAuthority,
    mint,
    faucetTokenAccount.address,
    mintAuthority,
    mintAmount
  );
  
  console.log(`✅ Minted ${FAUCET_AMOUNT.toLocaleString()} tokens to faucet`);
  console.log(`📄 Mint transaction: ${mintTx}`);
  
  // Save configuration
  const config = {
    tokenInfo: {
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      decimals: TOKEN_DECIMALS,
      totalSupply: TOTAL_SUPPLY,
      mintAddress: mint.toString(),
      network: 'devnet',
      createdAt: new Date().toISOString()
    },
    faucet: {
      walletAddress: faucetWallet.publicKey.toString(),
      tokenAccountAddress: faucetTokenAccount.address.toString(),
      initialBalance: FAUCET_AMOUNT,
      privateKey: Array.from(faucetWallet.secretKey)
    },
    urls: {
      solanaExplorer: `https://explorer.solana.com/address/${mint.toString()}?cluster=devnet`
    }
  };
  
  // Create directories if they don't exist
  const configDir = path.join(__dirname, '../../../infrastructure/config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  // Save to config file
  const configPath = path.join(configDir, 'test-token-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  // Save environment variables
  const envPath = path.join(__dirname, '.env.local');
  const envContent = `# QNet Test Token Configuration
TOKEN_MINT_ADDRESS=${mint.toString()}
FAUCET_PRIVATE_KEY='${JSON.stringify(Array.from(faucetWallet.secretKey))}'
FAUCET_WALLET_ADDRESS=${faucetWallet.publicKey.toString()}
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=${DEVNET_RPC}
`;
  
  fs.writeFileSync(envPath, envContent);
  
  console.log('');
  console.log('🎉 Token Creation Complete!');
  console.log('===========================');
  console.log(`Token Mint: ${mint.toString()}`);
  console.log(`Faucet Wallet: ${faucetWallet.publicKey.toString()}`);
  console.log(`Faucet Balance: ${FAUCET_AMOUNT.toLocaleString()} 1DEV-TEST`);
  console.log('');
  console.log('🔗 Explorer Links:');
  console.log(`Solana Explorer: https://explorer.solana.com/address/${mint.toString()}?cluster=devnet`);
  console.log('');
  console.log('📁 Files Created:');
  console.log(`Config: ${configPath}`);
  console.log(`Environment: ${envPath}`);
  console.log('');
  console.log('✅ Ready for testing! Restart the frontend server to use the new token.');
  
  return config;
}

// Run the script
if (require.main === module) {
  createTestToken()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ Error creating token:', error);
      process.exit(1);
    });
}

module.exports = { createTestToken }; 