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
// Confirm a submitted tx with a THREE-WAY outcome so the caller can decide whether it is safe to
// release the anti-double-claim reservation:
//   'landed'  — tx confirmed on-chain (deliver, keep cooldown).
//   'failed'  — DEFINITIVE not-landed: an on-chain error, OR the blockhash provably expired without
//               the tx landing (an expired-blockhash tx can NEVER land) → safe to release + retry.
//   'unknown' — AMBIGUOUS: RPC flaked / polling window elapsed while the blockhash is still valid, so
//               the tx may still land (maxRetries keeps rebroadcasting) → KEEP the reservation.
// Each poll iteration is isolated in try/catch so a transient RPC error never aborts the loop into a
// false 'failed'.
async function confirmSig(
  connection: import('@solana/web3.js').Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<{ status: 'landed' | 'failed' | 'unknown'; err: unknown }> {
  try {
    const conf = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    return conf.value?.err
      ? { status: 'failed', err: conf.value.err }
      : { status: 'landed', err: null };
  } catch {
    // Poll until the tx lands, definitively errors, or the blockhash provably expires.
    for (let i = 0; i < 24; i++) {
      try {
        const st = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
        const s = st.value;
        if (s) {
          if (s.err) return { status: 'failed', err: s.err };
          if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
            return { status: 'landed', err: null };
          }
        }
        // Blockhash expired with no status yet ⇒ the tx can never land ⇒ definitive failure.
        const currentHeight = await connection.getBlockHeight('confirmed');
        if (currentHeight > lastValidBlockHeight) {
          return { status: 'failed', err: 'blockhash_expired' };
        }
      } catch {
        // transient RPC error — ignore this tick, the blockhash may still be valid
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    // Polling window elapsed while the blockhash could still be valid — cannot prove it didn't land.
    return { status: 'unknown', err: 'confirmation_timeout' };
  }
}

async function send1DEVTokens(
  address: string,
  amount: number,
): Promise<{ success: boolean; txHash?: string; error?: string; releasable?: boolean }> {
  const TOKEN_MINT = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
  const DECIMALS = 6;

  try {
    const { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } = await import(
      '@solana/web3.js'
    );
    const {
      createTransferInstruction,
      getAssociatedTokenAddress,
      createAssociatedTokenAccountIdempotentInstruction,
    } = await import('@solana/spl-token');

    const rpcEndpoints = [
      'https://api.devnet.solana.com',
      'https://rpc.ankr.com/solana_devnet',
    ];

    const connection = new Connection(rpcEndpoints[0], {
      commitment: 'processed',
      confirmTransactionInitialTimeout: 60000,
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

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = faucetWallet.publicKey;

    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));
    transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));

    // Create the recipient ATA IDEMPOTENTLY. The non-idempotent variant aborts the whole tx with
    // IllegalOwner when the ATA already exists — so the transfer below never runs and nothing is
    // delivered (the historical false-"success" cause). Idempotent = no-op if the ATA already exists.
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
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

    // Confirm on-chain BEFORE reporting success — a submitted-but-failed tx must never read as
    // delivered. Preflight on so a doomed tx is rejected up front instead of silently accepted.
    const signature = await connection.sendTransaction(transaction, [faucetWallet], {
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });
    const conf = await confirmSig(connection, signature, blockhash, lastValidBlockHeight);
    if (conf.status !== 'landed') {
      // 'failed' ⇒ releasable (definitely didn't land); 'unknown' ⇒ NOT releasable (may still land).
      return {
        success: false,
        txHash: signature,
        error: `On-chain/confirm ${conf.status}: ${JSON.stringify(conf.err)}`,
        releasable: conf.status === 'failed',
      };
    }

    return { success: true, txHash: signature };
  } catch (error: unknown) {
    // Thrown before a signature exists ⇒ nothing was submitted ⇒ safe to release the reservation.
    const msg = error instanceof Error ? error.message : 'Failed to send 1DEV tokens';
    return { success: false, error: msg, releasable: true };
  }
}

