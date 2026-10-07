// The activation on aiqnet.io/node/activate (src/lib/cabinet/flow.ts, activation.ts, payment-store.ts,
// payment-key.ts; shared contracts C1 and C4): every stage move, QNet Wallet's signed reservation before the payment
// address shows, the request and the beneficiary rule (a check number only for a QR code when the page neither holds the
// wallet nor has its signed reservation), the burn only under that wallet's reservation and bound to its light node by
// the payment key's v2 owner bind before it is sent, the registration with the wallet's consent alone (from any
// browser), one step at a time across tabs, and the whole flow against the site's real routes with a fake Solana and
// fake genesis nodes, resumed from storage at every stage. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  DROPPED_KEPT, KEY_LIFETIME_MS, STAGES, TRANSITIONS, advance, beneficiaryConfirmed, confirmedWithoutCheck, consentFresh, isExpired, linkFacts,
  mayCancel, mayReturnLeftovers, receiptCode, refundDestination, withDropped,
} from '../cabinet/flow.ts';
import { checkRecord, listRecords, pruneReceipts, saveNew, updateRecord, RECEIPTS_KEPT } from '../cabinet/payment-store.ts';
import { createPaymentKey, signOwnerBindV2 } from '../cabinet/payment-key.ts';
import * as act from '../cabinet/activation.ts';
import { consentBodyOf, postConsent } from '../cabinet/consent-submit.ts';
import { activationCode, consentMessage, consentProof, encodeB64url, lightNodeId, walletHash } from '../qnet-link.ts';
import { OWNER_BIND_V2_FEATURE, RETRY_CODES, ownerBindMessageV2, submitOutcome } from '../cabinet/registration.ts';
import { verifyConsent } from '../cabinet/consent-verify.ts';
import { parseLegacyTransaction, signaturesValid } from '../solana-message.ts';
import { SIGNATURE_FEE_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS, classifyCabinetTx, refundShortfall } from '../cabinet/burn-tx.ts';
import { TX_CACHE_MS, createSolanaProxy } from '../../server/cabinet/solana-proxy.ts';
import { createRegister } from '../../server/cabinet/register.ts';
import { createNodeProxy } from '../../server/cabinet/node-proxy.ts';
import { createActivationRegistry, createMemoryStore } from '../../server/cabinet/activation-registry.ts';
import { createActivationApi } from '../../server/cabinet/activation-api.ts';
import { checkBurn } from '../../server/cabinet/burn-scan.ts';
import { OFFCHAIN_CONTEXT, SETTLE_AFTER_MS, burnRecordEnvelope, reservationMessage } from '../cabinet/burn-record.ts';
import { RpcError } from '../../server/solana-rpc.ts';
import { TEXTS } from '../texts.ts';

const V = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
const KAT = V.wallets.find((w) => w.name === 'kat-12');
const OTHER = V.wallets.find((w) => w.name === 'phrase-24');
const utf8 = (s) => new TextEncoder().encode(s);
const subtle = globalThis.crypto.subtle;

// Storage in memory with IndexedDB's one-step read and write.
function mapArea() {
  const m = new Map();
  return {
    m,
    all: async () => [...m.values()],
    update: async (pub, change) => {
      const next = change(m.get(pub));
      if (next === null) m.delete(pub);
      else if (next !== undefined) m.set(pub, next);
    },
  };
}

const base = (over = {}) => ({
  v: 1, pub: '9z1QsPH2k9xpYY9EQYh8EdPjhnt9CXnsxZZkYgT5Km96', key: null, network: 'testnet', createdAt: 1, updatedAt: 1, stage: 'funding',
  burn: null, link: null, answer: null, submit: null, refund: null, ...over,
});
const BURN = { tx: V.node[0].burnTx, lastValidBlockHeight: 500, amount: 1500 };

const { secretKey: KAT_SECRET, publicKey: KAT_PUB } = ml_dsa65.keygen(Uint8Array.from(Buffer.from(KAT.xi, 'hex')));
const { secretKey: OTHER_SECRET, publicKey: OTHER_PUB } = ml_dsa65.keygen(Uint8Array.from(Buffer.from(OTHER.xi, 'hex')));

// QNet Wallet's `reserve` `ok` answer: the wallet's signed reservation of a light node paid from `burner` at `ts`.
function reserveAnswer(burner, ts, wallet = KAT, secret = KAT_SECRET, pub = KAT_PUB) {
  const envelope = burnRecordEnvelope(reservationMessage(wallet.address, 'light', 'payment', burner, ts));
  return {
    v: 1, intent: 'reserve', status: 'ok', qnet: wallet.address, time: String(ts), pk: encodeB64url(pub),
    sig: encodeB64url(ml_dsa65.sign(envelope, secret, { context: utf8(OFFCHAIN_CONTEXT) })),
  };
}

// The record's hold as the page keeps it after a verified answer.
const holdOf = (burner, ts, wallet = KAT) => {
  const a = reserveAnswer(burner, ts, wallet, wallet === KAT ? KAT_SECRET : OTHER_SECRET, wallet === KAT ? KAT_PUB : OTHER_PUB);
  return { wallet: wallet.address, pk: a.pk, sig: a.sig, time: ts };
};

// QNet Wallet confirms the record's wallet (walletConfirm -> funding).
async function confirm(record, deps, ts = Math.floor(deps.now() / 1000)) {
  const got = await act.takeHold(record, reserveAnswer(record.pub, ts), act.reserveRequest(record), deps);
  assert.equal(got.outcome, 'confirmed');
  return got.record;
}

test('the stage machine: every move of the table and nothing else', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STAGES].sort());
  const events = new Set(Object.values(TRANSITIONS).flatMap((t) => Object.keys(t)));
  for (const stage of STAGES) {
    for (const event of events) {
      const next = advance(base({ stage }), event, 7);
      const want = TRANSITIONS[stage][event];
      assert.equal(next?.stage ?? null, want ?? null, `${stage} + ${event}`);
      if (next) assert.equal(next.updatedAt, 7);
    }
  }
  // QNet Wallet's confirmation comes first: nothing else moves a record out of walletConfirm (it is deleted instead).
  assert.equal(STAGES[0], 'walletConfirm');
  assert.deepEqual(TRANSITIONS.walletConfirm, { walletConfirmed: 'funding' });
  // The burn is written as sent before it is sent; a failed or expired burn goes back to funding, never forward.
  assert.equal(TRANSITIONS.funded.burnSigned, 'burnSent');
  assert.equal(TRANSITIONS.burnSent.burnExpired, 'funded');
  assert.equal(TRANSITIONS.burnFailed.retryBurn, 'funding');
  // Nothing moves out of done or closing; the user may end an activation only before a burn.
  assert.deepEqual(TRANSITIONS.done, {});
  assert.deepEqual(TRANSITIONS.closing, {});
  assert.deepEqual(STAGES.filter((s) => mayCancel({ stage: s })), ['walletConfirm', 'funding', 'funded', 'burnFailed']);
  // SITE-1: after 24 hours only an activation that burned nothing ends by itself (one still waiting for QNet Wallet is
  // deleted). A burn is the wallet's for good, so no stage with a burn has an expiry.
  assert.equal(KEY_LIFETIME_MS, 86_400_000);
  const expiring = STAGES.filter((s) => isExpired({ stage: s, createdAt: 0 }, KEY_LIFETIME_MS));
  assert.deepEqual(expiring, ['walletConfirm', 'funding', 'funded', 'burnFailed']);
  for (const s of expiring.slice(1)) assert.equal(TRANSITIONS[s].expire, 'closing', s);
  for (const s of STAGES.filter((x) => !expiring.includes(x) || x === 'walletConfirm')) assert.equal(TRANSITIONS[s].expire, undefined, s);
  assert.equal(isExpired({ stage: 'funded', createdAt: 0 }, KEY_LIFETIME_MS - 1), false);
  // A2: after a final burn the user may send what is left back at once, whatever the time: the burn stays the wallet's
  // activation, and nothing gives a burn up any more.
  const giving = ['burnFinal', 'mismatch', 'consentStale', 'nodeExists', 'refused', 'otherBurn'];
  assert.deepEqual(STAGES.filter((s) => mayReturnLeftovers({ stage: s })), giving);
  for (const s of giving) assert.equal(TRANSITIONS[s].returnLeftovers, 'closing', s);
  assert.ok(!events.has('abandon'));
  // A burn the page dropped as never landed is taken back only before another burn.
  assert.deepEqual(STAGES.filter((s) => TRANSITIONS[s].burnFound), ['funding', 'funded']);
  assert.equal(TRANSITIONS.funding.burnFound, 'burnFinal');
  // The network lists the node: this burn's registration, or another burn's; a node of either type stops it.
  assert.equal(TRANSITIONS.submitted.onChain, 'onChain');
  assert.equal(TRANSITIONS.submitted.otherBurn, 'otherBurn');
  assert.deepEqual(TRANSITIONS.otherBurn, { returnLeftovers: 'closing' });
  assert.deepEqual(TRANSITIONS.nodeExists, { returnLeftovers: 'closing' });
});

test('the request: the wallet by its hash; the check number only for a QR code when the page neither holds it nor has its reservation', () => {
  const r = base({ stage: 'burnFinal', burn: BURN });
  const kat = (source) => ({ qnet: KAT.address, source });
  assert.deepEqual(linkFacts(r, false, null), { qr: false, held: false, named: null, request: { burnTx: BURN.tx, walletHash: null, check: false } });
  assert.deepEqual(linkFacts(r, true, null), { qr: true, held: false, named: null, request: { burnTx: BURN.tx, walletHash: null, check: true } });
  for (const source of ['extension', 'entered', 'app']) {
    assert.deepEqual(linkFacts(r, true, kat(source)), { qr: true, held: true, named: KAT.address, request: { burnTx: BURN.tx, walletHash: KAT.walletHash, check: false } }, source);
  }
  // A wallet a QR `connect` answer named is named, but not held: the QR request still asks for the check number.
  assert.deepEqual(linkFacts(r, true, kat('app-qr')), { qr: true, held: false, named: KAT.address, request: { burnTx: BURN.tx, walletHash: KAT.walletHash, check: true } });
  assert.deepEqual(linkFacts(r, false, kat('app-qr')), { qr: false, held: false, named: KAT.address, request: { burnTx: BURN.tx, walletHash: KAT.walletHash, check: false } });
  // The wallet's signed reservation names it and stands for holding it: a QR request needs no check number, whatever the
  // page chose since, and names that wallet only.
  const held = { ...r, wallet: KAT.address, hold: holdOf(r.pub, 1_790_000_000) };
  assert.deepEqual(linkFacts(held, true, { qnet: OTHER.address, source: 'app-qr' }), { qr: true, held: true, named: KAT.address, request: { burnTx: BURN.tx, walletHash: KAT.walletHash, check: false } });
  assert.deepEqual(linkFacts(held, true, null).request, { burnTx: BURN.tx, walletHash: KAT.walletHash, check: false });
  assert.throws(() => linkFacts(base(), false, null), /no burn/);
});

test('the beneficiary rule; the code names the wallet that signed the reservation, from the burn on', () => {
  const answer = { qnet: KAT.address, nodeId: KAT.nodeId, consent: { ts: '1', pk: 'x', sig: 'y' }, bound: true, checkNumber: 482913, checkConfirmed: false };
  const withLink = (qr, held, check, over = {}) => ({ link: { qr, held, named: held ? KAT.address : null, request: { burnTx: BURN.tx, walletHash: held ? KAT.walletHash : null, check } }, answer: { ...answer, ...over } });
  assert.equal(confirmedWithoutCheck(withLink(false, false, false).link, KAT.address), true);
  assert.equal(confirmedWithoutCheck(withLink(true, true, false).link, KAT.address), true);
  assert.equal(confirmedWithoutCheck(withLink(true, false, true).link, KAT.address), false);
  assert.equal(beneficiaryConfirmed(withLink(true, false, true)), false);
  assert.equal(beneficiaryConfirmed(withLink(true, false, true, { checkConfirmed: true })), true);
  assert.equal(beneficiaryConfirmed({ link: null, answer }), false);
  assert.equal(consentFresh(1000, 1000 + 300, false), true);
  assert.equal(consentFresh(1000, 1000 + 301, false), false);
  assert.equal(consentFresh(1000, 1000 + 86_400, true), true);
  assert.equal(consentFresh(1000, 1000 + 86_401, true), false);
  assert.equal(consentFresh(1301, 1000, true), false, 'no more than five minutes ahead');
  // The code names the wallet the burn is for, never the payment address (owner rule, 26.09): the one that signed the
  // reservation, so it shows as soon as the burn is final, and stays while what is left goes back.
  const code = activationCode('light', KAT.address, BURN.tx, 1500);
  assert.equal(receiptCode({ burn: BURN, submit: null }), null, 'a record from before, bound to no wallet');
  assert.equal(receiptCode({ burn: BURN, submit: null, hold: holdOf('x', 1) }), code);
  assert.equal(receiptCode({ burn: BURN, submit: null, reservation: { id: 'a'.repeat(32), wallet: KAT.address, until: 1, amount: 1500 } }), code);
  assert.equal(receiptCode({ burn: BURN, submit: { qnet: KAT.address } }), code);
  assert.equal(receiptCode({ stage: 'closing', burn: BURN, submit: null, hold: holdOf('x', 1) }), code, 'the burn stays the wallet\'s');
  assert.equal(receiptCode({ stage: 'otherBurn', burn: BURN, submit: null, hold: holdOf('x', 1) }), null, 'a burn that registers no node');
});

test('what is left goes back to the wallet\'s own Solana address, never to one a QR answer or a typed address gave', () => {
  const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
  const r = base({ stage: 'leftovers', burn: BURN });
  const pinned = { ...r, wallet: KAT.address, hold: holdOf(r.pub, 1) };
  for (const source of ['extension', 'app']) {
    assert.equal(refundDestination(r, { qnet: KAT.address, source, solana: SOL }), SOL, source);
    assert.equal(refundDestination(pinned, { qnet: KAT.address, source, solana: SOL }), SOL, source);
  }
  assert.equal(refundDestination(r, { qnet: KAT.address, source: 'app-qr', solana: SOL }), null, 'a QR answer anyone could give');
  assert.equal(refundDestination(r, { qnet: KAT.address, source: 'entered' }), null, 'a typed QNet address names no Solana address');
  assert.equal(refundDestination(r, null), null);
  assert.equal(refundDestination(pinned, { qnet: OTHER.address, source: 'extension', solana: SOL }), null, 'another wallet than the burn\'s');
  assert.equal(refundDestination({ ...r, pub: SOL }, { qnet: KAT.address, source: 'extension', solana: SOL }), null, 'never the payment address itself');
});

