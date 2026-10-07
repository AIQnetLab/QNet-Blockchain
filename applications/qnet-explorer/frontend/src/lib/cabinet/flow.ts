// The activation of a light node on aiqnet.io/node/activate, as one record per payment address kept in this
// browser (src/lib/cabinet/payment-store.ts): its stage, the wallet's signed reservation, the burn, the QNet Link request
// that carries the burn to QNet Wallet, the wallet's answer and the submit. Pure: the page moves a record only through
// `advance` (unified plan R16 and flows A and B; shared contracts C1 and C4). The record is for one wallet from the start:
// QNet Wallet confirms it first (`walletConfirm`, its signed reservation, the `hold`), and only then is the payment address
// shown. The burn is made only under that wallet's reservation in the server's activation registry (C3.2; unified plan
// R6: one wallet, one burn), and the payment key binds it to that wallet's light node before it is sent, so the burn is
// the wallet's activation for good: the registration can then be finished in any browser where the wallet is connected.
// Before a burn the key lives at most 24 hours: then what arrived goes back to the wallet and the key is deleted (owner
// rule, 26.09). After a burn the key is kept only to send back what is left: once the node is recorded, or at once when
// the user asks (`returnLeftovers`).

import { activationCode, walletHash, type Consent, type LinkDeviceRequest } from '../qnet-link.ts';
import { isHeldWallet, ownSolanaOf, type WalletChoice } from './wallet-choice.ts';

export const STAGES = [
  'walletConfirm', 'funding', 'funded', 'burnSent', 'burnUnknown', 'burnFailed', 'burnFinal', 'linkOpen', 'consentVerified', 'mismatch',
  'consentStale', 'nodeExists', 'beneficiaryConfirmed', 'submitted', 'refused', 'otherBurn', 'onChain', 'leftovers', 'closing',
  'done',
] as const;
export type Stage = (typeof STAGES)[number];

export type FlowEvent =
  | 'walletConfirmed' | 'funded' | 'underfunded' | 'burnSigned' | 'burnFinalized' | 'burnFailed' | 'burnExpired' | 'burnTimeout'
  | 'retryBurn' | 'burnFound' | 'linkStarted' | 'linkEnded' | 'consentRead' | 'confirmed' | 'mismatch' | 'consentStale'
  | 'nodeExists' | 'relink' | 'submitted' | 'refused' | 'resubmit' | 'onChain' | 'otherBurn' | 'leftovers' | 'done' | 'expire'
  | 'cancel' | 'returnLeftovers';

// How long a payment key waits for its burn.
export const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Past its lifetime an activation that burned nothing ends: `closing` sends what arrived back, then the record goes.
const EXPIRE = { expire: 'closing' } as const;
// Before a burn the user may end it at once.
const CANCEL = { cancel: 'closing', ...EXPIRE } as const;
// After a final burn the user may send what is left back at once: the burn stays the wallet's activation, and the
// registration is finished later in any browser where the wallet is connected.
const GIVE_BACK = { returnLeftovers: 'closing' } as const;

