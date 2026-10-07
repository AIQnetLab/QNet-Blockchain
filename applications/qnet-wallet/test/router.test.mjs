// Router: who may send what (R09, EXT-SEC-06, MISS-02), the exact shape of every message, the provider
// port (origin from the sender only, method allow-list, dApp message and fee rules), and the result
// guard that keeps secrets out of every response.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../dist/lib/qnet-core.js';
import { LIMITS } from '../dist/background/config.js';
import { ProviderError, WalletError } from '../dist/background/errors.js';
import {
  CALL_ARGS_MAX_BYTES, PROVIDER_METHODS, PROVIDER_RESULT_KEY_EXCEPTIONS, RESULT_KEY_EXCEPTIONS, SECRET_RESULT_KEYS, UI_MESSAGES, createRouter,
  isActivationOrigin, isCanonicalOrigin, isSafeResult, isU64String, normalizeTransaction, originMatchesPattern, providerOriginOf,
  relayMatchPatterns, uiPageOf, validateParams,
} from '../dist/background/router.js';
import {
  OTHER_EXTENSION_ID, contentScriptSender, createPort, createRuntime, pageSender, until,
} from './helpers/chrome-mock.mjs';

const MANIFEST = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
const DEV_MANIFEST = structuredClone(MANIFEST);
for (const script of DEV_MANIFEST.content_scripts) {
  script.matches.push(`${'http'}://localhost/*`, `${'http'}://127.0.0.1/*`);
}

const QNET = core.KAT.qnetAddress;
const SOL = core.KAT.solanaAddress;
const QNET_TOKEN = core.qnetAddressFromPublicKey(new Uint8Array(1952).fill(3));
const SOL_SIGNATURE = core.KAT.activation.burnTx;
// Five distinct Solana addresses: a payment request carries at most four references.
const REFERENCES = [1, 2, 3, 4, 5].map((n) => core.solanaAddressFromPublicKey(new Uint8Array(32).fill(n)));
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SITE = 'https://aiqnet.io';
// A second dApp origin: the store manifest names aiqnet.io only (R4-ERP-02), so the test manifest adds this host,
// as the dev overlay adds loopback.
const APP = 'https://dapp.qnet.test';
const APP_MANIFEST = structuredClone(MANIFEST);
for (const script of APP_MANIFEST.content_scripts) script.matches.push(`${APP}/*`);

// Valid params for every UI type: adding a type without a line here fails the coverage test.
const VALID = Object.freeze({
  'vault.status': {},
  'vault.create': { mnemonic: core.KAT.mnemonic, password: 'correct horse battery' },
  'vault.import': { mnemonic: `  ${core.KAT.mnemonic.replaceAll(' ', '\n')} `, password: 'correct horse battery' },
  // the wallet an earlier version kept (M-4): moved with its password and a new one; removed only once confirmed
  'vault.migrate': { password: 'the old one', newPassword: 'a much longer one' },
  'vault.removeEarlier': { confirm: 'REMOVE' },
  'vault.unlock': { password: 'x' },
  'vault.lock': {},
  'vault.changePassword': { password: 'old', newPassword: 'a much longer one' },
  'vault.reveal': { password: 'pw' },
  // the private key of one account, behind the password as the phrase (owner, 06.10)
  'vault.exportKey': { password: 'pw', network: 'qnet' },
  'vault.wipe': { password: 'pw', confirm: 'DELETE' },
  'vault.restoreBegin': {},
  'vault.restore': { token: 'ab'.repeat(32), mnemonic: core.KAT.mnemonic, password: 'correct horse battery' },
  'wallet.addresses': {},
  // the popup's view cache and the Solana History (decision 39)
  'wallet.cached': {},
  'qnet.balance': {},
  'qnet.history': { cursor: null, limit: 20 },
  'qnet.preview': { to: QNET, amount: '1.5' },
  // the wallet's built-in tokens, the popup's token send and the History detail's lookup (owner, 06.10)
  'qnet.tokens': {},
  'qnet.tokenPreview': { token: QNET_TOKEN, to: QNET, amount: '2.25' },
  'qnet.tokenSend': { token: QNET_TOKEN, to: QNET, amount: '2.25', expectedFeeNano: '4509375', expectedDepositNano: '0', expectedNonce: '8' },
  'qnet.txLookup': { hash: 'ab'.repeat(32) },
  'qnet.send': { to: QNET, amount: '0.000000001', expectedFeeNano: '150000', expectedNonce: '7' },
  'solana.balances': {},
  'solana.history': { cursor: null, limit: 10 },
  'solana.quote': { asset: '1dev', to: SOL, amount: '12.5' },
  'solana.send': { asset: 'sol', to: SOL, amount: '0.001', expectedFeeLamports: '5000', expectedRentLamports: '0' },
  'solana.max': { asset: '1dev', to: SOL },
  'solana.status': { signature: SOL_SIGNATURE, lastValidBlockHeight: 300 },
  'activation.status': {},
  'activation.lookup': {},
  'activation.price': {},
  // no password for the popup's own burn, code and record (decision 33)
  'activation.burn': { nodeType: 'light', expectedPrice: 1500 },
  'activation.recover': {},
  'activation.copy': {},
  'activation.register': {},
  'activation.registration': {},
  // the light node's device: what the Activate tab offers and its Unlink (decision 38)
  'node.unlinkView': {},
  'node.unlink': {},
  'sites.list': {},
  'sites.revoke': { origin: SITE },
  'settings.get': {},
  'settings.set': { autoLockMinutes: 30 },
  'approval.get': { id: UUID },
  'approval.resolve': { id: UUID, approved: true },
});

// The privileged types the spec lists (Messaging); all must exist and none may be reachable from a page.
const SPEC_TYPES = [
  'vault.status', 'vault.create', 'vault.import', 'vault.unlock', 'vault.lock', 'vault.changePassword',
  'vault.reveal', 'vault.wipe', 'wallet.addresses', 'qnet.balance', 'qnet.history', 'qnet.send',
  'solana.balances', 'solana.send', 'activation.status', 'activation.price', 'activation.burn',
  'activation.recover', 'activation.copy', 'sites.list', 'sites.revoke', 'settings.get', 'settings.set',
  'approval.get', 'approval.resolve',
];

const PAGES = ['popup', 'setup', 'approve'];
const firstPage = (type) => UI_MESSAGES[type].pages[0];

function harness({ manifest = APP_MANIFEST, unlocked = true, handlers = {}, providerRequest, touchFails = false } = {}) {
  const runtime = createRuntime({ manifest });
  const h = { runtime, calls: [], providerCalls: [], closed: [], unlockChecks: 0, touches: 0 };
  const stubs = {};
  for (const type of Object.keys(UI_MESSAGES)) {
    stubs[type] = async (params, meta) => {
      h.calls.push({ type, params, meta });
      return { handled: type };
    };
  }
  h.router = createRouter({
    runtime,
    handlers: { ...stubs, ...handlers },
    requireUnlocked: async () => {
      h.unlockChecks += 1;
      if (!unlocked) throw new WalletError('LOCKED');
    },
    touch: async () => {
      h.touches += 1;
      if (touchFails) throw new Error('storage gone');
    },
    providerRequest: providerRequest ?? (async (ctx, method, params) => {
      h.providerCalls.push({ ctx, method, params });
      return { method };
    }),
    providerPortClosed: async (ctx) => {
      h.closed.push(ctx);
    },
  });
  h.ui = (page, type, params, extra = {}) => h.router.handleUiMessage(
    { type, id: 'req-1', params, ...extra },
    typeof page === 'string' ? pageSender(runtime, page) : page,
  );
  h.connect = (url, { name, sender } = {}) => {
    const port = createPort({ name, sender: sender ?? contentScriptSender(url) });
    h.router.handleProviderConnect(port);
    return port;
  };
  return h;
}

async function ask(port, message) {
  const before = port.posted.length;
  port.send(message);
  await until(() => port.posted.length > before);
  return port.posted.at(-1);
}

const errorOf = (reply) => {
  assert.equal(reply.ok, false, `expected an error, got ${JSON.stringify(reply)}`);
  return reply.error;
};