test('the store: one record per address, moved in one step, receipts only without a key; blocked storage keeps nothing', async () => {
  const area = mapArea();
  assert.equal(await createPaymentKey({ area, now: 5 }), null, 'no wallet named');
  assert.equal(await createPaymentKey({ wallet: 'x', area, now: 5 }), null);
  const r = await createPaymentKey({ wallet: KAT.address, area, now: 5 });
  assert.ok(r);
  assert.equal(r.stage, 'walletConfirm', 'nothing shows the address before QNet Wallet confirms its wallet');
  assert.equal(r.wallet, KAT.address);
  assert.equal(r.hold, undefined);
  assert.equal(r.key.extractable, false);
  assert.equal(r.key.algorithm.name, 'Ed25519');
  assert.equal(r.key.type, 'private');
  assert.equal(bs58.decode(r.pub).length, 32);
  assert.deepEqual((await listRecords(area)).map((x) => x.pub), [r.pub]);
  assert.equal(await saveNew(r, area), false, 'an address is saved once');
  // Two tabs take the same step: the first wins, the second writes nothing.
  const step = (current) => (current.stage === 'walletConfirm' ? { ...current, stage: 'funding', hold: holdOf(r.pub, 5) } : null);
  const [a, b] = await Promise.all([updateRecord(r.pub, step, area), updateRecord(r.pub, step, area)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  // What the store refuses to read back.
  const f = { ...r, stage: 'funding', hold: holdOf(r.pub, 5) };
  assert.ok(checkRecord(f));
  assert.equal(checkRecord({ ...f, key: await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']).then((k) => k.privateKey) }), null, 'an extractable key');
  assert.equal(checkRecord({ ...f, stage: 'burnFinal' }), null, 'a burn stage without a burn');
  assert.equal(checkRecord({ ...f, key: null }), null, 'no key before done');
  assert.ok(checkRecord({ ...f, key: null, stage: 'done', burn: BURN }), 'a receipt');
  assert.equal(checkRecord({ ...f, stage: 'nope' }), null);
  // A record at walletConfirm names its wallet and holds nothing yet; a hold is its wallet's and of its form.
  assert.ok(checkRecord(r));
  assert.equal(checkRecord({ ...r, wallet: undefined }), null);
  assert.equal(checkRecord({ ...r, hold: holdOf(r.pub, 5) }), null, 'a hold is past walletConfirm');
  assert.equal(checkRecord({ ...r, burn: BURN }), null);
  assert.equal(checkRecord({ ...f, hold: holdOf(r.pub, 5, OTHER) }), null, 'another wallet\'s hold');
  assert.equal(checkRecord({ ...f, hold: { ...f.hold, pk: 'x' } }), null);
  assert.equal(checkRecord({ ...f, hold: { ...f.hold, time: '5' } }), null);
  assert.equal(checkRecord({ ...f, wallet: 'x' }), null);
  // Dropped burns (SITE-11): absent in a record from before, else well formed and bounded.
  assert.ok(checkRecord({ ...f, dropped: [BURN] }));
  assert.equal(checkRecord({ ...f, dropped: [{ ...BURN, tx: 'x' }] }), null);
  assert.equal(checkRecord({ ...f, dropped: BURN }), null);
  assert.equal(checkRecord({ ...f, dropped: Array.from({ length: DROPPED_KEPT + 1 }, () => BURN) }), null);
  assert.deepEqual(withDropped({}, BURN, 5), [{ ...BURN, droppedAt: 5 }]);
  // SITE-R3-01, SITE-R3-02: a read pass of its form, a drop time, and a receipt only in a finished activation.
  const PASS = 'A'.repeat(21) + '_';
  assert.ok(checkRecord({ ...f, stage: 'burnSent', burn: { ...BURN, pass: PASS } }));
  assert.equal(checkRecord({ ...f, stage: 'burnSent', burn: { ...BURN, pass: 'short' } }), null);
  assert.ok(checkRecord({ ...f, dropped: [{ ...BURN, pass: PASS, droppedAt: 7 }] }));
  assert.equal(checkRecord({ ...f, dropped: [{ ...BURN, droppedAt: -1 }] }), null);
  assert.equal(checkRecord({ ...f, stage: 'leftovers', burn: BURN, refund: { dest: r.pub, tx: BURN.tx, lastValidBlockHeight: 1, pass: 7 } }), null);
  // A submit names the wallet and its node; it carries no owner bind any more.
  const submit = { qnet: KAT.address, nodeId: KAT.nodeId, ts: 1, attempts: 0, txHash: null, admittedAt: null, lastCode: null };
  assert.ok(checkRecord({ ...f, stage: 'submitted', burn: BURN, submit }));
  assert.equal(checkRecord({ ...f, stage: 'submitted', burn: BURN, submit: { ...submit, nodeId: 1 } }), null);
  const receipt = { qnet: KAT.address, nodeId: KAT.nodeId };
  assert.ok(checkRecord({ ...f, key: null, stage: 'done', burn: BURN, receipt }));
  assert.equal(checkRecord({ ...f, key: null, stage: 'done', burn: BURN, receipt: { ...receipt, qnet: 'x' } }), null);
  assert.equal(checkRecord({ ...f, stage: 'funded', receipt }), null, 'a receipt only when done');
  assert.deepEqual(withDropped({ dropped: [BURN] }, BURN, 9), [BURN], 'once');
  assert.deepEqual(withDropped({ dropped: [BURN] }, null, 9), [BURN]);
  assert.deepEqual(withDropped({}, BURN, 9), [{ ...BURN, droppedAt: 9 }], 'with the time it was dropped');
  assert.equal(withDropped({ dropped: Array.from({ length: DROPPED_KEPT }, (_, i) => ({ ...BURN, tx: `${BURN.tx.slice(0, -1)}${i}` })) }, BURN, 9).length, DROPPED_KEPT);
  // Receipts beyond the kept number go, oldest first.
  const receipts = mapArea();
  for (let i = 0; i < RECEIPTS_KEPT + 3; i += 1) {
    const pub = bs58.encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 7 + j) % 256));
    receipts.m.set(pub, base({ pub, stage: 'done', burn: BURN, createdAt: i }));
  }
  await pruneReceipts(receipts);
  assert.equal(receipts.m.size, RECEIPTS_KEPT);
  assert.ok(![...receipts.m.values()].some((x) => x.createdAt < 3));
  const blocked = { all: async () => { throw new Error('x'); }, update: async () => { throw new Error('x'); } };
  assert.deepEqual(await listRecords(blocked), []);
  assert.equal(await createPaymentKey({ wallet: KAT.address, area: blocked }), null);
});

// ---------------------------------------------------------------- the whole flow against the site's routes

// QNet Wallet's `link` `ok` answer for a burn, signed with the KAT wallet's key.
function appAnswer(burnTx, ts, wallet = KAT, secret = KAT_SECRET, pub = KAT_PUB) {
  const nodeId = lightNodeId(wallet.address);
  const message = consentMessage(nodeId, wallet.address, consentProof(burnTx, nodeId, wallet.address), String(ts));
  return {
    v: 1, intent: 'link', status: 'ok', qnet: wallet.address, nodeId, bound: true,
    consent: { ts: String(ts), pk: encodeB64url(pub), sig: encodeB64url(ml_dsa65.sign(utf8(message), secret)) },
  };
}

function site({ now }) {
  // `archive`: the explorer's record of each wallet's registration, wallet -> the burn that registered it. `features`:
  // what both settling genesis nodes list; by default the network past its one-wallet-one-node gate (owner_bind_v2).
  const chain = { balances: new Map(), statuses: new Map(), registered: new Set(), pending: new Set(), archive: new Map(), sent: [], submitted: [], features: ['consent_24h', 'owner_bind_v2'], nodeAnswer: null };
  const rpc = async (method, params) => {
    if (method === 'getLatestBlockhash') return { value: { blockhash: bs58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 500 } };
    if (method === 'sendTransaction') {
      if (chain.refuseSend) throw new RpcError(-32002, 'simulation failed');
      chain.sent.push(params[0]);
      return 'ok';
    }
    if (method === 'getMultipleAccounts') {
      // [address, its 1DEV account] of each caller, as the site's batcher sends them together.
      chain.accountCalls = (chain.accountCalls ?? 0) + 1;
      const value = [];
      for (let i = 0; i < params[0].length; i += 2) {
        const owner = params[0][i];
        const b = chain.balances.get(owner) ?? { sol: 0, oneDev: null };
        const token = b.oneDev === null ? null : { data: { parsed: { info: { mint: '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ', owner, tokenAmount: { amount: String(b.oneDev) } } } } };
        value.push(b.sol ? { lamports: b.sol } : null, token);
      }
      return { value };
    }
    if (method === 'getSignatureStatuses') return { value: [chain.statuses.get(params[0][0]) ?? null] };
    if (method === 'getBlockHeight') return chain.height ?? 400;
    if (method === 'getTransaction') {
      const payer = chain.burner;
      return {
        meta: { err: null },
        transaction: { message: { accountKeys: [{ pubkey: payer }], instructions: [
          { program: 'spl-token', parsed: { type: 'burn', info: { mint: '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ', authority: payer, account: 'x', amount: '1500000000' } } },
          { program: 'spl-memo', parsed: 'QNET_NODE_TYPE:LIGHT' },
        ] } },
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  const options = { now, clientKey: () => ({ ok: true, ip: '203.0.113.1' }), devOrigins: false };
  // The site's activation registry in memory, over the fake Solana.
  const registry = createActivationRegistry({ store: createMemoryStore({ now }), now, check: (burnTx, expect) => checkBurn(rpc, burnTx, expect) });
  // `chain.walletNode`: the network's answer for a wallet, else from the table of registered and pending light nodes and
  // `chain.superOf` (wallet -> its super node's id).
  const nodeOf = (w) => {
    if (chain.walletNode !== undefined) return chain.walletNode;
    if (chain.superOf?.has(w)) return { state: 'registered', nodeId: chain.superOf.get(w), nodeType: 'super' };
    return chain.registered.has(lightNodeId(w)) || chain.pending.has(lightNodeId(w)) ? { state: 'registered', nodeId: lightNodeId(w), nodeType: 'light' } : { state: 'none' };
  };
  const activation = createActivationApi({
    ...options, registry, scope: `a${Math.random()}`,
    walletNode: async (w) => nodeOf(w),
    scan: async () => chain.scan ?? { complete: true, unusable: false, burns: [] },
  });
  chain.registry = registry;
  chain.activation = activation;
  // `chain.quote`: what the genesis nodes ask now (null: they cannot be read).
  const solana = createSolanaProxy({
    ...options, rpc, scope: `s${Math.random()}`, quote: async () => (chain.quote === undefined ? { phase: 1, cost: 1500 } : chain.quote), batchWindowMs: 0,
    announce: (reservation, burner, amount, burnTx, ownerSig) => activation.announcePayment(reservation, burner, amount, burnTx, ownerSig),
    knownPayer: (payer) => activation.knowsPaymentBurner(payer),
  });
  const register = createRegister({
    ...options, scope: `r${Math.random()}`, verifyConsent, nodes: ['https://node1.aiqnet.io'], paymentRecord: (w) => activation.paymentRecord(w),
    fetchFn: async (url, init) => {
      chain.submitted.push(JSON.parse(init.body));
      return new Response(JSON.stringify(chain.nodeAnswer ?? { success: true, tx_hash: 'ab'.repeat(32) }), { status: 200 });
    },
  });
  const status = (id) => ({
    registered: chain.registered.has(id), pending: !chain.registered.has(id) && chain.pending.has(id), deviceBound: chain.registered.has(id), answeredThisEpoch: false, needsReactivation: false,
    counted: { sinceRegistration: 0, counted: 0, lastCountedEpoch: null }, features: chain.features, balanceNano: null, device: null,
  });
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url, 'https://aiqnet.io');
    const req = new Request(u, { ...init, headers: { host: 'aiqnet.io', ...(init.headers ?? {}) } });
    const path = u.pathname;
    if (path === '/api/cabinet/price') return solana.price(req);
    if (path === '/api/cabinet/blockhash') return solana.blockhash(req);
    if (path === '/api/cabinet/send') return solana.send(req);
    if (path.startsWith('/api/cabinet/payment/')) return solana.payment(req, path.split('/').pop());
    if (path.startsWith('/api/cabinet/tx/')) {
      chain.txReads = [...(chain.txReads ?? []), { sig: path.split('/').pop(), pass: u.searchParams.get('pass') }];
      return solana.tx(req, path.split('/').pop(), u.searchParams.get('lvh'), u.searchParams.get('pass'));
    }
    if (path.startsWith('/api/cabinet/node/')) {
      // `chain.nodeProxy`: the site's own status route over fake genesis nodes, in place of the table.
      const id = path.split('/').pop();
      return chain.nodeProxy ? chain.nodeProxy.status(req, id) : reply(status(id));
    }
    if (path.startsWith('/api/cabinet/wallet-node/')) {
      if (chain.nodeProxy && chain.walletNode === undefined) {
        // Behind the fake genesis nodes: registered only when they list the light node at the network's height.
        const st = await (await chain.nodeProxy.status(new Request(u, { headers: { host: 'aiqnet.io' } }), lightNodeId(decodeURIComponent(path.split('/').pop())))).json();
        if (st.registered === undefined) return reply({ error: 'unavailable' }, 503);
        return reply(st.registered ? { state: 'registered', nodeId: lightNodeId(decodeURIComponent(path.split('/').pop())), nodeType: 'light' } : { state: 'none' });
      }
      const got = nodeOf(decodeURIComponent(path.split('/').pop()));
      return got === null ? reply({ error: 'unavailable' }, 503) : reply(got);
    }
    if (path.startsWith('/api/cabinet/registration/')) {
      const burnTx = chain.archive.get(decodeURIComponent(path.split('/').pop()));
      return reply(burnTx ? { found: true, record: { height: 7, burnTx, burner: chain.burner ?? V.burner.address, amount: 1500 }, burnBy: 'payment' } : { found: false });
    }
    if (path === '/api/cabinet/register') return register.submit(req);
    if (path === '/api/cabinet/activation/reserve') return activation.reserve(req);
    if (path === '/api/cabinet/activation/release') return activation.release(req);
    if (path.startsWith('/api/cabinet/activation/')) return activation.get(req, decodeURIComponent(path.split('/').pop()));
    throw new Error(`unexpected ${path}`);
  };
  return { chain, fetchFn };
}

// A payment address of its own site for the KAT wallet, confirmed by QNet Wallet and funded, at `t`.
async function fundedAt(now, network = 'testnet') {
  const area = mapArea();
  const s = site({ now });
  const deps = { fetchFn: s.fetchFn, area, subtle, now };
  const created = await createPaymentKey({ wallet: KAT.address, area, now: now() });
  // A devnet release makes testnet records only (SITE-R3-01); a mainnet release's record is written as one.
  if (network !== created.network) await updateRecord(created.pub, (c) => ({ ...c, network }), area);
  const stored = async () => (await listRecords(area))[0] ?? null;
  await confirm(await stored(), deps);
  s.chain.burner = created.pub;
  s.chain.balances.set(created.pub, { sol: 2_000_000, oneDev: 1_500_000_000 });
  await act.checkFunding(await stored(), 1500, deps);
  assert.equal((await stored()).stage, 'funded');
  return { ...s, deps, created, stored };
}

// The same, burned and final: the site's record holds the burn as the wallet's.
async function burnedAt(now, network = 'testnet') {
  const s = await fundedAt(now, network);
  const sent = await act.burn(await s.stored(), 1500, s.deps, KAT.address);
  assert.equal(sent.outcome, 'sent');
  s.chain.statuses.set(sent.record.burn.tx, { err: null, confirmationStatus: 'finalized' });
  const r = await act.settleBurn(await s.stored(), s.deps);
  assert.equal(r.stage, 'burnFinal');
  return s;
}
const burnOf = (chain) => classifyCabinetTx(parseLegacyTransaction(Uint8Array.from(Buffer.from(chain.sent.at(-1), 'base64'))));
const recordOf = async (s, wallet = KAT.address) => (await s.chain.activation.get(new Request(`https://aiqnet.io/api/cabinet/activation/${wallet}`, { headers: { host: 'aiqnet.io' } }), wallet)).json();

// A1 (owner, 29.09): the payment address exists for the wallet QNet Wallet confirms, and only its signed reservation
// holds the wallet at the site; a decline, an error, another wallet's answer or an expired request deletes the record,
// whose address was never shown.
test('QNet Wallet confirms the wallet first: its signed reservation is the hold; anything else deletes the record', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const area = mapArea();
  const deps = { fetchFn: async () => { throw new Error('no route'); }, area, subtle, now };
  const stored = async () => (await listRecords(area))[0] ?? null;
  const make = async () => createPaymentKey({ wallet: KAT.address, area, now: t });
  let r = await make();
  const request = act.reserveRequest(r);
  assert.deepEqual(request, { walletHash: KAT.walletHash, burner: r.pub });
  // The answer to another record's request, or another request than this record's: never taken; the record goes.
  const ts = Math.floor(t / 1000);
  assert.deepEqual(await act.takeHold(r, reserveAnswer(r.pub, ts), { ...request, burner: V.burner.address }, deps), { outcome: 'ended', record: null });
  assert.equal(await stored(), null);
  // Declined, an error, another wallet's answer: deleted, and the page says which.
  for (const [answer, outcome] of [
    [{ v: 1, intent: 'reserve', status: 'rejected' }, 'ended'],
    [{ v: 1, intent: 'reserve', status: 'error', error: 'NODE_OTHER' }, 'ended'],
    [reserveAnswer('x', ts, OTHER, OTHER_SECRET, OTHER_PUB), 'other_wallet'],
  ]) {
    r = await make();
    const got = await act.takeHold(r, answer, act.reserveRequest(r), deps);
    assert.deepEqual(got, { outcome, record: null }, JSON.stringify(answer).slice(0, 60));
    assert.equal(await stored(), null);
  }
  // The wallet's own answer: the hold, and the address shows (funding).
  r = await make();
  const answer = reserveAnswer(r.pub, ts);
  const got = await act.takeHold(r, answer, act.reserveRequest(r), deps);
  assert.equal(got.outcome, 'confirmed');
  assert.equal(got.record.stage, 'funding');
  assert.deepEqual(got.record.hold, { wallet: KAT.address, pk: answer.pk, sig: answer.sig, time: ts });
  assert.deepEqual(await stored(), got.record);
  // Later (the server found it too old), a new answer replaces the hold and the stage stays.
  t += 90_000_000;
  const again = reserveAnswer(r.pub, Math.floor(t / 1000));
  const renewed = await act.takeHold(await stored(), again, act.reserveRequest(r), deps);
  assert.equal(renewed.record.stage, 'funding');
  assert.equal(renewed.record.hold.time, Math.floor(t / 1000));
  // A declined request then changes nothing: the address and its hold stay.
  const kept = await act.takeHold(await stored(), { v: 1, intent: 'reserve', status: 'rejected' }, act.reserveRequest(r), deps);
  assert.equal(kept.outcome, 'ended');
  assert.equal(kept.record.stage, 'funding');
  assert.equal((await stored()).hold.time, Math.floor(t / 1000));
  await area.update(r.pub, () => null);
  // Cancelled, or 24 hours without an answer: deleted, nothing to send back.
  r = await make();
  assert.equal(await act.cancel(r, deps), null);
  assert.equal(await stored(), null);
  r = await make();
  assert.equal(await act.expire(r, deps), r, 'not before 24 hours');
  t += KEY_LIFETIME_MS;
  assert.equal(await act.expire(await stored(), deps), null);
  assert.equal(await stored(), null);
  assert.equal(await act.dropUnconfirmed(base({ stage: 'funding' }), deps).then((x) => x.stage), 'funding', 'only a record at walletConfirm');
});

test('flow: confirmed, funded, burned under the reservation with the v2 bind, its code at once, then the consent alone registers it', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const area = mapArea();
  const { chain, fetchFn } = site({ now });
  const deps = { fetchFn, area, subtle, now };
  // Every step starts from what storage holds, as a reloaded page does.
  const stored = async () => (await listRecords(area))[0];

  const created = await createPaymentKey({ wallet: KAT.address, area, now: t });
  let r = await confirm(await stored(), deps);
  assert.equal(r.stage, 'funding');
  chain.burner = created.pub;
  r = (await act.checkFunding(await stored(), 1500, deps)).record;
  assert.equal(r.stage, 'funding');
  chain.balances.set(created.pub, { sol: 2_000_000, oneDev: 1_500_000_000 });
  t += 5000;
  r = (await act.checkFunding(await stored(), 1500, deps)).record;
  assert.equal(r.stage, 'funded');

  // Two tabs press Burn: one burn is sent, the other tab is told the step is taken.
  const [x, y] = await Promise.all([act.burn(await stored(), 1500, deps, KAT.address), act.burn(await stored(), 1500, deps, KAT.address)]);
  assert.deepEqual([x.outcome, y.outcome].sort(), ['busy', 'sent']);
  assert.equal(chain.sent.length, 1);
  const tx = parseLegacyTransaction(Uint8Array.from(Buffer.from(chain.sent[0], 'base64')));
  assert.ok(signaturesValid(tx));
  assert.deepEqual(classifyCabinetTx(tx), { kind: 'burn', payer: created.pub, whole: 1500 });
  r = await stored();
  assert.equal(r.stage, 'burnSent');
  assert.equal(r.burn.tx, bs58.encode(tx.signatures[0]), 'recorded as sent under its id before it was sent');
  // The site took it with the wallet's signed reservation and the payment key's v2 bind of the wallet's light node.
  const row = await chain.registry.paymentRecord(KAT.address);
  assert.deepEqual([row.state, row.way, row.burner, row.burnTx], ['sending', 'payment', created.pub, r.burn.tx]);
  assert.deepEqual({ pk: row.proof.pk, sig: row.proof.sig, time: row.proof.time }, { pk: r.hold.pk, sig: r.hold.sig, time: r.hold.time });
  const bind = ownerBindMessageV2(KAT.nodeId, KAT.address, consentProof(r.burn.tx, KAT.nodeId, KAT.address), KAT_PUB, r.burn.tx);
  assert.equal(ed25519.verify(Uint8Array.from(Buffer.from(row.proof.ownerSig, 'hex')), utf8(bind), bs58.decode(created.pub)), true);
  assert.equal((await recordOf({ chain })).state, 'sending');

  // Not final yet, then past 90 s unknown, then final: the code shows at once, and the site's record is the wallet's.
  r = await act.settleBurn(r, deps);
  assert.equal(r.stage, 'burnSent');
  chain.statuses.set(r.burn.tx, { err: null, confirmationStatus: 'confirmed' });
  t += 91_000;
  r = await act.settleBurn(await stored(), deps);
  assert.equal(r.stage, 'burnUnknown');
  chain.statuses.set(r.burn.tx, { err: null, confirmationStatus: 'finalized' });
  t += 3000;
  r = await act.settleBurn(await stored(), deps);
  assert.equal(r.stage, 'burnFinal');
  const code = activationCode('light', KAT.address, r.burn.tx, 1500);
  assert.equal(receiptCode(r), code, 'the code names the wallet that signed the reservation');
  const view = await recordOf({ chain });
  assert.deepEqual([view.state, view.way, view.code], ['recorded', 'payment', code]);

  // The request names the wallet by its hash; its signed reservation stands for holding it, so a QR request from a
  // desktop needs no check number.
  r = await act.openLink(await stored(), true, null, deps);
  assert.deepEqual(r.link.request, { burnTx: r.burn.tx, walletHash: KAT.walletHash, check: false });
  const ts = Math.floor(t / 1000);
  r = await act.takeAnswer(await stored(), appAnswer(r.burn.tx, ts), 482913, r.link.request, deps);
  assert.equal(r.stage, 'consentVerified');
  r = await act.reviewConsent(await stored(), deps);
  assert.equal(r.stage, 'beneficiaryConfirmed');

  // Registered: the page posts the consent alone; the site completes it from its record, and one genesis node gets it.
  r = await act.register(await stored(), deps);
  assert.equal(r.stage, 'submitted');
  assert.equal(chain.submitted.length, 1);
  const body = chain.submitted[0];
  assert.equal(body.node_id, KAT.nodeId);
  assert.equal(body.burn_wallet, created.pub, 'the burner from the site\'s record');
  assert.equal(body.owner_signature, row.proof.ownerSig, 'the v2 bind from the site\'s record');
  assert.equal(body.burn_tx_hash, r.burn.tx);
  assert.equal(body.timestamp, ts);
  assert.equal(r.submit.txHash, 'ab'.repeat(32));
  assert.deepEqual(Object.keys(r.submit).sort(), ['admittedAt', 'attempts', 'lastCode', 'nodeId', 'qnet', 'ts', 'txHash']);

  // The chain lists the node with this burn: done, the key deleted, the receipt kept.
  r = await act.followRegistration(await stored(), deps);
  assert.equal(r.stage, 'submitted', 'waits for the chain');
  chain.registered.add(KAT.nodeId);
  r = await act.followRegistration(await stored(), deps);
  assert.equal(r.stage, 'submitted', 'SITE-10: listed, but the archive does not show whose burn yet');
  assert.ok(r.key);
  chain.archive.set(KAT.address, r.burn.tx);
  r = await act.followRegistration(await stored(), deps);
  assert.equal(r.stage, 'onChain');
  // Testnet, no Solana address of the wallet known: the test tokens left are not asked for.
  r = await act.finish(await stored(), null, deps);
  assert.equal(r.stage, 'done');
  assert.equal(r.key, null);
  assert.equal(receiptCode(await stored()), code);
});

// A2 (owner, 29.09): after the burn the payment key only sends back what is left; the registration is finished from any
// browser or device with a fresh consent from QNet Wallet, and the site completes it from its record.
test('what is left goes back at once; another browser, with no payment key, finishes the registration with the consent alone', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const DEST = V.burner.address;
  const s = await burnedAt(now);
  const burnTx = (await s.stored()).burn.tx;
  // "Send what is left back now": what is left goes to the wallet, the key goes; nothing is released at the site.
  let r = await act.returnLeftovers(await s.stored(), s.deps);
  assert.equal(r.stage, 'closing');
  assert.equal(receiptCode(r), activationCode('light', KAT.address, burnTx, 1500), 'the burn stays the wallet\'s');
  s.chain.balances.set(s.created.pub, { sol: 1_993_800, oneDev: 0 });
  const got = await act.settleLeftovers(r, DEST, s.deps);
  assert.equal(got.outcome, 'sent');
  s.chain.statuses.set((await s.stored()).refund.tx, { err: null, confirmationStatus: 'finalized' });
  t += 3000;
  assert.deepEqual(await act.settleLeftovers(await s.stored(), DEST, s.deps), { outcome: 'final', record: null });
  assert.equal(await s.stored(), null, 'this browser keeps nothing');
  t += 3 * 86_400_000;
  const view = await recordOf(s);
  assert.deepEqual([view.state, view.burnTx], ['recorded', burnTx], 'the site\'s record days later');
  // Another browser: QNet Wallet's fresh consent to this burn, posted as the consent body; nothing of the payment key.
  const ts = Math.floor(t / 1000);
  const consent = appAnswer(burnTx, ts).consent;
  const body = consentBodyOf(KAT.address, consent, burnTx, 1500);
  assert.equal('burn_wallet' in body || 'owner_signature' in body, false);
  const other = { fetchFn: s.fetchFn };
  assert.deepEqual(await postConsent(body, other), { result: 'admitted', txHash: 'ab'.repeat(32) });
  const sent = s.chain.submitted.at(-1);
  assert.equal(sent.burn_wallet, s.created.pub);
  assert.equal(sent.owner_signature, (await s.chain.registry.paymentRecord(KAT.address)).proof.ownerSig);
  // Another burn than the record's, or another amount: refused, nothing relayed.
  const before = s.chain.submitted.length;
  assert.deepEqual(await postConsent(consentBodyOf(KAT.address, appAnswer(BURN.tx, ts).consent, BURN.tx, 1500), other), { result: 'refused', code: 'other_burn' });
  assert.deepEqual(await postConsent(consentBodyOf(KAT.address, consent, burnTx, 1400), other), { result: 'refused', code: 'invalid_burn' });
  // A wallet with no payment burn at the site: no record.
  const otherConsent = appAnswer(burnTx, ts, OTHER, OTHER_SECRET, OTHER_PUB).consent;
  assert.deepEqual(await postConsent(consentBodyOf(OTHER.address, otherConsent, burnTx, 1500), other), { result: 'refused', code: 'no_record' });
  assert.equal(s.chain.submitted.length, before);
  // The network's one-node rule: refused for good.
  s.chain.nodeAnswer = { success: false, code: 'wallet_has_node', error: 'This wallet already has a node on the QNet network: one wallet, one node' };
  assert.deepEqual(await postConsent(body, other), { result: 'refused', code: 'wallet_has_node' });
});

