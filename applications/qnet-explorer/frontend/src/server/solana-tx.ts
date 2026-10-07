// The faucet's Solana transactions (src/app/api/faucet/claim/route.ts), built and
// signed without @solana/web3.js or @solana/spl-token, so none of their dependencies run in the process that holds
// FAUCET_PRIVATE_KEY. The messages come from src/lib/solana-message.ts, which the node cabinet shares; this module
// adds the faucet's key and its signature. No network access here: src/server/solana-rpc.ts sends and confirms.

import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { compileLegacyMessage, singleSignerWire, type Instruction } from '../lib/solana-message.ts';

export {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  PACKET_DATA_SIZE,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  compileLegacyMessage,
  createAssociatedTokenAccountIdempotent,
  decodeKey,
  findProgramAddress,
  isOnCurve,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  tokenTransfer,
  type AccountMeta,
  type Instruction,
} from '../lib/solana-message.ts';

// The faucet's signing key: the Ed25519 seed and the public key it derives.
export interface Signer {
  publicKey: string;
  seed: Uint8Array;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// A Solana secret key as FAUCET_PRIVATE_KEY holds it: 64 integers 0..255, the seed then its public key.
// Null unless the second half is the public key of the first, as Keypair.fromSecretKey requires.
export function signerFromSecretKey(value: unknown): Signer | null {
  if (!Array.isArray(value) || value.length !== 64) return null;
  if (!value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
  const bytes = Uint8Array.from(value as number[]);
  const seed = bytes.slice(0, 32);
  const publicKey = bytes.slice(32);
  bytes.fill(0);
  if (!sameBytes(ed25519.getPublicKey(seed), publicKey)) {
    seed.fill(0);
    return null;
  }
  return { publicKey: bs58.encode(publicKey), seed };
}

// The signed transaction on the wire, and its id (the fee payer's signature, base58). The fee payer is
// the only signer the faucet's transactions have.
export function signLegacyTransaction(
  instructions: Instruction[],
  signer: Signer,
  recentBlockhash: string,
): { wire: Uint8Array; signature: string } {
  const message = compileLegacyMessage(instructions, signer.publicKey, recentBlockhash);
  if (message[0] !== 1) throw new Error('the faucet key must be the only signer');
  const signature = ed25519.sign(message, signer.seed);
  return { wire: singleSignerWire(signature, message), signature: bs58.encode(signature) };
}

// A decimal amount in base units of `decimals` places, when it is exact to within rounding noise.
export function toBaseUnits(amount: number, decimals: number): bigint | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  const scaled = Math.round(amount * 10 ** decimals);
  if (!Number.isSafeInteger(scaled) || scaled <= 0) return null;
  return BigInt(scaled);
}
