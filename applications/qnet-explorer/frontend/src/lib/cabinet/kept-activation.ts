// The activation the QNet extension reported on My node, kept in this browser per wallet so the pages can show it
// later: the Overview's next step and Node details, and the Activate page after a reload. Only a checked
// answer that names a burn is kept (`ok`, `exists`, `pending`), and only its public fields: the wallet's QNet and
// Solana addresses, the node type, the burn, its amount and the code, all public on Solana or on the QNet chain, plus
// when the page got it. Read back through the same check as the answer itself (qnet-link.ts validateActivation), so
// an edited entry is dropped. The browser store may be missing or blocked: then nothing is kept and nothing throws.

import { validateActivation, type ActivationAnswer, type NodeType } from '../qnet-link.ts';

export const ACTIVATIONS_KEY = 'qnet.cabinet.activations';
// A few wallets per browser; the oldest entry goes first.
export const ACTIVATIONS_KEPT = 5;
const TEXT_MAX = 8 * 1024;

export interface KeptActivation {
  status: 'ok' | 'exists' | 'pending';
  qnet: string;
  solana: string;
  nodeType: NodeType;
  burnTx: string;
  burnAmount: number;
  // Absent for a burn that is not final yet (`pending`).
  code?: string;
  supersededBurnTx?: string;
  // When the page got the answer (ms).
  at: number;
}

export type KeptActivations = Record<string, KeptActivation>;

const KEPT_STATUSES = ['ok', 'exists', 'pending'];
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// The answer as it is kept, or null for an answer that names no burn.
export function keptFrom(answer: ActivationAnswer, at: number): KeptActivation | null {
  if (!KEPT_STATUSES.includes(answer.status) || !answer.qnet || !answer.solana || !answer.nodeType || !answer.burnTx) return null;
  if (typeof answer.burnAmount !== 'number' || !Number.isSafeInteger(at) || at < 0) return null;
  const kept: KeptActivation = {
    status: answer.status as KeptActivation['status'],
    qnet: answer.qnet,
    solana: answer.solana,
    nodeType: answer.nodeType,
    burnTx: answer.burnTx,
    burnAmount: answer.burnAmount,
    at,
  };
  if (answer.code) kept.code = answer.code;
  if (answer.supersededBurnTx) kept.supersededBurnTx = answer.supersededBurnTx;
  return kept;
}

// One kept entry, checked again as the extension's answer.
function checkEntry(value: unknown): KeptActivation | null {
  if (!isObject(value)) return null;
  const { at, ...rest } = value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || !KEPT_STATUSES.includes(rest.status as string)) return null;
  const nodeType = rest.nodeType === 'super' ? 'super' : 'light';
  const checked = validateActivation(JSON.stringify({ v: 1, intent: 'activate', ...rest }), nodeType);
  return checked.ok ? keptFrom(checked.answer, at) : null;
}

export function parseKept(text: string | null | undefined): KeptActivations {
  const out: KeptActivations = {};
  if (typeof text !== 'string' || text.length > TEXT_MAX) return out;
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) return out;
    for (const [wallet, entry] of Object.entries(value)) {
      const kept = checkEntry(entry);
      if (kept && kept.qnet === wallet) out[wallet] = kept;
    }
  } catch {
    // unreadable: nothing kept
  }
  return out;
}

export function loadKept(storage: Pick<Storage, 'getItem'> | null | undefined): KeptActivations {
  try {
    return parseKept(storage?.getItem(ACTIVATIONS_KEY));
  } catch {
    return {};
  }
}

// The kept entries with `answer` added for its wallet (the newest `ACTIVATIONS_KEPT`), written to the store when it
// can be; unchanged for an answer that names no burn.
export function keepAnswer(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  current: KeptActivations,
  answer: ActivationAnswer,
  at: number,
): KeptActivations {
  const kept = keptFrom(answer, at);
  if (!kept) return current;
  const others = Object.values(current).filter((k) => k.qnet !== kept.qnet).sort((a, b) => b.at - a.at).slice(0, ACTIVATIONS_KEPT - 1);
  const next: KeptActivations = { [kept.qnet]: kept };
  for (const k of others) next[k.qnet] = k;
  try {
    storage?.setItem(ACTIVATIONS_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: kept for this page only
  }
  return next;
}

// The kept entry as the answer the page shows.
export function answerOf(kept: KeptActivation): ActivationAnswer {
  const answer: ActivationAnswer = {
    v: 1, intent: 'activate', status: kept.status, qnet: kept.qnet, solana: kept.solana, nodeType: kept.nodeType, burnTx: kept.burnTx, burnAmount: kept.burnAmount,
  };
  if (kept.code) answer.code = kept.code;
  if (kept.supersededBurnTx) answer.supersededBurnTx = kept.supersededBurnTx;
  return answer;
}