test('flow A: the button on this device needs no check; the other paths keep the burn the wallet\'s', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  // A record from before the signed reservation (no wallet named): the check-number paths.
  const legacy = async () => {
    const area = mapArea();
    const s = site({ now });
    const deps = { fetchFn: s.fetchFn, area, subtle, now };
    const created = await createPaymentKey({ wallet: KAT.address, area, now: t });
    s.chain.burner = created.pub;
    await updateRecord(created.pub, (c) => ({ ...c, stage: 'burnFinal', wallet: undefined, burn: BURN }), area);
    const stored = async () => (await listRecords(area))[0];
    return { ...s, deps, stored };
  };

  // Same device, no wallet known: confirmed without asking.
  let s = await legacy();
  let r = await act.openLink(await s.stored(), false, null, s.deps);
  assert.equal(r.link.request.check, false);
  r = await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps);
  r = await act.reviewConsent(r, s.deps);
  assert.equal(r.stage, 'beneficiaryConfirmed');

  // A wallet chosen from the extension, shown as a QR: its hash names it, no check number.
  s = await legacy();
  r = await act.openLink(await s.stored(), true, { qnet: KAT.address, source: 'extension' }, s.deps);
  assert.deepEqual(r.link.request, { burnTx: r.burn.tx, walletHash: walletHash(KAT.address), check: false });
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps), s.deps);
  assert.equal(r.stage, 'beneficiaryConfirmed');

  // The numbers differ: stop, and a new request is opened for the same burn.
  s = await legacy();
  r = await act.openLink(await s.stored(), true, null, s.deps);
  r = await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps);
  r = await act.answerCheck(await act.reviewConsent(r, s.deps), false, s.deps);
  assert.equal(r.stage, 'mismatch');
  r = await act.relink(r, s.deps);
  assert.equal(r.stage, 'burnFinal');
  assert.equal(r.answer, null);

  // The wallet has a super node: one wallet, one node; nothing is submitted, and only what is left goes back.
  s = await burnedAt(now);
  s.chain.superOf = new Map([[KAT.address, 'super_node_0123456789abcdef']]);
  r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps), s.deps);
  assert.equal(r.stage, 'nodeExists');
  assert.equal(s.chain.submitted.length, 0);
  assert.equal(mayReturnLeftovers(r), true);
  assert.equal(TRANSITIONS.nodeExists.relink, undefined, 'no new request proposes another wallet');

  // The wallet's light node is on the chain with this burn (a submit that went through before): recorded.
  s = await burnedAt(now);
  s.chain.registered.add(KAT.nodeId);
  s.chain.archive.set(KAT.address, (await s.stored()).burn.tx);
  r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps), s.deps);
  assert.equal(r.stage, 'onChain');
  assert.equal(s.chain.submitted.length, 0);

  // Before the nodes accept day-old consents, one older than five minutes is stale.
  s = await burnedAt(now);
  s.chain.features = [];
  r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000) - 400), 1, r.link.request, s.deps), s.deps);
  assert.equal(r.stage, 'consentStale');

  // An answer that is no consent (declined, `linked`, an error) ends the request; the burn stays.
  s = await burnedAt(now);
  r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.takeAnswer(r, { v: 1, intent: 'link', status: 'linked', qnet: KAT.address, nodeId: KAT.nodeId, seq: '1' }, 1, r.link.request, s.deps);
  assert.equal(r.stage, 'burnFinal');

  // Refused by the network, submitted again with the same consent; on the chain already counts as done.
  s = await burnedAt(now);
  r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps), s.deps);
  s.chain.nodeAnswer = { success: false, code: 'bad_request', error: 'x' };
  r = await act.register(r, s.deps);
  assert.equal(r.stage, 'refused');
  assert.equal(r.submit.lastCode, 'bad_request');
  const first = s.chain.submitted[0];
  s.chain.nodeAnswer = { success: false, error: 'Node already registered' };
  s.chain.archive.set(KAT.address, r.burn.tx);
  r = await act.resubmit(r, s.deps);
  assert.equal(r.stage, 'onChain');
  assert.deepEqual(s.chain.submitted[1], first, 'the same body: the same consent and owner bind');

  // The network's one-node rule refuses it for good: the page says so, and offers no resubmit.
  s = await burnedAt(now);
  r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps), s.deps);
  s.chain.nodeAnswer = { success: false, code: 'wallet_has_node', error: 'This wallet already has a node on the QNet network: one wallet, one node' };
  r = await act.register(r, s.deps);
  assert.equal(r.stage, 'refused');
  assert.equal(r.submit.lastCode, 'wallet_has_node');

  // A retry waits, then goes again.
  s = await burnedAt(now);
  r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps), s.deps);
  s.chain.nodeAnswer = { success: false, error: 'burn-attestation quorum not yet reached; retry shortly' };
  r = await act.register(r, s.deps);
  assert.equal(r.stage, 'submitted');
  assert.equal(r.submit.lastCode, 'quorum_pending');
  r = await act.followRegistration(r, s.deps);
  assert.equal(s.chain.submitted.length, 1, 'not before the delay');
  t += act.retryDelayMs(1) + 1;
  s.chain.nodeAnswer = null;
  r = await act.followRegistration(await s.stored(), s.deps);
  assert.equal(s.chain.submitted.length, 2);
  assert.equal(r.submit.txHash, 'ab'.repeat(32));
});