describe('router: message table', () => {
  it('covers exactly the tested types and every type the spec lists', () => {
    assert.deepEqual(Object.keys(UI_MESSAGES).sort(), Object.keys(VALID).sort());
    for (const type of SPEC_TYPES) assert.ok(Object.hasOwn(UI_MESSAGES, type), type);
    assert.deepEqual(Object.keys(PROVIDER_METHODS).sort(), [
      'qnet_accounts', 'qnet_activateNode', 'qnet_chainId', 'qnet_claimNodeBalance', 'qnet_disconnect', 'qnet_getActivation',
      'qnet_getTransactionStatus', 'qnet_requestAccounts', 'qnet_sendTransaction', 'qnet_signMessage', 'qnet_unlinkNodeDevice',
    ]);
  });

  it('keeps approval.resolve and approval.get to the approve page, setup types to setup, secrets to the popup', () => {
    assert.deepEqual(UI_MESSAGES['approval.resolve'].pages, ['approve']);
    assert.deepEqual(UI_MESSAGES['approval.get'].pages, ['approve']);
    assert.deepEqual(UI_MESSAGES['vault.create'].pages, ['setup']);
    assert.deepEqual(UI_MESSAGES['vault.import'].pages, ['setup']);
    assert.deepEqual(UI_MESSAGES['vault.migrate'].pages, ['setup']);
    assert.deepEqual(UI_MESSAGES['vault.removeEarlier'].pages, ['setup', 'popup']);
    for (const type of ['vault.reveal', 'vault.wipe', 'vault.changePassword', 'vault.restoreBegin', 'vault.restore',
      'activation.burn', 'activation.copy', 'activation.register', 'activation.lookup', 'qnet.send', 'solana.send', 'solana.max',
      'solana.status', 'sites.revoke', 'node.unlinkView', 'node.unlink', 'wallet.cached', 'solana.history']) {
      assert.deepEqual(UI_MESSAGES[type].pages, ['popup'], type);
    }
    // the activation window reads the light node's registration after its answer; nothing else reaches it from there
    assert.deepEqual(UI_MESSAGES['activation.registration'].pages, ['popup', 'approve']);
  });

  it('requires an unlocked session for every type that reads the wallet or spends', () => {
    for (const type of ['vault.changePassword', 'vault.reveal', 'wallet.addresses', 'qnet.balance', 'qnet.history',
      'qnet.preview', 'qnet.send', 'solana.balances', 'solana.quote', 'solana.send', 'solana.max', 'solana.status', 'activation.status',
      'activation.lookup', 'activation.price', 'activation.burn', 'activation.recover', 'activation.copy', 'activation.register',
      'activation.registration', 'sites.list', 'sites.revoke', 'settings.set', 'node.unlinkView', 'node.unlink', 'wallet.cached',
      'solana.history', 'vault.removeEarlier']) {
      assert.equal(UI_MESSAGES[type].unlocked, true, type);
    }
    // the unlink signs: a success extends the auto-lock deadline as the popup's other node actions do
    assert.equal(UI_MESSAGES['node.unlink'].activity, true);
  });
});

describe('router: extension-page senders', () => {
  it('dispatches every type from each allowed page with normalized params and sender meta', async () => {
    const h = harness();
    for (const [type, entry] of Object.entries(UI_MESSAGES)) {
      for (const page of entry.pages) {
        h.calls.length = 0;
        const sender = pageSender(h.runtime, page, page === 'approve' ? { query: `?id=${UUID}` } : {});
        const reply = await h.router.handleUiMessage({ type, id: 'a1', params: VALID[type] }, sender);
        assert.deepEqual(reply, { id: 'a1', ok: true, result: { handled: type } }, `${type} from ${page}`);
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.calls[0].params, VALID[type]);
        assert.equal(h.calls[0].meta.page, page);
        assert.equal(h.calls[0].meta.sender, sender);
        assert.ok(Object.isFrozen(h.calls[0].meta));
      }
    }
  });

  it('rejects every type from an extension page it is not meant for', async () => {
    const h = harness();
    for (const [type, entry] of Object.entries(UI_MESSAGES)) {
      for (const page of PAGES.filter((p) => !entry.pages.includes(p))) {
        const reply = await h.ui(page, type, VALID[type]);
        assert.equal(errorOf(reply).code, 'FORBIDDEN_SENDER', `${type} from ${page}`);
      }
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.unlockChecks, 0);
  });

  it('rejects every type from a content script on the dApp site or any web page', async () => {
    const h = harness();
    const senders = [
      contentScriptSender(`${SITE}/wallet`),
      contentScriptSender(`${APP}/`),
      contentScriptSender('https://evil.example/'),
      // a web frame can claim nothing, but even a sender naming an extension URL from a web tab is refused
      { ...contentScriptSender('https://evil.example/'), url: h.runtime.getURL('ui/popup.html') },
    ];
    for (const sender of senders) {
      for (const type of Object.keys(UI_MESSAGES)) {
        const reply = await h.router.handleUiMessage({ type, id: 'x', params: VALID[type] }, sender);
        assert.equal(errorOf(reply).code, 'FORBIDDEN_SENDER', `${type} from ${sender.url}`);
      }
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.unlockChecks, 0);
  });

  it('rejects forged or foreign extension senders', async () => {
    const h = harness();
    const popup = pageSender(h.runtime, 'popup');
    const other = createRuntime({ id: OTHER_EXTENSION_ID });
    const cases = {
      'other extension': pageSender(other, 'popup'),
      'other extension id, our url': { ...popup, id: OTHER_EXTENSION_ID },
      'worker url': pageSender(h.runtime, 'background/sw.js', { tab: false }),
      'bundle url': pageSender(h.runtime, 'lib/qnet-core.js', { tab: false }),
      'common.js url': pageSender(h.runtime, 'ui/common.js', { tab: false }),
      'unknown page': pageSender(h.runtime, 'ui/popup.htm', { tab: false }),
      'page outside ui/': pageSender(h.runtime, 'popup.html', { tab: false }),
      'setup page outside ui/': pageSender(h.runtime, 'setup.html'),
      'web origin on an extension url': { ...popup, origin: SITE },
      'subframe': pageSender(h.runtime, 'setup', { frameId: 2 }),
      'web tab url': { ...pageSender(h.runtime, 'setup'), tab: { id: 7, url: `${SITE}/` } },
      'web url': { id: h.runtime.id, url: `${SITE}/ui/popup.html`, origin: SITE },
      'no url': { id: h.runtime.id },
      'null sender': null,
      'string sender': 'popup',
    };
    for (const [name, sender] of Object.entries(cases)) {
      const reply = await h.router.handleUiMessage({ type: 'vault.unlock', id: 'f', params: { password: 'pw' } }, sender);
      assert.equal(errorOf(reply).code, 'FORBIDDEN_SENDER', name);
    }
    assert.equal(h.calls.length, 0);
  });

  it('accepts the popup opened as a tab and the approve window with its query', async () => {
    const h = harness();
    const tabPopup = pageSender(h.runtime, 'popup', { tab: true });
    assert.equal(uiPageOf(tabPopup, h.runtime), 'popup');
    assert.equal(uiPageOf(pageSender(h.runtime, 'approve', { query: `?id=${UUID}#x` }), h.runtime), 'approve');
    assert.equal(uiPageOf(pageSender(h.runtime, 'setup'), h.runtime), 'setup');
  });
});

