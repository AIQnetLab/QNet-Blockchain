// The layout holds in every language on the narrowest phone the app supports (320 dp): the real screens are rendered
// with the LONGEST translation of every key, and a measured-width heuristic walks the rendered tree the way the layout
// engine does (padding, rows that share or wrap, flex shrink and grow, percentage widths) to find text that would be
// cut off, words that could not fit on a line, rows that overflow and placeholders that do not fit. The Node tab is
// also walked at tablet and split-window widths. Arabic is laid out right to left with addresses left to right (spec:
// i18n.md).
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { RefreshControl, StyleSheet, Text, TextInput } from 'react-native';

const SCREEN = 320;
const TOL = 1;
// Each test mounts the whole wallet screen several times: on a loaded machine one can outlast the global 60 s, and a
// test cut off mid-render leaves its tree to break the ones after it.
jest.setTimeout(240000);
// Every translated string starts with this invisible mark, so the checks look only at text the tables put on screen.
const mockMARK = '\u200B';
const MARK = mockMARK;

// ── Measured-width heuristic (per em, by script) ───────────────────────────────────────────────────────────────────
function mockCharEm(ch) {
  const c = ch.codePointAt(0);
  if (c === 0x200b || c === 0x00ad || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c === 0xfe0f) return 0;
  if (/\s/.test(ch)) return 0.28;
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)) return 1.0;
  if (c >= 0x1f000 || (c >= 0x2600 && c <= 0x27bf)) return 1.2;
  if (c >= 0x0600 && c <= 0x06ff) return 0.5;
  if (".,:;'!|il()[]`/".includes(ch)) return 0.3;
  if (/[0-9]/.test(ch)) return 0.56;
  if (/[MWmwЖШЩЮжшщю]/.test(ch)) return 0.82;
  if (/[A-ZА-ЯЁ]/.test(ch)) return 0.66;
  return 0.54;
}
function mockTextWidth(text, style = {}) {
  const size = style.fontSize || 14;
  const mono = /mono|courier/i.test(style.fontFamily || '');
  let em = 0;
  for (const ch of String(text)) em += mono ? (mockCharEm(ch) ? 0.6 : 0) : mockCharEm(ch);
  const bold = style.fontWeight && (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600);
  return em * size * (bold ? 1.05 : 1) + (style.letterSpacing || 0) * [...String(text)].length;
}

// The screens run in English ('en'), and 'en' is whichever table the suite chose: the widest text of each key over
// every language, or one real language; every value marked.
const mockTables = { active: 'longest' };
jest.mock('../src/i18n/translations', () => {
  const real = jest.requireActual('../src/i18n/translations').default;
  const mark = (table) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, mockMARK + v]));
  mockTables.longest = {};
  for (const key of Object.keys(real.en)) {
    const values = Object.values(real).map((table) => table[key]);
    mockTables.longest[key] = mockMARK + values.reduce((a, b) => (mockTextWidth(b) > mockTextWidth(a) ? b : a));
  }
  for (const [lang, table] of Object.entries(real)) mockTables[lang] = mark(table);
  const tables = { ...real };
  Object.defineProperty(tables, 'en', { enumerable: true, get: () => mockTables[mockTables.active] });
  return { __esModule: true, default: tables };
});

// ── The wallet's services, standing still ──────────────────────────────────────────────────────────────────────────
const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const QNET = mockQNET;
const SOL = mockSOL;
const mockState = {};
const mockReset = () => Object.assign(mockState, {
  vault: 'none',
  locked: null,
  node: { nodeType: 'light', pseudonym: 'light_9f3a2c1d0e7b' },
  // LightNode.readNodeStatus: the network holds this wallet's node, this device answers for it, and it is Offline.
  lightStatus: {
    reachable: true, onChain: true, registrationPending: false, deviceBound: true, answered: false, needsReactivation: true,
    counted: { since: 6, counted: 5, last: 90 }, deviceTags: [], features: [], signed: null, keyOurs: null,
  },
  local: { nodeId: 'light_9f3a2c1d0e7b', seq: 1790000000, pushType: 'fcm' },
  pending: null,
  devAuth: false,
  device: { capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null }, // NodeDeviceKey.checkDevice
  // The chain's registrations of the wallet's nodes (PushService.getWalletNodeEvents) and aiqnet.io's record of it.
  events: { success: true, nodes: [{ nodeId: 'super_9f3a2c1d0e7b', nodeType: 'super', height: 0 }] },
  record: null,
  qncRead: 'ok', // the QNC read: 'ok', 'hang' (still running) or 'fail' (no figure)
  snapshot: null, // the last verified balances kept from an earlier session
});

jest.mock('../src/components/WalletManager', () => {
  class VaultCorruptError extends Error {}
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
  class FakeWalletManager {
    constructor() {
      return new Proxy(this, {
        get: (target, prop) => {
          if (prop in target || typeof prop === 'symbol' || prop === 'then') return target[prop];
          return async () => null;
        },
      });
    }
    async prepareInstall() {}
    async vaultState() { return mockState.vault; }
    async isBiometricEnabled() { return false; }
    async isBiometricSupported() { return true; }
    async getPasswordLockStatus() { return mockState.locked || { locked: false }; }
    async unlockWithPassword() { return { ok: true, token: 'session-token' }; }
    async checkPassword() { return { ok: true }; }
    async revealMnemonic() { return { ok: true, mnemonic: words.join(' ') }; }
    async revealPrivateKeys() {
      return {
        ok: true,
        qnet: { address: mockQNET, key: '5c5c79cac60d06d566b9c23047ad28b5da96dab4367593563ef34539067b57f6' },
        solana: { address: mockSOL, key: '4Z7cXSyeFR8wNGMVXUE1TwtKn5D5Vu7FzEv69dokLv7KrQk7h6pu4LF8ZRR9yQBhc7uSM6RTTZtU1fmaxiNrxXrs' },
      };
    }
    async loadBalanceSnapshot() { return mockState.snapshot || null; }
    async loadWallet() {
      return { address: mockSOL, solanaAddress: mockSOL, publicKey: mockSOL, qnetAddress: mockQNET };
    }
    async generateWallet() { return { mnemonic: words.join(' '), address: mockSOL, publicKey: mockSOL, qnetAddress: mockQNET }; }
    getBIP39WordList() { return [...words, 'zebra', 'zero', 'zone', 'zoo']; }
    generateVaultPassword() { return 'generated'; }
    getTrustedNodes() { return []; }
    trustedNodeUrl() { return 'https://node.invalid'; }
    async getBalance() { return 1.5; }
    async getTokenBalance() { return 123456.789; }
    // As the wallet answers it: the exact nano figure the Send form checks against (MB-R2-02).
    async getQNCBalanceWithProof() {
      if (mockState.qncRead === 'hang') return new Promise(() => {});
      if (mockState.qncRead === 'fail') return { ok: false, balance: null, verified: false };
      return { ok: true, balance: 1234567.123456, balanceNano: '1234567123456000', verified: true };
    }
    async getTokenHoldings() {
      return [{ contract: 'a'.repeat(64), name: 'A token with a rather long display name', symbol: 'LONGSYM', decimals: 6, balance: '1234567.891234' }];
    }
    async loadNodeRecord() { return mockState.node; }
    async deviceAuthAvailable() { return mockState.devAuth; }
    async switchToDeviceAuth() { return { ok: false, cancelled: true }; } // the system prompt refused
    generateQNetAddressFromSolana() { return mockQNET; }
    generateLightNodePseudonym() { return 'light_9f3a2c1d0e7b'; }
    generateSuperNodePseudonym() { return 'super_9f3a2c1d0e7b'; }
    qrc20TransferFeeNano() { return 150000; }
    toBaseUnits() { return '0'; }
    closeSession() {}
  }
  FakeWalletManager.MIN_PASSWORD_LENGTH = 8;
  FakeWalletManager.publicWallet = (w) => ({ ...w });
  FakeWalletManager.canonicalAddress = (a) => a;
  return { __esModule: true, default: FakeWalletManager, WalletManager: FakeWalletManager, VaultCorruptError };
});