// SITE-R1-04: for a QR request naming a held wallet, the check number was skipped on the 64-bit hash match alone. The
// answer's wallet must now be the named one by its full address, or nothing is submitted.
test('a named wallet is confirmed by its full address, never by the hash alone', async () => {
  const t = 1_790_000_000_000;
  const now = () => t;
  const answer = { qnet: KAT.address, nodeId: KAT.nodeId, consent: { ts: String(Math.floor(t / 1000)), pk: 'x', sig: 'y' }, bound: true, checkNumber: 1, checkConfirmed: false };
  const link = { qr: true, held: true, named: KAT.address, request: { burnTx: BURN.tx, walletHash: KAT.walletHash, check: false } };
  assert.equal(confirmedWithoutCheck(link, KAT.address), true);
  // Another wallet whose hash matched: not confirmed.
  assert.equal(confirmedWithoutCheck(link, OTHER.address), false);
  const colliding = base({ stage: 'beneficiaryConfirmed', key: {}, burn: BURN, link, answer: { ...answer, qnet: OTHER.address, nodeId: OTHER.nodeId } });
  assert.equal(beneficiaryConfirmed(colliding), false);
  // Nor with the check number: a request that named a wallet takes that wallet's answer only.
  const qrNamed = { ...link, held: false, request: { ...link.request, check: true } };
  assert.equal(beneficiaryConfirmed({ link: qrNamed, answer: { ...answer, qnet: OTHER.address, checkConfirmed: true } }), false);
  assert.equal(beneficiaryConfirmed({ link: qrNamed, answer: { ...answer, checkConfirmed: true } }), true);
  // A request kept from before, without the full address, is not confirmed by its hash either.
  const { named: _dropped, ...old } = link;
  assert.equal(confirmedWithoutCheck(old, KAT.address), false);
  // A request that named no wallet takes any wallet's answer.
  assert.equal(confirmedWithoutCheck({ qr: false, held: false, named: null, request: { burnTx: BURN.tx, walletHash: null, check: false } }, OTHER.address), true);

  // Through the steps: such an answer ends as a mismatch, nothing is submitted, and the burn stays the wallet's.
  const area = mapArea();
  const s = site({ now });
  const deps = { fetchFn: s.fetchFn, area, subtle, now };
  const created = await createPaymentKey({ wallet: KAT.address, area, now: t });
  await updateRecord(created.pub, (c) => ({ ...c, stage: 'consentVerified', burn: BURN, hold: holdOf(c.pub, 1), link, answer: { ...answer, qnet: OTHER.address, nodeId: OTHER.nodeId } }), area);
  let r = (await listRecords(area))[0];
  r = await act.reviewConsent(r, deps);
  assert.equal(r.stage, 'mismatch');
  assert.equal(r.submit, null);
  assert.equal(s.chain.submitted.length, 0);
  r = await act.relink(r, deps);
  assert.equal(r.stage, 'burnFinal');
  r = await act.openLink(r, true, { qnet: OTHER.address, source: 'extension' }, deps);
  assert.equal(r.link.named, KAT.address, 'the new request names the burn\'s wallet only');
});

// SITE-R1-05: a wallet whose light node is being recorded: the page waits and submits nothing; once the network lists
// the node, the archive says whose burn registered it.
test('a node being recorded: the page waits and submits nothing; listed with this burn, it is recorded', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await burnedAt(now);
  s.chain.pending.add(KAT.nodeId);
  assert.equal(await act.walletHasNode(KAT.address, s.deps), true);
  let r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps);
  r = await act.reviewConsent(r, s.deps);
  assert.equal(r.stage, 'consentVerified', 'waits');
  assert.equal(s.chain.submitted.length, 0);
  // Confirmed while nothing was pending, then a registration starts before the submit: nothing is submitted.
  s.chain.pending.clear();
  r = await act.reviewConsent(r, s.deps);
  assert.equal(r.stage, 'beneficiaryConfirmed');
  s.chain.pending.add(KAT.nodeId);
  r = await act.register(r, s.deps);
  assert.equal(r.stage, 'beneficiaryConfirmed');
  assert.equal(s.chain.submitted.length, 0);
  // Listed now, with this burn.
  s.chain.pending.clear();
  s.chain.registered.add(KAT.nodeId);
  s.chain.archive.set(KAT.address, r.burn.tx);
  r = await act.register(r, s.deps);
  assert.equal(r.stage, 'onChain');
  assert.equal(s.chain.submitted.length, 0);
});

// SITE-R4-01, through the steps: the wallet has a light node, and the only genesis nodes the cabinet reaches are behind
// the network (`authoritative: false`) and answer "not registered". Nothing is known until nodes at the network's
// height answer: the page submits nothing meanwhile, then sees the node.
test('genesis nodes behind the network never clear a wallet: nothing is submitted until nodes at its height answer', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await burnedAt(now);
  // The genesis nodes behind the site's status route: host -> the public status it answers, absent while unreachable.
  const genesis = new Map();
  const publicStatus = (listed, authoritative) => ({
    onchain_registered: listed, registration_pending: false, device_bound: listed, answered_this_epoch: false, needs_reactivation: false,
    counted: { epochs_since_registration: 0, counted: 0, last_counted_epoch: null }, features: ['consent_24h'], authoritative,
  });
  s.chain.nodeProxy = createNodeProxy({
    now, random: () => 0.999, clientKey: () => ({ ok: true, ip: '203.0.113.1' }), devOrigins: false, scope: `n${Math.random()}`,
    nodes: [1, 2, 3, 4].map((n) => `https://node${n}.aiqnet.io`),
    fetchFn: async (url) => {
      const u = new URL(url);
      const answer = genesis.get(u.host);
      if (answer === undefined) throw new TypeError('unreachable');
      return u.pathname === '/api/v1/light-node/status' ? new Response(JSON.stringify(answer), { status: 200 }) : new Response('{}', { status: 404 });
    },
  });
  genesis.set('node1.aiqnet.io', publicStatus(false, false));
  genesis.set('node2.aiqnet.io', publicStatus(false, false));
  assert.equal(await act.walletHasNode(KAT.address, s.deps), null, 'not known, never "no node"');
  let r = await act.openLink(await s.stored(), true, null, s.deps);
  r = await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 482913, r.link.request, s.deps);
  r = await act.reviewConsent(r, s.deps);
  assert.equal(r.stage, 'consentVerified', 'waits: the nodes behind settle nothing');
  assert.equal(s.chain.submitted.length, 0);

  // Nodes at the network's height answer: the wallet's node is on the chain (this burn's, per the archive).
  genesis.set('node3.aiqnet.io', publicStatus(true, true));
  genesis.set('node4.aiqnet.io', publicStatus(true, true));
  assert.equal(await act.walletHasNode(KAT.address, s.deps), true);
  s.chain.archive.set(KAT.address, r.burn.tx);
  r = await act.reviewConsent(await s.stored(), s.deps);
  assert.equal(r.stage, 'onChain');
  assert.equal(s.chain.submitted.length, 0);
});

// SITE-R1-06: the page asks the browser to keep its storage at the key, the burn and its finality, and never waits for
// the answer; its text says a browser may delete a site's data after a week unvisited.
test('the page asks the browser to keep its storage at the key, the burn and its finality, and never waits for it', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const area = mapArea();
  const s = site({ now });
  const asked = [];
  // A browser that asks the user first: the answer never comes while the flow goes on.
  const persist = () => { asked.push(t); return new Promise(() => {}); };
  const deps = { fetchFn: s.fetchFn, area, subtle, now, persist };
  const created = await createPaymentKey({ wallet: KAT.address, area, now: t, persist });
  assert.ok(created, 'created without waiting for the answer');
  assert.equal(asked.length, 1);
  const stored = async () => (await listRecords(area))[0];
  await confirm(created, deps);
  s.chain.burner = created.pub;
  s.chain.balances.set(created.pub, { sol: 2_000_000, oneDev: 1_500_000_000 });
  await act.checkFunding(await stored(), 1500, deps);
  t += 1000;
  const burned = await act.burn(await stored(), 1500, deps, KAT.address);
  assert.equal(burned.outcome, 'sent');
  await Promise.resolve();
  assert.equal(asked.length, 2, 'asked again once the burn is recorded as sent');
  s.chain.statuses.set(burned.record.burn.tx, { err: null, confirmationStatus: 'finalized' });
  const final = await act.settleBurn(await stored(), deps);
  assert.equal(final.stage, 'burnFinal');
  await Promise.resolve();
  assert.equal(asked.length, 3);
  // A request that throws, or a browser without it, changes nothing.
  assert.ok(await createPaymentKey({ wallet: KAT.address, area, now: t, persist: () => { throw new Error('blocked'); } }));
  const { requestPersistence } = await import('../cabinet/payment-store.ts');
  assert.equal(await requestPersistence(undefined), false);
  assert.equal(await requestPersistence({}), false);
  assert.equal(await requestPersistence({ persist: async () => { throw new Error('x'); } }), false);
  assert.equal(await requestPersistence({ persist: async () => true }), true);
  assert.equal(act.browserDeps().persist, requestPersistence);
  // The page says what the browser may do with its data.
  assert.match(TEXTS.act_keep_browser, /A browser may delete this site's data after about a week without a visit, and what is left would then stay on the address: finish soon\.$/);
});

test('a burn that never landed goes back to funded; a refused send too; a failed burn waits for a new try', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await fundedAt(now);
  const { deps, stored } = s;
  // Solana refuses the burn before it is forwarded: back to funded, nothing burned.
  s.chain.refuseSend = true;
  const refused = await act.burn(await stored(), 1500, deps, KAT.address);
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.record.stage, 'funded');
  assert.equal(refused.record.burn, null);
  s.chain.refuseSend = false;
  // A layer in front of the endpoint may have forwarded it all the same: nothing new is signed until it is proven never
  // landed (SITE-R3-02), past its last valid block and DROP_SETTLE_MS after it was dropped.
  assert.equal((await act.burn(await stored(), 1500, deps, KAT.address)).outcome, 'checking');
  assert.equal(s.chain.sent.length, 0);
  s.chain.height = 501;
  assert.equal((await act.burn(await stored(), 1500, deps, KAT.address)).outcome, 'checking', 'expired, but read too soon after the drop');
  t += act.DROP_SETTLE_MS;
  s.chain.height = 400;
  assert.equal((await act.burn(await stored(), 1500, deps, KAT.address)).outcome, 'checking', 'not past its last valid block');
  s.chain.height = 501;
  t += 3000;
  // Proven here, but the site's registry still holds the wallet for the burn it announced until it can no longer land
  // (SETTLE_AFTER_MS after the announce): the old reservation no longer signs, and a new one is refused meanwhile.
  const lost = await act.burn(await stored(), 1500, deps, KAT.address);
  assert.equal(lost.outcome, 'reservation');
  assert.deepEqual(lost.record.dropped, [], 'forgotten once proven');
  assert.equal(lost.record.reservation, undefined);
  assert.equal((await act.burn(await stored(), 1500, deps, KAT.address)).outcome, 'reserved');
  assert.equal(s.chain.sent.length, 0);
  t += SETTLE_AFTER_MS;
  let r = (await act.burn(await stored(), 1500, deps, KAT.address)).record;
  assert.equal(r.stage, 'burnSent');
  assert.equal(s.chain.sent.length, 1);
  s.chain.height = 400;
  // Solana never saw it and its blockhash expired (the fake chain is at height 400; the burn's lvh is 500).
  await updateRecord(r.pub, (c) => ({ ...c, burn: { ...c.burn, lastValidBlockHeight: 300 } }), deps.area);
  r = await act.settleBurn(await stored(), deps);
  assert.equal(r.stage, 'funded');
  assert.equal(r.burn, null);
  assert.equal(r.dropped.length, 1, 'kept aside for a second look (SITE-11)');
  assert.equal((await act.burn(await stored(), 1500, deps, KAT.address)).outcome, 'checking');
  t += SETTLE_AFTER_MS;
  r = (await act.burn(await stored(), 1500, deps, KAT.address)).record;
  assert.equal(r.stage, 'burnSent');
  s.chain.statuses.set(r.burn.tx, { err: { InstructionError: [2, 'x'] }, confirmationStatus: 'confirmed' });
  // The same key, blockhash and amount sign the same burn again: its status read a moment ago is kept TX_CACHE_MS.
  t += TX_CACHE_MS;
  r = await act.settleBurn(await stored(), deps);
  assert.equal(r.stage, 'burnFailed');
  r = await act.retryBurn(r, deps);
  assert.equal(r.stage, 'funding');
  // Cancelled before a burn: on testnet with no wallet address known the test tokens are not asked for.
  r = await act.cancel(r, deps);
  assert.equal(r.stage, 'closing');
  assert.deepEqual(await act.settleLeftovers(r, null, deps), { outcome: 'nothing', record: null });
  assert.deepEqual(await listRecords(deps.area), []);
});

