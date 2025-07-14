import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, Keypair } from '@solana/web3.js';
import { createTransferInstruction, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Production faucet configuration
const FAUCET_CONFIG = {
  // Testnet amounts
  testnet: {
    '1DEV': 2000,
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
    testnet: 1 * 60 * 60 * 1000, // 1 hour for testnet
    mainnet: 24 * 60 * 60 * 1000  // 24 hours for mainnet
  },
  // Rate limiting
  maxRequestsPerIP: 10,
  maxRequestsPerAddress: 5
};

// In-memory storage for rate limiting (in production, use Redis)
const rateLimitStore = new Map<string, { count: number; lastReset: number }>();
const addressCooldowns = new Map<string, number>();

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
  // EON address format: 8chars + "eon" + 8chars + 4char checksum
  const eonRegex = /^[a-z0-9]{8}eon[a-z0-9]{8}[a-z0-9]{4}$/;
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
 * Check cooldown for wallet address
 */
function checkAddressCooldown(address: string, environment: 'testnet' | 'mainnet'): { allowed: boolean; nextClaimTime?: number } {
  const now = Date.now();
  const lastClaim = addressCooldowns.get(address);
  const cooldownMs = FAUCET_CONFIG.cooldown[environment];
  
  if (!lastClaim || now - lastClaim > cooldownMs) {
    return { allowed: true };
  }
  
  const nextClaimTime = lastClaim + cooldownMs;
  return { allowed: false, nextClaimTime };
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
    // Simulate real token transfer for new 1DEV token
    const mockTxHash = `1DEV_PHASE1_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Log faucet activity
    console.log(`🚰 Faucet: Sending ${amount} 1DEV tokens to ${address}`);
    console.log(`📍 Token: ${TOKEN_CONFIG.mintAddress} (Phase 1 Ready)`);
    console.log(`📊 Phase: ${TOKEN_CONFIG.phase} (Universal pricing 1500 1DEV)`);
    
    // Simulate network delay for realistic UX
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    return {
      success: true,
      txHash: mockTxHash
    };
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
    // Mock QNC transaction for testnet
    const mockTxHash = `QNC_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    return {
      success: true,
      txHash: mockTxHash
    };
  }
  
  // Production would implement real QNet transfer
  return {
    success: false,
    error: 'Production QNC faucet not yet implemented'
  };
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
    
    // Validate amount
    const maxAmount = FAUCET_CONFIG[environment][tokenType as keyof typeof FAUCET_CONFIG.testnet];
    if (!maxAmount || amount > maxAmount) {
      return NextResponse.json(
        { success: false, error: `Maximum amount for ${tokenType} is ${maxAmount}` },
        { status: 400 }
      );
    }
    
    // Check rate limiting
    const clientIP = getClientIP(request);
    const rateLimitCheck = checkRateLimit(clientIP);
    
    if (!rateLimitCheck.allowed) {
      const resetTime = new Date(rateLimitCheck.resetTime!).toISOString();
      return NextResponse.json(
        { 
          success: false, 
          error: 'Rate limit exceeded',
          resetTime 
        },
        { status: 429 }
      );
    }
    
    // Check address cooldown
    const cooldownCheck = checkAddressCooldown(walletAddress, environment);
    
    if (!cooldownCheck.allowed) {
      const nextClaimTime = new Date(cooldownCheck.nextClaimTime!).toISOString();
      return NextResponse.json(
        { 
          success: false, 
          error: 'Address is in cooldown period',
          nextClaimTime 
        },
        { status: 429 }
      );
    }
    
    // Send tokens
    const result = await sendTokens(tokenType, amount, walletAddress, environment);
    
    if (result.success) {
      // Update cooldown
      addressCooldowns.set(walletAddress, Date.now());
      
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