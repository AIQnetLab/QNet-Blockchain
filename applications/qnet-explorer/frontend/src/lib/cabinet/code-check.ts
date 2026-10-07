// My node's Node details (unified plan R7, SITE-6; R1: the code is shown by itself, with no field to check one): an
// activation code identifies the burn behind a light or a super node and authorizes nothing. The page shows the chosen
// wallet's activation (activationFacts) by the code priority of the shared contracts: the registration as the chain
// holds it (src/server/cabinet/registration-record.ts), else the server's record, the answer of the QNet extension that
// holds the wallet, the burn on the wallet's own Solana address, the extension's answer kept in this browser
// (wallet-activation.ts knownBurn), else an activation made in this browser. Pure reads.
//
// A code encodes a wallet (owner rule, 26.09): a burn a payment key of aiqnet.io made for a wallet carries that
// wallet's QNet address, so its code is found only through the registration (burn -> wallet), never through the
// payment address; a wallet that burned from its own Solana address (the extension, an earlier QNet Wallet, QNet
// Wallet's own-burn registration with its owner bind v1) keeps the code of that address, as before. Node details show
// exactly one code (owner, 06.10): whose burn it is comes from what the page knows, else from the site's registration
// route (burnByOf); until either tells, the code follows later.

import { activationCode, isActivationCode, type NodeType } from '../qnet-link.ts';
import { receiptCode, receiptOf, type PaymentRecord } from './flow.ts';
import type { KeptActivation } from './kept-activation.ts';
import type { KnownBurn } from './wallet-activation.ts';

export interface RegistrationRecord {
  height: number;
  burnTx: string;
  burner: string;
  amount: number;
}

// Whose burn a registration's is: a one-time payment key of this site (`payment`, its code names the wallet) or the
// wallet's own Solana address (`own`, its code names that address).
export type BurnBy = 'payment' | 'own';

// What the site's registration route answers: the record and whose burn it is (null while the site cannot tell), or
// none in the archive; null when not known.
export type ArchivedRecord = { found: true; record: RegistrationRecord; burnBy: BurnBy | null } | { found: false };

// A code as written: spaces around it and letter case do not matter; a light (QNET-L) or a super (QNET-S) node's.
export function normalizeCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return isActivationCode(code) ? code : null;
}

// The two codes a wallet's registration can carry: the wallet's own (a payment key's light burn for it) and the
// burner's (a burn from the wallet's own Solana address, the only form a super node's has).
export function codesOfRegistration(wallet: string, r: RegistrationRecord, nodeType: NodeType = 'light'): { wallet: string; burner: string } {
  const burner = activationCode(nodeType, r.burner, r.burnTx, r.amount);
  return { wallet: nodeType === 'super' ? burner : activationCode('light', wallet, r.burnTx, r.amount), burner };
}

// What the page itself knows of whose burn a light registration's is (wallet-choice.ts ownSolanaOf for the address; the
// rest as NodeDetails.tsx useWalletActivation reads them).
export interface BurnEvidence {
  // The wallet's own Solana address: the one it shared, else the one its extension burned from.
  ownSolana?: string | null;
  // The burn the other sources know (wallet-activation.ts knownBurn): the site's record, the extension's answer, the
  // extension's answer kept in this browser, this browser's payment address.
  known?: KnownBurn | null;
  // This browser's payment addresses.
  records?: readonly PaymentRecord[] | null;
}

// Whose burn a light registration's is, from what the page knows, else from the site's answer (`served`; the route reads
// the activation registry, then the burn on Solana): the burner is the wallet's own Solana address; it is one of this
// browser's payment addresses, or made their burn; the burn the other sources know is this one, and its code (else its
// way) tells; the page knows the wallet's own address and the burner is another (a payment key, as before). The search of
// an address a QR answer named is no evidence (anyone could have given that address). Null when nothing tells yet.
export function burnByOf(wallet: string, r: RegistrationRecord, evidence: BurnEvidence, served: BurnBy | null): BurnBy | null {
  const { ownSolana = null, known = null, records = null } = evidence;
  if (ownSolana !== null && r.burner === ownSolana) return 'own';
  if ((records ?? []).some((p) => p.pub === r.burner || p.burn?.tx === r.burnTx)) return 'payment';
  if (known && known.source !== 'scan' && known.nodeType === 'light' && known.burnTx === r.burnTx) {
    const both = codesOfRegistration(wallet, r);
    if (known.code === both.burner) return 'own';
    if (known.code === both.wallet || known.way === 'payment') return 'payment';
    if (known.way === 'extension' && (known.burner === null || known.burner === r.burner)) return 'own';
  }
  if (ownSolana !== null) return 'payment';
  return served;
}