describe('router: UI message schema', () => {
  it('rejects malformed envelopes', async () => {
    const h = harness();
    const popup = pageSender(h.runtime, 'popup');
    const envelopes = [
      null, undefined, 'vault.status', 42, [], ['vault.status'],
      { type: 'vault.status' },
      { type: 'vault.status', id: 'has space' },
      { type: 'vault.status', id: -1 },
      { type: 'vault.status', id: 1.5 },
      { type: 'vault.status', id: 'x'.repeat(65) },
      { type: 'vault.status', id: 'a', params: {}, extra: true },
      { type: 42, id: 'a' },
      { type: 'vault', id: 'a' },
      { type: 'Vault.status', id: 'a' },
      { type: '__proto__', id: 'a' },
      { type: 'vault.status', id: 'a', params: { pad: 'x'.repeat(LIMITS.UI_MESSAGE_MAX_CHARS) } },
      JSON.parse('{"type":"vault.status","id":"a","__proto__":{"type":"vault.reveal"}}'),
    ];
    for (const message of envelopes) {
      const reply = await h.router.handleUiMessage(message, popup);
      assert.equal(errorOf(reply).code, 'INVALID_REQUEST', JSON.stringify(message)?.slice(0, 80));
    }
    assert.equal(h.calls.length, 0);
  });

  it('rejects unknown types, including prototype names', async () => {
    const h = harness();
    for (const type of ['vault.export', 'vault.constructor', 'vault.toString', 'vault.hasOwnProperty', 'wallet.setState',
      'wallet.sign', 'qnet.sign', 'solana.sign', 'solana.signMessage', 'activation.export', 'node.status']) {
      const reply = await h.ui('popup', type, {});
      assert.equal(errorOf(reply).code, 'UNKNOWN_TYPE', type);
    }
    assert.equal(h.calls.length, 0);
  });

  it('rejects bad params field by field, before the lock check and the handler', async () => {
    const h = harness();
    const badQnet = `${QNET.slice(0, -1)}${QNET.endsWith('0') ? '1' : '0'}`;
    const proto = JSON.parse('{"password":"x","__proto__":{"admin":true}}');
    const cases = [
      ['vault.unlock', {}, 'password'],
      ['vault.unlock', { password: '' }, 'password'],
      ['vault.unlock', { password: 12345 }, 'password'],
      ['vault.unlock', { password: 'x'.repeat(LIMITS.PASSWORD_MAX_CHARS + 1) }, 'password'],
      ['vault.unlock', { password: 'x', remember: true }, 'remember'],
      ['vault.unlock', proto, '__proto__'],
      ['vault.create', { mnemonic: core.KAT.mnemonic }, 'password'],
      ['vault.create', { mnemonic: 'x'.repeat(LIMITS.MNEMONIC_MAX_CHARS + 1), password: 'pw' }, 'mnemonic'],
      // import is 12 or 24 words and a password, nothing else
      ['vault.import', { mnemonic: core.KAT.mnemonic, password: 'pw', code: '4000-0247' }, 'code'],
      ['vault.wipe', { password: 'pw', confirm: 'DELETE', discard: true }, 'discard'],
      ['vault.wipe', { password: 'pw', confirm: 'delete' }, 'confirm'],
      ['vault.wipe', { password: 'pw' }, 'confirm'],
      // a reset starts with no typed word; the confirmation goes with the replacing vault.restore
      ['vault.restoreBegin', { confirm: 'ERASE' }, 'confirm'],
      ['vault.restore', { ...VALID['vault.restore'], token: undefined }, 'token'],
      ['vault.restore', { ...VALID['vault.restore'], token: 'AB'.repeat(32) }, 'token'],
      ['vault.restore', { ...VALID['vault.restore'], token: 'ab'.repeat(31) }, 'token'],
      ['vault.restore', { ...VALID['vault.restore'], confirm: 'erase' }, 'confirm'],
      ['vault.restore', { ...VALID['vault.restore'], confirm: true }, 'confirm'],
      ['vault.restore', { ...VALID['vault.restore'], confirm: 'DELETE' }, 'confirm'],
      ['vault.restore', { ...VALID['vault.restore'], replaceOther: 'yes' }, 'replaceOther'],
      ['vault.restore', { ...VALID['vault.restore'], mnemonic: '' }, 'mnemonic'],
      ['vault.changePassword', { password: 'pw', newPassword: null }, 'newPassword'],
      ['qnet.send', { ...VALID['qnet.send'], to: badQnet }, 'to'],
      ['qnet.send', { ...VALID['qnet.send'], to: QNET.toUpperCase() }, 'to'],
      ['qnet.send', { ...VALID['qnet.send'], gasPrice: '1000000' }, 'gasPrice'],
      ['qnet.send', { ...VALID['qnet.send'], nonce: '1' }, 'nonce'],
      ['qnet.send', { ...VALID['qnet.send'], expectedFeeNano: '0150000' }, 'expectedFeeNano'],
      ['qnet.send', { ...VALID['qnet.send'], expectedFeeNano: '18446744073709551616' }, 'expectedFeeNano'],
      ['qnet.send', { ...VALID['qnet.send'], expectedFeeNano: 150000 }, 'expectedFeeNano'],
      ['qnet.send', { ...VALID['qnet.send'], expectedNonce: '-1' }, 'expectedNonce'],
      ['qnet.send', { ...VALID['qnet.send'], expectedNonce: null }, 'expectedNonce'],
      ['solana.send', { ...VALID['solana.send'], asset: 'usdc' }, 'asset'],
      ['solana.send', { ...VALID['solana.send'], to: '0OIl'.repeat(9) }, 'to'],
      ['solana.send', { ...VALID['solana.send'], expectedRentLamports: undefined }, 'expectedRentLamports'],
      ['solana.quote', { ...VALID['solana.quote'], amount: '1e3' }, 'amount'],
      // a payment request's parts (decision 34): at most four distinct addresses, and a memo of plain text within 200 bytes
      ['solana.quote', { ...VALID['solana.quote'], references: [SOL, SOL] }, 'references'],
      ['solana.quote', { ...VALID['solana.quote'], references: REFERENCES }, 'references'],
      ['solana.quote', { ...VALID['solana.quote'], references: ['0OIl'.repeat(9)] }, 'references'],
      ['solana.quote', { ...VALID['solana.quote'], references: SOL }, 'references'],
      ['solana.send', { ...VALID['solana.send'], references: null }, 'references'],
      ['solana.send', { ...VALID['solana.send'], memo: '' }, 'memo'],
      ['solana.send', { ...VALID['solana.send'], memo: 'é'.repeat(101) }, 'memo'],
      ['solana.send', { ...VALID['solana.send'], memo: 'a\u202eb' }, 'memo'],
      ['solana.send', { ...VALID['solana.send'], memo: 'a\nb' }, 'memo'],
      ['solana.send', { ...VALID['solana.send'], memo: 'a\uD800b' }, 'memo'],
      ['solana.send', { ...VALID['solana.send'], memo: null }, 'memo'],
      ['solana.max', { asset: 'sol', memo: 'x' }, 'memo'],
      ['activation.burn', { ...VALID['activation.burn'], nodeType: 'Light' }, 'nodeType'],
      ['activation.burn', { ...VALID['activation.burn'], nodeType: 'full' }, 'nodeType'],
      ['activation.burn', { ...VALID['activation.burn'], expectedPrice: 1500.5 }, 'expectedPrice'],
      ['activation.burn', { ...VALID['activation.burn'], expectedPrice: '1500' }, 'expectedPrice'],
      ['activation.burn', { ...VALID['activation.burn'], expectedPrice: 0 }, 'expectedPrice'],
      ['activation.burn', { ...VALID['activation.burn'], amount: 1500 }, 'amount'],
      // the popup's burn, code and record take no password (decision 33): one sent is refused like any unknown field
      ['activation.burn', { ...VALID['activation.burn'], password: 'pw' }, 'password'],
      ['activation.copy', { password: 'pw' }, 'password'],
      ['activation.register', { password: 'pw' }, 'password'],
      ['solana.max', { asset: 'usdc' }, 'asset'],
      ['solana.max', { asset: 'sol', to: '0OIl'.repeat(9) }, 'to'],
      ['solana.max', { asset: 'sol', amount: '1' }, 'amount'],
      ['solana.status', { signature: 'nope' }, 'signature'],
      ['solana.status', { signature: '1'.repeat(89) }, 'signature'],
      ['solana.status', { ...VALID['solana.status'], lastValidBlockHeight: -1 }, 'lastValidBlockHeight'],
      ['solana.status', { ...VALID['solana.status'], lastValidBlockHeight: '300' }, 'lastValidBlockHeight'],
      ['solana.status', { ...VALID['solana.status'], commitment: 'processed' }, 'commitment'],
      ['settings.set', { autoLockMinutes: 0 }, 'autoLockMinutes'],
      ['settings.set', { autoLockMinutes: 120 }, 'autoLockMinutes'],
      ['settings.set', { autoLockMinutes: '15' }, 'autoLockMinutes'],
      ['settings.set', { autoLockMinutes: null }, 'autoLockMinutes'],
      ['settings.set', { autoLockMinutes: 'Never' }, 'autoLockMinutes'],
      ['settings.set', { language: 'xx' }, 'language'],
      ['settings.set', { language: 'zh' }, 'language'],
      ['settings.set', { language: 'EN' }, 'language'],
      ['approval.get', { id: 'not-a-uuid' }, 'id'],
      ['approval.get', { id: UUID.toUpperCase() }, 'id'],
      ['approval.resolve', { id: UUID, approved: 'yes' }, 'approved'],
      // no approval takes a password: the unlocked session and the armed press in its own window confirm
      ['approval.resolve', { id: UUID, approved: true, password: '' }, 'password'],
      ['approval.resolve', { id: UUID, approved: true, password: 'correct horse battery' }, 'password'],
      ['approval.resolve', { id: UUID, approved: true, password: 'x'.repeat(LIMITS.PASSWORD_MAX_CHARS + 1) }, 'password'],
      ['sites.revoke', { origin: `${SITE}/` }, 'origin'],
      ['sites.revoke', { origin: `${'http'}://aiqnet.io` }, 'origin'],
      ['sites.revoke', { origin: 'javascript:alert(1)' }, 'origin'],
      ['sites.revoke', { origin: 'https://AIQNET.io' }, 'origin'],
      ['qnet.history', { limit: 0 }, 'limit'],
      ['qnet.history', { limit: LIMITS.HISTORY_PAGE_MAX + 1 }, 'limit'],
      ['qnet.history', { limit: 1.5 }, 'limit'],
      ['qnet.history', { cursor: '' }, 'cursor'],
      ['qnet.history', { cursor: 'a b' }, 'cursor'],
      ['solana.history', { limit: 0 }, 'limit'],
      ['solana.history', { limit: LIMITS.SOLANA_HISTORY_PAGE_MAX + 1 }, 'limit'],
      ['solana.history', { cursor: '' }, 'cursor'],
      ['node.unlink', { seq: '1' }, 'seq'],
      ['node.unlinkView', { nodeId: 'light_mobile_0000000000000000' }, 'nodeId'],
      ['vault.removeEarlier', {}, 'confirm'],
      ['vault.removeEarlier', { confirm: 'remove' }, 'confirm'],
      ['vault.migrate', { password: 'x', newPassword: 'x'.repeat(LIMITS.PASSWORD_MAX_CHARS + 1) }, 'newPassword'],
    ];
    for (const [type, params, field] of cases) {
      const reply = await h.ui(firstPage(type), type, params);
      const error = errorOf(reply);
      assert.equal(error.code, 'INVALID_PARAMS', `${type} ${JSON.stringify(params).slice(0, 60)}`);
      assert.equal(error.field, field, `${type} field`);
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.unlockChecks, 0);
  });

  it('rejects amounts that are not canonical decimals of the asset', async () => {
    const h = harness();
    const qnc = ['0', '0.0', '-1', '01', '1.', '.5', '1e3', '1,5', ' 1', '1 ', '0x10', '0.0000000001', 'NaN', 'Infinity',
      '18446744073.709551616', '99999999999999999999'];
    for (const amount of qnc) {
      const reply = await h.ui('popup', 'qnet.send', { ...VALID['qnet.send'], amount });
      assert.equal(errorOf(reply).code, 'INVALID_PARAMS', `qnc ${amount}`);
    }
    for (const [asset, amount] of [['1dev', '0.0000001'], ['1dev', '0'], ['sol', '0.0000000001'], ['sol', '0.000']]) {
      const reply = await h.ui('popup', 'solana.send', { ...VALID['solana.send'], asset, amount });
      assert.equal(errorOf(reply).code, 'INVALID_PARAMS', `${asset} ${amount}`);
    }
    for (const amount of ['18446744073.709551615', '0.000000001', '1']) {
      const reply = await h.ui('popup', 'qnet.send', { ...VALID['qnet.send'], amount });
      assert.equal(reply.ok, true, `qnc ${amount}`);
    }
    for (const amount of ['1.000001', '0.000001']) {
      const reply = await h.ui('popup', 'solana.send', { ...VALID['solana.send'], asset: '1dev', amount });
      assert.equal(reply.ok, true, `1dev ${amount}`);
    }
  });

  it('a Solana quote and send take a payment request\'s references and memo (decision 34), the list copied', () => {
    const references = REFERENCES.slice(0, 4);
    for (const type of ['solana.quote', 'solana.send']) {
      const params = validateParams(UI_MESSAGES[type].params, { ...VALID[type], references, memo: 'é'.repeat(100) });
      assert.deepEqual(params.references, references, type);
      assert.notEqual(params.references, references, `${type}: a fresh array`);
      assert.equal(params.memo, 'é'.repeat(100), type);
      assert.deepEqual(validateParams(UI_MESSAGES[type].params, { ...VALID[type], references: [] }).references, [], type);
    }
  });

  it('rejects params that are not an object, an empty settings patch, and anything added to no-param types', async () => {
    const h = harness();
    for (const params of ['pw', ['pw'], 7, true]) {
      const reply = await h.ui('popup', 'vault.unlock', params);
      assert.equal(errorOf(reply).code, 'INVALID_PARAMS');
    }
    assert.equal(errorOf(await h.ui('popup', 'settings.set', {})).code, 'INVALID_PARAMS');
    assert.equal(errorOf(await h.ui('popup', 'vault.status', { force: true })).field, 'force');
    assert.equal(errorOf(await h.ui('popup', 'activation.recover', { signature: 'x' })).field, 'signature');
    assert.equal(h.calls.length, 0);
  });

  it('passes a fresh object with only the declared fields, allowing optional ones to be absent', async () => {
    const h = harness();
    const params = { cursor: 'abc', limit: 5 };
    await h.ui('popup', 'qnet.history', params);
    await h.ui('popup', 'qnet.history', undefined);
    await h.ui('popup', 'qnet.send', { to: QNET, amount: '2', expectedFeeNano: '150000' });
    await h.ui('popup', 'settings.set', { language: 'en' });
    await h.ui('approve', 'approval.resolve', { id: UUID, approved: true, revision: 3 });
    assert.notEqual(h.calls[0].params, params);
    assert.deepEqual(h.calls[0].params, params);
    assert.deepEqual(h.calls[1].params, {});
    assert.deepEqual(h.calls[2].params, { to: QNET, amount: '2', expectedFeeNano: '150000' });
    assert.deepEqual(h.calls[3].params, { language: 'en' });
    assert.deepEqual(h.calls[4].params, { id: UUID, approved: true, revision: 3 });
    for (const language of ['zh-CN', 'ar', 'ru', 'pt']) {
      assert.equal((await h.ui('popup', 'settings.set', { language })).ok, true, language);
    }
  });
});

