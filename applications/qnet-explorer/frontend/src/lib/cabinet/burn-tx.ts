// The node cabinet's two Solana transaction shapes (unified plan SITE-3; plan-site section 4.1), built here from
// the payment address and a few numbers, and read back by the site before it forwards one
// (src/server/cabinet/solana-proxy.ts). Nothing else is ever signed with a payment key or sent through the site.
//
// - Burn: the activation amount of 1DEV from the payment address's own token account, the payment address the
//   fee payer and burn authority, and the memo QNET_NODE_TYPE:LIGHT signed by it (as the extension burns).
// - Refund (mainnet leftovers): the 1DEV left, the token account's rent and the SOL left, all to one address.

import {
  COMPUTE_BUDGET_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  decodeKey,
  memo,
  readU32,
  readU64,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  tokenBurn,
  tokenCloseAccount,
  tokenTransfer,
  type Instruction,
  type ParsedInstruction,
  type ParsedTransaction,
} from '../solana-message.ts';
import { ONE_DEV_MINT, ONE_DEV_UNIT } from '../one-dev.ts';
import { BURN_AMOUNT_MAX } from '../qnet-link.ts';

export const LIGHT_MEMO = 'QNET_NODE_TYPE:LIGHT';
// The form of the read pass the site gives with each burn or refund it forwarded (solana-proxy.ts): 16 bytes, base64url.
export const READ_PASS_RE = /^[A-Za-z0-9_-]{22}$/;
export const BURN_PRIORITY_MICRO_LAMPORTS = 20_000n;
export const BURN_COMPUTE_UNITS = 60_000;
const COMPUTE_PRICE_MAX = 1_000_000n;
const COMPUTE_UNITS_MAX = 200_000;
// Solana's fee per signature, and the rent of a token account (165 bytes).
export const SIGNATURE_FEE_LAMPORTS = 5_000n;
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
// What a burn costs the payment address in SOL: the signature and the priority fee, rounded up.
export const BURN_FEE_LAMPORTS = SIGNATURE_FEE_LAMPORTS + (BURN_PRIORITY_MICRO_LAMPORTS * BigInt(BURN_COMPUTE_UNITS) + 999_999n) / 1_000_000n;
// Solana's rent-exempt minimum of a plain account: the payment address keeps at least this after the burn's fee.
export const SYSTEM_ACCOUNT_RENT_LAMPORTS = 890_880n;
// The SOL a payment address must hold to burn: the burn's fee and the rent-exempt minimum after it.
export const BURN_SOL_LAMPORTS = BURN_FEE_LAMPORTS + SYSTEM_ACCOUNT_RENT_LAMPORTS;
// The SOL the page asks the user to send for that, rounded up to whole thousandths of a SOL (0.001 SOL); what the burn
// does not take goes back to the wallet with the rest once the node is recorded.
export const FUNDING_SOL_LAMPORTS = ((BURN_SOL_LAMPORTS + 999_999n) / 1_000_000n) * 1_000_000n;

export const oneDevAccountOf = (owner: string): string => associatedTokenAddress(ONE_DEV_MINT, owner);

export function isWholeBurn(whole: unknown): whole is number {
  return typeof whole === 'number' && Number.isSafeInteger(whole) && whole >= 1 && whole <= BURN_AMOUNT_MAX;
}

export function burnInstructions(payer: string, whole: number): Instruction[] {
  if (!isWholeBurn(whole)) throw new RangeError('burn amount');
  return [
    setComputeUnitPrice(BURN_PRIORITY_MICRO_LAMPORTS),
    setComputeUnitLimit(BURN_COMPUTE_UNITS),
    tokenBurn(oneDevAccountOf(payer), ONE_DEV_MINT, payer, BigInt(whole) * ONE_DEV_UNIT),
    memo(LIGHT_MEMO, payer),
  ];
}

