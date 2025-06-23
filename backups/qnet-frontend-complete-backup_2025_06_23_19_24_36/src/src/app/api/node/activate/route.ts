import { type NextRequest, NextResponse } from 'next/server';
import { PublicKey, Connection } from '@solana/web3.js';
import { createHash } from 'crypto';

// Configuration
const DEVNET_RPC = 'https://api.devnet.solana.com';
const BURN_ADDRESS = '11111111111111111111111111111112'; // Solana burn address
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS || 'PLACEHOLDER_TO_BE_CREATED';

const QNET_API_BASE = process.env.QNET_API_BASE || 'http://localhost:8080';

interface ActivationRequest {
  walletAddress: string;
  nodeType: 'light' | 'full' | 'super';
  burnAmount: number;
}

interface ActivationResponse {
  success: boolean;
  activationCode?: string;
  txHash?: string;
  error?: string;
}

// Node type requirements (Phase 1: all same amount)
const NODE_REQUIREMENTS = {
  light: 1500,
  full: 1500,
  super: 1500
};

export async function POST(request: NextRequest): Promise<NextResponse<ActivationResponse>> {
  try {
    const body: ActivationRequest = await request.json();
    const { walletAddress, nodeType, burnAmount } = body;

    // Basic validation
    if (!walletAddress || !nodeType || !burnAmount) {
      return NextResponse.json({ success: false, error: 'Missing parameters' }, { status: 400 });
    }

    // Build transaction request for QNet API
    const txPayload = {
      from: walletAddress, // Using wallet as sender
      tx_type: {
        type: 'node_activation',
        node_type: nodeType,
        burn_amount: burnAmount,
        phase: 'phase1'
      },
      nonce: 1,
      gas_price: 1,
      gas_limit: 21000,
      signature: 'PLACEHOLDER_SIGNATURE' // TODO: client-side signing
    };

    const apiResponse = await fetch(`${QNET_API_BASE}/api/v1/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(txPayload)
    });

    const result = await apiResponse.json();

    if (!apiResponse.ok || !result.hash) {
      return NextResponse.json({ success: false, error: result.error || 'Activation failed' }, { status: 500 });
    }

    // Generate activation code locally (hash of tx hash)
    const activationCode = generateActivationCode(result.hash);

    return NextResponse.json({ success: true, activationCode, txHash: result.hash });
  } catch (error) {
    console.error('Activation error:', error);
    return NextResponse.json({ success: false, error: 'Unexpected server error' }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    nodeTypes: {
      light: {
        burnAmount: NODE_REQUIREMENTS.light,
        description: 'Mobile-optimized node for basic validation'
      },
      full: {
        burnAmount: NODE_REQUIREMENTS.full,
        description: 'Complete validation node for desktop/server'
      },
      super: {
        burnAmount: NODE_REQUIREMENTS.super,
        description: 'High-performance node for enterprise use'
      }
    },
    phase: 1,
    tokenType: '1DEV',
    network: 'Solana Devnet'
  });
}

function generateActivationCode(txHash: string): string {
  return `QNET-${txHash.substring(0, 4)}-${txHash.substring(4, 8)}-${txHash.substring(8, 12)}`.toUpperCase();
}

function generateNodeId(walletAddress: string, nodeType: string): string {
  // Generate unique node ID
  const data = `${walletAddress}:${nodeType}:${Date.now()}`;
  const hash = createHash('sha256').update(data).digest('hex');
  return `node_${nodeType}_${hash.substring(0, 8)}`;
} 