describe('router: UI dispatch', () => {
  it('refuses locked calls to unlocked types and still serves the rest', async () => {
    const h = harness({ unlocked: false });
    for (const [type, entry] of Object.entries(UI_MESSAGES)) {
      const reply = await h.ui(firstPage(type), type, VALID[type]);
      if (entry.unlocked) assert.equal(errorOf(reply).code, 'LOCKED', type);
      else assert.equal(reply.ok, true, type);
    }
    const served = h.calls.map((c) => c.type).sort();
    assert.deepEqual(served, Object.keys(UI_MESSAGES).filter((t) => !UI_MESSAGES[t].unlocked).sort());
    assert.ok(served.includes('vault.unlock') && served.includes('vault.wipe') && served.includes('approval.resolve'));
  });

  it('extends the session only after a successful activity type', async () => {
    const h = harness();
    await h.ui('popup', 'qnet.balance', {});
    await h.ui('popup', 'vault.status', {});
    assert.equal(h.touches, 0);
    await h.ui('popup', 'qnet.send', VALID['qnet.send']);
    assert.equal(h.touches, 1);
    const failing = harness({ handlers: { 'qnet.send': async () => { throw new WalletError('INSUFFICIENT_FUNDS'); } } });
    await failing.ui('popup', 'qnet.send', VALID['qnet.send']);
    assert.equal(failing.touches, 0);
    const brokenTouch = harness({ touchFails: true });
    assert.equal((await brokenTouch.ui('popup', 'qnet.send', VALID['qnet.send'])).ok, true);
  });

  it('returns fixed error messages and never the thrown text', async () => {
    const secret = core.KAT.mnemonic;
    const cases = [
      [new WalletError('BAD_PASSWORD'), { code: 'BAD_PASSWORD', message: 'Wrong password' }],
      [new WalletError('BACKOFF', { retryAfterMs: 4000 }), { code: 'BACKOFF', message: 'Too many attempts, wait before retrying', retryAfterMs: 4000 }],
      [new core.CoreError('INVALID_MNEMONIC'), { code: 'INVALID_MNEMONIC', message: 'Invalid recovery phrase' }],
      [new WalletError('NOT_A_CODE'), { code: 'INTERNAL', message: 'Internal error' }],
      [new Error(secret), { code: 'INTERNAL', message: 'Internal error' }],
      [Object.assign(new TypeError(secret), { code: 'BAD_PASSWORD' }), { code: 'INTERNAL', message: 'Internal error' }],
      ['a thrown string', { code: 'INTERNAL', message: 'Internal error' }],
    ];
    for (const [thrown, expected] of cases) {
      const h = harness({ handlers: { 'vault.unlock': async () => { throw thrown; } } });
      const reply = await h.ui('popup', 'vault.unlock', { password: secret });
      assert.deepEqual(reply, { id: 'req-1', ok: false, error: expected });
      assert.ok(!JSON.stringify(reply).includes('abandon'));
    }
  });

  it('withholds any result carrying a secret, bytes or non-JSON data', async () => {
    const unsafe = [
      { mnemonic: core.KAT.mnemonic },
      { deep: { list: [{ secretKey: 'aa' }] } },
      { key: 'AAAA' },
      { password: 'pw' },
      { entropy: [1, 2, 3] },
      { code: core.KAT.activation.code },
      new Uint8Array(32),
      { publicKey: new Uint8Array(4) },
      { amount: 10n },
      { value: undefined },
      { value: Number.NaN },
      new Date(0),
      { fn: () => 1 },
    ];
    for (const result of unsafe) {
      const h = harness({ handlers: { 'activation.status': async () => result } });
      const reply = await h.ui('popup', 'activation.status', {});
      assert.deepEqual(errorOf(reply), { code: 'INTERNAL', message: 'Internal error' });
      assert.ok(!JSON.stringify(reply).includes('abandon'));
    }
  });

  it('lets only the documented types carry the phrase or the activation code', async () => {
    const reveal = harness({ handlers: { 'vault.reveal': async () => ({ mnemonic: core.KAT.mnemonic }) } });
    assert.deepEqual((await reveal.ui('popup', 'vault.reveal', { password: 'pw' })).result, { mnemonic: core.KAT.mnemonic });
    for (const type of ['activation.copy', 'activation.burn']) {
      const h = harness({ handlers: { [type]: async () => ({ code: core.KAT.activation.code }) } });
      assert.equal((await h.ui('popup', type, VALID[type])).ok, true, type);
    }
    const leak = harness({ handlers: { 'vault.reveal': async () => ({ mnemonic: 'x', secretKey: 'y' }) } });
    assert.equal(errorOf(await leak.ui('popup', 'vault.reveal', { password: 'pw' })).code, 'INTERNAL');
    assert.deepEqual(Object.keys(RESULT_KEY_EXCEPTIONS).sort(), ['activation.burn', 'activation.copy', 'vault.exportKey', 'vault.reveal']);
    // the exported key leaves with its account and address only, never with the phrase or another secret
    const key = harness({ handlers: { 'vault.exportKey': async () => ({ network: 'qnet', address: QNET, privateKey: 'ab'.repeat(32) }) } });
    assert.equal((await key.ui('popup', 'vault.exportKey', VALID['vault.exportKey'])).ok, true);
    const keyAndPhrase = harness({ handlers: { 'vault.exportKey': async () => ({ privateKey: 'ab'.repeat(32), mnemonic: core.KAT.mnemonic }) } });
    assert.equal(errorOf(await keyAndPhrase.ui('popup', 'vault.exportKey', VALID['vault.exportKey'])).code, 'INTERNAL');
    assert.deepEqual(UI_MESSAGES['vault.exportKey'].pages, ['popup']);
    assert.equal(UI_MESSAGES['vault.exportKey'].unlocked, true);
    for (const network of ['eth', 'QNET', '']) {
      assert.equal(errorOf(await key.ui('popup', 'vault.exportKey', { password: 'pw', network })).code, 'INVALID_PARAMS', network);
    }
    // the phrase leaves with nothing but itself
    const withMore = harness({ handlers: { 'vault.reveal': async () => ({ mnemonic: core.KAT.mnemonic, code: core.KAT.activation.code }) } });
    assert.equal(errorOf(await withMore.ui('popup', 'vault.reveal', { password: 'pw' })).code, 'INTERNAL');
    for (const name of ['mnemonic', 'entropy', 'secretKey', 'privateKey', 'password', 'code']) {
      assert.ok(SECRET_RESULT_KEYS.includes(name), name);
    }
  });

  it('echoes the request id and turns an undefined result into null', async () => {
    const h = harness({ handlers: { 'vault.lock': async () => undefined } });
    const popup = pageSender(h.runtime, 'popup');
    assert.deepEqual(await h.router.handleUiMessage({ type: 'vault.lock', id: 0 }, popup), { id: 0, ok: true, result: null });
    assert.equal((await h.router.handleUiMessage({ type: 'nope', id: 'bad id' }, popup)).id, null);
  });
});

