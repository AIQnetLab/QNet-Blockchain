import { NextRequest, NextResponse } from 'next/server';
import { getRateLimitKey } from '../../../../../lib/rate-limit';
import { readJsonPost } from '@/server/request-guard';
import { LEGACY_COOLDOWN_MS, LEGACY_HOURLY, LEGACY_PER_IP, PASS_SHARE, PER_NETWORK, legacyFaucetGuard } from '@/server/faucet-guard';
import { checkFaucetPass, sharedFaucetPassKey } from '@/server/faucet-pass';
import { signLegacyTransaction, toBaseUnits } from '@/server/solana-tx';
import { faucetEnvironment, loadFaucetSigner } from '@/server/faucet-config';
import { confirmSignature, latestBlockhash, sendTransaction } from '@/server/solana-rpc';
import { sharedSolanaRpc } from '@/server/solana-endpoint';
import {
  ONE_DEV_DECIMALS,
  SOL_DECIMALS,
  oneDevTransferInstructions,
  solTransferInstructions,
} from '@/server/faucet-tx';

// ============================================================================
// Faucet Claim API - devnet 1DEV (Solana SPL) + devnet SOL, from the faucet wallet. Nothing else is handed out.
// The Solana transactions are built, signed and confirmed by src/server/solana-tx.ts and solana-rpc.ts,
// with no Solana SDK in this process: the only code near FAUCET_PRIVATE_KEY is the site's own.
// ============================================================================

// The most one claim may ask for. The /testnet page asks 0.005 SOL, enough for a wallet to fund a payment address of
// My node (its SOL and its 1DEV account's rent, with the fees); the faucet wallet's SOL is shared, so a claim never
// takes more than 0.01 (SITE-R1-02). Test tokens only: on a release whose network is not testnet (faucetEnvironment,
// from BURN_CLUSTER) the faucet sends nothing (SITE-R3-01).
const FAUCET_AMOUNTS = { '1DEV': 1500, SOL: 0.01 } as const;
const faucetAmounts = (environment: 'testnet' | 'mainnet'): typeof FAUCET_AMOUNTS | null => (environment === 'mainnet' ? null : FAUCET_AMOUNTS);
// {walletAddress, amount, tokenType, pass} fits in a few hundred bytes.
const FAUCET_BODY_MAX_BYTES = 1024;

type SendResult = { success: boolean; txHash?: string; error?: string; releasable?: boolean };

