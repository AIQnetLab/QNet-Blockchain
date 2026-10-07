// My node's Node details (src/lib/cabinet/code-check.ts, src/server/cabinet/registration-record.ts): the chosen wallet's
// activation shown by itself, with no field to check another code (owner, 29.09; SITE-F9): the network's registration
// record, else the other sources of the wallet (the site's record, the QNet extension, the kept answer of
// src/lib/cabinet/kept-activation.ts), else an activation of this browser; a code names a wallet (owner rule, 26.09): a
// payment key's burn gives the wallet's code, found through the registration (burn -> wallet), a burn from the wallet's
// own Solana address the code of that address (always so for a super node). Exactly one code (owner, 06.10): whose burn
// it is comes from what the page knows (the wallet's shared Solana address, this browser's payment addresses, the burn
// the other sources know), else from the route, which reads the activation registry, then the burn on Solana; none until
// either tells. The route reads only that wallet's row of the node type asked. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jsSha3 from 'js-sha3';
import {
  activationFacts, browserActivation, burnByOf, codesOfRegistration, knownOfKept, normalizeCode, parseArchivedRecord, walletRegistration,
} from '../cabinet/code-check.ts';
import { receiptCode } from '../cabinet/flow.ts';
import { ACTIVATIONS_KEPT, ACTIVATIONS_KEY, answerOf, keepAnswer, loadKept, parseKept } from '../cabinet/kept-activation.ts';
import { ownSolanaOf } from '../cabinet/wallet-choice.ts';
import { ONE_DEV_MINT } from '../one-dev.ts';
import { activationCode, superNodeId, validateActivation } from '../qnet-link.ts';
import { createActivationRegistry, createMemoryStore } from '../../server/cabinet/activation-registry.ts';
import { checkBurn } from '../../server/cabinet/burn-scan.ts';
import {
  BURN_BY_CACHE_MS, BURN_BY_CHECKS_PER_MINUTE, RECORD_SQL, createBurnByReader, createRecordReader, recordFrom, resolveBurnBy,
} from '../../server/cabinet/registration-record.ts';
import { TEXTS } from '../texts.ts';