describe('router: provider port', () => {
  it('keeps ports of the relay on the manifest origins only', () => {
    const accepted = [`${SITE}/`, `${SITE}/connect?x=1`, `${APP}/tx/1`];
    for (const url of accepted) {
      const h = harness();
      const port = h.connect(url);
      assert.equal(port.disconnected, false, url);
      assert.equal(h.router.openPorts(), 1);
    }
    const h = harness();
    const popup = pageSender(h.runtime, 'popup');
    const rejected = {
      'other name': { url: `${SITE}/`, name: 'qnet-provider-2' },
      'no name': { url: `${SITE}/`, name: '' },
      'foreign site': { url: 'https://evil.example/' },
      'other subdomain': { url: 'https://app.aiqnet.io/' },
      'nested subdomain': { url: 'https://a.www.aiqnet.io/' },
      // hosts that only redirect, and another service on another port of the site's host (R4-ERP-02)
      'www host': { url: 'https://www.aiqnet.io/connect' },
      'explorer host': { url: 'https://explorer.aiqnet.io/' },
      'another port': { url: 'https://aiqnet.io:8443/' },
      'another port of a test host': { url: 'https://dapp.qnet.test:444/' },
      'node host': { url: 'https://node1.aiqnet.io/' },
      'suffix trick': { url: 'https://aiqnet.io.evil.example/' },
      'prefix trick': { url: 'https://evilaiqnet.io/' },
      cleartext: { url: `${'http'}://aiqnet.io/` },
      'loopback on the store build': { url: `${'http'}://localhost:3000/` },
      subframe: { url: `${SITE}/`, sender: contentScriptSender(`${SITE}/`, { frameId: 3 }) },
      prerendered: { url: `${SITE}/`, sender: { ...contentScriptSender(`${SITE}/`), documentLifecycle: 'prerender' } },
      'back-forward cache': { url: `${SITE}/`, sender: { ...contentScriptSender(`${SITE}/`), documentLifecycle: 'cached' } },
      'origin differs from url': { url: `${SITE}/`, sender: contentScriptSender('https://evil.example/', { origin: SITE }) },
      'opaque origin': { url: `${SITE}/`, sender: contentScriptSender(`${SITE}/`, { origin: 'null' }) },
      'other extension': { url: `${SITE}/`, sender: contentScriptSender(`${SITE}/`, { id: OTHER_EXTENSION_ID }) },
      'extension page': { url: `${SITE}/`, sender: popup },
      'no tab': { url: `${SITE}/`, sender: { ...contentScriptSender(`${SITE}/`), tab: undefined } },
    };
    for (const [name, { url, ...options }] of Object.entries(rejected)) {
      const port = h.connect(url, options);
      assert.equal(port.disconnected, true, name);
    }
    assert.equal(h.router.openPorts(), 0);
    assert.equal(h.providerCalls.length, 0);
  });

  it('accepts loopback pages only with the dev overlay patterns', () => {
    const h = harness({ manifest: DEV_MANIFEST });
    assert.equal(h.connect(`${'http'}://localhost:3000/`).disconnected, false);
    assert.equal(h.connect(`${'http'}://127.0.0.1/`).disconnected, false);
    assert.equal(h.connect(`${'http'}://example.com/`).disconnected, true);
  });

  it('acts for the sender origin only, whatever the message says', async () => {
    const h = harness();
    const port = h.connect(`${APP}/page`);
    const ok = await ask(port, { id: 1, method: 'qnet_requestAccounts' });
    assert.deepEqual(ok, { id: 1, ok: true, result: { method: 'qnet_requestAccounts' } });
    assert.equal(h.providerCalls[0].ctx.origin, APP);
    assert.equal(h.providerCalls[0].ctx.tabId, 11);
    assert.ok(Object.isFrozen(h.providerCalls[0].ctx));
    const inParams = await ask(port, { id: 2, method: 'qnet_signMessage', params: { message: 'hi', origin: SITE } });
    assert.equal(errorOf(inParams).code, -32602);
    const onEnvelope = await ask(port, { id: 3, method: 'qnet_accounts', origin: SITE });
    assert.equal(errorOf(onEnvelope).code, -32602);
    assert.equal(h.providerCalls.length, 1);
  });

  it('dispatches the six methods with normalized params', async () => {
    const h = harness();
    const port = h.connect(`${SITE}/`);
    for (const method of ['qnet_requestAccounts', 'qnet_accounts', 'qnet_chainId', 'qnet_disconnect']) {
      for (const params of [undefined, null, [], {}]) {
        assert.equal((await ask(port, { id: 'm', method, params })).ok, true, `${method} ${JSON.stringify(params)}`);
      }
      for (const params of [{ a: 1 }, [1], 'x', 0]) {
        assert.equal(errorOf(await ask(port, { id: 'm', method, params })).code, -32602, `${method} ${JSON.stringify(params)}`);
      }
    }
    await ask(port, { id: 's', method: 'qnet_signMessage', params: { message: 'Sign in to aiqnet.io\nNonce: 42' } });
    await ask(port, { id: 't', method: 'qnet_sendTransaction', params: { to: QNET, amount: '2.5' } });
    assert.deepEqual(h.providerCalls.at(-2).params, { message: 'Sign in to aiqnet.io\nNonce: 42' });
    // a request without a type is a transfer, and reaches the provider as one (normalizeTransaction)
    assert.deepEqual(h.providerCalls.at(-1).params, { type: 'transfer', to: QNET, amount: '2.5' });
    assert.ok(h.providerCalls.every((c) => Object.keys(c.params).length <= 3));
  });

  it('answers 4200 for every method off the allow-list, Solana and raw signing included', async () => {
    const h = harness();
    const port = h.connect(`${SITE}/`);
    for (const method of ['other_requestAccounts', 'other_sign', 'raw_sign', 'qnet_sign', 'qnet_signTransaction',
      'qnet_exportPrivateKey', 'solana_signMessage', 'solana_signTransaction', 'qnet_burn', '__proto__', 'constructor',
      'toString', 'hasOwnProperty']) {
      assert.equal(errorOf(await ask(port, { id: 'u', method })).code, 4200, method);
    }
    for (const method of ['', 'qnet.accounts', 'x'.repeat(65), 7]) {
      assert.equal(errorOf(await ask(port, { id: 'u', method })).code, -32602, String(method));
    }
    assert.equal(h.providerCalls.length, 0);
  });

  it('refuses dApp messages that could pass for a protocol message or hide text', async () => {
    const h = harness();
    const port = h.connect(`${SITE}/`);
    const bad = [
      ...core.PROTOCOL_PREFIXES.map((prefix) => `${prefix}anything`),
      `q1337|transfer:${QNET}:${QNET}:1000000000:1:10:10000`,
      '  Q1337|transfer:x',
      'PING:123',
      '',
      '€'.repeat(1400),
      'pay ‮evil',
      'nul\u0000byte',
      'lone \uD800 surrogate',
      7,
      null,
    ];
    for (const message of bad) {
      const reply = await ask(port, { id: 'b', method: 'qnet_signMessage', params: { message } });
      assert.equal(errorOf(reply).code, -32602, JSON.stringify(message)?.slice(0, 40));
    }
    assert.equal(errorOf(await ask(port, { id: 'b', method: 'qnet_signMessage' })).code, -32602);
    assert.equal(h.providerCalls.length, 0);
    const ok = await ask(port, { id: 'g', method: 'qnet_signMessage', params: { message: 'x'.repeat(core.OFFCHAIN_MESSAGE_MAX_BYTES) } });
    assert.equal(ok.ok, true);
  });

  it('serves qnet_activateNode to https://aiqnet.io only: 4100 for every other origin, before its params are read', async () => {
    const h = harness();
    for (const url of [`${APP}/activate`]) {
      const port = h.connect(url);
      for (const params of [{ nodeType: 'light' }, { nodeType: 'bogus' }, undefined]) {
        assert.equal(errorOf(await ask(port, { id: 'a', method: 'qnet_activateNode', params })).code, 4100, url);
      }
    }
    assert.equal(h.providerCalls.length, 0);
    const port = h.connect(`${SITE}/activate`);
    for (const params of [undefined, {}, { nodeType: 'LIGHT' }, { nodeType: 'light', amount: 1 }, { nodeType: 'light', price: 1500 },
      ['light'], 'light']) {
      assert.equal(errorOf(await ask(port, { id: 'p', method: 'qnet_activateNode', params })).code, -32602, JSON.stringify(params));
    }
    assert.equal((await ask(port, { id: 'ok', method: 'qnet_activateNode', params: { nodeType: 'super' } })).ok, true);
    assert.deepEqual(h.providerCalls.map((call) => [call.ctx.origin, call.params]), [[SITE, { nodeType: 'super' }]]);

    assert.equal(isActivationOrigin(SITE), true);
    for (const origin of ['https://www.aiqnet.io', 'https://explorer.aiqnet.io', APP, `${'http'}://localhost:3000`, `${'http'}://127.0.0.1:8080`, 'https://aiqnet.io:8443',
      'https://evil.example', 'null', '']) {
      assert.equal(isActivationOrigin(origin), false, origin);
    }
    // the development build adds plain-HTTP loopback only
    for (const origin of [`${'http'}://localhost:3000`, `${'http'}://127.0.0.1:8080`, `${'http'}://localhost`]) {
      assert.equal(isActivationOrigin(origin, true), true, origin);
    }
    for (const origin of [`${'http'}://example.com`, 'https://localhost', 'https://www.aiqnet.io']) {
      assert.equal(isActivationOrigin(origin, true), false, origin);
    }
  });

  // decision 35: the extension's knowledge of the wallet's activation, read-only, for the activation origin only
  it('serves qnet_getActivation to https://aiqnet.io only, with no params: 4100 elsewhere before the params', async () => {
    const h = harness();
    const other = h.connect(`${APP}/node`);
    for (const params of [undefined, { status: 'none' }, 'x']) {
      assert.equal(errorOf(await ask(other, { id: 'a', method: 'qnet_getActivation', params })).code, 4100);
    }
    assert.equal(h.providerCalls.length, 0);
    const port = h.connect(`${SITE}/node`);
    for (const params of [{ wallet: QNET }, { nodeType: 'light' }, ['x'], 'x', 1]) {
      assert.equal(errorOf(await ask(port, { id: 'p', method: 'qnet_getActivation', params })).code, -32602, JSON.stringify(params));
    }
    for (const params of [undefined, null, [], {}]) {
      assert.equal((await ask(port, { id: 'ok', method: 'qnet_getActivation', params })).ok, true, JSON.stringify(params));
    }
    assert.deepEqual(h.providerCalls.map((call) => [call.ctx.origin, call.method, call.params]),
      Array.from({ length: 4 }, () => [SITE, 'qnet_getActivation', {}]));
  });

  it('serves qnet_claimNodeBalance to https://aiqnet.io only, with no params: 4100 elsewhere before the params', async () => {
    const h = harness();
    const other = h.connect(`${APP}/node`);
    for (const params of [undefined, { nodeId: 'light_mobile_0000000000000000' }]) {
      assert.equal(errorOf(await ask(other, { id: 'a', method: 'qnet_claimNodeBalance', params })).code, 4100);
    }
    assert.equal(h.providerCalls.length, 0);
    const port = h.connect(`${SITE}/node`);
    for (const params of [{ amountNano: '1' }, { wallet: QNET }, ['x'], 'x', 1]) {
      assert.equal(errorOf(await ask(port, { id: 'p', method: 'qnet_claimNodeBalance', params })).code, -32602, JSON.stringify(params));
    }
    for (const params of [undefined, null, [], {}]) {
      assert.equal((await ask(port, { id: 'ok', method: 'qnet_claimNodeBalance', params })).ok, true, JSON.stringify(params));
    }
    assert.deepEqual(h.providerCalls.map((call) => [call.ctx.origin, call.method, call.params]),
      Array.from({ length: 4 }, () => [SITE, 'qnet_claimNodeBalance', {}]));
  });

  it('serves qnet_unlinkNodeDevice to https://aiqnet.io only, with no params: 4100 elsewhere before the params', async () => {
    const h = harness();
    const other = h.connect(`${APP}/node`);
    for (const params of [undefined, { seq: '1' }]) {
      assert.equal(errorOf(await ask(other, { id: 'a', method: 'qnet_unlinkNodeDevice', params })).code, 4100);
    }
    assert.equal(h.providerCalls.length, 0);
    const port = h.connect(`${SITE}/node`);
    for (const params of [{ seq: '1' }, { nodeId: 'light_mobile_0000000000000000' }, ['x'], 'x', 1]) {
      assert.equal(errorOf(await ask(port, { id: 'p', method: 'qnet_unlinkNodeDevice', params })).code, -32602, JSON.stringify(params));
    }
    for (const params of [undefined, null, [], {}]) {
      assert.equal((await ask(port, { id: 'ok', method: 'qnet_unlinkNodeDevice', params })).ok, true, JSON.stringify(params));
    }
    assert.deepEqual(h.providerCalls.map((call) => [call.ctx.origin, call.method, call.params]),
      Array.from({ length: 4 }, () => [SITE, 'qnet_unlinkNodeDevice', {}]));
  });

  it('lets an activation code out to the dApp from qnet_activateNode and qnet_getActivation only', async () => {
    assert.deepEqual(Object.keys(PROVIDER_RESULT_KEY_EXCEPTIONS), ['qnet_activateNode', 'qnet_getActivation']);
    const result = { status: 'ok', code: core.KAT.activation.code };
    const h = harness({ providerRequest: async () => result });
    const port = h.connect(`${SITE}/`);
    assert.deepEqual(await ask(port, { id: 'a', method: 'qnet_activateNode', params: { nodeType: 'light' } }), { id: 'a', ok: true, result });
    assert.deepEqual(await ask(port, { id: 'g', method: 'qnet_getActivation' }), { id: 'g', ok: true, result });
    assert.equal(errorOf(await ask(port, { id: 'b', method: 'qnet_accounts' })).code, -32603);
    const leak = harness({ providerRequest: async () => ({ ...result, mnemonic: 'x' }) });
    const leakPort = leak.connect(`${SITE}/`);
    assert.equal(errorOf(await ask(leakPort, { id: 'c', method: 'qnet_activateNode', params: { nodeType: 'light' } })).code, -32603);
  });

  it('never lets a dApp choose the fee, nonce or sender of a transfer', async () => {
    const h = harness();
    const port = h.connect(`${SITE}/`);
    const base = { to: QNET, amount: '1' };
    const bad = [
      { ...base, gasPrice: '1000000' }, { ...base, gasLimit: '1000000' }, { ...base, nonce: '5' }, { ...base, from: QNET },
      { ...base, fee: '0' }, { ...base, amount: 1 }, { ...base, amount: '0' }, { ...base, amount: '1e9' },
      { ...base, to: QNET.toUpperCase() }, { to: SOL, amount: '1' }, { amount: '1' }, [QNET, '1'],
    ];
    for (const params of bad) {
      assert.equal(errorOf(await ask(port, { id: 'x', method: 'qnet_sendTransaction', params })).code, -32602,
        JSON.stringify(params).slice(0, 60));
    }
    assert.equal(h.providerCalls.length, 0);
  });

  it('qnet_sendTransaction: one strict shape per type, a request without a type a transfer', async () => {
    const h = harness();
    const port = h.connect(`${SITE}/`);
    const TOKEN = core.deriveContractAddress(QNET, 1);
    const GAME = core.deriveContractAddress(QNET, 3);
    const good = [
      [{ to: QNET, amount: '1' }, { type: 'transfer', to: QNET, amount: '1' }],
      [{ type: 'transfer', to: QNET, amount: '0.5' }, { type: 'transfer', to: QNET, amount: '0.5' }],
      [{ type: 'tokenTransfer', token: TOKEN, to: QNET, amount: '12.000000000000000001' },
        { type: 'tokenTransfer', token: TOKEN, to: QNET, amount: '12.000000000000000001' }],
      [{ type: 'contractCall', contract: GAME, method: 'play_move', args: '' },
        { type: 'contractCall', contract: GAME, method: 'play_move', args: '' }],
      [{ type: 'contractCall', contract: GAME, method: 'run', args: '', gasLimit: 150465 },
        { type: 'contractCall', contract: GAME, method: 'run', args: '', gasLimit: 150465 }],
      // input in either case is taken as lowercase
      [{ type: 'contractCall', contract: GAME, method: '_m1', args: 'AB'.repeat(CALL_ARGS_MAX_BYTES), gasLimit: 1000000 },
        { type: 'contractCall', contract: GAME, method: '_m1', args: 'ab'.repeat(CALL_ARGS_MAX_BYTES), gasLimit: 1000000 }],
    ];
    for (const [params, normalized] of good) {
      assert.equal((await ask(port, { id: 'g', method: 'qnet_sendTransaction', params })).ok, true, JSON.stringify(params).slice(0, 80));
      assert.deepEqual(h.providerCalls.at(-1).params, normalized);
    }
    const count = h.providerCalls.length;
    // the least gas a call may carry: its intrinsic gas plus the least fuel (core.WASM_MIN_FUEL)
    const least = core.contractCallIntrinsicGas(core.contractCallData(GAME, 'run', '0102')) + core.WASM_MIN_FUEL;
    const bad = [
      { type: 'Transfer', to: QNET, amount: '1' }, { type: 'deploy', code: '00' }, { type: 7 }, { type: null, to: QNET, amount: '1' },
      { type: 'transfer', to: QNET, amount: '1', token: TOKEN },
      { type: 'tokenTransfer', token: TOKEN, to: QNET }, { type: 'tokenTransfer', token: TOKEN, to: QNET, amount: '0' },
      { type: 'tokenTransfer', token: TOKEN, to: QNET, amount: '0.0' }, { type: 'tokenTransfer', token: TOKEN, to: QNET, amount: '01' },
      { type: 'tokenTransfer', token: TOKEN, to: QNET, amount: '1.0000000000000000001' }, { type: 'tokenTransfer', token: TOKEN, to: QNET, amount: 5 },
      { type: 'tokenTransfer', token: 'x', to: QNET, amount: '1' }, { type: 'tokenTransfer', token: TOKEN, to: SOL, amount: '1' },
      { type: 'tokenTransfer', token: TOKEN, to: QNET, amount: '1', decimals: 2 },
      { type: 'contractCall', contract: GAME, args: '' }, { type: 'contractCall', contract: GAME, method: '1run', args: '' },
      { type: 'contractCall', contract: GAME, method: 'run' }, { type: 'contractCall', contract: GAME, method: 'run', args: null },
      { type: 'contractCall', contract: GAME, method: 'run', args: '010' }, { type: 'contractCall', contract: GAME, method: 'run', args: 'zz' },
      { type: 'contractCall', contract: GAME, method: 'run', args: [1] },
      { type: 'contractCall', contract: GAME, method: 'run', args: 'ab'.repeat(CALL_ARGS_MAX_BYTES + 1) },
      { type: 'contractCall', contract: GAME, method: 'run', args: '0102', gasLimit: least - 1 },
      { type: 'contractCall', contract: GAME, method: 'run', args: '0102', gasLimit: String(least) },
      { type: 'contractCall', contract: GAME, method: 'run', args: '', gasLimit: 1000001 },
      { type: 'contractCall', contract: GAME, method: 'run', args: '', gasLimit: 150000.5 },
      { type: 'contractCall', contract: GAME, method: 'run', args: '', gasPrice: '10' },
      { type: 'contractCall', contract: GAME, method: 'run', args: '', nonce: '2' },
      { type: 'contractCall', contract: GAME, method: 'run', args: '', from: QNET },
    ];
    for (const params of bad) {
      assert.equal(errorOf(await ask(port, { id: 'b', method: 'qnet_sendTransaction', params })).code, -32602, JSON.stringify(params).slice(0, 80));
    }
    assert.equal(h.providerCalls.length, count);
    assert.equal((await ask(port, { id: 'l', method: 'qnet_sendTransaction', params: {
      type: 'contractCall', contract: GAME, method: 'run', args: '0102', gasLimit: least,
    } })).ok, true, 'exactly the least gas');
  });

  it('refuses value and accessList on a contract call as UNSUPPORTED_PARAM, before anything else is read', async () => {
    const h = harness();
    const port = h.connect(`${SITE}/`);
    const GAME = core.deriveContractAddress(QNET, 3);
    for (const [extra, field] of [[{ value: '1' }, 'value'], [{ value: '0' }, 'value'], [{ accessList: [] }, 'accessList'],
      [{ accessList: [GAME], method: '??' }, 'accessList'], [{ value: 1, accessList: [] }, 'value']]) {
      const reply = await ask(port, { id: 'u', method: 'qnet_sendTransaction', params: { type: 'contractCall', contract: GAME, method: 'run', ...extra } });
      assert.deepEqual(reply, {
        id: 'u', ok: false, error: { code: -32602, message: 'Unsupported parameter', data: { reason: 'UNSUPPORTED_PARAM' } },
      }, JSON.stringify(extra));
      assert.throws(() => normalizeTransaction({ type: 'contractCall', contract: GAME, method: 'run', ...extra }),
        (e) => e.code === 'UNSUPPORTED_PARAM' && e.field === field);
    }
    // a transfer or token transfer naming them is plain invalid input
    for (const params of [{ to: QNET, amount: '1', value: '1' }, { type: 'tokenTransfer', token: GAME, to: QNET, amount: '1', accessList: [] }]) {
      assert.deepEqual(errorOf(await ask(port, { id: 'v', method: 'qnet_sendTransaction', params })), { code: -32602, message: 'Invalid params' });
    }
    assert.throws(() => normalizeTransaction({ type: 'contractCall', value: '1' }), (e) => e.code === 'UNSUPPORTED_PARAM' && e.field === 'value');
    assert.equal(h.providerCalls.length, 0);
  });

  it('qnet_getTransactionStatus takes exactly {from, nonce}, a nonce above zero', async () => {
    const h = harness();
    const port = h.connect(`${SITE}/`);
    assert.equal((await ask(port, { id: 's', method: 'qnet_getTransactionStatus', params: { from: QNET, nonce: '18446744073709551615' } })).ok, true);
    assert.deepEqual(h.providerCalls.at(-1).params, { from: QNET, nonce: '18446744073709551615' });
    for (const params of [{ from: QNET }, { nonce: '1' }, { from: QNET, nonce: '0' }, { from: QNET, nonce: 1 }, { from: QNET, nonce: '01' },
      { from: QNET, nonce: '18446744073709551616' }, { from: SOL, nonce: '1' }, { from: QNET, nonce: '1', txHash: 'ab'.repeat(32) }, [QNET, '1']]) {
      assert.equal(errorOf(await ask(port, { id: 'x', method: 'qnet_getTransactionStatus', params })).code, -32602, JSON.stringify(params));
    }
    assert.equal(h.providerCalls.length, 1);
  });

  it('games.aiqnet.io gets the provider on the store build; other subdomains and qnet_activateNode there do not', async () => {
    const h = harness({ manifest: MANIFEST });
    const games = h.connect('https://games.aiqnet.io/play');
    assert.equal(games.disconnected, false);
    assert.equal((await ask(games, { id: 'a', method: 'qnet_requestAccounts' })).ok, true);
    assert.equal(h.providerCalls.at(-1).ctx.origin, 'https://games.aiqnet.io');
    assert.equal(errorOf(await ask(games, { id: 'b', method: 'qnet_activateNode', params: { nodeType: 'light' } })).code, 4100);
    for (const url of ['https://app.aiqnet.io/', 'https://games.aiqnet.io:8443/', 'https://www.games.aiqnet.io/', `${'http'}://games.aiqnet.io/`]) {
      assert.equal(h.connect(url).disconnected, true, url);
    }
  });
  it('maps errors to provider error codes without the thrown text', async () => {
    const cases = [
      [new ProviderError(4001), 4001, 'User rejected the request'],
      [new ProviderError(4100), 4100, 'Unauthorized'],
      [new WalletError('LOCKED'), 4100, 'Unauthorized'],
      [new WalletError('UNAUTHORIZED'), 4100, 'Unauthorized'],
      [new WalletError('INVALID_ADDRESS'), -32602, 'Invalid params'],
      [new core.CoreError('INVALID_ARGS'), -32602, 'Invalid params'],
      [new WalletError('INVALID_METHOD'), -32602, 'Invalid params'],
      [new WalletError('INVALID_GAS_LIMIT'), -32602, 'Invalid params'],
      // UNSUPPORTED_PARAM carries data only for the two fields the network does not accept
      [new WalletError('UNSUPPORTED_PARAM', { field: 'gasPrice' }), -32602, 'Invalid params'],
      [new WalletError('INSUFFICIENT_FUNDS'), -32603, 'Internal error'],
      [new core.CoreError('PROTOCOL_PREFIX'), -32602, 'Invalid params'],
      [new Error(core.KAT.mnemonic), -32603, 'Internal error'],
    ];
    for (const [thrown, code, message] of cases) {
      const h = harness({ providerRequest: async () => { throw thrown; } });
      const port = h.connect(`${SITE}/`);
      const reply = await ask(port, { id: 'e', method: 'qnet_accounts' });
      assert.deepEqual(reply, { id: 'e', ok: false, error: { code, message } });
    }
  });

  it('withholds unsafe provider results', async () => {
    for (const result of [{ secretKey: 'aa' }, new Uint8Array(3), { signature: new Uint8Array(2) }, { mnemonic: 'm' }]) {
      const h = harness({ providerRequest: async () => result });
      const port = h.connect(`${SITE}/`);
      assert.equal(errorOf(await ask(port, { id: 'r', method: 'qnet_accounts' })).code, -32603);
    }
  });

  it('ignores messages without a usable id and caps pending requests per port', async () => {
    const release = [];
    const h = harness({ providerRequest: () => new Promise((resolve) => { release.push(resolve); }) });
    const port = h.connect(`${SITE}/`);
    for (const message of [{ method: 'qnet_accounts' }, { id: 'no spaces allowed', method: 'qnet_accounts' }, 'x', null]) {
      port.send(message);
    }
    for (let i = 0; i < LIMITS.PORT_MAX_PENDING; i += 1) port.send({ id: i, method: 'qnet_requestAccounts' });
    await until(() => release.length === LIMITS.PORT_MAX_PENDING);
    assert.equal(port.posted.length, 0);
    const flood = await ask(port, { id: 'flood', method: 'qnet_requestAccounts' });
    assert.deepEqual(flood, { id: 'flood', ok: false, error: { code: 4001, message: 'User rejected the request' } });
    release.forEach((resolve) => resolve({}));
    await until(() => port.posted.length === LIMITS.PORT_MAX_PENDING + 1);
    port.send({ id: 'after', method: 'qnet_accounts' });
    await until(() => release.length === LIMITS.PORT_MAX_PENDING + 1);
    release.at(-1)({ done: true });
    await until(() => port.posted.length === LIMITS.PORT_MAX_PENDING + 2);
    assert.deepEqual(port.posted.at(-1), { id: 'after', ok: true, result: { done: true } });
  });

  it('reports a closed port to the provider module', async () => {
    const h = harness();
    const a = h.connect(`${SITE}/`);
    h.connect(`${APP}/`);
    assert.equal(h.router.openPorts(), 2);
    a.close();
    await until(() => h.closed.length === 1);
    assert.equal(h.closed[0].origin, SITE);
    assert.equal(h.router.openPorts(), 1);
  });

  it('delivers events only to the ports of the named origin', () => {
    const h = harness();
    const site = h.connect(`${SITE}/`);
    const app = h.connect(`${APP}/`);
    assert.equal(h.router.emitProviderEvent(SITE, 'accountsChanged', {}), 1);
    assert.deepEqual(site.posted, [{ event: 'accountsChanged', data: {} }]);
    assert.equal(app.posted.length, 0);
    assert.equal(h.router.emitProviderEvent(SITE, 'chainChanged', {}), 0);
    assert.equal(h.router.emitProviderEvent(null, 'disconnect', {}), 0);
    assert.equal(h.router.emitProviderEvent('*', 'disconnect', {}), 0);
    assert.equal(h.router.emitProviderEvent(SITE, 'accountsChanged', { secretKey: 'x' }), 0);
    assert.equal(h.router.emitProviderEvent(APP, 'disconnect', { anything: 'ignored' }), 1);
    assert.deepEqual(app.posted, [{ event: 'disconnect', data: { code: 4900, message: 'Disconnected' } }]);
    assert.equal(site.posted.length, 1);
  });

  // EXT-F3: an idle worker stops and closes every port, so the unlock would reach no page of the cabinet; the pages of the
  // origin no port reached get the event through their tab, and only tabs showing that exact origin.
  it('reaches the pages of the origin whose relay holds no open port through their tab, top frame only', async () => {
    const runtime = createRuntime({ manifest: MANIFEST });
    const queries = [];
    const sent = [];
    const tabs = {
      query: async (filter) => {
        queries.push(filter);
        return [
          { id: 11, url: `${SITE}/node` }, { id: 12, url: `${SITE}/activate` }, { id: 13, url: 'https://aiqnet.io:8443/' },
          { id: 14, url: 'https://evil.example/' }, { id: 'x', url: `${SITE}/` }, { id: 15 },
        ];
      },
      sendMessage: async (tabId, message, options) => {
        sent.push({ tabId, message, options });
        if (tabId === 12) throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    };
    const router = createRouter({ runtime, tabs, providerRequest: async () => null, providerPortClosed: async () => {} });
    const port = createPort({ sender: contentScriptSender(`${SITE}/node`, { tabId: 11 }) });
    router.handleProviderConnect(port);
    assert.equal(router.emitProviderEvent(SITE, 'accountsChanged', { qnet: QNET, solana: SOL }), 1);
    await until(() => sent.length === 1);
    // the host permission's pattern only (chrome.tabs.query filters by URL for those hosts): never games.aiqnet.io's
    assert.deepEqual(queries, [{ url: ['https://aiqnet.io/*'] }]);
    assert.deepEqual(sent, [{
      tabId: 12, message: { target: 'qnet-provider-event', origin: SITE, event: 'accountsChanged', data: { qnet: QNET, solana: SOL } },
      options: { frameId: 0 },
    }]);
    assert.deepEqual(port.posted, [{ event: 'accountsChanged', data: { qnet: QNET, solana: SOL } }]);
    // the port gone: every tab of the origin gets it, the disconnect payload fixed as on a port
    port.close();
    sent.length = 0;
    assert.equal(router.emitProviderEvent(SITE, 'disconnect', { anything: 'ignored' }), 0);
    await until(() => sent.length === 2);
    assert.deepEqual(sent.map((entry) => [entry.tabId, entry.message]), [11, 12].map((tabId) => [tabId,
      { target: 'qnet-provider-event', origin: SITE, event: 'disconnect', data: { code: 4900, message: 'Disconnected' } }]));
    // nothing unsafe, and no event outside the list, ever reaches a tab
    sent.length = 0;
    assert.equal(router.emitProviderEvent(SITE, 'accountsChanged', { secretKey: 'x' }), 0);
    assert.equal(router.emitProviderEvent(SITE, 'chainChanged', {}), 0);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, []);
  });
});