// SITE-R2-04: a JSON-RPC error means the endpoint did not take the burn, but a layer in front of it may have forwarded
// it. It is kept aside like a burn that expired unseen, and taken back if it lands, instead of being forgotten while the
// page offers the burn again.
test('a burn refused with a JSON-RPC error is kept aside and taken back when it lands after all', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await fundedAt(now);
  s.chain.refuseSend = true;
  const refused = await act.burn(await s.stored(), 1500, s.deps, KAT.address);
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.record.stage, 'funded');
  assert.equal(refused.record.burn, null);
  assert.equal(refused.record.dropped.length, 1);
  const tx = refused.record.dropped[0].tx;
  assert.deepEqual(refused.record.dropped[0], { tx, lastValidBlockHeight: 500, amount: 1500, droppedAt: t });
  // It landed all the same: the 1DEV is gone and the burn is final and this address's.
  s.chain.balances.set(s.created.pub, { sol: 1_990_000, oneDev: 0 });
  s.chain.statuses.set(tx, { err: null, confirmationStatus: 'finalized' });
  t += 6000;
  const r = (await act.checkFunding(await s.stored(), 1500, s.deps)).record;
  assert.equal(r.stage, 'burnFinal');
  assert.equal(r.burn.tx, tx);
  // The site's own check (400) forwarded nothing: nothing is kept aside for it.
  const own = await fundedAt(now);
  const deps400 = { ...own.deps, fetchFn: async (url, init) => (url === '/api/cabinet/send' ? new Response('{"error":"invalid_request"}', { status: 400 }) : own.fetchFn(url, init)) };
  const rejected = await act.burn(await own.stored(), 1500, deps400, KAT.address);
  assert.equal(rejected.outcome, 'refused');
  assert.equal(rejected.record.stage, 'funded');
  assert.equal((rejected.record.dropped ?? []).length, 0);
});

// SITE-R2-05: the price is read again just before the burn signs; the page burns only what the network asks now.
test('the burn reads the price again and signs nothing when the network asks another amount', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await fundedAt(now);
  // The price stepped down while the tab stood open (past the site's 15 s cache of it).
  s.chain.quote = { phase: 1, cost: 1350 };
  t += 15_000;
  const changed = await act.burn(await s.stored(), 1500, s.deps, KAT.address);
  assert.equal(changed.outcome, 'price_changed');
  assert.deepEqual(changed.quote, { phase: 1, cost: 1350 });
  assert.equal(changed.record.stage, 'funded');
  assert.equal(s.chain.sent.length, 0, 'nothing signed or sent');
  // At the amount the network asks it burns that, the rest going back later as leftovers.
  const burned = await act.burn(await s.stored(), 1350, s.deps, KAT.address);
  assert.equal(burned.outcome, 'sent');
  assert.deepEqual(burnOf(s.chain), { kind: 'burn', payer: s.created.pub, whole: 1350 });
  // Phase 2 has no burn; an unreadable price burns nothing either.
  const p2 = await fundedAt(now);
  p2.chain.quote = { phase: 2 };
  assert.equal((await act.burn(await p2.stored(), 1500, p2.deps, KAT.address)).outcome, 'price_changed');
  const none = await fundedAt(now);
  none.chain.quote = null;
  assert.equal((await act.burn(await none.stored(), 1500, none.deps, KAT.address)).outcome, 'price_unavailable');
  assert.equal(p2.chain.sent.length + none.chain.sent.length, 0);
  // The page shows the new amount before the user burns again, and reads the price whenever it is shown again.
  const page = readFileSync(new URL('../../components/cabinet/NodeActivate.tsx', import.meta.url), 'utf8');
  assert.match(page, /if \(result\.outcome === 'price_changed' && quote\) setSetup\(\(s\) => \(s\.phase === 'ready' \? \{ \.\.\.s, quote \} : s\)\);/);
  assert.match(page, /void act\.readPrice\(deps\)\.then\(\(quote\) => \{\s*if \(quote\) setSetup\(\(s\) => \(s\.phase === 'ready' && !sameQuote\(s\.quote, quote\) \? \{ \.\.\.s, quote \} : s\)\);/);
  assert.equal(TEXTS.act_price_changed, 'The network now asks another amount for an activation. Nothing was burned: check the new amount, then press Burn again.');
});

// SITE-R2-10 and A1: the burn is for the wallet that signed the reservation, only while it is the connected one, and
// only while the site finds no node, no burn and no check that did not answer for it.
test('no burn for another wallet than the one that signed, for a wallet with a node, or without a signed reservation', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await fundedAt(now);
  s.chain.registered.add(KAT.nodeId);
  assert.equal(await act.walletHasNode(KAT.address, s.deps), true);
  assert.equal(await act.walletHasNode(OTHER.address, s.deps), false);
  const refused = await act.burn(await s.stored(), 1500, s.deps, KAT.address);
  assert.equal(refused.outcome, 'has_node');
  assert.equal(refused.record.stage, 'funded');
  assert.equal(s.chain.sent.length, 0);
  // Another connected wallet than the one that signed, or none: nothing (A1).
  assert.equal((await act.burn(await s.stored(), 1500, s.deps, OTHER.address)).outcome, 'no_wallet');
  assert.equal((await act.burn(await s.stored(), 1500, s.deps, null)).outcome, 'no_wallet');
  // A super node of the wallet counts too (one wallet, one node).
  const sup = await fundedAt(now);
  sup.chain.superOf = new Map([[KAT.address, 'super_node_0123456789abcdef']]);
  assert.equal((await act.burn(await sup.stored(), 1500, sup.deps, KAT.address)).outcome, 'has_node');
  // A funded record from before, with no signed reservation: QNet Wallet is asked first.
  const old = await fundedAt(now);
  await updateRecord(old.created.pub, (c) => ({ ...c, hold: undefined }), old.deps.area);
  assert.equal((await act.burn(await old.stored(), 1500, old.deps, KAT.address)).outcome, 'reconfirm');
  // A network that cannot say whether the wallet has a node: nothing is burned (no fail-open any more).
  const blind = await fundedAt(now);
  blind.chain.walletNode = null;
  assert.equal((await act.burn(await blind.stored(), 1500, blind.deps, KAT.address)).outcome, 'check_unavailable');
  // The wallet has its burn already (the site's record, or a burn found on its Solana address): nothing more.
  const found = await fundedAt(now);
  found.chain.scan = { complete: true, unusable: false, burns: [{ burnTx: BURN.tx, nodeType: 'super', burnAmount: 1500 }] };
  assert.equal((await act.burn(await found.stored(), 1500, found.deps, KAT.address, V.burner.address)).outcome, 'has_burn');
  assert.equal(blind.chain.sent.length + found.chain.sent.length + old.chain.sent.length + sup.chain.sent.length, 0);
  // The signed reservation too old for the server (a day and more): QNet Wallet is asked again, the address stays, and
  // the new hold burns.
  const late = await fundedAt(now);
  t += 87_001_000;
  const stale = await act.burn(await late.stored(), 1500, late.deps, KAT.address);
  assert.equal(stale.outcome, 'reconfirm');
  assert.equal(stale.record.stage, 'funded');
  assert.equal(late.chain.sent.length, 0);
  const renewed = await act.takeHold(await late.stored(), reserveAnswer(late.created.pub, Math.floor(t / 1000)), act.reserveRequest(late.created), late.deps);
  assert.equal(renewed.outcome, 'confirmed');
  assert.equal((await act.burn(await late.stored(), 1500, late.deps, KAT.address)).outcome, 'sent');
  // The page burns for the chosen wallet, with its Solana address for the server's search, only while every source of
  // it says none, and makes an address for it only then.
  const page = readFileSync(new URL('../../components/cabinet/NodeActivate.tsx', import.meta.url), 'utf8');
  assert.match(page, /if \(price === null \|\| !mayBurn \|\| choice === null\) return undefined;(?:\s*\/\/[^\n]*)*\s*const result = await act\.burn\(r, price, deps, choice\.qnet, choice\.solana \?\? null\);/);
  assert.match(page, /if \(!offer\) return;\s*setWorking\(true\);(?:\s*\/\/[^\n]*)*\s*const open = await act\.paymentOpen\(choice\.qnet, deps\);\s*if \(open !== true\) \{\s*setWorking\(false\);\s*setNotice\(open === null \? 'act_check_unavailable' : 'act_payment_not_open'\);\s*return;\s*\}\s*const created = await createPaymentKey\(\{ wallet: choice\.qnet \}\);/);
  assert.match(page, /has_node: 'act_wallet_has_node',/);
  assert.match(page, /reconfirm: 'act_reconfirm',/);
  assert.match(TEXTS.act_wallet_has_node, /^The chosen wallet already has a node, or one being recorded\. One wallet, one node of either type/);
});

// H-4 (06.10): the payment key signs only the owner bind v2, which the nodes take from the one-wallet-one-node gate on;
// before, a burn would end in a refused registration. No address is made and no burn signed until both settling genesis
// nodes list `owner_bind_v2`; a node that answers `bind_v2_pending` is a calm retry, never a refusal.
test('payment activation opens only once both settling genesis nodes list owner_bind_v2; bind_v2_pending is a retry', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await fundedAt(now);
  assert.equal(OWNER_BIND_V2_FEATURE, 'owner_bind_v2');
  assert.equal(await act.paymentOpen(KAT.address, s.deps), true);
  // Before the gate the nodes do not list it: nothing is reserved, signed or sent, the record stays funded.
  s.chain.features = ['consent_24h', 'bind_v2'];
  assert.equal(await act.paymentOpen(KAT.address, s.deps), false);
  const closed = await act.burn(await s.stored(), 1500, s.deps, KAT.address);
  assert.equal(closed.outcome, 'not_open');
  assert.equal(closed.record.stage, 'funded');
  assert.equal(closed.record.reservation, undefined, 'no reservation was taken');
  assert.equal(s.chain.sent.length, 0);
  assert.equal((await recordOf(s)).state, 'none', 'the server holds nothing for the wallet');
  // The nodes cannot be read: nothing either.
  const blind = await fundedAt(now);
  const fetchFn = blind.deps.fetchFn;
  const deps = { ...blind.deps, fetchFn: (url, init) => (String(url).startsWith('/api/cabinet/node/') ? Promise.resolve(new Response('{}', { status: 503 })) : fetchFn(url, init)) };
  assert.equal(await act.paymentOpen(KAT.address, deps), null);
  assert.equal((await act.burn(await blind.stored(), 1500, deps, KAT.address)).outcome, 'check_unavailable');
  assert.equal(blind.chain.sent.length, 0);
  // Once listed, the same record burns.
  s.chain.features = ['consent_24h', 'owner_bind_v2'];
  assert.equal((await act.burn(await s.stored(), 1500, s.deps, KAT.address)).outcome, 'sent');
  // The node's answer before the gate is a retry with a calm note, never the terminal refusal.
  assert.ok(RETRY_CODES.includes('bind_v2_pending'));
  assert.deepEqual(submitOutcome(200, { success: false, code: 'bind_v2_pending', error: 'owner bind v2 not active yet' }), { result: 'retry', code: 'bind_v2_pending' });
  assert.deepEqual(submitOutcome(200, { success: false, code: 'bad_request' }), { result: 'refused', code: 'bad_request' });
  // A node's text alone reads the same: the submit door's and the attestor's (development/qnet-integration).
  const REPO = new URL('../../../../../../', import.meta.url);
  const door = readFileSync(new URL('development/qnet-integration/src/rpc/registration_door.rs', REPO), 'utf8').replace(/\s+/g, ' ');
  const doorText = /SubmitRefusal::new\(BindV2Pending, "bind_v2_pending", "([^"]+)"\)/.exec(door)?.[1];
  assert.ok(doorText, "the door's bind_v2_pending text");
  const attestor = /message: "(bind_v2_pending:[^"]+)"/.exec(readFileSync(new URL('development/qnet-integration/src/rpc/mod.rs', REPO), 'utf8'))?.[1];
  assert.ok(attestor, "the attestor's bind_v2_pending text");
  for (const error of [doorText, attestor]) assert.deepEqual(submitOutcome(200, { success: false, error }), { result: 'retry', code: 'bind_v2_pending' }, error);
  assert.doesNotMatch(TEXTS.act_bind_v2_pending, /did not accept|refused|try again/i);
  assert.match(TEXTS.act_payment_not_open, /not open yet/);
  const page = readFileSync(new URL('../../components/cabinet/NodeActivate.tsx', import.meta.url), 'utf8');
  assert.match(page, /not_open: 'act_payment_not_open',/);
  assert.match(page, /const paymentClosed = lightStatus\.state\.phase === 'ok' && !lightStatus\.state\.value\.features\.includes\(OWNER_BIND_V2_FEATURE\);/);
  assert.match(page, /\) : paymentClosed \? \(\s*<p className="activate-status">\{t\('act_payment_not_open'\)\}<\/p>\s*\) : \(/);
  assert.match(page, /disabled=\{working \|\| paymentClosed\}>\{t\('act_burn'\)\}/);
  assert.match(page, /\{stage === 'submitted' && record\.submit\?\.lastCode === 'bind_v2_pending' && <p className="activate-note">\{t\('act_bind_v2_pending'\)\}<\/p>\}/);
  const finish = readFileSync(new URL('../../components/cabinet/NextSteps.tsx', import.meta.url), 'utf8');
  assert.match(finish, /if \(outcome\.code === 'bind_v2_pending'\) return null;/);
  assert.match(finish, /\{outcome\?\.result === 'retry' && outcome\.code === 'bind_v2_pending' && <p className="activate-note">\{t\('act_bind_v2_pending'\)\}<\/p>\}/);
});