jest.mock('../src/services/LightNode', () => ({
  ...jest.requireActual('../src/services/LightNode'),
  // Two owners' device-bound answer (contract 4) follows the first owner's unless the state names it.
  readNodeStatus: jest.fn(async () => {
    const s = mockState.lightStatus;
    return s && !('deviceBoundAgreed' in s) ? { ...s, deviceBoundAgreed: s.onChain === true ? s.deviceBound : null } : s;
  }),
  readLinkPending: jest.fn(async () => mockState.pending),
  dropLinkPending: jest.fn(async () => {}),
}));

jest.mock('../src/services/NodeRecordRead', () => ({
  ...jest.requireActual('../src/services/NodeRecordRead'),
  readNodeRecordState: jest.fn(async () => mockState.record),
}));

jest.mock('../src/services/NodeDeviceKey', () => ({
  checkDevice: jest.fn(async () => mockState.device),
  isThisDevice: jest.fn(async () => null),
  settleByTag: jest.fn(async () => null),
}));

jest.mock('../src/services/PushService', () => ({
  BG_REFRESH_STATUS_KEY: 'qnet_bg_refresh_status',
  LAST_ANSWER_KEY: 'qnet_last_self_attest_at',
  localBinding: jest.fn(async () => mockState.local),
  forgetIfReplaced: jest.fn(async () => false),
  signStatusWithPingKey: jest.fn(async () => null),
  stopLightNode: jest.fn(async () => ({ unbound: true })),
  bindThisDevice: jest.fn(async () => ({ ok: true })),
  selfAttestIfNeeded: jest.fn(async () => false),
  checkServerNodeStatus: jest.fn(async () => ({
    success: true, registered: true, isOnline: true, nodeId: 'light_9f3a2c1d0e7b', pendingRewards: 5_123_456_789, reputation: 50,
    currentBlockHeight: 123456, heartbeatCount: 3, requiredHeartbeats: 9, lastSeen: 1790000000, lastSeenAgoSeconds: 12 * 86400 + 23 * 3600,
  })),
  getAllNodesByWallet: jest.fn(async () => ({ success: true, nodes: [] })),
  getWalletNodeEvents: jest.fn(async () => mockState.events),
  getNodeEpochs: jest.fn(async () => ({ counted: 58, missed: 6 })),
  getPendingRewards: jest.fn(async () => ({ success: true, pendingRewards: 5_123_456_789 })),
  refreshFcmTokenOnServer: jest.fn(async () => ({})),
  isTokenRefreshNeeded: jest.fn(async () => false),
  readdressIfOwed: jest.fn(async () => false),
  teardownLightNode: jest.fn(async () => {}),
  teardownLightNodeIfForeign: jest.fn(async () => {}),
}));

const mockNOW = Date.UTC(2026, 8, 24, 12, 0, 0);
jest.mock('../src/services/HistoryCache', () => ({
  loadCachedHistory: jest.fn(async () => [
    { hash: 'p'.repeat(64), from: mockQNET, to: 'e'.repeat(45), amount: 1234567.12345, fee: 0.00015, status: 'pending', timestamp: mockNOW, type: 'send' },
    { hash: 'r'.repeat(64), from: 'f'.repeat(45), to: mockQNET, amount: 98765.4321, fee: 0, status: 'reported', timestamp: mockNOW, type: 'receive' },
    { hash: 's'.repeat(64), from: mockQNET, to: mockQNET, amount: 10, fee: 0.00015, status: 'confirmed', timestamp: mockNOW, type: 'self' },
    { hash: 'b'.repeat(64), from: mockQNET, to: '0000000000000000000eon00000000000000036877022', amount: 5, fee: 0.00015, status: 'confirmed', timestamp: mockNOW, type: 'send' },
    { hash: 't'.repeat(64), from: mockQNET, to: 'e'.repeat(45), amount: 0, fee: 0.00045, status: 'confirmed', timestamp: mockNOW, type: 'send',
      tokenContract: 'c'.repeat(64), tokenSymbol: 'LONGSYM', tokenAmountDisplay: '123456.789', verified: true, tokenMetaTrusted: true },
    { hash: 'node:light_9f3a2c1d0e7b', nodeEvent: true, nodeId: 'light_9f3a2c1d0e7b', nodeType: 'light', height: 1234567, status: 'confirmed', timestamp: 0, type: 'receive' },
  ]),
  saveCachedHistory: jest.fn(async () => {}),
}));

jest.mock('react-native-qrcode-svg', () => {
  const { View } = require('react-native');
  return function QRCode() { return require('react').createElement(View, { style: { width: 200, height: 200 } }); };
});

// The link screen's services: a link opens nothing on the wallet screen; the screen itself gets a connect offer.
jest.mock('../src/services/QNetLink', () => ({
  parseLink: jest.fn(() => null),
  takeInitialUrl: jest.fn(async () => null),
  openSession: jest.fn(async () => ({ expiresAt: Date.now() + 60_000 })),
  prepareOffer: jest.fn(async () => ({ kind: 'connect', addresses: { qnet: mockQNET, solana: mockSOL } })),
  performIntent: jest.fn(),
  deliverAnswer: jest.fn(async () => 'delivered'),
  markHandled: jest.fn(async () => {}),
  LinkRefusal: class LinkRefusal extends Error {},
}));

// ── The heuristic walk ─────────────────────────────────────────────────────────────────────────────────────────────
const flat = (s) => StyleSheet.flatten(s) || {};
const num = (v) => (typeof v === 'number' ? v : 0);
const side = (st, kind, a, b) => num(st[`${kind}${a}`] ?? st[`${kind}${b}`] ?? st[`${kind}Horizontal`] ?? st[kind]);
const inset = (st, kind) => side(st, kind, 'Left', 'Start') + side(st, kind, 'Right', 'End');
const border = (st) => num(st.borderLeftWidth ?? st.borderWidth) + num(st.borderRightWidth ?? st.borderWidth);
const sizeOf = (v, base) => (typeof v === 'number' ? v : (typeof v === 'string' && v.endsWith('%') ? base * parseFloat(v) / 100 : undefined));
const isHost = (n) => n && typeof n === 'object' && typeof n.type === 'string';
const kidsOf = (n) => (n.children || []).filter(isHost);
const isAbsolute = (n) => flat(n.props.style).position === 'absolute';
const isRow = (st) => st.flexDirection === 'row' || st.flexDirection === 'row-reverse';

