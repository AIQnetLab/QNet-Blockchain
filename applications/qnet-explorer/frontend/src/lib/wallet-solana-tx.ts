// The Solana transactions QNet Wallet and the QNet extension build, read back by the site before the wallets' relay
// (src/server/cabinet/solana-relay.ts) passes one on: each paid for and signed by its one signer, and holding exactly
// the instructions and accounts the wallets' builders give it (the app's crypto/SolanaTx.js, the extension's
// background/solana.js). Nothing else passes.
//
// - SOL: [Memo] System Transfer from the fee payer to a recipient (the payer itself for a send to itself), then a
//   payment request's reference keys.
// - 1DEV: [CreateIdempotent of the recipient's 1DEV account] [Memo] TransferChecked of the 1DEV mint at 6 decimals from
//   an account of the payer, then a payment request's reference keys.
// - Burn (the extension's activation): Burn of whole 1DEV from the payer's 1DEV account, then the payer's signed
//   QNET_NODE_TYPE memo.
// A payment request's memo has no account and 1 to 200 bytes of UTF-8; its references are at most 4 and distinct, any
// key, the payer's own too, as both wallets take them. The account table must be exactly the one those instructions
// compile to, roles included.

import { NODE_TYPE_MEMO, isWholeBurn, oneDevAccountOf } from './cabinet/burn-tx.ts';
import { ONE_DEV_DECIMALS, ONE_DEV_MINT, ONE_DEV_UNIT } from './one-dev.ts';
import { NODE_TYPES, type NodeType } from './qnet-link.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, PACKET_DATA_SIZE, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, bytesEqual, keysAre, readU32, readU64,
  type ParsedInstruction, type ParsedMessage,
} from './solana-message.ts';

export const REFERENCES_MAX = 4;
export const REQUEST_MEMO_MAX_BYTES = 200;

export type WalletTx =
  | { kind: 'sol'; payer: string }
  | { kind: 'token'; payer: string }
  | { kind: 'burn'; payer: string; whole: number; nodeType: NodeType };

type Role = { isSigner: boolean; isWritable: boolean };
const SIGNER_WRITABLE: Role = { isSigner: true, isWritable: true };
const SIGNER: Role = { isSigner: true, isWritable: false };
const WRITABLE: Role = { isSigner: false, isWritable: true };
const READONLY: Role = { isSigner: false, isWritable: false };

// One instruction of a shape: the role its builder gives each of its accounts, in order.
type Part = { ix: ParsedInstruction; roles: Role[] };

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const isUtf8 = (data: Uint8Array): boolean => {
  try {
    UTF8.decode(data);
    return true;
  } catch {
    return false;
  }
};

// A payment request's memo: no account, 1 to 200 bytes of well-formed UTF-8.
const isRequestMemo = (ix: ParsedInstruction): boolean =>
  ix.programId === MEMO_PROGRAM_ID && ix.accounts.length === 0 && ix.data.length >= 1 && ix.data.length <= REQUEST_MEMO_MAX_BYTES && isUtf8(ix.data);

// The reference keys after a transfer's `own` accounts: at most REFERENCES_MAX and distinct, each read-only; a key the
// message names in another role too (the payer's own address) merges both, as the wallets' compilers do.
function references(ix: ParsedInstruction, own: number): Role[] | null {
  const refs = ix.accounts.slice(own).map((a) => a.pubkey);
  if (refs.length > REFERENCES_MAX || new Set(refs).size !== refs.length) return null;
  return refs.map(() => READONLY);
}

function solTransfer(ix: ParsedInstruction, payer: string): Part | null {
  const { data, accounts } = ix;
  if (ix.programId !== SYSTEM_PROGRAM_ID || data.length !== 12 || readU32(data, 0) !== 2 || (readU64(data, 4) as bigint) < 1n) return null;
  if (accounts.length < 2 || accounts[0].pubkey !== payer) return null;
  const refs = references(ix, 2);
  return refs && { ix, roles: [SIGNER_WRITABLE, WRITABLE, ...refs] };
}

function tokenTransfer(ix: ParsedInstruction, payer: string): Part | null {
  const { data, accounts } = ix;
  if (ix.programId !== TOKEN_PROGRAM_ID || data.length !== 10 || data[0] !== 12 || data[9] !== ONE_DEV_DECIMALS) return null;
  if ((readU64(data, 1) as bigint) < 1n || accounts.length < 4) return null;
  const [source, mint, destination, owner] = accounts.map((a) => a.pubkey);
  if (mint !== ONE_DEV_MINT || owner !== payer || [source, destination].some((key) => key === payer || key === ONE_DEV_MINT)) return null;
  const refs = references(ix, 4);
  return refs && { ix, roles: [WRITABLE, READONLY, WRITABLE, SIGNER, ...refs] };
}

