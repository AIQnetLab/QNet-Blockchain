// The steps of an activation on aiqnet.io/node/activate (unified plan flows A and B; shared contracts C1 and C4): each
// reads what it needs from the site's own routes, moves the payment record one stage (src/lib/cabinet/flow.ts) in one
// storage step, and returns it. The page calls them from its timers and buttons; the tests call them with fakes. Nothing
// here shows text; nothing is signed but through payment-key.ts.

import { parseSitePrice, type PriceQuote } from '../activation-price.ts';
import {
  MLDSA65_PUBLIC_KEY_BYTES, MLDSA65_SIGNATURE_BYTES, decodeB64url, isU64String, lightNodeId, walletHash, type LinkAnswer, type LinkRequest,
} from '../qnet-link.ts';
import type { WalletChoice } from './wallet-choice.ts';
import { BURN_SOL_LAMPORTS, READ_PASS_RE, SIGNATURE_FEE_LAMPORTS, refundLamports, refundShortfall, tokensMovable, type RefundPlan } from './burn-tx.ts';
import {
  advance,
  answerIsNamed,
  asReceipt,
  beneficiaryConfirmed,
  consentFresh,
  isExpired,
  linkFacts,
  mayCancel,
  mayReturnLeftovers,
  TRANSITIONS,
  withDropped,
  type FlowEvent,
  type HoldFacts,
  type PaymentRecord,
  type ReservationFacts,
  type SubmitFacts,
} from './flow.ts';
import { parseArchivedRecord, type ArchivedRecord } from './code-check.ts';
import { parseStatusView, type NodeStatusView } from './node-view.ts';
import { signBurn, signOwnerBindV2, signRefund, type SignedTx } from './payment-key.ts';
import { browserArea, listRecords, pruneReceipts, removeRecord, requestPersistence, updateRecord, type PaymentArea } from './payment-store.ts';
import { OWNER_BIND_V2_FEATURE, type ConsentBody, type SubmitOutcome } from './registration.ts';
import { consentBodyOf, postConsent } from './consent-submit.ts';
import { parseWalletNode, type WalletNodeView } from './wallet-activation.ts';
import { ONE_DEV_UNIT } from '../one-dev.ts';
import { SIGN_MARGIN_MS, isReservationId } from './burn-record.ts';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ActivationDeps {
  fetchFn: FetchLike;
  area: PaymentArea;
  subtle: SubtleCrypto;
  now: () => number;
  // Asks the browser to keep the site's storage (payment-store.ts requestPersistence); absent in the tests.
  persist?: () => Promise<boolean>;
}

export function browserDeps(): ActivationDeps {
  return { fetchFn: (url, init) => fetch(url, init), area: browserArea, subtle: crypto.subtle, now: Date.now, persist: requestPersistence };
}

// From the burn on, the payment key holds what is left on its address until it goes back: the browser is asked again to
// keep the site's storage (SITE-R1-06), never waited for.
function keepStorage(deps: ActivationDeps): void {
  const { persist } = deps;
  if (persist) void Promise.resolve().then(persist).catch(() => false);
}

// The burn waits for finality this long before the page says the outcome is not known yet.
export const BURN_WAIT_MS = 90_000;
// A dropped burn is forgotten only when a read this long after it was dropped still finds it nowhere past its last
// valid block: by then no lagging Solana backend still misses a burn that landed (SITE-R3-02).
export const DROP_SETTLE_MS = 3 * 60_000;
// After an admission the page waits this long for the chain before it submits again.
export const ADMIT_HOLD_MS = 180_000;
// A node the network lists after this page's submit was admitted is taken as registered with this burn when the
// explorer's archive still shows no registration this long after the admission (SITE-10).
export const ARCHIVE_WAIT_MS = 10 * 60_000;

const REQUEST: RequestInit = { cache: 'no-store', credentials: 'omit', redirect: 'error' };
const U64_RE = /^(?:0|[1-9][0-9]{0,19})$/;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