function textOf(node) {
  return (node.children || []).map((c) => (typeof c === 'string' ? c : (isHost(c) && c.type === 'Text' ? textOf(c) : ''))).join('');
}
const plain = (s) => String(s).replace(/[\u200B\u2066-\u2069]/g, '');
const hasMark = (node) => (typeof node === 'string' ? node.includes(MARK)
  : isHost(node) && ((node.props && typeof node.props.placeholder === 'string' && node.props.placeholder.includes(MARK))
    || (node.children || []).some(hasMark)));

// For a text node: the width of its content, nested runs in their own style.
function runsWidth(node, inherited) {
  const st = { ...inherited, ...flat(node.props.style) };
  return (node.children || []).reduce((w, c) => w + (typeof c === 'string' ? mockTextWidth(c, st) : (isHost(c) ? runsWidth(c, st) : 0)), 0);
}

// Scroll views: the mock renders the content container without its style; put it back.
function contentStyle(node, child) {
  return node.type === 'RCTScrollView' && child === kidsOf(node)[kidsOf(node).length - 1]
    ? flat([child.props.style, node.props.contentContainerStyle]) : flat(child.props.style);
}

function natural(node, base) {
  const st = flat(node.props.style);
  const fixed = sizeOf(st.width, base);
  let w;
  if (fixed !== undefined) w = fixed;
  else if (node.type === 'Text') w = runsWidth(node, {}) + inset(st, 'padding');
  else if (node.type === 'TextInput') w = 120;
  else {
    const kids = kidsOf(node).filter((k) => !isAbsolute(k));
    const ws = kids.map((k) => natural(k, base) + inset(flat(k.props.style), 'margin'));
    const gap = num(st.columnGap ?? st.gap) * Math.max(0, ws.length - 1);
    w = inset(st, 'padding') + border(st) + (isRow(st) ? ws.reduce((a, b) => a + b, 0) + gap : Math.max(0, ...ws));
  }
  const max = sizeOf(st.maxWidth, base);
  const min = sizeOf(st.minWidth, base);
  if (max !== undefined) w = Math.min(w, max);
  if (min !== undefined) w = Math.max(w, min);
  return w;
}

function checkText(node, width, issues, where) {
  const content = textOf(node);
  if (!content.includes(MARK)) return;
  const st = flat(node.props.style);
  const avail = width - inset(st, 'padding');
  const need = runsWidth(node, {});
  const label = `${where}: "${plain(content).slice(0, 60)}"`;
  if (node.props.numberOfLines === 1) {
    const scale = node.props.adjustsFontSizeToFit ? (node.props.minimumFontScale ?? 0.5) : 1;
    if (need * scale > avail + TOL) issues.push(`${label} is cut off (${Math.round(need * scale)} > ${Math.round(avail)} dp)`);
    return;
  }
  // Wrapping text: every word (a CJK character, a part of a compound split by a soft hyphen) must fit on a line, at
  // the smallest size the text may shrink to.
  const scale = node.props.adjustsFontSizeToFit ? (node.props.minimumFontScale ?? 0.5) : 1;
  const words = plain(content).split(/[\s\u00AD]+/).flatMap((w) => (/[\u2E80-\u9FFF\uAC00-\uD7A3\u3000-\u30FF]/.test(w) ? [...w] : [w]));
  for (const w of words) {
    // An address, a hash, a code or an env name (a long run with digits or underscores): breaks anywhere by design.
    if (/^[0-9A-Za-z_\-:.#…=]{20,}$/.test(w) && /[0-9_]/.test(w)) continue;
    if (mockTextWidth(w, st) * scale > avail + TOL) issues.push(`${label}: the word "${w}" does not fit (${Math.round(mockTextWidth(w, st) * scale)} > ${Math.round(avail)} dp)`);
  }
  if (node.props.numberOfLines > 1) {
    const lines = plain(content).split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(mockTextWidth(p, st) * scale / avail)), 0);
    if (lines > node.props.numberOfLines) issues.push(`${label} needs ${lines} lines, has ${node.props.numberOfLines}`);
  }
}

function checkInput(node, width, issues, where) {
  const p = node.props.placeholder;
  if (typeof p !== 'string' || !p.includes(MARK) || node.props.multiline) return;
  const st = flat(node.props.style);
  const avail = width - inset(st, 'padding') - border(st);
  const need = mockTextWidth(p, st);
  if (need > avail + TOL) issues.push(`${where}: placeholder "${plain(p).slice(0, 60)}" is cut off (${Math.round(need)} > ${Math.round(avail)} dp)`);
}

function layout(node, width, issues, where, styleOverride) {
  const st = styleOverride || flat(node.props.style);
  if (st.display === 'none') return;
  if (node.type === 'Text') { checkText(node, width, issues, where); return; }
  if (node.type === 'TextInput') { checkInput(node, width, issues, where); return; }
  const inner = Math.max(0, width - inset(st, 'padding') - border(st));
  const kids = kidsOf(node);
  for (const k of kids.filter(isAbsolute)) {
    const ks = flat(k.props.style);
    const w = sizeOf(ks.width, inner) ?? (typeof ks.left === 'number' && typeof ks.right === 'number' ? width - ks.left - ks.right : inner);
    layout(k, Math.min(w, sizeOf(ks.maxWidth, inner) ?? w), issues, where);
  }
  const flow = kids.filter((k) => !isAbsolute(k));
  const styleOfKid = (k) => contentStyle(node, k);
  if (!isRow(st)) {
    for (const k of flow) {
      const ks = styleOfKid(k);
      const m = inset(ks, 'margin');
      const align = ks.alignSelf || st.alignItems || 'stretch';
      let w = sizeOf(ks.width, inner) ?? (align === 'stretch' ? inner - m : Math.min(natural(k, inner), inner - m));
      const max = sizeOf(ks.maxWidth, inner);
      if (max !== undefined) w = Math.min(w, max);
      layout(k, w, issues, where, ks);
    }
    return;
  }
  const gap = num(st.columnGap ?? st.gap);
  const items = flow.map((k) => {
    const s = styleOfKid(k);
    const flex = typeof s.flex === 'number' ? s.flex : 0;
    const explicit = sizeOf(s.width, inner);
    const basis = explicit ?? (flex > 0 && s.flexBasis === undefined ? 0 : (sizeOf(s.flexBasis, inner) ?? natural(k, inner)));
    return {
      k, s, m: inset(s, 'margin'), basis, grow: s.flexGrow ?? (flex > 0 ? flex : 0), shrink: s.flexShrink ?? (flex > 0 ? 1 : 0),
      min: sizeOf(s.minWidth, inner) ?? 0, max: sizeOf(s.maxWidth, inner),
    };
  });
  if (st.flexWrap === 'wrap') {
    for (const it of items) {
      let w = Math.min(Math.max(it.basis, it.min), inner - it.m);
      if (it.max !== undefined) w = Math.min(w, it.max);
      layout(it.k, w, issues, where, it.s);
    }
    return;
  }
  const gaps = gap * Math.max(0, items.length - 1);
  const widths = items.map((it) => Math.max(it.basis, it.min));
  const free = inner - widths.reduce((a, w, i) => a + w + items[i].m, 0) - gaps;
  if (free < 0) {
    const weight = items.reduce((a, it, i) => a + it.shrink * widths[i], 0);
    items.forEach((it, i) => { if (it.shrink > 0 && weight > 0) widths[i] = Math.max(it.min, widths[i] + free * (it.shrink * widths[i]) / weight); });
    const used = widths.reduce((a, w, i) => a + w + items[i].m, 0) + gaps;
    if (used > inner + TOL && hasMark(node)) {
      issues.push(`${where}: a row overflows by ${Math.round(used - inner)} dp: ${items.map((it) => JSON.stringify(plain(textOfTree(it.k)).slice(0, 30))).join(' | ')}`);
    }
  } else {
    const grow = items.reduce((a, it) => a + it.grow, 0);
    if (grow > 0) items.forEach((it, i) => { widths[i] += free * it.grow / grow; });
  }
  items.forEach((it, i) => layout(it.k, it.max !== undefined ? Math.min(widths[i], it.max) : widths[i], issues, where, it.s));
}
function textOfTree(n) {
  if (typeof n === 'string') return n;
  if (!isHost(n)) return '';
  return n.type === 'Text' ? textOf(n) : (n.children || []).map(textOfTree).join(' ');
}