// SITE-R2-02: a refund that cannot pay for itself is never signed (Solana would refuse it at every try); the page learns
// what the payment address lacks, shows the address and that amount, and offers no "Leave it" while 1DEV would stay.
test('what is left that cannot pay for its own refund: nothing is signed, the page learns the SOL it lacks', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const DEST = V.burner.address;
  const closing = async (network, balance) => {
    const s = await fundedAt(now, network);
    const r = await act.cancel(await s.stored(), s.deps);
    assert.equal(r.stage, 'closing');
    s.chain.balances.set(s.created.pub, balance);
    t += 5000;
    return s;
  };
  // (a) The wallet has a 1DEV account; the payment address has no SOL for the fee.
  let s = await closing('mainnet', { sol: 0, oneDev: 1_500_000_000 });
  s.chain.balances.set(DEST, { sol: 1, oneDev: 0 });
  let got = await act.settleLeftovers(await s.stored(), DEST, s.deps);
  assert.equal(got.outcome, 'short');
  assert.equal(got.need, 5_000n);
  assert.equal(s.chain.sent.length, 0);
  assert.ok((await s.stored()).key, 'the key stays');
  assert.equal((await s.stored()).refund, null);
  // (b) The wallet has no 1DEV account: the refund also pays its rent.
  s = await closing('mainnet', { sol: 1_000_000, oneDev: 1_500_000_000 });
  got = await act.refund(await s.stored(), DEST, s.deps);
  assert.equal(got.outcome, 'short');
  assert.equal(got.need, 5_000n + 2_039_280n - 1_000_000n);
  assert.equal(s.chain.sent.length, 0);
  // The SOL arrives: the refund goes, 1DEV, the account's rent and all.
  s.chain.balances.set(s.created.pub, { sol: 2_044_280, oneDev: 1_500_000_000 });
  t += 5000;
  got = await act.settleLeftovers(await s.stored(), DEST, s.deps);
  assert.equal(got.outcome, 'sent');
  assert.deepEqual(burnOf(s.chain), { kind: 'refund', payer: s.created.pub, dest: DEST, oneDevRaw: 1_500_000_000n, lamports: 0n });
  // An empty token account alone still needs the fee to be closed.
  s = await closing('mainnet', { sol: 0, oneDev: 0 });
  got = await act.settleLeftovers(await s.stored(), DEST, s.deps);
  assert.deepEqual([got.outcome, got.need], ['short', 5_000n]);
  // Testnet: test 1DEV the address cannot pay to move stay where they are, as before.
  s = await closing('testnet', { sol: 0, oneDev: 1_500_000_000 });
  s.chain.balances.set(DEST, { sol: 1, oneDev: 0 });
  assert.deepEqual(await act.settleLeftovers(await s.stored(), DEST, s.deps), { outcome: 'nothing', record: null });
  // The shortfall itself.
  const plan = (over) => ({ oneDevRaw: 1n, accountExists: true, lamports: 0n, destAccountExists: true, ...over });
  assert.equal(refundShortfall(plan()), SIGNATURE_FEE_LAMPORTS);
  assert.equal(refundShortfall(plan({ destAccountExists: false })), SIGNATURE_FEE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS);
  assert.equal(refundShortfall(plan({ lamports: SIGNATURE_FEE_LAMPORTS })), 0n);
  assert.equal(refundShortfall(plan({ oneDevRaw: 0n, accountExists: false })), 0n, 'SOL alone: refundLamports decides');
  assert.equal(refundShortfall(plan({ oneDevRaw: 0n, destAccountExists: false })), SIGNATURE_FEE_LAMPORTS, 'closing creates nothing');
  // The page: the address, its QR code and what it lacks; no "Leave it" while 1DEV would stay behind; a typed
  // address short of SOL is sent to by itself once the SOL arrives.
  const steps = readFileSync(new URL('../../components/cabinet/ActivateSteps.tsx', import.meta.url), 'utf8');
  assert.match(steps, /<p className="activate-error">\{t\(ACTIVATION_NETWORK === 'testnet' \? 'act_refund_short_testnet' : 'act_refund_short', \{ sol: formatUnits\(short, SOL_DECIMALS\) \}\)\}<\/p>\s*<QrCode text=\{pub\} label=\{t\('act_address_qr'\)\} \/>/);
  // Test SOL comes from the faucet or the user's wallet, never "from any wallet or exchange" (XC-10).
  assert.doesNotMatch(TEXTS.act_refund_short_testnet, /exchange/);
  assert.match(TEXTS.act_refund_short_testnet, /Send \{sol\} test SOL more to it from your wallet \(the Testnet page's faucet gives test SOL\)/);
  assert.match(steps, /const mayLeave = !\(lacking && \(balance === null \|\| balance\.oneDev > 0n\)\);\s*if \(leaving && mayLeave\) \{/);
  assert.match(steps, /\{mayLeave && <button type="button" className="activate-link-button" onClick=\{\(\) => setLeaving\(true\)\} disabled=\{busy\}>\{t\('act_refund_leave'\)\}<\/button>\}/);
  const page = readFileSync(new URL('../../components/cabinet/NodeActivate.tsx', import.meta.url), 'utf8');
  assert.match(page, /const to = dest \?\? typedDest\.current;\s*const got = await act\.settleLeftovers\(r, to, deps\);/);
  assert.match(page, /if \(result\.outcome !== 'unavailable'\) typedDest\.current = result\.outcome === 'short' \? to : null;/);
  assert.match(page, /short=\{short\?\.need \?\? null\}/);
  assert.match(TEXTS.act_refund_short, /Send \{sol\} SOL more to it/);
});

test('the key lives 24 hours before a burn; after it, only until what is left has gone back, at once when the user asks', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const DEST = V.burner.address;
  const setup = async (network, over) => {
    const area = mapArea();
    const s = site({ now });
    const deps = { fetchFn: s.fetchFn, area, subtle, now };
    const created = await createPaymentKey({ wallet: KAT.address, area, now: t });
    await updateRecord(created.pub, (c) => ({ ...c, network, hold: holdOf(c.pub, Math.floor(t / 1000)), ...over }), area);
    s.chain.balances.set(created.pub, { sol: 1_993_800, oneDev: 0 });
    const stored = async () => (await listRecords(area))[0] ?? null;
    return { ...s, deps, stored, created };
  };
  const lastRefund = (chain) => classifyCabinetTx(parseLegacyTransaction(Uint8Array.from(Buffer.from(chain.sent.at(-1), 'base64'))));
  // The refund on its way lands: the next step ends the key.
  const land = async (s) => {
    s.chain.statuses.set((await s.stored()).refund.tx, { err: null, confirmationStatus: 'finalized' });
    t += 3000;
    return act.settleLeftovers(await s.stored(), DEST, s.deps);
  };

  // SITE-1: a burn never ends by the clock. Every stage after it keeps its key past 24 hours.
  for (const stage of ['burnFinal', 'linkOpen', 'consentVerified', 'mismatch', 'consentStale', 'nodeExists', 'beneficiaryConfirmed', 'refused']) {
    const k = await setup('testnet', { stage, burn: BURN });
    t += KEY_LIFETIME_MS + 1;
    const kept = await act.expire(await k.stored(), k.deps);
    assert.equal(kept.stage, stage, stage);
    assert.ok(kept.key, stage);
  }
  // After a burn the user sends what is left back at once (no clock, no warning of a lost burn): it goes to the wallet's
  // Solana address, and the record goes once final.
  let s = await setup('testnet', { stage: 'burnFinal', burn: BURN });
  let r = await act.returnLeftovers(await s.stored(), s.deps);
  assert.equal(r.stage, 'closing');
  assert.deepEqual(r.burn, BURN, 'the burn stays in view while what is left goes back');
  let got = await act.settleLeftovers(r, DEST, s.deps);
  assert.equal(got.outcome, 'sent');
  assert.equal(got.record.refund.dest, DEST);
  assert.ok(got.record.key, 'the key stays until the refund is final');
  assert.deepEqual(lastRefund(s.chain), { kind: 'refund', payer: s.created.pub, dest: DEST, oneDevRaw: 0n, lamports: 1_993_800n - 5_000n });
  // Not final yet: nothing is sent again.
  assert.equal((await act.settleLeftovers(await s.stored(), DEST, s.deps)).outcome, 'unknown');
  assert.equal(s.chain.sent.length, 1);
  assert.deepEqual(await land(s), { outcome: 'final', record: null });
  assert.equal(await s.stored(), null);
  // Not while a registration is on its way.
  for (const stage of ['linkOpen', 'consentVerified', 'beneficiaryConfirmed', 'submitted', 'onChain']) {
    const k = await setup('testnet', { stage, burn: BURN });
    assert.equal((await act.returnLeftovers(await k.stored(), k.deps)).stage, stage, stage);
  }
  // A refund that never landed is sent again.
  s = await setup('testnet', { stage: 'funding' });
  t += KEY_LIFETIME_MS;
  r = (await act.settleLeftovers(await act.expire(await s.stored(), s.deps), DEST, s.deps)).record;
  await updateRecord(r.pub, (c) => ({ ...c, refund: { ...c.refund, lastValidBlockHeight: 300 } }), s.deps.area);
  assert.equal((await act.settleLeftovers(await s.stored(), DEST, s.deps)).outcome, 'refused');
  assert.equal((await s.stored()).refund, null);
  assert.equal((await act.settleLeftovers(await s.stored(), DEST, s.deps)).outcome, 'sent');
  assert.equal(s.chain.sent.length, 2);

  // A burn in flight is settled first; a day-old funded address sends its 1DEV back too.
  s = await setup('testnet', { stage: 'burnSent', burn: BURN });
  t += KEY_LIFETIME_MS;
  assert.equal((await act.expire(await s.stored(), s.deps)).stage, 'burnSent');
  s = await setup('testnet', { stage: 'funded' });
  s.chain.balances.set(s.created.pub, { sol: 2_000_000, oneDev: 1_500_000_000 });
  s.chain.balances.set(DEST, { sol: 1, oneDev: 0 });
  t += KEY_LIFETIME_MS;
  got = await act.settleLeftovers(await act.expire(await s.stored(), s.deps), DEST, s.deps);
  assert.equal(got.outcome, 'sent');
  assert.deepEqual(lastRefund(s.chain), { kind: 'refund', payer: s.created.pub, dest: DEST, oneDevRaw: 1_500_000_000n, lamports: 1_995_000n });
  // The wallet has no 1DEV account and the address cannot pay its rent: test 1DEV stay, the SOL goes back.
  s = await setup('testnet', { stage: 'funded' });
  s.chain.balances.set(s.created.pub, { sol: 2_000_000, oneDev: 1_500_000_000 });
  got = await act.settleLeftovers(await act.cancel(await s.stored(), s.deps), DEST, s.deps);
  assert.equal(got.outcome, 'sent');
  assert.deepEqual(lastRefund(s.chain), { kind: 'refund', payer: s.created.pub, dest: DEST, oneDevRaw: 0n, lamports: 1_995_000n });

  // Mainnet, the wallet's Solana address not known: the page asks; the address the user gives gets it.
  s = await setup('mainnet', { stage: 'nodeExists', burn: BURN });
  r = await act.returnLeftovers(await s.stored(), s.deps);
  got = await act.settleLeftovers(r, null, s.deps);
  assert.equal(got.outcome, 'unavailable');
  assert.equal((await s.stored()).stage, 'closing', 'kept until the user gives the address');
  got = await act.refund(await s.stored(), DEST, s.deps);
  assert.equal(got.outcome, 'sent');
  // The page follows the refund the user sent, without the address again.
  s.chain.statuses.set((await s.stored()).refund.tx, { err: null, confirmationStatus: 'finalized' });
  assert.equal((await act.settleLeftovers(await s.stored(), null, s.deps)).outcome, 'final');
  assert.equal(await s.stored(), null);

  // Recorded: what is left goes back, the key is deleted, the receipt keeps the wallet's code.
  const submit = { qnet: KAT.address, nodeId: KAT.nodeId, ts: 1, attempts: 1, txHash: null, admittedAt: null, lastCode: null };
  s = await setup('testnet', { stage: 'onChain', burn: BURN, submit });
  r = await act.finish(await s.stored(), DEST, s.deps);
  assert.equal(r.stage, 'leftovers');
  got = await act.settleLeftovers(r, DEST, s.deps);
  assert.equal(got.outcome, 'sent');
  got = await land(s);
  assert.equal(got.outcome, 'final');
  assert.equal(got.record.stage, 'done');
  assert.equal(got.record.key, null);
  assert.equal(got.record.refund, null, 'the receipt keeps no refund (SITE-R3-03)');
  assert.deepEqual(got.record.receipt, { qnet: KAT.address, nodeId: KAT.nodeId });
  assert.equal(receiptCode(await s.stored()), activationCode('light', KAT.address, BURN.tx, 1500));
  // "Leave it", confirmed: the key goes all the same.
  s = await setup('mainnet', { stage: 'leftovers', burn: BURN, submit });
  r = await act.done(await s.stored(), s.deps);
  assert.equal(r.stage, 'done');
  assert.equal(r.key, null);

  // SITE-1: a mainnet address with nothing on it at 24 hours keeps its key: an exchange's transfer may still be on
  // its way. It goes back once it lands; only the user deletes the key of an empty address.
  s = await setup('mainnet', { stage: 'funding' });
  s.chain.balances.set(s.created.pub, { sol: 0, oneDev: null });
  t += KEY_LIFETIME_MS;
  r = await act.expire(await s.stored(), s.deps);
  assert.equal(r.stage, 'closing');
  assert.deepEqual(await act.settleLeftovers(r, null, s.deps), { outcome: 'empty', record: r });
  assert.deepEqual(await act.settleLeftovers(await s.stored(), DEST, s.deps), { outcome: 'empty', record: r });
  assert.ok((await s.stored()).key, 'kept');
  s.chain.balances.set(s.created.pub, { sol: 2_000_000, oneDev: null });
  t += 5000;
  got = await act.settleLeftovers(await s.stored(), DEST, s.deps);
  assert.equal(got.outcome, 'sent', 'the late transfer goes back to the wallet');
  s = await setup('mainnet', { stage: 'funding' });
  s.chain.balances.set(s.created.pub, { sol: 0, oneDev: null });
  t += KEY_LIFETIME_MS;
  r = await act.expire(await s.stored(), s.deps);
  assert.equal((await act.settleLeftovers(r, null, s.deps)).outcome, 'empty');
  assert.equal(await act.done(await s.stored(), s.deps), null, 'the user deletes it');
  assert.equal(await s.stored(), null);
  // On testnet an empty address ends with its test tokens' activation, as before.
  s = await setup('testnet', { stage: 'funding' });
  s.chain.balances.set(s.created.pub, { sol: 0, oneDev: null });
  t += KEY_LIFETIME_MS;
  assert.deepEqual(await act.settleLeftovers(await act.expire(await s.stored(), s.deps), DEST, s.deps), { outcome: 'nothing', record: null });

  // SITE-3: the page asks before "Leave it" or "Delete the payment address" deletes a key, naming what is lost; sending
  // what is left back after a burn loses nothing and says so.
  const steps = readFileSync(new URL('../../components/cabinet/ActivateSteps.tsx', import.meta.url), 'utf8');
  assert.match(steps, /const warning = empty \|\| !amounts \? t\('act_closing_delete_warn'\) : t\('act_refund_leave_warn', amounts\);\s*return <ConfirmLoss warning=\{warning\} confirm=\{t\('act_delete_key'\)\} busy=\{busy\} onConfirm=\{onLeave\} onBack=\{\(\) => setLeaving\(false\)\} \/>;/);
  assert.equal(steps.match(/onClick=\{onLeave\}/g), null, 'no button deletes the key at once');
  assert.equal((steps.match(/onClick=\{\(\) => setLeaving\(true\)\}/g) ?? []).length, 2);
  assert.match(steps, /<p className="activate-note">\{t\('act_leftovers_now_note'\)\}<\/p>\s*<button type="button" className="qnet-button secondary" onClick=\{onSend\} disabled=\{busy\}>\{t\('act_leftovers_now'\)\}<\/button>/);
  assert.doesNotMatch(steps, /act_abandon/);
  assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, 'act_abandon_warn'), false);
  assert.match(TEXTS.act_leftovers_now_note, /^The burn stays this wallet's activation: finish the registration later in any browser where this wallet is connected\./);
  assert.match(TEXTS.act_refund_leave_warn, /\{oneDev\} 1DEV and \{sol\} SOL stay on the payment address for good/);
  assert.doesNotMatch(TEXTS.act_leftovers, /go back/, 'no promise the page does not keep');
});

