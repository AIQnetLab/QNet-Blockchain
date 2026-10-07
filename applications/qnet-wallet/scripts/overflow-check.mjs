#!/usr/bin/env node
// Layout check of every screen of the popup, the setup tab and the approval window in every UI language,
// in headless Chrome (i18n: nothing may overflow). The pages run from dist/ over a local HTTP server with
// a scripted stand-in for chrome.runtime: no worker, no wallet, no network. Each scenario drives the
// page's own code to its screens; at every check each element is measured:
//   - scrollWidth > clientWidth (content wider than its box, clipped or spilling);
//   - scrollHeight > clientHeight unless the element scrolls vertically (content cut or spilling);
//   - a placeholder or selected option wider than its field;
//   - a whole address (QNet or Solana) on more than one line: in the popup and the approval window at every width, on
//     the setup tab at 800 px (a setup tab narrower than about 400 px wraps it).
// Widths: popup 360 px (its fixed body), approval window 400 and 360 px, setup tab 360 and 800 px.
// Usage: node scripts/overflow-check.mjs [--chrome <exe>] [--dist <dir>] [--lang en,ar] [--only <text>]
//        [--shots <dir>] [--report <file.json>] [--mono <font family>] [--scrollbars]
//   --mono: the monospace font in place of the pages' list (addresses: 'Courier New' has the widest advance, 0.6 em)
//   --scrollbars: the platform's scrollbars take their width, as in the real popup (hidden by default)
// Exit code 1 when anything overflows, a screen cannot be reached, or a page throws.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WALLET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const CHROME = option('chrome', process.env.CHROME_PATH ?? [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => existsSync(candidate)));
const DIST = path.resolve(option('dist', path.join(WALLET, 'dist')));
const SHOTS = option('shots');
const REPORT = option('report');
const ONLY = option('only');
const MONO = option('mono');
const SCROLLBARS = args.includes('--scrollbars');
const { SUPPORTED_LANGUAGES, TIMINGS } = await import(new URL(`file:///${path.join(DIST, 'background/config.js').replace(/\\/g, '/')}`).href);
const core = await import(new URL(`file:///${path.join(DIST, 'lib/qnet-core.js').replace(/\\/g, '/')}`).href);
const LANGS = (option('lang')?.split(',') ?? SUPPORTED_LANGUAGES).filter((code) => SUPPORTED_LANGUAGES.includes(code));