function check(tree, where, width = SCREEN) {
  const issues = [];
  const roots = [].concat(tree.toJSON()).filter(isHost);
  for (const root of roots) layout(root, width, issues, where);
  if (!roots.some(hasMark)) issues.push(`${where}: nothing from the tables is on screen`);
  return issues.map((i) => `[${mockTables.active}] ${i}`);
}
// The phone, then iPad and Android tablet windows: Slide Over and the Split View shares up to a 13-inch iPad's full
// width. Content stays in one column of at most 640 dp.
const TABLET_WIDTHS = [375, 507, 592, 639, 678, 768, 810, 981, 1024, 1180, 1366];
const checkWidths = (tree, where) => [SCREEN, ...TABLET_WIDTHS].flatMap((w) => check(tree, `${where} @${w}`, w));

// ── Driving the screens ────────────────────────────────────────────────────────────────────────────────────────────
const { makeT } = require('../src/i18n');
const L = makeT('en'); // the longest table
const label = (key) => plain(L(key));
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const texts = (tree) => tree.root.findAllByType(Text).map((n) => plain([].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join(''))).join('\n');

function pressable(tree, text) {
  const textOf = (t) => plain([].concat(t.props.children).flat(Infinity).filter((c) => typeof c === 'string').join(''));
  const labelled = (match) => tree.root.findAll((n) => typeof n.props.onPress === 'function' && n.findAllByType(Text).some((t) => match(textOf(t))));
  // A control labelled exactly so wins over one whose longer text merely contains the label (in zh-CN the hidden
  // tokens hint starts with the word of the Send button).
  const exact = labelled((s) => s === text);
  const all = exact.length ? exact : labelled((s) => s.includes(text));
  if (!all.length) throw new Error(`nothing to press labelled "${text}"`);
  return all[all.length - 1];
}
const press = async (tree, text) => { await act(async () => { await pressable(tree, text).props.onPress(); }); await flush(); };
const pressKey = (tree, key) => press(tree, label(key));
const pressTab = async (tree, tab) => {
  await act(async () => { tree.root.find((n) => n.props.testID === `tab-${tab}` && typeof n.props.onPress === 'function').props.onPress(); });
  await flush();
};
const input = (tree, placeholderKey) => tree.root.findAll((n) => n.type === TextInput && plain(n.props.placeholder || '') === label(placeholderKey))[0];
const type = async (tree, placeholderKey, value) => { await act(async () => { input(tree, placeholderKey).props.onChangeText(value); }); await flush(1); };

const AsyncStorage = require('@react-native-async-storage/async-storage');
const WalletScreen = require('../src/screens/WalletScreen').default;
const walletStyles = require('../src/screens/WalletScreen.styles').default;
const Svg = require('react-native-svg').default;

// The Send form's scan: one button inside the recipient field's own container, beside the address input, named by the
// scan's title for screen readers and drawn as an icon, with no text. Returns the button.
function expectScanInField(tree, placeholder, title) {
  const scan = tree.root.findAll((n) => n.props.testID === 'send-scan' && typeof n.props.onPress === 'function', { deep: false });
  expect(scan).toHaveLength(1);
  expect(scan[0].props).toMatchObject({ accessibilityRole: 'button', accessibilityLabel: title });
  expect(scan[0].findAllByType(Text)).toHaveLength(0);
  expect(scan[0].findAllByType(Svg)).toHaveLength(1);
  const field = tree.root.findAll((n) => n.props.style === walletStyles.recipientField)[0];
  expect(field).toBeDefined();
  expect(field.findAll((n) => n === scan[0])).toHaveLength(1);
  expect(field.findAll((n) => n.type === TextInput && plain(n.props.placeholder || '') === placeholder)).toHaveLength(1);
  return scan[0];
}

async function mountWallet() {
  let tree;
  await act(async () => { tree = renderer.create(<WalletScreen />); });
  await flush(6);
  return tree;
}
const mounted = [];
const mount = async () => { const tree = await mountWallet(); mounted.push(tree); return tree; };

beforeAll(() => {
  global.fetch = jest.fn(async () => { throw new Error('offline in tests'); });
});
beforeEach(async () => {
  mockReset();
  await AsyncStorage.clear();
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
});

const SUITES = ['longest', 'en', 'zh-CN', 'ru', 'es', 'ko', 'ja', 'pt', 'fr', 'de', 'ar', 'it'];

