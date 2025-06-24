import { type NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, Keypair } from '@solana/web3.js';
import { createTransferInstruction, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Faucet configuration
const DEVNET_RPC = 'https://api.devnet.solana.com';
const FAUCET_AMOUNT = 1500 * 1000000; // 1500 tokens with 6 decimals
const COOLDOWN_HOURS = 24;

// Test token configuration
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS || '9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf';
const FAUCET_PRIVATE_KEY = process.env.FAUCET_PRIVATE_KEY;

interface ClaimRequest {
  walletAddress: string;
  amount: number;
  tokenType: string;
}

interface ClaimResponse {
  success: boolean;
  txHash?: string;
  error?: string;
  balance?: string;
}

// Simple in-memory cooldown tracking (in production, use Redis or database)
const claimHistory = new Map<string, number>();

export async function POST(request: NextRequest): Promise<NextResponse<ClaimResponse>> {
  try {
    const body: ClaimRequest = await request.json();
    const { walletAddress, amount, tokenType } = body;

    // Validation
    if (!walletAddress || !amount || tokenType !== '1DEV') {
      return NextResponse.json({
        success: false,
        error: 'Invalid request parameters'
      }, { status: 400 });
    }

    // Validate Solana address
    try {
      new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({
        success: false,
        error: 'Invalid Solana wallet address'
      }, { status: 400 });
    }

    // Check cooldown
    const lastClaim = claimHistory.get(walletAddress);
    if (lastClaim) {
      const hoursSinceLastClaim = (Date.now() - lastClaim) / (1000 * 60 * 60);
      if (hoursSinceLastClaim < COOLDOWN_HOURS) {
        const nextClaimTime = new Date(lastClaim + (COOLDOWN_HOURS * 60 * 60 * 1000));
        return NextResponse.json({
          success: false,
          error: `Cooldown active. Next claim available at ${nextClaimTime.toISOString()}`
        }, { status: 429 });
      }
    }

    // Check if we have faucet configuration
    if (!FAUCET_PRIVATE_KEY || FAUCET_PRIVATE_KEY === '[PLACEHOLDER_FOR_MANUAL_SETUP]') {
      return NextResponse.json({
        success: false,
        error: 'Faucet temporarily unavailable. Test token created but faucet setup incomplete due to devnet limits. Please use manual token distribution for testing.',
        tokenInfo: {
          mintAddress: TOKEN_MINT_ADDRESS,
          network: 'devnet',
          symbol: '1DEV-TEST',
          explorers: {
            solscan: `https://solscan.io/token/${TOKEN_MINT_ADDRESS}?cluster=devnet`,
            solanaExplorer: `https://explorer.solana.com/address/${TOKEN_MINT_ADDRESS}?cluster=devnet`
          }
        }
      }, { status: 503 });
    }

    // Initialize Solana connection
    const connection = new Connection(DEVNET_RPC, 'confirmed');
    
    // Load faucet keypair
    const faucetKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(FAUCET_PRIVATE_KEY))
    );

    const tokenMint = new PublicKey(TOKEN_MINT_ADDRESS);
    const recipientPublicKey = new PublicKey(walletAddress);

    // Get or create recipient token account
    const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      faucetKeypair,
      tokenMint,
      recipientPublicKey
    );

    // Get faucet token account
    const faucetTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      faucetKeypair,
      tokenMint,
      faucetKeypair.publicKey
    );

    // Create transfer instruction
    const transferInstruction = createTransferInstruction(
      faucetTokenAccount.address,
      recipientTokenAccount.address,
      faucetKeypair.publicKey,
      FAUCET_AMOUNT,
      [],
      TOKEN_PROGRAM_ID
    );

    // Create and send transaction
    const transaction = new Transaction().add(transferInstruction);
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [faucetKeypair],
      { commitment: 'confirmed' }
    );

    // Update cooldown tracking
    claimHistory.set(walletAddress, Date.now());

    // Get recipient balance
    const balance = await connection.getTokenAccountBalance(recipientTokenAccount.address);

    return NextResponse.json({
      success: true,
      txHash: signature,
      balance: balance.value.uiAmountString || '0'
    });

  } catch (error) {
    console.error('Faucet error:', error);
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  const isConfigured = FAUCET_PRIVATE_KEY && FAUCET_PRIVATE_KEY !== '[PLACEHOLDER_FOR_MANUAL_SETUP]';
  
  return NextResponse.json({
    faucetAmount: FAUCET_AMOUNT / 1000000, // Convert back to UI amount
    cooldownHours: COOLDOWN_HOURS,
    tokenType: '1DEV-TEST',
    network: 'Solana Devnet',
    status: isConfigured ? 'active' : 'setup_required',
    tokenInfo: {
      mintAddress: TOKEN_MINT_ADDRESS,
      totalSupply: '1,000,000,000',
      standard: 'pump.fun compatible',
      explorers: {
        solscan: `https://solscan.io/token/${TOKEN_MINT_ADDRESS}?cluster=devnet`,
        solanaExplorer: `https://explorer.solana.com/address/${TOKEN_MINT_ADDRESS}?cluster=devnet`
      }
    }
  });
} 