export interface RefundPlan {
  // Raw 1DEV units left on the payment address's token account.
  oneDevRaw: bigint;
  // Whether that token account exists (it is closed when it does).
  accountExists: boolean;
  // Lamports on the payment address.
  lamports: bigint;
  // Whether the destination's 1DEV account exists already (otherwise the refund creates it and pays its rent).
  destAccountExists: boolean;
}

// The SOL the refund moves last: everything on the payment address but the fee and, when 1DEV goes to a
// destination without a token account, that account's rent. Zero when nothing is left to move.
export function refundLamports(plan: RefundPlan): bigint {
  const createsAccount = plan.oneDevRaw > 0n && !plan.destAccountExists;
  const left = plan.lamports - SIGNATURE_FEE_LAMPORTS - (createsAccount ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0n);
  return left > 0n ? left : 0n;
}

// The SOL the payment address still lacks to move its 1DEV or close its token account: the refund's signature fee
// and, when the destination has no 1DEV account, that account's rent (it is created before the payment address's own
// one is closed, whose rent goes to the destination and pays for nothing here). Zero when neither is to be moved
// (SOL alone goes back only when there is more than the fee, refundLamports) or the address holds enough (SITE-R2-02).
export function refundShortfall(plan: RefundPlan): bigint {
  if (plan.oneDevRaw === 0n && !plan.accountExists) return 0n;
  const createsAccount = plan.oneDevRaw > 0n && !plan.destAccountExists;
  const need = SIGNATURE_FEE_LAMPORTS + (createsAccount ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0n) - plan.lamports;
  return need > 0n ? need : 0n;
}

// Whether the payment address can pay for moving its 1DEV and closing its token account.
export function tokensMovable(plan: RefundPlan): boolean {
  return refundShortfall(plan) === 0n;
}

export function refundInstructions(payer: string, dest: string, plan: RefundPlan): Instruction[] {
  if (dest === payer || !decodeKey(dest)) throw new RangeError('refund destination');
  const out: Instruction[] = [];
  const source = oneDevAccountOf(payer);
  if (plan.oneDevRaw > 0n) {
    const to = oneDevAccountOf(dest);
    if (!plan.destAccountExists) out.push(createAssociatedTokenAccountIdempotent(payer, to, dest, ONE_DEV_MINT));
    out.push(tokenTransfer(source, to, payer, plan.oneDevRaw));
  }
  if (plan.accountExists) out.push(tokenCloseAccount(source, dest, payer));
  const lamports = refundLamports(plan);
  if (lamports > 0n) out.push(systemTransfer(payer, dest, lamports));
  if (out.length === 0) throw new RangeError('nothing to refund');
  return out;
}

// ---------------------------------------------------------------- reading a transaction back

export type CabinetTx =
  | { kind: 'burn'; payer: string; whole: number }
  | { kind: 'refund'; payer: string; dest: string; oneDevRaw: bigint; lamports: bigint };

const keysAre = (ix: ParsedInstruction, keys: string[]): boolean =>
  ix.accounts.length === keys.length && ix.accounts.every((a, i) => a.pubkey === keys[i]);

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// The compute budget instructions at the head: at most one price and one limit, each within bounds. The index
// of the first other instruction, or -1 for anything else.
function computeBudgetPrefix(ixs: ParsedInstruction[]): number {
  const seen = new Set<number>();
  let i = 0;
  for (; i < ixs.length && ixs[i].programId === COMPUTE_BUDGET_PROGRAM_ID; i += 1) {
    const { data, accounts } = ixs[i];
    if (accounts.length !== 0 || seen.has(data[0])) return -1;
    seen.add(data[0]);
    if (data[0] === 3 && data.length === 9 && (readU64(data, 1) as bigint) <= COMPUTE_PRICE_MAX) continue;
    if (data[0] === 2 && data.length === 5 && (readU32(data, 1) as number) <= COMPUTE_UNITS_MAX) continue;
    return -1;
  }
  return i;
}

