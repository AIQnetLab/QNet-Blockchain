import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, Keypair } from '@solana/web3.js';
import { createTransferInstruction, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

// Production faucet configuration
const FAUCET_CONFIG = {
  // Testnet amounts
  testnet: {
    '1DEV': 1500,  // 1500 1DEV tokens for testing
    'SOL': 1.0,
    'QNC': 50000
  },
  // Production amounts (much smaller)
  mainnet: {
    '1DEV': 100,
    'SOL': 0.1,
    'QNC': 1000
  },
  // Cooldown periods (in milliseconds)
  cooldown: {
    testnet: 24 * 60 * 60 * 1000, // 24 hours for testnet
    mainnet: 24 * 60 * 60 * 1000  // 24 hours for mainnet
  },
  // Rate limiting
  maxRequestsPerIP: 10,
  maxRequestsPerAddress: 5
};

// In-memory storage for rate limiting
const rateLimitStore = new Map<string, { count: number; lastReset: number }>();

// Persistent cooldown storage path (production ready)
const COOLDOWN_FILE_PATH = path.join(process.cwd(), 'node_data_local', 'faucet-cooldowns.json');

/**
 * Load cooldowns from persistent storage
 */
function loadCooldowns(): Map<string, number> {
  try {
    if (fs.existsSync(COOLDOWN_FILE_PATH)) {
      const data = fs.readFileSync(COOLDOWN_FILE_PATH, 'utf8');
      const parsed = JSON.parse(data);
      return new Map(Object.entries(parsed));
    }
  } catch (error) {
    // If file doesn't exist or is corrupted, start fresh
  }
  return new Map();
}

/**
 * Save cooldowns to persistent storage
 */
function saveCooldowns(cooldowns: Map<string, number>): void {
  try {
    const dir = path.dirname(COOLDOWN_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = Object.fromEntries(cooldowns);
    fs.writeFileSync(COOLDOWN_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    // Silent fail - not critical for operation
  }
}

// Load cooldowns on startup
const addressCooldowns = loadCooldowns();

/**
 * Validate Solana address format
 */
function validateSolanaAddress(address: string): boolean {
  // Basic Solana address validation (base58, 32-44 characters)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

/**
 * Validate QNet EON address format
 */
function validateQNetAddress(address: string): boolean {
  // EON address format: 8chars + "eon" + 8chars (symmetric structure)
  const eonRegex = /^[a-z0-9]{8}eon[a-z0-9]{8}$/;
  return eonRegex.test(address);
}

/**
 * Check rate limiting for IP address
 */
function checkRateLimit(ip: string): { allowed: boolean; resetTime?: number } {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour window
  
  const record = rateLimitStore.get(ip);
  
  if (!record || now - record.lastReset > windowMs) {
    // Reset or create new record
    rateLimitStore.set(ip, { count: 1, lastReset: now });
    return { allowed: true };
  }
  
  if (record.count >= FAUCET_CONFIG.maxRequestsPerIP) {
    const resetTime = record.lastReset + windowMs;
    return { allowed: false, resetTime };
  }
  
  record.count++;
  return { allowed: true };
}

/**
 * Check cooldown for wallet address (with persistent storage)
 */
function checkAddressCooldown(address: string, environment: 'testnet' | 'mainnet'): { allowed: boolean; nextClaimTime?: number } {
  const now = Date.now();
  const lastClaim = addressCooldowns.get(address);
  const cooldownMs = FAUCET_CONFIG.cooldown[environment];
  
  // Clean up expired entries (older than 48 hours)
  if (lastClaim && now - lastClaim > cooldownMs * 2) {
    addressCooldowns.delete(address);
    saveCooldowns(addressCooldowns);
  }
  
  if (!lastClaim || now - lastClaim > cooldownMs) {
    return { allowed: true };
  }
  
  const nextClaimTime = lastClaim + cooldownMs;
  return { allowed: false, nextClaimTime };
}

/**
 * Record successful claim with persistent storage
 */
function recordClaim(address: string): void {
  addressCooldowns.set(address, Date.now());
  saveCooldowns(addressCooldowns);
}

/**
 * Get client IP address
 */
function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIP = request.headers.get('x-real-ip');
  const cfIP = request.headers.get('cf-connecting-ip');
  
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  
  return realIP || cfIP || 'unknown';
}

/**
 * Detect environment based on hostname
 */
function detectEnvironment(request: NextRequest): 'testnet' | 'mainnet' {
  const hostname = request.headers.get('host') || '';
  
  if (hostname.includes('testnet') || hostname.includes('localhost')) {
    return 'testnet';
  }
  
  return 'mainnet';
}

/**
 * Send tokens via appropriate network
 */
async function sendTokens(
  tokenType: string,
  amount: number,
  address: string,
  environment: 'testnet' | 'mainnet'
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  
  try {
    switch (tokenType) {
      case '1DEV':
        return await send1DEVTokens(address, amount, environment);
      case 'SOL':
        return await sendSOLTokens(address, amount, environment);
      case 'QNC':
        return await sendQNCTokens(address, amount, environment);
      default:
        return { success: false, error: 'Unsupported token type' };
    }
  } catch (error) {
    console.error('Token sending error:', error);
    return { success: false, error: 'Failed to send tokens' };
  }
}

/**
 * Send 1DEV tokens (Solana SPL)
 */
async function send1DEVTokens(
  address: string,
  amount: number,
  environment: 'testnet' | 'mainnet'
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  
  // Updated 1DEV token configuration for QNet testnet
  const TOKEN_CONFIG = {
    // Production 1DEV token with full supply (Phase 1 active)
    mintAddress: '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ',
    decimals: 6,
    network: 'devnet',
    faucetAmount: amount,
    phase: 1,
    status: 'phase_1_active'
  };
  
  if (environment === 'testnet') {
    try {
      // Import necessary Solana libraries
      const { Connection, Keypair, PublicKey, Transaction } = await import('@solana/web3.js');
      const { createTransferInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } = await import('@solana/spl-token');
      
      // Setup connection with processed commitment for faster transactions
      const connection = new Connection('https://api.devnet.solana.com', 'processed');
      
      // Get faucet private key from environment variable OR testnet config file
      let faucetPrivateKey: number[] | undefined;
      const faucetPrivateKeyEnv = process.env.FAUCET_PRIVATE_KEY;
      
      if (faucetPrivateKeyEnv) {
        // Use environment variable if available (production)
        try {
          faucetPrivateKey = JSON.parse(faucetPrivateKeyEnv);
        } catch (e) {
          throw new Error('Faucet configuration error - invalid private key format');
        }
      } else {
        // Fallback to testnet config file for development/testnet
        const path = await import('path');
        const fs = await import('fs');
        
        // Try multiple possible paths
        const possiblePaths = [
          path.join(process.cwd(), 'infrastructure', 'config', 'faucet-config-testnet.json'),
          path.join(process.cwd(), '..', '..', '..', 'infrastructure', 'config', 'faucet-config-testnet.json'),
          'C:\\QNet-Project\\infrastructure\\config\\faucet-config-testnet.json'
        ];
        
        let configFound = false;
        for (const configPath of possiblePaths) {
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            faucetPrivateKey = config.wallet.secretKey;
            configFound = true;
            break;
          }
        }
        
        if (!configFound) {
          throw new Error('Faucet configuration error - no private key source available');
        }
      }
      
      if (!faucetPrivateKey) {
        throw new Error('Faucet configuration error - private key not loaded');
      }
      
      const faucetWallet = Keypair.fromSecretKey(new Uint8Array(faucetPrivateKey));
      const mintPubkey = new PublicKey(TOKEN_CONFIG.mintAddress);
      const recipientPubkey = new PublicKey(address);
      
      // Get or create recipient's token account
      const recipientTokenAddress = await getAssociatedTokenAddress(
        mintPubkey,
        recipientPubkey
      );
      
      // Get faucet's token account
      const faucetTokenAddress = await getAssociatedTokenAddress(
        mintPubkey,
        faucetWallet.publicKey
      );
      
      // Check faucet balance before sending
      try {
        const faucetAccount = await getAccount(connection, faucetTokenAddress);
        const faucetBalance = Number(faucetAccount.amount) / 1000000;
        
        if (faucetBalance < amount) {
          throw new Error(`Insufficient faucet balance: ${faucetBalance} < ${amount}`);
        }
      } catch (balanceError: any) {
        throw balanceError;
      }
      
      const transaction = new Transaction();
      
      // Check if recipient token account exists
      try {
        await getAccount(connection, recipientTokenAddress);
      } catch (error) {
        // Account doesn't exist, add instruction to create it
        transaction.add(
          createAssociatedTokenAccountInstruction(
            faucetWallet.publicKey,
            recipientTokenAddress,
            recipientPubkey,
            mintPubkey
          )
        );
      }
      
      // Add transfer instruction (amount * 10^6 because token has 6 decimals)
      transaction.add(
        createTransferInstruction(
          faucetTokenAddress,
          recipientTokenAddress,
          faucetWallet.publicKey,
          amount * 1000000
        )
      );
      
      // Send transaction with optimized settings for production speed
      const signature = await connection.sendTransaction(
        transaction,
        [faucetWallet],
        { 
          skipPreflight: true, // Skip preflight for faster submission
          preflightCommitment: 'processed',
          maxRetries: 3
        }
      );
      
      // Wait for confirmation with processed commitment (faster)
      await connection.confirmTransaction(signature, 'processed');
      
      return {
        success: true,
        txHash: signature
      };
      
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to send tokens'
      };
    }
  }
  
  // Production would implement real Solana SPL transfer with new token
  return {
    success: false,
    error: 'Production 1DEV faucet ready - token configured but real transfer not implemented'
  };
}

/**
 * Send SOL tokens (Solana native)
 */
async function sendSOLTokens(
  address: string,
  amount: number,
  environment: 'testnet' | 'mainnet'
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  
  if (environment === 'testnet') {
    try {
      // Use Solana devnet airdrop
      const response = await fetch('https://api.devnet.solana.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'requestAirdrop',
          params: [address, amount * 1e9] // Convert to lamports
        })
      });
      
      const data = await response.json();
      
      if (data.result) {
        return {
          success: true,
          txHash: data.result
        };
      } else {
        return {
          success: false,
          error: data.error?.message || 'Airdrop failed'
        };
      }
    } catch (error) {
      return {
        success: false,
        error: 'Solana airdrop service unavailable'
      };
    }
  }
  
  // Production SOL faucet not available
  return {
    success: false,
    error: 'Production SOL faucet not available'
  };
}