// ---------------------------------------------------------------------------
// SOL transfer — sends from faucet wallet (same key as 1DEV)
// ---------------------------------------------------------------------------
async function sendSOLTokens(
  address: string,
  amount: number,
): Promise<{ success: boolean; txHash?: string; error?: string; releasable?: boolean }> {
  try {
    const { Connection, Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } =
      await import('@solana/web3.js');

    const connection = new Connection('https://api.devnet.solana.com', {
      commitment: 'processed',
      confirmTransactionInitialTimeout: 60000,
    });

    // Fail-closed: signing key sourced only from the runtime secret (same
    // wallet as 1DEV). No on-disk fallback.
    const faucetWallet = loadFaucetWallet(Keypair);
    if (!faucetWallet) {
      return { success: false, error: 'Faucet configuration error - private key not found' };
    }

    const recipientPubkey = new PublicKey(address);
    const lamports = Math.round(amount * 1e9);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
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
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });
    // Confirm before reporting success (same discipline as the 1DEV path).
    const conf = await confirmSig(connection, signature, blockhash, lastValidBlockHeight);
    if (conf.status !== 'landed') {
      return {
        success: false,
        txHash: signature,
        error: `On-chain/confirm ${conf.status}: ${JSON.stringify(conf.err)}`,
        releasable: conf.status === 'failed',
      };
    }

    return { success: true, txHash: signature };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to send SOL';
    return { success: false, error: msg, releasable: true };
  }
}

// ---------------------------------------------------------------------------
// QNC tokens (QNet native, plain HTTP)
// ---------------------------------------------------------------------------
async function sendQNCTokens(
  address: string,
  amount: number,
): Promise<{ success: boolean; txHash?: string; error?: string; releasable?: boolean }> {
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
    // Definitive server-side reject (node returned an error status): nothing was dispensed ⇒ releasable.
    const err = await response.json().catch(() => ({ message: 'QNet faucet request failed' }));
    return { success: false, error: err.message || 'QNet faucet request failed', releasable: true };
  } catch {
    // Network error / timeout after the request left: the node MAY have processed it ⇒ keep the
    // reservation (releasable stays undefined) so a lost-response claim is not double-dispensed.
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
): Promise<{ success: boolean; txHash?: string; error?: string; releasable?: boolean }> {
  switch (tokenType) {
    case '1DEV':
      return send1DEVTokens(address, amount);
    case 'SOL':
      return sendSOLTokens(address, amount);
    case 'QNC':
      return sendQNCTokens(address, amount);
    default:
      // Unsupported type never sent anything ⇒ releasable.
      return { success: false, error: 'Unsupported token type', releasable: true };
  }
}

// ---------------------------------------------------------------------------
// POST /api/faucet/claim
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { walletAddress, amount, tokenType = '1DEV' } = body;

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Missing required field: walletAddress' },
        { status: 400 },
      );
    }
    // Amount must be a finite positive number — reject negatives/NaN/strings/objects before any math.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { success: false, error: 'Invalid amount: must be a positive number' },
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

      // Reserve the per-address slot BEFORE dispatching (which now awaits confirmation for seconds), so
      // concurrent same-wallet claims can't all pass the cooldown check and each send. Released below only
      // on a hard pre-send / on-chain failure — a landed-but-slow tx keeps the reservation.
      addressCooldowns.set(walletAddress, Date.now());
    }

    const result = await sendTokens(tokenType, amount, walletAddress, environment);

    if (result.success) {
      return NextResponse.json({
        success: true,
        txHash: result.txHash,
        amount,
        tokenType,
        environment,
        message: `Successfully sent ${amount} ${tokenType} to ${walletAddress}`,
      });
    }

    // Release the per-address reservation ONLY when the send definitively did not and cannot land
    // (pre-send failure or a definitive on-chain error / expired blockhash). An AMBIGUOUS outcome
    // (RPC flake / confirm timeout while the blockhash may still be valid) KEEPS the reservation so a
    // slow-but-landed tx can never be double-paid on retry. Always echo the signature (when present)
    // so the money-moving operation is observable on a Solana explorer even on failure.
    if (environment !== 'testnet' && result.releasable === true) {
      addressCooldowns.delete(walletAddress);
    }
    return NextResponse.json(
      { success: false, error: result.error, txHash: result.txHash ?? null },
      { status: 500 },
    );
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