// Every allowed move; anything else is refused. A record still at `walletConfirm` is deleted instead of ended: its address
// was never shown, so nothing can have been sent to it (activation.ts dropUnconfirmed).
export const TRANSITIONS: Record<Stage, Partial<Record<FlowEvent, Stage>>> = {
  walletConfirm: { walletConfirmed: 'funding' },
  // A burn the page had dropped as never landed turns out final (a lagging Solana read, SITE-11): it is taken back.
  funding: { funded: 'funded', burnFound: 'burnFinal', ...CANCEL },
  funded: { underfunded: 'funding', burnSigned: 'burnSent', burnFound: 'burnFinal', ...CANCEL },
  // Sent: final, failed on chain, never landed before its blockhash expired, or not known after 90 s.
  burnSent: { burnFinalized: 'burnFinal', burnFailed: 'burnFailed', burnExpired: 'funded', burnTimeout: 'burnUnknown' },
  burnUnknown: { burnFinalized: 'burnFinal', burnFailed: 'burnFailed', burnExpired: 'funded' },
  burnFailed: { retryBurn: 'funding', ...CANCEL },
  burnFinal: { linkStarted: 'linkOpen', ...GIVE_BACK },
  // An answer that is no consent (declined, an error, `linked`, expired) leaves the burn unregistered.
  linkOpen: { consentRead: 'consentVerified', linkEnded: 'burnFinal' },
  consentVerified: { confirmed: 'beneficiaryConfirmed', mismatch: 'mismatch', consentStale: 'consentStale', nodeExists: 'nodeExists', onChain: 'onChain', otherBurn: 'otherBurn' },
  mismatch: { relink: 'burnFinal', ...GIVE_BACK },
  consentStale: { relink: 'burnFinal', ...GIVE_BACK },
  // The wallet has a node of either type already: one wallet, one node, so this burn registers none.
  nodeExists: { ...GIVE_BACK },
  beneficiaryConfirmed: { submitted: 'submitted', nodeExists: 'nodeExists', consentStale: 'consentStale', onChain: 'onChain', otherBurn: 'otherBurn' },
  // The network lists the node: recorded with this burn (onChain), or with another one (otherBurn, SITE-10).
  submitted: { submitted: 'submitted', refused: 'refused', consentStale: 'consentStale', onChain: 'onChain', otherBurn: 'otherBurn' },
  refused: { resubmit: 'submitted', ...GIVE_BACK },
  // The wallet's node was registered with another burn: this burn registers none, and only what is left goes back.
  otherBurn: { ...GIVE_BACK },
  // Recorded: what is left goes back to the wallet, then the key is deleted and the receipt stays.
  onChain: { leftovers: 'leftovers', done: 'done' },
  leftovers: { done: 'done' },
  // Not recorded here: what is left goes back, then the record is deleted (a burn stays the wallet's on the server).
  closing: {},
  done: {},
};

export type Network = 'testnet' | 'mainnet';

export interface BurnFacts {
  // The burn's transaction signature, known before it is sent.
  tx: string;
  lastValidBlockHeight: number;
  // Whole 1DEV.
  amount: number;
  // The site's read pass for it (src/server/cabinet/solana-proxy.ts): its reads are never held back. Absent while the
  // site gave none (the burn was refused, or its answer was lost) and in a record from before.
  pass?: string;
}

// A burn the page took for never landed, and when (absent in a record from before).
export interface DroppedBurn extends BurnFacts {
  droppedAt?: number;
}

// The QNet Link request that carries the burn: how it was shown, whether the page held its wallet, and the wallet's
// full address the request named by its hash (null when it named none).
export interface LinkFacts {
  qr: boolean;
  held: boolean;
  named: string | null;
  request: LinkDeviceRequest;
}

// A `link` `ok` answer the page verified (qnet-link.ts validateAnswer), with the check number of its session.
export interface AnswerFacts {
  qnet: string;
  nodeId: string;
  consent: Consent;
  bound: boolean;
  checkNumber: number;
  // The user read the same check number in QNet Wallet.
  checkConfirmed: boolean;
}

export interface SubmitFacts {
  qnet: string;
  nodeId: string;
  ts: number;
  attempts: number;
  txHash: string | null;
  admittedAt: number | null;
  lastCode: string | null;
}

export interface RefundFacts {
  dest: string;
  tx: string;
  lastValidBlockHeight: number;
  // The site's read pass for it, as for a burn.
  pass?: string;
}

// The wallet's signed reservation from QNet Wallet's `reserve` answer, which the page verified (qnet-link.ts
// validateAnswer): the wallet, its ML-DSA-65 public key and signature (base64url) and when it signed (Unix seconds). The
// server holds the wallet only with it (burn-record.ts verifyReservationProof), and the owner bind names its key.
export interface HoldFacts {
  wallet: string;
  pk: string;
  sig: string;
  time: number;
}

// The wallet's reservation in the server's activation registry that the burn is made under (activation.ts burn): its id,
// the wallet, when it ends (ms) and the amount reserved. The payment key signs a burn only under one with at least
// SIGN_MARGIN_MS left and of this very amount (payment-key.ts signBurn).
export interface ReservationFacts {
  id: string;
  wallet: string;
  until: number;
  amount: number;
}

// What a finished activation keeps (SITE-R3-03): the wallet the burn registered and its node. The rest of the record
// goes with the key.
export interface ReceiptFacts {
  qnet: string;
  nodeId: string;
}