if (!CHROME) {
  console.error('[ERR][OVERFLOW] Chrome not found: pass --chrome <exe> or set CHROME_PATH');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- fixtures

const NOW = Date.now();
// the start of today, local time: History's day headers (Today, Yesterday, the date) count from it
const MIDNIGHT = new Date(NOW).setHours(0, 0, 0, 0);
const A = Object.freeze({ qnet: core.KAT.qnetAddress, solana: core.KAT.solanaAddress });
const BURN_TX = 'nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx';
const SOL_RECIPIENT = 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR';
const MINT = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
const TOKEN_PROGRAM = core.SOLANA_PROGRAMS.TOKEN;
const PASSWORD = 'correct horse battery staple';
const KAT = core.KAT.mnemonic;
const MASKED = 'QNET-L•••••-••••••-••••36';
const TX_HASH = 'ab'.repeat(32);

function eon(seed) {
  const body = `${seed.padEnd(19, '0').slice(0, 19)}eon${'7'.repeat(15)}`;
  return body + core.bytesToHex(core.sha3_256(core.utf8Encode(body))).slice(0, 8);
}
const HISTORY_PEER = eon('5fce3965d3c627f688f');
// A valid EON with the first and last four characters of HISTORY_PEER: an address-poisoning look-alike.
function lookalikeOf(address) {
  const head = address.slice(0, 4);
  const tail = address.slice(-4);
  for (let i = 0; ; i += 1) {
    const body = `${head}${i.toString(16).padStart(15, '0')}eon${'0'.repeat(15)}`;
    const candidate = body + core.bytesToHex(core.sha3_256(core.utf8Encode(body))).slice(0, 8);
    if (candidate.endsWith(tail) && candidate !== address) return candidate;
  }
}
const LOOKALIKE = lookalikeOf(HISTORY_PEER);

const unlocked = { exists: true, unlocked: true, lockDeadline: NOW + 900000, addresses: A, signingEnabled: true, backoffUntil: null };
const locked = { exists: true, unlocked: false, lockDeadline: null, addresses: null, signingEnabled: true, backoffUntil: null };
const noVault = { exists: false, unlocked: false, lockDeadline: null, addresses: null, signingEnabled: true, backoffUntil: null };
const qnetBalance = { balanceNano: '12500000000', nonce: '4', verified: true, verification: 'proof', blockHeight: 1612800 };
const solBalances = (oneDevRaw = '5000000000', lamports = '2000000000', exists = true) => ({
  address: A.solana, lamports, oneDev: { mint: MINT, ata: SOL_RECIPIENT, exists, raw: oneDevRaw, decimals: 6 },
});
const item = (direction, status = 'confirmed') => ({
  hash: TX_HASH, direction, from: direction === 'in' ? HISTORY_PEER : A.qnet, to: direction === 'out' ? HISTORY_PEER : A.qnet,
  amountNano: '1234567890123', feeNano: '150000', timestamp: NOW - 3600000, status,
});
// this wallet's unconfirmed sends: no hash of their own (the node's hash covers its receive time)
const pendingItem = (status, nonce) => ({ ...item('out', status), hash: '', nonce });
// a site's token transfer and contract call, named by their contract without a QNC amount
const callItem = (nonce, recipient) => ({ ...pendingItem('pending', nonce), to: 'da401c47c976814aa4ceon0a63be8d36c9f0ff502bd06', kind: 'call', method: recipient ? 'transfer' : 'play_move', recipient });
const history = {
  items: [item('in'), item('out'), item('self')], cursor: 'page-2', pending: [pendingItem('pending', '5'), callItem('6', HISTORY_PEER), callItem('7', null)],
};
const outstanding = [
  { nonce: '5', to: HISTORY_PEER, amountNano: '1000000000', feeNano: '150000', createdAt: NOW - 600000, stale: false },
  { nonce: '6', to: LOOKALIKE, amountNano: '250000000000', feeNano: '150000', createdAt: NOW - 7200000, stale: true },
  { nonce: '7', to: '83485d2591342b03b8aeonc9ca2211bc1b2aad43bbad3', amountNano: '0', feeNano: '4509375', createdAt: NOW - 60000, stale: false, kind: 'call' },
];
const price = { phase: 1, light: { cost: 1500 }, super: { cost: 6000 }, fetchedAt: NOW };
const activationOf = (nodeType) => ({
  nodeType, burnTx: BURN_TX, burnAmount: 1500, solanaAddress: A.solana, cluster: 'devnet', createdAt: NOW - 86400000,
  codeMasked: nodeType === 'super' ? MASKED.replace('QNET-L', 'QNET-S') : MASKED,
});
const pendingBurn = { burnTx: BURN_TX, nodeType: 'light', burnAmount: 1500, solanaAddress: A.solana, cluster: 'devnet', createdAt: NOW };
// the light node's record on the QNet network (nodes.publicRegistration), and a node aiqnet.io paid for this wallet
const NODE_ID = core.lightNodeId(A.qnet);
const registrationOf = (state, automatic = false) => ({
  nodeId: NODE_ID, state, attempts: automatic ? 1 : 12, lastError: null, txHash: null, updatedAt: NOW, automatic,
});
// the network's one-node rule refused the record for good (decision 36)
const hasNodeRefusal = { ...registrationOf('refused'), attempts: 1, lastError: 'wallet_has_node' };
const paidActivation = { ...activationOf('light'), solanaAddress: SOL_RECIPIENT, paidOnSite: true };
// activation.lookup (decision 35): the scenarios that name activation.status get the lookup of a wallet whose vault is the
// only source that knows something; the others name the view they draw
const lookupFrom = (status) => ({
  activation: null, pending: null, busy: false, superseded: null, registration: null, ...status, record: null, keptBurn: null,
  network: 'none', search: 'none', reason: null,
  view: status.activation ? 'activation' : status.pending ? 'pending' : status.busy ? 'busy' : 'none',
});
const lookupView = (view, extra = {}) => ({ ...lookupFrom({}), view, ...extra });
const paidRecord = {
  state: 'recorded', nodeType: 'light', way: 'payment', burnTx: BURN_TX, burnAmount: 1500, until: null, paidOnSite: true, codeMasked: MASKED,
  createdAt: NOW - 86400000,
};
// a Solana send's quote (solana.quote), and a payment request the send form reads (label, message and memo shown as
// text, the number of references named): four references and a 200-byte memo with a long unbroken run
const solanaQuote = (extra = {}) => ({
  asset: '1dev', to: SOL_RECIPIENT, mint: MINT, decimals: 6, amountRaw: '1500000000', feeLamports: '5000', createsRecipientAccount: true,
  rentLamports: '2039280', totalLamports: '2044280', balanceLamports: '2000000000', tokenRaw: '5000000000', rentFloorLamports: '890880',
  shortfall: null, recipient: { known: false, lookalike: true }, references: [], memo: null, ...extra,
});
const REQUEST_REFERENCES = [1, 2, 3, 4].map((n) => core.solanaAddressFromPublicKey(new Uint8Array(32).fill(0x60 + n)));
const REQUEST_MEMO = `Order 2026-09-29/0042 ${'f0e1d2c3b4a59687'.repeat(12)}`.slice(0, 200);
const PAY_REQUEST = `solana:${SOL_RECIPIENT}?amount=1500&spl-token=${MINT}&label=${encodeURIComponent('QNet node operators cooperative, annual membership')}`
  + `&message=${encodeURIComponent('Order 2026-09-29/0042 https://pay.example.test/checkout/0123456789abcdef0123456789abcdef0123456789')}`
  + `&${REQUEST_REFERENCES.map((r) => `reference=${r}`).join('&')}&memo=${encodeURIComponent(REQUEST_MEMO)}`;
// the Solana History (decision 39): a burn, a failed send, 1DEV in and the largest amounts a row can hold on its one line
const solItem = (n, extra = {}) => ({
  signature: core.base58Encode(new Uint8Array(64).fill(n)), asset: 'sol', direction: 'in', counterparty: SOL_RECIPIENT,
  amountRaw: '1234567890', feeLamports: null, timestamp: NOW - 3600000 * n, status: 'confirmed', burn: false, ...extra,
});
const solanaHistory = {
  items: [solItem(1), solItem(2, { asset: '1dev', direction: 'out', amountRaw: '1500000000', burn: true, counterparty: null, feeLamports: '5000' }),
    solItem(3, { direction: 'out', status: 'failed', feeLamports: '5000' }), solItem(4, { asset: '1dev', amountRaw: '18446744073709551615' }),
    solItem(5, { direction: 'self', amountRaw: '18446744073709551615', counterparty: null, feeLamports: '5000' })],
  cursor: 'next-page',
};
const noDevice = { mode: 'unavailable', reason: 'NOT_LINKED', nodeId: core.lightNodeId(A.qnet), platform: null, linkedSince: null };
// the wallet's built-in QNet tokens (owner, 06.10): one with a short symbol, one with a long name, one unread, and one
// named after QNC with the largest balance (M-5: marked, its short contract id under it); the list leaves tokens out
// (L-13: "Some tokens are not shown")
const TOKEN_GOLD = eon('7a1b2c3d4e5f6a7b8c9');
const TOKEN_LONG = eon('1f2e3d4c5b6a7980a1b');
const TOKEN_FAKE = eon('9e8d7c6b5a4f3e2d1c0');
const tokens = {
  tokens: [
    { contract: TOKEN_GOLD, name: 'Gold Coin', symbol: 'GOLD', decimals: 6, balanceBase: '340282366920938463463374607431768211455', reserved: false },
    { contract: TOKEN_LONG, name: 'QNet operators cooperative membership token', symbol: 'QOCMT', decimals: 18, balanceBase: null, reserved: true },
    { contract: TOKEN_FAKE, name: 'QNC', symbol: 'QNC', decimals: 0, balanceBase: '340282366920938463463374607431768211455', reserved: true },
  ],
  complete: false,
};
const tokenPreview = {
  kind: 'tokenTransfer', from: A.qnet, contract: TOKEN_GOLD, method: 'transfer', gasLimit: '45093', feeNano: '450930',
  depositNano: String(core.fees.STORAGE_DEPOSIT_NANO), totalNano: String(450930n + BigInt(core.fees.STORAGE_DEPOSIT_NANO)), nonce: '4',
  balanceNano: '12500000000', verified: true, verification: 'proof', outstanding, replacesNonce: '6', inFlight: false, to: LOOKALIKE,
  amountBase: '18446744073709551615', tokenBalance: '100', tokenProblem: null, duplicate: true, token: TOKEN_GOLD, name: 'QNet operators cooperative membership token',
  symbol: 'GOLD', decimals: 6, amount: '18446744073709.551615', reserved: true, burn: true,
  recipient: { known: false, lookalike: true, incomingOnly: true, historyRead: true, recentSame: false },
};
// a QNet token row of the archive and a dropped send, for History and its detail
const tokenItem = { ...item('in'), hash: 'cd'.repeat(32), amountNano: '0', feeNano: '0', kind: 'token', block: 2068700,
  token: { contract: TOKEN_GOLD, symbol: 'GOLD', decimals: 6, reserved: false }, amountBase: '340282366920938463463374607431768211455' };
// a token row named after QNC: marked in its row, and its detail says it is not QNC (M-5)
const fakeTokenItem = { ...tokenItem, hash: 'ce'.repeat(32), token: { contract: TOKEN_FAKE, symbol: 'QNC', decimals: 0, reserved: true } };
const sites = {
  sites: [
    { origin: 'https://aiqnet.io', originDisplay: 'https://aiqnet.io', idn: false, grantedAt: NOW, chains: ['qnet', 'solana'] },
    { origin: 'https://xn--80ak6aa92e.aiqnet.io', originDisplay: 'https://аррӏе.aiqnet.io', idn: true, grantedAt: NOW - 1000, chains: ['qnet', 'solana'] },
  ],
};

// ---------------------------------------------------------------- scenarios
// responses: type → result | {$error: CODE, retryAfterMs?} | {$pending: true} | {$seq: [..]} (the last repeats)
// steps: ['check', name] | ['click', sel] | ['trusted', sel] | ['type', sel, text] | ['waitFor', sel] |
//        ['wait', ms] | ['words'] (setup: type the asked words back) | ['hold', sel] (pointerdown) | ['select', sel, value]

const popupBase = {
  'vault.status': unlocked,
  'qnet.balance': qnetBalance,
  'solana.balances': solBalances(),
  'qnet.history': history,
  'activation.status': { activation: null, pending: null, busy: false },
  'activation.registration': { registration: null },
  'activation.price': price,
  'sites.list': sites,
  'vault.lock': { locked: true },
  'wallet.cached': { qnetBalance: null, qnetHistory: null, solanaBalances: null, solanaHistory: null },
  'solana.history': solanaHistory,
  'node.unlinkView': noDevice,
  'qnet.tokens': tokens,
};

const tab = (name) => ['click', `[data-tab="${name}"]`];
const net = (name) => ['click', `.network-switch [data-value="${name}"]`];
const pw = (sel = 'input[name="password"]') => ['type', sel, PASSWORD];
// Reset wallet: locked, a token, and the phrase with a new password typed up to the confirmation
const restoreBase = { 'vault.status': locked, 'vault.restoreBegin': { token: 'ab'.repeat(32), expiresAt: NOW + 600000 } };
const restoreTyped = [['type', 'textarea[name="phrase"]', KAT], pw('input[name="new-password"]'), pw('input[name="confirm-password"]'),
  ['click', '[data-action="restore"]'], ['waitFor', 'input[name="understand"]']];
// a Solana send of 1500 1DEV up to its sent screen
const solanaSendSteps = [net('solana'), tab('send'), ['click', '.segmented [data-value="1dev"]'], ['type', 'input[name="to"]', SOL_RECIPIENT],
  ['type', 'input[name="amount"]', '1500'], ['click', '[data-action="review"]'], ['waitFor', '[data-action="confirm-send"]:not([disabled])'],
  ['click', '[data-action="confirm-send"]'], ['waitFor', '[data-action="done"]']];

const POPUP = [
  { name: 'welcome', responses: { 'vault.status': noVault }, steps: [['check', 'welcome']] },
  // the wallet of an earlier version is in this browser (M-4): the first screen leads to setup, which moves it
  { name: 'welcome-earlier', responses: { 'vault.status': { ...noVault, earlier: true } }, steps: [['check', 'welcome-earlier']] },
  { name: 'error', responses: { 'vault.status': { $error: 'INTERNAL' } }, steps: [['check', 'error']] },
  { name: 'lock-backoff', responses: { 'vault.status': { ...locked, backoffUntil: NOW + 3600000 } }, steps: [['check', 'lock-backoff']] },
  {
    name: 'lock-error',
    responses: { 'vault.status': locked, 'vault.unlock': { $error: 'BAD_PASSWORD' } },
    steps: [['check', 'lock'], pw(), ['click', '[data-action="unlock"]'], ['check', 'lock-wrong-password']],
  },
  {
    // Forgot password → Reset wallet: the phrase and a new password, the check naming this wallet, one checkbox
    name: 'restore',
    responses: {
      ...restoreBase,
      'vault.restore': { $seq: [
        { status: 'confirm', erased: A, restored: A, otherWallet: false },
        { status: 'restored', qnet: A.qnet, solana: A.solana, lockDeadline: NOW + 900000 },
      ] },
    },
    steps: [['click', '[data-action="forgot-password"]'], ['check', 'restore'],
      ['type', 'textarea[name="phrase"]', 'not a phrase'], ['click', '[data-action="restore"]'], ['check', 'restore-invalid'],
      ...restoreTyped, ['check', 'restore-confirm'], ['click', 'input[name="understand"]'],
      ['click', '[data-action="restore-confirm"]'], ['waitFor', '[data-action="continue"]'], ['check', 'restore-done']],
  },
  {
    // another wallet's phrase: both pairs under a danger notice, the same checkbox
    name: 'restore-other-wallet',
    responses: {
      ...restoreBase,
      'vault.restore': { $seq: [
        { status: 'confirm', erased: A, restored: { qnet: HISTORY_PEER, solana: SOL_RECIPIENT }, otherWallet: true },
        { status: 'restored', qnet: HISTORY_PEER, solana: SOL_RECIPIENT, lockDeadline: NOW + 900000 },
      ] },
    },
    steps: [['click', '[data-action="forgot-password"]'], ...restoreTyped, ['check', 'restore-other-confirm'],
      ['click', 'input[name="understand"]'], ['click', '[data-action="restore-confirm"]'], ['waitFor', '[data-action="continue"]'],
      ['check', 'restore-other-done']],
  },
  {
    // a stored record that does not parse: said so, the phrase's wallet named
    name: 'restore-unreadable',
    responses: { ...restoreBase, 'vault.restore': { status: 'confirm', erased: null, restored: A, otherWallet: false } },
    steps: [['click', '[data-action="forgot-password"]'], ...restoreTyped, ['check', 'restore-unreadable']],
  },
  {
    name: 'restore-failed',
    responses: { ...restoreBase, 'vault.restore': { $error: 'RESTORE_EXPIRED' } },
    steps: [['click', '[data-action="forgot-password"]'], ['type', 'textarea[name="phrase"]', KAT], pw('input[name="new-password"]'),
      pw('input[name="confirm-password"]'), ['click', '[data-action="restore"]'], ['waitFor', '[data-action="restore-again"]'], ['check', 'restore-failed']],
  },
  {
    name: 'assets',
    responses: { 'solana.balances': solBalances('0', '2000000000', false) },
    steps: [['check', 'assets-qnet'], net('solana'), ['check', 'assets-solana']],
  },
  { name: 'assets-error', responses: { 'qnet.balance': { $error: 'NETWORK' } }, steps: [['check', 'assets-error']] },
  // decision 44: a balance no committee certificate verified yet, and none certified at all
  {
    name: 'assets-unverified',
    responses: { 'qnet.balance': { ...qnetBalance, spendableNano: '12500000000', verified: false, verification: 'none' } },
    steps: [['check', 'assets-unverified']],
  },
  { name: 'assets-unconfirmed', responses: { 'qnet.balance': { $error: 'BALANCE_UNCONFIRMED' } }, steps: [['check', 'assets-unconfirmed']] },
  {
    // the send rule refuses: a transaction from another device is not confirmed yet
    name: 'send-qnet-foreign',
    responses: { 'qnet.preview': { $error: 'BALANCE_FOREIGN_PENDING' } },
    steps: [tab('send'), ['type', 'input[name="to"]', HISTORY_PEER], ['type', 'input[name="amount"]', '1'], ['click', '[data-action="review"]'],
      ['wait', 200], ['check', 'send-qnet-foreign']],
  },
  { name: 'signing-off', responses: { 'vault.status': { ...unlocked, signingEnabled: false } }, steps: [['check', 'signing-disabled']] },
  {
    name: 'send-qnet',
    responses: {
      'qnet.preview': {
        from: A.qnet, to: LOOKALIKE, amountNano: '99999999000000000', feeNano: '150000', totalNano: '99999999000150000', nonce: '4',
        balanceNano: '12500000000', verified: false, verification: 'none',
        recipient: { known: false, lookalike: true, incomingOnly: true, historyRead: true },
      },
      'qnet.send': { $seq: [{ $error: 'FEE_CHANGED' }, { txHash: TX_HASH, status: 'submitted', nonce: '4' }] },
    },
    steps: [tab('send'), ['check', 'send-qnet'], ['type', 'input[name="to"]', 'not an address'], ['click', '[data-action="review"]'],
      ['check', 'send-qnet-invalid'], ['type', 'input[name="to"]', LOOKALIKE], ['type', 'input[name="amount"]', '99999999'],
      ['click', '[data-action="review"]'], ['waitFor', '[data-action="confirm-send"]'], ['check', 'review-qnet-warnings'],
      ['click', '[data-action="confirm-send"]'], ['waitFor', '[data-action="confirm-send"]'], ['check', 'review-qnet-fee-changed'],
      ['click', '[data-action="confirm-send"]'], ['waitFor', '[data-action="done"]'], ['check', 'sent-qnet']],
  },
  {
    name: 'send-qnet-unknown',
    responses: {
      'qnet.preview': {
        from: A.qnet, to: HISTORY_PEER, amountNano: '1000000000', feeNano: '150000', totalNano: '1000150000', nonce: '4', balanceNano: '12500000000',
        verified: true, verification: 'proof', recipient: { known: false, lookalike: false, incomingOnly: false, historyRead: true },
      },
      'qnet.send': { txHash: null, status: 'unknown', nonce: '4' },
    },
    steps: [tab('send'), ['type', 'input[name="to"]', HISTORY_PEER], ['type', 'input[name="amount"]', '1'], ['click', '[data-action="review"]'],
      ['waitFor', '[data-action="confirm-send"]'], ['check', 'review-qnet'], ['click', '[data-action="confirm-send"]'],
      ['waitFor', '[data-action="done"]'], ['check', 'sent-qnet-unknown']],
  },
  {
    // earlier unconfirmed sends: what is left to spend, the same payment again, and a replace at a nonce
    name: 'send-qnet-outstanding',
    responses: {
      'qnet.balance': { ...qnetBalance, spendableNano: '11499850000' },
      'qnet.preview': { $seq: [
        {
          from: A.qnet, to: HISTORY_PEER, amountNano: '1000000000', feeNano: '150000', totalNano: '1000150000', nonce: '7', balanceNano: '11499850000',
          verified: true, verification: 'proof', recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true, recentSame: true },
          outstanding, replacesNonce: null,
        },
        {
          from: A.qnet, to: HISTORY_PEER, amountNano: '1000000000', feeNano: '150000', totalNano: '1000150000', nonce: '5', balanceNano: '12500000000',
          verified: true, verification: 'proof', recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true, recentSame: true },
          outstanding, replacesNonce: '5',
        },
      ] },
    },
    steps: [tab('send'), ['check', 'send-qnet-spendable'], ['type', 'input[name="to"]', HISTORY_PEER], ['type', 'input[name="amount"]', '1'],
      ['click', '[data-action="review"]'], ['waitFor', '[data-action="replace-pending"]'], ['check', 'review-qnet-outstanding'],
      ['click', '[data-action="replace-pending"]'], ['waitFor', '[data-action="confirm-send"]'], ['check', 'review-qnet-replaces']],
  },
  {
    // the replaced transfer was decided meanwhile: never a review of an additional send (R3-EXTQ-03); a history
    // that could not be read is said (R3-EXTQ-01)
    name: 'send-qnet-replace-decided',
    responses: {
      'qnet.preview': { $seq: [
        {
          from: A.qnet, to: HISTORY_PEER, amountNano: '1000000000', feeNano: '150000', totalNano: '1000150000', nonce: '7', balanceNano: '11499850000',
          verified: true, verification: 'proof', recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: false, recentSame: false },
          outstanding, replacesNonce: null, duplicate: true,
        },
        {
          from: A.qnet, to: HISTORY_PEER, amountNano: '1000000000', feeNano: '150000', totalNano: '1000150000', nonce: '5', balanceNano: '12500000000',
          verified: true, verification: 'proof', recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: false, recentSame: false },
          outstanding, replacesNonce: '5', duplicate: true,
        },
      ] },
      'qnet.send': { $error: 'NONCE_CHANGED' },
    },
    steps: [tab('send'), ['type', 'input[name="to"]', HISTORY_PEER], ['type', 'input[name="amount"]', '1'],
      ['click', '[data-action="review"]'], ['waitFor', '[data-action="replace-pending"]'], ['check', 'review-qnet-history-unread'],
      ['click', '[data-action="replace-pending"]'], ['waitFor', '[data-action="confirm-send"]'], ['click', '[data-action="confirm-send"]'],
      ['waitFor', '[data-action="history"]'], ['check', 'review-qnet-replace-decided']],
  },
  {
    name: 'send-solana',
    responses: {
      'solana.quote': solanaQuote(),
      'solana.max': { amount: '5000', amountRaw: '5000000000' },
      'solana.send': { signature: BURN_TX, status: 'submitted', lastValidBlockHeight: 150 },
      'solana.status': { status: 'pending' },
    },
    steps: [net('solana'), tab('send'), ['click', '.segmented [data-value="1dev"]'], ['check', 'send-solana'],
      ['type', 'input[name="to"]', SOL_RECIPIENT], ['click', '[data-action="max"]'], ['wait', 100], ['check', 'send-solana-max'],
      ['click', '[data-action="review"]'], ['waitFor', '[data-action="confirm-send"]'], ['check', 'review-solana'],
      ['waitFor', '[data-action="confirm-send"]:not([disabled])'], ['click', '[data-action="confirm-send"]'],
      ['waitFor', '[data-action="done"]'], ['check', 'sent-solana-pending']],
  },
  {
    // a payment request typed in fills the form (label, message and memo as text, the references counted); its review
    // names them, with a shortfall
    name: 'send-solana-request',
    responses: {
      'solana.quote': solanaQuote({
        shortfall: 'SOL_BELOW_RENT', recipient: { known: true, lookalike: false }, references: REQUEST_REFERENCES, memo: REQUEST_MEMO,
      }),
    },
    steps: [net('solana'), tab('send'), ['type', 'input[name="to"]', PAY_REQUEST], ['click', '[data-action="review"]'], ['wait', 100],
      ['check', 'send-solana-request'], ['click', '[data-action="review"]'], ['waitFor', '[data-action="confirm-send"]'],
      ['check', 'review-solana-request-shortfall']],
  },
  {
    name: 'send-solana-request-refused',
    steps: [net('solana'), tab('send'), ['type', 'input[name="to"]', `solana:${SOL_RECIPIENT}?amount=1&amount=2`],
      ['click', '[data-action="review"]'], ['wait', 100], ['check', 'send-solana-request-refused']],
  },
  {
    name: 'send-solana-short',
    responses: { 'solana.quote': solanaQuote({ asset: 'sol', mint: null, decimals: 9, amountRaw: '3000000000', createsRecipientAccount: false,
      rentLamports: '0', totalLamports: '3000005000', tokenRaw: null, shortfall: 'INSUFFICIENT_SOL' }) },
    steps: [net('solana'), tab('send'), ['type', 'input[name="to"]', SOL_RECIPIENT], ['type', 'input[name="amount"]', '3'],
      ['click', '[data-action="review"]'], ['waitFor', '[data-action="confirm-send"]'], ['check', 'review-solana-short-sol']],
  },
  ...['finalized', 'failed', 'expired'].map((status) => ({
    name: `sent-solana-${status}`,
    responses: {
      'solana.quote': solanaQuote(),
      'solana.send': { signature: BURN_TX, status: 'submitted', lastValidBlockHeight: 150 },
      'solana.status': { status },
    },
    steps: [...solanaSendSteps, ['wait', 2600], ['check', `sent-solana-${status}`]],
  })),
  { name: 'receive', steps: [tab('receive'), ['check', 'receive-qnet'], net('solana'), ['check', 'receive-solana'], ['click', '[data-action="copy-address"]'], ['wait', 150], ['check', 'receive-toast']] },
  { name: 'history', steps: [tab('history'), ['check', 'history'], net('solana'), ['check', 'history-solana']] },
  { name: 'history-empty', responses: { 'qnet.history': { items: [], cursor: null, pending: [] } }, steps: [tab('history'), ['check', 'history-empty']] },
  // one line per row whatever the amount (owner, 04.10): the largest QNC amount each way
  {
    name: 'history-largest',
    responses: {
      'qnet.history': {
        items: ['in', 'out', 'self'].map((direction) => ({ ...item(direction), amountNano: '18446744073709551615' })), cursor: null, pending: [],
      },
      'solana.history': { items: [], cursor: null },
    },
    steps: [tab('history'), ['check', 'history-largest'], net('solana'), ['check', 'history-solana-empty']],
  },
  // what this session read shows at once on both networks (owner, 04.10)
  {
    name: 'cached',
    responses: { 'wallet.cached': { qnetBalance, qnetHistory: history, solanaBalances: solBalances(), solanaHistory }, 'qnet.balance': { $pending: true } },
    steps: [['check', 'assets-cached'], tab('history'), ['check', 'history-cached'], net('solana'), ['check', 'history-solana-cached']],
  },
  {
    name: 'history-unconfirmed',
    responses: {
      'qnet.history': {
        items: [item('in')], cursor: null,
        pending: [pendingItem('pending', '7'), pendingItem('stale', '6'), pendingItem('replaced', '5'), pendingItem('unknown', '4')],
      },
    },
    steps: [tab('history'), ['check', 'history-unconfirmed']],
  },
  // a history row opens its detail (owner, 06.10): a confirmed transfer, a dropped send, a token row, a Solana burn
  {
    name: 'history-detail',
    responses: {
      'qnet.history': { items: [{ ...item('out'), amountNano: '18446744073709551615', block: 2068632 }, tokenItem], cursor: null,
        pending: [pendingItem('dropped', '9')] },
      'qnet.txLookup': { status: 'in_block', blockHeight: 2068700 },
    },
    steps: [tab('history'), ['check', 'history-resolved'], ['click', '.history li:nth-child(2) [data-action="open-detail"]'], ['check', 'history-detail-qnet'],
      ['click', '.history-detail [data-action="back"]'], ['click', '.history li:nth-child(1) [data-action="open-detail"]'], ['check', 'history-detail-dropped'],
      ['click', '.history-detail [data-action="back"]'], ['click', '.history li:nth-child(3) [data-action="open-detail"]'], ['wait', 100],
      ['check', 'history-detail-token'], ['click', '.history-detail [data-action="back"]'], net('solana'),
      ['click', '.history li:nth-child(2) [data-action="open-detail"]'], ['check', 'history-detail-solana']],
  },
  // a row of every kind under its day (owner, 06.10): a send another transaction replaced (today), the largest node
  // balance moved in (yesterday), a node registration with its node (three days ago), a burn (five days ago), a token
  // row of last year and a deploy with no time; the registration's detail
  {
    name: 'history-kinds',
    responses: {
      'qnet.history': {
        items: [
          { ...item('in'), hash: '12'.repeat(32), from: 'system_rewards_pool', amountNano: '18446744073709551615', feeNano: '0', kind: 'reward',
            timestamp: MIDNIGHT - 3600000 },
          { ...item('out'), hash: 'ef'.repeat(32), to: '', amountNano: '0', feeNano: '0', kind: 'node_registration', nodeId: NODE_ID,
            block: 2068800, timestamp: MIDNIGHT - 3 * 86400000 },
          { ...item('out'), hash: '56'.repeat(32), to: core.CANONICAL_BURN_ADDRESS, amountNano: '5000000000', timestamp: MIDNIGHT - 5 * 86400000 + 3600000 },
          { ...tokenItem, timestamp: MIDNIGHT - 400 * 86400000 },
          { ...item('out'), hash: '34'.repeat(32), to: '', amountNano: '0', kind: 'deploy', timestamp: 0 },
        ],
        cursor: null,
        pending: [{ ...pendingItem('replaced', '8'), timestamp: NOW }],
      },
    },
    steps: [tab('history'), ['check', 'history-kinds'], ['click', '.history-day:nth-child(3) [data-action="open-detail"]'],
      ['check', 'history-detail-node']],
  },
  // a received token named after QNC: its row and its detail with the notice (M-5)
  {
    name: 'history-token-reserved',
    responses: { 'qnet.history': { items: [fakeTokenItem], cursor: null, pending: [] } },
    steps: [tab('history'), ['check', 'history-token-reserved'], ['click', '[data-action="open-detail"]'], ['wait', 100],
      ['check', 'history-detail-token-reserved']],
  },
  // any QNet token can be sent (owner, 06.10): the picker with the tokens, a token's form and its review with every warning
  {
    name: 'send-token',
    responses: { 'qnet.tokenPreview': tokenPreview },
    steps: [tab('send'), ['check', 'send-token-picker'], ['select', 'select[name="asset"]', TOKEN_FAKE], ['check', 'send-token-reserved'],
      ['select', 'select[name="asset"]', TOKEN_LONG], ['check', 'send-token-long'],
      ['select', 'select[name="asset"]', TOKEN_GOLD], ['type', 'input[name="to"]', LOOKALIKE], ['type', 'input[name="amount"]', '18446744073709.551615'],
      ['click', '[data-action="review"]'], ['waitFor', '[data-action="confirm-send"]'], ['check', 'review-token']],
  },
  {
    // decision 44: the token balance a send is decided by is not confirmed yet
    name: 'send-token-unconfirmed',
    responses: { 'qnet.tokenPreview': { ...tokenPreview, tokenBalance: null, tokenProblem: 'BALANCE_UNCONFIRMED' } },
    steps: [tab('send'), ['select', 'select[name="asset"]', TOKEN_GOLD], ['type', 'input[name="to"]', LOOKALIKE],
      ['type', 'input[name="amount"]', '18446744073709.551615'], ['click', '[data-action="review"]'], ['waitFor', '[data-action="confirm-send"]'],
      ['check', 'review-token-unconfirmed']],
  },
  { name: 'activate', steps: [tab('activate'), ['check', 'activate-overview']] },
  { name: 'activate-no-sol', responses: { 'solana.balances': solBalances('5000000000', '5000') }, steps: [tab('activate'), ['check', 'activate-no-sol']] },
  {
    name: 'activate-unavailable',
    responses: { 'activation.price': { $error: 'PRICE_UNAVAILABLE' }, 'solana.balances': { $error: 'SOLANA_UNAVAILABLE' } },
    steps: [tab('activate'), ['check', 'activate-price-unavailable']],
  },
  { name: 'activate-phase2', responses: { 'activation.price': { ...price, phase: 2 } }, steps: [tab('activate'), ['check', 'activate-phase2']] },
  { name: 'activate-pending', responses: { 'activation.status': { activation: null, pending: pendingBurn, busy: false } }, steps: [tab('activate'), ['check', 'activate-pending']] },
  { name: 'activate-busy', responses: { 'activation.status': { activation: null, pending: null, busy: true } }, steps: [tab('activate'), ['check', 'activate-busy']] },
  // the tab of a Super activation: the one line to aiqnet.io/node (owner, 06.10: the code is in Settings)
  {
    name: 'activate-code',
    responses: { 'activation.status': { activation: activationOf('super'), pending: null, busy: false } },
    steps: [tab('activate'), ['waitFor', '.inline-link'], ['check', 'activate-super']],
  },
  // the code in Settings (owner, 06.10): one plain row, masked, Show and Copy; a read that fails says why, then the code shown
  {
    name: 'settings-code',
    responses: {
      'activation.status': { activation: activationOf('super'), pending: null, busy: false },
      'activation.copy': { $seq: [{ $error: 'NOT_FOUND' }, { code: 'QNET-SFEFD9-706058-537636' }] },
    },
    steps: [tab('settings'), ['waitFor', '[data-action="show-code"]'], ['check', 'settings-code'], ['click', '[data-action="show-code"]'],
      ['wait', 50], ['check', 'settings-code-error'], ['click', '[data-action="show-code"]'], ['wait', 50], ['check', 'settings-code-shown'],
      ['click', '[data-action="copy-code"]'], ['wait', 100], ['check', 'settings-code-copied']],
  },
  // what an earlier version left (M-4): offered for removal in Settings, behind one confirmation
  {
    name: 'settings-earlier',
    responses: { 'vault.status': { ...unlocked, earlier: true }, 'vault.removeEarlier': { $error: 'LOCKED' } },
    steps: [tab('settings'), ['waitFor', '[data-action="remove-earlier"]'], ['check', 'settings-earlier'], ['click', '[data-action="remove-earlier"]'],
      ['check', 'settings-earlier-confirm'], ['click', '[data-action="confirm-remove-earlier"]'], ['wait', 50], ['check', 'settings-earlier-refused']],
  },
  // the Activate tab once the node is on chain: the code and the one line to aiqnet.io/node (owner, 06.10)
  {
    name: 'activate-onchain',
    responses: { 'activation.status': { activation: activationOf('light'), pending: null, busy: false, registration: registrationOf('onchain') } },
    steps: [tab('activate'), ['waitFor', '.inline-link'], ['check', 'activate-onchain']],
  },
  {
    name: 'burn',
    responses: { 'activation.burn': { $pending: true } },
    steps: [tab('activate'), ['click', '[data-action="choose-light"]'], ['check', 'burn-confirm'], ['click', 'input[name="acknowledge"]'],
      ['click', '[data-action="burn"]'], ['check', 'burn-progress']],
  },
  ...['SIMULATION_FAILED', 'TX_FAILED', 'INTERNAL', 'PRICE_CHANGED', 'HISTORY_TOO_LONG'].map((code) => ({
    name: `burn-${code}`,
    responses: { 'activation.burn': { $error: code } },
    steps: [tab('activate'), ['click', '[data-action="choose-super"]:not([disabled]), [data-action="choose-light"]'], ['click', 'input[name="acknowledge"]'],
      ['click', '[data-action="burn"]'], ['wait', 50], ['check', `burn-${code}`]],
  })),
  ...['ACTIVATION_RECORDED', 'ACTIVATION_RESERVED', 'RECORD_UNAVAILABLE'].map((code) => ({
    name: `burn-${code}`,
    responses: { 'activation.burn': { $error: code } },
    steps: [tab('activate'), ['click', '[data-action="choose-light"]'], ['click', 'input[name="acknowledge"]'],
      ['click', '[data-action="burn"]'], ['wait', 50], ['check', `burn-${code}`]],
  })),
  {
    name: 'burn-done',
    responses: { 'activation.burn': { status: 'finalized', code: 'QNET-LFEFD9-706058-537636', activation: activationOf('light') } },
    steps: [tab('activate'), ['click', '[data-action="choose-light"]'], ['click', 'input[name="acknowledge"]'], ['click', '[data-action="burn"]'],
      ['waitFor', '.inline-link'], ['check', 'burn-done']],
  },
  // decision 35: the Activate tab's views of the vault, aiqnet.io's record, the QNet network and the search
  { name: 'activate-checking', responses: { 'activation.lookup': lookupView('checking', { search: 'searching' }) }, steps: [tab('activate'), ['check', 'activate-checking']] },
  ...['reserved', 'sending'].map((state) => ({
    name: `activate-elsewhere-${state}`,
    responses: { 'activation.lookup': lookupView('elsewhere', { record: { ...paidRecord, state, codeMasked: null, createdAt: null } }) },
    steps: [tab('activate'), ['check', `activate-elsewhere-${state}`]],
  })),
  { name: 'activate-node', responses: { 'activation.lookup': lookupView('node', { network: 'exists' }) }, steps: [tab('activate'), ['check', 'activate-node']] },
  { name: 'activate-unusable', responses: { 'activation.lookup': lookupView('unusable', { search: 'unusable' }) }, steps: [tab('activate'), ['check', 'activate-unusable']] },
  ...['RECORD_UNAVAILABLE', 'NETWORK', 'SOLANA_UNAVAILABLE', 'HISTORY_TOO_LONG'].map((reason) => ({
    name: `activate-source-${reason}`,
    responses: { 'activation.lookup': lookupView('unavailable', { reason }) },
    steps: [tab('activate'), ['check', `activate-source-${reason}`]],
  })),
  {
    name: 'activate-record-paid',
    responses: { 'activation.lookup': lookupView('record', { record: paidRecord }), 'activation.copy': { code: 'QNET-LFEFD9-706058-537636' } },
    steps: [tab('activate'), ['waitFor', '.inline-link'], ['check', 'activate-record-paid'], tab('settings'), ['waitFor', '[data-action="show-code"]'],
      ['click', '[data-action="show-code"]'], ['wait', 50], ['check', 'settings-code-paid']],
  },
  {
    name: 'activate-record-kept',
    responses: {
      'activation.lookup': lookupView('record', {
        record: paidRecord, keptBurn: { burnTx: BURN_TX, nodeType: 'super', burnAmount: 1234567, solanaAddress: A.solana, cluster: 'devnet', createdAt: NOW },
      }),
    },
    steps: [tab('activate'), ['check', 'activate-record-kept']],
  },
  {
    // a light activation not recorded on the QNet network yet: Record on the network (no password), then recording
    name: 'activate-record',
    responses: {
      'activation.status': { activation: activationOf('light'), pending: null, busy: false, registration: null },
      'activation.register': { registration: registrationOf('queued', true) },
    },
    steps: [tab('activate'), ['waitFor', '[data-action="record"]'], ['check', 'activate-record-none'], ['click', '[data-action="record"]'],
      ['wait', 100], ['check', 'activate-record-recording']],
  },
  ...['refused', 'clock', 'onchain'].map((state) => ({
    name: `activate-record-${state}`,
    responses: {
      'activation.status': { activation: activationOf('light'), pending: null, busy: false, registration: registrationOf(state) },
      'activation.registration': { registration: registrationOf(state) },
    },
    steps: [tab('activate'), ['wait', 100], ['check', `activate-record-${state}`]],
  })),
  {
    // decision 36: the network's one-node rule refused the record (this wallet has a node of either type)
    name: 'activate-record-wallet-has-node',
    responses: {
      'activation.status': { activation: activationOf('light'), pending: null, busy: false, registration: hasNodeRefusal },
      'activation.registration': { registration: hasNodeRefusal },
    },
    steps: [tab('activate'), ['wait', 100], ['check', 'activate-record-wallet-has-node']],
  },
  {
    // a node aiqnet.io's one-time payment key paid for this wallet, found by Recover through the registration record
    name: 'activate-paid-on-site',
    responses: {
      'activation.status': { activation: paidActivation, pending: null, busy: false, registration: registrationOf('onchain') },
      'activation.registration': { registration: registrationOf('onchain') },
    },
    steps: [tab('activate'), ['wait', 100], ['check', 'activate-paid-on-site']],
  },
  {
    name: 'recover',
    responses: { 'activation.recover': { $seq: [{ found: false, complete: false, activation: null }, { $error: 'BURN_IN_PROGRESS' }] } },
    steps: [tab('activate'), ['click', '[data-action="recover"]'], ['check', 'recover-incomplete'], ['click', '[data-action="recover"]'], ['check', 'recover-error']],
  },
  {
    name: 'settings',
    responses: {
      'settings.set': { autoLockMinutes: 30, language: '$LANG' }, 'sites.revoke': { revoked: true },
      'vault.reveal': { mnemonic: KAT },
    },
    steps: [tab('settings'), ['check', 'settings'], ['click', '.settings .segmented [data-value="30"]'], ['wait', 100], ['check', 'settings-auto-lock-toast'],
      ['click', '[data-action="revoke"]'], ['wait', 100], ['check', 'settings-revoked-toast'],
      ['click', '[data-action="reveal-phrase"]'], ['check', 'reveal-password'], pw(), ['click', '[data-action="reveal"]'],
      ['waitFor', '[data-action="copy-phrase"]'], ['check', 'reveal-shown'], ['click', '[data-action="copy-phrase"]'], ['wait', 100],
      ['check', 'reveal-copy']],
  },
  // the private key, as the phrase (owner, 06.10): the account, the warning and the password, then the key at once; the
  // QNet key (64 hex characters) too
  {
    name: 'export-key',
    responses: { 'vault.exportKey': { network: 'solana', address: A.solana, privateKey: core.base58Encode(new Uint8Array(64).fill(250)) } },
    steps: [tab('settings'), ['click', '[data-action="export-key"]'], ['check', 'export-key'], ['click', '.tab-body .segmented [data-value="solana"]'],
      ['check', 'export-key-solana'], pw(), ['click', '[data-action="export"]'], ['waitFor', '[data-action="copy-key"]'], ['check', 'export-shown'],
      ['click', '[data-action="copy-key"]'], ['wait', 100], ['check', 'export-copy']],
  },
  {
    name: 'export-key-qnet',
    responses: { 'vault.exportKey': { network: 'qnet', address: A.qnet, privateKey: 'cd'.repeat(32) } },
    steps: [tab('settings'), ['click', '[data-action="export-key"]'], pw(), ['click', '[data-action="export"]'], ['waitFor', '[data-action="copy-key"]'],
      ['check', 'export-shown-qnet']],
  },
  {
    name: 'change-password',
    responses: { 'vault.changePassword': { $error: 'BACKOFF', retryAfterMs: 125000 } },
    steps: [tab('settings'), ['click', '[data-action="change-password"]'], ['check', 'change-password'], pw(),
      ['type', 'input[name="new-password"]', 'a new long password'], ['type', 'input[name="confirm-password"]', 'another one'],
      ['click', '[data-action="save-password"]'], ['check', 'change-password-mismatch'],
      ['type', 'input[name="password"]', PASSWORD], ['type', 'input[name="new-password"]', 'a new long password'], ['type', 'input[name="confirm-password"]', 'a new long password'],
      ['click', '[data-action="save-password"]'], ['check', 'change-password-backoff']],
  },
  {
    name: 'delete',
    responses: { 'vault.wipe': { $error: 'BAD_PASSWORD' } },
    steps: [tab('settings'), ['click', '[data-action="delete-wallet"]'], ['check', 'delete'], ['type', 'input[name="confirm"]', 'DELETE'], pw(),
      ['click', '[data-action="confirm-delete"]'], ['check', 'delete-wrong-password']],
  },
];

