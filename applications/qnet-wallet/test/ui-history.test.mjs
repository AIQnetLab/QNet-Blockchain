// History of either network (owner, 06.10: the history of a good wallet) on the browserless DOM: each row is the asset's
// icon with the badge of what it did, what it did over who it was with (and the state of a row not confirmed), and the
// amount with its sign; rows are newest first under the header of their day; one transaction is one row (a node
// registration reads "Node registered", never a transfer of 0 QNC); each row has an accessible name; the detail opens
// with the same icon and badge. The badges are vector glyphs drawn through masks in popup.css.
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../dist/lib/qnet-core.js';
import { SOLANA } from '../dist/background/config.js';
import { openPage } from './helpers/ui-page.mjs';

const ADDRESSES = Object.freeze({ qnet: core.KAT.qnetAddress, solana: core.KAT.solanaAddress });
const PEER = core.qnetAddressFromPublicKey(new Uint8Array(1952).fill(7));
const TOKEN = core.deriveContractAddress(PEER, 1);
const SOLANA_PEER = core.solanaAddressFromPublicKey(new Uint8Array(32).fill(9));
const NODE_ID = core.lightNodeId(ADDRESSES.qnet);
const short = (address) => `${address.slice(0, 6)}…${address.slice(-6)}`;
const at = (year, month, day, hour) => new Date(year, month - 1, day, hour).getTime();
// local times: "now" is 6 October 2026, 15:00
const NOW = at(2026, 10, 6, 15);

function handlers(overrides = {}) {
  return {
    'settings.get': () => ({ autoLockMinutes: 15, language: 'en' }),
    'vault.status': () => ({
      exists: true, unlocked: true, lockDeadline: NOW + 900000, addresses: ADDRESSES, signingEnabled: true, backoffUntil: null,
    }),
    'qnet.balance': () => ({ balanceNano: '12500000000', nonce: '3', verified: true, verification: 'proof', blockHeight: 1234 }),
    'solana.balances': () => ({
      address: ADDRESSES.solana, lamports: '2000000000',
      oneDev: { mint: SOLANA.ONE_DEV_MINT, ata: SOLANA_PEER, exists: true, raw: '5000000000', decimals: 6 },
    }),
    'activation.status': () => ({ activation: null, pending: null, busy: false }),
    'activation.lookup': () => ({
      activation: null, pending: null, busy: false, superseded: null, registration: null, record: null, keptBurn: null,
      network: 'none', search: 'none', reason: null, view: 'none',
    }),
    'activation.registration': () => ({ registration: null }),
    'activation.price': () => ({ phase: 1, light: { cost: 1500 }, super: { cost: 3000 }, fetchedAt: NOW }),
    'sites.list': () => ({ sites: [] }),
    'qnet.history': () => ({ items: [], cursor: null, pending: [] }),
    'qnet.tokens': () => ({ tokens: [], complete: true }),
    'wallet.cached': () => ({ qnetBalance: null, qnetHistory: null, solanaBalances: null, solanaHistory: null }),
    'solana.history': () => ({ items: [], cursor: null }),
    'wallet.touch': () => ({ touched: true }),
    'wallet.remember': () => ({ remembered: true }),
    ...overrides,
  };
}

let page = null;
afterEach(() => {
  if (page) {
    assert.deepEqual(page.violations, [], 'every request matches the router table');
    page.close();
    page = null;
  }
  mock.timers.reset();
});

async function openHistory(overrides, network = 'qnet') {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  page = await openPage('popup', { handlers: handlers(overrides) });
  if (network === 'solana') await page.click('.network-switch [data-value="solana"]');
  await page.click('[data-tab="history"]');
  await page.settle();
  return page;
}

// Each row as what it shows: title, badge, amount, who with, state, and the class that colours its amount.
function rows() {
  return page.$$('.history-row').map((row) => ({
    title: row.querySelector('.row-title').textContent,
    badge: row.querySelector('.history-action').className.replace('history-action history-action-', ''),
    amount: row.querySelector('.amount')?.textContent ?? null,
    party: row.querySelector('.history-party')?.textContent ?? null,
    status: row.querySelector('.history-status')?.textContent ?? null,
  }));
}
const days = () => page.$$('.history-days .history-day').map((day) => [day.querySelector('.history-date').textContent,
  day.querySelectorAll('.history-row').length]);

