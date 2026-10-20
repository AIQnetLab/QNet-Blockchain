// Site side of the wallet provider protocol against mock providers.
// Run: npm run test:wallet   (node --experimental-strip-types loads the .ts module directly)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import bs58 from 'bs58';
import {
  COOLDOWN_MESSAGE,
  COOLDOWN_TEXT,
  EXTENSION_STORE_URL,
  QNET_RDNS,
  DETECT_MS,
  aliasProvider,
  callProvider,
  connectWay,
  detectProvider,
  installTarget,
  isAndroid,
  isApprovalCooldown,
  isPhoneLike,
  connectErrorMessage,
  isEonAddress,
  isSolanaAddress,
  loadView,
  parseAccounts,
  readAccounts,
  readAnnouncement,
  requestAccounts,
  revokeAccess,
  saveView,
  shortAddress,
  watchProviders,
  SOLANA_TRANSFER_METHOD,
  isSolanaSignature,
  isSolanaTransfer,
  providerFailure,
  readSolanaTransfer,
  sendSolanaTransfer,
  supportsSolanaTransfer,
} from '../qnet-provider.ts';
import { isSolanaSignature as linkSignatureCheck } from '../qnet-link.ts';

// KAT from applications/qnet-mobile/__tests__/fix5_kat.test.js ('abandon' x11 + 'about').
const EON = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const SOL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function mockProvider(handlers, extra = {}) {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    listeners,
    request({ method }) {
      calls.push(method);
      const h = handlers[method];
      if (!h) return Promise.reject({ code: 4200 });
      return h();
    },
    on(event, fn) { listeners.set(event, fn); },
    removeListener(event) { listeners.delete(event); },
    ...extra,
  };
}

function announce(target, detail) {
  target.dispatchEvent(new CustomEvent('qnet:announceProvider', { detail }));
}

test('EON addresses need the SHA3-256 checksum', () => {
  assert.equal(isEonAddress(EON), true);
  assert.equal(isEonAddress(EON.slice(0, -1) + (EON.endsWith('e') ? 'f' : 'e')), false);
  assert.equal(isEonAddress(EON.toUpperCase()), false);
  assert.equal(isEonAddress(EON + '0'), false);
  assert.equal(isEonAddress(`<img src=x>${EON}`), false);
  assert.equal(isEonAddress(42), false);
});

test('Solana addresses must decode to 32 bytes', () => {
  assert.equal(isSolanaAddress(SOL), true);
  assert.equal(isSolanaAddress('11111111111111111111111111111111'), true);
  assert.equal(isSolanaAddress('0OIl' + SOL.slice(4)), false);
  assert.equal(isSolanaAddress(SOL.slice(0, 20)), false);
  assert.equal(isSolanaAddress('z'.repeat(44)), false);
  assert.equal(isSolanaAddress(null), false);
});

test('parseAccounts: {} is not connected, anything else must be a valid pair', () => {
  assert.deepEqual(parseAccounts({}), { kind: 'none' });
  assert.deepEqual(parseAccounts({ qnet: EON, solana: SOL, extra: 'x' }), { kind: 'ok', accounts: { qnet: EON, solana: SOL } });
  assert.equal(parseAccounts({ qnet: EON }).kind, 'invalid');
  assert.equal(parseAccounts({ qnet: EON, solana: 'nope' }).kind, 'invalid');
  assert.equal(parseAccounts([EON, SOL]).kind, 'invalid');
  assert.equal(parseAccounts(null).kind, 'invalid');
  assert.equal(parseAccounts('d9fa').kind, 'invalid');
  const hostile = {};
  Object.defineProperty(hostile, 'qnet', { get() { throw new Error('boom'); } });
  assert.equal(parseAccounts(hostile).kind, 'invalid');
});