const earlierVault = { ...noVault, earlier: true };
const SETUP = [
  { name: 'welcome', responses: { 'vault.status': noVault }, steps: [['check', 'welcome']] },
  // the wallet of an earlier version (M-4): the first screen, its password (wrong, then the backoff), the new password,
  // the moved wallet; an unreadable one; and Import beside it, whose last screen offers to remove it
  {
    name: 'earlier',
    responses: {
      'vault.status': earlierVault,
      'vault.migrate': { $seq: [{ $error: 'BAD_PASSWORD' }, { checked: true }, { qnet: A.qnet, solana: A.solana, lockDeadline: NOW }] },
    },
    steps: [['check', 'earlier'], ['click', '[data-action="earlier-unlock"]'], ['check', 'earlier-password'], pw('input[name="earlier-password"]'),
      ['click', '[data-action="earlier-continue"]'], ['wait', 50], ['check', 'earlier-password-wrong'], pw('input[name="earlier-password"]'),
      ['click', '[data-action="earlier-continue"]'], ['waitFor', 'input[name="new-password"]'], ['check', 'earlier-new-password'],
      pw('input[name="new-password"]'), pw('input[name="confirm-password"]'), ['click', '[data-action="submit"]'], ['waitFor', '[data-action="close"]'],
      ['check', 'earlier-done']],
  },
  {
    name: 'earlier-backoff',
    responses: { 'vault.status': { ...earlierVault, backoffUntil: NOW + 3600000 } },
    steps: [['click', '[data-action="earlier-unlock"]'], ['check', 'earlier-backoff']],
  },
  {
    name: 'earlier-unreadable',
    responses: { 'vault.status': earlierVault, 'vault.migrate': { $error: 'VAULT_CORRUPT' } },
    steps: [['click', '[data-action="earlier-unlock"]'], pw('input[name="earlier-password"]'), ['click', '[data-action="earlier-continue"]'],
      ['waitFor', '.notice'], ['check', 'earlier-unreadable']],
  },
  {
    name: 'earlier-import',
    responses: {
      'vault.status': earlierVault, 'vault.import': { qnet: A.qnet, solana: A.solana, lockDeadline: NOW }, 'vault.removeEarlier': { $error: 'LOCKED' },
    },
    steps: [['click', '[data-action="import"]'], ['type', 'textarea[name="phrase"]', KAT], ['click', '[data-action="continue"]'],
      ['waitFor', 'input[name="new-password"]'], pw('input[name="new-password"]'), pw('input[name="confirm-password"]'), ['click', '[data-action="submit"]'],
      ['waitFor', '[data-action="remove-earlier"]'], ['check', 'earlier-import-done'], ['click', '[data-action="remove-earlier"]'],
      ['check', 'earlier-remove-confirm'], ['click', '[data-action="confirm-remove-earlier"]'], ['wait', 50], ['check', 'earlier-remove-refused']],
  },
  { name: 'exists', responses: { 'vault.status': locked }, steps: [['check', 'exists']] },
  { name: 'error', responses: { 'vault.status': { $error: 'INTERNAL' } }, steps: [['check', 'error']] },
  {
    name: 'create',
    responses: { 'vault.status': noVault, 'vault.create': { $pending: true } },
    steps: [['click', '[data-action="create"]'], ['check', 'create-hidden'], ['click', '[data-action="reveal-words"]'], ['check', 'create-words'],
      ['click', '[data-action="copy-phrase"]'], ['wait', 100], ['check', 'create-copy'], ['click', 'input[name="written"]'], ['click', '[data-action="continue"]'], ['check', 'verify'],
      ['type', '.field input', 'zoo'], ['click', '[data-action="verify"]'], ['check', 'create-mismatch'],
      ['click', '[data-action="reveal-words"]'], ['click', 'input[name="written"]'], ['click', '[data-action="continue"]'], ['words'],
      ['click', '[data-action="verify"]'], ['waitFor', 'input[name="new-password"]'], ['check', 'password'],
      ['type', 'input[name="new-password"]', 'short'], ['click', '[data-action="submit"]'], ['check', 'password-too-short'],
      ['type', 'input[name="new-password"]', 'a new long password'], ['type', 'input[name="confirm-password"]', 'another one'],
      ['click', '[data-action="submit"]'], ['check', 'password-mismatch'],
      pw('input[name="new-password"]'), pw('input[name="confirm-password"]'), ['click', '[data-action="submit"]'], ['check', 'encrypting']],
  },
  {
    name: 'import',
    responses: { 'vault.status': noVault, 'vault.import': { $seq: [{ $error: 'NETWORK' }, { qnet: A.qnet, solana: A.solana, lockDeadline: NOW }] } },
    steps: [['click', '[data-action="import"]'], ['check', 'import'], ['type', 'textarea[name="phrase"]', 'not a phrase'], ['click', '[data-action="continue"]'],
      ['check', 'import-invalid'], ['type', 'textarea[name="phrase"]', `  ${KAT.toUpperCase()}  `], ['click', '[data-action="continue"]'],
      ['waitFor', 'input[name="new-password"]'], ['check', 'import-password-normalized'], pw('input[name="new-password"]'), pw('input[name="confirm-password"]'),
      ['click', '[data-action="submit"]'], ['waitFor', 'input[name="new-password"]'], ['check', 'import-failed'],
      pw('input[name="new-password"]'), pw('input[name="confirm-password"]'), ['click', '[data-action="submit"]'], ['waitFor', '[data-action="close"]'], ['check', 'done']],
  },
];

