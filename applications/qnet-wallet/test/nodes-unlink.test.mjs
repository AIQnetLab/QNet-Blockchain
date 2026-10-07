// nodes.js, offline: the wallet key's unlink of this wallet's light node from its device (CONTRACTS.md decision 38). The
// view reads the public status of two pinned nodes alike (on chain, the `unbind_wallet` feature, the device it names); the
// action reads the binding's sequence from two nodes' signed status (the wallet key), signs
// q1337|light_unbind_wallet:{N}:{S}:{ts} and sends the unbind to the nodes that agreed. The nodes are simulated; every
// signature the wallet sends is verified here as the node verifies it.
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/chains-activation-loader.mjs', import.meta.url);

const core = await import('../dist/lib/qnet-core.js');
const { QNET } = await import('../dist/background/config.js');
const { WalletError } = await import('../dist/background/errors.js');
const { WALLET, installEnv, installFetch } = await import('./helpers/chains-activation-env.mjs');
const nodes = await import('../dist/background/nodes.js');

const W = WALLET.qnetAddress;
const N = core.lightNodeId(W);
const PK_HEX = core.bytesToHex(WALLET.qnetPublicKey);
const SEQ = 1_790_035_123;
const NOW_S = 1_790_100_000;

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WalletError || error?.name === 'CoreError', `${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: NOW_S * 1000 });
});
afterEach(() => {
  mock.timers.reset();
});

const device = (state = 'online', platform = 'android', since = SEQ - (SEQ % 86400)) => ({
  platform, linked_since: since, last_answer_epoch: 12, state,
});
const publicStatus = ({ listed = true, features = ['status_signed', 'unbind_wallet'], dev = device() } = {}) => ({
  success: true, node_id: N, onchain_registered: listed, registration_pending: false, features, device: listed ? dev : null,
});

/**
 * The pinned nodes: pub(node) → the public status (an object, or an Error for no answer); signed(body, node) → the signed
 * status; unbind(body, node) → {status?, body} or an Error.
 */
function network({ pub = () => publicStatus(), signed = () => ({ node_id: N, device_bound: true, binding_seq: SEQ }), unbind } = {}) {
  const seen = { pub: [], signed: [], unbinds: [] };
  installFetch(async (request) => {
    const url = new URL(request.url);
    if (!QNET.NODES.includes(url.origin)) return undefined;
    if (url.pathname === '/api/v1/light-node/status' && request.method === 'GET') {
      seen.pub.push(url.origin);
      const answer = await pub(url.origin);
      if (answer instanceof Error) throw answer;
      return { body: answer };
    }
    if (url.pathname === '/api/v1/light-node/status' && request.method === 'POST') {
      const body = JSON.parse(request.body);
      seen.signed.push({ node: url.origin, body });
      const answer = await signed(body, url.origin);
      if (answer instanceof Error) throw answer;
      return { body: answer };
    }
    if (url.pathname === '/api/v1/light-node/unbind' && request.method === 'POST') {
      const body = JSON.parse(request.body);
      seen.unbinds.push({ node: url.origin, body, keys: Object.keys(body) });
      const answer = await unbind(body, url.origin);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return undefined;
  });
  return seen;
}

const taken = (body) => ({ body: { success: true, unbound: true, node_id: body.node_id, binding_seq: body.seq, device_released: false } });
const refused = (reason) => ({ body: { success: false, reason, error: 'refused' } });

// What a genesis checks of the wallet-form unbind (light_unbind.rs, decision 38): exactly these keys, this wallet's node
// and key, the sequence it reported, a fresh time, and the wallet key's ML-DSA-65 signature over the wallet-form message.
async function assertUnbindAsNodeChecks(entry, seq = SEQ) {
  assert.deepEqual(entry.keys, ['node_id', 'seq', 'ts', 'signer', 'sig', 'identity_pubkey']);
  const { body } = entry;
  assert.equal(body.node_id, N);
  assert.equal(body.seq, seq);
  assert.equal(body.signer, 'wallet');
  assert.equal(body.identity_pubkey, PK_HEX);
  assert.ok(Math.abs(body.ts - NOW_S) <= 1, 'a fresh time');
  assert.equal(body.sig.length, 3309 * 2);
  const preimage = core.walletUnbindPreimage(N, seq, body.ts);
  assert.equal(preimage, `q1337|light_unbind_wallet:${N}:${seq}:${body.ts}`);
  assert.equal(await core.verifyConsensusSignature(preimage, body.sig, body.identity_pubkey), true, 'the wallet key signed it');
  // the ping form's message signed by the same key is another message: never what is sent
  assert.equal(await core.verifyConsensusSignature(`q1337|light_unbind:${N}:${seq}:${body.ts}`, body.sig, body.identity_pubkey), false);
}

describe('nodes: what the unlink of the light node\'s device offers', () => {
  it('the device two nodes name: its platform and the day it was linked', async () => {
    installEnv();
    const seen = network();
    assert.deepEqual(await nodes.unlinkView(), {
      mode: 'confirm', reason: null, nodeId: N, platform: 'android', linkedSince: SEQ - (SEQ % 86400),
    });
    assert.ok(seen.pub.length >= 2, 'two nodes asked');
    assert.equal(seen.signed.length, 0, 'nothing signed for the view');
    // a genesis that took the binding by gossip names no platform yet: the other node's answer does
    let first = true;
    network({ pub: () => {
      const answer = publicStatus({ dev: device('offline', first ? 'unknown' : 'ios') });
      first = false;
      return answer;
    } });
    assert.equal((await nodes.unlinkView()).platform, 'ios');
    // a device linked less than an epoch ago that has not answered yet is linked all the same
    network({ pub: () => publicStatus({ dev: device('other_device_pending', 'android') }) });
    assert.equal((await nodes.unlinkView()).mode, 'confirm');
  });

  it('NOT_LINKED off chain or with no device, UNSUPPORTED without the feature, NETWORK when no two agree', async () => {
    installEnv();
    const unavailable = (reason) => ({ mode: 'unavailable', reason, nodeId: N, platform: null, linkedSince: null });
    network({ pub: () => publicStatus({ listed: false }) });
    assert.deepEqual(await nodes.unlinkView(), unavailable('NOT_LINKED'));
    network({ pub: () => publicStatus({ dev: device('unlinked', null, null) }) });
    assert.deepEqual(await nodes.unlinkView(), unavailable('NOT_LINKED'));
    network({ pub: () => publicStatus({ features: ['status_signed'] }) });
    assert.deepEqual(await nodes.unlinkView(), unavailable('UNSUPPORTED'));
    network({ pub: () => new TypeError('offline') });
    assert.deepEqual(await nodes.unlinkView(), unavailable('NETWORK'));
    // a node that lists the feature but names no device is no answer
    network({ pub: () => ({ ...publicStatus(), device: null }) });
    assert.deepEqual(await nodes.unlinkView(), unavailable('NETWORK'));
    // each node another word: off chain, no feature, no device, a device, no answer
    const words = [publicStatus({ listed: false }), publicStatus({ features: [] }), publicStatus({ dev: device('unlinked', null, null) }),
      publicStatus(), new TypeError('offline')];
    network({ pub: (node) => words[QNET.NODES.indexOf(node)] });
    assert.equal((await nodes.unlinkView()).reason, 'NETWORK', 'no two alike');
  });

  it('refuses while locked, and offers nothing with signing disabled', async () => {
    const env = installEnv({ locked: true });
    network();
    await rejectsWith(nodes.unlinkView(), 'LOCKED');
    env.locked = false;
    env.keys.signingEnabled = () => false;
    assert.equal((await nodes.unlinkView()).reason, 'SIGNING_DISABLED');
  });
});

describe('nodes: the wallet key unlinks the light node\'s device', () => {
  it('signs the binding two nodes report and sends the unbind to the node that reported it, then to the other', async () => {
    const env = installEnv();
    const seen = network({ unbind: taken });
    assert.deepEqual(await nodes.unlinkForSite(), { status: 'ok', qnet: W, nodeId: N, unbound: true });
    assert.equal(env.calls.signNodeStatus, 1, 'one signed status request, with the wallet key');
    assert.deepEqual(Object.keys(seen.signed[0].body), ['node_id', 'ts', 'signer', 'sig', 'identity_pubkey']);
    assert.equal(seen.signed[0].body.signer, 'wallet');
    assert.equal(env.calls.signNodeUnbind, 1);
    assert.equal(seen.unbinds.length, 2);
    const agreed = seen.signed.map((entry) => entry.node).slice(0, 2);
    assert.deepEqual(seen.unbinds.map((entry) => entry.node), agreed, 'the two nodes whose status gave the sequence');
    for (const entry of seen.unbinds) await assertUnbindAsNodeChecks(entry);
  });

  it('the first node silent: the second one\'s taking is the unlink; neither answering is NETWORK', async () => {
    installEnv();
    let calls = 0;
    network({ unbind: (body) => {
      calls += 1;
      return calls === 1 ? new TypeError('offline') : taken(body);
    } });
    assert.equal((await nodes.unlinkForSite()).unbound, true);
    installEnv();
    network({ unbind: () => new TypeError('offline') });
    await rejectsWith(nodes.unlinkForSite(), 'NETWORK');
  });

  it('no device bound at two nodes is NOT_LINKED, no two alike is NETWORK: nothing signed', async () => {
    let env = installEnv();
    let seen = network({ signed: () => ({ node_id: N, device_bound: false, binding_seq: SEQ }), unbind: taken });
    await rejectsWith(nodes.unlinkForSite(), 'NOT_LINKED');
    assert.equal(env.calls.signNodeUnbind, 0);
    assert.equal(seen.unbinds.length, 0);
    env = installEnv();
    let n = 0;
    seen = network({ signed: () => {
      n += 1;
      return { node_id: N, device_bound: true, binding_seq: SEQ + n };
    }, unbind: taken });
    await rejectsWith(nodes.unlinkForSite(), 'NETWORK');
    assert.equal(env.calls.signNodeUnbind, 0);
    // another node's answer, or a sequence no JSON number carries exactly, is no answer
    env = installEnv();
    seen = network({ signed: (body, node) => ({ node_id: 'light_mobile_0000000000000000', device_bound: true, binding_seq: SEQ, node }), unbind: taken });
    await rejectsWith(nodes.unlinkForSite(), 'NETWORK');
    env = installEnv();
    network({ signed: () => ({ node_id: N, device_bound: true, binding_seq: '18446744073709551615' }), unbind: taken });
    await rejectsWith(nodes.unlinkForSite(), 'NETWORK');
    assert.equal(env.calls.signNodeUnbind, 0);
  });

  it('stale_seq: read again, done when two nodes now say no device is bound, else UNLINK_REFUSED', async () => {
    installEnv();
    let bound = true;
    network({
      signed: () => ({ node_id: N, device_bound: bound, binding_seq: SEQ }),
      unbind: () => {
        bound = false;
        return refused('stale_seq');
      },
    });
    assert.equal((await nodes.unlinkForSite()).unbound, true);
    installEnv();
    network({ unbind: () => refused('stale_seq') });
    await rejectsWith(nodes.unlinkForSite(), 'UNLINK_REFUSED');
  });

  it('any other refusal is UNLINK_REFUSED; one node taking it is enough', async () => {
    for (const reason of ['bad_signature', 'identity_mismatch', 'expired', 'rate_limited', 'not_registered', 'bad_request']) {
      installEnv();
      network({ unbind: () => refused(reason) });
      await rejectsWith(nodes.unlinkForSite(), 'UNLINK_REFUSED');
    }
    installEnv();
    let calls = 0;
    network({ unbind: (body) => {
      calls += 1;
      return calls === 1 ? refused('rate_limited') : taken(body);
    } });
    assert.equal((await nodes.unlinkForSite()).unbound, true);
    // an HTTP refusal is a refusal too
    installEnv();
    network({ unbind: () => ({ status: 400, body: 'bad' }) });
    await rejectsWith(nodes.unlinkForSite(), 'UNLINK_REFUSED');
  });

  it('refuses while locked', async () => {
    installEnv({ locked: true });
    network({ unbind: taken });
    await rejectsWith(nodes.unlinkForSite(), 'LOCKED');
  });
});
