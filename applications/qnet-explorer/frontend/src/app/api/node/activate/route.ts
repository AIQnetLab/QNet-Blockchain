import { type NextRequest, NextResponse } from 'next/server';
import { PublicKey, Connection } from '@solana/web3.js';
import { createHash, randomBytes } from 'crypto';

// Configuration
const DEVNET_RPC = 'https://api.devnet.solana.com';
const BURN_ADDRESS = '1nc1nerator11111111111111111111111111111111'; // Official Solana incinerator address
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS || '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';

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

    // Generate activation code with embedded wallet address
    const activationCode = generateActivationCodeWithEmbeddedWallet(result.hash, walletAddress, nodeType, burnAmount);

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

function generateActivationCodeWithEmbeddedWallet(burnTx: string, wallet: string, nodeType: string, burnAmount: number): string {
  // Generate quantum-secure activation code with embedded wallet address
  const timestamp = Date.now();
  const hardwareEntropy = randomBytes(8).toString('hex'); // Shorter for space
  
  // Create encryption key from burn transaction (deterministic)
  const keyMaterial = `${burnTx}:${nodeType}:${burnAmount}`;
  const encryptionKey = createHash('sha256').update(keyMaterial).digest('hex').substring(0, 32);
  
  // Encrypt wallet address with XOR (simple and reversible)
  let encryptedWallet = '';
  for (let i = 0; i < wallet.length; i++) {
    const walletChar = wallet.charCodeAt(i);
    const keyChar = encryptionKey.charCodeAt(i % encryptionKey.length);
    encryptedWallet += String.fromCharCode(walletChar ^ keyChar);
  }
  
  // Convert encrypted wallet to hex
  const encryptedWalletHex = Buffer.from(encryptedWallet, 'binary').toString('hex');
  
  // Create structured code with embedded data
  const nodeTypeMarker = nodeType.charAt(0).toUpperCase(); // L, F, S
  const timestampHex = timestamp.toString(16).substring(-8); // Last 8 hex chars
  const entropyShort = hardwareEntropy.substring(0, 4); // 4 hex chars
  
  // Embed wallet in the code structure: QNET-[TYPE+TIMESTAMP]-[WALLET_PART1]-[WALLET_PART2+ENTROPY]
  const walletPart1 = encryptedWalletHex.substring(0, 8);
  const walletPart2 = encryptedWalletHex.substring(8, 16);
  
  // Store metadata for decryption in first segment
  const segment1 = (nodeTypeMarker + timestampHex).substring(0, 4).toUpperCase();
  const segment2 = walletPart1.substring(0, 4).toUpperCase();  
  const segment3 = (walletPart2 + entropyShort).substring(0, 4).toUpperCase();
  
  return `QNET-${segment1}-${segment2}-${segment3}`;
}

function generateNodeId(walletAddress: string, nodeType: string): string {
  // Generate unique node ID
  const data = `${walletAddress}:${nodeType}:${Date.now()}`;
  const hash = createHash('sha256').update(data).digest('hex');
  return `node_${nodeType}_${hash.substring(0, 8)}`;
} 