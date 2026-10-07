// An activation burn as Solana holds it (shared contract C3.6), read from a finalized transaction (getTransaction,
// jsonParsed): the site's /tx read of a light burn, the settle and the record of the activation registry, and the
// search of a wallet's own Solana address all read a burn this one way.

import { ONE_DEV_MINT, ONE_DEV_UNIT } from '../../lib/one-dev.ts';
import type { NodeType } from '../../lib/qnet-link.ts';
import { decodeKey } from '../../lib/solana-message.ts';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const U64_RE = /^(?:0|[1-9][0-9]{0,19})$/;

// An activation burn read from a finalized transaction: its payer (the burner), whole 1DEV, the node type of its memo,
// and, when Solana gave them, its slot and block time (ms).
export interface ActivationBurn {
  payer: string;
  amount: number;
  nodeType: NodeType;
  slot: number | null;
  blockTime: number | null;
}

const MEMO_RE = /^QNET_NODE_TYPE:(LIGHT|SUPER)$/;

// A finalized transaction (getTransaction, jsonParsed) as an activation burn: it succeeded; its fee payer, who signed
// it, burned a whole number of 1DEV, as the burn's authority, in exactly one burn, with exactly one
// QNET_NODE_TYPE:LIGHT or QNET_NODE_TYPE:SUPER memo (shared contract C3.6). With `expected`, only a burn of that node
// type. Null otherwise. The account burned from is not checked: an older extension burned from any 1DEV account of the
// wallet.
export function parseBurn(result: unknown, expected: NodeType | null = null): ActivationBurn | null {
  if (!isObject(result) || !isObject(result.meta) || result.meta.err !== null) return null;
  const message = isObject(result.transaction) && isObject(result.transaction.message) ? result.transaction.message : null;
  const keys = message && Array.isArray(message.accountKeys) ? message.accountKeys : null;
  const first = keys?.[0];
  const payer = typeof first === 'string' ? first : isObject(first) && typeof first.pubkey === 'string' ? first.pubkey : null;
  if (!payer || !decodeKey(payer) || !message || !Array.isArray(message.instructions)) return null;
  if (isObject(first) && first.signer === false) return null;
  const burns: bigint[] = [];
  const types: NodeType[] = [];
  for (const ix of message.instructions) {
    if (!isObject(ix)) continue;
    if (ix.program === 'spl-memo' && typeof ix.parsed === 'string' && ix.parsed.includes('QNET_NODE_TYPE:')) {
      const m = MEMO_RE.exec(ix.parsed);
      if (!m) return null;
      types.push(m[1] === 'SUPER' ? 'super' : 'light');
    }
    const parsed = isObject(ix.parsed) ? ix.parsed : null;
    if (ix.program !== 'spl-token' || !parsed || (parsed.type !== 'burn' && parsed.type !== 'burnChecked')) continue;
    const info = isObject(parsed.info) ? parsed.info : null;
    const raw = info?.amount ?? (isObject(info?.tokenAmount) ? info.tokenAmount.amount : undefined);
    if (!info || info.mint !== ONE_DEV_MINT || info.authority !== payer) return null;
    if (typeof raw !== 'string' || !U64_RE.test(raw)) return null;
    burns.push(BigInt(raw));
  }
  if (burns.length !== 1 || types.length !== 1 || burns[0] % ONE_DEV_UNIT !== 0n) return null;
  if (expected !== null && types[0] !== expected) return null;
  const amount = Number(burns[0] / ONE_DEV_UNIT);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const slot = typeof result.slot === 'number' && Number.isSafeInteger(result.slot) && result.slot >= 0 ? result.slot : null;
  const blockTime = typeof result.blockTime === 'number' && Number.isSafeInteger(result.blockTime) && result.blockTime > 0 ? result.blockTime * 1000 : null;
  return { payer, amount, nodeType: types[0], slot, blockTime };
}

// Whether a finalized transaction burned 1DEV of `owner`'s in any form: it succeeded, `owner` paid for it and signed it,
// and one of its instructions, inner ones included, burned 1DEV with `owner` as the authority. A transaction without such
// a burn (a transfer that only carries an activation memo) is no burn at all, whatever its memo says; the QNet extension
// reads a wallet's own burns the same way.
export function holdsOwnBurn(result: unknown, owner: string): boolean {
  if (!isObject(result) || !isObject(result.meta) || result.meta.err !== null) return false;
  const message = isObject(result.transaction) && isObject(result.transaction.message) ? result.transaction.message : null;
  const first = message && Array.isArray(message.accountKeys) ? message.accountKeys[0] : undefined;
  const payer = typeof first === 'string' ? first : isObject(first) && typeof first.pubkey === 'string' ? first.pubkey : null;
  if (payer !== owner || (isObject(first) && first.signer === false)) return false;
  const outer = message && Array.isArray(message.instructions) ? message.instructions : [];
  const inner = Array.isArray(result.meta.innerInstructions)
    ? result.meta.innerInstructions.flatMap((g: unknown) => (isObject(g) && Array.isArray(g.instructions) ? g.instructions : []))
    : [];
  return [...outer, ...inner].some((ix: unknown) => {
    const parsed = isObject(ix) && ix.program === 'spl-token' && isObject(ix.parsed) ? ix.parsed : null;
    const info = parsed && (parsed.type === 'burn' || parsed.type === 'burnChecked') && isObject(parsed.info) ? parsed.info : null;
    return info !== null && info.mint === ONE_DEV_MINT && info.authority === owner;
  });
}
