// What the faucet sends on Solana devnet: 1DEV (SPL token, into the recipient's associated token account,
// created if missing) and SOL. Instruction lists only; src/server/solana-tx.ts compiles and signs them.

import {
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  tokenTransfer,
  type Instruction,
} from './solana-tx.ts';
import { ONE_DEV_MINT } from '../lib/one-dev.ts';

export { ONE_DEV_DECIMALS, ONE_DEV_MINT, SOL_DECIMALS } from '../lib/one-dev.ts';
const PRIORITY_MICRO_LAMPORTS = 50_000n;
const TOKEN_COMPUTE_UNITS = 400_000;

// The recipient's account is created idempotently: the plain create aborts the whole transaction when the
// account exists, and the transfer after it would never run.
export function oneDevTransferInstructions(faucet: string, recipient: string, raw: bigint): Instruction[] {
  const to = associatedTokenAddress(ONE_DEV_MINT, recipient);
  const from = associatedTokenAddress(ONE_DEV_MINT, faucet);
  return [
    setComputeUnitPrice(PRIORITY_MICRO_LAMPORTS),
    setComputeUnitLimit(TOKEN_COMPUTE_UNITS),
    createAssociatedTokenAccountIdempotent(faucet, to, recipient, ONE_DEV_MINT),
    tokenTransfer(from, to, faucet, raw),
  ];
}

export function solTransferInstructions(faucet: string, recipient: string, lamports: bigint): Instruction[] {
  return [setComputeUnitPrice(PRIORITY_MICRO_LAMPORTS), systemTransfer(faucet, recipient, lamports)];
}