// One payment address and where its activation stands. `key` is the non-extractable Ed25519 key; null once the
// activation is done and only the receipt is kept.
export interface PaymentRecord {
  v: 1;
  pub: string;
  key: CryptoKey | null;
  network: Network;
  createdAt: number;
  updatedAt: number;
  stage: Stage;
  burn: BurnFacts | null;
  link: LinkFacts | null;
  answer: AnswerFacts | null;
  submit: SubmitFacts | null;
  refund: RefundFacts | null;
  // Burns the page took for never landed (their blockhash expired unseen, or the endpoint refused them), looked at again
  // until each is proven never landed or taken back (SITE-11); no new burn is signed while one is kept (SITE-R3-02).
  // Absent in a record from before.
  dropped?: DroppedBurn[];
  // Only in a receipt (stage `done`); a receipt from before keeps `submit` instead.
  receipt?: ReceiptFacts;
  // The wallet this activation is for, named when the key was made; absent in a record from before.
  wallet?: string;
  // The wallet's signed reservation (QNet Wallet's confirmation); absent before it, and in a record from before.
  hold?: HoldFacts;
  // The reservation the burn is made under; absent before one, and in a record from before.
  reservation?: ReservationFacts;
}

// How many dropped burns a record keeps.
export const DROPPED_KEPT = 4;

export function advance(record: PaymentRecord, event: FlowEvent, now: number): PaymentRecord | null {
  const next = TRANSITIONS[record.stage][event];
  return next === undefined ? null : { ...record, stage: next, updatedAt: now };
}

// Nothing was burned yet: the user may end the activation (what the address received goes back first; a record still
// waiting for QNet Wallet's confirmation is deleted, its address never shown).
export function mayCancel(record: Pick<PaymentRecord, 'stage'>): boolean {
  return record.stage === 'walletConfirm' || TRANSITIONS[record.stage].cancel !== undefined;
}

// The key's lifetime is over and nothing was burned: the activation ends from where it stands.
export function isExpired(record: Pick<PaymentRecord, 'stage' | 'createdAt'>, now: number): boolean {
  return now - record.createdAt >= KEY_LIFETIME_MS && (record.stage === 'walletConfirm' || TRANSITIONS[record.stage].expire !== undefined);
}

// After a final burn that is not registered from this browser (yet), the user may send what is left back at once and
// delete the key: the burn stays the wallet's activation (the server's record), and the registration needs no payment
// key.
export function mayReturnLeftovers(record: Pick<PaymentRecord, 'stage'>): boolean {
  return TRANSITIONS[record.stage].returnLeftovers !== undefined;
}

// The record's dropped burns with one more, dropped at `now` (the newest first), at most DROPPED_KEPT.
export function withDropped(record: Pick<PaymentRecord, 'dropped'>, burn: BurnFacts | null, now: number): DroppedBurn[] {
  const kept = record.dropped ?? [];
  if (!burn || kept.some((b) => b.tx === burn.tx)) return kept;
  return [{ ...burn, droppedAt: now }, ...kept].slice(0, DROPPED_KEPT);
}

export const isUnfinished = (record: Pick<PaymentRecord, 'stage'>): boolean => record.stage !== 'done';

// The wallet the activation is for: the one it registered, else the one that signed its reservation, else the one the
// reservation or the key names. A request names only it.
export function pinnedWallet(record: Pick<PaymentRecord, 'submit' | 'reservation'> & Partial<Pick<PaymentRecord, 'hold' | 'wallet'>>): string | null {
  return record.submit?.qnet ?? record.hold?.wallet ?? record.reservation?.wallet ?? record.wallet ?? null;
}

// Where what is left on the payment address goes: the Solana address the chosen wallet shared, when that wallet
// is the one the burn is for (or the burn is for none yet); null when the page does not know it.
export function refundDestination(record: Pick<PaymentRecord, 'pub' | 'submit' | 'reservation'> & Partial<Pick<PaymentRecord, 'hold' | 'wallet'>>, choice: WalletChoice | null): string | null {
  const dest = ownSolanaOf(choice);
  const pinned = pinnedWallet(record);
  if (!dest || dest === record.pub || (pinned !== null && pinned !== choice?.qnet)) return null;
  return dest;
}