function validateSolanaAddress(address: string): boolean {
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

// ---------------------------------------------------------------------------
// 1DEV (SPL token) and SOL on Solana devnet
// ---------------------------------------------------------------------------
// The result says whether the anti-double-claim reservation may be released:
//   releasable true  — definitely not sent (a failure before sending, or the RPC refused it), or it
//                      definitely cannot land (failed on chain, or its blockhash expired unseen).
//   releasable false — it may still land (no answer to the send, or no confirmation before the
//                      deadline while its blockhash is valid): the reservation stays.
// The transaction id is the faucet's signature, known before sending, so it is echoed even when
// the send itself gets no answer.
async function sendSolanaTransfer(kind: '1DEV' | 'SOL', address: string, amount: number): Promise<SendResult> {
  const signer = loadFaucetSigner();
  if (!signer) {
    return { success: false, error: 'Faucet configuration error - private key not found', releasable: true };
  }
  try {
    const raw = toBaseUnits(amount, kind === '1DEV' ? ONE_DEV_DECIMALS : SOL_DECIMALS);
    if (raw === null) return { success: false, error: 'Invalid amount', releasable: true };

    const rpc = sharedSolanaRpc();
    let signed: { wire: Uint8Array; signature: string };
    let lastValidBlockHeight: number;
    try {
      const latest = await latestBlockhash(rpc);
      lastValidBlockHeight = latest.lastValidBlockHeight;
      const instructions = kind === '1DEV'
        ? oneDevTransferInstructions(signer.publicKey, address, raw)
        : solTransferInstructions(signer.publicKey, address, raw);
      signed = signLegacyTransaction(instructions, signer, latest.blockhash);
    } catch (error: unknown) {
      // Nothing was sent.
      const msg = error instanceof Error ? error.message : `Failed to send ${kind}`;
      return { success: false, error: msg, releasable: true };
    }

    const sent = await sendTransaction(rpc, signed.wire);
    if (sent.state === 'refused') return { success: false, error: sent.error, releasable: true };

    const conf = await confirmSignature(rpc, signed.signature, lastValidBlockHeight);
    if (conf.status === 'landed') return { success: true, txHash: signed.signature };
    return {
      success: false,
      txHash: signed.signature,
      error: `On-chain/confirm ${conf.status}: ${conf.reason}`,
      releasable: conf.status === 'failed',
    };
  } finally {
    signer.seed.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
async function sendTokens(tokenType: string, amount: number, address: string): Promise<SendResult> {
  switch (tokenType) {
    case '1DEV':
    case 'SOL':
      return sendSolanaTransfer(tokenType, address, amount);
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
    // Before anything else: no Origin (a script, the SDK) or aiqnet.io's own, a JSON body, a size cap.
    // Another site's page can then send nothing here with its visitors' IP addresses.
    const read = await readJsonPost(request, FAUCET_BODY_MAX_BYTES);
    if (!read.ok) {
      return NextResponse.json({ success: false, error: read.error }, { status: read.status });
    }
    const body = read.value;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
    }
    const { walletAddress, amount, tokenType = '1DEV', pass = null } = body as Record<string, unknown>;

    if (typeof walletAddress !== 'string' || !walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Missing required field: walletAddress' },
        { status: 400 },
      );
    }
    if (typeof tokenType !== 'string') {
      return NextResponse.json({ success: false, error: 'Unsupported token type' }, { status: 400 });
    }
    // Amount must be a finite positive number — reject negatives/NaN/strings/objects before any math.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { success: false, error: 'Invalid amount: must be a positive number' },
        { status: 400 },
      );
    }

    if (!validateSolanaAddress(walletAddress)) {
      return NextResponse.json(
        { success: false, error: 'Invalid wallet address format' },
        { status: 400 },
      );
    }

    const environment = faucetEnvironment();
    const amounts = faucetAmounts(environment);
    if (!amounts) {
      return NextResponse.json({ success: false, error: 'The faucet sends test tokens only' }, { status: 404 });
    }

    // Validate amount
    const maxAmount = Object.prototype.hasOwnProperty.call(amounts, tokenType)
      ? amounts[tokenType as keyof typeof FAUCET_AMOUNTS]
      : undefined;
    if (!maxAmount || amount > maxAmount) {
      return NextResponse.json(
        { success: false, error: `Maximum amount for ${tokenType} is ${maxAmount}` },
        { status: 400 },
      );
    }

    // Every claim (SITE-R1-02): the per-(address, token) cooldown, the per-IP and per-network windows (X-Real-IP from
    // nginx, else the socket address) and the faucet's hourly budget per token, most of it kept for claims with a faucet
    // pass, one of each token per wallet a day (SITE M-13). A pass that does not check out, or has ended, makes the claim
    // an open one. The places are taken before the transfer is sent, keyed per token so the page's parallel 1DEV and SOL
    // pair never refuses itself (src/server/faucet-guard.ts). A refusal says when to try again.
    const wallet = checkFaucetPass(sharedFaucetPassKey(), pass, Date.now());
    const admission = legacyFaucetGuard().admit(walletAddress, tokenType, getRateLimitKey(request), wallet);
    if (!admission.ok) {
      const headers: Record<string, string> = admission.retryAfterS ? { 'Retry-After': String(admission.retryAfterS) } : {};
      return NextResponse.json(
        {
          success: false,
          error: admission.error,
          ...(admission.retryAfterS ? { retryAfterS: admission.retryAfterS } : {}),
          ...(admission.nextClaimTime ? { nextClaimTime: new Date(admission.nextClaimTime).toISOString() } : {}),
        },
        { status: admission.status, headers },
      );
    }

    const result = await sendTokens(tokenType, amount, walletAddress);

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
    if (result.releasable === true) admission.release();
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
export async function GET() {
  const environment = faucetEnvironment();
  const amounts = faucetAmounts(environment);
  return NextResponse.json({
    environment,
    supportedTokens: amounts ? Object.keys(amounts) : [],
    amounts: amounts ?? {},
    cooldownMs: LEGACY_COOLDOWN_MS,
    rateLimit: {
      maxRequestsPerIP: LEGACY_PER_IP.max,
      maxRequestsPerNetwork: PER_NETWORK.max,
      windowMs: LEGACY_PER_IP.windowMs,
      hourlyPerToken: LEGACY_HOURLY,
      passShare: PASS_SHARE,
    },
  });
}