const V = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
const OWN = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/light-node-own-burn.vectors.json', import.meta.url), 'utf8'));
const KAT = V.wallets.find((w) => w.name === 'kat-12');
const OTHER = V.wallets.find((w) => w.name === 'phrase-24');
// The real devnet burn whose code the mobile app's KAT names.
const BURN = { burnTx: 'nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx', burner: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR', amount: 1500 };
const KNOWN_CODE = 'QNET-LFEFD9-706058-537636';
const RECORD = { height: 1_612_800, ...BURN };

const receipt = (over = {}) => ({
  v: 1, pub: V.burner.address, key: null, network: 'testnet', createdAt: 1, updatedAt: 1, stage: 'done',
  burn: { tx: V.node[0].burnTx, lastValidBlockHeight: 1, amount: 1500 }, link: null,
  answer: { qnet: KAT.address, nodeId: KAT.nodeId, consent: {}, bound: true, checkNumber: 1, checkConfirmed: false },
  submit: { qnet: KAT.address, nodeId: KAT.nodeId, ts: 1, attempts: 1, txHash: null, admittedAt: null, lastCode: null }, refund: null, ...over,
});
// The KAT wallet's code for the KAT burn, had a payment key made it for the wallet.
const WALLET_CODE = activationCode('light', KAT.address, BURN.burnTx, 1500);

test('a code as written: spaces and letter case do not matter; a light or a super node\'s code', () => {
  assert.deepEqual(codesOfRegistration(KAT.address, RECORD), { wallet: WALLET_CODE, burner: KNOWN_CODE });
  assert.notEqual(WALLET_CODE, KNOWN_CODE);
  assert.equal(normalizeCode(`  ${KNOWN_CODE.toLowerCase()} `), KNOWN_CODE);
  const superCode = activationCode('super', BURN.burner, BURN.burnTx, 1500);
  assert.equal(normalizeCode(superCode.toLowerCase()), superCode);
  for (const bad of ['', 'QNET-', KNOWN_CODE.replace('QNET-L', 'QNET-X'), `${KNOWN_CODE}0`, KNOWN_CODE.replace('-', ' ')]) assert.equal(normalizeCode(bad), null, bad);
  // A super node's registration has one code, its burner's: the extension burned from the wallet's own address.
  assert.deepEqual(codesOfRegistration(KAT.address, RECORD, 'super'), { wallet: superCode, burner: superCode });
  for (const burnBy of ['own', null]) {
    assert.deepEqual(walletRegistration(true, { found: true, record: RECORD, burnBy }, KAT.address, {}, 'super'), { kind: 'code', code: superCode, record: RECORD });
  }
});

// The kept answers of the other sources for the KAT burn (wallet-activation.ts KnownBurn).
const knownOf = (over = {}) => ({ nodeType: 'light', burnTx: BURN.burnTx, burnAmount: 1500, code: null, way: null, burner: null, source: 'record', ...over });

test('the chosen wallet\'s registration: none, its one code, not in the archive, or not known; whose burn decides the form', () => {
  assert.deepEqual(walletRegistration(null, null, KAT.address), { kind: 'unavailable' });
  assert.deepEqual(walletRegistration(false, null, KAT.address), { kind: 'none' });
  assert.deepEqual(walletRegistration(true, null, KAT.address), { kind: 'unavailable' });
  assert.deepEqual(walletRegistration(true, { found: false }, KAT.address), { kind: 'notArchived' });
  const shown = [];
  const codeOf = (served, evidence = {}) => {
    const got = walletRegistration(true, { found: true, record: RECORD, burnBy: served }, KAT.address, evidence);
    shown.push(got);
    return got.code;
  };
  // The wallet's own Solana address burned: its code, whatever the site says.
  for (const served of [null, 'payment', 'own']) assert.equal(codeOf(served, { ownSolana: BURN.burner }), KNOWN_CODE, String(served));
  // The page knows the wallet's address and another one burned (a payment key): the wallet's code, never the payment
  // address's.
  assert.equal(codeOf(null, { ownSolana: V.burner.address }), WALLET_CODE);
  // The page knows nothing of it: the site's answer decides; while the site cannot tell either, no code at all.
  assert.equal(codeOf('own'), KNOWN_CODE);
  assert.equal(codeOf('payment'), WALLET_CODE);
  assert.equal(codeOf(null), null);
  // This browser's payment address burned, or made this burn: the wallet's code.
  assert.equal(codeOf('own', { records: [receipt({ pub: BURN.burner })] }), WALLET_CODE);
  assert.equal(codeOf(null, { records: [receipt({ burn: { tx: BURN.burnTx, lastValidBlockHeight: 1, amount: 1500 } })] }), WALLET_CODE);
  assert.equal(codeOf(null, { records: [receipt()] }), null, 'another payment address and burn tell nothing');
  // The burn the other sources know is this one: its code, else its way, tells.
  assert.equal(codeOf(null, { known: knownOf({ code: KNOWN_CODE, way: 'extension', burner: BURN.burner }) }), KNOWN_CODE, 'the site\'s record of the extension\'s burn');
  assert.equal(codeOf(null, { known: knownOf({ code: WALLET_CODE, way: 'payment', burner: BURN.burner }) }), WALLET_CODE, 'the site\'s record of a payment burn');
  assert.equal(codeOf(null, { known: knownOf({ source: 'extension', code: WALLET_CODE, way: 'payment' }) }), WALLET_CODE, 'the extension: paid on the site');
  assert.equal(codeOf(null, { known: knownOf({ source: 'extension', code: KNOWN_CODE, way: 'extension', burner: BURN.burner }) }), KNOWN_CODE);
  assert.equal(codeOf(null, { known: knownOf({ source: 'kept', code: KNOWN_CODE }) }), KNOWN_CODE, 'the extension\'s answer kept here');
  assert.equal(codeOf(null, { known: knownOf({ source: 'browser', way: 'payment', burner: BURN.burner }) }), WALLET_CODE);
  // Another burn, the search of an address a QR answer named, or another node type tell nothing: the site's answer.
  assert.equal(codeOf(null, { known: knownOf({ burnTx: V.node[0].burnTx, code: KNOWN_CODE, way: 'extension' }) }), null);
  assert.equal(codeOf(null, { known: knownOf({ source: 'scan', code: KNOWN_CODE, way: 'extension', burner: BURN.burner }) }), null);
  assert.equal(codeOf('payment', { known: knownOf({ source: 'scan', code: KNOWN_CODE, way: 'extension', burner: BURN.burner }) }), WALLET_CODE);
  assert.equal(codeOf(null, { known: knownOf({ nodeType: 'super', code: activationCode('super', BURN.burner, BURN.burnTx, 1500) }) }), null);
  // Never a second form beside the one code.
  for (const got of shown) assert.deepEqual(Object.keys(got).sort(), ['code', 'kind', 'record']);
  assert.equal(burnByOf(KAT.address, RECORD, {}, null), null);
  assert.equal(burnByOf(KAT.address, RECORD, { ownSolana: BURN.burner }, 'payment'), 'own');
});

test('a receipt names the wallet its burn was bound to; Node details show one code and no other form', () => {
  const mine = receipt();
  // A receipt names the wallet the burn is for, not the payment address: the one that signed the reservation, whose
  // reservation the burn was made under, from the burn on (C4: the owner bind comes with the burn).
  assert.equal(receiptCode(mine), activationCode('light', KAT.address, V.node[0].burnTx, 1500));
  assert.notEqual(receiptCode(mine), activationCode('light', V.burner.address, V.node[0].burnTx, 1500));
  assert.equal(receiptCode(receipt({ submit: null })), null, 'a record from before, bound to no wallet');
  assert.equal(receiptCode(receipt({ submit: null, stage: 'burnFinal', reservation: { id: 'a'.repeat(32), wallet: KAT.address, until: 1, amount: 1500 } })), activationCode('light', KAT.address, V.node[0].burnTx, 1500));
  // The code row holds the one code with Copy, or that it follows later; no link to another form, no text of one.
  const page = readFileSync(new URL('../../components/cabinet/NodeDetails.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(page, /facts\.other|showOther|code_show_other|code_recover_other/);
  for (const key of ['code_show_other', 'code_recover_other']) assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, key), false, key);
  const value = page.slice(page.indexOf('function CodeValue('), page.indexOf('// The details card'));
  assert.match(value, /if \(!facts\.code\) return <span className="activate-note">\{t\('code_code_later'\)\}<\/span>;/);
  assert.equal(value.match(/className="activate-code"/g).length, 1, 'one code');
  assert.equal(value.match(/<CopyButton /g).length, 1);
  assert.doesNotMatch(value, /<button /);
});

test('the extension\'s answer: its code is its own Solana address\'s or, for a light node paid on aiqnet.io, the wallet\'s', () => {
  const answer = (code, nodeType = 'light') => JSON.stringify({
    v: 1, intent: 'activate', status: 'exists', qnet: KAT.address, solana: V.burner.address, nodeType, burnTx: BURN.burnTx, burnAmount: 1500, code,
  });
  assert.equal(validateActivation(answer(activationCode('light', V.burner.address, BURN.burnTx, 1500)), 'light').ok, true);
  assert.equal(validateActivation(answer(WALLET_CODE), 'light').ok, true);
  assert.equal(validateActivation(answer(KNOWN_CODE), 'light').reason, 'code');
  // A super node's code is never the wallet's QNet address's.
  assert.equal(validateActivation(answer(activationCode('super', KAT.address, BURN.burnTx, 1500), 'super'), 'super').reason, 'code');
});

test('the archive\'s rows: the newest light node row of this wallet with its burn facts; anything else is passed over', () => {
  const row = (over = {}, block = '1612800') => ({ block, data: { node_id: KAT.nodeId, node_type: 'Light', burn_tx: BURN.burnTx, burn_wallet: BURN.burner, burn_amount: 1500, ...over } });
  assert.deepEqual(recordFrom(KAT.address, [row()]), { found: true, record: RECORD });
  assert.deepEqual(recordFrom(KAT.address, [row({ node_type: 'Super', node_id: 'genesis_node_001' }), row()]), { found: true, record: RECORD });
  for (const over of [{ node_id: OTHER.nodeId }, { node_type: 'Super' }, { burn_tx: null }, { burn_wallet: 'x' }, { burn_amount: 0 }, { burn_amount: null }]) {
    assert.deepEqual(recordFrom(KAT.address, [row(over)]), { found: false }, JSON.stringify(over));
  }
  assert.deepEqual(recordFrom(KAT.address, [row({}, 'x')]), { found: false });
  assert.deepEqual(recordFrom(KAT.address, [{ block: 5, data: null }]), { found: false });
  assert.deepEqual(recordFrom(KAT.address, []), { found: false });
  // A super node's registration, sent from its own id, of its type.
  const superRow = { block: '1612800', data: { node_id: superNodeId(KAT.address), node_type: 'Super', burn_tx: BURN.burnTx, burn_wallet: BURN.burner, burn_amount: 1500 } };
  assert.deepEqual(recordFrom(KAT.address, [superRow], 'super'), { found: true, record: RECORD });
  assert.deepEqual(recordFrom(KAT.address, [superRow]), { found: false }, 'not a light node');
  assert.deepEqual(recordFrom(KAT.address, [row()], 'super'), { found: false }, 'not a super node');
  // The page reads the route's answer again, exactly: the record and whose burn it is (null while the site cannot tell).
  for (const burnBy of [null, 'payment', 'own']) assert.deepEqual(parseArchivedRecord({ found: true, record: RECORD, burnBy }), { found: true, record: RECORD, burnBy });
  assert.deepEqual(parseArchivedRecord({ found: false }), { found: false });
  for (const bad of [
    { found: false, x: 1 }, { found: true }, { found: true, record: RECORD }, { found: true, record: RECORD, burnBy: 'wallet' },
    { found: true, record: RECORD, burnBy: null, x: 1 }, { found: true, record: { ...RECORD, amount: 0 }, burnBy: null },
    { found: true, record: { ...RECORD, x: 1 }, burnBy: null }, null,
  ]) {
    assert.equal(parseArchivedRecord(bad), null, JSON.stringify(bad));
  }
  // One indexed query: this sender's registrations, newest first, a few rows.
  assert.match(RECORD_SQL, /WHERE from_address = \$1 AND tx_type = 'NodeRegistration' ORDER BY block DESC, tx_index DESC LIMIT 4/);
});

test('/registration/:wallet: an EON address only, one archive read per wallet for half a minute, the client metered', async () => {
  let t = 1_000_000;
  const asked = [];
  const reader = createRecordReader({
    lookup: async (wallet) => {
      asked.push(wallet);
      return wallet === KAT.address ? [{ block: '1612800', data: { node_id: KAT.nodeId, node_type: 'Light', burn_tx: BURN.burnTx, burn_wallet: BURN.burner, burn_amount: 1500 } }] : [];
    },
    now: () => t, clientKey: () => ({ ok: true, ip: '203.0.113.30' }), scope: 'record-test', devOrigins: false,
  });
  const get = (w) => new Request(`https://aiqnet.io/api/cabinet/registration/${w}`, { headers: { host: 'aiqnet.io' } });
  const json = async (res) => JSON.parse(await res.text());
  const res = await reader.read(get(KAT.address), KAT.address);
  assert.equal(res.status, 200);
  const body = await json(res);
  // Without the registry and Solana, whose light burn it is stays unknown.
  assert.deepEqual(body, { found: true, record: RECORD, burnBy: null });
  assert.equal(activationCode('light', body.record.burner, body.record.burnTx, body.record.amount), KNOWN_CODE);
  await reader.read(get(KAT.address), KAT.address);
  assert.equal(asked.length, 1);
  t += 30_001;
  await reader.read(get(KAT.address), KAT.address);
  assert.equal(asked.length, 2);
  assert.deepEqual(await json(await reader.read(get(OTHER.address), OTHER.address)), { found: false });
  // ?type=super reads the rows sent from the wallet's super node id.
  await reader.read(get(KAT.address), KAT.address, 'super');
  assert.equal(asked.at(-1), superNodeId(KAT.address));
  assert.equal((await reader.read(get(KAT.address), KAT.address, 'full')).status, 400);
  assert.equal((await reader.read(get('x'), 'x')).status, 400);
  const failing = createRecordReader({ lookup: async () => { throw new Error('db'); }, clientKey: () => ({ ok: true, ip: '203.0.113.31' }), scope: 'record-test-2', devOrigins: false });
  assert.equal((await failing.read(get(KAT.address), KAT.address)).status, 503);
});

// A fake Solana for whose burn: `burns` maps a signature to its payer, each a final light burn of `amount` (getTransaction,
// jsonParsed, as burn-parse.ts reads it); `down` fails every call.
function fakeSolana(burns = new Map(), { down = false } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (down) throw new Error('rpc_http_503');
    if (method === 'getSignatureStatuses') return { value: [burns.has(params[0][0]) ? { err: null, confirmationStatus: 'finalized' } : null] };
    if (method === 'getTransaction') {
      const b = burns.get(params[0]);
      return b ? {
        slot: 100, blockTime: 1_790_000_000, meta: { err: null },
        transaction: { message: { accountKeys: [{ pubkey: b.payer, signer: true, writable: true }], instructions: [
          { program: 'spl-token', parsed: { type: 'burn', info: { mint: ONE_DEV_MINT, authority: b.payer, account: 'x', amount: `${b.amount ?? 1500}000000` } } },
          { program: 'spl-memo', parsed: 'QNET_NODE_TYPE:LIGHT' },
        ] } },
      } : null;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls, check: (burnTx, expect) => checkBurn(rpc, burnTx, expect) };
}

// A recorded row of the activation registry (activation-registry.ts ActivationRow).
const rowOf = (wallet, way, burner, burnTx) => ({
  wallet, state: 'recorded', nodeType: 'light', way, burner, burnAmount: 1500, reservation: null, reservedAt: null, expiresAt: null, burnTx,
  announcedAt: null, burnSlot: 100, burnedAt: 1, recordedAt: 1, proof: null,
});

test('whose burn on the server: the registry\'s row of this burn, else the burn on Solana as the burner\'s own; null while either cannot tell', async () => {
  const solana = fakeSolana(new Map([[BURN.burnTx, { payer: BURN.burner }]]));
  // The wallet's row as the registry reads it (activation-api.ts paymentRecord).
  const rowIn = async (row) => {
    const store = createMemoryStore();
    await store.record(row, null);
    return createActivationRegistry({ store, check: solana.check }).paymentRecord(row.wallet);
  };
  // A payment address's burn: the registry holds it (C4: announced before it left), and Solana is not asked.
  assert.equal(await resolveBurnBy(await rowIn(rowOf(KAT.address, 'payment', BURN.burner, BURN.burnTx)), RECORD, solana.check), 'payment');
  // The extension's burn from the wallet's own Solana address, recorded with the wallet's proof.
  assert.equal(await resolveBurnBy(await rowIn(rowOf(KAT.address, 'extension', BURN.burner, BURN.burnTx)), RECORD, solana.check), 'own');
  assert.equal(solana.calls.length, 0);
  // No row (a burn of the extension from before the registry, of an earlier QNet Wallet, or QNet Wallet's own-burn
  // registration): no payment key of this site made it, and Solana holds it final with the archive's burner as payer.
  assert.equal(await resolveBurnBy(null, RECORD, solana.check), 'own');
  assert.deepEqual(solana.calls, ['getSignatureStatuses', 'getTransaction']);
  // A row of another burn says nothing of this one: Solana decides.
  assert.equal(await resolveBurnBy(rowOf(KAT.address, 'payment', V.burner.address, V.node[0].burnTx), RECORD, solana.check), 'own');
  // Not known: the registry cannot answer (Solana is not asked), Solana holds no such burn, another payer, or is down.
  const before = solana.calls.length;
  assert.equal(await resolveBurnBy('unavailable', RECORD, solana.check), null);
  assert.equal(solana.calls.length, before);
  assert.equal(await resolveBurnBy(null, { ...RECORD, burnTx: V.node[0].burnTx }, solana.check), null, 'missing');
  assert.equal(await resolveBurnBy(null, { ...RECORD, burner: V.burner.address }, solana.check), null, 'another payer');
  assert.equal(await resolveBurnBy(null, { ...RECORD, amount: 300 }, solana.check), null, 'another amount');
  assert.equal(await resolveBurnBy(null, RECORD, fakeSolana(new Map(), { down: true }).check), null, 'Solana down');
});

test('whose burn is kept once known, one Solana budget a minute for the server; the route answers it, a super node\'s always the burner\'s', async () => {
  let t = 5_000_000;
  const solana = fakeSolana(new Map([[BURN.burnTx, { payer: BURN.burner }], [V.node[0].burnTx, { payer: V.burner.address }]]));
  const rows = [];
  let registry = null;
  const burnBy = createBurnByReader({
    row: async (wallet) => {
      rows.push(wallet);
      return registry;
    },
    check: solana.check, now: () => t, perMinute: 1,
  });
  assert.equal(await burnBy(KAT.address, RECORD), 'own');
  assert.equal(await burnBy(KAT.address, RECORD), 'own');
  assert.deepEqual(rows, [KAT.address], 'kept');
  t += BURN_BY_CACHE_MS;
  registry = rowOf(KAT.address, 'payment', BURN.burner, BURN.burnTx);
  assert.equal(await burnBy(KAT.address, RECORD), 'payment', 'read again after a day');
  // Past the minute's Solana budget: not known, and not kept; the next minute tells.
  registry = null;
  const other = { height: 8, burnTx: V.node[0].burnTx, burner: V.burner.address, amount: 1500 };
  assert.equal(await burnBy(OTHER.address, other), 'own');
  assert.equal(await burnBy(OTHER.address, { ...other, burnTx: BURN.burnTx, burner: BURN.burner }), null, 'a second check this minute');
  t += 60_000;
  assert.equal(await burnBy(OTHER.address, { ...other, burnTx: BURN.burnTx, burner: BURN.burner }), 'own');
  // The registry failing is not known either.
  const failing = createBurnByReader({ row: async () => { throw new Error('db'); }, check: solana.check });
  assert.equal(await failing(KAT.address, RECORD), null);
  // A burn Solana holds final but not as the archive's burner's own: not known, and not asked again for a day; a burn
  // Solana does not hold (yet) is asked again.
  let u = 7_000_000;
  const settled = fakeSolana(new Map([[BURN.burnTx, { payer: V.burner.address }]]));
  const never = createBurnByReader({ row: async () => null, check: settled.check, now: () => u });
  assert.equal(await never(KAT.address, RECORD), null);
  assert.equal(await never(KAT.address, RECORD), null);
  assert.deepEqual(settled.calls, ['getSignatureStatuses', 'getTransaction'], 'not asked again');
  u += BURN_BY_CACHE_MS;
  assert.equal(await never(KAT.address, RECORD), null);
  assert.equal(settled.calls.length, 4, 'asked again after a day');
  const missing = { ...RECORD, burnTx: V.node[0].burnTx };
  assert.equal(await never(KAT.address, missing), null);
  assert.equal(await never(KAT.address, missing), null);
  assert.equal(settled.calls.length, 6, 'a missing burn is asked every time');

  // The route: whose light burn from the reader; a super node's the burner's own without asking.
  const asked = [];
  const reader = createRecordReader({
    lookup: async (from) => [
      { block: '1612800', data: { node_id: KAT.nodeId, node_type: 'Light', burn_tx: BURN.burnTx, burn_wallet: BURN.burner, burn_amount: 1500 } },
      { block: '1612800', data: { node_id: superNodeId(KAT.address), node_type: 'Super', burn_tx: BURN.burnTx, burn_wallet: BURN.burner, burn_amount: 1500 } },
    ].filter((r) => (from === KAT.address ? r.data.node_type === 'Light' : r.data.node_type === 'Super')),
    burnBy: async (wallet, record) => {
      asked.push([wallet, record.burnTx]);
      return 'payment';
    },
    clientKey: () => ({ ok: true, ip: '203.0.113.32' }), scope: 'record-test-3', devOrigins: false,
  });
  const get = (w) => new Request(`https://aiqnet.io/api/cabinet/registration/${w}`, { headers: { host: 'aiqnet.io' } });
  assert.deepEqual(JSON.parse(await (await reader.read(get(KAT.address), KAT.address)).text()), { found: true, record: RECORD, burnBy: 'payment' });
  assert.deepEqual(JSON.parse(await (await reader.read(get(KAT.address), KAT.address, 'super')).text()), { found: true, record: RECORD, burnBy: 'own' });
  assert.deepEqual(asked, [[KAT.address, BURN.burnTx]]);
  const throwing = createRecordReader({
    lookup: async () => [{ block: '1612800', data: { node_id: KAT.nodeId, node_type: 'Light', burn_tx: BURN.burnTx, burn_wallet: BURN.burner, burn_amount: 1500 } }],
    burnBy: async () => { throw new Error('x'); }, clientKey: () => ({ ok: true, ip: '203.0.113.33' }), scope: 'record-test-4', devOrigins: false,
  });
  assert.deepEqual(JSON.parse(await (await throwing.read(get(KAT.address), KAT.address)).text()), { found: true, record: RECORD, burnBy: null });
  // The route wires the registry's row of the wallet and the burn's Solana check.
  const route = readFileSync(new URL('../../app/api/cabinet/registration/[wallet]/route.ts', import.meta.url), 'utf8');
  assert.match(route, /const row: BurnRowReader = \(wallet\) => activationApi\(\(text, values\) => query\(text, values\)\)\.paymentRecord\(wallet\);/);
  assert.match(route, /const check: BurnChecker = \(burnTx, expect\) => checkBurn\(sharedSolanaRpc\(\), burnTx, expect\);/);
  assert.match(route, /return cabinetRecordReader\(lookup, \{ row, check \}\)\.read\(request, wallet, new URL\(request\.url\)\.searchParams\.get\('type'\)\);/);
  // explorer.md states the route's answer and its numbers as the code has them.
  const doc = readFileSync(new URL('../../../../../../docs/applications/explorer.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.equal(BURN_BY_CACHE_MS, 24 * 3_600_000);
  assert.equal(BURN_BY_CHECKS_PER_MINUTE, 30);
  for (const claim of [
    'exactly `{"found","record":{"height","burnTx","burner","amount"},"burnBy"}` or `{"found":false}`',
    'Kept 24 hours per registration once known, and `null` as long when Solana holds that burn failed, or final but not as that burner\'s own valid burn; the Solana checks share 30 a minute for the whole server; `null` while the registry or Solana cannot tell',
    'the route is read again every 30 s while the page is shown (a read that fails keeps the answer before it)',
    'Exactly one code is shown.',
  ]) assert.ok(doc.includes(claim), claim);
  assert.doesNotMatch(doc, /the other form on request/);
});

test('the own-burn phone path: QNet Wallet registered a burn of the wallet\'s own Solana address; every browser shows that address\'s code', async () => {
  const C = OWN.cases[0];
  const record = { height: 9, burnTx: C.burnTx, burner: C.solana.address, amount: C.burnAmount };
  const ownCode = activationCode('light', C.solana.address, C.burnTx, C.burnAmount);
  assert.notEqual(ownCode, activationCode('light', C.wallet.address, C.burnTx, C.burnAmount));
  // The own-burn registration leaves no row in the registry; the burn on Solana is the burner's own.
  const served = await createBurnByReader({ row: async () => null, check: fakeSolana(new Map([[C.burnTx, { payer: C.solana.address }]])).check })(C.wallet.address, record);
  assert.equal(served, 'own');
  const archived = { found: true, record, burnBy: served };
  // On the phone, connected with QNet Wallet on it, which shared its Solana address.
  const phone = { qnet: C.wallet.address, source: 'app', solana: C.solana.address };
  assert.deepEqual(walletRegistration(true, { ...archived, burnBy: null }, C.wallet.address, { ownSolana: ownSolanaOf(phone) }), { kind: 'code', code: ownCode, record });
  // On a computer connected by a QR code, whose Solana address anyone answering could have named: the site's answer.
  const qr = { qnet: C.wallet.address, source: 'app-qr', solana: C.solana.address };
  assert.equal(ownSolanaOf(qr), null);
  assert.deepEqual(walletRegistration(true, archived, C.wallet.address, { ownSolana: ownSolanaOf(qr) }), { kind: 'code', code: ownCode, record });
  assert.deepEqual(walletRegistration(true, { ...archived, burnBy: null }, C.wallet.address, {}), { kind: 'code', code: null, record }, 'no code until it is known');
  // The Overview's facts carry that one code.
  const facts = activationFacts(walletRegistration(true, archived, C.wallet.address, {}), null, null);
  assert.deepEqual(facts, { source: 'network', nodeType: 'light', burnTx: C.burnTx, amount: C.burnAmount, code: ownCode, height: 9, open: false });
});

// A QNet address for the tests: 19 hex, "eon", 15 hex and its checksum.
const eon = (i) => {
  const body = `${i.toString(16).padStart(19, '0')}eon${'0'.repeat(15)}`;
  return `${body}${jsSha3.sha3_256(body).slice(0, 8)}`;
};
// The extension's answer for `qnet`: its own Solana address burned, its code that address's.
const extAnswer = (qnet, over = {}) => ({
  v: 1, intent: 'activate', status: 'ok', qnet, solana: V.burner.address, nodeType: 'light', burnTx: BURN.burnTx, burnAmount: 1500,
  code: activationCode('light', V.burner.address, BURN.burnTx, 1500), ...over,
});

test('the extension\'s activation kept per wallet: public fields only, checked again when read, the newest few, blocked storage keeps nothing', () => {
  const area = new Map();
  const storage = { getItem: (k) => area.get(k) ?? null, setItem: (k, v) => area.set(k, v) };
  const answer = extAnswer(KAT.address);
  const kept = keepAnswer(storage, {}, answer, 1000);
  assert.deepEqual(kept, { [KAT.address]: { status: 'ok', qnet: KAT.address, solana: V.burner.address, nodeType: 'light', burnTx: BURN.burnTx, burnAmount: 1500, code: answer.code, at: 1000 } });
  assert.deepEqual([...area.keys()], [ACTIVATIONS_KEY]);
  assert.deepEqual(loadKept(storage), kept);
  assert.deepEqual(answerOf(kept[KAT.address]), answer);
  assert.equal(validateActivation(JSON.stringify(answerOf(kept[KAT.address])), 'light').ok, true);
  // A burn not final yet is kept without a code; answers that name no burn are not kept.
  const pending = keepAnswer(storage, {}, { v: 1, intent: 'activate', status: 'pending', qnet: KAT.address, solana: V.burner.address, nodeType: 'light', burnTx: BURN.burnTx, burnAmount: 1500 }, 5);
  assert.equal(pending[KAT.address].code, undefined);
  assert.deepEqual(loadKept(storage), pending);
  for (const none of [{ v: 1, intent: 'activate', status: 'rejected' }, { v: 1, intent: 'activate', status: 'error', error: 'INTERNAL' }]) {
    assert.equal(keepAnswer(storage, kept, none, 2000), kept);
  }
  // An entry that no longer checks out is dropped: a code that is not the burn's, another wallet's key, a field more.
  for (const bad of [
    { [KAT.address]: { ...kept[KAT.address], code: KNOWN_CODE } },
    { [OTHER.address]: kept[KAT.address] },
    { [KAT.address]: { ...kept[KAT.address], seed: 'x' } },
    { [KAT.address]: { ...kept[KAT.address], at: -1 } },
    { [KAT.address]: { ...kept[KAT.address], status: 'error' } },
  ]) {
    area.set(ACTIVATIONS_KEY, JSON.stringify(bad));
    assert.deepEqual(loadKept(storage), {}, JSON.stringify(bad));
  }
  assert.deepEqual(parseKept('not json'), {});
  assert.deepEqual(parseKept('x'.repeat(9000)), {});
  // The newest few wallets.
  let many = {};
  for (let i = 1; i <= ACTIVATIONS_KEPT + 2; i += 1) many = keepAnswer(storage, many, extAnswer(eon(i)), i);
  assert.equal(Object.keys(many).length, ACTIVATIONS_KEPT);
  assert.ok(!(eon(1) in many) && !(eon(2) in many) && eon(ACTIVATIONS_KEPT + 2) in many);
  assert.deepEqual(loadKept(storage), many);
  // Blocked storage: kept for the page only, nothing thrown.
  const blocked = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.equal(keepAnswer(blocked, {}, answer, 1)[KAT.address].at, 1);
  assert.deepEqual(loadKept(blocked), {});
  assert.deepEqual(loadKept(null), {});
});

test('the wallet\'s activation in Node details: the network\'s record first, then the other sources, then this browser\'s', () => {
  const registration = walletRegistration(true, { found: true, record: RECORD, burnBy: null }, KAT.address, { ownSolana: BURN.burner });
  const otherBurn = { burnTx: V.node[0].burnTx, code: activationCode('light', V.burner.address, V.node[0].burnTx, 1500) };
  const kept = knownOfKept(keepAnswer(null, {}, extAnswer(KAT.address, otherBurn), 7)[KAT.address]);
  const done = receipt();
  assert.deepEqual(activationFacts(registration, kept, done), {
    source: 'network', nodeType: 'light', burnTx: BURN.burnTx, amount: 1500, code: KNOWN_CODE, height: RECORD.height, open: false,
  });
  assert.deepEqual(activationFacts({ kind: 'notArchived' }, kept, done), {
    source: 'kept', nodeType: 'light', burnTx: V.node[0].burnTx, amount: 1500, code: otherBurn.code, height: null, open: false,
  });
  // The site's record and the extension's own answer come before the kept one (wallet-activation.ts knownBurn).
  const fromRecord = { nodeType: 'super', burnTx: BURN.burnTx, burnAmount: 1500, code: activationCode('super', BURN.burner, BURN.burnTx, 1500), way: 'extension', burner: BURN.burner, source: 'record' };
  assert.equal(activationFacts({ kind: 'none' }, fromRecord, done, 'super').source, 'record');
  // A super node's registration in the archive comes first, with its one code.
  const superReg = walletRegistration(true, { found: true, record: RECORD, burnBy: 'own' }, KAT.address, {}, 'super');
  assert.equal(activationFacts(superReg, fromRecord, null, 'super').code, fromRecord.code);
  assert.deepEqual(activationFacts(null, null, done), {
    source: 'browser', nodeType: 'light', burnTx: V.node[0].burnTx, amount: 1500, code: receiptCode(done), height: null, open: false,
  });
  assert.equal(activationFacts({ kind: 'none' }, null, null), null);
  // A super node's activation keeps its type.
  assert.equal(activationFacts(null, { ...kept, nodeType: 'super' }, null).nodeType, 'super');
  assert.equal(knownOfKept(null), null);
  // This browser's activation for the wallet: its burn, open until done; a burn given up or not used is none.
  const open = receipt({ stage: 'submitted' });
  assert.equal(browserActivation([open], KAT.address), open);
  assert.equal(activationFacts(null, null, open).open, true);
  assert.equal(browserActivation([done], OTHER.address), null);
  assert.equal(browserActivation([receipt({ stage: 'closing' }), receipt({ stage: 'otherBurn' }), receipt({ burn: null })], KAT.address), null);
  assert.equal(browserActivation([receipt({ updatedAt: 1 }), receipt({ pub: 'newer', updatedAt: 9 })], KAT.address).pub, 'newer');
});

test('Node details show the activation by themselves, with no field to check another code (SITE-F9)', () => {
  const page = readFileSync(new URL('../../components/cabinet/NodeDetails.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(page, /const facts = wallet \? activationFacts\(registration, known, nodeType === 'light' \? browserActivation\(records, wallet\) : null, nodeType\) : null;/);
  // What tells whose burn it was: the wallet's own Solana address (the one it shared, else the one its extension burned
  // from), the burn the other sources know, this browser's payment addresses; else the route's answer.
  assert.match(page, /const evidence: BurnEvidence = \{ ownSolana: ownSolanaOf\(choice\) \?\? activation\?\.solana \?\? null, known, records \};/);
  assert.match(page, /const registration = useWalletRegistration\(wallet, registered, evidence, nodeType\);/);
  // A code not known yet: the archive's route is read again every half minute while the page is shown.
  assert.match(page, /const unresolved = registration\?\.kind === 'code' && registration\.code === null;/);
  assert.match(page, /if \(document\.visibilityState === 'visible'\) setRound\(\(n\) => n \+ 1\);\s*\}, BURN_BY_RETRY_MS\);/);
  assert.match(page, /\}, \[wallet, registered, nodeType, round\]\);/);
  // The archive's answer is used only for the wallet it was read for: another wallet chosen meanwhile never gets its burn.
  // A read again that fails keeps the answer before it, so the page neither drops the record nor stops reading.
  assert.match(page, /if \(live\) setArchived\(\(before\) => \(record === null && before\?\.wallet === wallet && before\.record !== null \? before : \{ wallet, record \}\)\);/);
  assert.match(page, /const mine = archived\?\.wallet === wallet \? archived : undefined;/);
  // Registered without burn details: the explorer keeps none, or it could not be read (not the network).
  assert.match(page, /\{t\(registration\.kind === 'notArchived' \? 'code_not_archived' : 'code_archive_unavailable'\)\}/);
  // Status on the network, type, node id, code, burn and amount, and where the page learned them.
  for (const key of ['code_field_status', 'ext_field_type', 'code_field_node', 'act_code', 'act_burn_tx', 'code_field_amount', 'super_id']) assert.ok(page.includes(`'${key}'`), key);
  assert.match(page, /<a href=\{solanaTxUrl\(facts\.burnTx\)\} target="_blank" rel="noopener noreferrer" className="activate-mono">\{facts\.burnTx\}<\/a>/);
  assert.match(page, /<p className="activate-note">\{t\(SOURCE_TEXT\[facts\.source\]\)\}<\/p>/);
  // Nothing to type: no form, no check button, no text of one.
  assert.doesNotMatch(page, /<form |<input |CheckAnother|code_check/);
  for (const key of ['code_check_other', 'code_input', 'code_check', 'code_malformed', 'code_match', 'code_no_match']) assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, key), false, key);
});
