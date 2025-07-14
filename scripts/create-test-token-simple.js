#!/usr/bin/env node

/**
 * QNet 1DEV Test Token Creation Script (Simplified)
 * Creates a new SPL token on Solana Devnet with 1 billion supply
 */

const path = require('path');
const fs = require('fs');

// Add frontend node_modules to path
const frontendNodeModules = path.join(__dirname, '../applications/qnet-explorer/frontend/node_modules');
const solanaWeb3Path = path.join(frontendNodeModules, '@solana/web3.js');
const solanaSplPath = path.join(frontendNodeModules, '@solana/spl-token');

let Connection, Keypair, PublicKey, LAMPORTS_PER_SOL;
let createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID;

try {
  // Try to load from frontend dependencies
  const web3 = require(solanaWeb3Path);
  const spl = require(solanaSplPath);
  
  Connection = web3.Connection;
  Keypair = web3.Keypair;
  PublicKey = web3.PublicKey;
  LAMPORTS_PER_SOL = web3.LAMPORTS_PER_SOL;
  
  createMint = spl.createMint;
  getOrCreateAssociatedTokenAccount = spl.getOrCreateAssociatedTokenAccount;
  mintTo = spl.mintTo;
  TOKEN_PROGRAM_ID = spl.TOKEN_PROGRAM_ID;
  
} catch (error) {
  console.error('❌ Solana dependencies not found. Please install them first:');
  console.error('cd applications/qnet-explorer/frontend && npm install');
  process.exit(1);
}

// Configuration
const DEVNET_RPC = 'https://api.devnet.solana.com';
const TOKEN_NAME = '1DEV Test Token';
const TOKEN_SYMBOL = '1DEV-TEST';
const TOKEN_DECIMALS = 6;
const TOTAL_SUPPLY = 1_000_000_000; // 1 billion tokens (pump.fun standard)
const FAUCET_AMOUNT = 100_000_000; // 100M tokens for faucet (10% of supply)