test('discovery binds only the QNet rdns, once, and asks for it', () => {
  const target = new EventTarget();
  let asked = 0;
  target.addEventListener('qnet:requestProvider', () => {
    asked += 1;
  });
  const bound = [];
  const stop = watchProviders(target, (p) => bound.push(p));
  assert.equal(asked, 1);

  const good = mockProvider({});
  announce(target, { info: { uuid: 'a', rdns: 'com.other.wallet' }, provider: mockProvider({}) });
  announce(target, { info: { uuid: 'b', rdns: QNET_RDNS }, provider: { request: 'not a function' } });
  announce(target, { info: { rdns: QNET_RDNS }, provider: good });
  assert.equal(bound.length, 0);
  announce(target, { info: { uuid: 'c', rdns: QNET_RDNS }, provider: good });
  announce(target, { info: { uuid: 'd', rdns: QNET_RDNS }, provider: mockProvider({}) });
  assert.deepEqual(bound, [good]);

  stop();
  announce(target, { info: { uuid: 'e', rdns: QNET_RDNS }, provider: mockProvider({}) });
  assert.equal(bound.length, 1);
});

test('readAnnouncement survives hostile details', () => {
  const detail = {};
  Object.defineProperty(detail, 'info', { get() { throw new Error('boom'); } });
  assert.equal(readAnnouncement(new CustomEvent('qnet:announceProvider', { detail })), null);
  assert.equal(readAnnouncement(new Event('qnet:announceProvider')), null);
});

test('window.qnet alias is used only when it says isQNet: true', () => {
  const p = mockProvider({}, { isQNet: true });
  assert.equal(aliasProvider({ qnet: p }), p);
  assert.equal(aliasProvider({ qnet: mockProvider({}, { isQNet: 'true' }) }), null);
  assert.equal(aliasProvider({}), null);
  assert.equal(aliasProvider(null), null);
});

test('readAccounts is passive and reads every failure as not connected', async () => {
  const ok = mockProvider({ qnet_accounts: async () => ({ qnet: EON, solana: SOL }) });
  assert.deepEqual(await readAccounts(ok), { qnet: EON, solana: SOL });
  assert.deepEqual(ok.calls, ['qnet_accounts']);
  assert.equal(await readAccounts(mockProvider({ qnet_accounts: async () => ({}) })), null);
  assert.equal(await readAccounts(mockProvider({ qnet_accounts: () => Promise.reject({ code: 4100 }) })), null);
  assert.equal(await readAccounts(mockProvider({ qnet_accounts: async () => ({ qnet: 'bad', solana: SOL }) })), null);
  const throwing = { request() { throw new Error('sync'); } };
  assert.equal(await readAccounts(throwing), null);
});

test('requestAccounts maps protocol errors to fixed texts', async () => {
  const ok = await requestAccounts(mockProvider({ qnet_requestAccounts: async () => ({ qnet: EON, solana: SOL }) }));
  assert.deepEqual(ok, { ok: true, accounts: { qnet: EON, solana: SOL } });

  const rejected = await requestAccounts(mockProvider({ qnet_requestAccounts: () => Promise.reject({ code: 4001, message: '<b>spoof</b>' }) }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.message, 'The connection was rejected in the wallet.');

  const empty = await requestAccounts(mockProvider({ qnet_requestAccounts: async () => ({}) }));
  assert.equal(empty.ok, false);
  assert.match(empty.message, /not valid/);

  const unsupported = await requestAccounts(mockProvider({}));
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.message, /Update the extension/);
});

test('connectErrorMessage covers the protocol codes', () => {
  assert.match(connectErrorMessage({ code: 4100 }), /locked/);
  assert.match(connectErrorMessage({ code: 4900 }), /disconnected/);
  assert.equal(connectErrorMessage({ code: -32603, message: 'internal' }), 'The wallet did not connect. Try again.');
  assert.equal(connectErrorMessage('string error'), 'The wallet did not connect. Try again.');
});