// The `link` request for the record's burn (section 14.4 and R16): the wallet the burn is for by its hash, and the
// check number only for a QR code when the page neither holds that wallet nor has its signed reservation. A request that
// names a wallet takes an answer from that wallet only (answerIsNamed), and only its key can sign one.
export function linkFacts(record: PaymentRecord, qr: boolean, choice: WalletChoice | null): LinkFacts {
  if (!record.burn) throw new Error('no burn');
  const pinned = pinnedWallet(record);
  const named = pinned ?? choice?.qnet ?? null;
  const held = record.submit !== null || (record.hold !== undefined && record.hold.wallet === named)
    || (choice !== null && isHeldWallet(choice) && choice.qnet === named);
  return {
    qr,
    held: named !== null && held,
    named,
    request: { burnTx: record.burn.tx, walletHash: named === null ? null : walletHash(named), check: qr && !(named !== null && held) },
  };
}

// A request that named a wallet takes an answer from that wallet only, by its full address and not only by the
// 64-bit hash the request carried (SITE-R1-04). A request that named none takes any wallet's.
export function answerIsNamed(link: LinkFacts, answerQnet: string): boolean {
  return link.request.walletHash === null || (typeof link.named === 'string' && link.named === answerQnet);
}

// Whether the answer's wallet is the beneficiary without asking the user: the request opened QNet Wallet on this
// device (nobody else saw it), or it named a wallet the page held and the answer is that wallet.
export function confirmedWithoutCheck(link: LinkFacts, answerQnet: string): boolean {
  if (!answerIsNamed(link, answerQnet)) return false;
  return !link.qr || (link.held && link.request.walletHash !== null);
}

export function beneficiaryConfirmed(record: Pick<PaymentRecord, 'link' | 'answer'>): boolean {
  if (!record.link || !record.answer || !answerIsNamed(record.link, record.answer.qnet)) return false;
  if (confirmedWithoutCheck(record.link, record.answer.qnet)) return true;
  return record.link.request.check && record.answer.checkConfirmed;
}

// The consent window of section 14.2.
export function consentFresh(ts: number, nowS: number, consent24h: boolean): boolean {
  return ts >= nowS - (consent24h ? 86_400 : 300) && ts <= nowS + 300;
}

// The activation code of the record's burn, a receipt the network does not need. It encodes the wallet the burn is
// for, never the payment address (owner rule, 26.09): the wallet that signed the reservation, so it shows as soon as the
// burn is final. A burn whose wallet's node came from another burn has none.
export function receiptCode(record: Pick<PaymentRecord, 'burn' | 'submit'> & Partial<Pick<PaymentRecord, 'hold' | 'reservation'>> & { stage?: Stage; receipt?: ReceiptFacts }): string | null {
  const wallet = record.receipt?.qnet ?? record.submit?.qnet ?? record.hold?.wallet ?? record.reservation?.wallet ?? null;
  if (record.stage === 'otherBurn') return null;
  return record.burn && wallet ? activationCode('light', wallet, record.burn.tx, record.burn.amount) : null;
}

// The wallet and node a finished activation registered: its receipt, or in a receipt from before, its submit.
export function receiptOf(record: Pick<PaymentRecord, 'stage' | 'submit' | 'receipt'>): ReceiptFacts | null {
  if (record.stage !== 'done') return null;
  if (record.receipt) return record.receipt;
  return record.submit ? { qnet: record.submit.qnet, nodeId: record.submit.nodeId } : null;
}

// The record as the receipt it leaves once the node is recorded (onChain, leftovers -> done): the payment address, the
// burn, its amount, and the wallet and node it registered, as the privacy policy says (SITE-R3-03). The signed
// reservation, the link request, the wallet's answer with its public key and consent, the refund, the dropped burns and
// the key go.
export function asReceipt(record: PaymentRecord, now: number): PaymentRecord | null {
  const next = advance(record, 'done', now);
  const facts = record.submit ?? record.answer;
  if (!next || !record.burn || !facts) return null;
  const { tx, lastValidBlockHeight, amount } = record.burn;
  return {
    v: 1, pub: record.pub, key: null, network: record.network, createdAt: record.createdAt, updatedAt: now, stage: 'done',
    burn: { tx, lastValidBlockHeight, amount }, link: null, answer: null, submit: null, refund: null,
    receipt: { qnet: facts.qnet, nodeId: facts.nodeId },
  };
}