const APPROVAL_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const approvalView = (kind, details, extra = {}) => ({
  id: APPROVAL_ID, kind, origin: 'https://aiqnet.io', originDisplay: 'https://aiqnet.io', idn: false, locked: false, queued: 2,
  createdAt: NOW, details, revision: 1, ...extra,
});
const sendDetails = (extra = {}) => ({
  to: HISTORY_PEER, amountNano: '1234567890123', feeNano: '150000', totalNano: '1234568040123', nonce: '17', balanceNano: '99999999999999',
  verified: true, verification: 'proof', balanceProblem: null, recipient: { known: false, lookalike: false, incomingOnly: false, historyRead: true },
  ...extra,
});
const knownRecipient = { known: true, lookalike: false, incomingOnly: false, historyRead: true };
// A built-in token and a game contract of the KAT wallet's deploys, and the address that destroys tokens.
const TOKEN_CONTRACT = 'da401c47c976814aa4ceon0a63be8d36c9f0ff502bd06';
const GAME_CONTRACT = '83485d2591342b03b8aeonc9ca2211bc1b2aad43bbad3';
const BURN_ADDRESS = '0000000000000000000eon00000000000000036877022';
const tokenDetails = (extra = {}) => ({
  token: TOKEN_CONTRACT, to: HISTORY_PEER, amount: '123456789.123456', amountBase: '123456789123456', name: 'Gold Coin', symbol: 'GOLD',
  decimals: 6, reserved: false, burn: false, gasLimit: '100750', feeNano: '1511250', depositNano: '10000000', totalNano: '11511250',
  nonce: '17', balanceNano: '99999999999999', verified: true, verification: 'proof', balanceProblem: null, tokenBalance: '999999999999999999',
  tokenProblem: null,
  outstanding: 0, duplicate: false, replaces: null, inFlight: false, recipient: { known: false, lookalike: false, incomingOnly: false, historyRead: true },
  ...extra,
});
const TOKEN_UNREAD = {
  gasLimit: null, feeNano: null, depositNano: null, totalNano: null, nonce: null, balanceNano: null, verified: false, verification: 'none',
  balanceProblem: null, tokenBalance: null, tokenProblem: null, recipient: null,
};
const callDetails = (extra = {}) => ({
  contract: GAME_CONTRACT, method: 'play_move', args: '6d6f76652065326534206c6f6e672064657363726970746976652074657874', argsBytes: 31,
  argsText: 'move e2e4 long descriptive text', gasLimit: '300625', feeNano: '4509375', totalNano: '4509375', nonce: '17',
  balanceNano: '99999999999999', verified: true, verification: 'proof', balanceProblem: null, outstanding: 0, replaces: null, inFlight: false,
  ...extra,
});
const activationDetails = (extra = {}) => ({
  nodeType: 'light', mode: 'burn', reason: null, cost: 1500, activation: null, pending: null,
  balances: { lamports: '2000000000', oneDevRaw: '5000000000' }, recorded: false, solanaAddress: A.solana, mint: MINT,
  tokenProgram: TOKEN_PROGRAM, cluster: 'devnet', ...extra,
});
const unlinkDetails = (extra = {}) => ({
  mode: 'confirm', reason: null, nodeId: NODE_ID, wallet: A.qnet, platform: 'unknown', linkedSince: 1_790_035_200, ...extra,
});
const claimDetails = (extra = {}) => ({
  mode: 'claim', reason: null, nodeId: NODE_ID, wallet: A.qnet, amountNano: '123456789012345678', ...extra,
});
// a send or an activation arms after CONFIRM_ARM_VALUE_MS; a press before that starts the wait over
const ARMED = TIMINGS.CONFIRM_ARM_VALUE_MS + 400;
// no password: the unlocked session and the armed press confirm (a burn also needs its acknowledgement)
const confirmBurn = [['click', '#ap-ack'], ['wait', ARMED], ['trusted', '.ap-actions .ap-btn-primary']];
const confirmArmed = [['wait', ARMED], ['trusted', '.ap-actions .ap-btn-primary']];