// Where the chosen wallet's registration stands, from the nodes (registered or not, two agreeing) and the archive, with
// its one code: the wallet's for a payment key's burn, the burner's for a burn from the wallet's own Solana address
// (owner rule 2, 26.09; SITE-13: the burner's form of a payment key's burn names that temporary address, so it is never
// shown). `code` is null while whose burn it is cannot be told yet (burnByOf): never a code of the other form.
export type WalletRegistration =
  | { kind: 'none' }
  | { kind: 'code'; code: string | null; record: RegistrationRecord }
  | { kind: 'notArchived' }
  | { kind: 'unavailable' };

// A super node's burn is always from the wallet's own Solana address, so its code is the burner's.
export function walletRegistration(
  registered: boolean | null,
  archived: ArchivedRecord | null,
  wallet: string,
  evidence: BurnEvidence = {},
  nodeType: NodeType = 'light',
): WalletRegistration {
  if (registered === null) return { kind: 'unavailable' };
  if (!registered) return { kind: 'none' };
  if (archived === null) return { kind: 'unavailable' };
  if (!archived.found) return { kind: 'notArchived' };
  const both = codesOfRegistration(wallet, archived.record, nodeType);
  if (nodeType === 'super') return { kind: 'code', code: both.burner, record: archived.record };
  const by = burnByOf(wallet, archived.record, evidence, archived.burnBy);
  return { kind: 'code', code: by === null ? null : by === 'own' ? both.burner : both.wallet, record: archived.record };
}

// The wallet's activation as Node details show it, and where it comes from: the network's registration record, the
// server's record, the QNet extension that holds the wallet, the burn on its own Solana address, the extension's answer
// kept in this browser, or an activation made in this browser. `height`: the registration's block.
export interface ActivationFacts {
  source: 'network' | 'record' | 'extension' | 'scan' | 'kept' | 'browser';
  nodeType: NodeType;
  burnTx: string;
  amount: number;
  // One code, or null while it is not known yet.
  code: string | null;
  height: number | null;
  // An activation of this browser that is not finished yet.
  open: boolean;
}

// The payment record of this browser whose burn is for `wallet`, newest first; one whose key is going (what is left goes
// back, the burn stays the wallet's record on the server) or whose burn registers no node is none.
export function browserActivation(records: PaymentRecord[], wallet: string): PaymentRecord | null {
  const mine = records.filter((r) => r.burn && r.stage !== 'closing' && r.stage !== 'otherBurn'
    && (receiptOf(r)?.qnet ?? r.submit?.qnet ?? r.hold?.wallet ?? r.reservation?.wallet ?? r.answer?.qnet) === wallet);
  return mine.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

// The extension's answer kept in this browser as a known burn.
export function knownOfKept(kept: KeptActivation | null): KnownBurn | null {
  if (!kept) return null;
  return { nodeType: kept.nodeType, burnTx: kept.burnTx, burnAmount: kept.burnAmount, code: kept.code ?? null, way: null, burner: null, source: 'kept' };
}

// `nodeType`: the registration's (a light or a super node's); `known`: the burn the other sources know (wallet-activation.ts
// knownBurn); `record`: this browser's activation for the wallet.
export function activationFacts(
  registration: WalletRegistration | null,
  known: KnownBurn | null,
  record: PaymentRecord | null,
  nodeType: NodeType = 'light',
): ActivationFacts | null {
  if (registration?.kind === 'code') {
    const r = registration.record;
    return { source: 'network', nodeType, burnTx: r.burnTx, amount: r.amount, code: registration.code, height: r.height, open: false };
  }
  if (known && (known.source !== 'browser' || !record?.burn || record.burn.tx !== known.burnTx)) {
    return { source: known.source, nodeType: known.nodeType, burnTx: known.burnTx, amount: known.burnAmount, code: known.code, height: null, open: false };
  }
  if (record?.burn) {
    return {
      source: 'browser', nodeType: 'light', burnTx: record.burn.tx, amount: record.burn.amount, code: receiptCode(record), height: null,
      open: receiptOf(record) === null,
    };
  }
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// The route's answer, read again in the page: exactly {found, record, burnBy} or {found: false}.
export function parseArchivedRecord(body: unknown): ArchivedRecord | null {
  if (!isObject(body)) return null;
  if (body.found === false && Object.keys(body).length === 1) return { found: false };
  const r = body.record;
  if (body.found !== true || Object.keys(body).length !== 3 || !isObject(r) || Object.keys(r).length !== 4) return null;
  const burnBy = body.burnBy;
  if (burnBy !== null && burnBy !== 'payment' && burnBy !== 'own') return null;
  if (typeof r.height !== 'number' || !Number.isSafeInteger(r.height) || typeof r.burnTx !== 'string' || typeof r.burner !== 'string') return null;
  if (typeof r.amount !== 'number' || !Number.isSafeInteger(r.amount) || r.amount < 1) return null;
  return { found: true, record: { height: r.height, burnTx: r.burnTx, burner: r.burner, amount: r.amount }, burnBy };
}