describe('router: install and broadcasts', () => {
  it('registers one message and one connect listener that answer through sendResponse', async () => {
    const h = harness();
    h.router.install();
    assert.equal(h.runtime.onMessage.listenerCount(), 1);
    assert.equal(h.runtime.onConnect.listenerCount(), 1);
    const replies = [];
    const [keepOpen] = h.runtime.onMessage.dispatch(
      { type: 'vault.unlock', id: 'c', params: { password: 'pw' } },
      contentScriptSender(`${SITE}/`),
      (reply) => replies.push(reply),
    );
    assert.equal(keepOpen, true);
    await until(() => replies.length === 1);
    assert.equal(replies[0].error.code, 'FORBIDDEN_SENDER');
    h.runtime.onMessage.dispatch({ type: 'vault.status', id: 'p' }, pageSender(h.runtime, 'popup'), (reply) => replies.push(reply));
    await until(() => replies.length === 2);
    assert.equal(replies[1].ok, true);
    const port = createPort({ sender: contentScriptSender(`${SITE}/`) });
    h.runtime.onConnect.dispatch(port);
    assert.equal(h.router.openPorts(), 1);
  });

  it('broadcasts only the known view events', () => {
    const h = harness();
    h.router.broadcastToViews('locked');
    h.router.broadcastToViews('mnemonic', 'x');
    h.router.broadcastToViews('unlocked', { secretKey: 'x' });
    assert.deepEqual(h.runtime.sent, [{ channel: 'qnet-event', event: 'locked', data: null }]);
    const throwing = createRouter({ runtime: { ...createRuntime(), sendMessage: () => { throw new Error('no receiver'); } } });
    assert.doesNotThrow(() => throwing.broadcastToViews('wiped'));
  });

  it('needs a runtime', () => {
    assert.throws(() => createRouter({ runtime: null }), /chrome.runtime/);
  });
});

