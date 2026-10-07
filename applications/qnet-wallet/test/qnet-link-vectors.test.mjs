// QNet Link v1 shared vectors (docs/protocols/qnet-link-v1.vectors.json), the extension's side (XP-R3-07): the
// site and the app pin their answers to these vectors; so does the extension, whose qnet_activateNode result is
// the same answer (section 10: {v: 1, intent: 'activate', ...result} is what the site validates). The error list,
// the activation code derivation and the exact answers of the ok, exists, pending and error cases must match.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../dist/lib/qnet-core.js';
import { WalletError } from '../dist/background/errors.js';
import { SITE_ERROR_CODES } from '../dist/background/provider.js';
import { ACCOUNTS, SITE, createWorld, replyTo } from './helpers/provider-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(path.join(HERE, '../../../docs/protocols/qnet-link-v1.vectors.json'), 'utf8'));
const activateCases = VECTORS.cases.filter((c) => c.intent === 'activate');

// The extension's answer to a qnet_activateNode request of `nodeType` whose activation outcome is `outcome`.
async function siteAnswer(nodeType, { outcome = null, error = null }) {
  const w = createWorld();
  w.state.activateOutcome = outcome;
  w.state.activateError = error;
  const port = w.connect(`${SITE}/`);
  port.send({ id: 'a', method: 'qnet_activateNode', params: { nodeType } });
  const shown = await w.shown();
  await shown.get();
  await shown.resolve(true);
  const reply = await replyTo(port, 'a');
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return { v: 1, intent: 'activate', ...reply.result };
}

describe('QNet Link v1 shared vectors (XP-R3-07)', () => {
  it('the vectors are the extension wallet\'s: the same QNet and Solana addresses', () => {
    assert.deepEqual(VECTORS.wallet, ACCOUNTS);
  });

  it('the error codes a site answer may carry are exactly the protocol\'s', () => {
    assert.deepEqual([...SITE_ERROR_CODES].sort(), [...VECTORS.constants.errors].sort());
    assert.ok(VECTORS.constants.statuses.activate.includes('pending'));
  });

  it('derives the activation code of the known-answer test and of every case', () => {
    const k = VECTORS.activationCodeKat;
    assert.equal(core.generateActivationCode(k.nodeType, k.solanaAddress, k.burnTx, k.burnAmount), k.code);
    for (const c of VECTORS.cases) {
      const answer = JSON.parse(c.plaintext);
      if (typeof answer.code !== 'string') continue;
      assert.equal(core.generateActivationCode(answer.nodeType, answer.solana, answer.burnTx, answer.burnAmount), answer.code, c.name);
    }
  });

  it('names a burn of aiqnet.io\'s payment key by the wallet\'s QNet address, exactly as the vectors (section 3)', () => {
    const w = VECTORS.walletActivationCodeKat;
    assert.equal(w.qnetAddress, ACCOUNTS.qnet);
    assert.equal(core.walletActivationCode(w.qnetAddress, w.burnTx, w.burnAmount), w.code);
    assert.notEqual(w.code, VECTORS.activationCodeKat.code);
  });

  it('answers the ok, exists, pending and error cases exactly as the vectors (section 7 and 10)', async () => {
    let checked = 0;
    for (const c of activateCases) {
      const expected = JSON.parse(c.plaintext);
      let answer = null;
      if (expected.status === 'ok' || expected.status === 'exists') {
        const activation = {
          code: expected.code, nodeType: expected.nodeType, burnTx: expected.burnTx, burnAmount: expected.burnAmount,
          solanaAddress: expected.solana, cluster: 'devnet', createdAt: 1_790_000_000_000,
        };
        // the burn this device sent that another device's older burn beat (section 7.1): activation.activateForSite's
        // `superseded`, whatever its own node type
        const superseded = expected.supersededBurnTx === undefined ? {} : {
          superseded: {
            burnTx: expected.supersededBurnTx, nodeType: c.nodeType, burnAmount: 5000, solanaAddress: expected.solana, cluster: 'devnet',
            createdAt: 1,
          },
        };
        answer = await siteAnswer(c.nodeType, { outcome: { status: expected.status, activation, ...superseded } });
      } else if (expected.status === 'pending') {
        const pending = { burnTx: expected.burnTx, nodeType: expected.nodeType, burnAmount: expected.burnAmount, solanaAddress: expected.solana };
        answer = await siteAnswer(c.nodeType, { outcome: { status: 'pending', pending } });
      } else if (expected.status === 'error') {
        answer = await siteAnswer(c.nodeType, { error: new WalletError(expected.error) });
      } else {
        // 'rejected' reaches a dApp as the provider's 4001, which the site reads as rejected
        continue;
      }
      assert.deepEqual(answer, expected, c.name);
      checked += 1;
    }
    assert.ok(checked >= 5, `cases checked: ${checked}`);
  });

  it('never names a superseded burn of another address, or the answered burn itself', async () => {
    const stranger = core.solanaAddressFromPublicKey(new Uint8Array(32).fill(4));
    const mine = JSON.parse(VECTORS.cases.find((c) => c.name === 'activate-super-exists-superseded').plaintext);
    const superseded = {
      burnTx: mine.supersededBurnTx, nodeType: 'super', burnAmount: 5000, solanaAddress: ACCOUNTS.solana, cluster: 'devnet', createdAt: 1,
    };
    const own = {
      code: mine.code, nodeType: mine.nodeType, burnTx: mine.burnTx, burnAmount: mine.burnAmount, solanaAddress: mine.solana, cluster: 'devnet',
      createdAt: 1,
    };
    for (const other of [{ ...superseded, solanaAddress: stranger }, { ...superseded, burnTx: mine.burnTx }, { ...superseded, burnTx: 'x' }]) {
      const answer = await siteAnswer('super', { outcome: { status: 'exists', activation: own, superseded: other } });
      assert.equal(Object.hasOwn(answer, 'supersededBurnTx'), false, JSON.stringify(other).slice(0, 60));
    }
  });
});