describe.each(SUITES)('every screen fits 320 dp: %s', (table) => {
  beforeEach(() => { mockTables.active = table; });
  afterAll(() => { mockTables.active = 'longest'; });

  it('uses the chosen table, marked', () => {
    expect(L('tab_settings').startsWith(MARK)).toBe(true);
    expect(label('common_ok').length).toBeGreaterThan(0);
  });

  it('start, create, show and confirm the recovery phrase', async () => {
    const tree = await mount();
    const issues = [...check(tree, 'welcome')];
    await pressKey(tree, 'create_new_wallet');
    issues.push(...check(tree, 'create'));
    await type(tree, 'enter_password', 'abc');
    issues.push(...check(tree, 'create: short password'));
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await type(tree, 'confirm_password', 'Otter-Canyon-5X');
    issues.push(...check(tree, 'create: mismatch'));
    await pressKey(tree, 'create_wallet'); // terms not accepted
    issues.push(...check(tree, 'create: terms'));
    await type(tree, 'confirm_password', 'Otter-Canyon-58');
    await pressKey(tree, 'terms_of_service');
    expect(texts(tree)).toContain(label('terms_title'));
    issues.push(...check(tree, 'terms'));
    await pressKey(tree, 'accept');
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await type(tree, 'confirm_password', 'Otter-Canyon-58');
    await pressKey(tree, 'create_wallet');
    expect(texts(tree)).toContain(label('seed_save_title'));
    issues.push(...check(tree, 'show phrase'));
    await pressKey(tree, 'seed_wrote_it');
    issues.push(...check(tree, 'confirm phrase'));
    await pressKey(tree, 'seed_confirm_create');
    issues.push(...check(tree, 'confirm phrase: word missing'));
    expect(issues).toEqual([]);
  });

  it('import', async () => {
    const tree = await mount();
    await pressKey(tree, 'import_wallet');
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await type(tree, 'confirm_password', 'Otter-Canyon-58');
    const issues = [...check(tree, 'import step 1')];
    await pressKey(tree, 'common_next');
    await type(tree, 'import_placeholder', 'one two three four five');
    await act(async () => { tree.root.find((n) => n.props.style === walletStyles.checkbox && n.props.onPress).props.onPress(); });
    await pressKey(tree, 'import_title');
    issues.push(...check(tree, 'import step 2'));
    expect(texts(tree)).toContain(plain(L('import_word_count', { count: 5 })));
    expect(issues).toEqual([]);
  });

  it('the lock screen, also while locked out', async () => {
    mockState.vault = 'sealed';
    let tree = await mount();
    const issues = [...check(tree, 'lock')];
    await act(async () => { tree.unmount(); });
    mounted.pop();
    mockState.locked = { locked: true, remainingMs: 125000 };
    tree = await mount();
    expect(texts(tree)).toContain(plain(L('unlock_locked_for')).split('{time}')[0].trim().slice(0, 20));
    issues.push(...check(tree, 'lock: locked out'));
    await act(async () => { tree.unmount(); });
    mounted.pop();
    mockState.locked = null;
    mockState.vault = 'corrupt';
    tree = await mount();
    expect(texts(tree)).toContain(label('vault_corrupt'));
    issues.push(...check(tree, 'vault unreadable'));
    await pressKey(tree, 'erase_and_restore');
    issues.push(...check(tree, 'erase dialog'));
    expect(issues).toEqual([]);
  });

  async function unlocked() {
    mockState.vault = 'sealed';
    await AsyncStorage.setItem('qnet_bg_refresh_status', '1');
    const tree = await mount();
    await type(tree, 'enter_password', 'abcdefghijk');
    await pressKey(tree, 'unlock_wallet');
    await flush(6);
    return tree;
  }

  it('assets, send (with its refusal) and receive', async () => {
    await AsyncStorage.setItem('qnet_shown_tokens', JSON.stringify(['a'.repeat(64)]));
    const tree = await unlocked();
    const issues = [...check(tree, 'assets')];
    await pressKey(tree, 'assets_send');
    issues.push(...check(tree, 'send form'));
    // QNC and the token the Assets list shows, side by side; the token's form names its contract.
    expect(tree.root.findAll((n) => n.props.testID === 'qnet-token-QNC' && n.props.onPress).length).toBeGreaterThan(0);
    await act(async () => { tree.root.find((n) => n.props.testID === `qnet-token-${'a'.repeat(12)}` && n.props.onPress).props.onPress(); });
    await flush(1);
    expect(texts(tree)).toContain(plain(L('tok_contract_id', { id: 'aaaaaa…aaaa' })));
    issues.push(...check(tree, 'send form: token'));
    await act(async () => { tree.root.find((n) => n.props.testID === 'qnet-token-QNC' && n.props.onPress).props.onPress(); });
    await flush(1);
    expect(expectScanInField(tree, label('send_placeholder_eon'), L('scan_title')).props.hitSlop).toEqual({ top: 8, bottom: 8, right: 8 });
    await type(tree, 'send_placeholder_eon', 'not-an-address');
    await act(async () => { tree.root.findAll((n) => n.type === TextInput && n.props.keyboardType === 'decimal-pad')[0].props.onChangeText('1'); });
    await flush(1);
    issues.push(...check(tree, 'send form: total'));
    await pressKey(tree, 'send_button');
    expect(texts(tree)).toContain(label('send_invalid_address'));
    issues.push(...check(tree, 'send result'));
    await pressKey(tree, 'common_done');
    await pressKey(tree, 'common_back');
    await pressKey(tree, 'assets_receive');
    issues.push(...check(tree, 'receive'));
    expect(issues).toEqual([]);
  });

  it('the line about the figures on Assets: none while a read runs, not updated with the kept figures, not updated with none', async () => {
    if (table !== 'longest') return; // the longest table holds the widest text of each key of every language
    const issues = [];
    for (const [read, snapshot, key] of [
      ['hang', null, null],
      ['fail', { owner: QNET, qnc: 12.5, sol: 1, oneDev: 2, tokens: [], at: mockNOW }, 'balance_stale'],
      ['fail', null, 'balance_unavailable'],
    ]) {
      mockState.qncRead = read;
      mockState.snapshot = snapshot;
      const tree = await unlocked();
      const line = tree.root.findAll((n) => n.props.testID === 'balance-status' && n.type === Text);
      expect(line).toHaveLength(key ? 1 : 0);
      if (key) expect(plain([].concat(line[0].props.children).join(''))).toContain(label(key).split('{time}')[0].trim());
      issues.push(...check(tree, `assets: ${key}`));
      await act(async () => { tree.unmount(); });
      mounted.splice(mounted.indexOf(tree), 1);
    }
    expect(issues).toEqual([]);
  });

  it('the Solana send form (with its refusal)', async () => {
    const tree = await unlocked();
    await press(tree, 'Solana');
    const issues = [...check(tree, 'assets: solana')];
    await pressKey(tree, 'assets_send');
    issues.push(...check(tree, 'solana send form'));
    expect(expectScanInField(tree, label('send_placeholder_solana'), L('scan_title_solana')).props.hitSlop).toEqual({ top: 8, bottom: 8, right: 8 });
    await type(tree, 'send_placeholder_solana', 'not-an-address');
    await act(async () => { tree.root.findAll((n) => n.type === TextInput && n.props.keyboardType === 'decimal-pad')[0].props.onChangeText('1'); });
    await flush(1);
    issues.push(...check(tree, 'solana send form: total'));
    await pressKey(tree, 'send_button');
    expect(texts(tree)).toContain(label('err_SOL_ADDRESS'));
    issues.push(...check(tree, 'solana send result'));
    await pressKey(tree, 'common_done');
    expect(issues).toEqual([]);
  });

  const historyNetwork = async (tree, key) => {
    await act(async () => { tree.root.find((n) => n.props.testID === `history-network-${key}` && typeof n.props.onPress === 'function').props.onPress(); });
    await flush();
  };

  it('history rows of every kind', async () => {
    const tree = await unlocked();
    await pressTab(tree, 'history');
    await flush(4);
    expect(texts(tree)).toContain(label('hist_node_registered'));
    expect(texts(tree).split(label('hist_solana_scope')).length - 1).toBe(0);
    const issues = [...check(tree, 'history: QNet')];
    // Each row's detail screen, with Back.
    await act(async () => { tree.root.findAll((n) => n.props.testID === 'history-row' && typeof n.props.onPress === 'function')[0].props.onPress(); });
    await flush();
    expect(texts(tree)).toContain(label('tx_label'));
    issues.push(...check(tree, 'history: detail'));
    await act(async () => { tree.root.find((n) => n.props.testID === 'tx-detail-back' && typeof n.props.onPress === 'function').props.onPress(); });
    await flush();
    // The Solana side says once that it lists only this device's Solana sends.
    await historyNetwork(tree, 'solana');
    expect(texts(tree).split(label('hist_solana_scope')).length - 1).toBe(1);
    issues.push(...check(tree, 'history: Solana'));
    expect(issues).toEqual([]);
  });

  it('an empty history with SOL and 1DEV held says what the Solana rows cover, above "No transactions yet"', async () => {
    const cache = require('../src/services/HistoryCache');
    const rows = cache.loadCachedHistory.getMockImplementation();
    cache.loadCachedHistory.mockImplementation(async () => []);
    try {
      const tree = await unlocked();
      await pressTab(tree, 'history');
      await flush(4);
      await historyNetwork(tree, 'solana');
      const shown = texts(tree);
      expect(shown).toContain(label('hist_empty'));
      expect(shown.split(label('hist_solana_scope')).length - 1).toBe(1);
      expect(shown.indexOf(label('hist_solana_scope'))).toBeLessThan(shown.indexOf(label('hist_empty')));
      expect(check(tree, 'history: empty')).toEqual([]);
    } finally {
      cache.loadCachedHistory.mockImplementation(rows);
    }
  });

  it('the Node tab in every state, on a phone and on tablets', async () => {
    const issues = [];
    const nodeTab = async () => { const tree = await unlocked(); await pressTab(tree, 'node'); await flush(8); return tree; };
    const unmount = async (tree) => { await act(async () => { tree.unmount(); }); mounted.pop(); };
    // A new read of the status on the open tab: pull to refresh.
    const reread = async (tree, change) => {
      Object.assign(mockState, change);
      await act(async () => { await tree.root.findAllByType(RefreshControl).pop().props.onRefresh(); });
      await flush(6);
    };
    const shows = (tree, keys) => { for (const k of keys) expect(texts(tree)).toContain(label(k)); };
    const base = mockState.lightStatus;

    let tree = await nodeTab();
    shows(tree, ['node_answered', 'node_answered_no', 'node_counted']);
    issues.push(...checkWidths(tree, 'node: here, offline'));
    await reread(tree, { lightStatus: { ...base, needsReactivation: false, answered: true } });
    shows(tree, ['node_status_online', 'node_balance', 'node_move']);
    // No off switch on the tab: the node leaves this device on the unlink sheet (owner, 30.09).
    expect(texts(tree)).not.toContain(label('link_title_unlink'));
    issues.push(...checkWidths(tree, 'node: here, online'));
    // Background App Refresh turned off: the Background row says restricted, with its one button to the settings.
    const BackgroundFetch = require('react-native-background-fetch').default;
    BackgroundFetch.status.mockResolvedValue(1);
    try {
      await reread(tree, {});
      shows(tree, ['node_background', 'node_background_restricted', 'node_background_open']);
      issues.push(...checkWidths(tree, 'node: here, background restricted'));
    } finally {
      BackgroundFetch.status.mockResolvedValue(2);
    }
    // The latest miss, one line: what happened, how long the wake took to reach this device, and what to do.
    await reread(tree, { lightStatus: { ...base, lastMiss: {
      epoch: 95, reason: 'answered_late', wokenAt: 1790000000, answeredAt: 1790008100, deliveryDelaySecs: 8040, refused: null,
    } } });
    shows(tree, ['node_miss_do_background']);
    issues.push(...checkWidths(tree, 'node: here, latest miss'));
    await reread(tree, { local: null });
    shows(tree, ['node_other_device', 'node_use']);
    issues.push(...checkWidths(tree, 'node: another device'));
    await pressKey(tree, 'node_use');
    shows(tree, ['node_use_title']);
    issues.push(...checkWidths(tree, 'node: use this device alert'));
    await pressKey(tree, 'cancel');
    await reread(tree, { lightStatus: { ...base, deviceBound: false } });
    shows(tree, ['node_no_device', 'node_use']);
    issues.push(...checkWidths(tree, 'node: no device'));
    await reread(tree, { lightStatus: { ...base, onChain: false, deviceBound: null } });
    shows(tree, ['node_none']);
    expect(tree.root.findAll((n) => n.props.testID === 'node-use' || n.props.testID === 'node-move')).toEqual([]);
    issues.push(...checkWidths(tree, 'node: none'));
    await unmount(tree);

    mockState.lightStatus = { ...base, reachable: false, onChain: null, deviceBound: null, needsReactivation: false, counted: null };
    tree = await nodeTab();
    shows(tree, ['node_unreachable']);
    issues.push(...checkWidths(tree, 'node: unreachable'));
    await reread(tree, { lightStatus: { ...base, onChain: false }, local: null, pending: { nodeId: 'light_9f3a2c1d0e7b', T: 1790000000, expired: false } });
    shows(tree, ['node_linking']);
    issues.push(...checkWidths(tree, 'node: linking'));
    await unmount(tree);

    // A device that cannot run a node: the sentence, and nothing to run it with.
    Object.assign(mockState, { lightStatus: base, local: null, pending: null, device: { capable: false, reason: 'device_secondary_user' } });
    tree = await nodeTab();
    shows(tree, ['node_other_device', 'node_main_profile']);
    expect(tree.root.findAll((n) => n.props.testID === 'node-use')).toEqual([]);
    issues.push(...checkWidths(tree, 'node: this device cannot run it'));
    await unmount(tree);

    // A super node, with this wallet's light node under it (both on the chain): the server card's rows, then the light's.
    Object.assign(mockState, { device: { capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null } });
    mockState.node = { nodeType: 'super', pseudonym: 'super_9f3a2c1d0e7b' };
    tree = await nodeTab();
    shows(tree, ['node_balance', 'node_move', 'node_last_seen', 'node_heartbeats', 'node_counted', 'node_missed']);
    issues.push(...checkWidths(tree, 'node: server node'));
    await unmount(tree);

    // Before the network lists the node: what aiqnet.io records of it, for either type.
    Object.assign(mockState, {
      node: null, lightStatus: { ...base, onChain: false, deviceBound: null }, local: null,
      events: { success: true, nodes: [] }, record: { state: 'recorded', nodeType: 'super' },
    });
    tree = await nodeTab();
    shows(tree, ['node_not_on_network_super']);
    issues.push(...checkWidths(tree, 'node: super node not on the network yet'));
    await reread(tree, { record: { state: 'sending', nodeType: 'light' } });
    shows(tree, ['node_not_on_network_light']);
    issues.push(...checkWidths(tree, 'node: light node not on the network yet'));
    expect(issues).toEqual([]);
  });

  it('settings, its pickers, dialogs and alerts', async () => {
    const tree = await unlocked();
    await pressTab(tree, 'settings');
    await flush(4);
    const issues = [...check(tree, 'settings')];
    const cancel = () => pressKey(tree, 'cancel');
    await pressKey(tree, 'autolock_1'); issues.push(...check(tree, 'auto-lock picker')); await cancel();
    await press(tree, 'English'); issues.push(...check(tree, 'language picker')); await cancel();
    await pressKey(tree, 'change_password'); issues.push(...check(tree, 'change password')); await cancel();
    await pressKey(tree, 'export_recovery_phrase'); issues.push(...check(tree, 'export phrase'));
    // The one warning comes before the password (owner, 07.10, as the extension says it).
    expect(texts(tree)).toContain(label('recovery_phrase_warning'));
    await type(tree, 'password', 'abcdefghijk');
    await pressKey(tree, 'show');
    // After the password: the words, Copy and Done, and no second warning.
    const revealed = texts(tree).split('\n');
    for (const w of 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ')) expect(revealed).toContain(w);
    expect(texts(tree)).not.toContain(label('recovery_phrase_warning'));
    issues.push(...check(tree, 'phrase revealed'));
    await pressKey(tree, 'common_done');
    await pressKey(tree, 'export_private_key'); issues.push(...check(tree, 'export keys'));
    // Which account first (the extension's order), the one warning, then the password.
    expect(texts(tree)).toContain(label('private_key_warning'));
    expect(texts(tree)).toContain(label('private_key_account'));
    expect(texts(tree)).toContain(label('private_key_qnet_format'));
    await pressKey(tree, 'private_key_solana');
    expect(texts(tree)).toContain(label('private_key_solana_format'));
    issues.push(...check(tree, 'export keys: the Solana account'));
    await type(tree, 'password', 'abcdefghijk');
    await pressKey(tree, 'show');
    // Shown at once (owner, 06.10): no hold to show; only the chosen account's key, and no second warning.
    expect(tree.root.findAll((n) => n.props.testID === 'key-shown-solana').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n) => n.props.testID === 'key-shown-qnet')).toHaveLength(0);
    expect(texts(tree)).not.toContain(label('private_key_warning'));
    expect(tree.root.findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('key-hold-'))).toHaveLength(0);
    issues.push(...check(tree, 'keys revealed'));
    await pressKey(tree, 'common_done');
    await pressKey(tree, 'enable_biometric'); issues.push(...check(tree, 'biometric password')); await cancel();
    await pressKey(tree, 'delete_wallet'); issues.push(...check(tree, 'delete alert'));
    await pressKey(tree, 'common_delete'); issues.push(...check(tree, 'delete password')); await cancel();
    // Lock Wallet locks at once, with no dialog: the lock screen is next.
    await pressKey(tree, 'lock_wallet');
    await flush(2);
    expect(texts(tree)).toContain(label('unlock_wallet'));
    issues.push(...check(tree, 'locked by Lock Wallet'));
    expect(issues).toEqual([]);
  });

  it('a password wallet on a device with a screen lock: the move at unlock and the settings row', async () => {
    mockState.devAuth = true;
    const tree = await unlocked();
    expect(texts(tree)).toContain(label('device_unlock_offer_body'));
    const issues = [...check(tree, 'device unlock move')];
    await pressKey(tree, 'device_unlock_offer_yes'); // the system prompt is refused: the password stays
    await flush(2);
    await pressTab(tree, 'settings');
    await flush(4);
    await pressKey(tree, 'set_device_unlock'); issues.push(...check(tree, 'device unlock password'));
    await pressKey(tree, 'cancel');
    expect(issues).toEqual([]);
  });

  it('the header menu, the token manager and the browser start page', async () => {
    const tree = await unlocked();
    await act(async () => { tree.root.find((n) => n.props.accessibilityLabel === L('menu_open') && n.props.onPress).props.onPress(); });
    await flush(1);
    const issues = [...check(tree, 'header menu')];
    await pressKey(tree, 'tok_manage');
    issues.push(...check(tree, 'token manager'));
    await act(async () => { tree.root.find((n) => n.props.accessibilityLabel === L('common_close') && n.props.onPress).props.onPress(); });
    await pressTab(tree, 'browser');
    await flush(4);
    expect(texts(tree)).toContain(label('browser_bookmark_explorer'));
    issues.push(...check(tree, 'browser'));
    await act(async () => { tree.root.find((n) => n.props.accessibilityLabel === L('browser_menu') && n.props.onPress).props.onPress(); });
    await flush(1);
    issues.push(...check(tree, 'browser menu'));
    // The tabs button next to the address bar opens the tab overview over the pane.
    await act(async () => { tree.root.findAll((n) => n.props.testID === 'browser-tabs' && n.props.onPress)[0].props.onPress(); });
    await flush(1);
    expect(texts(tree)).toContain(label('browser_close_all_tabs'));
    issues.push(...check(tree, 'browser tabs'));
    expect(issues).toEqual([]);
  });
});