// The idempotent create of the 1DEV account the transfer pays into, for that account's owner.
function createFor(ix: ParsedInstruction, payer: string, destination: string): Part | null {
  if (ix.programId !== ASSOCIATED_TOKEN_PROGRAM_ID || !bytesEqual(ix.data, Uint8Array.of(1)) || ix.accounts.length !== 6) return null;
  const owner = ix.accounts[2].pubkey;
  if (destination !== oneDevAccountOf(owner)) return null;
  if (!keysAre(ix, [payer, destination, owner, ONE_DEV_MINT, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID])) return null;
  return { ix, roles: [SIGNER_WRITABLE, WRITABLE, READONLY, READONLY, READONLY, READONLY] };
}

function burnParts(ixs: ParsedInstruction[], payer: string): { parts: Part[]; whole: number; nodeType: NodeType } | null {
  if (ixs.length !== 2) return null;
  const [burn, note] = ixs;
  if (burn.programId !== TOKEN_PROGRAM_ID || burn.data.length !== 9 || burn.data[0] !== 8) return null;
  if (!keysAre(burn, [oneDevAccountOf(payer), ONE_DEV_MINT, payer])) return null;
  const raw = readU64(burn.data, 1) as bigint;
  const whole = Number(raw / ONE_DEV_UNIT);
  if (raw % ONE_DEV_UNIT !== 0n || !isWholeBurn(whole)) return null;
  const nodeType = NODE_TYPES.find((type) => bytesEqual(note.data, new TextEncoder().encode(NODE_TYPE_MEMO[type])));
  if (note.programId !== MEMO_PROGRAM_ID || !keysAre(note, [payer]) || nodeType === undefined) return null;
  return { parts: [{ ix: burn, roles: [WRITABLE, WRITABLE, SIGNER] }, { ix: note, roles: [SIGNER] }], whole, nodeType };
}

function transferParts(ixs: ParsedInstruction[], payer: string): { parts: Part[]; kind: 'sol' | 'token' } | null {
  const last = ixs.at(-1);
  if (!last) return null;
  const before = ixs.slice(0, -1);
  const memo = before.length > 0 && isRequestMemo(before[before.length - 1]) ? before.pop() as ParsedInstruction : null;
  const memoPart: Part[] = memo ? [{ ix: memo, roles: [] }] : [];
  if (last.programId === SYSTEM_PROGRAM_ID) {
    const transfer = solTransfer(last, payer);
    return transfer && before.length === 0 ? { parts: [...memoPart, transfer], kind: 'sol' } : null;
  }
  const transfer = tokenTransfer(last, payer);
  if (!transfer || before.length > 1) return null;
  const create = before.length === 1 ? createFor(before[0], payer, last.accounts[2].pubkey) : null;
  if (before.length === 1 && !create) return null;
  return { parts: [...(create ? [create] : []), ...memoPart, transfer], kind: 'token' };
}

// The account table holds exactly the payer, the parts' accounts and their programs, each with the role the parts
// give it (a key named twice takes both roles, as a compiled message merges them).
function tableMatches(tx: ParsedMessage, parts: Part[]): boolean {
  const expected = new Map<string, Role>();
  const add = (key: string, role: Role) => {
    const seen = expected.get(key);
    expected.set(key, seen ? { isSigner: seen.isSigner || role.isSigner, isWritable: seen.isWritable || role.isWritable } : role);
  };
  add(tx.feePayer, SIGNER_WRITABLE);
  for (const { ix, roles } of parts) {
    if (roles.length !== ix.accounts.length) return false;
    add(ix.programId, READONLY);
    ix.accounts.forEach((a, i) => add(a.pubkey, roles[i]));
  }
  return tx.accounts.length === expected.size && tx.accounts.every((a) => {
    const role = expected.get(a.pubkey);
    return role !== undefined && role.isSigner === a.isSigner && role.isWritable === a.isWritable;
  });
}

// Which of the wallets' shapes a message or a transaction is; null for anything else. The caller checks the
// signature (signaturesValid of solana-message.ts) where it needs one.
export function classifyWalletTx(tx: ParsedMessage | null): WalletTx | null {
  if (!tx || tx.signers.length !== 1 || tx.signers[0] !== tx.feePayer || 1 + 64 + tx.message.length > PACKET_DATA_SIZE) return null;
  const payer = tx.feePayer;
  const burn = burnParts(tx.instructions, payer);
  if (burn) return tableMatches(tx, burn.parts) ? { kind: 'burn', payer, whole: burn.whole, nodeType: burn.nodeType } : null;
  const transfer = transferParts(tx.instructions, payer);
  return transfer && tableMatches(tx, transfer.parts) ? { kind: transfer.kind, payer } : null;
}