function readBurn(tx: ParsedTransaction, rest: ParsedInstruction[]): CabinetTx | null {
  const payer = tx.feePayer;
  if (rest.length !== 2) return null;
  const [burn, note] = rest;
  if (burn.programId !== TOKEN_PROGRAM_ID || burn.data.length !== 9 || burn.data[0] !== 8) return null;
  if (!keysAre(burn, [oneDevAccountOf(payer), ONE_DEV_MINT, payer])) return null;
  const raw = readU64(burn.data, 1) as bigint;
  if (raw % ONE_DEV_UNIT !== 0n) return null;
  const whole = Number(raw / ONE_DEV_UNIT);
  if (!isWholeBurn(whole)) return null;
  if (note.programId !== MEMO_PROGRAM_ID || !keysAre(note, [payer])) return null;
  if (!bytesEqual(note.data, new TextEncoder().encode(LIGHT_MEMO))) return null;
  return { kind: 'burn', payer, whole };
}

function readRefund(tx: ParsedTransaction, rest: ParsedInstruction[]): CabinetTx | null {
  const payer = tx.feePayer;
  const source = oneDevAccountOf(payer);
  // The one address the refund names: the owner of the account it creates, the close's destination and the SOL's
  // recipient must all be it.
  const named = rest.map((ix) => {
    if (ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID) return ix.accounts[2]?.pubkey;
    if (ix.programId === TOKEN_PROGRAM_ID && ix.data[0] === 9) return ix.accounts[1]?.pubkey;
    if (ix.programId === SYSTEM_PROGRAM_ID) return ix.accounts[1]?.pubkey;
    return undefined;
  }).filter((d): d is string => typeof d === 'string');
  const dest = named[0];
  if (dest === undefined || dest === payer || !decodeKey(dest) || named.some((d) => d !== dest)) return null;
  const destAccount = oneDevAccountOf(dest);
  let i = 0;
  let oneDevRaw = 0n;
  let lamports = 0n;
  const at = (programId: string, tag?: number): boolean => rest[i]?.programId === programId && (tag === undefined || rest[i].data[0] === tag);
  let created = false;
  if (at(ASSOCIATED_TOKEN_PROGRAM_ID)) {
    if (!bytesEqual(rest[i].data, Uint8Array.of(1))) return null;
    if (!keysAre(rest[i], [payer, destAccount, dest, ONE_DEV_MINT, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID])) return null;
    created = true;
    i += 1;
  }
  if (at(TOKEN_PROGRAM_ID, 3)) {
    if (rest[i].data.length !== 9 || !keysAre(rest[i], [source, destAccount, payer])) return null;
    oneDevRaw = readU64(rest[i].data, 1) as bigint;
    if (oneDevRaw === 0n) return null;
    i += 1;
  } else if (created) {
    return null;
  }
  if (at(TOKEN_PROGRAM_ID, 9)) {
    if (rest[i].data.length !== 1 || !keysAre(rest[i], [source, dest, payer])) return null;
    i += 1;
  }
  if (at(SYSTEM_PROGRAM_ID)) {
    if (rest[i].data.length !== 12 || readU32(rest[i].data, 0) !== 2 || !keysAre(rest[i], [payer, dest])) return null;
    lamports = readU64(rest[i].data, 4) as bigint;
    if (lamports === 0n) return null;
    i += 1;
  }
  if (i === 0 || i !== rest.length) return null;
  return { kind: 'refund', payer, dest, oneDevRaw, lamports };
}
// Which of the two shapes a transaction is, signed by its one signer, the fee payer; null for anything else.
// The caller checks the signature (signaturesValid of solana-message.ts).
export function classifyCabinetTx(tx: ParsedTransaction | null): CabinetTx | null {
  if (!tx || tx.signers.length !== 1 || tx.signers[0] !== tx.feePayer) return null;
  const start = computeBudgetPrefix(tx.instructions);
  if (start < 0) return null;
  const rest = tx.instructions.slice(start);
  if (rest.some((ix) => ix.programId === COMPUTE_BUDGET_PROGRAM_ID)) return null;
  return rest[0]?.programId === TOKEN_PROGRAM_ID && rest[0].data[0] === 8 ? readBurn(tx, rest) : readRefund(tx, rest);
}
