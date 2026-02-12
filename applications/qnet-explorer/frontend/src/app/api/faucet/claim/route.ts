import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Faucet Claim API - 1DEV (Solana SPL) + SOL + QNC
// Security: uses only @solana/web3.js + @solana/spl-token (no wallet-adapter)
// ============================================================================

const FAUCET_CONFIG = {
  testnet: { '1DEV': 1500, SOL: 1.0, QNC: 50000 },
  mainnet: { '1DEV': 1500, SOL: 0.1, QNC: 1000 },
  cooldown: {
    testnet: 24 * 60 * 60 * 1000,
    mainnet: 24 * 60 * 60 * 1000,
  },
  maxRequestsPerIP: 10,
  maxRequestsPerAddress: 5,
};

const rateLimitStore = new Map<string, { count: number; lastReset: number }>();
const addressCooldowns = new Map<string, number>();

function validateSolanaAddress(address: string): boolean {
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

function validateQNetAddress(address: string): boolean {
  const eonRegex = /^[a-z0-9]{19}eon[a-z0-9]{15}[a-z0-9]{4}$/;
  return eonRegex.test(address);
}

function checkRateLimit(ip: string): { allowed: boolean; resetTime?: number } {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const record = rateLimitStore.get(ip);

  if (!record || now - record.lastReset > windowMs) {
    rateLimitStore.set(ip, { count: 1, lastReset: now });
    return { allowed: true };
  }

  if (record.count >= FAUCET_CONFIG.maxRequestsPerIP) {
    return { allowed: false, resetTime: record.lastReset + windowMs };
  }

  record.count++;
  return { allowed: true };
}

function checkAddressCooldown(
  address: string,
  environment: 'testnet' | 'mainnet',
): { allowed: boolean; nextClaimTime?: number } {
  const now = Date.now();
  const lastClaim = addressCooldowns.get(address);
  const cooldownMs = FAUCET_CONFIG.cooldown[environment];

  if (lastClaim && now - lastClaim > cooldownMs * 2) {
    addressCooldowns.delete(address);
  }

  if (!lastClaim || now - lastClaim > cooldownMs) {
    return { allowed: true };
  }

  return { allowed: false, nextClaimTime: lastClaim + cooldownMs };
}

function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIP = request.headers.get('x-real-ip');
  const cfIP = request.headers.get('cf-connecting-ip');
  if (forwarded) return forwarded.split(',')[0].trim();
  return realIP || cfIP || 'unknown';
}

function detectEnvironment(request: NextRequest): 'testnet' | 'mainnet' {
  const hostname = request.headers.get('host') || '';
  return hostname.includes('testnet') || hostname.includes('localhost') ? 'testnet' : 'mainnet';
}