/**
 * Send QNC tokens (QNet native)
 */
async function sendQNCTokens(
  address: string,
  amount: number,
  environment: 'testnet' | 'mainnet'
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  
  if (environment === 'testnet') {
    try {
      // Real QNet testnet faucet integration
      const qnetApiUrl = process.env.QNET_TESTNET_API || 'https://testnet-api.qnet.io';
      
      const response = await fetch(`${qnetApiUrl}/v1/faucet/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'QNet-Explorer-Faucet/1.0'
        },
        body: JSON.stringify({
          address: address,
          amount: amount,
          token: 'QNC'
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        return {
          success: true,
          txHash: data.txHash
        };
      } else {
        const error = await response.json();
        return {
          success: false,
          error: error.message || 'QNet faucet request failed'
        };
      }
      
    } catch (error) {
      console.error('QNet testnet faucet error:', error);
      
      // Fallback to local node faucet
      try {
        const localResponse = await fetch('http://localhost:8080/api/v1/faucet/claim', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            address: address,
            amount: amount,
            token: 'QNC'
          })
        });
        
        if (localResponse.ok) {
          const data = await localResponse.json();
          return {
            success: true,
            txHash: data.txHash
          };
        }
      } catch (localError) {
        console.error('Local QNet faucet error:', localError);
      }
      
      return {
        success: false,
        error: 'QNet testnet faucet unavailable'
      };
    }
  }
  
  // Production QNet faucet
  try {
    const qnetApiUrl = process.env.QNET_MAINNET_API || 'https://api.qnet.io';
    
    const response = await fetch(`${qnetApiUrl}/v1/faucet/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.QNET_FAUCET_API_KEY}`,
        'User-Agent': 'QNet-Explorer-Faucet/1.0'
      },
      body: JSON.stringify({
        address: address,
        amount: amount,
        token: 'QNC'
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        txHash: data.txHash
      };
    } else {
      const error = await response.json();
      return {
        success: false,
        error: error.message || 'Production QNet faucet request failed'
      };
    }
    
  } catch (error) {
    console.error('Production QNet faucet error:', error);
    return {
      success: false,
      error: 'Production QNet faucet unavailable'
    };
  }
}

/**
 * POST /api/faucet/claim
 * Claim tokens from faucet
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { walletAddress, amount, tokenType = '1DEV' } = body;
    
    // Validate input
    if (!walletAddress || !amount) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: walletAddress, amount' },
        { status: 400 }
      );
    }
    
    // Validate address format
    let isValidAddress = false;
    if (tokenType === 'QNC') {
      isValidAddress = validateQNetAddress(walletAddress);
    } else {
      isValidAddress = validateSolanaAddress(walletAddress);
    }
    
    if (!isValidAddress) {
      return NextResponse.json(
        { success: false, error: 'Invalid wallet address format' },
        { status: 400 }
      );
    }
    
    // Detect environment
    const environment = detectEnvironment(request);
    
    // Check address cooldown FIRST (before any expensive operations)
    const cooldownCheck = checkAddressCooldown(walletAddress, environment);
    
    if (!cooldownCheck.allowed) {
      const nextClaimTime = new Date(cooldownCheck.nextClaimTime!).toISOString();
      return NextResponse.json(
        { 
          success: false, 
          error: 'This address has already claimed tokens. Please wait 24 hours between claims.',
          nextClaimTime 
        },
        { status: 429 }
      );
    }
    
    // Validate amount
    const maxAmount = FAUCET_CONFIG[environment][tokenType as keyof typeof FAUCET_CONFIG.testnet];
    if (!maxAmount || amount > maxAmount) {
      return NextResponse.json(
        { success: false, error: `Maximum amount for ${tokenType} is ${maxAmount}` },
        { status: 400 }
      );
    }
    
    // Check rate limiting (IP-based protection)
    const clientIP = getClientIP(request);
    const rateLimitCheck = checkRateLimit(clientIP);
    
    if (!rateLimitCheck.allowed) {
      const resetTime = new Date(rateLimitCheck.resetTime!).toISOString();
      return NextResponse.json(
        { 
          success: false, 
          error: 'Too many requests from this IP. Please try again later.',
          resetTime 
        },
        { status: 429 }
      );
    }
    
    // Send tokens
    const result = await sendTokens(tokenType, amount, walletAddress, environment);
    
    if (result.success) {
      // Record successful claim with persistent storage
      recordClaim(walletAddress);
      
      return NextResponse.json({
        success: true,
        txHash: result.txHash,
        amount,
        tokenType,
        environment,
        message: `Successfully sent ${amount} ${tokenType} to ${walletAddress}`
      });
    } else {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }
    
  } catch (error) {
    console.error('Faucet API error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/faucet/claim
 * Get faucet information
 */
export async function GET(request: NextRequest) {
  const environment = detectEnvironment(request);
  
  return NextResponse.json({
    environment,
    supportedTokens: Object.keys(FAUCET_CONFIG[environment]),
    amounts: FAUCET_CONFIG[environment],
    cooldownMs: FAUCET_CONFIG.cooldown[environment],
    rateLimit: {
      maxRequestsPerIP: FAUCET_CONFIG.maxRequestsPerIP,
      maxRequestsPerAddress: FAUCET_CONFIG.maxRequestsPerAddress,
      windowMs: 60 * 60 * 1000 // 1 hour
    }
  });
} 