async function getJson(deps: ActivationDeps, url: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await deps.fetchFn(url, REQUEST);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

async function postJson(deps: ActivationDeps, url: string, value: unknown): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await deps.fetchFn(url, { ...REQUEST, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

// ---------------------------------------------------------------- reads

export async function readPrice(deps: ActivationDeps): Promise<PriceQuote | null> {
  const got = await getJson(deps, '/api/cabinet/price');
  return got?.status === 200 ? parseSitePrice(got.body, 'light') : null;
}

export interface PaymentBalance {
  sol: bigint;
  oneDev: bigint;
  accountExists: boolean;
}

export async function readPayment(address: string, deps: ActivationDeps): Promise<PaymentBalance | null> {
  const got = await getJson(deps, `/api/cabinet/payment/${encodeURIComponent(address)}`);
  const b = got?.status === 200 ? got.body : null;
  if (!isObject(b) || Object.keys(b).length !== 3 || typeof b.sol !== 'string' || !U64_RE.test(b.sol)) return null;
  if (typeof b.oneDev !== 'string' || !U64_RE.test(b.oneDev) || typeof b.accountExists !== 'boolean') return null;
  return { sol: BigInt(b.sol), oneDev: BigInt(b.oneDev), accountExists: b.accountExists };
}

export type TxRead = { state: 'pending' | 'processed' | 'confirmed' | 'failed' | 'expired' } | { state: 'finalized'; burn: { payer: string; amount: number } | null };

// `pass`: the site's read pass for it, which /api/cabinet/send gave (src/server/cabinet/solana-proxy.ts).
export async function readTx(signature: string, lastValidBlockHeight: number | null, deps: ActivationDeps, pass: string | null = null): Promise<TxRead | null> {
  const query = new URLSearchParams();
  if (lastValidBlockHeight !== null) query.set('lvh', String(lastValidBlockHeight));
  if (pass !== null) query.set('pass', pass);
  const q = query.toString() === '' ? '' : `?${query.toString()}`;
  const got = await getJson(deps, `/api/cabinet/tx/${encodeURIComponent(signature)}${q}`);
  const b = got?.status === 200 ? got.body : null;
  if (!isObject(b) || typeof b.state !== 'string') return null;
  if (b.state === 'finalized') {
    const burn = b.burn;
    if (burn === null) return { state: 'finalized', burn: null };
    if (!isObject(burn) || typeof burn.payer !== 'string' || typeof burn.amount !== 'number' || !Number.isSafeInteger(burn.amount)) return null;
    return { state: 'finalized', burn: { payer: burn.payer, amount: burn.amount } };
  }
  return ['pending', 'processed', 'confirmed', 'failed', 'expired'].includes(b.state) ? { state: b.state as 'pending' } : null;
}

export async function readNodeStatus(nodeId: string, deps: ActivationDeps): Promise<NodeStatusView | null> {
  const got = await getJson(deps, `/api/cabinet/node/${encodeURIComponent(nodeId)}`);
  return got?.status === 200 ? parseStatusView(got.body) : null;
}

// Whether a wallet has a light node already, or one being recorded (SITE-R2-10). Null while the nodes cannot be read.
export async function walletHasNode(qnet: string, deps: ActivationDeps): Promise<boolean | null> {
  const status = await readNodeStatus(lightNodeId(qnet), deps);
  return status === null ? null : status.registered || status.pending;
}

// Whether the network takes a payment address's burn now: the two genesis nodes that settle the wallet's light node
// status both list the v2 owner bind (node-proxy.ts mergeStatus keeps the features both list). The payment key signs no
// other bind, and before the network's one-wallet-one-node gate the nodes refuse it, so no address is shown and no burn
// signed until then. Null while the nodes cannot be read.
export async function paymentOpen(qnet: string, deps: ActivationDeps): Promise<boolean | null> {
  const status = await readNodeStatus(lightNodeId(qnet), deps);
  return status === null ? null : status.features.includes(OWNER_BIND_V2_FEATURE);
}

// The wallet's node of either type on the network (GET /api/cabinet/wallet-node/{wallet}); null while it cannot be read.
export async function readWalletNode(qnet: string, deps: ActivationDeps): Promise<WalletNodeView | null> {
  const got = await getJson(deps, `/api/cabinet/wallet-node/${encodeURIComponent(qnet)}`);
  return got?.status === 200 ? parseWalletNode(got.body) : null;
}

// The burn facts of a wallet's light node registration, from the explorer's archive of the chain.
export async function readRegistration(qnet: string, deps: ActivationDeps): Promise<ArchivedRecord | null> {
  const got = await getJson(deps, `/api/cabinet/registration/${encodeURIComponent(qnet)}`);
  return got?.status === 200 ? parseArchivedRecord(got.body) : null;
}

// ---------------------------------------------------------------- moving the record

// `when`: a further condition on the stored record, read in the same storage step.
function move(record: PaymentRecord, event: FlowEvent, deps: ActivationDeps, extra: Partial<PaymentRecord> = {}, when: (current: PaymentRecord) => boolean = () => true): Promise<PaymentRecord | null> {
  return updateRecord(record.pub, (current) => {
    if (current.stage !== record.stage || !when(current)) return null;
    const next = advance(current, event, deps.now());
    return next ? { ...next, ...extra } : null;
  }, deps.area);
}

// The read pass the site answered a send with, or null.
function passIn(body: unknown): string | null {
  return isObject(body) && typeof body.pass === 'string' && READ_PASS_RE.test(body.pass) ? body.pass : null;
}

// Fields of a record that stays where it is, in one storage step.
function patch(record: PaymentRecord, extra: Partial<PaymentRecord>, deps: ActivationDeps): Promise<PaymentRecord | null> {
  return updateRecord(record.pub, (current) => (current.stage === record.stage ? { ...current, ...extra, updatedAt: deps.now() } : null), deps.area);
}

// What the payment address must hold to burn `price`: the 1DEV, the fee, and the rent-exempt minimum after it.
export function fundedFor(balance: PaymentBalance, price: number): boolean {
  return balance.oneDev >= BigInt(price) * ONE_DEV_UNIT && balance.sol >= BURN_SOL_LAMPORTS;
}

// The burns the page dropped as never landed, looked at again (SITE-11): one that is final after all, and this
// address's light burn, is taken back (burnFinal). One is forgotten only once proven: it failed, it holds no burn of this
// address, or a read DROP_SETTLE_MS after it was dropped still finds it nowhere past its last valid block. Any other is
// kept, and while one is kept no new burn is signed (burn, SITE-R3-02).
export async function recheckDropped(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  const dropped = record.dropped ?? [];
  if (dropped.length === 0 || TRANSITIONS[record.stage].burnFound === undefined) return record;
  const kept = [];
  for (const [i, b] of dropped.entries()) {
    const read = await readTx(b.tx, b.lastValidBlockHeight, deps, b.pass ?? null);
    if (read?.state === 'finalized' && read.burn !== null && read.burn.payer === record.pub && read.burn.amount === b.amount) {
      keepStorage(deps);
      const burn = { tx: b.tx, lastValidBlockHeight: b.lastValidBlockHeight, amount: b.amount, ...(b.pass ? { pass: b.pass } : {}) };
      return (await move(record, 'burnFound', deps, { burn, dropped: [...kept, ...dropped.slice(i + 1)] })) ?? record;
    }
    // A record from before has no drop time: its last move, which came at the drop or after it, stands in.
    const settled = deps.now() - (b.droppedAt ?? record.updatedAt) >= DROP_SETTLE_MS;
    const proven = read !== null && (read.state === 'failed' || read.state === 'finalized' || (read.state === 'expired' && settled));
    if (!proven) kept.push(b);
  }
  return kept.length === dropped.length ? record : (await patch(record, { dropped: kept }, deps)) ?? record;
}

// funding <-> funded, from the address's balance. Dropped burns are looked at again first, at every read while one is
// kept: one may have landed even when the address still holds as much 1DEV as it would have burned (SITE-R3-02).
export async function checkFunding(record: PaymentRecord, price: number, deps: ActivationDeps): Promise<{ record: PaymentRecord; balance: PaymentBalance | null }> {
  const balance = await readPayment(record.pub, deps);
  if (!balance) return { record, balance };
  if ((record.dropped ?? []).length > 0) {
    const found = await recheckDropped(record, deps);
    if (found.stage === 'burnFinal') return { record: found, balance };
    record = found;
  }
  const enough = fundedFor(balance, price);
  const event: FlowEvent | null = record.stage === 'funding' && enough ? 'funded' : record.stage === 'funded' && !enough ? 'underfunded' : null;
  return { record: (event && (await move(record, event, deps))) || record, balance };
}

// `found`: a burn the page had dropped landed after all, and the record follows it now (burnFinal). `checking`: a
// dropped burn is not proven never landed yet, so nothing is signed (SITE-R3-02). The wallet's reservation (shared
// contract C3.2): `no_wallet`, the chosen wallet is not the one this activation is for; `reconfirm`, the wallet's signed
// reservation is missing or too old for the server, and QNet Wallet is asked again (the address stays); `has_node`, the
// wallet has a node; `has_burn`, it has its burn already (a record, or one found on its Solana address); `reserved`,
// another browser or device holds it, or its burn is on its way; `check_unavailable`, a check did not answer;
// `reservation`, the reservation ended before the burn left (nothing was forwarded); `not_open`, the network does not
// take the payment key's owner bind yet (paymentOpen), so nothing is reserved or signed.
export type BurnResult = {
  outcome: 'sent' | 'unknown' | 'refused' | 'busy' | 'unavailable' | 'price_unavailable' | 'price_changed' | 'has_node' | 'found' | 'checking'
    | 'no_wallet' | 'reconfirm' | 'has_burn' | 'reserved' | 'check_unavailable' | 'reservation' | 'not_open';
  record: PaymentRecord;
  // With `price_changed`: what the network asks now, for the page to show before the user burns.
  quote?: PriceQuote;
};

// The record's burn or refund with the read pass the site gave for it, in one storage step; the record as it was when
// it moved on meanwhile.
async function keepPass(record: PaymentRecord, which: 'burn' | 'refund', pass: string | null, deps: ActivationDeps): Promise<PaymentRecord> {
  const tx = record[which]?.tx;
  if (pass === null || tx === undefined) return record;
  const kept = await updateRecord(record.pub, (current) => {
    if (which === 'burn') return current.burn && current.burn.tx === tx ? { ...current, burn: { ...current.burn, pass } } : null;
    return current.refund && current.refund.tx === tx ? { ...current, refund: { ...current.refund, pass } } : null;
  }, deps.area);
  return kept ?? record;
}

// ---------------------------------------------------------------- the wallet's reservation (shared contract C3.2)

export type ReserveAnswer =
  | { ok: true; reservation: string; until: number }
  | { ok: false; outcome: 'has_node' | 'has_burn' | 'reserved' | 'check_unavailable' | 'reconfirm' };

// POST /api/cabinet/activation/reserve for a payment address's light burn of `amount` for `wallet`, with the wallet's own
// Solana address when the page knows it (the server searches it for a burn first) and the wallet's signed reservation
// (C1): the server holds the wallet only with it. A proof too old for the server asks QNet Wallet again (`reconfirm`).
// Anything but a reservation offers no burn.
export async function reserveWallet(wallet: string, burner: string, amount: number, solana: string | null, proof: Omit<HoldFacts, 'wallet'>, deps: ActivationDeps): Promise<ReserveAnswer> {
  const got = await postJson(deps, '/api/cabinet/activation/reserve', {
    wallet, nodeType: 'light', way: 'payment', burner, burnAmount: amount, solana, proof: { pk: proof.pk, sig: proof.sig, time: proof.time },
  });
  const b = got?.body;
  if (got?.status === 200 && isObject(b) && isReservationId(b.reservation) && typeof b.until === 'number' && Number.isSafeInteger(b.until)) {
    return { ok: true, reservation: b.reservation, until: b.until };
  }
  if (got?.status === 400 && isObject(b) && b.error === 'stale_proof') return { ok: false, outcome: 'reconfirm' };
  const error = got?.status === 409 && isObject(b) ? b.error : null;
  if (error === 'has_node') return { ok: false, outcome: 'has_node' };
  if (error === 'has_burn' || error === 'burn_found' || error === 'burn_unusable') return { ok: false, outcome: 'has_burn' };
  if (error === 'reserved' || error === 'burn_pending') return { ok: false, outcome: 'reserved' };
  return { ok: false, outcome: 'check_unavailable' };
}

// ---------------------------------------------------------------- the wallet's confirmation (shared contract C1)

// The `reserve` request for the record (section 14): its wallet by hash, and its payment address as the burner.
export function reserveRequest(record: Pick<PaymentRecord, 'pub' | 'wallet'>): { walletHash: string; burner: string } | null {
  return record.wallet ? { walletHash: walletHash(record.wallet), burner: record.pub } : null;
}

// A record still waiting for QNet Wallet's confirmation is deleted: its address was never shown, so nothing can have
// been sent to it (declined, an error, the request expired, or the user cancelled).
export async function dropUnconfirmed(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord | null> {
  if (record.stage !== 'walletConfirm') return record;
  await removeRecord(record.pub, deps.area);
  return null;
}

// `confirmed`: the wallet signed its reservation, kept as the record's hold (walletConfirm -> funding, or a new hold in
// place of one the server found too old). `other_wallet`: the answer is another wallet's than the one the record is for.
// `ended`: declined, an error, or no answer. A record at walletConfirm whose request ended is deleted (null); later,
// the record stays as it is.
export type HoldResult = { outcome: 'confirmed' | 'other_wallet' | 'ended'; record: PaymentRecord | null };

// QNet Wallet's `reserve` answer, as the link session read and verified it against `request`, the request that session
// carried (qnet-link.ts validateAnswer: the wallet's signature over its reservation of this payment address). An answer
// to another request (another record's) is never taken.
export async function takeHold(record: PaymentRecord, answer: LinkAnswer, request: LinkRequest | null, deps: ActivationDeps): Promise<HoldResult> {
  if (record.stage !== 'walletConfirm' && record.stage !== 'funding' && record.stage !== 'funded') return { outcome: 'ended', record };
  const wallet = record.wallet;
  const mine = reserveRequest(record);
  const asked = request !== null && 'burner' in request ? request : null;
  const end = async (outcome: HoldResult['outcome']): Promise<HoldResult> => ({ outcome, record: await dropUnconfirmed(record, deps) });
  if (!wallet || !mine || !asked || asked.walletHash !== mine.walletHash || asked.burner !== mine.burner) return end('ended');
  if (answer.intent !== 'reserve' || answer.status !== 'ok') return end('ended');
  if (answer.qnet !== wallet) return end('other_wallet');
  const pk = answer.pk ?? '';
  const sig = answer.sig ?? '';
  if (!isU64String(answer.time) || !decodeB64url(pk, MLDSA65_PUBLIC_KEY_BYTES) || !decodeB64url(sig, MLDSA65_SIGNATURE_BYTES)) return end('ended');
  const hold: HoldFacts = { wallet, pk, sig, time: Number(answer.time) };
  const next = record.stage === 'walletConfirm' ? await move(record, 'walletConfirmed', deps, { hold }) : await patch(record, { hold }, deps);
  return { outcome: 'confirmed', record: next ?? record };
}

// How often, and how far apart, the page looks for another tab's reservation of the same record.
const BUSY_LOOKS = 3;
const BUSY_LOOK_MS = 100;

// POST /api/cabinet/activation/release: a reservation without a burn (the server never releases a burn). Best effort:
// the server ends a reservation by itself.
export async function releaseReservation(held: ReservationFacts | undefined, deps: ActivationDeps): Promise<void> {
  if (held) await postJson(deps, '/api/cabinet/activation/release', { wallet: held.wallet, reservation: held.id });
}

// The reservation the record may sign under for `wallet` and `amount` (at least SIGN_MARGIN_MS left), else null.
function usableReservation(record: PaymentRecord, wallet: string, amount: number, now: number): ReservationFacts | null {
  const held = record.reservation;
  return held && held.wallet === wallet && held.amount === amount && held.until - now >= SIGN_MARGIN_MS ? held : null;
}

// The burn: every burn the page dropped proven never landed (a landed one is taken back instead), the price read again,
// the network open to the payment key's owner bind (paymentOpen), the wallet it is for held by a reservation in the server's activation registry with the wallet's signed reservation
// (the server checks the network, its record and the wallet's Solana address first, and holds the wallet for this browser
// alone), then signed under that reservation, bound to the wallet's light node by the payment key's v2 owner bind,
// recorded as sent before it is sent (its id is its signature), then sent through the site with the reservation and the
// bind: the site announces it as the wallet's before it leaves, and once final it is the wallet's activation for good.
// Another tab that took the step first leaves this one `busy`, with nothing sent. `wallet`: the connected wallet, which
// must be the one that signed the reservation; `solana`: the wallet's own Solana address, when the page knows it.
export async function burn(record: PaymentRecord, price: number, deps: ActivationDeps, wallet: string | null = null, solana: string | null = null): Promise<BurnResult> {
  // A dropped burn may have landed all the same (a lagging read, a refusal a layer in front of the endpoint forwarded
  // anyway): a second burn beside it would burn the price twice, and the first one could never be registered (SITE-R3-02).
  const checked = await recheckDropped(record, deps);
  if (checked.stage !== record.stage) return { outcome: 'found', record: checked };
  if ((checked.dropped ?? []).length > 0) return { outcome: 'checking', record: checked };
  record = checked;
  // The page may have stood open for hours, and the phase-1 price steps down as supply is burned: a burn of the amount
  // read earlier would lose the difference, or fall short of the price (SITE-R2-05).
  const quote = await readPrice(deps);
  if (!quote) return { outcome: 'price_unavailable', record };
  if (quote.phase !== 1 || quote.cost !== price) return { outcome: 'price_changed', record, quote };
  // One wallet, one burn (R6): the burn is for the wallet that signed its reservation, held by a reservation, and only
  // while that wallet is the connected one.
  const hold = record.hold;
  if (!hold) return { outcome: 'reconfirm', record };
  const target = hold.wallet;
  if (wallet !== target) return { outcome: 'no_wallet', record };
  // Before the network takes the v2 owner bind, a burn could not register the node: nothing is reserved or signed.
  const open = await paymentOpen(target, deps);
  if (open === null) return { outcome: 'check_unavailable', record };
  if (!open) return { outcome: 'not_open', record };
  if (!usableReservation(record, target, price, deps.now())) {
    // A reservation for another wallet or amount, or too close to its end, goes first: the server holds one per wallet.
    if (record.reservation) {
      await releaseReservation(record.reservation, deps);
      record = (await patch(record, { reservation: undefined }, deps)) ?? record;
    }
    const held = await reserveWallet(target, record.pub, price, solana, hold, deps);
    if (!held.ok) {
      // Another tab of this browser took the reservation for this record, and keeps it in the record a moment later:
      // that tab burns.
      if (held.outcome === 'reserved') {
        for (let look = 0; look < BUSY_LOOKS; look += 1) {
          if (look > 0) await new Promise((resolve) => setTimeout(resolve, BUSY_LOOK_MS));
          const stored = (await listRecords(deps.area)).find((r) => r.pub === record.pub);
          if (stored && usableReservation(stored, target, price, deps.now())) return { outcome: 'busy', record: stored };
        }
      }
      return { outcome: held.outcome, record };
    }
    const kept = await patch(record, { reservation: { id: held.reservation, wallet: target, until: held.until, amount: price } }, deps);
    if (!kept) {
      await releaseReservation({ id: held.reservation, wallet: target, until: held.until, amount: price }, deps);
      return { outcome: 'busy', record };
    }
    record = kept;
  }
  const got = await getJson(deps, '/api/cabinet/blockhash');
  const b = got?.status === 200 ? got.body : null;
  if (!isObject(b) || typeof b.blockhash !== 'string' || typeof b.lastValidBlockHeight !== 'number' || !Number.isSafeInteger(b.lastValidBlockHeight)) {
    return { outcome: 'unavailable', record };
  }
  let signed: SignedTx;
  let ownerSig: string;
  const burnFacts = { tx: '', lastValidBlockHeight: b.lastValidBlockHeight, amount: price };
  try {
    signed = await signBurn(record, price, b.blockhash, deps.subtle, deps.now());
    burnFacts.tx = signed.signature;
    // Bound to the reserved wallet's light node before it is sent: the site takes no burn of a payment address without it.
    ownerSig = await signOwnerBindV2({ ...record, burn: burnFacts }, deps.subtle);
  } catch {
    return { outcome: 'unavailable', record };
  }
  // Another tab may have dropped a burn since this one looked: nothing is recorded, or sent, beside it.
  const reservation = record.reservation as ReservationFacts;
  const sent = await move(record, 'burnSigned', deps, { burn: burnFacts }, (current) => (current.dropped ?? []).length === 0 && current.reservation?.id === reservation.id);
  if (!sent) return { outcome: 'busy', record };
  keepStorage(deps);
  const answer = await postJson(deps, '/api/cabinet/send', { tx: base64(signed.wire), reservation: reservation.id, ownerSig });
  const state = answer?.status === 200 && isObject(answer.body) ? answer.body.state : null;
  // The reservation no longer allows this burn (it ended, or the wallet was taken meanwhile): nothing was forwarded.
  if (answer?.status === 409) return { outcome: 'reservation', record: (await move(sent, 'burnExpired', deps, { burn: null, reservation: undefined })) ?? sent };
  if (state === 'refused' || answer?.status === 400) {
    // The site's own check (400) forwarded nothing. A JSON-RPC error means the endpoint did not take it, but a layer in
    // front of it may have forwarded it all the same: that burn is kept aside, like one that expired unseen, and looked
    // at again until it is proven never landed (SITE-R2-04, SITE-R3-02).
    const dropped = state === 'refused' ? { dropped: withDropped(sent, sent.burn, deps.now()) } : {};
    return { outcome: 'refused', record: (await move(sent, 'burnExpired', deps, { burn: null, ...dropped })) ?? sent };
  }
  return { outcome: state === 'sent' ? 'sent' : 'unknown', record: await keepPass(sent, 'burn', passIn(answer?.body), deps) };
}

// A sent burn: final (and ours), failed, never landed, or not known yet. A burn the page dropped before stays kept when
// this one is final: only a read that proves it never landed forgets it (recheckDropped).
export async function settleBurn(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  if ((record.stage !== 'burnSent' && record.stage !== 'burnUnknown') || !record.burn) return record;
  const read = await readTx(record.burn.tx, record.burn.lastValidBlockHeight, deps, record.burn.pass ?? null);
  let event: FlowEvent | null = null;
  let extra: Partial<PaymentRecord> = {};
  if (read?.state === 'finalized') {
    const ours = read.burn !== null && read.burn.payer === record.pub && read.burn.amount === record.burn.amount;
    event = ours ? 'burnFinalized' : 'burnFailed';
    if (ours) keepStorage(deps);
  } else if (read?.state === 'failed') {
    event = 'burnFailed';
  } else if (read?.state === 'expired') {
    // Two reads found nothing past its last valid block. A lagging read can say so of a burn that landed, so the burn
    // is kept aside and looked at again until it is proven never landed (recheckDropped).
    event = 'burnExpired';
    extra = { burn: null, dropped: withDropped(record, record.burn, deps.now()) };
  } else if (record.stage === 'burnSent' && deps.now() - record.updatedAt > BURN_WAIT_MS) {
    // Not final yet, or not readable now (the site may be out of its Solana budget, SITE-R3-01): past 90 s the page says
    // the outcome is not known yet, and keeps reading.
    event = 'burnTimeout';
  }
  return (event && (await move(record, event, deps, extra))) || record;
}

export async function retryBurn(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  return (await move(record, 'retryBurn', deps, { burn: null })) ?? record;
}

// burnFinal -> linkOpen, with the request the page opens (flow.ts linkFacts).
export async function openLink(record: PaymentRecord, qr: boolean, choice: WalletChoice | null, deps: ActivationDeps): Promise<PaymentRecord | null> {
  return move(record, 'linkStarted', deps, { link: linkFacts(record, qr, choice), answer: null });
}

// The request ended without a consent (declined, an error, `linked`, expired, cancelled): the burn stays unused.
export async function closeLink(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  return (await move(record, 'linkEnded', deps, { link: null, answer: null })) ?? record;
}

// The session's request is exactly the record's open request, for the record's own burn.
export function isRecordRequest(record: PaymentRecord, request: LinkRequest | null): boolean {
  const mine = record.link?.request;
  if (!mine || !record.burn || mine.burnTx !== record.burn.tx || request === null || !('burnTx' in request)) return false;
  return request.burnTx === mine.burnTx && request.walletHash === mine.walletHash && request.check === mine.check;
}

// QNet Wallet's answer to the record's request, as the link session read and verified it against `request`, the
// request that session carried. An answer to another request (another activation's, from a session another tab kept)
// is never taken: it consents to another burn. The record's own request is then gone, and the page opens a new one
// (SITE-R3-02).
export async function takeAnswer(record: PaymentRecord, answer: LinkAnswer, checkNumber: number, request: LinkRequest | null, deps: ActivationDeps): Promise<PaymentRecord> {
  if (record.stage !== 'linkOpen') return record;
  if (!isRecordRequest(record, request)) return closeLink(record, deps);
  if (answer.intent !== 'link' || answer.status !== 'ok' || !answer.qnet || !answer.nodeId || !answer.consent || typeof answer.bound !== 'boolean') {
    return closeLink(record, deps);
  }
  const facts = { qnet: answer.qnet, nodeId: answer.nodeId, consent: answer.consent, bound: answer.bound, checkNumber, checkConfirmed: false };
  return (await move(record, 'consentRead', deps, { answer: facts })) ?? record;
}

// Where the wallet's nodes stand before a registration: its light node listed (settled against the archive: this burn
// or another), being recorded (wait), a node of either type (one wallet, one node), or none. Null while any cannot be read.
async function nodesBefore(record: PaymentRecord, qnet: string, nodeId: string, deps: ActivationDeps): Promise<{ status: NodeStatusView; next: PaymentRecord | 'wait' | 'nodeExists' | null } | null> {
  const status = await readNodeStatus(nodeId, deps);
  if (!status) return null;
  if (status.registered) return { status, next: await settleListed(record, record.submit, deps) };
  if (status.pending) return { status, next: 'wait' };
  const node = await readWalletNode(qnet, deps);
  if (!node) return null;
  if (node.state === 'registered') return { status, next: node.nodeType === 'light' ? await settleListed(record, record.submit, deps) : 'nodeExists' };
  return { status, next: null };
}

// A verified consent: from a wallet other than the one the request named, its light node on the chain already (with
// this burn or another) or being recorded (the page waits), a node of either type already (one wallet, one node), too
// old for the nodes, confirmed without asking, or waiting for the user's check. Unchanged while the nodes cannot be read.
export async function reviewConsent(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  if (record.stage !== 'consentVerified' || !record.answer) return record;
  // Not the wallet the request named by its full address (SITE-R1-04): nothing is submitted.
  if (!record.link || !answerIsNamed(record.link, record.answer.qnet)) return (await move(record, 'mismatch', deps)) ?? record;
  const nodes = await nodesBefore(record, record.answer.qnet, record.answer.nodeId, deps);
  if (!nodes) return record;
  if (nodes.next === 'wait') return record;
  if (nodes.next === 'nodeExists') return (await move(record, 'nodeExists', deps)) ?? record;
  if (nodes.next !== null) return nodes.next;
  if (!consentFresh(Number(record.answer.consent.ts), Math.floor(deps.now() / 1000), nodes.status.features.includes('consent_24h'))) {
    return (await move(record, 'consentStale', deps)) ?? record;
  }
  return beneficiaryConfirmed(record) ? (await move(record, 'confirmed', deps)) ?? record : record;
}

// The user compared the check numbers.
export async function answerCheck(record: PaymentRecord, matches: boolean, deps: ActivationDeps): Promise<PaymentRecord> {
  if (record.stage !== 'consentVerified' || !record.answer || !record.link?.request.check) return record;
  if (!matches) return (await move(record, 'mismatch', deps)) ?? record;
  return (await move(record, 'confirmed', deps, { answer: { ...record.answer, checkConfirmed: true } })) ?? record;
}

// mismatch, consentStale, nodeExists -> burnFinal: a new request for the unused burn.
export async function relink(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  return (await move(record, 'relink', deps, { link: null, answer: null })) ?? record;
}

// The wallet's consent from the record's answer, posted as the consent body (consent-submit.ts): the site completes it
// with the owner bind its record keeps.
async function postRegistration(record: PaymentRecord, submit: SubmitFacts, deps: ActivationDeps): Promise<SubmitOutcome> {
  let body: ConsentBody;
  try {
    if (!record.answer || !record.burn) throw new Error('consent');
    body = consentBodyOf(record.answer.qnet, { ...record.answer.consent, ts: submit.ts }, record.burn.tx, record.burn.amount);
  } catch {
    return { result: 'refused', code: 'bad_request' };
  }
  return postConsent(body, deps);
}

// The network lists the wallet's light node (SITE-10): registered with this burn (onChain), or with another one
// (otherBurn), as the explorer's archive of the chain shows. While the archive shows no registration yet the record
// waits; a registration is taken as this burn's once ARCHIVE_WAIT_MS passed since this page's submit was admitted, or,
// before a submit, since the consent was read (one wallet, one burn: its reservation kept any other burn out).
async function settleListed(record: PaymentRecord, submit: SubmitFacts | null, deps: ActivationDeps): Promise<PaymentRecord> {
  const qnet = submit?.qnet ?? record.answer?.qnet;
  if (!qnet) return record;
  const archived = await readRegistration(qnet, deps);
  const extra = submit ? { submit } : {};
  if (archived?.found) {
    const ours = record.burn !== null && archived.record.burnTx === record.burn.tx;
    return (await move(record, ours ? 'onChain' : 'otherBurn', deps, extra)) ?? record;
  }
  const since = submit ? submit.admittedAt : record.updatedAt;
  if (since !== null && deps.now() - since >= ARCHIVE_WAIT_MS) return (await move(record, 'onChain', deps, extra)) ?? record;
  return !submit || submit === record.submit ? record : (await patch(record, { submit }, deps)) ?? record;
}

async function applyOutcome(record: PaymentRecord, outcome: SubmitOutcome, deps: ActivationDeps): Promise<PaymentRecord> {
  const submit = record.submit as SubmitFacts;
  const attempts = submit.attempts + 1;
  // The server's record names another burn as this wallet's: this burn registers no node, and nothing was relayed.
  if (outcome.result === 'refused' && outcome.code === 'other_burn') return (await move(record, 'otherBurn', deps, { submit: { ...submit, attempts, lastCode: 'other_burn' } })) ?? record;
  if (outcome.result === 'registered') return settleListed(record, { ...submit, attempts, lastCode: 'registered' }, deps);
  if (outcome.result === 'stale') return (await move(record, 'consentStale', deps, { submit: { ...submit, attempts, lastCode: 'timestamp_window' } })) ?? record;
  if (outcome.result === 'refused') return (await move(record, 'refused', deps, { submit: { ...submit, attempts, lastCode: outcome.code } })) ?? record;
  const next = outcome.result === 'admitted'
    ? { ...submit, attempts, txHash: outcome.txHash, admittedAt: deps.now(), lastCode: null }
    : { ...submit, attempts, lastCode: outcome.code };
  return (await move(record, 'submitted', deps, { submit: next })) ?? record;
}

// beneficiaryConfirmed -> submitted: the nodes say the wallet has no node of either type and the consent is fresh, then
// the site submits the wallet's consent (it completes it with the owner bind of its record; nothing is signed here).
export async function register(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  if (record.stage !== 'beneficiaryConfirmed' || !record.answer) return record;
  const nodes = await nodesBefore(record, record.answer.qnet, record.answer.nodeId, deps);
  if (!nodes || nodes.next === 'wait') return record;
  if (nodes.next === 'nodeExists') return (await move(record, 'nodeExists', deps)) ?? record;
  if (nodes.next !== null) return nodes.next;
  const ts = Number(record.answer.consent.ts);
  if (!consentFresh(ts, Math.floor(deps.now() / 1000), nodes.status.features.includes('consent_24h'))) return (await move(record, 'consentStale', deps)) ?? record;
  const submit: SubmitFacts = { qnet: record.answer.qnet, nodeId: record.answer.nodeId, ts, attempts: 0, txHash: null, admittedAt: null, lastCode: null };
  const submitted = await move(record, 'submitted', deps, { submit });
  if (!submitted) return record;
  return applyOutcome(submitted, await postRegistration(submitted, submit, deps), deps);
}

// The wait between two submits of a registration that the nodes asked to retry.
export function retryDelayMs(attempts: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 120_000);
}

// submitted: on the chain now, or wait, or submit again (the same signatures).
export async function followRegistration(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  if (record.stage !== 'submitted' || !record.submit) return record;
  const status = await readNodeStatus(record.submit.nodeId, deps);
  if (status?.registered) return settleListed(record, record.submit, deps);
  const { admittedAt, attempts } = record.submit;
  const waitUntil = admittedAt !== null ? admittedAt + ADMIT_HOLD_MS : record.updatedAt + retryDelayMs(attempts);
  if (deps.now() < waitUntil) return record;
  return applyOutcome(record, await postRegistration(record, record.submit, deps), deps);
}

// refused -> submitted, once more with the same signatures.
export async function resubmit(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  if (record.stage !== 'refused' || !record.submit) return record;
  const again = await move(record, 'resubmit', deps);
  if (!again) return record;
  return applyOutcome(again, await postRegistration(again, record.submit as SubmitFacts, deps), deps);
}

// What is left on a payment address: the refund's plan when 1DEV, its token account or more SOL than a refund costs
// is left.
export function leftoverPlan(balance: PaymentBalance, destAccountExists: boolean): RefundPlan | null {
  const plan = { oneDevRaw: balance.oneDev, accountExists: balance.accountExists, lamports: balance.sol, destAccountExists };
  const worth = balance.oneDev > 0n || balance.accountExists || balance.sol > SIGNATURE_FEE_LAMPORTS;
  return worth ? plan : null;
}

// Whether the page may end an activation without sending what is left: nothing to send back to, and only test tokens.
const mayForgo = (record: PaymentRecord, dest: string | null): boolean => dest === null && record.network === 'testnet';

// An unrecorded mainnet activation with nothing on its address keeps its key until the user deletes it (`done`): a
// transfer from an exchange may still be on its way to it, and once the key is gone nobody could move it (SITE-1).
const keepsEmptyKey = (record: PaymentRecord): boolean => record.stage === 'closing' && record.network === 'mainnet';

// onChain -> leftovers when something is left to send back to the wallet (`dest`, or on mainnet the address the user
// gives), else done: the key is deleted and the receipt stays.
export async function finish(record: PaymentRecord, dest: string | null, deps: ActivationDeps): Promise<PaymentRecord> {
  if (record.stage !== 'onChain') return record;
  if (!mayForgo(record, dest)) {
    const balance = await readPayment(record.pub, deps);
    if (!balance) return record;
    if (leftoverPlan(balance, true)) return (await move(record, 'leftovers', deps)) ?? record;
  }
  return (await end(record, deps)) ?? record;
}

// The key's lifetime is over and nothing was burned: the activation ends from where it stands (flow.ts isExpired); one
// still waiting for QNet Wallet's confirmation is deleted. A dropped burn that landed after all is taken back instead,
// and while one is not proven never landed the key stays (SITE-R3-02).
export async function expire(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord | null> {
  if (!isExpired(record, deps.now())) return record;
  if (record.stage === 'walletConfirm') return dropUnconfirmed(record, deps);
  const found = await recheckDropped(record, deps);
  if (found.stage !== record.stage || (found.dropped ?? []).length > 0) return found;
  const ended = await move(found, 'expire', deps, {}, (current) => (current.dropped ?? []).length === 0);
  if (ended) await releaseReservation(found.reservation, deps);
  return ended ?? found;
}

// The user ends an activation before its burn (one still waiting for QNet Wallet's confirmation is deleted); a dropped
// burn that landed after all is taken back instead, and while one is not proven never landed nothing ends (the page
// says it is still checking).
export async function cancel(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord | null> {
  if (!mayCancel(record)) return record;
  if (record.stage === 'walletConfirm') return dropUnconfirmed(record, deps);
  const found = await recheckDropped(record, deps);
  if (found.stage !== record.stage || (found.dropped ?? []).length > 0) return found;
  const ended = await move(found, 'cancel', deps, {}, (current) => (current.dropped ?? []).length === 0);
  // The wallet is free again at once, for another browser or way too.
  if (ended) await releaseReservation(found.reservation, deps);
  return ended ?? found;
}

// After a final burn, the user sends what is left back now (flow.ts mayReturnLeftovers): what is left goes back to the
// wallet, then the key goes. The burn stays the wallet's activation in the server's record, and its registration is
// finished later in any browser where the wallet is connected: nothing is released.
export async function returnLeftovers(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord> {
  if (!mayReturnLeftovers(record)) return record;
  return (await move(record, 'returnLeftovers', deps)) ?? record;
}

// The end of a key: a recorded activation keeps only its receipt (done, flow.ts asReceipt); one that ended unrecorded is
// deleted (null).
async function end(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord | null> {
  if (record.stage === 'closing') {
    await removeRecord(record.pub, deps.area);
    return null;
  }
  const next = (await updateRecord(record.pub, (current) => (current.stage === record.stage ? asReceipt(current, deps.now()) : null), deps.area)) ?? record;
  await pruneReceipts(deps.area);
  return next;
}

// What is left stays where it is, or nothing is there: the key is deleted all the same, on the user's confirmation
// after the page named what is lost with it.
export async function done(record: PaymentRecord, deps: ActivationDeps): Promise<PaymentRecord | null> {
  return record.stage === 'leftovers' || record.stage === 'closing' ? end(record, deps) : record;
}

// `empty`: nothing is on the address, and the key stays until the user deletes it (keepsEmptyKey). `short`: 1DEV or
// the token account are left but the address lacks the SOL to send them back; `need` is what it lacks, in lamports
// (SITE-R2-02).
export type RefundResult = {
  outcome: 'sent' | 'unknown' | 'refused' | 'unavailable' | 'nothing' | 'empty' | 'final' | 'short';
  record: PaymentRecord | null;
  need?: bigint;
};

// leftovers, closing: what is left, to the wallet's Solana address `dest`. The key stays until the refund is final
// (settleLeftovers); a refund already on its way is not sent again.
export async function refund(record: PaymentRecord, dest: string, deps: ActivationDeps): Promise<RefundResult> {
  if ((record.stage !== 'leftovers' && record.stage !== 'closing') || record.refund) return { outcome: 'unavailable', record };
  const [mine, theirs, latest] = await Promise.all([readPayment(record.pub, deps), readPayment(dest, deps), getJson(deps, '/api/cabinet/blockhash')]);
  const b = latest?.status === 200 ? latest.body : null;
  if (!mine || !theirs || !isObject(b) || typeof b.blockhash !== 'string' || typeof b.lastValidBlockHeight !== 'number') return { outcome: 'unavailable', record };
  const found = leftoverPlan(mine, theirs.accountExists);
  // Test 1DEV the address cannot pay to move stay where they are; its SOL still goes back.
  const plan = found && !tokensMovable(found) && record.network === 'testnet' ? { ...found, oneDevRaw: 0n, accountExists: false } : found;
  if (!plan || (plan.oneDevRaw === 0n && !plan.accountExists && refundLamports(plan) === 0n)) {
    return keepsEmptyKey(record) ? { outcome: 'empty', record } : { outcome: 'nothing', record: await end(record, deps) };
  }
  // A refund that cannot pay for itself is never signed: Solana would refuse it at every try. The page shows the
  // payment address and the SOL it still needs instead.
  const need = refundShortfall(plan);
  if (need > 0n) return { outcome: 'short', record, need };
  let signed: SignedTx;
  try {
    signed = await signRefund(record, dest, plan, b.blockhash, deps.subtle);
  } catch {
    return { outcome: 'unavailable', record };
  }
  // Recorded before it is sent (its id is its signature), so a reload follows it instead of sending another.
  const facts = { dest, tx: signed.signature, lastValidBlockHeight: b.lastValidBlockHeight as number };
  const kept = await patch(record, { refund: facts }, deps);
  if (!kept) return { outcome: 'unavailable', record };
  const answer = await postJson(deps, '/api/cabinet/send', { tx: base64(signed.wire) });
  const state = answer?.status === 200 && isObject(answer.body) ? answer.body.state : null;
  if (state === 'refused' || answer?.status === 400) return { outcome: 'refused', record: (await patch(kept, { refund: null }, deps)) ?? kept };
  return { outcome: state === 'sent' ? 'sent' : 'unknown', record: await keepPass(kept, 'refund', passIn(answer?.body), deps) };
}

// A refund on its way: final ends the key; failed or never landed lets the next step send it again.
async function followRefund(record: PaymentRecord, deps: ActivationDeps): Promise<RefundResult> {
  const facts = record.refund as NonNullable<PaymentRecord['refund']>;
  const read = await readTx(facts.tx, facts.lastValidBlockHeight, deps, facts.pass ?? null);
  if (!read) return { outcome: 'unavailable', record };
  if (read.state === 'finalized') return { outcome: 'final', record: await end(record, deps) };
  if (read.state === 'failed' || read.state === 'expired') return { outcome: 'refused', record: (await patch(record, { refund: null }, deps)) ?? record };
  return { outcome: 'unknown', record };
}

// leftovers, closing, run by the page: a refund on its way is followed; nothing left ends the key (an unrecorded
// mainnet one waits for the user instead, keepsEmptyKey); a known wallet address gets what is left; with none, test
// tokens are forgone and on mainnet the page asks for the address.
export async function settleLeftovers(record: PaymentRecord, dest: string | null, deps: ActivationDeps): Promise<RefundResult> {
  if (record.stage !== 'leftovers' && record.stage !== 'closing') return { outcome: 'unavailable', record };
  if (record.refund) return followRefund(record, deps);
  if (dest !== null) return refund(record, dest, deps);
  if (mayForgo(record, dest)) return { outcome: 'nothing', record: await end(record, deps) };
  const balance = await readPayment(record.pub, deps);
  if (!balance) return { outcome: 'unavailable', record };
  if (leftoverPlan(balance, true)) return { outcome: 'unavailable', record };
  return keepsEmptyKey(record) ? { outcome: 'empty', record } : { outcome: 'nothing', record: await end(record, deps) };
}