async function createTestToken() {
  console.log('🚀 Creating 1DEV Test Token on Solana Devnet');
  console.log('============================================');
  
  // Connect to devnet with enhanced settings
  const connection = new Connection(DEVNET_RPC, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
    wsEndpoint: 'wss://api.devnet.solana.com/'
  });
  
  // Load existing keypairs with SOL balance
  const existingConfigPath = path.join(__dirname, '../infrastructure/config/generated-keypairs.json');
  let existingConfig;
  
  try {
    existingConfig = JSON.parse(fs.readFileSync(existingConfigPath, 'utf8'));
  } catch (error) {
    console.error('❌ Cannot load existing wallet config:', error.message);
    process.exit(1);
  }
  
  // Use existing wallet with SOL balance as MINT AUTHORITY
  const mintAuthority = Keypair.fromSecretKey(new Uint8Array(existingConfig.mintAuthority.secretKey));
  console.log(`🔑 Using existing MINT AUTHORITY: ${mintAuthority.publicKey.toString()}`);
  
  // Use same wallet for faucet (single wallet approach)
  const faucetWallet = mintAuthority;
  
  console.log('📋 Token Configuration:');
  console.log(`Name: ${TOKEN_NAME}`);
  console.log(`Symbol: ${TOKEN_SYMBOL}`);
  console.log(`Decimals: ${TOKEN_DECIMALS}`);
  console.log(`Total Supply: ${TOTAL_SUPPLY.toLocaleString()} tokens`);
  console.log(`Faucet Amount: ${TOTAL_SUPPLY.toLocaleString()} tokens (FULL SUPPLY)`);
  console.log('');
  
  // Check existing SOL balance
  console.log('💰 Checking existing SOL balance...');
  
  try {
    const balance = await connection.getBalance(mintAuthority.publicKey);
    console.log(`✅ Current balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    
    if (balance < 0.1 * LAMPORTS_PER_SOL) {
      console.error('❌ Insufficient SOL balance for gas fees!');
      console.error('Please fund the wallet with at least 0.1 SOL');
      process.exit(1);
    }
    
    console.log('✅ Sufficient SOL balance for token creation');
  } catch (error) {
    console.error('❌ Error checking balance:', error.message);
    process.exit(1);
  }
  
  // Create mint with enhanced gas settings
  console.log('🏭 Creating token mint with enhanced gas settings...');
  const mint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey,
    null, // No freeze authority
    TOKEN_DECIMALS,
    undefined,
    {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 5
    },
    TOKEN_PROGRAM_ID
  );
  
  console.log(`✅ Token mint created: ${mint.toString()}`);
  
  // Create faucet token account with enhanced gas settings
  console.log('🪣 Creating faucet token account with enhanced gas settings...');
  const faucetTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    faucetWallet,
    mint,
    faucetWallet.publicKey,
    false,
    'confirmed'
  );
  
  console.log(`✅ Faucet token account: ${faucetTokenAccount.address.toString()}`);
  
  // Mint tokens to faucet with enhanced gas settings
  console.log('⚡ Minting FULL SUPPLY (1 billion tokens) to faucet with enhanced gas settings...');
  const mintAmount = TOTAL_SUPPLY * Math.pow(10, TOKEN_DECIMALS); // Convert to atomic units
  
  const mintTx = await mintTo(
    connection,
    mintAuthority,
    mint,
    faucetTokenAccount.address,
    mintAuthority,
    mintAmount,
    [],
    {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 5
    }
  );
  
  console.log(`✅ Minted ${TOTAL_SUPPLY.toLocaleString()} tokens (FULL SUPPLY) to faucet`);
  console.log(`📄 Mint transaction: ${mintTx}`);
  
  // Save enhanced configuration
  const config = {
    tokenInfo: {
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      decimals: TOKEN_DECIMALS,
      totalSupply: TOTAL_SUPPLY,
      mintAddress: mint.toString(),
      network: 'devnet',
      createdAt: new Date().toISOString(),
      gasEnhanced: true
    },
    mintAuthority: {
      publicKey: mintAuthority.publicKey.toString(),
      privateKey: Array.from(mintAuthority.secretKey)
    },
    faucet: {
      walletAddress: faucetWallet.publicKey.toString(), // Same as mint authority
      tokenAccountAddress: faucetTokenAccount.address.toString(),
      initialBalance: TOTAL_SUPPLY,
      privateKey: Array.from(faucetWallet.secretKey), // Same as mint authority
      note: "Single wallet used for MINT AUTHORITY and faucet operations - FULL SUPPLY MINTED"
    },
    urls: {
      solscan: `https://solscan.io/token/${mint.toString()}?cluster=devnet`,
      solanaExplorer: `https://explorer.solana.com/address/${mint.toString()}?cluster=devnet`
    }
  };
  
  // Create directories if they don't exist
  const configDir = path.join(__dirname, '../infrastructure/config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  // Save to config file
  const configPath = path.join(configDir, 'test-token-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  // Save environment variables
  const envPath = path.join(__dirname, '../applications/qnet-explorer/frontend/.env.local');
  const envContent = `# QNet Test Token Configuration (Enhanced Gas)
TOKEN_MINT_ADDRESS=${mint.toString()}
FAUCET_PRIVATE_KEY='${JSON.stringify(Array.from(faucetWallet.secretKey))}'
FAUCET_WALLET_ADDRESS=${faucetWallet.publicKey.toString()}
MINT_AUTHORITY_PRIVATE_KEY='${JSON.stringify(Array.from(mintAuthority.secretKey))}'
MINT_AUTHORITY_WALLET_ADDRESS=${mintAuthority.publicKey.toString()}
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=${DEVNET_RPC}
GAS_ENHANCED=true
`;
  
  fs.writeFileSync(envPath, envContent);
  
  console.log('');
  console.log('🎉 Token Creation Complete! (Enhanced Gas)');
  console.log('==========================================');
  console.log(`Token Mint: ${mint.toString()}`);
  console.log(`MINT AUTHORITY: ${mintAuthority.publicKey.toString()}`);
  console.log(`Faucet Wallet: ${faucetWallet.publicKey.toString()} (Same as MINT AUTHORITY)`);
  console.log(`Faucet Balance: ${TOTAL_SUPPLY.toLocaleString()} 1DEV-TEST (FULL SUPPLY)`);
  console.log('');
  console.log('🔗 Explorer Links:');
  console.log(`Solscan: https://solscan.io/token/${mint.toString()}?cluster=devnet`);
  console.log(`Solana Explorer: https://explorer.solana.com/address/${mint.toString()}?cluster=devnet`);
  console.log('');
  console.log('📁 Files Created:');
  console.log(`Config: ${configPath}`);
  console.log(`Environment: ${envPath}`);
  console.log('');
  console.log('✅ Ready for production! Single wallet controls all operations.');
  console.log('💡 Enhanced gas settings used for reliable token creation.');
  
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