describe('the sheets, the link screen, the result card and the crash screen fit 320 dp', () => {
  const DappSheet = require('../src/browser/DappSheet').default;
  const TxResultCard = require('../src/components/TxResultCard').default;
  const ErrorBoundary = require('../src/components/ErrorBoundary').default;

  const render = async (el) => { let tree; await act(async () => { tree = renderer.create(el); }); await flush(2); mounted.push(tree); return tree; };
  const actions = { approve: jest.fn(), reject: jest.fn(), dismiss: jest.fn(), loadPreview: jest.fn() };
  const base = { id: 'a1', origin: 'https://xn--80ak6aa92e.com', busy: false, queued: 3, details: {}, preview: null, outcome: null };

  it('the browser sheets: connect, sign, send, a token transfer, a contract call, outcome', async () => {
    const issues = [];
    for (const view of [
      { ...base, kind: 'connect' },
      { ...base, kind: 'sign', details: { message: 'Log in to dapp.example', byteLength: 22 } },
      { ...base, kind: 'send', details: { to: 'e'.repeat(45), amountNano: '1234567890000000', feeNano: '150000', totalNano: '1234567890150000' },
        preview: { nonce: 7, balanceNano: '1000', verified: false, counterparties: [`eeee${'f'.repeat(37)}eeee`] } },
      { ...base, kind: 'send', details: { to: 'e'.repeat(45), amountNano: '1', feeNano: '1', totalNano: '2' }, previewError: true },
      { ...base, kind: 'send', details: { to: 'e'.repeat(45), amountNano: '1', feeNano: '1', totalNano: '2' }, outcome: { status: 'unknown', txHash: 'f'.repeat(64) } },
      { ...base, kind: 'send',
        details: {
          type: 'tokenTransfer', token: 'c'.repeat(45), to: 'e'.repeat(45), amount: '1234567.123456', amountBase: '1234567123456', symbol: 'GOLDCOIN',
          name: 'Game Gold Coin', decimals: 6, gasLimit: '100750', feeNano: '1511250', destroys: true, reservedName: true,
        },
        preview: { nonce: 7, balanceNano: '1000', verified: true, counterparties: [], tokenBalanceBase: '1', tokenVerified: false, depositNano: '10000000', listed: false } },
      { ...base, kind: 'send', details: { type: 'tokenTransfer', token: 'c'.repeat(45), to: 'e'.repeat(45), amount: '1', amountBase: '1', symbol: 'G', name: '', decimals: 0, gasLimit: '1', feeNano: '1', destroys: false, reservedName: false }, previewError: 'TOKEN_DECIMALS' },
      { ...base, kind: 'send',
        details: {
          type: 'contractCall', contract: 'd'.repeat(45), method: 'claim_reward_for_level', args: 'ab'.repeat(300), argsBytes: 300,
          argsText: 'level 12 cleared', gasLimit: '301500', feeNano: '4522500', totalNano: '4522500',
        },
        preview: { nonce: 7, balanceNano: '1000', verified: false, counterparties: [] } },
    ]) {
      const tree = await render(<DappSheet view={view} actions={actions} t={L} authenticate={async () => false} accounts={{ qnet: QNET, solana: SOL }} />);
      issues.push(...check(tree, `sheet ${view.kind}${view.details.type ? ` ${view.details.type}` : ''}${view.outcome ? ' outcome' : ''}`));
    }
    expect(issues).toEqual([]);
  });

  it('the result card in each of its three outcomes', async () => {
    const issues = [];
    for (const props of [
      { state: 'success', title: L('tx_sent_title'), amount: '1234567.123456', symbol: 'QNC', counterparty: QNET, counterpartyLabel: L('tx_to_self'), note: L('tx_note_still_pending'), hash: 'f'.repeat(64) },
      { state: 'pending', title: L('tx_not_confirmed_title'), amount: '10', symbol: 'QNC', note: L('tx_note_refused', { reason: 'nonce too low' }) },
      { state: 'failed', title: L('claim_failed_title'), error: L('err_NODE_ID_UNKNOWN') },
    ]) {
      const tree = await render(<TxResultCard {...props} t={L} onAction={() => {}} />);
      issues.push(...check(tree, `result ${props.state}`));
    }
    expect(issues).toEqual([]);
  });

  it('the review of a Solana token send, with the new token account and a memo', async () => {
    const SendReview = require('../src/components/SendReview').default;
    const review = {
      to: SOL, network: L('solana_devnet'), amount: '123456.123456 1DEV', fee: '0.000005 SOL', account: '0.00203928 SOL',
      memo: 'order 42 from the shop', total: '123456.123456 1DEV + 0.00204428 SOL', warnings: { firstTime: true },
    };
    const tree = await render(<SendReview review={review} t={L} onCancel={() => {}} onConfirm={() => {}} />);
    expect(texts(tree)).toContain(label('send_review_account'));
    expect(texts(tree)).toContain(label('send_review_memo'));
    expect(check(tree, 'review: solana')).toEqual([]);
  });

  it('the QNet Link screen: to confirm, a reservation, not available, refused', async () => {
    const QNetLinkScreen = require('../src/screens/QNetLinkScreen').default;
    const QNetLink = require('../src/services/QNetLink');
    const screen = (link) => render(<QNetLinkScreen link={link} wallet={{ qnetAddress: QNET }} t={L} authenticate={async () => false} onClose={() => {}} />);
    const connect = { id: 'x'.repeat(32), intent: 'connect' };
    const issues = [];
    let tree = await screen(connect);
    await flush(4);
    issues.push(...check(tree, 'link: connect'));
    QNetLink.prepareOffer.mockResolvedValueOnce({ kind: 'reserve', qnet: QNET, nodeId: 'light_mobile_6526ab8fd00ff8ca', burner: mockSOL });
    tree = await screen({ id: 'w'.repeat(32), intent: 'reserve', reqHash: 'r'.repeat(43) });
    await flush(4);
    expect(texts(tree)).toContain(label('link_reserve_body'));
    issues.push(...check(tree, 'link: reserve'));
    // The unlink from a device that does not run the node (the wallet key, contract 1.9b).
    QNetLink.prepareOffer.mockResolvedValueOnce({
      kind: 'unlink', mode: 'wallet', qnet: QNET, nodeId: 'light_mobile_6526ab8fd00ff8ca', platform: 'android', since: 1790035200,
    });
    tree = await screen({ id: 'u'.repeat(32), intent: 'unlink', reqHash: 'r'.repeat(43) });
    await flush(4);
    expect(texts(tree)).toContain(label('link_title_unlink_wallet'));
    expect(texts(tree)).toContain(label('link_unlink_wallet_body'));
    issues.push(...check(tree, 'link: unlink by the wallet key'));
    QNetLink.prepareOffer.mockRejectedValueOnce(new Error('unreadable'));
    tree = await screen({ ...connect, id: 'y'.repeat(32) });
    await flush(4);
    issues.push(...check(tree, 'link: unavailable'));
    QNetLink.openSession.mockRejectedValueOnce(Object.assign(new QNetLink.LinkRefusal('x'), { reason: 'not_found' }));
    tree = await screen({ ...connect, id: 'z'.repeat(32) });
    await flush(4);
    issues.push(...check(tree, 'link: refused'));
    expect(issues).toEqual([]);
  });

  it('the crash screen', async () => {
    const Boom = () => { throw new Error('boom'); };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const tree = await render(<ErrorBoundary><Boom /></ErrorBoundary>);
    spy.mockRestore();
    expect(check(tree, 'crash')).toEqual([]);
  });

  it('the bottom bar labels fit a fifth of the screen in every language', () => {
    const translations = jest.requireActual('../src/i18n/translations').default;
    const BottomBarStyles = { fontSize: 11, fontWeight: '600' };
    const share = SCREEN / 5 - 4; // the label's padding
    for (const [lang, table] of Object.entries(translations)) {
      for (const tab of ['assets', 'history', 'browser', 'node', 'settings']) {
        const w = mockTextWidth(table[`tab_${tab}`], BottomBarStyles) * 0.75; // minimumFontScale
        expect([lang, tab, w <= share]).toEqual([lang, tab, true]);
      }
    }
  });
});

