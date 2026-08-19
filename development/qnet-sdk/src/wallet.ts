import { QNetAddress, WalletKeys } from './types';
import { publicKeyHashToAddress, isValidQNetAddress } from './address';

// ─────────────────────────────────────────────────────────────────────────────
// QNet Wallet Utilities
//
// Key generation is intentionally NOT included in the SDK — private keys should
// be managed by the hardware wallet, mobile app (React Native), or a secure
// enclave. The SDK only handles the public-facing operations:
//   - deriving QNet addresses from public keys
//   - building unsigned transaction payloads
//   - validating addresses / signatures before broadcast
// ─────────────────────────────────────────────────────────────────────────────

export interface UnsignedTransfer {
  from: QNetAddress;
  to: QNetAddress;
  value: string;        // smallest QNC unit, as string
  fee: string;
  nonce: number;
  timestamp: number;    // Unix seconds
  /** Hex-encoded bytes to sign with Dilithium3 (ML-DSA-65) or Ed25519 */
  signingPayload: string;
}

/**
 * Build an unsigned QNC transfer payload ready for signing.
 *
 * The `signingPayload` is the canonical message that must be signed:
 * `SHA3-256(from || to || value || fee || nonce || timestamp)` serialised
 * as a hex string.  The actual hash is computed server-side; the client
 * should sign the raw concatenated bytes.
 *
 * @example
 * const tx = buildUnsignedTransfer({
 *   from:  "19chex...",
 *   to:    "19chex...",
 *   value: "1000000000",   // 1 QNC
 *   fee:   "100000",
 *   nonce: 5,
 * });
 * const sig = myWallet.sign(Buffer.from(tx.signingPayload, 'hex'));
 * await client.sendTransaction({ ...tx, signature: sig.toString('hex') });
 */
export function buildUnsignedTransfer(params: {
  from: QNetAddress;
  to: QNetAddress;
  value: string;
  fee?: string;
  nonce: number;
}): UnsignedTransfer {
  if (!isValidQNetAddress(params.from)) {
    throw new Error(`Invalid sender address: ${params.from}`);
  }
  if (!isValidQNetAddress(params.to)) {
    throw new Error(`Invalid recipient address: ${params.to}`);
  }

  const fee       = params.fee ?? '100000';
  const timestamp = Math.floor(Date.now() / 1000);

  // Canonical signing payload: big-endian encoding of each field
  const fromBytes  = Buffer.from(params.from,    'utf8');
  const toBytes    = Buffer.from(params.to,      'utf8');
  const valBytes   = Buffer.from(params.value,   'utf8');
  const feeBytes   = Buffer.from(fee,            'utf8');
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64BE(BigInt(params.nonce));
  const tsBytes    = Buffer.alloc(8);
  tsBytes.writeBigUInt64BE(BigInt(timestamp));

  const payload = Buffer.concat([fromBytes, toBytes, valBytes, feeBytes, nonceBytes, tsBytes]);

  return {
    from:           params.from,
    to:             params.to,
    value:          params.value,
    fee,
    nonce:          params.nonce,
    timestamp,
    signingPayload: payload.toString('hex'),
  };
}

/**
 * Chain tag the node prefixes onto every canonical sign-preimage. MUST byte-match QNET_CHAIN_ID in
 * core/qnet-state/src/transaction.rs, or every signature this SDK produces is rejected.
 */
export const QNET_CHAIN_TAG = 'q1337|';

/**
 * The request-auth message for a reward claim, verified verbatim as UTF-8 by the node.
 *
 * This authorizes the REQUEST only. The credit itself is authorized by a second signature over the
 * quoted payload (`RewardClaimQuote.signMessage`) — see `QNetClient.claimRewards()`.
 */
export function buildRewardClaimPayload(nodeId: string, address: QNetAddress): string {
  return `${QNET_CHAIN_TAG}claim_rewards:${nodeId}:${address}`;
}

/**
 * Derive a QNet address from an Ed25519 or Dilithium3 public key.
 *
 * For Ed25519:    first 20 bytes of SHA3-256(pubkey)
 * For Dilithium3: first 20 bytes of SHA3-256(pubkey)
 *
 * The actual hash is computed externally (e.g. `@noble/hashes` or Node crypto).
 * This function accepts the pre-hashed 20-byte public key hash.
 */
export function addressFromPublicKeyHash(pubKeyHash: Uint8Array): QNetAddress {
  return publicKeyHashToAddress(pubKeyHash);
}
