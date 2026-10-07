// Moving the node balance with the QNet extension (unified plan SITE-5; docs/protocols/qnet-link-v1.md section
// 14.10; claimWithExtension in src/lib/qnet-link.ts): the one method, no parameters, the result checked as the
// `claim` answer for the wallet the page shows, and each provider failure by its code. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COOLDOWN_MESSAGE } from '../qnet-provider.ts';
import { LINK_ERRORS, claimWithExtension, walletHash } from '../qnet-link.ts';
import { LINK } from './link-helpers.mjs';

const NOW = 1_790_000_060;
const result = (name) => {
  const { v, intent, ...rest } = JSON.parse(LINK.cases.find((c) => c.name === name).plaintext);
  assert.equal(v, 1);
  assert.equal(intent, 'claim');
  return rest;
};
const WALLET = result('claim-ok').qnet;
const OTHER = 'a'.repeat(19) + 'eon' + 'b'.repeat(15) + 'cccccccc';

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

test('one call of qnet_claimNodeBalance without parameters; the answer is the claim answer of the page\'s wallet', async () => {
  assert.equal(walletHash(WALLET), '74940b0126365748');
  for (const name of ['claim-ok', 'claim-ok-partial', 'claim-empty', 'claim-rejected', 'claim-error']) {
    const p = provider(result(name));
    const got = await claimWithExtension(p, WALLET, NOW);
    assert.equal(got.ok, true, name);
    assert.deepEqual(got.answer, { v: 1, intent: 'claim', ...result(name) }, name);
    assert.deepEqual(p.calls, [{ method: 'qnet_claimNodeBalance' }], name);
  }
});

test('an answer for another wallet, or one the page cannot verify, shows nothing of it', async () => {
  assert.deepEqual(await claimWithExtension(provider(result('claim-ok')), OTHER, NOW), { ok: false, failure: 'other_wallet' });
  for (const bad of [
    { ...result('claim-ok'), v: 1 },
    { ...result('claim-ok'), intent: 'claim' },
    { ...result('claim-ok'), amountNano: '999999999' },
    { ...result('claim-ok'), txHash: 'x' },
    { ...result('claim-ok'), extra: true },
    { status: 'linked' },
    { status: 'error', error: 'BIND_REFUSED' },
    'ok',
    null,
  ]) {
    assert.deepEqual(await claimWithExtension(provider(bad), WALLET, NOW), { ok: false, failure: 'unverifiable' }, JSON.stringify(bad));
  }
});

test('provider failures by code: declined, cooldown, not allowed, too old (update), disconnected, anything else', async () => {
  const failing = (err) => claimWithExtension(provider(() => Promise.reject(err)), WALLET, NOW);
  assert.deepEqual(await failing({ code: 4001, message: 'User rejected' }), { ok: false, failure: 'rejected' });
  assert.deepEqual(await failing({ code: 4001, message: COOLDOWN_MESSAGE }), { ok: false, failure: 'cooldown' });
  assert.deepEqual(await failing({ code: 4100, message: 'x' }), { ok: false, failure: 'unauthorized' });
  assert.deepEqual(await failing({ code: 4200, message: 'Unsupported method' }), { ok: false, failure: 'unsupported' });
  assert.deepEqual(await failing({ code: 4900, message: 'x' }), { ok: false, failure: 'disconnected' });
  assert.deepEqual(await failing({ code: -32603, message: 'x' }), { ok: false, failure: 'failed' });
  assert.deepEqual(await claimWithExtension({ isQNet: true, request() { throw new Error('sync'); } }, WALLET, NOW), { ok: false, failure: 'failed' });
});

test('every error the extension may answer is one the site reads', () => {
  const provider = readFileSync(new URL('../../../../../qnet-wallet/dist/background/provider.js', import.meta.url), 'utf8');
  const set = /const CLAIM_ERRORS = new Set\(\[([^\]]+)\]\);/.exec(provider);
  assert.ok(set, 'the extension\'s claim error list');
  const codes = [...set[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 5);
  for (const c of codes) assert.ok(LINK_ERRORS.claim.includes(c), c);
});

// Contract of 04.10, section 1.9: the extension unlinks its own wallet's node from its device (qnet_unlinkNodeDevice),
// without parameters; its result is the `unlink` answer for the wallet the page shows, `ok` only with the network's
// unbind; an extension without the method answers 4200, which the page reads as one to update.
test('one call of qnet_unlinkNodeDevice without parameters; the answer is the unlink answer of the page\'s wallet', async () => {
  const { unlinkWithExtension } = await import('../qnet-link.ts');
  const { failureKey, unlinkReport } = await import('../cabinet/extension-view.ts');
  const nodeId = result('claim-ok').nodeId;
  for (const answer of [{ status: 'ok', qnet: WALLET, nodeId, unbound: true }, { status: 'error', error: 'NOT_LINKED' }, { status: 'error', error: 'UNLINK_REFUSED' }, { status: 'rejected' }]) {
    const p = provider(answer);
    const got = await unlinkWithExtension(p, WALLET, NOW);
    assert.equal(got.ok, true, JSON.stringify(answer));
    assert.deepEqual(got.answer, { v: 1, intent: 'unlink', ...answer });
    assert.deepEqual(p.calls, [{ method: 'qnet_unlinkNodeDevice' }]);
  }
  assert.deepEqual(await unlinkWithExtension(provider({ status: 'ok', qnet: OTHER, nodeId, unbound: true }), WALLET, NOW), { ok: false, failure: 'unverifiable' });
  assert.deepEqual(await unlinkWithExtension(provider({ status: 'ok', qnet: WALLET, nodeId, unbound: true, extra: 1 }), WALLET, NOW), { ok: false, failure: 'unverifiable' });
  assert.deepEqual(await unlinkWithExtension(provider({ status: 'error', error: 'CLAIM_BUSY' }), WALLET, NOW), { ok: false, failure: 'unverifiable' });
  assert.deepEqual(await unlinkWithExtension(provider(() => Promise.reject({ code: 4200, message: 'Unsupported method' })), WALLET, NOW), { ok: false, failure: 'unsupported' });
  assert.deepEqual(await unlinkWithExtension(provider(() => Promise.reject({ code: 4001, message: 'User rejected' })), WALLET, NOW), { ok: false, failure: 'rejected' });
  // What the page says: the report of each answer and failure.
  assert.equal(unlinkReport({ v: 1, intent: 'unlink', status: 'ok', unbound: true }, 'extension'), 'unlink_answer_ok');
  assert.equal(unlinkReport({ v: 1, intent: 'unlink', status: 'ok', unbound: false }, 'app'), 'unlink_answer_unconfirmed');
  assert.equal(unlinkReport({ v: 1, intent: 'unlink', status: 'error', error: 'NOT_LINKED' }, 'app'), 'unlink_error_NOT_LINKED');
  assert.equal(unlinkReport({ v: 1, intent: 'unlink', status: 'error', error: 'NO_WALLET' }, 'extension'), 'ext_error_NO_WALLET');
  assert.equal(unlinkReport({ v: 1, intent: 'unlink', status: 'rejected' }, 'app'), 'link_answer_rejected');
  assert.equal(failureKey('unsupported', 'unlink'), 'ext_failure_unsupported');
  assert.equal(failureKey('timeout', 'unlink'), 'unlink_failure_timeout');
  assert.equal(failureKey('other_wallet', 'unlink'), 'unlink_failure_other_wallet');
});