describe('Arabic is laid out right to left', () => {
  it('the whole screen turns, addresses and amounts stay left to right', async () => {
    mockState.vault = 'sealed';
    await AsyncStorage.setItem('qnet_language', 'ar');
    const tree = await mount();
    const rootStyle = flat(tree.toJSON().props ? tree.toJSON().props.style : [].concat(tree.toJSON())[0].props.style);
    expect(rootStyle.direction).toBe('rtl');
    const pw = tree.root.findAll((n) => n.type === TextInput)[0];
    await act(async () => { pw.props.onChangeText('abcdefghijk'); });
    const unlock = pressable(tree, jest.requireActual('../src/i18n/translations').default.ar.unlock_wallet);
    await act(async () => { await unlock.props.onPress(); });
    await flush(6);
    const main = [].concat(tree.toJSON()).find(isHost);
    expect(flat(main.props.style).direction).toBe('rtl');
    const address = tree.root.findAll((n) => n.type === Text && flat(n.props.style).fontFamily && [].concat(n.props.children).join('').includes(QNET));
    expect(address.length).toBeGreaterThan(0);
    expect(address.every((n) => flat(n.props.style).writingDirection === 'ltr')).toBe(true);
    // The bottom bar speaks Arabic.
    const ar = jest.requireActual('../src/i18n/translations').default.ar;
    expect(texts(tree)).toContain(ar.tab_settings);
    // On Send the scan icon sits at the field's end, the left here; its target reaches out past that edge only.
    await act(async () => { await pressable(tree, ar.assets_send).props.onPress(); });
    await flush();
    const scan = expectScanInField(tree, plain(ar.send_placeholder_eon), makeT('ar')('scan_title'));
    expect(scan.props.hitSlop).toEqual({ top: 8, bottom: 8, left: 8 });
  });

  it('every other language is laid out left to right', async () => {
    mockState.vault = 'sealed';
    await AsyncStorage.setItem('qnet_language', 'de');
    const tree = await mount();
    expect(flat([].concat(tree.toJSON()).find(isHost).props.style).direction).toBe('ltr');
  });
});