test('the approval cooldown (4001 with its fixed text) reads as too many declined requests', async () => {
  // applications/qnet-wallet CONTRACTS.md 4.5 and the in-app browser's provider carry this exact text.
  assert.equal(COOLDOWN_MESSAGE, 'Too many rejected requests from this site, try again later');
  // The extension bars an origin until its oldest of 20 windows in 10 minutes is 10 minutes old: up to several minutes
  // (XC-07).
  assert.equal(COOLDOWN_TEXT, 'Too many declined requests. Try again in a few minutes.');
  assert.equal(isApprovalCooldown({ code: 4001, message: COOLDOWN_MESSAGE }), true);
  assert.equal(isApprovalCooldown({ code: 4001, message: 'User rejected the request' }), false);
  assert.equal(isApprovalCooldown({ code: 4001, message: `${COOLDOWN_MESSAGE}.` }), false);
  assert.equal(isApprovalCooldown({ code: 4100, message: COOLDOWN_MESSAGE }), false);
  assert.equal(isApprovalCooldown(null), false);
  const hostile = { code: 4001 };
  Object.defineProperty(hostile, 'message', { get() { throw new Error('boom'); } });
  assert.equal(isApprovalCooldown(hostile), false);

  assert.equal(connectErrorMessage({ code: 4001, message: COOLDOWN_MESSAGE }), COOLDOWN_TEXT);
  assert.equal(connectErrorMessage({ code: 4001, message: 'User rejected the request' }), 'The connection was rejected in the wallet.');
  const cooled = await requestAccounts(mockProvider({ qnet_requestAccounts: () => Promise.reject({ code: 4001, message: COOLDOWN_MESSAGE }) }));
  assert.deepEqual(cooled, { ok: false, message: COOLDOWN_TEXT });
});

