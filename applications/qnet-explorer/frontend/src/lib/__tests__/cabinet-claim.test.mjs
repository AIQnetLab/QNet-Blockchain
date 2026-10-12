// Moving a node balance from My node (owner, 12.10: through the site too, for a light and for a super node; unified plan
// SITE-5; docs/protocols/qnet-link-v1.md sections 14.4 and 14.10): with the QNet extension, the one method naming the
// node (claimWithExtension in src/lib/qnet-link.ts), the result checked as the `claim` answer for the wallet the page
// shows and that node, each provider failure by its code and what the page says of each; with QNet Wallet, the `claim`
// request naming the wallet and the node (docs/protocols/node-claim.vectors.json); the Overview offering Move to wallet
// for each node type. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COOLDOWN_MESSAGE } from '../qnet-provider.ts';
import { LINK_ERRORS, claimWithExtension, lightNodeId, superNodeId, walletHash } from '../qnet-link.ts';
import { claimErrorKey, claimReport, failureKey } from '../cabinet/extension-view.ts';
import { CLAIM } from './link-helpers.mjs';

const NOW = 1_790_000_060;
const [KAT, OTHER_WALLET] = CLAIM.wallets;
const WALLET = KAT.address;
const LIGHT = KAT.lightNodeId;
const SUPER = KAT.superNodeId;
const result = (name) => {
  const { v, intent, ...rest } = JSON.parse(CLAIM.cases.find((c) => c.name === name).plaintext);
  assert.equal(v, 1);
  assert.equal(intent, 'claim');
  return rest;
};

const SRC = new URL('../../', import.meta.url);
const code = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function provider(answer) {
  const calls = [];
  return {
    calls,
    isQNet: true,
    request(args) {
      calls.push(args);
      return typeof answer === 'function' ? answer(args) : Promise.resolve(answer);
    },
  };
}

test('the vectors\' wallet: its hash and its light and super node ids, as the site derives them', () => {
  assert.equal(walletHash(WALLET), KAT.walletHash);
  assert.equal(lightNodeId(WALLET), LIGHT);
  assert.equal(superNodeId(WALLET), SUPER);
  assert.equal(superNodeId(OTHER_WALLET.address), OTHER_WALLET.superNodeId);
});

test('one call of qnet_claimNodeBalance naming the node; the answer is the claim answer of the page\'s wallet and node', async () => {
  for (const c of CLAIM.cases.filter((x) => x.request.walletHash === KAT.walletHash)) {
    const nodeId = c.request.nodeId;
    const p = provider(result(c.name));
    const got = await claimWithExtension(p, WALLET, nodeId, NOW);
    assert.equal(got.ok, true, c.name);
    assert.deepEqual(got.answer, { v: 1, intent: 'claim', ...result(c.name) }, c.name);
    assert.deepEqual(p.calls, [{ method: 'qnet_claimNodeBalance', params: { nodeId } }], c.name);
  }
  // the extension's WALLET_MISMATCH (it holds another wallet than the one whose node the page named) is read as such
  const mismatch = await claimWithExtension(provider({ status: 'error', error: 'WALLET_MISMATCH' }), WALLET, SUPER, NOW);
  assert.deepEqual(mismatch, { ok: true, answer: { v: 1, intent: 'claim', status: 'error', error: 'WALLET_MISMATCH' } });
});

test('an answer for another wallet or another node, or one the page cannot verify, shows nothing of it', async () => {
  // the light node's answer to a move of the super node, and the reverse
  assert.deepEqual(await claimWithExtension(provider(result('claim-light-ok')), WALLET, SUPER, NOW), { ok: false, failure: 'unverifiable' });
  assert.deepEqual(await claimWithExtension(provider(result('claim-super-ok')), WALLET, LIGHT, NOW), { ok: false, failure: 'unverifiable' });
  // another wallet's answer for its own node: the extension holds another wallet than the page shows
  const otherAnswer = { ...result('claim-super-ok'), qnet: OTHER_WALLET.address, nodeId: OTHER_WALLET.superNodeId };
  assert.deepEqual(await claimWithExtension(provider(otherAnswer), WALLET, OTHER_WALLET.superNodeId, NOW), { ok: false, failure: 'other_wallet' });
  assert.deepEqual(await claimWithExtension(provider(otherAnswer), WALLET, SUPER, NOW), { ok: false, failure: 'unverifiable' });
  for (const bad of [
    { ...result('claim-super-ok'), v: 1 },
    { ...result('claim-super-ok'), intent: 'claim' },
    { ...result('claim-super-ok'), amountNano: '999999999' },
    { ...result('claim-super-ok'), txHash: 'x' },
    { ...result('claim-super-ok'), extra: true },
    { ...result('claim-super-ok'), qnet: OTHER_WALLET.address },
    { status: 'linked' },
    { status: 'error', error: 'BIND_REFUSED' },
    'ok',
    null,
  ]) {
    assert.deepEqual(await claimWithExtension(provider(bad), WALLET, SUPER, NOW), { ok: false, failure: 'unverifiable' }, JSON.stringify(bad));
  }
});