const APPROVE = [
  {
    name: 'unlock',
    responses: { 'approval.get': approvalView('activateNode', activationDetails({ mode: null, cost: null, balances: null, solanaAddress: null }), { locked: true }), 'vault.unlock': { $error: 'BAD_PASSWORD' } },
    steps: [['check', 'unlock'], ['type', '#ap-password', 'wrong'], ['trusted', '.ap-actions .ap-btn-primary'], ['wait', 100], ['check', 'unlock-wrong-password']],
  },
  { name: 'connect', responses: { 'approval.get': approvalView('connect', { alreadyGranted: false }), 'wallet.addresses': A }, steps: [['check', 'connect']] },
  {
    name: 'sign',
    responses: {
      'approval.get': approvalView('signMessage', {
        message: `Sign in to aiqnet.io\nNonce: ${'f'.repeat(64)}\n${'a very long line without any break '.repeat(4)}\n${'x'.repeat(300)}`, byteLength: 512,
      }, { origin: 'https://xn--80ak6aa92e.aiqnet.io', originDisplay: 'https://аррӏе.aiqnet.io', idn: true }),
    },
    steps: [['check', 'sign-idn']],
  },
  {
    // text far below what the box shows: the hint stays until the end has been in view
    name: 'sign-scroll',
    responses: { 'approval.get': approvalView('signMessage', { message: `Sign in to aiqnet.io${'\n'.repeat(60)}Transfer all funds`, byteLength: 80 }) },
    steps: [['check', 'sign-scroll-hint']],
  },
  { name: 'send', responses: { 'approval.get': approvalView('sendTransaction', sendDetails()) }, steps: [['check', 'send-first-time']] },
  {
    name: 'send-outstanding',
    responses: { 'approval.get': approvalView('sendTransaction', sendDetails({
      recipient: { ...knownRecipient, recentSame: true }, outstanding: 2, duplicate: true,
    })) },
    steps: [['check', 'send-outstanding-duplicate']],
  },
  {
    name: 'send-lookalike',
    responses: { 'approval.get': approvalView('sendTransaction', sendDetails({
      to: LOOKALIKE, recipient: { known: false, lookalike: true, incomingOnly: true, historyRead: true }, balanceNano: '1', verified: false,
      verification: 'none',
    })) },
    steps: [['check', 'send-lookalike-insufficient']],
  },
  { name: 'send-pending', responses: { 'approval.get': approvalView('sendTransaction', sendDetails({ nonce: null, balanceNano: null, verified: false, verification: 'none', recipient: null })) }, steps: [['check', 'send-preview-pending']] },
  // decision 44: why no balance a send is decided by was read, said in place of "Reading the account…"
  {
    name: 'send-balance-foreign',
    responses: { 'approval.get': approvalView('sendTransaction', sendDetails({
      nonce: null, balanceNano: null, verified: false, verification: 'none', recipient: null, balanceProblem: 'BALANCE_FOREIGN_PENDING',
    })) },
    steps: [['check', 'send-balance-foreign']],
  },
  {
    name: 'send-balance-unconfirmed',
    responses: { 'approval.get': approvalView('sendTransaction', sendDetails({
      nonce: null, balanceNano: null, verified: false, verification: 'none', recipient: null, balanceProblem: 'BALANCE_UNCONFIRMED',
    })) },
    steps: [['check', 'send-balance-unconfirmed']],
  },
  {
    name: 'send-failed',
    responses: { 'approval.get': approvalView('sendTransaction', sendDetails({ recipient: knownRecipient, verification: 'proof' })), 'approval.resolve': { $error: 'NODE_REJECTED' } },
    steps: [['wait', ARMED], ['trusted', '.ap-actions .ap-btn-primary'], ['waitFor', '.ap-error'], ['check', 'send-failed']],
  },
  {
    name: 'send-review-again',
    responses: { 'approval.get': approvalView('sendTransaction', sendDetails({ recipient: knownRecipient, verification: 'proof' })), 'approval.resolve': { $error: 'NONCE_CHANGED' } },
    steps: [['wait', ARMED], ['trusted', '.ap-actions .ap-btn-primary'], ['waitFor', '.ap-notice'], ['check', 'send-review-again']],
  },
  {
    // an earlier transaction still holds the nonce before this one's: confirm waits, and the refused one it replaces
    name: 'send-in-flight',
    responses: { 'approval.get': approvalView('sendTransaction', sendDetails({
      recipient: knownRecipient, outstanding: 3, inFlight: true,
      replaces: { nonce: '16', to: LOOKALIKE, amountNano: '1234567890123', kind: 'transfer' },
    })) },
    steps: [['check', 'send-in-flight']],
  },
  {
    name: 'token-transfer',
    responses: { 'approval.get': approvalView('tokenTransfer', tokenDetails()) },
    steps: [['check', 'token-transfer-deposit']],
  },
  {
    // a token named after QNC, sent to the burn address, with a token balance short of the amount and a refused call it replaces
    name: 'token-transfer-warnings',
    responses: { 'approval.get': approvalView('tokenTransfer', tokenDetails({
      name: 'QNet Coin of the Realm with a very long name', symbol: 'QNC', reserved: true, burn: true, to: BURN_ADDRESS,
      tokenBalance: '1', duplicate: true, inFlight: true, recipient: { known: false, lookalike: true, incomingOnly: true, historyRead: true },
      replaces: { nonce: '16', to: GAME_CONTRACT, amountNano: '0', kind: 'call' },
    })) },
    steps: [['check', 'token-transfer-warnings']],
  },
  { name: 'token-transfer-pending', responses: { 'approval.get': approvalView('tokenTransfer', tokenDetails(TOKEN_UNREAD)) }, steps: [['check', 'token-transfer-pending']] },
  {
    name: 'token-transfer-unconfirmed',
    responses: { 'approval.get': approvalView('tokenTransfer', tokenDetails({ tokenBalance: null, tokenProblem: 'BALANCE_UNCONFIRMED' })) },
    steps: [['check', 'token-transfer-unconfirmed']],
  },
  {
    name: 'contract-call',
    responses: { 'approval.get': approvalView('contractCall', callDetails()) },
    steps: [['check', 'contract-call-text']],
  },
  {
    // the largest input a site may send, hex only, and an explicit gas limit
    name: 'contract-call-large',
    responses: { 'approval.get': approvalView('contractCall', callDetails({
      method: `a_${'long_method_name_'.repeat(3)}x`.slice(0, 64), args: 'ff'.repeat(4096), argsBytes: 4096, argsText: null, gasLimit: '1000000',
      feeNano: '15000000', totalNano: '15000000', inFlight: true,
    })) },
    steps: [['check', 'contract-call-large']],
  },
  { name: 'contract-call-no-input', responses: { 'approval.get': approvalView('contractCall', callDetails({ args: '', argsBytes: 0, argsText: null })) }, steps: [['check', 'contract-call-no-input']] },
  {
    name: 'activate-burn',
    responses: { 'approval.get': approvalView('activateNode', activationDetails({ nodeType: 'super', cost: 6000, balances: { lamports: '2000000000', oneDevRaw: '6000000000' } })), 'approval.resolve': { $pending: true } },
    steps: [['check', 'activate-burn'], ...confirmBurn, ['waitFor', '.progress'], ['check', 'activate-progress']],
  },
  {
    name: 'activate-price-changed',
    responses: { 'approval.get': approvalView('activateNode', activationDetails()), 'approval.resolve': { $error: 'PRICE_CHANGED' } },
    steps: [...confirmBurn, ['waitFor', '.ap-notice'], ['check', 'activate-price-changed']],
  },
  {
    name: 'activate-exists',
    responses: { 'approval.get': approvalView('activateNode', activationDetails({ mode: 'exists', cost: null, activation: activationOf('super') })), 'approval.resolve': { resolved: true, status: 'exists', error: null, nodeType: 'super' } },
    steps: [['check', 'activate-exists'], ...confirmArmed, ['waitFor', '.ap-ok'], ['check', 'activate-outcome-exists']],
  },
  {
    name: 'activate-pending',
    responses: { 'approval.get': approvalView('activateNode', activationDetails({ mode: 'pending', cost: null, pending: pendingBurn })), 'approval.resolve': { $pending: true } },
    steps: [['check', 'activate-pending'], ...confirmArmed, ['wait', 100], ['check', 'activate-checking']],
  },
  { name: 'activate-reading', responses: { 'approval.get': approvalView('activateNode', activationDetails({ mode: null, cost: null, balances: null })) }, steps: [['check', 'activate-reading']] },
  // decision 35: nothing offered while the wallet is checked
  { name: 'activate-checking-wallet', responses: { 'approval.get': approvalView('activateNode', activationDetails({ mode: 'checking', cost: null, balances: null })) }, steps: [['check', 'activate-checking-wallet']] },
  ...['PRICE_UNAVAILABLE', 'PHASE_UNSUPPORTED', 'NODE_EXISTS', 'BURN_IN_PROGRESS', 'INSUFFICIENT_TOKENS', 'INSUFFICIENT_SOL', 'SIGNING_DISABLED',
    'ACTIVATION_RECORDED', 'ACTIVATION_RESERVED', 'RECORD_UNAVAILABLE', 'BURN_UNUSABLE', 'HISTORY_TOO_LONG'].map((reason) => ({
    name: `activate-unavailable-${reason}`,
    responses: {
      'approval.get': approvalView('activateNode', activationDetails({
        mode: 'unavailable', reason,
        cost: reason.startsWith('INSUFFICIENT') ? 6000 : null,
        balances: reason.startsWith('INSUFFICIENT') ? { lamports: '5000', oneDevRaw: '1500000000' } : null,
      })),
    },
    steps: [['check', `activate-unavailable-${reason}`]],
  })),
  ...[['ok', null], ['pending', null], ['error', 'TX_FAILED'], ['error', 'INTERNAL'], ['error', 'INSUFFICIENT_SOL']].map(([status, error]) => ({
    name: `activate-outcome-${status}${error ? `-${error}` : ''}`,
    responses: { 'approval.get': approvalView('activateNode', activationDetails()), 'approval.resolve': { resolved: true, status, error } },
    steps: [...confirmBurn, ['waitFor', '.ap-actions .ap-btn-primary'], ['wait', 50], ['check', `activate-outcome-${status}${error ? `-${error}` : ''}`]],
  })),
  // a light burn, and an existing light activation, are recorded on the QNet network after the answer
  { name: 'activate-burn-light', responses: { 'approval.get': approvalView('activateNode', activationDetails()) }, steps: [['check', 'activate-burn-light']] },
  {
    name: 'activate-exists-light',
    responses: {
      'approval.get': approvalView('activateNode', activationDetails({
        mode: 'exists', cost: null, activation: activationOf('light'),
      })),
      'approval.resolve': { resolved: true, status: 'exists', error: null, registration: { nodeId: NODE_ID, state: 'queued', automatic: true } },
      'activation.registration': { registration: registrationOf('queued', true) },
    },
    steps: [['check', 'activate-exists-light'], ...confirmArmed, ['waitFor', '.ap-ok'], ['check', 'activate-outcome-exists-recording']],
  },
  ...['onchain', 'refused', 'clock'].map((state) => ({
    name: `activate-outcome-record-${state}`,
    responses: {
      'approval.get': approvalView('activateNode', activationDetails()),
      'approval.resolve': { resolved: true, status: 'ok', error: null, nodeType: 'light', registration: { nodeId: NODE_ID, state, automatic: false } },
      'activation.registration': { registration: registrationOf(state) },
    },
    steps: [...confirmBurn, ['waitFor', '.ap-actions .ap-btn-primary'], ['wait', 50], ['check', `activate-outcome-record-${state}`]],
  })),
  {
    name: 'activate-outcome-record-wallet-has-node',
    responses: {
      'approval.get': approvalView('activateNode', activationDetails()),
      'approval.resolve': { resolved: true, status: 'ok', error: null, nodeType: 'light', registration: { nodeId: NODE_ID, state: 'refused', automatic: false } },
      'activation.registration': { registration: hasNodeRefusal },
    },
    steps: [...confirmBurn, ['waitFor', '.ap-actions .ap-btn-primary'], ['wait', 100], ['check', 'activate-outcome-record-wallet-has-node']],
  },
  // Move to wallet (qnet_claimNodeBalance): the balance, the armed confirm, the outcome
  {
    name: 'claim',
    responses: {
      'approval.get': approvalView('claimNodeBalance', claimDetails()),
      'approval.resolve': { resolved: true, status: 'ok', error: null, amountNano: '123456789012345678', partial: true },
    },
    steps: [['check', 'claim'], ['wait', ARMED], ['trusted', '.ap-actions .ap-btn-primary'], ['waitFor', '.ap-ok'], ['check', 'claim-outcome-ok-partial']],
  },
  {
    name: 'claim-progress',
    responses: { 'approval.get': approvalView('claimNodeBalance', claimDetails()), 'approval.resolve': { $pending: true } },
    steps: [['wait', ARMED], ['trusted', '.ap-actions .ap-btn-primary'], ['waitFor', '.progress'], ['check', 'claim-progress']],
  },
  { name: 'claim-reading', responses: { 'approval.get': approvalView('claimNodeBalance', claimDetails({ mode: null, nodeId: null, wallet: null, amountNano: null })) }, steps: [['check', 'claim-reading']] },
  { name: 'claim-empty', responses: { 'approval.get': approvalView('claimNodeBalance', claimDetails({ mode: 'empty', amountNano: '999999999' })) }, steps: [['check', 'claim-empty']] },
  ...['NO_NODE', 'NETWORK', 'SIGNING_DISABLED'].map((reason) => ({
    name: `claim-unavailable-${reason}`,
    responses: { 'approval.get': approvalView('claimNodeBalance', claimDetails({ mode: 'unavailable', reason, amountNano: null })) },
    steps: [['check', `claim-unavailable-${reason}`]],
  })),
  ...[['empty', null], ['error', 'CLAIM_BUSY'], ['error', 'CLAIM_REFUSED'], ['error', 'NETWORK']].map(([status, error]) => ({
    name: `claim-outcome-${status}${error ? `-${error}` : ''}`,
    responses: { 'approval.get': approvalView('claimNodeBalance', claimDetails()), 'approval.resolve': { resolved: true, status, error, amountNano: null, partial: false } },
    steps: [['wait', ARMED], ['trusted', '.ap-actions .ap-btn-primary'], ['waitFor', '.ap-actions .ap-btn-primary'], ['wait', 50],
      ['check', `claim-outcome-${status}${error ? `-${error}` : ''}`]],
  })),
  // Unlink the node's device (qnet_unlinkNodeDevice, decision 38): the device, the armed confirm, the outcome
  {
    name: 'unlink',
    responses: { 'approval.get': approvalView('unlinkNodeDevice', unlinkDetails()), 'approval.resolve': { resolved: true, status: 'ok', error: null } },
    steps: [['check', 'unlink'], ...confirmArmed, ['waitFor', '.ap-ok'], ['check', 'unlink-outcome-ok']],
  },
  {
    name: 'unlink-progress',
    responses: { 'approval.get': approvalView('unlinkNodeDevice', unlinkDetails({ platform: 'ios' })), 'approval.resolve': { $pending: true } },
    steps: [...confirmArmed, ['waitFor', '.progress'], ['check', 'unlink-progress']],
  },
  {
    name: 'unlink-reading',
    responses: { 'approval.get': approvalView('unlinkNodeDevice', unlinkDetails({ mode: null, nodeId: null, wallet: null, platform: null, linkedSince: null })) },
    steps: [['check', 'unlink-reading']],
  },
  ...['NOT_LINKED', 'UNSUPPORTED', 'NETWORK', 'SIGNING_DISABLED'].map((reason) => ({
    name: `unlink-unavailable-${reason}`,
    responses: { 'approval.get': approvalView('unlinkNodeDevice', unlinkDetails({ mode: 'unavailable', reason, platform: null, linkedSince: null })) },
    steps: [['check', `unlink-unavailable-${reason}`]],
  })),
  ...['NOT_LINKED', 'UNLINK_REFUSED', 'NETWORK'].map((error) => ({
    name: `unlink-outcome-${error}`,
    responses: { 'approval.get': approvalView('unlinkNodeDevice', unlinkDetails()), 'approval.resolve': { resolved: true, status: 'error', error } },
    steps: [...confirmArmed, ['waitFor', '.ap-error'], ['wait', 50], ['check', `unlink-outcome-${error}`]],
  })),
];