describe('router: helpers', () => {
  it('isCanonicalOrigin accepts exact https origins and loopback http only', () => {
    for (const origin of [SITE, 'https://app.aiqnet.io', 'https://aiqnet.io:8443', `${'http'}://localhost:3000`, `${'http'}://127.0.0.1`]) {
      assert.equal(isCanonicalOrigin(origin), true, origin);
    }
    for (const origin of [`${SITE}/`, 'https://aiqnet.io:443', `${'http'}://aiqnet.io`, 'HTTPS://aiqnet.io', 'null', '',
      'chrome-extension://abc', 'javascript:1', `${'http'}://192.168.0.1`, 'https://user@aiqnet.io', 42]) {
      assert.equal(isCanonicalOrigin(origin), false, String(origin));
    }
  });

  it('originMatchesPattern follows Chrome match patterns', () => {
    const table = [
      [SITE, 'https://aiqnet.io/*', true],
      ['https://app.aiqnet.io', 'https://aiqnet.io/*', false],
      ['https://app.aiqnet.io', 'https://*.aiqnet.io/*', true],
      [SITE, 'https://*.aiqnet.io/*', true],
      ['https://xaiqnet.io', 'https://*.aiqnet.io/*', false],
      ['https://explorer.aiqnet.io', 'https://explorer.aiqnet.io/*', true],
      ['https://www.explorer.aiqnet.io', 'https://explorer.aiqnet.io/*', false],
      ['https://app.aiqnet.io', 'https://www.aiqnet.io/*', false],
      [SITE, 'https://www.aiqnet.io/*', false],
      [`${'http'}://localhost:5173`, `${'http'}://localhost/*`, true],
      [`${'http'}://localhost:5173`, `${'http'}://localhost:3000/*`, false],
      // stricter than Chrome: an https pattern without a port takes the default port only (R4-ERP-02)
      ['https://aiqnet.io:8443', 'https://aiqnet.io/*', false],
      ['https://aiqnet.io:8443', 'https://aiqnet.io:8443/*', true],
      [SITE, 'https://aiqnet.io:443/*', true],
      [SITE, '<all_urls>', false],
      [SITE, '*://aiqnet.io/*', false],
    ];
    for (const [origin, pattern, expected] of table) assert.equal(originMatchesPattern(origin, pattern), expected, `${origin} ${pattern}`);
  });

  it('reads the relay patterns from the manifest: aiqnet.io and games.aiqnet.io only (R4-ERP-02)', () => {
    assert.deepEqual(relayMatchPatterns(MANIFEST), ['https://aiqnet.io/*', 'https://games.aiqnet.io/*']);
    assert.deepEqual(relayMatchPatterns({}), []);
    assert.equal(providerOriginOf(contentScriptSender(`${SITE}/x`), { id: contentScriptSender(SITE).id }, []), null);
  });

  it('validateParams and isU64String are strict', () => {
    assert.equal(isU64String('18446744073709551615'), true);
    for (const v of ['18446744073709551616', '00', '-0', '1.0', '', 1]) assert.equal(isU64String(v), false, String(v));
    assert.deepEqual(validateParams(null, []), {});
    assert.throws(() => validateParams(null, [0]), (e) => e.code === 'INVALID_PARAMS');
    assert.throws(() => validateParams({}, Object.create({ inherited: 1 })), (e) => e.code === 'INVALID_PARAMS');
    assert.equal(isSafeResult({ a: [1, 'x', null, true, { b: -1 }] }), true);
    let deep = {};
    const root = deep;
    for (let i = 0; i < 12; i += 1) deep = (deep.n = {});
    assert.equal(isSafeResult(root), false);
  });
});