test('SITE-10: a node the network lists with another burn is not this burn\'s registration; only what is left goes back', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await burnedAt(now);
  let r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps), s.deps);
  assert.equal(r.stage, 'beneficiaryConfirmed');
  // Another burn registered the wallet first (before the network's one-node rule): the nodes answer "already
  // registered" for this submit, and the archive names that burn.
  s.chain.nodeAnswer = { success: false, code: 'already_registered', error: 'x' };
  const other = V.node[1]?.burnTx ?? `${BURN.tx.slice(0, -2)}11`;
  assert.notEqual(other, r.burn.tx);
  s.chain.archive.set(KAT.address, other);
  r = await act.register(r, s.deps);
  assert.equal(r.stage, 'otherBurn');
  assert.ok(r.key, 'the key is not deleted before what is left goes back');
  assert.equal(receiptCode(r), null, 'no code for a burn the chain never used');
  assert.equal(mayReturnLeftovers(r), true);
  // A listing the archive does not show yet waits; one this page's submit was admitted for counts after a while.
  const w = await burnedAt(now);
  let q = await act.openLink(await w.stored(), false, null, w.deps);
  q = await act.register(await act.reviewConsent(await act.takeAnswer(q, appAnswer(q.burn.tx, Math.floor(t / 1000)), 1, q.link.request, w.deps), w.deps), w.deps);
  assert.equal(q.stage, 'submitted');
  assert.equal(q.submit.admittedAt, t);
  w.chain.registered.add(KAT.nodeId);
  q = await act.followRegistration(q, w.deps);
  assert.equal(q.stage, 'submitted');
  t += act.ARCHIVE_WAIT_MS;
  q = await act.followRegistration(await w.stored(), w.deps);
  assert.equal(q.stage, 'onChain');
});

test('SITE-11: a burn dropped as never landed is looked at again and taken back when it landed after all', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await fundedAt(now);
  const { deps, stored, created } = s;
  let r = (await act.burn(await stored(), 1500, deps, KAT.address)).record;
  const tx = r.burn.tx;
  // Two reads past its last valid block found nothing (a lagging backend): dropped, back to funded, kept aside.
  await updateRecord(r.pub, (c) => ({ ...c, burn: { ...c.burn, lastValidBlockHeight: 300 } }), deps.area);
  r = await act.settleBurn(await stored(), deps);
  assert.equal(r.stage, 'funded');
  assert.equal(r.burn, null);
  assert.deepEqual(r.dropped.map((b) => b.tx), [tx]);
  // The 1DEV is still there: it is looked at (SITE-R3-02) and kept, not yet proven never landed.
  r = (await act.checkFunding(await stored(), 1500, deps)).record;
  assert.equal(r.stage, 'funded');
  // It landed after all: the 1DEV is gone, and the burn is final and this address's.
  s.chain.balances.set(created.pub, { sol: 1_990_000, oneDev: 0 });
  s.chain.statuses.set(tx, { err: null, confirmationStatus: 'finalized' });
  t += 6000;
  r = (await act.checkFunding(await stored(), 1500, deps)).record;
  assert.equal(r.stage, 'burnFinal');
  assert.equal(r.burn.tx, tx);
  assert.deepEqual(r.dropped, []);
  // The same at the 24-hour end: the burn is taken back instead of the activation ending.
  const e = site({ now });
  const earea = mapArea();
  const edeps = { fetchFn: e.fetchFn, area: earea, subtle, now };
  const ekey = await createPaymentKey({ wallet: KAT.address, area: earea, now: t });
  e.chain.burner = ekey.pub;
  await updateRecord(ekey.pub, (c) => ({ ...c, stage: 'funding', hold: holdOf(c.pub, 1), dropped: [{ ...BURN, tx }] }), earea);
  e.chain.statuses.set(tx, { err: null, confirmationStatus: 'finalized' });
  t += KEY_LIFETIME_MS;
  assert.equal((await act.expire((await listRecords(earea))[0], edeps)).stage, 'burnFinal');
  // A dropped burn that failed is forgotten.
  const f = site({ now });
  const farea = mapArea();
  const fdeps = { fetchFn: f.fetchFn, area: farea, subtle, now };
  const fkey = await createPaymentKey({ wallet: KAT.address, area: farea, now: t });
  await updateRecord(fkey.pub, (c) => ({ ...c, stage: 'funding', hold: holdOf(c.pub, 1), dropped: [{ ...BURN, tx }] }), farea);
  f.chain.statuses.set(tx, { err: { InstructionError: [0, 'x'] }, confirmationStatus: 'confirmed' });
  f.chain.balances.set(fkey.pub, { sol: 2_000_000, oneDev: 0 });
  assert.deepEqual((await act.checkFunding((await listRecords(farea))[0], 1500, fdeps)).record.dropped, []);
});

// SITE-R3-02: an answer to another activation's request is never taken into this record; and the payment key's owner
// bind names only the wallet that signed the reservation, for the burn about to be sent.
test('an answer to another activation\'s request is never taken; the v2 bind only for the reserved wallet\'s own burn', async () => {
  const t = 1_790_000_000_000;
  const now = () => t;
  const area = mapArea();
  const s = site({ now });
  const deps = { fetchFn: s.fetchFn, area, subtle, now };
  const BURN_A = BURN;
  const BURN_B = { tx: bs58.encode(new Uint8Array(64).fill(9)), lastValidBlockHeight: 500, amount: 1500 };
  const a = await createPaymentKey({ wallet: KAT.address, area, now: t });
  const b = await createPaymentKey({ wallet: KAT.address, area, now: t + 1 });
  await updateRecord(a.pub, (c) => ({ ...c, stage: 'burnFinal', hold: holdOf(c.pub, 1), burn: BURN_A }), area);
  await updateRecord(b.pub, (c) => ({ ...c, stage: 'burnFinal', hold: holdOf(c.pub, 1), burn: BURN_B }), area);
  const get = async (pub) => (await listRecords(area)).find((x) => x.pub === pub);
  const ra = await act.openLink(await get(a.pub), false, null, deps);
  let rb = await act.openLink(await get(b.pub), false, null, deps);
  const answerA = appAnswer(BURN_A.tx, Math.floor(t / 1000));

  // The session another tab opened for A, with QNet Wallet's consent to burn A, reaches the page that follows B.
  assert.equal(act.isRecordRequest(rb, ra.link.request), false);
  rb = await act.takeAnswer(rb, answerA, 1, ra.link.request, deps);
  assert.equal(rb.stage, 'burnFinal', 'B\'s own request is gone: the page opens a new one');
  assert.equal(rb.answer, null);
  assert.equal(rb.submit, null);
  // A takes its own answer.
  assert.equal((await act.takeAnswer(ra, answerA, 1, ra.link.request, deps)).stage, 'consentVerified');
  // A request that differs in any field, a claim request or none is another request.
  for (const over of [{ burnTx: BURN_B.tx }, { walletHash: OTHER.walletHash }, { check: true }]) {
    assert.equal(act.isRecordRequest(ra, { ...ra.link.request, ...over }), false, JSON.stringify(over));
  }
  assert.equal(act.isRecordRequest(ra, { walletHash: null }), false);
  assert.equal(act.isRecordRequest(ra, null), false);
  // The same goes for QNet Wallet's confirmation: another record's reserve request is never taken.
  const c = await createPaymentKey({ wallet: KAT.address, area, now: t + 2 });
  assert.deepEqual(await act.takeHold(c, reserveAnswer(a.pub, Math.floor(t / 1000)), act.reserveRequest(a), deps), { outcome: 'ended', record: null });

  // The v2 bind: only a funded record about to send its burn, under the reservation of the wallet that signed the hold.
  const held = { id: 'a'.repeat(32), wallet: KAT.address, until: t + 600_000, amount: 1500 };
  const funded = { ...(await get(a.pub)), stage: 'funded', burn: BURN_A, reservation: held };
  const sig = await signOwnerBindV2(funded, subtle);
  const message = ownerBindMessageV2(KAT.nodeId, KAT.address, consentProof(BURN_A.tx, KAT.nodeId, KAT.address), KAT_PUB, BURN_A.tx);
  assert.equal(ed25519.verify(Uint8Array.from(Buffer.from(sig, 'hex')), utf8(message), bs58.decode(a.pub)), true);
  await assert.rejects(signOwnerBindV2({ ...funded, stage: 'burnFinal' }, subtle), /reservation/, 'not after the burn left');
  await assert.rejects(signOwnerBindV2({ ...funded, burn: null }, subtle), /reservation/);
  await assert.rejects(signOwnerBindV2({ ...funded, reservation: undefined }, subtle), /reservation/);
  await assert.rejects(signOwnerBindV2({ ...funded, reservation: { ...held, wallet: OTHER.address } }, subtle), /reservation/, 'another wallet\'s reservation');
  await assert.rejects(signOwnerBindV2({ ...funded, hold: { ...funded.hold, pk: encodeB64url(OTHER_PUB) } }, subtle), /hold/, 'a key that is not the wallet\'s');

  // The page keeps each activation's requests under slots of its own, and the link session a request from one slot
  // never outlives a change of slot: it is let go of, still kept for its own activation.
  const page = readFileSync(new URL('../../components/cabinet/NodeActivate.tsx', import.meta.url), 'utf8');
  assert.match(page, /useLinkSession\(\{ slot: record \? `activate\.\$\{record\.pub\}` : undefined, consent24h: true, verify: verifyConsent \}\)/);
  assert.match(page, /useLinkSession\(\{ slot: record \? `activate-qr\.\$\{record\.pub\}` : undefined, consent24h: true, verify: verifyConsent \}\)/);
  assert.match(page, /useLinkSession\(\{ slot: record \? `reserve\.\$\{record\.pub\}` : undefined, verifyReservation: verifyReserveAnswer \}\)/);
  assert.doesNotMatch(page, /slot: 'activate'|slot: 'activate-qr'/);
  assert.match(page, /const \{ answer, checkNumber, request \} = session\.state;\s*void step\(record, async \(r\) => \{\s*const next = await act\.takeAnswer\(r, answer, checkNumber, request, deps\);/);
  assert.match(page, /void act\.takeHold\(from, answer, request, deps\)\.then\(\(got\) => \{/);
  const hook = readFileSync(new URL('../../hooks/useLinkSession.ts', import.meta.url), 'utf8');
  assert.match(hook, /interface Run \{\s*session: SiteSession;\s*\/\/[^\n]*\n\s*slot: string \| undefined;/);
  assert.match(hook, /if \(release\) void releaseLinkSession\(r\.session\.id\);\s*if \(r\.slot\) void clearSession\(r\.slot\);/);
  assert.doesNotMatch(hook, /const \{ slot \} = opts\.current;\s*if \(slot\) void clearSession/);
  assert.match(hook, /follow\(kept\.session, kept\.expiresAt, keptSlot, 0\);\s*\}\);\s*return \(\) => \{\s*attempt\.current \+= 1;\s*detach\(\);\s*setState\(\{ phase: 'idle' \}\);\s*\};\s*\}, \[keptSlot, follow, detach\]\);/);
});

// SITE-R3-02: a burn the page dropped as never landed was looked at again only while the payment address lacked the 1DEV
// it would have burned, and the Burn button signed a new burn beside it. Now no new burn while one may have landed.
test('SITE-R3-02: no new burn while a dropped burn may have landed; a landed one is taken back, whatever the balance', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const s = await fundedAt(now);
  s.chain.balances.set(s.created.pub, { sol: 2_000_000, oneDev: 3_000_000_000 });
  const a = await act.burn(await s.stored(), 1500, s.deps, KAT.address);
  assert.equal(a.outcome, 'sent');
  const tx = a.record.burn.tx;
  // A landed, but a lagging backend finds it nowhere past its last valid block, twice: dropped, back to funded.
  s.chain.height = 501;
  t += 3000;
  let r = await act.settleBurn(await s.stored(), s.deps);
  assert.equal(r.stage, 'funded');
  assert.deepEqual(r.dropped.map((b) => b.tx), [tx]);
  assert.equal(r.dropped[0].droppedAt, t);
  // The address still holds one price: the dropped burn is looked at again all the same, at every read.
  s.chain.balances.set(s.created.pub, { sol: 1_990_000, oneDev: 1_500_000_000 });
  const reads = () => (s.chain.txReads ?? []).filter((x) => x.sig === tx).length;
  const before = reads();
  t += 3000;
  r = (await act.checkFunding(await s.stored(), 1500, s.deps)).record;
  assert.equal(r.stage, 'funded');
  assert.equal(reads(), before + 1, 'looked at with the 1DEV still there');
  // The Burn button signs nothing while it is not proven never landed, and the page says why.
  t += 3000;
  const refused = await act.burn(await s.stored(), 1500, s.deps, KAT.address);
  assert.equal(refused.outcome, 'checking');
  assert.equal(s.chain.sent.length, 1, 'no second burn');
  assert.match(TEXTS.act_burn_checking, /nothing new was burned/);
  // Nor does ending the activation delete the key of a burn that may have landed: not the user's cancel while the burn
  // is unproven, nor the 24-hour end while Solana cannot be read.
  t += 3000;
  assert.equal((await act.cancel(await s.stored(), s.deps)).stage, 'funded');
  const down = { ...s.deps, fetchFn: async (url, init) => (String(url).startsWith('/api/cabinet/tx/') ? new Response('{"error":"unavailable"}', { status: 503 }) : s.fetchFn(url, init)) };
  t += KEY_LIFETIME_MS;
  assert.equal((await act.expire(await s.stored(), down)).stage, 'funded');
  assert.ok((await s.stored()).key);
  // A healthy read finds it final: taken back, with the pass it was sent with.
  s.chain.statuses.set(tx, { err: null, confirmationStatus: 'finalized' });
  t += 3000;
  r = (await act.checkFunding(await s.stored(), 1500, s.deps)).record;
  assert.equal(r.stage, 'burnFinal');
  assert.deepEqual(r.burn, { tx, lastValidBlockHeight: 500, amount: 1500, pass: a.record.burn.pass });
  assert.deepEqual(r.dropped, []);
  assert.equal(s.chain.sent.length, 1);
  // The Burn button pressed on a record with a dropped burn that landed takes it back instead of burning.
  const b = await fundedAt(now);
  await updateRecord(b.created.pub, (c) => ({ ...c, dropped: [{ tx, lastValidBlockHeight: 300, amount: 1500, droppedAt: t }] }), b.deps.area);
  b.chain.statuses.set(tx, { err: null, confirmationStatus: 'finalized' });
  const found = await act.burn(await b.stored(), 1500, b.deps, KAT.address);
  assert.equal(found.outcome, 'found');
  assert.equal(found.record.stage, 'burnFinal');
  assert.equal(b.chain.sent.length, 0);
});