test('provider failures by code: declined, cooldown, not allowed, too old (update), disconnected, anything else', async () => {
  const failing = (err) => claimWithExtension(provider(() => Promise.reject(err)), WALLET, SUPER, NOW);
  assert.deepEqual(await failing({ code: 4001, message: 'User rejected' }), { ok: false, failure: 'rejected' });
  assert.deepEqual(await failing({ code: 4001, message: COOLDOWN_MESSAGE }), { ok: false, failure: 'cooldown' });
  assert.deepEqual(await failing({ code: 4100, message: 'x' }), { ok: false, failure: 'unauthorized' });
  assert.deepEqual(await failing({ code: 4200, message: 'Unsupported method' }), { ok: false, failure: 'unsupported' });
  // an extension from before the named node refuses the params: one to update
  assert.deepEqual(await failing({ code: -32602, message: 'Invalid params' }), { ok: false, failure: 'unsupported' });
  assert.deepEqual(await failing({ code: 4900, message: 'x' }), { ok: false, failure: 'disconnected' });
  assert.deepEqual(await failing({ code: -32603, message: 'x' }), { ok: false, failure: 'failed' });
  assert.deepEqual(await claimWithExtension({ isQNet: true, request() { throw new Error('sync'); } }, WALLET, SUPER, NOW), { ok: false, failure: 'failed' });
});

test('what the page says of each answer and failure, by the wallet that answered', () => {
  assert.deepEqual(claimReport({ v: 1, intent: 'claim', ...result('claim-super-ok') }, 'extension'), { key: 'claim_ok', amountNano: '48000000000' });
  assert.deepEqual(claimReport({ v: 1, intent: 'claim', ...result('claim-super-ok-partial') }, 'app'), { key: 'claim_ok_part', amountNano: '1000000000', epoch: '155' });
  assert.deepEqual(claimReport({ v: 1, intent: 'claim', ...result('claim-light-empty') }, 'app'), { key: 'claim_empty' });
  assert.deepEqual(claimReport({ v: 1, intent: 'claim', ...result('claim-super-rejected') }, 'app'), { key: 'link_answer_rejected' });
  assert.deepEqual(claimReport({ v: 1, intent: 'claim', status: 'rejected' }, 'extension'), { key: 'ext_failure_rejected' });
  assert.equal(claimErrorKey('NO_NODE', 'app'), 'claim_error_NO_NODE');
  assert.equal(claimErrorKey('CLAIM_BUSY', 'extension'), 'claim_error_CLAIM_BUSY');
  assert.equal(claimErrorKey('WALLET_MISMATCH', 'app'), 'link_error_WALLET_MISMATCH');
  assert.equal(claimErrorKey('WALLET_MISMATCH', 'extension'), 'claim_failure_other_wallet');
  assert.equal(claimErrorKey('NO_WALLET', 'extension'), 'ext_error_NO_WALLET');
  assert.equal(failureKey('other_wallet', 'claim'), 'claim_failure_other_wallet');
  assert.equal(failureKey('timeout', 'claim'), 'claim_failure_timeout');
  assert.equal(failureKey('unsupported', 'claim'), 'ext_failure_unsupported');
});

test('every error the extension may answer is one the site reads', () => {
  const provider = readFileSync(new URL('../../../../../qnet-wallet/dist/background/provider.js', import.meta.url), 'utf8');
  const set = /const CLAIM_ERRORS = new Set\(\[([^\]]+)\]\);/.exec(provider);
  assert.ok(set, 'the extension\'s claim error list');
  const codes = [...set[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 6 && codes.includes('WALLET_MISMATCH'));
  for (const c of codes) assert.ok(LINK_ERRORS.claim.includes(c), c);
});

test('the Overview offers Move to wallet for a light and a super node, naming the node; a genesis node only shows its balance', () => {
  const home = code('components/cabinet/NodeHome.tsx');
  const light = home.slice(home.indexOf('function Summary('), home.indexOf('function LightOverview('));
  const sup = home.slice(home.indexOf('function SuperOverview('), home.indexOf('function Overview('));
  for (const part of [light, sup]) {
    assert.match(part, /<Move\s+qnet=\{choice\.qnet\}\s+nodeId=\{nodeId\}\s+movable=\{movable\}/);
    assert.match(part, /\{movable && viewOnly && <ConnectFirst \/>\}/);
    assert.match(part, /<p className="activate-note">\{t\('balance_lead'\)\}<\/p>/);
  }
  assert.match(sup, /const movable = isClaimNodeId\(nodeId\) && canMove\(status\.balanceNano\);/);
  assert.doesNotMatch(home, /balance_move|super_move/);
  const claim = code('components/cabinet/NodeClaim.tsx');
  // the extension's window for its own wallet's node, QNet Wallet's request naming the wallet and the node
  assert.match(claim, /await claimNodeBalance\(qnet, nodeId\)/);
  assert.match(claim, /const request: ClaimRequest = \{ walletHash: walletHash\(qnet\), nodeId \};/);
  assert.match(claim, /useLinkSession\(\{ slot: `claim\.\$\{nodeId\}` \}\)/);
  assert.match(claim, /useLinkSession\(\{ slot: `claim-qr\.\$\{nodeId\}` \}\)/);
  assert.match(claim, /&& \(choice\?\.source === 'extension' \|\| accounts\?\.qnet === qnet\)/);
});