// ---------------------------------------------------------------------------
// 1DEV token send (Solana SPL)
// ---------------------------------------------------------------------------
async function send1DEVTokens(
  address: string,
  amount: number,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const TOKEN_MINT = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
  const DECIMALS = 6;

  try {
    const { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } = await import(
      '@solana/web3.js'
    );
    const {
      createTransferInstruction,
      getAssociatedTokenAddress,
      createAssociatedTokenAccountInstruction,
    } = await import('@solana/spl-token');

    const rpcEndpoints = [
      'https://api.devnet.solana.com',
      'https://rpc.ankr.com/solana_devnet',
    ];

    const connection = new Connection(rpcEndpoints[0], {
      commitment: 'processed',
      confirmTransactionInitialTimeout: 3000,
    });

    // Load faucet private key
    let faucetPrivateKey: number[] | undefined;
    const faucetPrivateKeyEnv = process.env.FAUCET_PRIVATE_KEY;

    if (faucetPrivateKeyEnv) {
      faucetPrivateKey = JSON.parse(faucetPrivateKeyEnv);
    } else {
      const path = await import('path');
      const fs = await import('fs');
      const candidates = [
        path.join(process.cwd(), '..', '..', '..', 'infrastructure', 'config', 'faucet-config-testnet.json'),
        '/var/qnet-fresh/infrastructure/config/faucet-config-testnet.json',
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
          faucetPrivateKey = cfg.wallet?.secretKey;
          break;
        }
      }
    }

    if (!faucetPrivateKey) {
      return { success: false, error: 'Faucet configuration error - private key not found' };
    }

    const faucetWallet = Keypair.fromSecretKey(new Uint8Array(faucetPrivateKey));
    const mintPubkey = new PublicKey(TOKEN_MINT);
    const recipientPubkey = new PublicKey(address);

    const recipientTokenAddress = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);
    const faucetTokenAddress = await getAssociatedTokenAddress(mintPubkey, faucetWallet.publicKey);

    const { blockhash } = await connection.getLatestBlockhash('processed');

    const transaction = new Transaction();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = faucetWallet.publicKey;

    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));
    transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));

    // Optimistically create associated token account (idempotent)
    transaction.add(
      createAssociatedTokenAccountInstruction(
        faucetWallet.publicKey,
        recipientTokenAddress,
        recipientPubkey,
        mintPubkey,
      ),
    );

    transaction.add(
      createTransferInstruction(
        faucetTokenAddress,
        recipientTokenAddress,
        faucetWallet.publicKey,
        amount * 10 ** DECIMALS,
      ),
    );

    const signature = await connection.sendTransaction(transaction, [faucetWallet], {
      skipPreflight: true,
      preflightCommitment: 'processed',
      maxRetries: 0,
    });

    // Fire-and-forget confirmation
    setTimeout(async () => {
      try {
        await connection.confirmTransaction(signature, 'processed');
      } catch {
        /* non-critical */
      }
    }, 100);

    return { success: true, txHash: signature };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to send 1DEV tokens';
    return { success: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// SOL airdrop (Solana devnet, plain HTTP)
// ---------------------------------------------------------------------------
async function sendSOLTokens(
  address: string,
  amount: number,
  environment: 'testnet' | 'mainnet',
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  if (environment !== 'testnet') {
    return { success: false, error: 'Production SOL faucet not available' };
  }

  try {
    const response = await fetch('https://api.devnet.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'requestAirdrop',
        params: [address, amount * 1e9],
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await response.json();
    if (data.result) {
      return { success: true, txHash: data.result };
    }
    return { success: false, error: data.error?.message || 'Airdrop failed' };
  } catch {
    return { success: false, error: 'Solana airdrop service unavailable' };
  }
}

// ---------------------------------------------------------------------------
// QNC tokens (QNet native, plain HTTP)
// ---------------------------------------------------------------------------
async function sendQNCTokens(
  address: string,
  amount: number,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const bootstrapNodes = [
    'http://154.38.160.39:8001',
    'http://62.171.157.44:8001',
    'http://161.97.86.81:8001',
    'http://5.189.130.160:8001',
    'http://162.244.25.114:8001',
  ];
  const qnetApiUrl =
    process.env.QNET_NODE_URL || bootstrapNodes[Math.floor(Math.random() * bootstrapNodes.length)];

  try {
    const response = await fetch(`${qnetApiUrl}/v1/faucet/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'QNet-Explorer-Faucet/1.0' },
      body: JSON.stringify({ address, amount, token: 'QNC' }),
      signal: AbortSignal.timeout(15000),
    });

    if (response.ok) {
      const data = await response.json();
      return { success: true, txHash: data.txHash };
    }
    const err = await response.json().catch(() => ({ message: 'QNet faucet request failed' }));
    return { success: false, error: err.message || 'QNet faucet request failed' };
  } catch {
    return { success: false, error: 'QNet faucet unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
async function sendTokens(
  tokenType: string,
  amount: number,
  address: string,
  environment: 'testnet' | 'mainnet',
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  switch (tokenType) {
    case '1DEV':
      return send1DEVTokens(address, amount);
    case 'SOL':
      return sendSOLTokens(address, amount, environment);
    case 'QNC':
      return sendQNCTokens(address, amount);
    default:
      return { success: false, error: 'Unsupported token type' };
  }
}

// ---------------------------------------------------------------------------
// POST /api/faucet/claim
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { walletAddress, amount, tokenType = '1DEV' } = body;

    if (!walletAddress || !amount) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: walletAddress, amount' },
        { status: 400 },
      );
    }

    // Validate address format
    const isValid =
      tokenType === 'QNC' ? validateQNetAddress(walletAddress) : validateSolanaAddress(walletAddress);

    if (!isValid) {
      return NextResponse.json(
        { success: false, error: 'Invalid wallet address format' },
        { status: 400 },
      );
    }

    const environment = detectEnvironment(request);

    // Validate amount
    const maxAmount =
      FAUCET_CONFIG[environment][tokenType as keyof (typeof FAUCET_CONFIG)['testnet']];
    if (!maxAmount || amount > maxAmount) {
      return NextResponse.json(
        { success: false, error: `Maximum amount for ${tokenType} is ${maxAmount}` },
        { status: 400 },
      );
    }

    // Rate-limiting & cooldown for mainnet only
    if (environment !== 'testnet') {
      const cooldownCheck = checkAddressCooldown(walletAddress, environment);
      if (!cooldownCheck.allowed) {
        return NextResponse.json(
          {
            success: false,
            error: 'Please wait 24 hours between claims.',
            nextClaimTime: new Date(cooldownCheck.nextClaimTime!).toISOString(),
          },
          { status: 429 },
        );
      }

      const clientIP = getClientIP(request);
      const rl = checkRateLimit(clientIP);
      if (!rl.allowed) {
        return NextResponse.json(
          { success: false, error: 'Too many requests. Please try again later.' },
          { status: 429 },
        );
      }
    }

    const result = await sendTokens(tokenType, amount, walletAddress, environment);

    if (result.success) {
      if (environment !== 'testnet') addressCooldowns.set(walletAddress, Date.now());
      return NextResponse.json({
        success: true,
        txHash: result.txHash,
        amount,
        tokenType,
        environment,
        message: `Successfully sent ${amount} ${tokenType} to ${walletAddress}`,
      });
    }

    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  } catch {
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/faucet/claim
// ---------------------------------------------------------------------------
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
      windowMs: 60 * 60 * 1000,
    },
  });
}