test('SITE-R3-02: another tab\'s dropped burn stops this tab\'s burn; a final burn keeps the dropped ones not yet proven', async () => {
  const t = 1_790_000_000_000;
  const now = () => t;
  const s = await fundedAt(now);
  const stale = await s.stored();
  const other = { tx: BURN.tx, lastValidBlockHeight: 500, amount: 1500, droppedAt: t };
  await updateRecord(stale.pub, (c) => ({ ...c, dropped: [other] }), s.deps.area);
  const got = await act.burn(stale, 1500, s.deps, KAT.address);
  assert.equal(got.outcome, 'busy', 'the record this tab held had no dropped burn; the stored one has');
  assert.equal(s.chain.sent.length, 0);
  // A burn final while a dropped one is still unproven (a record from before): the dropped one stays.
  const f = await fundedAt(now);
  const burnTx = (await act.burn(await f.stored(), 1500, f.deps, KAT.address)).record.burn.tx;
  await updateRecord(f.created.pub, (c) => ({ ...c, dropped: [other] }), f.deps.area);
  f.chain.statuses.set(burnTx, { err: null, confirmationStatus: 'finalized' });
  const r = await act.settleBurn(await f.stored(), f.deps);
  assert.equal(r.stage, 'burnFinal');
  assert.deepEqual(r.dropped, [other]);
});

// SITE-R3-01: the server answers each send it forwarded with a read pass, the page keeps it with the transaction and
// shows it on every read, and a read the site cannot answer still lets the page say after 90 s that the outcome is not
// known yet.
test('SITE-R3-01: the page keeps the read pass of its burn and refund and reads with it; an unreadable burn times out', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const { READ_PASS_RE } = await import('../cabinet/burn-tx.ts');
  const s = await fundedAt(now);
  const sent = await act.burn(await s.stored(), 1500, s.deps, KAT.address);
  assert.equal(sent.outcome, 'sent');
  const pass = (await s.stored()).burn.pass;
  assert.match(pass, READ_PASS_RE);
  assert.equal(sent.record.burn.pass, pass);
  await act.settleBurn(await s.stored(), s.deps);
  assert.deepEqual(s.chain.txReads.at(-1), { sig: sent.record.burn.tx, pass });
  // The site cannot read Solana now (503): after 90 s the page says the outcome is not known yet, and keeps reading.
  const down = { ...s.deps, fetchFn: async (url, init) => (String(url).startsWith('/api/cabinet/tx/') ? new Response('{"error":"unavailable"}', { status: 503 }) : s.fetchFn(url, init)) };
  assert.equal((await act.settleBurn(await s.stored(), down)).stage, 'burnSent');
  t += act.BURN_WAIT_MS + 1;
  assert.equal((await act.settleBurn(await s.stored(), down)).stage, 'burnUnknown');
  // A refused burn earns no pass.
  const r = await fundedAt(now);
  r.chain.refuseSend = true;
  assert.equal((await act.burn(await r.stored(), 1500, r.deps, KAT.address)).record.dropped[0].pass, undefined);
  // The refund of an address a reservation named (its burn went out): its pass is kept and shown when the page follows it.
  const c = await burnedAt(now);
  await updateRecord(c.created.pub, (cur) => ({ ...cur, stage: 'leftovers' }), c.deps.area);
  const DEST = V.burner.address;
  const refund = await act.settleLeftovers(await c.stored(), DEST, c.deps);
  assert.equal(refund.outcome, 'sent');
  const refundPass = (await c.stored()).refund.pass;
  assert.match(refundPass, READ_PASS_RE);
  t += 3000;
  assert.equal((await act.settleLeftovers(await c.stored(), DEST, c.deps)).outcome, 'unknown');
  assert.deepEqual(c.chain.txReads.at(-1), { sig: (await c.stored()).refund.tx, pass: refundPass });
  // SITE M-14: a refund from an address no reservation named (here cancelled before its burn; any funded key could send
  // one) earns no pass: the page reads it on the shared budget, like any other signature.
  const early = await fundedAt(now);
  const closing = await act.cancel(await early.stored(), early.deps);
  assert.equal(closing.stage, 'closing');
  assert.equal((await act.settleLeftovers(closing, DEST, early.deps)).outcome, 'sent');
  assert.equal((await early.stored()).refund.pass, undefined);
  t += 3000;
  assert.equal((await act.settleLeftovers(await early.stored(), DEST, early.deps)).outcome, 'unknown');
  assert.deepEqual(early.chain.txReads.at(-1), { sig: (await early.stored()).refund.tx, pass: null });
});

// SITE-R3-03: a finished activation keeps only its receipt: the payment address, the burn, its amount, the node and the
// wallet's address; the signed reservation, the answer, the refund and the key go.
test('SITE-R3-03: a finished activation keeps only its receipt: payment address, burn, amount, node and wallet', async () => {
  const t = 1_790_000_000_000;
  const now = () => t;
  const area = mapArea();
  const s = site({ now });
  const deps = { fetchFn: s.fetchFn, area, subtle, now };
  const created = await createPaymentKey({ wallet: KAT.address, area, now: t });
  const submit = { qnet: KAT.address, nodeId: KAT.nodeId, ts: 1, attempts: 1, txHash: 'cd'.repeat(32), admittedAt: 5, lastCode: null };
  const answer = { qnet: KAT.address, nodeId: KAT.nodeId, consent: { ts: '1', pk: 'x', sig: 'y' }, bound: true, checkNumber: 1, checkConfirmed: true };
  const link = { qr: false, held: true, named: KAT.address, request: { burnTx: BURN.tx, walletHash: KAT.walletHash, check: false } };
  await updateRecord(created.pub, (c) => ({
    ...c, stage: 'leftovers', burn: { ...BURN, pass: 'A'.repeat(22) }, submit, answer, link, dropped: [], hold: holdOf(c.pub, 1),
    reservation: { id: 'a'.repeat(32), wallet: KAT.address, until: 1, amount: 1500 },
    refund: { dest: V.burner.address, tx: BURN.tx, lastValidBlockHeight: 9, pass: 'B'.repeat(22) },
  }), area);
  const done = await act.done((await listRecords(area))[0], deps);
  const stored = (await listRecords(area))[0];
  assert.deepEqual(stored, done);
  assert.deepEqual(stored, {
    v: 1, pub: created.pub, key: null, network: created.network, createdAt: t, updatedAt: t, stage: 'done', burn: BURN,
    link: null, answer: null, submit: null, refund: null, receipt: { qnet: KAT.address, nodeId: KAT.nodeId },
  });
  // What the pages show of it: the code and the node, as from a receipt from before (its submit).
  const { receiptOf, asReceipt } = await import('../cabinet/flow.ts');
  assert.equal(receiptCode(stored), activationCode('light', KAT.address, BURN.tx, 1500));
  assert.deepEqual(receiptOf(stored), { qnet: KAT.address, nodeId: KAT.nodeId });
  assert.deepEqual(receiptOf(base({ stage: 'done', burn: BURN, submit })), { qnet: KAT.address, nodeId: KAT.nodeId });
  assert.equal(receiptOf(base({ stage: 'submitted', burn: BURN, submit })), null);
  assert.equal(asReceipt(base({ stage: 'burnFinal', burn: BURN, submit }), t), null, 'only from a recorded stage');
  // The pages read the wallet and node of a finished activation through its receipt.
  for (const file of ['components/cabinet/NodeActivate.tsx', 'lib/cabinet/wallet-activation.ts', 'lib/cabinet/code-check.ts']) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(text, /receiptOf\(/, file);
    assert.doesNotMatch(text, /stage === 'done' && (?:record|r|result\.record)\.answer/, file);
  }
});

// Owner, 29.09: a consent too old at record time is asked for again at the same step: the burn, its code and its wallet
// stay, whichever way the wallet is connected now.
test('a consent too old at record time: QNet Wallet is asked again for the same burn, the code and the wallet kept', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;

  // Stale before the submit (the page stood open past the consent window): nothing is submitted, the burn is kept, and
  // the new request is for the same burn.
  let s = await burnedAt(now);
  let r = await act.openLink(await s.stored(), false, null, s.deps);
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps), s.deps);
  assert.equal(r.stage, 'beneficiaryConfirmed');
  const code = receiptCode(r);
  assert.equal(code, activationCode('light', KAT.address, r.burn.tx, 1500));
  t += 25 * 60 * 60 * 1000;
  r = await act.register(await s.stored(), s.deps);
  assert.equal(r.stage, 'consentStale');
  assert.equal(r.submit, null);
  assert.equal(s.chain.submitted.length, 0);
  r = await act.relink(await s.stored(), s.deps);
  assert.equal(r.stage, 'burnFinal');
  r = await act.openLink(r, true, { qnet: KAT.address, source: 'app-qr' }, s.deps);
  assert.equal(r.stage, 'linkOpen');
  assert.equal(r.link.request.burnTx, (await s.stored()).burn.tx, 'the same burn');
  assert.equal(r.link.held, true, 'the wallet that signed the reservation is held, however it is connected now');
  assert.deepEqual(r.link.request.walletHash, walletHash(KAT.address));
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 7, r.link.request, s.deps), s.deps);
  r = await act.register(await s.stored(), s.deps);
  assert.equal(r.stage, 'submitted', 'the fresh consent registers');
  assert.equal(receiptCode(r), code);

  // Stale at the network after the submit: the code stays, and the new request names that wallet.
  t = 1_790_000_000_000;
  s = await burnedAt(now);
  r = await act.openLink(await s.stored(), false, { qnet: KAT.address, source: 'extension' }, s.deps);
  r = await act.reviewConsent(await act.takeAnswer(r, appAnswer(r.burn.tx, Math.floor(t / 1000)), 1, r.link.request, s.deps), s.deps);
  s.chain.nodeAnswer = { success: false, error: 'timestamp too old or too far in future' };
  r = await act.register(r, s.deps);
  assert.equal(r.stage, 'consentStale');
  assert.equal(r.submit.qnet, KAT.address);
  const again = receiptCode(r);
  r = await act.relink(await s.stored(), s.deps);
  assert.equal(receiptCode(r), again, 'the code stays');
  r = await act.openLink(r, true, { qnet: OTHER.address, source: 'app-qr' }, s.deps);
  assert.equal(r.link.named, KAT.address);
  assert.deepEqual(r.link.request, { burnTx: r.burn.tx, walletHash: walletHash(KAT.address), check: false });

  // The page asks again in one tap: back to the burn's request step, and the request opens at once.
  const page = readFileSync(new URL('../../components/cabinet/NodeActivate.tsx', import.meta.url), 'utf8');
  assert.match(page, /const askAgain = \(\) => withRecord\(async \(r\) => \{\s*const back = await act\.relink\(r, deps\);\s*if \(back\.stage !== 'burnFinal'\) return back;\s*const asQr = !device\?\.phone;\s*const opened = await act\.openLink\(back, asQr, choice, deps\);\s*if \(opened\?\.link\) void \(asQr \? qr : button\)\.start\('link', opened\.link\.request\);/);
  assert.match(page, /\{stage === 'consentStale' \? \(\s*<button type="button" className="qnet-button activate-primary" onClick=\{\(\) => void askAgain\(\)\}/);
  assert.match(TEXTS.act_stale, /Ask QNet Wallet again: the burn and its code stay\.$/);
});

// R6: one wallet, one burn, whichever browser burns first. Two browsers (each its own payment address and key, each
// confirmed by the wallet) against the one site: while the first one's burn is on its way the second is refused, and
// once it is final it is the wallet's record for good.
test('two browsers for one wallet: the first one\'s burn holds the wallet; the second never burns', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const first = await fundedAt(now);
  // The second browser: its own storage and payment key, the same site, the same wallet's confirmation.
  const area = mapArea();
  const deps = { fetchFn: first.fetchFn, area, subtle, now };
  const created = await createPaymentKey({ wallet: KAT.address, area, now: t });
  const second = async () => (await listRecords(area))[0];
  await confirm(created, deps);
  first.chain.balances.set(created.pub, { sol: 2_000_000, oneDev: 1_500_000_000 });
  await act.checkFunding(await second(), 1500, deps);
  // Both press Burn at once: exactly one burn is sent.
  const [a, b] = await Promise.all([act.burn(await first.stored(), 1500, first.deps, KAT.address), act.burn(await second(), 1500, deps, KAT.address)]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['reserved', 'sent']);
  assert.equal(first.chain.sent.length, 1);
  const winner = a.outcome === 'sent' ? { stored: first.stored, deps: first.deps } : { stored: second, deps };
  const loser = a.outcome === 'sent' ? { stored: second, deps } : { stored: first.stored, deps: first.deps };
  const burnTx = (await winner.stored()).burn.tx;
  // On its way: held; final on Solana: the wallet's record, refused for good, of either way.
  t += 60_000;
  assert.equal((await act.burn(await loser.stored(), 1500, loser.deps, KAT.address)).outcome, 'reserved');
  first.chain.burner = (await winner.stored()).pub;
  first.chain.statuses.set(burnTx, { err: null, confirmationStatus: 'finalized' });
  assert.equal((await act.settleBurn(await winner.stored(), winner.deps)).stage, 'burnFinal');
  assert.equal((await act.burn(await loser.stored(), 1500, loser.deps, KAT.address)).outcome, 'has_burn');
  t += SETTLE_AFTER_MS * 10 + 3 * 86_400_000;
  // Days later, a fresh confirmation: still the wallet's burn.
  await act.takeHold(await loser.stored(), reserveAnswer((await loser.stored()).pub, Math.floor(t / 1000)), act.reserveRequest(await loser.stored()), loser.deps);
  assert.equal((await act.burn(await loser.stored(), 1500, loser.deps, KAT.address)).outcome, 'has_burn');
  assert.equal(first.chain.sent.length, 1, 'one burn in all');
  // The loser gives up without a burn: its reservation, if any, is released, and what arrived goes back.
  const ended = await act.cancel(await loser.stored(), loser.deps);
  assert.equal(ended.stage, 'closing');
});
