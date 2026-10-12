// Unlinking the light node's device with the QNet extension (contract of 04.10, section 1.9; docs/protocols/qnet-link-v1.md
// section 14.10; unlinkWithExtension in src/lib/qnet-link.ts): the one method, no parameters, the result checked as the
// `unlink` answer for the wallet the page shows, and what the page says of each answer and failure. Moving a node
// balance is cabinet-claim.test.mjs. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightNodeId, unlinkWithExtension } from '../qnet-link.ts';
import { failureKey, unlinkReport } from '../cabinet/extension-view.ts';
import { LINK } from './link-helpers.mjs';

const NOW = 1_790_000_060;
const WALLET = JSON.parse(LINK.cases.find((c) => c.name === 'unlink-ok').plaintext).qnet;
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

// The extension unlinks its own wallet's node from its device (qnet_unlinkNodeDevice), without parameters; its result is
// the `unlink` answer for the wallet the page shows, `ok` only with the network's unbind; an extension without the
// method answers 4200, which the page reads as one to update.
test('one call of qnet_unlinkNodeDevice without parameters; the answer is the unlink answer of the page\'s wallet', async () => {
  const nodeId = lightNodeId(WALLET);
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
  assert.deepEqual(await unlinkWithExtension(provider({ status: 'empty', qnet: WALLET, nodeId }), WALLET, NOW), { ok: false, failure: 'unverifiable' });
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