// oneLine: the widths at which a whole address must stay on one line
const PAGES = [
  { page: 'popup', html: 'ui/popup.html', widths: [360], height: 600, scenarios: POPUP, base: popupBase, oneLine: [360] },
  {
    page: 'setup', html: 'ui/setup.html', widths: [360, 800], height: 900, scenarios: SETUP,
    base: { 'vault.status': noVault }, oneLine: [800],
  },
  { page: 'approve', html: `ui/approve.html?id=${APPROVAL_ID}`, widths: [400, 360], height: 640, scenarios: APPROVE, base: {}, oneLine: [400, 360] },
];

// ---------------------------------------------------------------- the page side

// Runs in the page before its scripts: chrome.runtime answered from the scenario, and the measuring code.
function pageScript(responses, language, localStorageItems) {
  const data = JSON.stringify({ responses, language, localStorage: localStorageItems, mono: MONO });
  return `(() => {
  const S = ${data};
  if (S.mono) document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('--font-mono', JSON.stringify(S.mono)));
  const counters = {};
  let inflight = 0;
  const missing = [];
  const answer = (type) => {
    let entry = S.responses[type];
    if (entry && Array.isArray(entry.$seq)) {
      counters[type] = (counters[type] ?? -1) + 1;
      entry = entry.$seq[Math.min(counters[type], entry.$seq.length - 1)];
    }
    if (entry === undefined) {
      missing.push(type);
      return { ok: false, error: { code: 'INTERNAL', message: 'Internal error' } };
    }
    if (entry && typeof entry.$error === 'string') {
      const error = { code: entry.$error, message: entry.$error };
      if (entry.retryAfterMs) error.retryAfterMs = entry.retryAfterMs;
      return { ok: false, error };
    }
    return { ok: true, result: JSON.parse(JSON.stringify(entry).replaceAll('"$LANG"', JSON.stringify(S.language))) };
  };
  try {
    // every scenario starts from its own page storage: the origin's localStorage outlives the tab
    // (sessionStorage does not), so it is emptied once per tab before the scenario's own items
    if (sessionStorage.getItem('__qnet_overflow_tab') === null) {
      localStorage.clear();
      sessionStorage.setItem('__qnet_overflow_tab', '1');
    }
    for (const [key, value] of Object.entries(S.localStorage)) localStorage.setItem(key, value);
  } catch {}
  const listeners = new Set();
  window.chrome = {
    runtime: {
      id: 'qnetoverflowcheckpagesonly',
      getURL: (p = '') => location.origin + '/' + String(p).replace(/^\\/+/, ''),
      getManifest: () => ({}),
      onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
      sendMessage: (message) => {
        const entry = S.responses[message.type];
        if (entry && entry.$pending) return new Promise(() => {});
        inflight += 1;
        return new Promise((resolve) => setTimeout(() => {
          inflight -= 1;
          resolve({ id: message.id, ...answer(message.type) });
        }, 0));
      },
    },
    tabs: { create: async () => ({ id: 1 }), getCurrent: async () => ({ id: 1 }), remove: async () => {} },
  };
  const describe = (node) => {
    const cls = typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '';
    const action = node.getAttribute('data-action') ? '[data-action=' + node.getAttribute('data-action') + ']' : '';
    return node.tagName.toLowerCase() + cls + action + ' "' + (node.textContent || node.placeholder || '').trim().slice(0, 70) + '"';
  };
  let canvas = null;
  const textWidth = (text, style) => {
    canvas ??= document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
    return context.measureText(text).width;
  };
  window.__q = {
    missing,
    idle: () => inflight === 0,
    ready: () => document.getElementById('app') !== null && document.getElementById('app').childElementCount > 0,
    click: (selector) => {
      const node = document.querySelector(selector);
      if (!node) return false;
      node.click();
      return true;
    },
    type: (selector, text) => {
      const node = document.querySelector(selector);
      if (!node) return false;
      node.value = text;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    select: (selector, value) => {
      const node = document.querySelector(selector);
      if (!node) return false;
      node.value = value;
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    hold: (selector) => {
      const node = document.querySelector(selector);
      if (!node) return false;
      node.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      return true;
    },
    exists: (selector) => document.querySelector(selector) !== null,
    words: () => {
      const inputs = [...document.querySelectorAll('input[name^="word-"]')];
      for (const input of inputs) {
        const index = Number(input.name.slice(5)) - 1;
        input.value = window.__words[index];
      }
      return inputs.length > 0;
    },
    rememberWords: () => {
      const words = [...document.querySelectorAll('.word-grid .word')].map((node) => node.textContent);
      if (words.length > 0) window.__words = words;
    },
    center: (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      node.scrollIntoView({ block: 'center' });
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    measure: (oneLine) => {
      const problems = [];
      // a whole address on one line (owner, 29.09): the popup's addressText/addressCopy and the approval window's blocks
      if (oneLine) {
        for (const node of document.querySelectorAll('.addr, .ap-address')) {
          if (!/^[0-9A-Za-z]{32,45}$/.test((node.textContent || '').trim()) || node.getClientRects().length === 0) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.bottom)));
          if (lines.size > 1) {
            const box = node.closest('.account-address, .kv-addr, .ap-card') ?? node.parentElement;
            problems.push('address on ' + lines.size + ' lines ' + describe(node) + ' (' + getComputedStyle(node).fontSize + ' type, '
              + (box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight)) + ' px box)');
          }
        }
      }
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth) problems.push('page: scrollWidth ' + root.scrollWidth + ' > ' + root.clientWidth);
      for (const node of document.body.querySelectorAll('*')) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || node.getClientRects().length === 0) continue;
        if (node.tagName === 'OPTION' || node.tagName === 'SCRIPT' || node.tagName === 'LINK') continue;
        // a bar that scrolls sideways on purpose (the tab bar in a long language) is no overflow
        const scrollsX = style.overflowX === 'auto' || style.overflowX === 'scroll';
        if (!scrollsX && node.clientWidth > 0 && node.scrollWidth > node.clientWidth) {
          problems.push('overflow-x ' + describe(node) + ': ' + node.scrollWidth + ' > ' + node.clientWidth);
        }
        const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
        if (!scrolls && node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 1 && node.tagName !== 'TEXTAREA' && node.tagName !== 'SELECT') {
          problems.push('overflow-y ' + describe(node) + ': ' + node.scrollHeight + ' > ' + node.clientHeight);
        }
        const room = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (node.tagName === 'INPUT' && node.placeholder && node.value === '' && textWidth(node.placeholder, style) > room + 0.5) {
          problems.push('placeholder ' + describe(node) + ': ' + Math.ceil(textWidth(node.placeholder, style)) + ' > ' + Math.floor(room));
        }
        if (node.tagName === 'SELECT') {
          const option = node.options[node.selectedIndex];
          const width = option ? textWidth(option.textContent, style) : 0;
          if (width > room - 16) problems.push('select ' + describe(node) + ': ' + Math.ceil(width) + ' > ' + Math.floor(room - 16));
        }
      }
      if (document.body.clientWidth > 0 && document.body.scrollWidth > document.body.clientWidth) problems.push('body: ' + document.body.scrollWidth + ' > ' + document.body.clientWidth);
      return problems;
    },
  };
})();`;
}