test('Android is told apart for the explicit app launch', () => {
  assert.equal(isAndroid({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36' }), true);
  assert.equal(isAndroid({ userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' }), true, 'a tablet');
  assert.equal(isAndroid({ userAgent: 'x', userAgentData: { mobile: true, platform: 'Android' } }), true);
  assert.equal(isAndroid({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }), false);
  assert.equal(isAndroid({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36' }), false);
  assert.equal(isAndroid(null), false);
});

test('revokeAccess calls qnet_disconnect and reports whether the wallet confirmed', async () => {
  const p = mockProvider({ qnet_disconnect: async () => null });
  assert.equal(await revokeAccess(p), true);
  assert.deepEqual(p.calls, ['qnet_disconnect']);
  assert.equal(await revokeAccess(mockProvider({ qnet_disconnect: () => Promise.reject({ code: 4900 }) })), false);
});

test('address view preference defaults to QNet and survives blocked storage', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(loadView(storage), 'qnet');
  saveView(storage, 'solana');
  assert.equal(loadView(storage), 'solana');
  store.set('qnet.addressView', 'javascript:alert(1)');
  assert.equal(loadView(storage), 'qnet');
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadView(blocked), 'qnet');
  assert.doesNotThrow(() => saveView(blocked, 'solana'));
  assert.equal(loadView(null), 'qnet');
});

test('shortAddress keeps both ends', () => {
  assert.equal(shortAddress(EON), 'd9fa37…73823e');
  assert.equal(shortAddress('short'), 'short');
});

test('a browser without the wallet is sent where one can be installed', () => {
  const chromeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  assert.deepEqual(installTarget({ userAgent: chromeUa }), { kind: 'store', href: EXTENSION_STORE_URL });
  assert.deepEqual(
    installTarget({ userAgent: 'x', userAgentData: { mobile: false, brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }] } }),
    { kind: 'store', href: EXTENSION_STORE_URL },
  );
  // Phones run no browser extensions: the mobile app's page instead.
  assert.equal(installTarget({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile Safari/537.36' }).kind, 'mobile');
  assert.equal(installTarget({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }).href, '/wallet');
  assert.equal(installTarget({ userAgent: 'x', userAgentData: { mobile: true, brands: [{ brand: 'Chromium' }] } }).kind, 'mobile');
  // Desktop browsers that do not install from the extension's store: the page listing the supported browsers.
  assert.deepEqual(
    installTarget({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0' }),
    { kind: 'unsupported', href: '/qnet-wallet-extension' },
  );
  assert.equal(installTarget({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' }).kind, 'unsupported');
  assert.equal(installTarget(null).kind, 'unsupported');
});

test('the announcement says where the wallet runs; anything but mobile reads as the extension', () => {
  const p = mockProvider({});
  const read = (info) => readAnnouncement(new CustomEvent('qnet:announceProvider', { detail: { info: { uuid: 'u', rdns: QNET_RDNS, ...info }, provider: p } }));
  assert.deepEqual(read({ channel: 'mobile' }), { provider: p, channel: 'mobile' });
  assert.deepEqual(read({ channel: 'extension' }), { provider: p, channel: 'extension' });
  assert.deepEqual(read({}), { provider: p, channel: 'extension' });
  assert.deepEqual(read({ channel: 'Mobile' }), { provider: p, channel: 'extension' });
  assert.deepEqual(read({ channel: { toString: () => 'mobile' } }), { provider: p, channel: 'extension' });

  const target = new EventTarget();
  const seen = [];
  watchProviders(target, (provider, channel) => seen.push(channel));
  announce(target, { info: { uuid: 'm', rdns: QNET_RDNS, channel: 'mobile' }, provider: p });
  assert.deepEqual(seen, ['mobile']);
});

test('callProvider sends params only when given', async () => {
  const p = mockProvider({ qnet_activateNode: async () => 'ok', qnet_accounts: async () => ({}) });
  const sent = [];
  const spy = { request(args) { sent.push(args); return p.request(args); } };
  assert.equal(await callProvider(spy, 'qnet_activateNode', 1000, { nodeType: 'light' }), 'ok');
  await callProvider(spy, 'qnet_accounts', 1000);
  assert.deepEqual(sent, [{ method: 'qnet_activateNode', params: { nodeType: 'light' } }, { method: 'qnet_accounts' }]);
  await assert.rejects(callProvider({ request: () => new Promise(() => {}) }, 'qnet_accounts', 10), /timeout/);
});

// qnet_sendSolanaTransfer: the payment address's buttons on a computer (src/components/cabinet/ActivateSteps.tsx).
const PAY_TO = '9z1QsPH2k9xpYY9EQYh8EdPjhnt9CXnsxZZkYgT5Km96';
const MINT = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
const SIG = bs58.encode(new Uint8Array(64).fill(7));

function transferProvider(answer) {
  const sent = [];
  return { sent, request(args) { sent.push(args); return answer(args); } };
}

test('the extension\'s transfer is offered only when a call without params is refused for its params', async () => {
  assert.equal(SOLANA_TRANSFER_METHOD, 'qnet_sendSolanaTransfer');
  const has = transferProvider(() => Promise.reject({ code: -32602, message: 'Invalid params' }));
  assert.equal(await supportsSolanaTransfer(has), true);
  // The probe names no params, so it can open no window.
  assert.deepEqual(has.sent, [{ method: 'qnet_sendSolanaTransfer' }]);
  // An extension without the method, another origin, a lost worker, a broken contract or no answer: no buttons.
  for (const answer of [() => Promise.reject({ code: 4200 }), () => Promise.reject({ code: 4100 }), () => Promise.reject({ code: 4900 }), async () => ({ status: 'submitted' }), () => { throw new Error('sync'); }]) {
    assert.equal(await supportsSolanaTransfer(transferProvider(answer)), false);
  }
});

test('a transfer goes to the extension exactly as asked, and only its two answer shapes are read', async () => {
  const ok = transferProvider(async () => ({ status: 'submitted', signature: SIG }));
  assert.deepEqual(await sendSolanaTransfer(ok, { to: PAY_TO, mint: MINT, amount: '1500' }), { ok: true, signature: SIG });
  assert.deepEqual(ok.sent, [{ method: 'qnet_sendSolanaTransfer', params: { to: PAY_TO, mint: MINT, amount: '1500' } }]);
  const sol = transferProvider(async () => ({ status: 'submitted', signature: SIG }));
  await sendSolanaTransfer(sol, { to: PAY_TO, mint: null, amount: '0.001', extra: 'dropped' });
  assert.deepEqual(sol.sent[0].params, { to: PAY_TO, mint: null, amount: '0.001' });
  // A malformed transfer is never sent.
  for (const bad of [{ to: 'x', mint: null, amount: '1' }, { to: PAY_TO, mint: 'x', amount: '1' }, { to: PAY_TO, mint: null, amount: '0' }, { to: PAY_TO, mint: null, amount: '1.50' },
    { to: PAY_TO, mint: null, amount: '01' }, { to: PAY_TO, mint: null, amount: '1e3' }, { to: PAY_TO, mint: null, amount: '1,500' }, { to: PAY_TO, mint: null, amount: 1 }, { to: PAY_TO, amount: '1' }, null]) {
    const p = transferProvider(async () => ({ status: 'submitted', signature: SIG }));
    assert.deepEqual(await sendSolanaTransfer(p, bad), { ok: false, failure: 'failed' }, JSON.stringify(bad));
    assert.equal(p.sent.length, 0);
  }
  assert.equal(isSolanaTransfer({ to: PAY_TO, mint: null, amount: '0.000000001' }), true);
  // The protocol codes, the cooldown included.
  const failed = async (err) => (await sendSolanaTransfer(transferProvider(() => Promise.reject(err)), { to: PAY_TO, mint: null, amount: '1' })).failure;
  assert.equal(await failed({ code: 4001, message: 'User rejected the request' }), 'rejected');
  assert.equal(await failed({ code: 4001, message: COOLDOWN_MESSAGE }), 'cooldown');
  assert.equal(await failed({ code: 4100 }), 'unauthorized');
  assert.equal(await failed({ code: 4200 }), 'unsupported');
  assert.equal(await failed({ code: 4900 }), 'disconnected');
  assert.equal(await failed({ code: -32603 }), 'failed');
  // The answers: a balance too low for it, any other error, and anything off the two shapes.
  assert.deepEqual(readSolanaTransfer({ status: 'error', error: 'INSUFFICIENT_SOL' }), { ok: false, failure: 'short' });
  assert.deepEqual(readSolanaTransfer({ status: 'error', error: 'INSUFFICIENT_TOKENS' }), { ok: false, failure: 'short' });
  assert.deepEqual(readSolanaTransfer({ status: 'error', error: 'TX_FAILED' }), { ok: false, failure: 'failed' });
  const hostile = {};
  Object.defineProperty(hostile, 'status', { enumerable: true, get() { throw new Error('boom'); } });
  for (const bad of [null, [], 'submitted', { status: 'submitted' }, { status: 'submitted', signature: 'x' }, { status: 'submitted', signature: SIG, from: PAY_TO },
    { status: 'error' }, { status: 'error', error: 1 }, { status: 'ok', signature: SIG }, hostile]) {
    assert.deepEqual(readSolanaTransfer(bad), { ok: false, failure: 'unverifiable' });
  }
});

test('one failure mapping and one signature check, shared with the activation\'s calls', () => {
  assert.equal(providerFailure(new Error('timeout')), 'timeout');
  assert.equal(providerFailure({ code: 4001 }), 'rejected');
  assert.equal(providerFailure('x'), 'failed');
  assert.equal(isSolanaSignature(SIG), true);
  assert.equal(isSolanaSignature(PAY_TO), false);
  assert.equal(linkSignatureCheck, isSolanaSignature);
  const link = readFileSync(new URL('../qnet-link.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(link, /function providerFailure|function isSolanaSignature/);
});

test('phones and tablets, iPadOS included, are told apart from desktops', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  assert.equal(isPhoneLike({ userAgent: mac, maxTouchPoints: 5 }), true, 'iPadOS Safari');
  assert.equal(isPhoneLike({ userAgent: mac, maxTouchPoints: 0 }), false, 'a Mac');
  assert.equal(isPhoneLike({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile Safari/537.36' }), true);
  assert.equal(isPhoneLike({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36', maxTouchPoints: 10 }), false);
  assert.equal(isPhoneLike(null), false);
  assert.equal(installTarget({ userAgent: mac, maxTouchPoints: 5 }).kind, 'mobile');
  // SITE-5: an Android tablet in desktop mode (the common tablet browsers' default on large tablets) presents a
  // desktop Linux; its touch screen makes it a tablet, and Android for the app launch. A CrOS laptop stays a computer.
  const desktopMode = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const samsung = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Safari/537.36';
  for (const ua of [desktopMode, samsung]) {
    assert.equal(isPhoneLike({ userAgent: ua, maxTouchPoints: 10 }), true, ua);
    assert.equal(isAndroid({ userAgent: ua, maxTouchPoints: 10 }), true, ua);
    assert.equal(isPhoneLike({ userAgent: ua, maxTouchPoints: 0 }), false, 'a Linux desktop');
    assert.equal(isAndroid({ userAgent: ua, maxTouchPoints: 0 }), false, 'a Linux desktop');
  }
  assert.equal(isPhoneLike({ userAgent: 'x', userAgentData: { mobile: false, platform: 'Android' } }), true, 'client hints name Android');
  const chromebook = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  assert.equal(isPhoneLike({ userAgent: chromebook, maxTouchPoints: 10 }), false);
  assert.equal(isAndroid({ userAgent: chromebook, maxTouchPoints: 10 }), false);
  // A request shown as a QR code can be opened on this device too; the page still asks for its check number, and a
  // button that opened nothing is told within NOT_OPENED_MS (SITE-14).
  const waiting = readFileSync(new URL('../../components/cabinet/LinkWaiting.tsx', import.meta.url), 'utf8');
  assert.match(waiting, /<QrCode text=\{state\.link\} label=\{t\('link_qr_label'\)\} \/>[\s\S]*?<a className="btn btn-text" href=\{openHref\(state\.link, android\)\}>\{t\('link_open_here'\)\}<\/a>/);
  assert.match(waiting, /export const NOT_OPENED_MS = 2_500;/);
  assert.match(waiting, /timer\.current = window\.setTimeout\(\(\) => \{\s*if \(document\.visibilityState === 'visible'\) setNotOpened\(true\);\s*\}, NOT_OPENED_MS\);/);
  assert.match(waiting, /if \(document\.visibilityState === 'hidden'\) window\.clearTimeout\(timer\.current\);/);
  assert.match(waiting, /\{notOpened && <p className="rq-failed" role="status">\{t\('link_not_opened'\)\}<\/p>\}/);
});
// SITE-R2-11: official source names no other product. Comments describe browsers by what they do (a tablet browser in
// desktop mode, a browser without Object.hasOwn); user-agent tokens stay in the code that matches them.
test('no comment of the site\'s source names a browser product', () => {
  const PRODUCTS = /\b(Chrome|Chromium|ChromeOS|Chromebook|Safari|Samsung Internet|Firefox|Brave|Opera|Edge|WebKit)\b/;
  const root = new URL('../../', import.meta.url);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(new URL(`${d.name}/`, dir)) : /\.(ts|tsx|mjs)$/.test(d.name) ? [new URL(d.name, dir)] : []));
  const found = [];
  for (const url of walk(root)) {
    const src = readFileSync(url, 'utf8');
    const comments = [...src.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]);
    for (const line of src.split(/\r?\n/)) {
      const m = /(^|[^:'"`\\])\/\/(.*)$/.exec(line);
      if (m) comments.push(m[2]);
    }
    for (const c of comments) if (PRODUCTS.test(c)) found.push(`${url.pathname.split('/src/')[1]}: ${c.trim().slice(0, 80)}`);
  }
  assert.deepEqual(found, []);
});
// Owner, 20.10: the header's Connect wallet and My node's main action are one function, by device. A phone or tablet
// opens QNet Wallet and is never offered the extension; a computer asks the extension it has, or without one gets the
// extension's store page at once; nothing is offered while the wallet is still being detected.
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const OTHER_DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const computer = { phone: false };
const phone = { phone: true };

test('Connect wallet by device: the extension, its store page, or QNet Wallet; nothing while detecting', () => {
  const desktop = { userAgent: DESKTOP_UA };
  // Detecting, or the device not known yet: nothing to offer, whatever is announced later.
  for (const device of [computer, phone, null]) assert.deepEqual(connectWay('detecting', null, device, desktop), { kind: 'wait' });
  assert.deepEqual(connectWay('missing', null, null, desktop), { kind: 'wait' });
  // A computer with the QNet extension asks it.
  assert.deepEqual(connectWay('available', 'extension', computer, desktop), { kind: 'extension' });
  // A computer without it: the store page at once (a new tab), or in a browser that store does not serve, the page that
  // lists the browsers it installs in.
  assert.deepEqual(connectWay('missing', null, computer, desktop), { kind: 'install', href: EXTENSION_STORE_URL, store: true });
  assert.deepEqual(connectWay('missing', null, computer, { userAgent: OTHER_DESKTOP_UA }), { kind: 'install', href: '/qnet-wallet-extension', store: false });
  // A phone or tablet opens QNet Wallet, with or without a provider: never an extension or an install offer.
  for (const [status, channel] of [['missing', null], ['available', 'extension'], ['available', 'mobile']]) {
    assert.deepEqual(connectWay(status, channel, phone, { userAgent: PHONE_UA }), { kind: 'app' }, `${status} ${channel}`);
  }
});

test('the wallet search: present binds at once, absent turns missing after DETECT_MS, late binds after missing', async () => {
  assert.equal(DETECT_MS, 1_000);
  const desktop = { userAgent: DESKTOP_UA };
  // What a computer's Connect wallet offers at each step of the search, starting from detecting.
  const run = async (setup, ms) => {
    const target = new EventTarget();
    const ways = [connectWay('detecting', null, computer, desktop).kind];
    const provider = mockProvider({});
    setup(target, provider);
    const stop = detectProvider(
      target,
      (p, channel) => {
        assert.equal(p, provider);
        ways.push(connectWay('available', channel, computer, desktop).kind);
      },
      () => ways.push(connectWay('missing', null, computer, desktop).kind),
      ms,
    );
    return { target, provider, ways, stop };
  };
  const answer = (target, provider) => announce(target, { info: { uuid: 'u', rdns: QNET_RDNS, channel: 'extension' }, provider });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Present: the extension answers the request at once; the timer finds it bound and does nothing.
  const present = await run((target, provider) => target.addEventListener('qnet:requestProvider', () => answer(target, provider)), 20);
  await wait(40);
  assert.deepEqual(present.ways, ['wait', 'extension']);
  present.stop();

  // Absent: missing once the time is up, so Connect wallet is the store page.
  const absent = await run(() => {}, 20);
  assert.deepEqual(absent.ways, ['wait']);
  await wait(40);
  assert.deepEqual(absent.ways, ['wait', 'install']);
  absent.stop();

  // Late: missing first, then the announcement still binds and Connect wallet asks the extension; later ones are ignored.
  const late = await run(() => {}, 20);
  await wait(40);
  answer(late.target, late.provider);
  answer(late.target, mockProvider({}));
  assert.deepEqual(late.ways, ['wait', 'install', 'extension']);
  late.stop();
  // After the cleanup nothing binds.
  answer(late.target, late.provider);
  assert.equal(late.ways.length, 3);

  // No announcement but the window.qnet alias: bound as the extension when the time is up.
  const target = Object.assign(new EventTarget(), { qnet: mockProvider({}, { isQNet: true }) });
  const seen = [];
  const stop = detectProvider(target, (p, channel) => seen.push([p === target.qnet, channel]), () => seen.push('missing'), 10);
  await wait(30);
  assert.deepEqual(seen, [[true, 'extension']]);
  stop();
});

test('a phone\'s Connect wallet is asked once and taken once by My node\'s connect card', async () => {
  const { APP_CONNECT_EVENT, askAppConnect, takeAppConnect } = await import('../cabinet/connect-card.ts');
  assert.equal(takeAppConnect(), false);
  const target = new EventTarget();
  let heard = 0;
  target.addEventListener(APP_CONNECT_EVENT, () => {
    heard += 1;
  });
  askAppConnect(target);
  assert.equal(heard, 1);
  // The card that takes it starts the request; a second card, or a reload of this page's memory, finds nothing.
  assert.equal(takeAppConnect(), true);
  assert.equal(takeAppConnect(), false);
});