const qnetItem = (extra) => ({
  hash: `${'0'.repeat(62)}${extra.n}`, direction: 'in', from: PEER, to: ADDRESSES.qnet, amountNano: '2000000000', feeNano: '0',
  timestamp: NOW, status: 'included', nonce: null, kind: 'transfer', block: 2068700, ...extra,
});

describe('popup: History rows (owner, 06.10)', () => {
  it('QNet: one row per transaction with its icon and badge, who it was with, its amount and state, newest first under its day', async () => {
    await openHistory({
      'qnet.history': () => ({
        items: [
          qnetItem({ n: 1, direction: 'in', from: 'system_rewards_pool', amountNano: '5000000000', kind: 'reward', timestamp: at(2026, 10, 6, 11) }),
          qnetItem({ n: 2, direction: 'out', from: ADDRESSES.qnet, to: '', amountNano: '0', kind: 'node_registration', nodeId: NODE_ID,
            timestamp: at(2026, 10, 6, 10) }),
          qnetItem({ n: 3, timestamp: at(2026, 10, 5, 10), status: 'unverified' }),
          qnetItem({ n: 4, kind: 'token', amountNano: '0', token: { contract: TOKEN, symbol: 'GOLD', decimals: 6 }, amountBase: '1500000',
            timestamp: at(2026, 9, 28, 9) }),
          qnetItem({ n: 5, direction: 'self', from: ADDRESSES.qnet, amountNano: '1000000000', timestamp: at(2025, 12, 31, 23) }),
          qnetItem({ n: 6, direction: 'out', from: ADDRESSES.qnet, to: '', amountNano: '0', kind: 'deploy', timestamp: 0 }),
        ],
        cursor: null,
        // this wallet's send not decided yet: the newest row, so it leads Today
        pending: [qnetItem({ n: 7, hash: '', direction: 'out', from: ADDRESSES.qnet, to: PEER, amountNano: '1500000000', feeNano: '31500',
          status: 'pending', nonce: '4', block: undefined, timestamp: at(2026, 10, 6, 12) })],
      }),
    });
    assert.deepEqual(days(), [['Today', 3], ['Yesterday', 1], ['September 28', 1], ['December 31, 2025', 1], ['Earlier', 1]]);
    assert.deepEqual(rows(), [
      { title: 'Sent', badge: 'sent', amount: '−1.5 QNC', party: `To: ${short(PEER)}`, status: 'Pending' },
      { title: 'Moved from node', badge: 'node', amount: '+5 QNC', party: 'From: node balance', status: null },
      { title: 'Node registered', badge: 'node', amount: null, party: `Node ${NODE_ID}`, status: null },
      { title: 'Received', badge: 'received', amount: '+2 QNC', party: `From: ${short(PEER)}`, status: 'Unverified' },
      { title: 'Received', badge: 'received', amount: '+1.5 GOLD', party: `From: ${short(PEER)}`, status: null },
      { title: 'Sent to self', badge: 'self', amount: '1 QNC', party: null, status: null },
      { title: 'Contract deployed', badge: 'call', amount: null, party: null, status: null },
    ]);
    // the amount's colour: incoming, outgoing, to yourself
    assert.deepEqual(page.$$('.history li').map((li) => li.className),
      ['history-out', 'history-in', 'history-out', 'history-in', 'history-in', 'history-self', 'history-out']);
    // the asset's own icon: QNC on QNet rows, the token's letter on a token row
    const icons = page.$$('.history-row .history-icon');
    assert.equal(icons[0].getAttribute('src'), '../icons/qnc-token.png');
    assert.equal(icons[4].textContent, 'G');
    assert.ok(page.$$('.history-row .history-action').every((badge) => badge.getAttribute('aria-hidden') === 'true'));
    // never a transfer of 0 QNC for a registration or a deploy
    assert.ok(!page.$$('.history-row .amount').some((node) => /^[−+]?0 QNC$/.test(node.textContent)));
    // the accessible name: what happened, the amount, who with, the state and when
    assert.equal(page.$('.history-row').getAttribute('aria-label'),
      `Sent, −1.5 QNC, To: ${short(PEER)}, Pending, ${new Date(at(2026, 10, 6, 12)).toLocaleString('en')}`);
    assert.equal(page.$$('.history-row')[2].getAttribute('aria-label'),
      `Node registered, Node ${NODE_ID}, ${new Date(at(2026, 10, 6, 10)).toLocaleString('en')}`);
    assert.equal(page.$$('.history-row')[6].getAttribute('aria-label'), 'Contract deployed');
  });

  // The archive lists a token transfer this wallet sent twice under one hash: its contract call's row and the token's own
  // row. History shows one row, the token row, with the fee the call paid; a call that wrote no token event keeps its row.
  it('QNet: a token transfer this wallet sent is one row, the token row with its call\'s fee, across a page boundary too', async () => {
    const HASH = 'ab'.repeat(32);
    const call = qnetItem({ n: 1, hash: HASH, direction: 'out', from: ADDRESSES.qnet, to: TOKEN, amountNano: '0', feeNano: '4509375',
      kind: 'call', timestamp: NOW - 1000 });
    const token = qnetItem({ n: 1, hash: HASH, direction: 'out', from: ADDRESSES.qnet, to: PEER, amountNano: '0', kind: 'token',
      token: { contract: TOKEN, symbol: 'GOLD', decimals: 6 }, amountBase: '2500000', timestamp: NOW - 1000 });
    const lone = qnetItem({ n: 2, direction: 'out', from: ADDRESSES.qnet, to: TOKEN, amountNano: '0', feeNano: '4509375', kind: 'call',
      timestamp: NOW - 2000 });
    const expected = [
      { title: 'Sent', badge: 'sent', amount: '−2.5 GOLD', party: `To: ${short(PEER)}`, status: null },
      { title: 'Contract call', badge: 'call', amount: null, party: `Contract ${short(TOKEN)}`, status: null },
    ];
    await openHistory({ 'qnet.history': () => ({ items: [call, token, lone], cursor: null, pending: [] }) });
    assert.deepEqual(rows(), expected);
    page.$$('[data-action="open-detail"]')[0].click();
    await page.settle();
    const detail = Object.fromEntries(page.$$('.history-detail dt').map((node, i) => [node.textContent, page.$$('.history-detail dd')[i].textContent]));
    assert.equal(detail['Network fee'], '0.004509375 QNC', 'the fee the transfer cost');
    assert.equal(detail.Token, 'GOLD');
    page.close();
    mock.timers.reset();

    // the call's row on one page, the token row on the next (More)
    await openHistory({
      'qnet.history': ({ cursor }) => (cursor === 'older' ? { items: [token, lone], cursor: null, pending: [] }
        : { items: [call], cursor: 'older', pending: [] }),
    });
    assert.deepEqual(rows(), [{ title: 'Contract call', badge: 'call', amount: null, party: `Contract ${short(TOKEN)}`, status: null }]);
    await page.click('[data-action="more"]');
    assert.deepEqual(rows(), expected);
  });

  it('QNet: a node registration this wallet did not submit names no node, and its detail has no recipient', async () => {
    await openHistory({
      'qnet.history': () => ({
        items: [qnetItem({ n: 1, direction: 'out', from: ADDRESSES.qnet, to: '', amountNano: '0', kind: 'node_registration', block: 5 })],
        cursor: null,
        pending: [],
      }),
    });
    assert.deepEqual(rows(), [{ title: 'Node registered', badge: 'node', amount: null, party: null, status: null }]);
    assert.equal(page.$('.history-sub'), null, 'no empty second line');
    await page.click('[data-action="open-detail"]');
    assert.deepEqual(page.$$('.history-detail dt').map((node) => node.textContent), ['Type', 'Status', 'From', 'Block', 'Time', 'Transaction']);
  });

  it('QNet: a send to the address that destroys what it receives reads Burned; a contract call or deploy names its contract', async () => {
    await openHistory({
      'qnet.history': () => ({
        items: [
          qnetItem({ n: 1, direction: 'out', from: ADDRESSES.qnet, to: core.CANONICAL_BURN_ADDRESS, amountNano: '5000000000', timestamp: NOW - 1000 }),
          qnetItem({ n: 2, direction: 'out', from: ADDRESSES.qnet, to: TOKEN, amountNano: '0', kind: 'call', timestamp: NOW - 2000 }),
          qnetItem({ n: 3, direction: 'out', from: ADDRESSES.qnet, to: TOKEN, amountNano: '0', kind: 'deploy', timestamp: NOW - 3000 }),
        ],
        cursor: null,
        pending: [],
      }),
    });
    assert.deepEqual(rows(), [
      { title: 'Burned', badge: 'burn', amount: '−5 QNC', party: `To: ${short(core.CANONICAL_BURN_ADDRESS)}`, status: null },
      { title: 'Contract call', badge: 'call', amount: null, party: `Contract ${short(TOKEN)}`, status: null },
      { title: 'Contract deployed', badge: 'call', amount: null, party: `Contract ${short(TOKEN)}`, status: null },
    ]);
  });

  it('a detail opens with the row\'s icon and badge, what happened and the amount', async () => {
    await openHistory({
      'qnet.history': () => ({
        items: [
          qnetItem({ n: 1, direction: 'out', from: ADDRESSES.qnet, to: '', amountNano: '0', kind: 'node_registration', nodeId: NODE_ID, block: 5 }),
          qnetItem({ n: 2, direction: 'out', from: ADDRESSES.qnet, to: PEER, timestamp: NOW - 60000, status: 'replaced' }),
        ],
        cursor: null,
        pending: [],
      }),
    });
    page.$$('[data-action="open-detail"]')[0].click();
    await page.settle();
    const head = page.$('.history-detail .detail-head');
    assert.equal(head.querySelector('.history-avatar-large .history-icon').getAttribute('src'), '../icons/qnc-token.png');
    assert.equal(head.querySelector('.history-action').className, 'history-action history-action-node');
    assert.equal(head.querySelector('h2').textContent, 'Node registered');
    assert.equal(head.querySelector('.detail-amount'), null, 'a registration moves no amount');
    const labels = page.$$('.history-detail dt').map((node) => node.textContent);
    assert.deepEqual(labels, ['Type', 'Status', 'Node', 'From', 'Block', 'Time', 'Transaction']);
    assert.equal(page.$$('.history-detail dd')[2].textContent, NODE_ID);
    await page.click('.history-detail [data-action="back"]');
    page.$$('[data-action="open-detail"]')[1].click();
    await page.settle();
    // a transfer another transaction replaced: the failed mark, its amount muted, Failed with its line
    assert.equal(page.$('.history-detail .history-action').className, 'history-action history-action-failed');
    assert.equal(page.$('.history-detail .detail-amount').className, 'detail-amount history-out history-failed');
    assert.equal(page.$('.history-detail .detail-amount').textContent, '−2 QNC');
    assert.equal(page.$('.history-detail .badge').textContent, 'Failed');
  });

  it('Solana: received, a burn and a failed send, each with its badge, who it was with and its state', async () => {
    const sig = (n) => core.base58Encode(new Uint8Array(64).fill(n));
    const solRow = (n, extra) => ({
      signature: sig(n), asset: 'sol', direction: 'in', counterparty: SOLANA_PEER, amountRaw: '2000000000', feeLamports: null,
      timestamp: NOW - 3600000 * n, status: 'confirmed', burn: false, ...extra,
    });
    await openHistory({
      'solana.history': () => ({
        items: [
          solRow(1),
          solRow(2, { asset: '1dev', direction: 'out', amountRaw: '1500000000', burn: true, counterparty: null, feeLamports: '5000' }),
          solRow(30, { direction: 'out', status: 'failed', feeLamports: '5000' }),
          solRow(4, { direction: 'self', counterparty: null, timestamp: null }),
        ],
        cursor: null,
      }),
    }, 'solana');
    assert.deepEqual(days(), [['Today', 2], ['Yesterday', 1], ['Earlier', 1]]);
    assert.deepEqual(rows(), [
      { title: 'Received', badge: 'received', amount: '+2 SOL', party: `From: ${short(SOLANA_PEER)}`, status: null },
      { title: 'Burned', badge: 'burn', amount: '−1,500 1DEV', party: null, status: null },
      { title: 'Sent', badge: 'failed', amount: '−2 SOL', party: `To: ${short(SOLANA_PEER)}`, status: 'Failed' },
      { title: 'Sent to self', badge: 'self', amount: '2 SOL', party: null, status: null },
    ]);
    assert.deepEqual(page.$$('.history-row .history-icon').map((node) => node.getAttribute('src')),
      ['../icons/sol-token.png', '../icons/1dev-token.png', '../icons/sol-token.png', '../icons/sol-token.png']);
    assert.equal(page.$$('.history li')[1].className, 'history-out');
    assert.equal(page.$$('.history-days .history li')[2].className, 'history-out history-failed');
    page.$$('[data-action="open-detail"]')[1].click();
    await page.settle();
    assert.equal(page.$('.history-detail .history-action').className, 'history-action history-action-burn');
    assert.equal(page.$('.history-detail .history-icon').getAttribute('src'), '../icons/1dev-token.png');
  });

  it('a row writes its amount as the app does: grouped, compact past 100,000, powers of ten past 10^18; a long symbol shortened', async () => {
    const LONG = 'LONGSYMBOLNAME';
    const tokenRow = (n, amountBase, symbol = 'GOLD', decimals = 6) => qnetItem({
      n, kind: 'token', amountNano: '0', token: { contract: TOKEN, symbol, decimals }, amountBase, timestamp: NOW - n * 1000,
    });
    await openHistory({
      'qnet.history': () => ({
        items: [
          qnetItem({ n: 1, amountNano: '98765432100000', timestamp: NOW - 1000 }),
          qnetItem({ n: 2, direction: 'out', from: ADDRESSES.qnet, to: PEER, amountNano: '123456700000000', timestamp: NOW - 2000 }),
          qnetItem({ n: 3, amountNano: '1', timestamp: NOW - 3000 }),
          tokenRow(4, '340282366920938463463374607431768211455'),
          tokenRow(5, '4200000000000000000000', 'GOLD'),
          tokenRow(6, '1500000', LONG),
          qnetItem({ n: 7, amountNano: '0', timestamp: NOW - 7000 }),
        ],
        cursor: null,
        pending: [],
      }),
    });
    assert.deepEqual(page.$$('.history-row .amount').map((node) => [...node.children].map((part) => part.textContent)), [
      ['+98,765.43', 'QNC'], ['−123.46K', 'QNC'], ['+<0.00000001', 'QNC'], ['+3.4e32', 'GOLD'], ['+4200T', 'GOLD'],
      ['+1.5', 'LONGSYMBO…'], ['0', 'QNC'],
    ]);
    // the accessible name gives the whole symbol; the detail the exact figure and the whole symbol
    assert.match(page.$$('.history-row')[5].getAttribute('aria-label'), new RegExp(`^Received, \\+1\\.5 ${LONG}, `));
    page.$$('[data-action="open-detail"]')[3].click();
    await page.settle();
    assert.equal(page.$('.history-detail .detail-amount').textContent, '+340,282,366,920,938,463,463,374,607,431,768.211455 GOLD');
  });

  it('a row writes its figures in one format for every language: comma groups and a decimal point (owner, 19.10)', async () => {
    const items = [
      qnetItem({ n: 1, amountNano: '98765432100000', timestamp: NOW - 1000 }),
      qnetItem({ n: 2, direction: 'out', from: ADDRESSES.qnet, to: PEER, amountNano: '123456700000000', timestamp: NOW - 2000 }),
      qnetItem({ n: 3, amountNano: '1234500000000', timestamp: NOW - 3000 }),
      qnetItem({ n: 4, amountNano: '1', timestamp: NOW - 4000 }),
    ];
    const expected = [['+98,765.43', 'QNC'], ['−123.46K', 'QNC'], ['+1,234.5', 'QNC'], ['+<0.00000001', 'QNC']];
    for (const language of ['de', 'es', 'ru', 'fr', 'ar']) {
      mock.timers.enable({ apis: ['Date'], now: NOW });
      page = await openPage('popup', {
        handlers: handlers({
          'settings.get': () => ({ autoLockMinutes: 15, language }), 'qnet.history': () => ({ items, cursor: null, pending: [] }),
        }),
      });
      // the language's table is a module the page imports: the wallet comes once it is loaded
      for (let turn = 0; turn < 400 && page.$('[data-tab="history"]') === null; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      await page.click('[data-tab="history"]');
      await page.settle();
      assert.deepEqual(page.$$('.history-row .amount').map((node) => [...node.children].map((part) => part.textContent)), expected, language);
      page.$$('[data-action="open-detail"]')[0].click();
      await page.settle();
      assert.equal(page.$('.history-detail .detail-amount').textContent, '+98,765.4321 QNC', language);
      assert.deepEqual(page.violations, [], language);
      page.close();
      page = null;
      mock.timers.reset();
    }
  });

  it('a day header follows the day: a list read again after midnight says Yesterday for what was Today', async () => {
    let reads = 0;
    await openHistory({
      'qnet.history': () => {
        reads += 1;
        return { items: [qnetItem({ n: 1, timestamp: at(2026, 10, 6, 9) })], cursor: null, pending: [] };
      },
    });
    assert.deepEqual(days(), [['Today', 1]]);
    const row = page.$('.history-row');
    const before = reads;
    // a balance event reads the list again: the same rows, after midnight
    mock.timers.setTime(at(2026, 10, 7, 0) + 60000);
    page.emit('balance');
    await page.settle();
    assert.ok(reads > before, 'read again');
    assert.deepEqual(days(), [['Yesterday', 1]]);
    assert.notEqual(page.$('.history-row'), row, 'drawn again although its rows did not change');
    // a read of the same rows on the same day draws nothing again
    const drawn = page.$('.history-row');
    page.emit('balance');
    await page.settle();
    assert.equal(page.$('.history-row'), drawn);
  });
});

describe('popup.css: the History badges', () => {
  it('every badge the popup draws has a glyph: a 24-unit vector of paths and circles, with no script, link or style', async () => {
    const css = await readFile(new URL('../dist/ui/popup.css', import.meta.url), 'utf8');
    const popup = await readFile(new URL('../dist/ui/popup.js', import.meta.url), 'utf8');
    const glyphs = new Map([...css.matchAll(/\.history-action-([a-z]+) \{ --glyph: url\("data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"\); \}/g)]
      .map(([, name, data]) => [name, Buffer.from(data, 'base64').toString('utf8')]));
    const drawn = new Set([...popup.matchAll(/\bbadge: '([a-z]+)'/g)].map(([, name]) => name).concat('failed'));
    assert.deepEqual([...drawn].sort(), ['burn', 'call', 'failed', 'node', 'received', 'self', 'sent', 'swap']);
    assert.deepEqual([...glyphs.keys()].sort(), [...drawn].sort(), 'one glyph per badge, none unused');
    const namespace = ['http', '//www.w3.org/2000/svg'].join(':');
    for (const [name, svg] of glyphs) {
      assert.ok(svg.startsWith(`<svg xmlns='${namespace}' viewBox='0 0 24 24' `), name);
      assert.deepEqual([...new Set([...svg.matchAll(/<\/?([a-zA-Z]+)/g)].map(([, tag]) => tag))].sort(),
        name === 'node' ? ['circle', 'path', 'svg'] : ['path', 'svg'], name);
      assert.doesNotMatch(svg, /script|href|style|\bon[a-z]+=|url\(|<!|&/i, name);
    }
    // drawn in the badge's colour through both mask properties (Chrome 111 reads the prefixed one)
    assert.match(css, /-webkit-mask: var\(--glyph\) center \/ contain no-repeat;/);
    assert.match(css, /\n {2}mask: var\(--glyph\) center \/ contain no-repeat;/);
  });
});