// ---------------------------------------------------------------- Chrome over the DevTools pipe

function launchChrome(profile) {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-extensions', ...(SCROLLBARS ? [] : ['--hide-scrollbars']), '--force-device-scale-factor=1', '--window-size=1200,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  // settles once Chrome has exited, by an exit code or a signal (exitCode stays null after a signal)
  let running = true;
  const exited = new Promise((resolve) => proc.once('exit', resolve)).then(() => { running = false; });
  const out = proc.stdio[3];
  const input = proc.stdio[4];
  // a write to the pipe of a Chrome that is exiting fails with EPIPE: its exit is handled above, not as a crash
  out.on('error', () => {});
  let buffer = '';
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  input.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    }
  });
  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, { resolve, reject });
    out.write(`${JSON.stringify({ id: seq, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  return {
    send,
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // true once Chrome has exited: only then may the profile be removed, Windows keeps its files locked until then
    // (EXT-R4-03). A Chrome already gone never answers Browser.close, so the reply is not waited for alone.
    close: async () => {
      if (running) await Promise.race([send('Browser.close').catch(() => {}), exited, sleep(5000)]);
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (running) await Promise.race([exited, sleep(5000)]);
        if (running) proc.kill(signal);
      }
      if (running) await Promise.race([exited, sleep(5000)]);
      return !running;
    },
  };
}

function serve(root) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': `${types[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------- runner

async function runScenario(browser, origin, spec, scenario, language, report) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => browser.send(method, params, sessionId);
  const errors = [];
  const stop = browser.onEvent((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? message.params.exceptionDetails?.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) {
      errors.push(`console.${message.params.type}: ${JSON.stringify(message.params.args?.map((a) => a.value ?? a.description)).slice(0, 200)}`);
    }
  });
  const evaluate = async (expression) => {
    const result = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const metrics = (width) => s('Emulation.setDeviceMetricsOverride', { width, height: spec.height, deviceScaleFactor: 1, mobile: false });
  const settle = async () => {
    for (let i = 0; i < 200; i += 1) {
      if (await evaluate('window.__q && window.__q.idle()')) break;
      await sleep(15);
    }
    await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  };
  const waitFor = async (selector, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`window.__q && window.__q.exists(${JSON.stringify(selector)})`)) return true;
      await sleep(30);
    }
    return false;
  };
  const label = `${spec.page}/${scenario.name}`;
  const fail = (screen, problem) => report.failures.push({ language, page: spec.page, scenario: scenario.name, screen, problem });
  try {
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Emulation.setFocusEmulationEnabled', { enabled: true });
    await metrics(spec.widths[0]);
    const responses = { 'settings.get': { autoLockMinutes: 15, language }, ...spec.base, ...(scenario.responses ?? {}) };
    if (spec.page === 'popup' && responses['activation.lookup'] === undefined && responses['activation.status']) {
      responses['activation.lookup'] = lookupFrom(responses['activation.status']);
    }
    await s('Page.addScriptToEvaluateOnNewDocument', { source: pageScript(responses, language, scenario.localStorage ?? {}) });
    await s('Page.navigate', { url: `${origin}/${spec.html}` });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !(await evaluate('Boolean(window.__q && window.__q.ready())').catch(() => false))) await sleep(30);
    await settle();
    for (const step of scenario.steps) {
      const [action, target, text] = step;
      if (action === 'check') {
        report.checks += 1;
        for (const width of spec.widths) {
          await metrics(width);
          await settle();
          const problems = await evaluate(`window.__q.measure(${spec.oneLine.includes(width)})`);
          for (const problem of problems) fail(`${target}@${width}`, problem);
          if (SHOTS && width === spec.widths[0]) {
            const dir = path.join(SHOTS, language);
            mkdirSync(dir, { recursive: true });
            // the viewport grows to the content (captureBeyondViewport loses right-to-left pages)
            const tall = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
            await s('Emulation.setDeviceMetricsOverride', { width, height: Math.max(spec.height, tall), deviceScaleFactor: 1, mobile: false });
            await settle();
            const { data } = await s('Page.captureScreenshot', { format: 'png' });
            writeFileSync(path.join(dir, `${spec.page}-${target}.png`), Buffer.from(data, 'base64'));
          }
        }
        await metrics(spec.widths[0]);
        continue;
      }
      if (action === 'wait') {
        await sleep(target);
        continue;
      }
      if (action === 'waitFor') {
        if (!(await waitFor(target))) throw new Error(`${target} did not appear`);
        continue;
      }
      if (!(await waitFor(target ?? 'body'))) throw new Error(`${target} is missing for ${action}`);
      if (action === 'click') await evaluate(`window.__q.click(${JSON.stringify(target)})`);
      else if (action === 'type') await evaluate(`window.__q.type(${JSON.stringify(target)}, ${JSON.stringify(text)})`);
      else if (action === 'hold') await evaluate(`window.__q.hold(${JSON.stringify(target)})`);
      else if (action === 'select') await evaluate(`window.__q.select(${JSON.stringify(target)}, ${JSON.stringify(text)})`);
      else if (action === 'words') await evaluate('window.__q.words()');
      else if (action === 'trusted') {
        await s('Page.bringToFront');
        const point = await evaluate(`window.__q.center(${JSON.stringify(target)})`);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await s('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
        }
      } else throw new Error(`unknown step ${action}`);
      if (action === 'click' && target.includes('reveal-words')) {
        await settle();
        await evaluate('window.__q.rememberWords()');
      }
      await settle();
    }
    const missing = await evaluate('window.__q.missing');
    for (const type of new Set(missing)) fail('-', `no scripted answer for ${type}`);
  } catch (error) {
    fail('-', `scenario stopped: ${error.message}`);
  } finally {
    stop();
    for (const message of errors) fail('-', `page error: ${message}`);
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  }
  return label;
}

