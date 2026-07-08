import { NextRequest, NextResponse } from 'next/server';
import { getRateLimitKey } from '../../../../../lib/rate-limit';

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

// ---------------------------------------------------------------------------
// Faucet signing key loader
// ---------------------------------------------------------------------------
// The key is read ONLY from the runtime secret FAUCET_PRIVATE_KEY (a JSON
// byte-array, injected by the deploy's secrets manager). It is never logged
// and there is no on-disk fallback — the wallet must not be recoverable from
// repo/config files. Returns null when unset/malformed so callers fail closed.
function loadFaucetWallet(
  Keypair: typeof import('@solana/web3.js').Keypair,
): import('@solana/web3.js').Keypair | null {
  const raw = process.env.FAUCET_PRIVATE_KEY;
  if (!raw) return null;
  try {
    const bytes = JSON.parse(raw);
    if (!Array.isArray(bytes) || bytes.length === 0) return null;
    return Keypair.fromSecretKey(new Uint8Array(bytes));
  } catch {
    // Never surface the key material in the error path.
    return null;
  }
}

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

// ---------------------------------------------------------------------------
// v14.5: SECURE ENVIRONMENT DETECTION
// ---------------------------------------------------------------------------
// Previous implementation inferred the environment from the Host header,
// which is supplied by the client and can be forged:
//   curl -H "Host: testnet.example" https://mainnet.example/api/faucet/claim
// That caused the rate-limit bypass branch (environment === 'testnet' skips
// the limit) to fire on mainnet, enabling unlimited SPL 1DEV transfers.
//
// New rule: environment comes ONLY from a server-side build-time or runtime
// env var that the client cannot influence. FAUCET_ENV must be 'testnet' or
// 'mainnet' — anything else (or missing) defaults to the safer 'mainnet'.
// NEXT_PUBLIC_NETWORK is accepted as a secondary fallback because it is
// already used across the frontend for network switching; note it is fixed
// at build time so still not attacker-influenceable per request.
// ---------------------------------------------------------------------------
function detectEnvironment(_request: NextRequest): 'testnet' | 'mainnet' {
  const explicit = (process.env.FAUCET_ENV || process.env.NEXT_PUBLIC_NETWORK || '').toLowerCase();
  if (explicit === 'testnet' || explicit === 'dev' || explicit === 'development') {
    return 'testnet';
  }
  // Default: safer branch — mainnet rules (full rate limiting).
  return 'mainnet';
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

    // Fail-closed: the signing key comes ONLY from the runtime secret (injected
    // by the deploy's secrets manager). No on-disk fallback — a committed key
    // file would leak the wallet to anyone with repo access.
    const faucetWallet = loadFaucetWallet(Keypair);
    if (!faucetWallet) {
      return { success: false, error: 'Faucet configuration error - private key not found' };
    }

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
// SOL transfer — sends from faucet wallet (same key as 1DEV)
// ---------------------------------------------------------------------------
async function sendSOLTokens(
  address: string,
  amount: number,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const { Connection, Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } =
      await import('@solana/web3.js');

    const connection = new Connection('https://api.devnet.solana.com', {
      commitment: 'processed',
      confirmTransactionInitialTimeout: 3000,
    });

    // Fail-closed: signing key sourced only from the runtime secret (same
    // wallet as 1DEV). No on-disk fallback.
    const faucetWallet = loadFaucetWallet(Keypair);
    if (!faucetWallet) {
      return { success: false, error: 'Faucet configuration error - private key not found' };
    }

    const recipientPubkey = new PublicKey(address);
    const lamports = Math.round(amount * 1e9);

    const { blockhash } = await connection.getLatestBlockhash('processed');
    const transaction = new Transaction();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = faucetWallet.publicKey;

    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: faucetWallet.publicKey,
        toPubkey: recipientPubkey,
        lamports,
      }),
    );

    const signature = await connection.sendTransaction(transaction, [faucetWallet], {
      skipPreflight: true,
      preflightCommitment: 'processed',
      maxRetries: 0,
    });

    setTimeout(async () => {
      try { await connection.confirmTransaction(signature, 'processed'); } catch { /* non-critical */ }
    }, 100);

    return { success: true, txHash: signature };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to send SOL';
    return { success: false, error: msg };
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
    'https://154.38.160.39:8001',
    'https://62.171.157.44:8001',
    'https://161.97.86.81:8001',
    'https://5.189.130.160:8001',
    'https://162.244.25.114:8001',
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
      return sendSOLTokens(address, amount);
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

      // Derive the per-IP key from trusted proxy headers. On mainnet with no
      // trusted proxy configured this fails closed (503) instead of collapsing
      // every caller into one shared bucket.
      const ipKey = getRateLimitKey(request);
      if (!ipKey.ok) {
        return NextResponse.json(
          { success: false, error: `Service misconfigured: ${ipKey.reason}` },
          { status: 503 },
        );
      }

      const rl = checkRateLimit(ipKey.ip);
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