const server = await serve(DIST);
const origin = `${'http'}://127.0.0.1:${server.address().port}`;
const profile = path.join(os.tmpdir(), `qnet-overflow-${process.pid}`);
const browser = launchChrome(profile);
const report = { dist: DIST, languages: LANGS, checks: 0, scenarios: 0, failures: [] };
const started = Date.now();
try {
  await browser.send('Target.setDiscoverTargets', { discover: false });
  for (const language of LANGS) {
    for (const spec of PAGES) {
      for (const scenario of spec.scenarios) {
        if (ONLY && !`${spec.page}/${scenario.name}`.includes(ONLY)) continue;
        await runScenario(browser, origin, spec, scenario, language, report);
        report.scenarios += 1;
      }
    }
    const count = report.failures.filter((f) => f.language === language).length;
    console.log(`[INFO][OVERFLOW] ${language}: ${count === 0 ? 'ok' : `${count} problem(s)`}`);
  }
} finally {
  // the cleanup never decides the exit code: what it cannot do is reported, and the run's own outcome stands (EXT-R4-03)
  const stopped = await browser.close().catch(() => false);
  server.close(() => {});
  if (!stopped) {
    console.warn(`[WARN][OVERFLOW] Chrome did not exit; its profile ${profile} is left in place`);
  } else {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.warn(`[WARN][OVERFLOW] the profile ${profile} was not removed: ${error.message}`);
    }
  }
}
report.seconds = Math.round((Date.now() - started) / 1000);
if (REPORT) writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
for (const failure of report.failures) {
  console.log(`[FAIL] ${failure.language} ${failure.page}/${failure.scenario} ${failure.screen}: ${failure.problem}`);
}
console.log(`[INFO][OVERFLOW] ${report.scenarios} scenarios, ${report.checks} screens x widths, ${LANGS.length} languages, `
  + `${report.failures.length} problem(s), ${report.seconds} s`);
process.exit(report.failures.length === 0 ? 0 : 1);
