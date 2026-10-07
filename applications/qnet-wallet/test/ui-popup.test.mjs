// The popup on a browserless DOM with a scripted worker (test/helpers/ui-page.mjs). Every request is
// also checked against the router's message table, so these tests fail when the page drifts from
// CONTRACTS.md. Secrets: typed passwords are sent once and cleared at once; the phrase and a private key are shown at
// once after the password and leave the page with their screen (owner, 06.10); the activation code is in Settings and
// comes into the page only on Show or Copy; a secret reaches the clipboard only by its Copy button, and leaves it after a
// minute (the code after TIMINGS.CLIPBOARD_CLEAR_MS).
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/lib/qnet-core.js';
import { LIMITS, RECORD_ORIGIN, SOLANA, TIMINGS, UI_PAGES } from '../dist/background/config.js';
import { FakeEvent, fire, type } from './helpers/ui-dom.mjs';
import { fail, openPage } from './helpers/ui-page.mjs';

const ADDRESSES = Object.freeze({ qnet: core.KAT.qnetAddress, solana: core.KAT.solanaAddress });
const RECIPIENT = core.qnetAddressFromPublicKey(new Uint8Array(1952).fill(7));
const SOLANA_RECIPIENT = core.solanaAddressFromPublicKey(new Uint8Array(32).fill(9));
const PASSWORD = 'correct horse battery';
const CODE = core.KAT.activation.code;
const MASKED = 'QNET-L•••••-••••••-••••36';
const BURN_TX = core.KAT.activation.burnTx;
const HARDENED = {
  spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', 'data-gramm': 'false',
};

const unlockedStatus = () => ({
  exists: true, unlocked: true, lockDeadline: Date.now() + 900000, addresses: ADDRESSES, signingEnabled: true, backoffUntil: null,
});
const lockedStatus = (extra = {}) => ({
  exists: true, unlocked: false, lockDeadline: null, addresses: null, signingEnabled: true, backoffUntil: null, ...extra,
});
const activationRecord = (nodeType = 'light') => ({
  nodeType, burnTx: BURN_TX, burnAmount: 1500, solanaAddress: ADDRESSES.solana, cluster: 'devnet', createdAt: 1_700_000_000_000,
  codeMasked: MASKED,
});

// activation.lookup as the worker answers it for a wallet whose only source is the vault (activation.status's fields), every
// other source saying "none" (decision 35).
const lookupOf = (status, extra = {}) => {
  const view = status.activation ? 'activation' : status.pending ? 'pending' : status.busy ? 'busy' : 'none';
  return {
    activation: null, pending: null, busy: false, superseded: null, registration: null, ...status, record: null, keptBurn: null,
    network: 'none', search: 'none', reason: null, view, ...extra,
  };
};

function handlers(overrides = {}) {
  const table = {
    'settings.get': () => ({ autoLockMinutes: 15, language: 'en' }),
    'vault.status': () => unlockedStatus(),
    'qnet.balance': () => ({ balanceNano: '12500000000', nonce: '3', verified: true, verification: 'proof', blockHeight: 1234 }),
    'solana.balances': () => ({
      address: ADDRESSES.solana,
      lamports: '2000000000',
      oneDev: { mint: SOLANA.ONE_DEV_MINT, ata: SOLANA_RECIPIENT, exists: true, raw: '5000000000', decimals: 6 },
    }),
    'activation.status': () => ({ activation: null, pending: null, busy: false }),
    'activation.registration': () => ({ registration: null }),
    'activation.price': () => ({ phase: 1, light: { cost: 1500 }, super: { cost: 3000 }, fetchedAt: 1_700_000_000_000 }),
    'sites.list': () => ({ sites: [] }),
    'qnet.history': () => ({ items: [], cursor: null, pending: [] }),
    // the wallet's built-in QNet tokens: none unless a test lists some (owner, 06.10)
    'qnet.tokens': () => ({ tokens: [], complete: true }),
    // the session's view cache, empty until a test fills it, and the Solana History (decision 39)
    'wallet.cached': () => ({ qnetBalance: null, qnetHistory: null, solanaBalances: null, solanaHistory: null }),
    'solana.history': () => ({ items: [], cursor: null }),
    // no handler for node.unlinkView or node.unlink: the popup no longer asks about the light node's device (owner,
    // 06.10), so a request for either is a violation in every test
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'activation.lookup')) {
    table['activation.lookup'] = async (params) => lookupOf(await table['activation.status'](params));
  }
  return table;
}

function assertHardened(input) {
  for (const [name, value] of Object.entries(HARDENED)) assert.equal(input.getAttribute(name), value, `${input.getAttribute('name')} ${name}`);
}

function assertAllInputsHardened(page) {
  for (const input of page.$$('input, textarea')) {
    if (input.getAttribute('type') !== 'checkbox') assertHardened(input);
  }
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

async function openWallet(overrides = {}, options = {}) {
  // a test that opens a second page has its first page's requests checked too, not only the last page's
  if (page) assert.deepEqual(page.violations, [], 'every request of the previous page matches the router table');
  page = await openPage('popup', { handlers: handlers(overrides), ...options });
  return page;
}

// The Activate tab once the wallet has its code (owner, 06.10; decisions 41 and 43): the light node's record only while the
// chain does not list it, one line to aiqnet.io/node, and a warning only when another burn is involved; nothing else. The
// code itself is in Settings.
const recordCard = () => page.$$('.tab-body .card').find((card) => card.children[0]?.textContent === 'QNet network') ?? null;

// The tab's parts, top to bottom, by what each is.
function activateParts() {
  const [stack] = page.$('.tab-body').children;
  return stack.children.map((node) => {
    if (node.classList.contains('heading')) return node.querySelector('.lead') ? 'heading+lead' : 'heading';
    if (node.classList.contains('code-card')) return 'code';
    if (node === recordCard()) return node.classList.contains('hidden') ? 'record:hidden' : 'record';
    if (node.querySelector('a')) return 'manage';
    if (node.querySelector('[data-action="superseded-burn"]')) return 'superseded';
    if (node.querySelector('[data-action="kept-burn"]')) return 'kept-burn';
    if (node.querySelector('[data-action="recover"]')) return 'recover';
    if (node.classList.contains('notice')) return node.className.replace(/^notice /, '');
    return `other:${node.className || node.localName}`;
  });
}

// The tab's text as the user sees it: page.text() less every subtree the `hidden` class takes off the screen.
function shownText(node = page.$('.tab-body')) {
  if (node.nodeType === 3) return node.textContent;
  if (node.classList.contains('hidden')) return '';
  return node.childNodes.map((child) => shownText(child)).join('');
}

// Every text on the screen, top to bottom, and every control (data-action) on it, less what the `hidden` class takes off:
// the views of a wallet with a code are pinned whole with these, so no line or button (the code among them) can come back
// unnoticed.
function shownLines(node = page.$('.tab-body')) {
  if (node.nodeType === 3) return node.textContent.trim() ? [node.textContent.trim()] : [];
  if (node.classList.contains('hidden')) return [];
  return node.childNodes.flatMap((child) => shownLines(child));
}
function shownActions(node = page.$('.tab-body')) {
  if (node.nodeType !== 1 || node.classList.contains('hidden')) return [];
  const own = node.getAttribute('data-action');
  return [...(own ? [own] : []), ...node.childNodes.flatMap((child) => shownActions(child))];
}
const MANAGE = 'Manage the node at aiqnet.io/node';
// the light node's record card with its line, while the chain does not list the node
const recordLines = (...line) => ['QNet network', 'Light node', core.lightNodeId(core.KAT.qnetAddress), ...line];

// The one line where the node is managed: the tab's only link, to aiqnet.io/node in a new tab.
function assertManageLine() {
  const links = page.$$('.tab-body a');
  assert.equal(links.length, 1, 'one link on the tab');
  const [link] = links;
  assert.equal(link.textContent, MANAGE);
  assert.equal(link.parentNode.textContent, MANAGE, 'the line is the link alone');
  assert.equal(link.getAttribute('href'), `${RECORD_ORIGIN}/node`);
  assert.equal(link.getAttribute('href'), 'https://aiqnet.io/node');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.ok(link.classList.contains('inline-link'));
}

// What the tab no longer draws once the wallet has its code (aiqnet.io/node shows the node, its device and its balance;
// the code is in Settings): the code panel, the burn's details and their buttons, the success banner, the paid-on-site
// line, the Light next step, the Super server card and the Device card with Unlink.
const REMOVED_TEXT = new RegExp(['Node type', 'Burned', 'Burn transaction', 'Created', 'Copy transaction', 'Network',
  'Solana devnet', 'This wallet has its activation code', 'one-time payment address', 'Link a device', 'QNET_',
  'Server environment', 'Every server step', 'server steps', 'holds this wallet’s keys', 'Device', 'Runs on',
  'Linked since', 'Unlink', 'Activation code', 'Your activation code', 'Hold to show', 'Show or copy the code', 'Before you copy',
  MASKED].join('|'));
const REMOVED_ACTIONS = ['burn-explorer', 'copy-burn-tx', 'server-steps', 'unlink', 'unlink-confirm', 'hold-code', 'copy-code',
  'unlock-code', 'show-code', 'confirm-copy-code'];

const within = (node, ancestor) => {
  for (let at = node; at; at = at.parentNode) if (at === ancestor) return true;
  return false;
};

function assertOnlyTheLine() {
  const text = page.text();
  assert.doesNotMatch(text, REMOVED_TEXT);
  assert.ok(!text.includes(BURN_TX), 'no burn transaction');
  assert.ok(!text.includes(CODE), 'no code');
  assert.equal(page.$('.tab-body .code-box'), null, 'no code panel');
  for (const action of REMOVED_ACTIONS) assert.equal(page.$(`[data-action="${action}"]`), null, action);
  // the record card's own line may be a success (recorded); no banner says the wallet has its code
  const card = recordCard();
  assert.equal(page.$$('.tab-body .notice-success').filter((node) => !card || !within(node, card)).length, 0, 'no success banner');
}

describe('popup: lock screen', () => {
  it('sends the typed password once, clears the field at once, then shows the six tabs and no Node tab', async () => {
    let unlocked = false;
    await openWallet({
      'vault.status': () => (unlocked ? unlockedStatus() : lockedStatus()),
      'vault.unlock': ({ password }) => {
        assert.equal(password, PASSWORD);
        unlocked = true;
        return { ...ADDRESSES, lockDeadline: Date.now() + 900000 };
      },
    });
    const input = page.$('input[name="password"]');
    assert.equal(input.getAttribute('type'), 'password');
    assertHardened(input);
    type(input, PASSWORD);
    page.$('[data-action="unlock"]').click();
    assert.equal(input.value, '', 'cleared as soon as the request is sent');
    await page.settle();
    assert.equal(page.callsOf('vault.unlock').length, 1);
    assert.deepEqual(page.$$('[data-tab]').map((node) => node.getAttribute('data-tab')),
      ['assets', 'send', 'receive', 'history', 'activate', 'settings']);
    assert.equal(page.$('[data-tab="node"]'), null);
    assert.deepEqual(page.$$('.network-switch [data-value]').map((node) => node.getAttribute('data-value')), ['qnet', 'solana']);
    assert.equal(page.$('.network-switch [data-value="qnet"]').getAttribute('aria-pressed'), 'true');
    assert.match(page.text(), /12\.5 QNC/);
    // a normal wallet's home: the balance, no verification badge or block height (owner, 28.09)
    assert.doesNotMatch(page.text(), /Verified|Not verified|state proof|two nodes|Block 1234/);
  });

  it('shows the wrong-password error and a backoff countdown that blocks the button', async () => {
    let attempts = 0;
    await openWallet({
      'vault.status': () => lockedStatus(),
      'vault.unlock': () => {
        attempts += 1;
        return attempts === 1 ? fail('BAD_PASSWORD') : fail('BACKOFF', { retryAfterMs: 4000 });
      },
    });
    type(page.$('input[name="password"]'), 'nope');
    await page.click('[data-action="unlock"]');
    assert.match(page.text(), /Wrong password/);
    type(page.$('input[name="password"]'), 'nope again');
    await page.click('[data-action="unlock"]');
    assert.equal(page.$('[data-action="unlock"]').disabled, true);
    assert.match(page.text(), /Try again in 4 s/);
  });

  it('honours a backoff the worker reports before any attempt', async () => {
    await openWallet({ 'vault.status': () => lockedStatus({ backoffUntil: Date.now() + 9000 }) });
    assert.equal(page.$('[data-action="unlock"]').disabled, true);
    assert.match(page.text(), /Try again in (9|10) s/);
  });

  it('without a vault offers setup, which opens ui/setup.html in a tab and closes the popup', async () => {
    await openWallet({
      'vault.status': () => ({ exists: false, unlocked: false, lockDeadline: null, addresses: null, signingEnabled: true, backoffUntil: null }),
    });
    await page.click('[data-action="open-setup"]');
    assert.deepEqual(page.tabsCreated, [{ url: page.chrome.runtime.getURL(UI_PAGES.setup) }]);
    assert.equal(page.window.closed, true);
  });
});

describe('popup: forgot password (Reset wallet)', () => {
  const TOKEN = 'ab'.repeat(32);
  const NEW_PASSWORD = 'quantum otter lantern meadow';
  const OTHER = Object.freeze({ qnet: RECIPIENT, solana: SOLANA_RECIPIENT });

  // The worker's protocol: without `confirm` a check that names both wallets; with it the replace.
  let replaced = false;
  const worker = (checked, restored = ADDRESSES) => (params) => {
    if (params.confirm !== 'ERASE') return { status: 'confirm', ...checked };
    page.emit('wiped'); // the worker erases the old vault before it answers
    replaced = true;
    return { status: 'restored', ...restored, lockDeadline: Date.now() + 900000 };
  };
  const SAME = Object.freeze({ erased: ADDRESSES, restored: ADDRESSES, otherWallet: false });

  async function openRestore(overrides = {}) {
    replaced = false;
    await openWallet({
      'vault.status': () => (replaced ? unlockedStatus() : lockedStatus()),
      'vault.restoreBegin': () => ({ token: TOKEN, expiresAt: Date.now() + TIMINGS.RESTORE_TOKEN_TTL_MS }),
      'vault.restore': worker(SAME),
      ...overrides,
    });
    await page.click('[data-action="forgot-password"]');
  }

  async function typeAndContinue(phrase = core.KAT.mnemonic) {
    type(page.$('textarea[name="phrase"]'), phrase);
    type(page.$('input[name="new-password"]'), NEW_PASSWORD);
    type(page.$('input[name="confirm-password"]'), NEW_PASSWORD);
    await page.click('[data-action="restore"]');
  }

  it('the lock screen says only "Forgot password?"', async () => {
    await openWallet({ 'vault.status': () => lockedStatus() });
    assert.equal(page.$('[data-action="forgot-password"]').textContent, 'Forgot password?');
  });

  it('Reset wallet: a lead, one warning, the phrase and a new password checked here, no typed word', async () => {
    await openRestore();
    const text = page.text();
    assert.match(text, /Reset wallet/);
    assert.match(text, /cannot recover your password/);
    assert.match(text, /replaced only after the phrase is checked/);
    assert.equal(page.$$('.notice').length, 1, 'one warning');
    assert.match(page.$('.notice').textContent, /removes the wallet from this browser/);
    assert.doesNotMatch(text, /ERASE|Type .* to confirm/);
    assert.equal(page.$('input[name="confirm"]'), null);
    assert.deepEqual(page.$$('input, textarea').map((node) => node.getAttribute('name')), ['phrase', 'new-password', 'confirm-password']);
    assertAllInputsHardened(page);

    const phrase = page.$('textarea[name="phrase"]');
    type(phrase, core.KAT.mnemonic.replace(/about$/, 'abandon'));
    type(page.$('input[name="new-password"]'), NEW_PASSWORD);
    type(page.$('input[name="confirm-password"]'), NEW_PASSWORD);
    await page.click('[data-action="restore"]');
    assert.match(page.text(), /not a valid recovery phrase/);
    type(phrase, `  ${core.KAT.mnemonic.toUpperCase().replaceAll(' ', '\n')} `);
    type(page.$('input[name="confirm-password"]'), 'something else entirely');
    assert.match(page.text(), /✓ At least 8 characters/);
    assert.match(page.text(), /Passwords do not match/);
    await page.click('[data-action="restore"]');
    assert.match(page.text(), /Passwords do not match/);
    assert.equal(page.callsOf('vault.restoreBegin').length + page.callsOf('vault.restore').length, 0,
      'invalid input never reaches the worker');
  });

  it('checks first (nothing erased, this wallet named), then one checkbox arms Reset wallet, which sends the confirmation with the same token', async () => {
    await openRestore();
    const phrase = page.$('textarea[name="phrase"]');
    type(phrase, `  ${core.KAT.mnemonic.toUpperCase().replaceAll(' ', '\n')} `);
    type(page.$('input[name="new-password"]'), NEW_PASSWORD);
    type(page.$('input[name="confirm-password"]'), NEW_PASSWORD);
    page.$('[data-action="restore"]').click();
    assert.equal(phrase.value, '', 'the phrase leaves the field as the requests are sent');
    assert.equal(page.$('input[name="new-password"]').value, '');
    await page.settle();
    assert.deepEqual(page.callsOf('vault.restoreBegin').map((c) => c.params), [{}], 'no typed word: nothing to send');
    assert.deepEqual(page.callsOf('vault.restore').map((c) => c.params), [
      { token: TOKEN, mnemonic: core.KAT.mnemonic, password: NEW_PASSWORD },
    ], 'the check carries no confirmation');

    const text = page.text();
    assert.match(text, /Confirm the reset/);
    assert.match(text, /This recovery phrase is this wallet’s/);
    assert.match(text, /Wallet in this browser/);
    assert.ok(text.includes(ADDRESSES.qnet) && text.includes(ADDRESSES.solana), 'the wallet that is replaced is named');
    assert.doesNotMatch(text, /different wallet|Takes its place/);
    assert.deepEqual(page.$$('input, textarea').map((node) => node.getAttribute('name')), ['understand'], 'one checkbox, no typing');
    const go = page.$('[data-action="restore-confirm"]');
    assert.equal(go.textContent, 'Reset wallet');
    assert.equal(go.disabled, true);
    const understand = page.$('input[name="understand"]');
    assert.match(page.text(), /I understand the wallet in this browser will be replaced/);
    understand.click();
    assert.equal(go.disabled, false);
    understand.click();
    assert.equal(go.disabled, true, 'unticked: disarmed again');
    understand.click();
    await page.click('[data-action="restore-confirm"]');
    assert.deepEqual(page.callsOf('vault.restore').map((c) => c.params).slice(1), [
      { token: TOKEN, mnemonic: core.KAT.mnemonic, password: NEW_PASSWORD, confirm: 'ERASE' },
    ]);
    assert.equal(page.location.reloads, 0, "its own 'wiped' event does not reload the page mid-restore");
    assert.match(page.text(), /Wallet restored/);
    assert.ok(page.text().includes(ADDRESSES.qnet) && page.text().includes(ADDRESSES.solana));
    assert.match(page.text(), /use Recover my code/);
    await page.click('[data-action="continue"]');
    assert.ok(page.$('[data-tab="assets"]'));
  });

  it('a refused step says why and starts again from the lock screen', async () => {
    await openRestore({ 'vault.restore': () => fail('RESTORE_EXPIRED') });
    await typeAndContinue();
    assert.match(page.text(), /Nothing was erased/);
    await page.click('[data-action="restore-again"]');
    assert.ok(page.$('[data-action="unlock"]'));
    assert.ok(page.$('[data-action="forgot-password"]'));
  });

  it('a phrase of another wallet: a danger notice, both wallets named, one checkbox, replaceOther with the same token (EXT-VAULT-R2-04)', async () => {
    await openRestore({ 'vault.restore': worker({ erased: ADDRESSES, restored: OTHER, otherWallet: true }, OTHER) });
    await typeAndContinue();
    const text = page.text();
    assert.match(page.$('.notice-danger').textContent, /This recovery phrase is of a different wallet/);
    assert.match(text, /Removed from this browser/);
    assert.match(text, /Takes its place/);
    for (const address of [ADDRESSES.qnet, ADDRESSES.solana, OTHER.qnet, OTHER.solana]) {
      assert.ok(text.includes(address), address);
    }
    assert.ok(text.indexOf(ADDRESSES.qnet) < text.indexOf('Takes its place') && text.indexOf(OTHER.qnet) > text.indexOf('Takes its place'));
    assert.deepEqual(page.$$('input, textarea').map((node) => node.getAttribute('name')), ['understand']);
    assert.equal(page.$('[data-action="restore-confirm"]').disabled, true);
    // a click that reaches the button while the box is not ticked sends nothing
    fire(page.$('[data-action="restore-confirm"]'), 'click');
    await page.settle();
    assert.equal(page.callsOf('vault.restore').length, 1, 'no confirmation without the checkbox');
    page.$('input[name="understand"]').click();
    await page.click('[data-action="restore-confirm"]');
    assert.deepEqual(page.callsOf('vault.restore').map((c) => c.params), [
      { token: TOKEN, mnemonic: core.KAT.mnemonic, password: NEW_PASSWORD },
      { token: TOKEN, mnemonic: core.KAT.mnemonic, password: NEW_PASSWORD, confirm: 'ERASE', replaceOther: true },
    ]);
    assert.match(page.text(), /Wallet restored/);
    assert.ok(page.text().includes(OTHER.qnet));
  });

  it('a stored wallet that cannot be read is said so, and the phrase\'s wallet is named', async () => {
    await openRestore({ 'vault.restore': worker({ erased: null, restored: ADDRESSES, otherWallet: false }) });
    await typeAndContinue();
    assert.match(page.$('.notice-warn').textContent, /cannot be read/);
    assert.match(page.text(), /Takes its place/);
    assert.ok(page.text().includes(ADDRESSES.qnet));
    page.$('input[name="understand"]').click();
    await page.click('[data-action="restore-confirm"]');
    assert.equal(page.callsOf('vault.restore')[1].params.replaceOther, undefined);
    assert.match(page.text(), /Wallet restored/);
  });

  it('keeps the worker up while the token exists: the restore token lives in its memory (R2-ESM-06)', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    await openRestore();
    const start = page.callsOf('vault.status').length;
    mock.timers.tick(TIMINGS.RESTORE_KEEPALIVE_MS * 3);
    await page.settle();
    assert.equal(page.callsOf('vault.status').length, start, 'no token yet: nothing to keep');
    await typeAndContinue();
    assert.ok(page.$('input[name="understand"]'));
    const before = page.callsOf('vault.status').length;
    mock.timers.tick(TIMINGS.RESTORE_KEEPALIVE_MS * 3);
    await page.settle();
    assert.equal(page.callsOf('vault.status').length, before + 3);
    await page.click('[data-action="back"]');
    const after = page.callsOf('vault.status').length;
    mock.timers.tick(TIMINGS.RESTORE_KEEPALIVE_MS * 3);
    await page.settle();
    assert.equal(page.callsOf('vault.status').length, after, 'no keepalive once the screen is gone');
  });

  it('Back leaves the flow without asking the worker for anything; Back from the confirmation erases nothing', async () => {
    await openRestore();
    await page.click('[data-action="back"]');
    assert.ok(page.$('[data-action="unlock"]'));
    assert.equal(page.callsOf('vault.restoreBegin').length, 0);
    await page.click('[data-action="forgot-password"]');
    await typeAndContinue();
    page.$('input[name="understand"]').click();
    await page.click('[data-action="back"]');
    assert.ok(page.$('[data-action="unlock"]'));
    assert.equal(page.callsOf('vault.restore').filter((c) => c.params.confirm === 'ERASE').length, 0);
  });
});

describe('popup: lock, wipe and events', () => {
  it('the Lock button shows the lock screen even when the worker does not confirm (EXT-SEC-M1)', async () => {
    await openWallet({ 'vault.lock': () => fail('INTERNAL') });
    await page.click('[data-action="lock"]');
    assert.ok(page.$('input[name="password"]'));
    assert.equal(page.$('[data-tab]'), null);
    assert.equal(page.callsOf('vault.lock').length, 1);
  });

  it("a worker 'locked' event wipes typed values and shows the lock screen", async () => {
    let locked = false;
    await openWallet({ 'vault.status': () => (locked ? lockedStatus() : unlockedStatus()) });
    await page.click('[data-tab="send"]');
    const to = page.$('input[name="to"]');
    const amount = page.$('input[name="amount"]');
    type(to, RECIPIENT);
    type(amount, '1');
    locked = true;
    page.emit('locked');
    await page.settle();
    assert.equal(to.value, '');
    assert.equal(amount.value, '');
    assert.ok(page.$('input[name="password"]'));
    assert.equal(page.$('[data-tab]'), null);
  });

  it('ignores the same event from a content script or a tab', async () => {
    await openWallet();
    page.emit('locked', { id: page.chrome.runtime.id, url: 'https://aiqnet.io/', tab: { id: 4 } });
    page.emit('wiped', { id: page.chrome.runtime.id, url: page.chrome.runtime.getURL('background/sw.js'), tab: { id: 4 } });
    await page.settle();
    assert.ok(page.$('[data-tab="assets"]'));
    assert.equal(page.location.reloads, 0);
  });

  it("a 'wiped' event clears the page storage, empties the clipboard and reloads once", async () => {
    await openWallet({}, { localStorage: { anything: '1' } });
    page.sessionStorage.setItem('s', '1');
    page.emit('wiped');
    assert.equal(page.localStorage.length, 0);
    assert.equal(page.sessionStorage.length, 0);
    page.emit('wiped');
    await page.settle();
    assert.deepEqual(page.clipboard.writes, [''], 'a wipe from another view empties the clipboard too (R16)');
    assert.equal(page.location.reloads, 1);
  });

  // R4-ESM-01: the worker announces the wipe before it deletes the database and answers vault.wipe, so this popup
  // reloads inside the event, before the delete's own continuation: the clipboard must be emptied there.
  it('Delete wallet empties the clipboard although the worker announces the wipe before it answers (R4-ESM-01)', async () => {
    await openWallet({
      'activation.status': () => ({ activation: activationRecord('light'), pending: null, busy: false }),
      'activation.copy': () => ({ code: CODE }),
      'vault.wipe': async () => {
        page.emit('wiped');
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { wiped: true };
      },
    });
    await page.click('[data-tab="settings"]');
    await page.click('[data-action="copy-code"]');
    assert.equal(page.clipboard.text, CODE);
    await page.click('[data-action="delete-wallet"]');
    type(page.$('input[name="password"]'), PASSWORD);
    type(page.$('input[name="confirm"]'), 'DELETE');
    // a real reload ends the page: whatever the clipboard holds when it is asked for stays there
    const atReload = [];
    const reload = page.location.reload.bind(page.location);
    page.location.reload = () => {
      atReload.push(page.clipboard.text);
      reload();
    };
    await page.click('[data-action="confirm-delete"]');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await page.settle();
    assert.deepEqual(atReload, [''], 'emptied before the one reload: the activation code does not outlive the wallet');
    assert.equal(page.localStorage.length, 0);
  });
});

describe('popup: send', () => {
  it('QNet: checks the address locally, previews, warns about a look-alike, and sends the previewed fee and nonce', async () => {
    let sent = null;
    await openWallet({
      'qnet.preview': ({ to, amount }) => {
        assert.equal(amount, '1.5');
        return {
          from: ADDRESSES.qnet, to, amountNano: '1500000000', feeNano: '31500', totalNano: '1500031500', nonce: '4',
          balanceNano: '12500000000', verified: false, verification: 'none',
          // the worker's check (qnet.recipientCheck): the page shows it, it never builds its own list (ES-01)
          recipient: { known: false, lookalike: true, incomingOnly: true, historyRead: true },
        };
      },
      'qnet.send': (params) => {
        sent = params;
        return { txHash: 'ab'.repeat(32), status: 'submitted', nonce: '4' };
      },
    });
    await page.click('[data-tab="send"]');
    assertAllInputsHardened(page);
    type(page.$('input[name="to"]'), `${RECIPIENT.slice(0, -1)}0`);
    type(page.$('input[name="amount"]'), '01.50');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /not a valid QNet address/);
    assert.equal(page.callsOf('qnet.preview').length, 0);

    type(page.$('input[name="to"]'), ` ${RECIPIENT} `);
    // the history the popup reads after an open is no read of the review's own
    await page.settle();
    const historyReads = page.callsOf('qnet.history').length;
    await page.click('[data-action="review"]');
    const text = page.text();
    assert.ok(text.includes(RECIPIENT), 'the full recipient is shown');
    assert.match(text, /0\.0000315 QNC/);
    assert.match(text, /1\.5000315 QNC/);
    assert.match(text, /Nonce4/);
    assert.match(text, /look-alike/);
    assert.match(text, /only ever sent to you/);
    // no text on how the numbers were verified, and no always-on compare-the-characters box (owner, 28.09)
    assert.doesNotMatch(text, /could not be verified|first and last characters|Never copy an address/);
    assert.equal(page.callsOf('qnet.history').length, historyReads, 'no history of its own for the warnings');
    await page.click('[data-action="confirm-send"]');
    assert.deepEqual(sent, { to: RECIPIENT, amount: '1.5', expectedFeeNano: '31500', expectedNonce: '4' });
    assert.match(page.text(), /Sent/);
    assert.doesNotMatch(page.text(), /submitted to the network|which the wallet verifies/);
  });

  it('QNet: a recipient that is a contract gets no review; one that cannot be checked says so (EXT-R2A-01)', async () => {
    let refusal = 'RECIPIENT_IS_CONTRACT';
    await openWallet({
      'qnet.preview': () => fail(refusal),
      'qnet.send': () => assert.fail('nothing is sent'),
    });
    await page.click('[data-tab="send"]');
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '100');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /This address is a contract\. Nothing can ever move what is sent to it/);
    assert.equal(page.$('[data-action="confirm-send"]'), null, 'no review to confirm');
    refusal = 'RECIPIENT_UNCHECKED';
    await page.click('[data-action="review"]');
    assert.match(page.text(), /could not check whether this address is a contract/);
    assert.equal(page.$('[data-action="confirm-send"]'), null);
    assert.equal(page.callsOf('qnet.send').length, 0);
  });

  it('QNet: names unconfirmed sends and a second payment, offers to replace it, and shows what is left to spend (R2-EXTQ-03)', async () => {
    const outstanding = [{ nonce: '4', to: RECIPIENT, amountNano: '1500000000', feeNano: '31500', createdAt: 1, stale: false }];
    const previews = [];
    let sent = null;
    await openWallet({
      'qnet.balance': () => ({
        balanceNano: '12500000000', spendableNano: '10999968500', nonce: '3', verified: true, verification: 'proof', blockHeight: 1,
      }),
      'qnet.preview': (params) => {
        previews.push(params);
        const replacing = params.replaceNonce ?? null;
        return {
          from: ADDRESSES.qnet, to: params.to, amountNano: '1500000000', feeNano: '31500', totalNano: '1500031500',
          nonce: replacing ?? '5', balanceNano: '10999968500', verified: true, verification: 'proof',
          outstanding, replacesNonce: replacing,
          recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true, recentSame: false },
        };
      },
      'qnet.send': (params) => {
        sent = params;
        return { txHash: 'ab'.repeat(32), status: 'unknown', nonce: params.replaceNonce ?? '5' };
      },
    });
    await page.click('[data-tab="send"]');
    assert.match(page.text(), /Available: 10\.9999685 QNC/, 'the spendable amount, not the balance');
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '1.5');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /not confirmed yet: 1/);
    assert.match(page.text(), /do not pay twice/);
    // the replace button names the transfer it cancels: amount, recipient and nonce (R3-EXTQ-03)
    assert.match(page.$('[data-action="replace-pending"]').textContent, /1\.5 QNC to 5fce39…27531f \(nonce 4\)/);
    await page.click('[data-action="replace-pending"]');
    assert.deepEqual(previews.at(-1), { to: RECIPIENT, amount: '1.5', replaceNonce: '4' });
    assert.match(page.text(), /replaces the unconfirmed one of 1\.5 QNC to 5fce39…27531f \(nonce 4\)/);
    await page.click('[data-action="confirm-send"]');
    assert.deepEqual(sent, { to: RECIPIENT, amount: '1.5', expectedFeeNano: '31500', expectedNonce: '4', replaceNonce: '4' });
    // the hash a node returned is neither shown nor linked (R2-EXTQ-06)
    assert.ok(!page.text().includes('ab'.repeat(32)));
    assert.equal(page.$('[data-action="explorer"]'), null);
  });

  // R3-EXTQ-03: the transfer to be replaced lands while the replace is being confirmed: nothing is signed, and the
  // same recipient and amount would now be an additional payment, so no review of it is drawn.
  it('QNet: a replace whose target was decided meanwhile never turns into an additional send (R3-EXTQ-03)', async () => {
    const outstanding = [{ nonce: '4', to: RECIPIENT, amountNano: '1500000000', feeNano: '31500', createdAt: 1, stale: false }];
    const previews = [];
    await openWallet({
      'qnet.preview': (params) => {
        previews.push(params);
        const replacing = params.replaceNonce ?? null;
        return {
          from: ADDRESSES.qnet, to: params.to, amountNano: '1500000000', feeNano: '31500', totalNano: '1500031500',
          nonce: replacing ?? '5', balanceNano: '10999968500', verified: true, verification: 'proof', outstanding, replacesNonce: replacing,
          duplicate: true, recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true, recentSame: false },
        };
      },
      'qnet.send': () => fail('NONCE_CHANGED'),
    });
    await page.click('[data-tab="send"]');
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '1.5');
    await page.click('[data-action="review"]');
    await page.click('[data-action="replace-pending"]');
    await page.click('[data-action="confirm-send"]');
    assert.equal(previews.length, 2, 'no fresh review of an additional send');
    assert.match(page.text(), /1\.5 QNC to 5fce39…27531f \(nonce 4\) was decided before this one could replace it/);
    assert.match(page.text(), /Nothing was signed/);
    assert.equal(page.$('[data-action="confirm-send"]'), null);
  });

  // R3-EXTQ-01: the vault's own records name a second payment. A history that could not be read is no longer described
  // on the screen (owner, 28.09): the duplicate check itself is unchanged.
  it('QNet: names a second payment from the wallet\'s own records, with no text on a history that could not be read (R3-EXTQ-01)', async () => {
    await openWallet({
      'qnet.preview': (params) => ({
        from: ADDRESSES.qnet, to: params.to, amountNano: '1500000000', feeNano: '31500', totalNano: '1500031500', nonce: '5',
        balanceNano: '10999968500', verified: true, verification: 'proof', outstanding: [], replacesNonce: null, duplicate: true,
        recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: false, recentSame: false },
      }),
    });
    await page.click('[data-tab="send"]');
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '1.5');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /do not pay twice/);
    assert.doesNotMatch(page.text(), /history could not be read/);
  });

  it('QNet: a changed fee sends the user back to a fresh review', async () => {
    let previews = 0;
    await openWallet({
      'qnet.preview': ({ to }) => {
        previews += 1;
        const fee = previews === 1 ? '31500' : '47250';
        return {
          from: ADDRESSES.qnet, to, amountNano: '1000000000', feeNano: fee, totalNano: String(1000000000 + Number(fee)), nonce: '4',
          balanceNano: '12500000000', verified: true, verification: 'proof',
          recipient: { known: false, lookalike: false, incomingOnly: false, historyRead: true },
        };
      },
      'qnet.send': () => fail('FEE_CHANGED'),
    });
    await page.click('[data-tab="send"]');
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '1');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /has not sent to this address before/);
    assert.doesNotMatch(page.text(), /look-alike|only ever sent/);
    await page.click('[data-action="confirm-send"]');
    assert.equal(previews, 2);
    assert.match(page.text(), /The fee changed\. Review again\./);
    assert.match(page.text(), /0\.00004725 QNC/);
  });

  // R3-EXT-UI-03: a Solana send gets the first-time and look-alike warnings the QNet send has.
  it('Solana: names a first-time recipient and a look-alike of one this wallet paid (R3-EXT-UI-03)', async () => {
    let recipient = { known: false, lookalike: false };
    await openWallet({
      'solana.quote': (params) => ({
        asset: 'sol', to: params.to, amountRaw: '1000000', feeLamports: '5000', createsRecipientAccount: false, rentLamports: '0',
        totalLamports: '1005000', recipient, references: [], memo: null,
      }),
    });
    await page.click('.network-switch [data-value="solana"]');
    await page.click('[data-tab="send"]');
    type(page.$('input[name="to"]'), SOLANA_RECIPIENT);
    type(page.$('input[name="amount"]'), '0.001');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /has not sent to this address before/);
    recipient = { known: false, lookalike: true };
    await page.click('[data-action="back"]');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /looks like one you sent to before/);
    assert.doesNotMatch(page.text(), /has not sent to this address before/);
  });
});

// The Solana send (owner, 29.09): the token, a recipient address or a pasted payment request, the amount with Max, a
// review with every detail and the armed Send, then pending until the status settles it.
const SOLANA_OTHER_MINT = core.solanaAddressFromPublicKey(new Uint8Array(32).fill(21));
const units = (amount, decimals) => {
  const [whole, fraction = ''] = amount.split('.');
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
};
function solanaQuote(params, extra = {}) {
  const token = params.asset === '1dev';
  const amountRaw = units(params.amount, token ? 6 : 9);
  return {
    asset: params.asset, to: params.to, mint: token ? SOLANA.ONE_DEV_MINT : null, decimals: token ? 6 : 9, amountRaw, feeLamports: '5000',
    createsRecipientAccount: false, rentLamports: '0', totalLamports: String(5000n + (token ? 0n : BigInt(amountRaw))),
    balanceLamports: '2000000000', tokenRaw: token ? '5000000000' : null, rentFloorLamports: '890880', shortfall: null,
    recipient: { known: true, lookalike: false }, references: params.references ?? [], memo: params.memo ?? null, ...extra,
  };
}
// Payment request references: four distinct addresses, and a fifth one too many.
const SOLANA_REFERENCES = [1, 2, 3, 4, 5].map((n) => core.solanaAddressFromPublicKey(new Uint8Array(32).fill(40 + n)));
function paste(input, text) {
  const event = new FakeEvent('paste');
  event.clipboardData = { getData: (kind) => (kind === 'text' ? text : '') };
  input.dispatchEvent(event);
  return event;
}
async function openSolanaSend(overrides = {}) {
  await openWallet({ 'solana.quote': (params) => solanaQuote(params), ...overrides });
  await page.click('.network-switch [data-value="solana"]');
  await page.click('[data-tab="send"]');
}
const pressedAsset = () => page.$$('.tab-body .segmented [aria-pressed="true"]').map((node) => node.getAttribute('data-value'));

describe('popup: Solana send', () => {
  it('reviews the token, its mint, the fee and the new account\'s rent, arms Send, and sends with the quoted fee and rent', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let sent = null;
    await openSolanaSend({
      'solana.quote': (params) => {
        assert.deepEqual(params, { asset: '1dev', to: SOLANA_RECIPIENT, amount: '2.5' });
        return solanaQuote(params, { createsRecipientAccount: true, rentLamports: '2039280', totalLamports: '2044280' });
      },
      'solana.send': (params) => {
        sent = params;
        return { signature: BURN_TX, status: 'confirmed', lastValidBlockHeight: 100 };
      },
    });
    await page.click('[data-value="1dev"]');
    assert.match(page.text(), /Available: 5000 1DEV/);
    type(page.$('input[name="to"]'), SOLANA_RECIPIENT);
    type(page.$('input[name="amount"]'), '2.5');
    await page.click('[data-action="review"]');
    const text = page.text();
    assert.match(text, /Token1DEV/);
    assert.ok(text.includes(SOLANA.ONE_DEV_MINT), 'the mint');
    assert.match(text, /2\.5 1DEV/);
    assert.match(text, /Network fee0\.000005 SOL/);
    assert.match(text, /Rent of new 1DEV account0\.00203928 SOL/);
    assert.match(text, /Total SOL spent0\.00204428 SOL/);
    assert.match(text, /Solana devnet/);
    assert.equal(page.$('.tab-body input[type="password"]'), null, 'no password: the unlocked session confirms');
    const send = page.$('[data-action="confirm-send"]');
    assert.equal(send.disabled, true, 'Send arms after the value delay');
    send.click();
    mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS - 1);
    assert.equal(send.disabled, true);
    mock.timers.tick(1);
    assert.equal(send.disabled, false);
    await page.click('[data-action="confirm-send"]');
    assert.deepEqual(sent, {
      asset: '1dev', to: SOLANA_RECIPIENT, amount: '2.5', expectedFeeLamports: '5000', expectedRentLamports: '2039280',
    });
    assert.equal(page.callsOf('solana.send').length, 1);
    assert.equal(page.$('.tab-body h2').textContent, 'Confirmed');
    assert.equal(page.callsOf('solana.status').length, 0, 'confirmed already: nothing to follow');
    await page.click('[data-action="explorer"]');
    assert.deepEqual(page.tabsCreated.at(-1), { url: `${SOLANA.EXPLORER_TX_URL}${BURN_TX}${SOLANA.EXPLORER_CLUSTER_QUERY}` });
  });

  it('a submitted send is pending until solana.status settles it, and the balance is read again', async () => {
    for (const [final, title, lead] of [['finalized', 'Confirmed', null], ['failed', 'Failed', /Its network fee was paid/],
      ['expired', 'Expired', /before its blockhash expired\. Nothing moved: send it again/]]) {
      mock.timers.enable({ apis: ['setTimeout'] });
      const answers = ['pending', 'pending', final];
      await openSolanaSend({
        'solana.send': () => ({ signature: BURN_TX, status: 'submitted', lastValidBlockHeight: 150 }),
        'solana.status': (params) => {
          assert.deepEqual(params, { signature: BURN_TX, lastValidBlockHeight: 150 });
          return { status: answers.shift() };
        },
      });
      type(page.$('input[name="to"]'), SOLANA_RECIPIENT);
      type(page.$('input[name="amount"]'), '0.25');
      await page.click('[data-action="review"]');
      mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
      await page.click('[data-action="confirm-send"]');
      assert.equal(page.$('.tab-body h2').textContent, 'Sent, not yet confirmed');
      assert.match(page.text(), /Waiting for Solana to confirm it…/);
      assert.ok(page.$('.tab-body .spinner'));
      assert.ok(page.$('[data-action="send-again"]').classList.contains('hidden'));
      const balances = page.callsOf('solana.balances').length;
      for (let i = 0; i < 2; i += 1) {
        mock.timers.tick(2000);
        await page.settle();
        assert.equal(page.$('.tab-body h2').textContent, 'Sent, not yet confirmed', final);
      }
      mock.timers.tick(2000);
      await page.settle();
      assert.equal(page.callsOf('solana.status').length, 3);
      assert.equal(page.$('.tab-body h2').textContent, title, final);
      assert.equal(page.$('.tab-body .spinner'), null);
      if (lead) assert.match(page.text(), lead);
      assert.equal(page.callsOf('solana.balances').length, balances + 1, `${final}: the balance is read again`);
      mock.timers.tick(20000);
      await page.settle();
      assert.equal(page.callsOf('solana.status').length, 3, 'settled: no more reads');
      const again = page.$('[data-action="send-again"]');
      assert.equal(again.classList.contains('hidden'), final === 'finalized', final);
      if (final === 'expired') {
        await page.click('[data-action="send-again"]');
        assert.equal(page.$('input[name="to"]').value, SOLANA_RECIPIENT, 'Send again keeps the recipient');
        assert.equal(page.$('input[name="amount"]').value, '0.25');
      }
      assert.deepEqual(page.violations, [], 'every request matches the router table');
      page.close();
      page = null;
      mock.timers.reset();
    }
  });

  it('a changed fee or an expired blockhash quotes again with the reason; other errors stay on the review', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const failures = ['BLOCKHASH_EXPIRED', 'FEE_CHANGED', 'SOLANA_UNAVAILABLE'];
    await openSolanaSend({ 'solana.send': () => fail(failures.shift()) });
    type(page.$('input[name="to"]'), SOLANA_RECIPIENT);
    type(page.$('input[name="amount"]'), '0.25');
    await page.click('[data-action="review"]');
    for (const [text, quotes] of [[/expired before it was sent\. Nothing was sent\. Review it again\./, 2], [/The fee changed\. Review again\./, 3]]) {
      mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
      await page.click('[data-action="confirm-send"]');
      assert.match(page.text(), text);
      assert.equal(page.callsOf('solana.quote').length, quotes);
      assert.equal(page.$('[data-action="confirm-send"]').disabled, true, 'a fresh review arms again');
    }
    mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    await page.click('[data-action="confirm-send"]');
    assert.match(page.$('.tab-body .message').textContent, /Solana could not be read\. Try again\./);
    assert.equal(page.callsOf('solana.quote').length, 3);
  });

  it('names a shortfall with its numbers and keeps Send off', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const cases = [
      ['sol', { shortfall: 'INSUFFICIENT_SOL', totalLamports: '3000005000' }, /this send needs 3\.000005 SOL in all, and the wallet holds 2 SOL/],
      ['1dev', { shortfall: 'INSUFFICIENT_TOKENS', tokenRaw: '1500000' }, /Not enough tokens: the wallet holds 1\.5 1DEV/],
      ['sol', { shortfall: 'AMOUNT_BELOW_RENT' }, /must be at least 0\.00089088 SOL/],
      ['sol', { shortfall: 'SOL_BELOW_RENT' }, /keeps at least 0\.00089088 SOL or is emptied\. Send less, or send everything with Max/],
      ['1dev', { shortfall: 'SOL_BELOW_RENT' }, /less than 0\.00089088 SOL would stay in this wallet’s SOL.*Add SOL first/],
    ];
    let current = null;
    await openSolanaSend({ 'solana.quote': (params) => solanaQuote(params, current) });
    for (const [asset, extra, text] of cases) {
      current = extra;
      await page.click('[data-tab="send"]');
      if (asset === '1dev') await page.click('[data-value="1dev"]');
      type(page.$('input[name="to"]'), SOLANA_RECIPIENT);
      type(page.$('input[name="amount"]'), '3');
      await page.click('[data-action="review"]');
      assert.match(page.$('.tab-body .notice-danger').textContent, text, extra.shortfall);
      mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS * 2);
      assert.equal(page.$('[data-action="confirm-send"]').disabled, true, `${extra.shortfall}: Send stays off`);
    }
    assert.equal(page.callsOf('solana.send').length, 0);
  });

  it('Max asks the worker for the amount of the chosen token, with the recipient once it is an address', async () => {
    const maxCalls = [];
    await openSolanaSend({
      'solana.max': (params) => {
        maxCalls.push(params);
        if (maxCalls.length === 3) return fail('INSUFFICIENT_SOL');
        return params.asset === 'sol' ? { amount: '1.999995', amountRaw: '1999995000' } : { amount: '5000', amountRaw: '5000000000' };
      },
    });
    assert.match(page.text(), /Available: 2 SOL/);
    await page.click('[data-action="max"]');
    assert.equal(page.$('input[name="amount"]').value, '1.999995');
    type(page.$('input[name="to"]'), SOLANA_RECIPIENT);
    await page.click('[data-value="1dev"]');
    assert.match(page.text(), /Available: 5000 1DEV/);
    assert.match(page.text(), /Amount \(1DEV\)/);
    await page.click('[data-action="max"]');
    assert.equal(page.$('input[name="amount"]').value, '5000');
    await page.click('[data-value="sol"]');
    await page.click('[data-action="max"]');
    assert.match(page.text(), /Not enough SOL for this transaction and its network fee\./);
    assert.deepEqual(maxCalls, [{ asset: 'sol' }, { asset: '1dev', to: SOLANA_RECIPIENT }, { asset: 'sol', to: SOLANA_RECIPIENT }]);
  });

  it('a pasted payment request fills the recipient, the token and the amount; its label and message are plain text', async () => {
    await openSolanaSend();
    const to = page.$('input[name="to"]');
    const request = `solana:${SOLANA_RECIPIENT}?amount=2.50&spl-token=${SOLANA.ONE_DEV_MINT}`
      + '&label=Shop%20%3Cb%3Eone%3C%2Fb%3E&message=Order%2042%E2%80%AE%20https%3A%2F%2Fpay.example.test%2Fx&unknown=1';
    const event = paste(to, request);
    await page.settle();
    assert.equal(event.defaultPrevented, true, 'the request itself never lands in the field');
    assert.equal(to.value, SOLANA_RECIPIENT);
    assert.deepEqual(pressedAsset(), ['1dev']);
    assert.equal(page.$('input[name="amount"]').value, '2.5');
    assert.match(page.text(), /Filled in from the payment request\. Check everything, then review\./);
    assert.match(page.text(), /Payment request/);
    assert.match(page.text(), /LabelShop <b>one<\/b>/, 'shown as text, never as markup');
    assert.match(page.text(), /MessageOrder 42 https:\/\/pay\.example\.test\/x/, 'the bidi override is gone');
    assert.equal(page.$('a'), null, 'never a link');
    assert.equal(page.callsOf('solana.quote').length, 0, 'the user still reviews');
    await page.click('[data-action="review"]');
    assert.deepEqual(page.callsOf('solana.quote').map((entry) => entry.params), [{ asset: '1dev', to: SOLANA_RECIPIENT, amount: '2.5' }]);
    assert.match(page.text(), /LabelShop <b>one<\/b>/, 'the review names the request too');
    await page.click('[data-action="back"]');
    assert.match(page.text(), /Payment request/, 'back keeps it');
    type(page.$('input[name="to"]'), SOLANA_OTHER_MINT);
    assert.doesNotMatch(page.text(), /Payment request/, 'another recipient drops it');
  });

  it('a payment request\'s references and memo: named on the form and the review, quoted and sent exactly as read', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let sent = null;
    await openSolanaSend({
      'solana.send': (params) => {
        sent = params;
        return { signature: BURN_TX, status: 'confirmed', lastValidBlockHeight: 100 };
      },
    });
    const references = SOLANA_REFERENCES.slice(0, 4);
    const memo = 'order 42+1 <b>x</b>';
    paste(page.$('input[name="to"]'), `solana:${SOLANA_RECIPIENT}?amount=1.0000000000&${references.map((r) => `reference=${r}`).join('&')}`
      + '&memo=order+42%2B1+%3Cb%3Ex%3C%2Fb%3E&label=Shop&label=Other');
    await page.settle();
    assert.equal(page.$('input[name="to"]').value, SOLANA_RECIPIENT);
    assert.equal(page.$('input[name="amount"]').value, '1', 'trailing zeros are no decimal places SOL lacks');
    assert.deepEqual(pressedAsset(), ['sol']);
    for (const screen of ['form', 'review']) {
      const text = page.text();
      assert.match(text, /LabelShop/, `${screen}: the first label`);
      assert.doesNotMatch(text, /Other/, screen);
      assert.ok(text.includes(`Memo${memo}`), `${screen}: the memo, form-decoded ('+' a space, %2B a plus), as text`);
      assert.match(text, /References attached4/, screen);
      assert.equal(page.$('a'), null, `${screen}: never a link`);
      if (screen === 'form') await page.click('[data-action="review"]');
    }
    assert.deepEqual(page.callsOf('solana.quote').map((entry) => entry.params),
      [{ asset: 'sol', to: SOLANA_RECIPIENT, amount: '1', references, memo }]);
    mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    await page.click('[data-action="confirm-send"]');
    assert.deepEqual(sent, {
      asset: 'sol', to: SOLANA_RECIPIENT, amount: '1', references, memo, expectedFeeLamports: '5000', expectedRentLamports: '0',
    }, 'the send plans again from exactly what was quoted');
    assert.deepEqual(page.violations, [], 'every request matches the router table');
  });

  it('the references and memo go to the request\'s address only, and a quote that does not carry them is refused', async () => {
    let quoted = (params) => solanaQuote(params);
    await openSolanaSend({ 'solana.quote': (params) => quoted(params) });
    const request = `solana:${SOLANA_RECIPIENT}?amount=0.5&reference=${SOLANA_REFERENCES[0]}&memo=m`;
    paste(page.$('input[name="to"]'), request);
    await page.settle();
    type(page.$('input[name="to"]'), SOLANA_OTHER_MINT);
    await page.click('[data-action="review"]');
    assert.deepEqual(page.callsOf('solana.quote').at(-1).params, { asset: 'sol', to: SOLANA_OTHER_MINT, amount: '0.5' });
    assert.doesNotMatch(page.text(), /Memo|References attached/);
    for (const dropped of [{ references: [] }, { memo: null }, { references: [SOLANA_REFERENCES[1]] }, { memo: 'n' }, { references: undefined }]) {
      quoted = (params) => solanaQuote(params, dropped);
      await page.click('[data-tab="send"]');
      paste(page.$('input[name="to"]'), request);
      await page.settle();
      await page.click('[data-action="review"]');
      assert.match(page.$('.tab-body .message').textContent, /Something went wrong/, JSON.stringify(dropped));
      assert.equal(page.$('[data-action="confirm-send"]'), null, `${JSON.stringify(dropped)}: no review`);
    }
    assert.equal(page.callsOf('solana.send').length, 0);
  });

  it('refuses a payment request it cannot fill, and anything that is not an address', async () => {
    const cases = [
      [`solana:${SOLANA_RECIPIENT}?spl-token=${SOLANA_OTHER_MINT}`, /is for a token this wallet does not list\. Nothing was filled in\./],
      [`solana:${SOLANA_RECIPIENT}?amount=1&amount=2`, /neither a Solana address nor a payment request the wallet can read/],
      [`solana:${SOLANA_RECIPIENT}?memo=a&memo=b`, /neither a Solana address nor a payment request the wallet can read/],
      [`solana:${SOLANA_RECIPIENT}?${SOLANA_REFERENCES.map((r) => `reference=${r}`).join('&')}`, /neither a Solana address nor a payment request/],
      [`solana:${SOLANA_RECIPIENT}?reference=${SOLANA_REFERENCES[0]}&reference=${SOLANA_REFERENCES[0]}`, /neither a Solana address nor/],
      [`solana:${SOLANA_RECIPIENT}?reference=not-an-address`, /neither a Solana address nor a payment request the wallet can read/],
      [`solana:${SOLANA_RECIPIENT}?memo=${'x'.repeat(201)}`, /neither a Solana address nor a payment request the wallet can read/],
      [`solana:${SOLANA_RECIPIENT}?memo=a%E2%80%AEb`, /neither a Solana address nor a payment request the wallet can read/],
      [`solana:${SOLANA_RECIPIENT}?amount=0.0000000001`, /amount in this payment request is not valid for its token/],
      [`solana:${SOLANA_RECIPIENT}?amount=1.0000001&spl-token=${SOLANA.ONE_DEV_MINT}`, /amount in this payment request is not valid for its token/],
      [`solana:${SOLANA_RECIPIENT}?amount=-1`, /amount in this payment request is not valid for its token/],
      [`solana:${SOLANA_RECIPIENT}?amount=1e3`, /amount in this payment request is not valid for its token/],
      ['solana:not-an-address?amount=1', /neither a Solana address nor a payment request the wallet can read/],
      [`solana:${SOLANA_RECIPIENT}?label=%E0%A4%A`, /neither a Solana address nor a payment request the wallet can read/],
      ['solana:https://pay.example.test/request', /neither a Solana address nor a payment request the wallet can read/],
    ];
    await openSolanaSend();
    for (const [text, refusal] of cases) {
      type(page.$('input[name="amount"]'), '7');
      const event = paste(page.$('input[name="to"]'), text);
      assert.equal(event.defaultPrevented, true, text);
      assert.match(page.$('.tab-body .message').textContent, refusal, text);
      assert.equal(page.$('input[name="to"]').value, '', `${text}: nothing filled`);
      assert.equal(page.$('input[name="amount"]').value, '7', `${text}: the amount is kept`);
      assert.deepEqual(pressedAsset(), ['sol']);
    }
    // a plain address pastes as it is; junk is refused at Review, as it always was
    assert.equal(paste(page.$('input[name="to"]'), SOLANA_RECIPIENT).defaultPrevented, false);
    type(page.$('input[name="to"]'), 'hello there');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /This is not a valid Solana address/);
    // a request typed in rather than pasted fills the form at Review, and nothing is quoted yet
    type(page.$('input[name="to"]'), `SOLANA:${SOLANA_RECIPIENT}?amount=0.5`);
    await page.click('[data-action="review"]');
    assert.equal(page.$('input[name="to"]').value, SOLANA_RECIPIENT);
    assert.equal(page.$('input[name="amount"]').value, '0.5');
    assert.equal(page.callsOf('solana.quote').length, 0);
  });

  it('the QNet send keeps taking only QNet addresses', async () => {
    await openWallet();
    await page.click('[data-tab="send"]');
    type(page.$('input[name="to"]'), `solana:${SOLANA_RECIPIENT}?amount=1`);
    type(page.$('input[name="amount"]'), '1');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /This is not a valid QNet address/);
    type(page.$('input[name="to"]'), SOLANA_RECIPIENT);
    await page.click('[data-action="review"]');
    assert.match(page.text(), /This is not a valid QNet address/);
    assert.equal(page.callsOf('qnet.preview').length, 0);
  });
});

describe('popup: receive and history', () => {
  it('draws the QR locally, copies the address, and fetches nothing remote', async () => {
    await openWallet();
    await page.click('[data-tab="receive"]');
    const canvas = page.$('canvas.qr');
    assert.ok(canvas.context.rects.length > 100, 'modules drawn on the canvas');
    assert.ok(page.text().includes(ADDRESSES.qnet));
    await page.click('[data-action="copy-address"]');
    assert.deepEqual(page.clipboard.writes, [ADDRESSES.qnet]);
    assert.match(page.$('.toast').textContent, /^Copied$/);
    assert.ok(page.fetches.every((url) => url.startsWith('chrome-extension://')), page.fetches.join(' '));
    await page.click('.network-switch [data-value="solana"]');
    assert.ok(page.text().includes(ADDRESSES.solana));
  });

  // Owner, 28.09: "Receive", one neutral line on what the address takes (QNC and every QNet token; SOL and Solana
  // tokens), the QR, the address with its edges set apart and Copy; no notice or warning box.
  it('Receive: one plain line per network and no warning boxes', async () => {
    await openWallet();
    await page.click('[data-tab="receive"]');
    const tab = page.$('.tab-body');
    assert.equal(tab.querySelector('h2').textContent, 'Receive');
    assert.equal(tab.querySelector('.heading .lead').textContent, 'Your QNet address for QNC and QNet tokens.');
    assert.equal(tab.querySelectorAll('.notice').length, 0, 'no notice or warning box');
    assert.doesNotMatch(tab.textContent, /Receive QNC|Only QNC|testnet|first and last characters/);
    assert.equal(tab.querySelectorAll('.addr-edge').length, 2, 'the start and end of the address are set apart');
    assert.ok(tab.querySelector('[data-action="copy-address"]'));
    await page.click('.network-switch [data-value="solana"]');
    assert.equal(tab.querySelector('h2').textContent, 'Receive');
    assert.equal(tab.querySelector('.heading .lead').textContent, 'Your Solana address for SOL and Solana tokens.');
    assert.equal(tab.querySelectorAll('.notice').length, 0);
    assert.doesNotMatch(tab.textContent, /Receive SOL|Only SOL|another network|first and last characters/);
  });

  // Owner, 28.09: the address card of Assets shows the whole address wrapped to the card, and the address itself copies
  // (a native button: Enter and Space press it) with "Click to copy" on hover; there is no separate Copy button.
  it('Assets: the full QNet and Solana address is the copy control, with no Copy button', async () => {
    await openWallet();
    for (const [network, address] of [['qnet', ADDRESSES.qnet], ['solana', ADDRESSES.solana]]) {
      if (network === 'solana') await page.click('.network-switch [data-value="solana"]');
      const card = page.$('.card.account');
      assert.equal(card.textContent.includes(address), true, `${network}: the whole address`);
      assert.doesNotMatch(card.textContent, /…/, `${network}: never shortened`);
      assert.equal(card.querySelectorAll('.addr-edge').length, 2);
      const control = card.querySelector('[data-action="copy-address"]');
      assert.equal(control.tagName, 'BUTTON');
      assert.equal(control.getAttribute('type'), 'button');
      assert.equal(control.getAttribute('title'), 'Click to copy');
      assert.match(control.getAttribute('aria-label'), /address, Click to copy$/);
      assert.equal(card.querySelectorAll('button').length, 1, `${network}: no separate Copy button`);
      assert.ok(page.$$('.tab-body button').every((node) => node.textContent !== 'Copy'), `${network}: no Copy button`);
      page.clipboard.writes.length = 0;
      await page.click('.card.account [data-action="copy-address"]');
      assert.deepEqual(page.clipboard.writes, [address]);
      assert.equal(page.$('.toast').textContent, 'Copied');
    }
  });

  it('lists pending transfers first, pages with the cursor, and a row opens its detail with the explorer link', async () => {
    const item = (hash, direction, status = 'confirmed') => ({
      hash, direction, from: direction === 'in' ? RECIPIENT : ADDRESSES.qnet, to: direction === 'in' ? ADDRESSES.qnet : RECIPIENT,
      amountNano: '2000000000', feeNano: '0', timestamp: 1_700_000_000_000, status,
    });
    await openWallet({
      'qnet.history': ({ cursor }) => (cursor === undefined
        ? { items: [item('c1', 'in')], cursor: 'next-page', pending: [item('p1', 'out', 'pending')] }
        : { items: [item('c2', 'out')], cursor: null, pending: [] }),
    });
    await page.click('[data-tab="history"]');
    assert.deepEqual(page.$$('.history-row .row-title').map((node) => node.textContent), ['Sent', 'Received']);
    assert.match(page.text(), /Pending/);
    await page.click('[data-action="more"]');
    // the first page as the open read it, again when the tab shows it, then More with the cursor
    const reads = page.callsOf('qnet.history').map((entry) => entry.params);
    assert.deepEqual(reads.at(-1), { cursor: 'next-page', limit: 20 });
    assert.ok(reads.slice(0, -1).every((params) => JSON.stringify(params) === '{"limit":20}'), JSON.stringify(reads));
    assert.equal(page.$$('.history-row').length, 3);
    assert.ok(page.$('[data-action="more"]').classList.contains('hidden'));
    // owner, 06.10: a row opens its detail in place of the list; the explorer is a button there, Back returns to the list
    await page.click('[data-action="open-detail"]');
    assert.ok(page.$('.history-detail') && !page.$('.history-detail').classList.contains('hidden'));
    assert.equal(page.$('.history-detail h2').textContent, 'Sent');
    await page.click('.history-detail [data-action="explorer"]');
    assert.deepEqual(page.tabsCreated.at(-1), { url: 'https://aiqnet.io/explorer/tx/p1' });
    await page.click('.history-detail [data-action="back"]');
    assert.ok(page.$('.history-detail').classList.contains('hidden'));
    assert.equal(page.$$('.history-row').length, 3, 'the list as it was, More pages included');
  });

  // Owner, 06.10: a token transfer this wallet sent reads as a send of that token (its letter, the sent badge, its
  // recipient), a contract call as one (the code badge, its contract).
  it('a site\'s contract call shows as one and its token transfer as a send, named by contract and recipient, with no QNC amount', async () => {
    const GAME = core.deriveContractAddress(ADDRESSES.qnet, 3);
    const row = (extra) => ({
      hash: '', direction: 'out', from: ADDRESSES.qnet, to: GAME, amountNano: '10000000', feeNano: '1500000', timestamp: 1_700_000_000_000,
      status: 'pending', nonce: '8', kind: 'call', method: 'play', recipient: null, ...extra,
    });
    await openWallet({
      'qnet.history': () => ({ items: [], cursor: null, pending: [row({}), row({ nonce: '9', method: 'transfer', recipient: RECIPIENT })] }),
    });
    await page.click('[data-tab="history"]');
    assert.deepEqual(page.$$('.history-row .row-title').map((node) => node.textContent), ['Contract call', 'Sent']);
    assert.deepEqual(page.$$('.history-row .history-action').map((node) => node.className),
      ['history-action history-action-call', 'history-action history-action-sent']);
    assert.deepEqual(page.$$('.history-row .history-party').map((node) => node.textContent),
      [`Contract ${GAME.slice(0, 6)}…${GAME.slice(-6)}`, `To: ${RECIPIENT.slice(0, 6)}…${RECIPIENT.slice(-6)}`]);
    assert.equal(page.$$('.history-row .history-icon')[1].textContent, 'T', 'a token the list does not know: a letter, never the QNC icon');
    assert.equal(page.$$('.history-row .amount').length, 0, 'a call moves no QNC but its fee');
  });

  it('QNet: an unconfirmed contract call is named as one where a send can replace it', async () => {
    const GAME = core.deriveContractAddress(ADDRESSES.qnet, 3);
    const outstanding = [{ nonce: '4', to: GAME, amountNano: '0', feeNano: '4500000', createdAt: 1, stale: false, refused: false, kind: 'call' }];
    await openWallet({
      'qnet.preview': (params) => {
        const replacing = params.replaceNonce ?? null;
        return {
          from: ADDRESSES.qnet, to: params.to, amountNano: '1500000000', feeNano: '31500', totalNano: '1500031500',
          nonce: replacing ?? '5', balanceNano: '10999968500', verified: true, verification: 'proof', outstanding, replacesNonce: replacing,
          recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true, recentSame: false },
        };
      },
    });
    await page.click('[data-tab="send"]');
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '1.5');
    await page.click('[data-action="review"]');
    assert.match(page.$('[data-action="replace-pending"]').textContent, new RegExp(`contract call to ${GAME.slice(0, 6)}…${GAME.slice(-6)} \\(nonce 4\\)`));
    assert.ok(!/do not pay twice/.test(page.text()), 'a call is never a second payment of this transfer');
    await page.click('[data-action="replace-pending"]');
    assert.match(page.text(), /replaces the unconfirmed contract call to/);
  });

  // Owner, 28.09: History shows plain badges. The worker's states are unchanged (R2-EXTQ-02, R3-EXTQ-04,
  // R4-EXTQ-04, R5-EXTQ-01, R5-EXTQ-02); only their names on screen are: two pinned nodes list it (included) →
  // Confirmed; another transaction took its nonce (replaced) → Failed; what may still apply (pending, stale, unknown,
  // refused) → Pending. Owner, 06.10: a row resolves: one no node can hold any more (dropped) → Not found, and an explorer
  // row no two pinned nodes list (unverified) → Unverified, never Pending forever. Owner, 06.10: a row says its state only
  // while it is not confirmed (after who it was with), a row where nothing moved carries the failed mark, and the detail
  // keeps the badge of every state, Confirmed too.
  it('shows each row state as Pending, Failed, Not found or Unverified, Confirmed in its detail, and no text on where the list comes from', async () => {
    const row = (hash, status, nonce = null) => ({
      hash, direction: 'out', from: ADDRESSES.qnet, to: RECIPIENT, amountNano: '1', feeNano: '0', timestamp: 1_700_000_000_000, status, nonce,
    });
    const states = ['pending', 'stale', 'unknown', 'refused', 'replaced', 'dropped'];
    await openWallet({
      'qnet.history': () => ({
        items: [row('c1', 'included'), row('u1', 'unverified')],
        cursor: null,
        pending: states.map((status, index) => row('', status, String(9 - index))),
      }),
    });
    await page.click('[data-tab="history"]');
    const tab = page.$('.tab-body');
    assert.equal(tab.querySelector('h2').textContent, 'History');
    assert.equal(tab.querySelector('.heading .lead'), null, 'no paragraph under the title');
    assert.deepEqual(page.$$('.history-row').map((node) => node.querySelector('.history-status')?.textContent ?? null),
      ['Pending', 'Pending', 'Pending', 'Pending', 'Failed', 'Not found', null, 'Unverified']);
    assert.deepEqual(page.$$('.history-row .history-status').map((node) => node.className.replace('history-status history-status-', '')),
      ['warn', 'warn', 'warn', 'warn', 'danger', 'danger', 'muted']);
    assert.equal(page.$$('.history-row .badge').length, 0, 'no pill in a row');
    assert.deepEqual(page.$$('.history-row .history-action').map((node) => node.className.replace('history-action history-action-', '')),
      ['sent', 'sent', 'sent', 'sent', 'failed', 'failed', 'sent', 'sent']);
    assert.deepEqual(page.$$('.history li').map((node) => node.className).slice(4, 6), ['history-out history-failed', 'history-out history-failed']);
    assert.doesNotMatch(tab.textContent,
      /explorer|In a block|Not verified|No longer resent|Not applied|Outcome unknown|Refused by a node|two QNet nodes|which the wallet verifies/);
    assert.equal(tab.querySelectorAll('.notice').length, 0);
    // every row opens its detail (owner, 06.10); the explorer link is there, for a row with a hash
    assert.equal(page.$$('[data-action="open-detail"]').length, 8);
    assert.equal(page.$$('.history-row').length, 8);
    page.$$('[data-action="open-detail"]')[6].click();
    await page.settle();
    assert.equal(page.$('.history-detail .badge').textContent, 'Confirmed');
    assert.equal(page.$('.history-detail .badge').className, 'badge badge-ok');
  });

  it('an empty history says "No transactions yet"', async () => {
    await openWallet();
    await page.click('[data-tab="history"]');
    assert.equal(page.$('.tab-body .message').textContent, 'No transactions yet');
    await page.click('.network-switch [data-value="solana"]');
    await page.settle();
    assert.equal(page.$('.tab-body .message').textContent, 'No transactions yet', 'Solana: its own list, empty');
    assert.equal(page.$('[data-action="explorer"]'), null, 'no explorer button: a row opens its transaction');
  });
});

describe('popup: activate', () => {
  it('burns at the worker price after its one confirmation line, with no password; the tab then holds no code, Settings does', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_750_000_000_000 });
    let burnParams = null;
    let finishBurn = null;
    let burned = false;
    const burning = new Promise((resolve) => {
      finishBurn = resolve;
    });
    await openWallet({
      'activation.burn': async (params) => {
        burnParams = params;
        await burning;
        burned = true;
        return { status: 'finalized', code: CODE, activation: activationRecord('light') };
      },
      'activation.status': () => ({ activation: burned ? activationRecord('light') : null, pending: null, busy: false }),
      'activation.copy': () => ({ code: CODE }),
    });
    await page.click('[data-tab="activate"]');
    assert.match(page.text(), /1500 1DEV/);
    assert.match(page.text(), /3000 1DEV/);
    await page.click('[data-action="choose-light"]');
    const text = page.text();
    // the burn is irreversible: one confirmation line, the acknowledgement, and no warning list (owner, 28.09)
    assert.match(text, /I understand that 1500 1DEV will be destroyed and that this wallet gets exactly one code\./);
    assert.equal(page.$$('.tab-body .notice').length, 0);
    assert.doesNotMatch(text, /Read before you burn|Nobody receives them|cannot be undone or refunded/);
    assert.ok(text.includes(SOLANA.ONE_DEV_MINT));
    assert.ok(text.includes(`SPL Token Burn, program ${core.SOLANA_PROGRAMS.TOKEN}`), 'the burn program (MISS-04)');
    const burn = page.$('[data-action="burn"]');
    // no password: the unlocked session and the acknowledged press (decision 33)
    assert.equal(page.$('.tab-body input[type="password"]'), null);
    assert.equal(burn.disabled, true, 'the acknowledgement is required');
    page.$('input[name="acknowledge"]').click();
    assert.equal(burn.disabled, false);
    page.$('input[name="acknowledge"]').click();
    assert.equal(burn.disabled, true, 'unticked, it is off again');
    page.$('input[name="acknowledge"]').click();
    burn.click();
    fire(burn, 'click');
    await page.settle();
    assert.equal(page.callsOf('activation.burn').length, 1, 'a second click never reaches the worker');
    assert.deepEqual(burnParams, { nodeType: 'light', expectedPrice: 1500 });
    // while it burns: the title, a progress bar and the time, no list of what the wallet does inside (owner, 28.09)
    assert.match(page.text(), /Burning 1500 1DEV/);
    assert.ok(page.$('.progress'));
    assert.equal(page.$('.steps'), null);
    assert.doesNotMatch(page.text(), /simulating|Deriving|no earlier burn|Checking the price/);
    finishBurn();
    await page.settle();
    // no Done button (EXT-F5); owner, 06.10: the light node's record on its way and the one line to aiqnet.io/node, with no
    // code (it is in Settings), burn details, success banner or next step
    assert.equal(page.$('[data-action="done"]'), null);
    assert.equal(page.$('.tab-body h2').textContent, 'Activate a node');
    assert.deepEqual(activateParts(), ['heading', 'record', 'manage']);
    assert.deepEqual(shownLines(), ['Activate a node', ...recordLines('Recording on the QNet network… This usually takes a minute or two.'), MANAGE]);
    assert.deepEqual(shownActions(), []);
    assertOnlyTheLine();
    assertManageLine();
    assert.doesNotMatch(page.text(), /mobile app/);
    // the light node is being recorded on the QNet network: its card shows while the chain does not list it
    assert.ok(shownText().includes(core.lightNodeId(core.KAT.qnetAddress)), 'the light node id');
    assert.equal(page.$('[data-action="record"]'), null, 'no button while the wallet records it on its own');
    assert.equal(page.callsOf('activation.copy').length, 0);
    // the code the burn answered is in Settings, masked until Show
    await page.click('[data-tab="settings"]');
    assert.equal(page.$('.code-box').textContent, MASKED);
    assert.ok(!page.text().includes(CODE));
    await page.click('[data-action="show-code"]');
    assert.equal(page.$('.code-box').textContent, CODE);
    assert.deepEqual(page.callsOf('activation.copy').map((entry) => entry.params), [{}]);
  });

  // Owner, 06.10: a Super code is the same tab as a Light one, less the record (a Super node is never recorded here): the
  // burn, the amount, the server's settings and every server step are on aiqnet.io/node, the line's destination.
  // Owner, 06.10: a Super activation is the same tab as a Light one, less the record (a Super node is never recorded here):
  // the burn, the amount, the server's settings and every server step are on aiqnet.io/node, the line's destination; the
  // code is in Settings.
  it('an existing Super activation shows the manage line only: no code, no burn, no env names or server card', async () => {
    await openWallet({ 'activation.status': () => ({ activation: activationRecord('super'), pending: null, busy: false }) });
    await page.click('[data-tab="activate"]');
    assert.equal(page.$('.tab-body h2').textContent, 'Activate a node');
    assert.deepEqual(activateParts(), ['heading', 'manage']);
    assert.deepEqual(shownLines(), ['Activate a node', MANAGE]);
    assert.deepEqual(shownActions(), []);
    assert.equal(recordCard(), null);
    assertOnlyTheLine();
    assertManageLine();
    assert.equal(page.$('[data-action="choose-light"]'), null, 'one code per wallet: no second burn');
    assert.equal(page.$('[data-action="choose-super"]'), null);
    assert.equal(page.$('[data-action="recover"]'), null);
    assert.equal(page.$('.tab-body input[type="password"]'), null);
    assert.equal(page.callsOf('activation.copy').length, 0);
  });

  // Owner, 06.10: the code is in Settings, beside the recovery phrase and the private key: one plain row with Show and Copy,
  // no warning, no timer and no password (decision 33). Copy copies at once and the clipboard is cleared after
  // TIMINGS.CLIPBOARD_CLEAR_MS, silently; leaving Settings drops the code.
  it('Settings shows the activation code as one plain row: masked, Show and Copy, no warning, no timer, no password', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_750_000_000_000 });
    const SUPER_CODE = 'QNET-SFEFD9-706058-537636';
    let reads = 0;
    await openWallet({
      'activation.status': () => ({ activation: activationRecord('super'), pending: null, busy: false }),
      'activation.copy': () => {
        reads += 1;
        return reads === 1 ? fail('NOT_FOUND') : { code: SUPER_CODE };
      },
    });
    await page.click('[data-tab="settings"]');
    // a section of its own among Settings' sections, right after the recovery phrase and the private key
    const titles = page.$('.settings').children.map((node) => node.querySelector('h3')?.textContent ?? node.className);
    const at = titles.indexOf('Activation code');
    assert.deepEqual(titles.slice(at - 2, at + 1), ['Recovery phrase', 'Private key', 'Activation code'], 'beside the phrase and the key');
    assert.equal(page.$('.settings').children[at].classList.contains('section'), true);
    const section = page.$('.code-row').parentNode;
    assert.deepEqual(shownLines(section), ['Activation code', MASKED, 'Show', 'Copy']);
    assert.deepEqual(shownActions(section), ['show-code', 'copy-code']);
    assert.equal(section.querySelector('.notice'), null, 'no warning');
    assert.equal(page.$('.tab-body input[type="password"]'), null);
    assert.equal(page.callsOf('activation.copy').length, 0, 'the code comes into the page only on request');
    await page.click('[data-action="show-code"]');
    assert.match(page.text(), /Nothing was found for this request/);
    assert.equal(page.$('.code-box').textContent, MASKED);
    await page.click('[data-action="show-code"]');
    assert.equal(page.$('.code-box').textContent, SUPER_CODE);
    assert.ok(page.$('[data-action="show-code"]').classList.contains('hidden'), 'shown: Copy stays');
    mock.timers.tick(TIMINGS.REVEAL_AUTO_HIDE_MS * 2);
    await page.settle();
    assert.equal(page.$('.code-box').textContent, SUPER_CODE, 'no timer hides it');
    assert.doesNotMatch(page.text(), /Hides in/);
    await page.click('[data-action="copy-code"]');
    assert.deepEqual(page.clipboard.writes, [SUPER_CODE], 'copied at once: no warning first');
    assert.equal(page.callsOf('activation.copy').length, 2, 'read once, then kept while Settings is shown');
    assert.doesNotMatch(shownText(section), /clipboard|Before you copy|server/i);
    mock.timers.tick(TIMINGS.CLIPBOARD_CLEAR_MS);
    await page.settle();
    assert.equal(page.clipboard.text, '', 'the clipboard is cleared, silently');
    // leaving Settings drops the code; a Copy alone reads it again and does not show it
    await page.click('[data-tab="assets"]');
    await page.click('[data-tab="settings"]');
    assert.equal(page.$('.code-box').textContent, MASKED);
    assert.ok(!page.text().includes(SUPER_CODE));
    await page.click('[data-action="copy-code"]');
    assert.equal(page.clipboard.text, SUPER_CODE);
    assert.equal(page.$('.code-box').textContent, MASKED, 'Copy alone does not show it');
    assert.equal(page.callsOf('activation.copy').length, 3);
    page.close();
    // a wallet with no code has no such row
    await openWallet();
    await page.click('[data-tab="settings"]');
    assert.equal(page.$('.code-row'), null);
    assert.doesNotMatch(page.text(), /Activation code/);
    assert.equal(page.callsOf('activation.lookup').length, 1);
  });

  // Owner correction 26.09: a light burn aiqnet.io's one-time payment key made for this wallet, found by Recover through
  // the registration record, is this wallet's activation; its burner is the site's payment address. Owner, 06.10: the
  // tab shows its code as any other, with no line that it was paid there (aiqnet.io/node says how the node was activated).
  it('an activation paid on aiqnet.io shows no paid-on-site line and no code; listed on chain, it has no record card', async () => {
    const paid = { ...activationRecord('light'), solanaAddress: SOLANA_RECIPIENT, paidOnSite: true };
    const onchain = { nodeId: core.lightNodeId(core.KAT.qnetAddress), state: 'onchain', attempts: 0, lastError: null, txHash: null, updatedAt: 1, automatic: false };
    await openWallet({
      'activation.status': () => ({ activation: paid, pending: null, busy: false, registration: onchain }),
      'activation.registration': () => ({ registration: onchain }),
    });
    await page.click('[data-tab="activate"]');
    assert.deepEqual(activateParts(), ['heading', 'record:hidden', 'manage']);
    assert.deepEqual(shownLines(), ['Activate a node', MANAGE]);
    assert.deepEqual(shownActions(), []);
    assertOnlyTheLine();
    assertManageLine();
    assert.doesNotMatch(page.text(), /One code per wallet|burned on aiqnet\.io|finish it on aiqnet\.io/);
    assert.doesNotMatch(page.text(), /Burn 1DEV on Solana to get/, 'no invitation to burn once the wallet has its code');
    // the chain lists the node: nothing to record here, and the card is off the screen
    assert.doesNotMatch(shownText(), /QNet network|Recorded on the QNet network/);
    assert.equal(page.$('[data-action="record"]'), null);
    // its code is in Settings like any other
    await page.click('[data-tab="settings"]');
    assert.equal(page.$('.code-box').textContent, MASKED);
  });

  it('shows the light node\'s record on the QNet network and records it with one press when it waits for the user', async () => {
    const view = (state, automatic = false) => ({
      nodeId: core.lightNodeId(core.KAT.qnetAddress), state, attempts: 1, lastError: null, txHash: null, updatedAt: 1, automatic,
    });
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let registration = null;
    const registered = [];
    await openWallet({
      'activation.status': () => ({ activation: activationRecord('light'), pending: null, busy: false, registration }),
      'activation.registration': () => ({ registration }),
      'activation.register': (params) => {
        registered.push(params);
        registration = view('admitted', true);
        return { registration };
      },
    });
    await page.click('[data-tab="activate"]');
    mock.timers.tick(1);
    await page.settle();
    assert.deepEqual(activateParts(), ['heading', 'record', 'manage']);
    assert.deepEqual(shownLines(), ['Activate a node', ...recordLines('Not recorded on the QNet network yet.',
      'Records this wallet’s light node on the QNet network. It costs no fee and burns nothing.', 'Record on the network'), MANAGE]);
    assert.deepEqual(shownActions(), ['record']);
    assert.match(shownText(), /Not recorded on the QNet network yet\./);
    assert.equal(page.callsOf('activation.registration').length, 1, 'an activation without a record is looked up once');
    assert.match(shownText(), /It costs no fee and burns nothing\./);
    assert.equal(page.$('.tab-body input[type="password"]'), null, 'no password (decision 33)');
    await page.click('[data-action="record"]');
    assert.deepEqual(registered, [{}]);
    assert.match(shownText(), /Recording on the QNet network/);
    assert.equal(page.$('[data-action="record"]'), null, 'no button while the wallet records it on its own');
    // read again while it is being recorded, until the chain lists it; then the card goes (owner, 06.10: aiqnet.io/node
    // shows the node) and the manage line stays
    registration = view('onchain');
    mock.timers.tick(TIMINGS.REGISTRATION_POLL_MS);
    await page.settle();
    assert.equal(page.callsOf('activation.registration').length, 2);
    assert.ok(recordCard().classList.contains('hidden'), 'listed on chain: the card is off the screen');
    assert.deepEqual(activateParts(), ['heading', 'record:hidden', 'manage']);
    assert.deepEqual(shownLines(), ['Activate a node', MANAGE]);
    assert.deepEqual(shownActions(), []);
    assert.doesNotMatch(shownText(), /QNet network|Record on the network/);
    assertManageLine();
    mock.timers.tick(TIMINGS.REGISTRATION_POLL_MS * 3);
    await page.settle();
    assert.equal(page.callsOf('activation.registration').length, 2, 'a listed node is not read again');
    page.close();
    // the states the user is shown on the card, which stays while the chain does not list the node (refused, the clock,
    // a retry hours away, the one-node rule, another burn's registration), with Record on the network when it can help
    const deferred = { ...view('queued', true), attempts: 7, deferred: true };
    const states = [
      ['refused', view('refused'), /The QNet network did not accept the record\. Nothing is burned again\. Try again later\./, true],
      ['clock', view('clock'), /This computer’s clock is more than 5 minutes off\./, true],
      // EXT-R1-04 (b): a retry hours away is not "a minute or two": Not recorded, with Record on the network
      ['deferred', deferred, /Not recorded on the QNet network yet\./, true],
      // decision 36: the network's one-node rule refused it (this wallet has a node of either type): said so, and no
      // Record on the network, which would only meet the same refusal
      ['wallet_has_node', { ...view('refused'), lastError: 'wallet_has_node' },
        /The QNet network refused the record: this wallet already has a node\. One wallet, one node\./, false],
      // EXT-R2A-03: listed with another burn's registration: said so, never "Recorded", and no Record on the network
      ['other_burn', view('other_burn'), /recorded on the QNet network with another 1DEV burn\. The burn made here recorded nothing/, false],
    ];
    for (const [state, shown, text, offered] of states) {
      registration = shown;
      await openWallet({
        'activation.status': () => ({ activation: activationRecord('light'), pending: null, busy: false, registration }),
        'activation.registration': () => ({ registration }),
      });
      await page.click('[data-tab="activate"]');
      assert.deepEqual(activateParts(), ['heading', 'record', 'manage'], state);
      assert.deepEqual(shownActions(), offered ? ['record'] : [], state);
      assertOnlyTheLine();
      assert.match(shownText(), text, state);
      assert.doesNotMatch(shownText(), /Recording on the QNet network|Recorded on the QNet network for this wallet/, state);
      assert.equal(page.$('[data-action="record"]') !== null, offered, state);
      assert.equal(page.$$('.tab-body .notice-success').length, 0, `${state}: no success banner`);
      page.close();
    }
    // a Super activation has no record on the QNet network here
    await openWallet({ 'activation.status': () => ({ activation: activationRecord('super'), pending: null, busy: false, registration: null }) });
    await page.click('[data-tab="activate"]');
    assert.equal(recordCard(), null);
    assert.deepEqual(shownLines(), ['Activate a node', MANAGE]);
    assert.doesNotMatch(page.text(), /QNet network/);
    assert.equal(page.callsOf('activation.registration').length, 0);
  });

  // Right after a burn (renderCodeResult) the tab is the overview's: a burn another device beat is named above the record;
  // the light node's record is read at once, then once every REGISTRATION_POLL_MS while it is being recorded, and its
  // reads stop with the view. The code is in Settings.
  it('the screen after a burn: the warning when another device burned first, the record read once per poll, nothing read once the tab is left', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const own = core.base58Encode(new Uint8Array(64).fill(7));
    const recording = {
      nodeId: core.lightNodeId(core.KAT.qnetAddress), state: 'admitted', attempts: 1, lastError: null, txHash: null, updatedAt: 1, automatic: true,
    };
    await openWallet({
      'activation.burn': () => ({
        status: 'finalized', code: CODE, activation: activationRecord('light'),
        superseded: { burnTx: own, nodeType: 'light', burnAmount: 1500, solanaAddress: ADDRESSES.solana, cluster: 'devnet', createdAt: 1 },
      }),
      'activation.registration': () => ({ registration: recording }),
    });
    await page.click('[data-tab="activate"]');
    await page.click('[data-action="choose-light"]');
    page.$('input[name="acknowledge"]').click();
    await page.click('[data-action="burn"]');
    assert.equal(page.$('.tab-body h2').textContent, 'Activate a node');
    assert.deepEqual(activateParts(), ['heading', 'superseded', 'record', 'manage']);
    assert.deepEqual(shownActions(), ['superseded-burn']);
    assertOnlyTheLine();
    assertManageLine();
    assert.match(page.text(), /Another device with this recovery phrase burned first/);
    assert.match(page.text(), /The burn of 1500 1DEV this device sent also went through/);
    await page.click('[data-action="superseded-burn"]');
    assert.ok(page.tabsCreated.at(-1).url.includes(own));
    assert.equal(page.callsOf('activation.registration').length, 0);
    mock.timers.tick(1);
    await page.settle();
    assert.equal(page.callsOf('activation.registration').length, 1, 'read at once');
    assert.deepEqual(shownLines(), ['Activate a node',
      'Another device with this recovery phrase burned first: that burn is this wallet’s activation. The burn of 1500 1DEV this device sent also went through; it gives no second activation code.',
      'Open in Solana Explorer', ...recordLines('Recording on the QNet network… This usually takes a minute or two.'), MANAGE]);
    assert.ok(!page.text().includes(CODE), 'the code the burn answered is not drawn here');
    assert.match(shownText(), /Recording on the QNet network/);
    mock.timers.tick(TIMINGS.REGISTRATION_POLL_MS);
    await page.settle();
    assert.equal(page.callsOf('activation.registration').length, 2, 'one read per poll');
    mock.timers.tick(TIMINGS.REGISTRATION_POLL_MS);
    await page.settle();
    assert.equal(page.callsOf('activation.registration').length, 3, 'one read per poll');
    await page.click('[data-tab="assets"]');
    mock.timers.tick(TIMINGS.REGISTRATION_POLL_MS * 3);
    await page.settle();
    assert.equal(page.callsOf('activation.registration').length, 3, 'no read once the tab is left');
  });

  it('turns activation off when the price is unavailable or phase 2, and when 1DEV is short', async () => {
    await openWallet({ 'activation.price': () => fail('PRICE_UNAVAILABLE') });
    await page.click('[data-tab="activate"]');
    assert.match(page.text(), /activation price is unavailable/);
    assert.equal(page.$('[data-action="choose-light"]'), null);
    page.close();

    await openWallet({ 'activation.price': () => ({ phase: 2, light: { cost: 5000 }, super: { cost: 10000 }, fetchedAt: 1 }) });
    await page.click('[data-tab="activate"]');
    assert.match(page.text(), /not available in this network phase/);
    assert.equal(page.$('[data-action="choose-super"]'), null);
    page.close();

    await openWallet({ 'activation.price': () => ({ phase: 1, light: { cost: 1500 }, super: { cost: 6000 }, fetchedAt: 1 }) });
    await page.click('[data-tab="activate"]');
    assert.equal(page.$('[data-action="choose-light"]').disabled, false);
    assert.equal(page.$('[data-action="choose-super"]').disabled, true);
    assert.match(page.text(), /Not enough 1DEV: this needs 6000 1DEV\./);
  });

  it('a burn refused because the wallet already burned points to Recover, and Recover reports what it found', async () => {
    let recovered = false;
    let recoverCalls = 0;
    await openWallet({
      'activation.burn': () => fail('BURN_EXISTS'),
      'activation.recover': () => {
        recoverCalls += 1;
        if (recoverCalls === 1) return { found: false, complete: false, activation: null };
        recovered = true;
        return { found: true, complete: true, activation: activationRecord('light') };
      },
      'activation.status': () => ({ activation: recovered ? activationRecord('light') : null, pending: null, busy: false }),
    });
    await page.click('[data-tab="activate"]');
    await page.click('[data-action="choose-light"]');
    page.$('input[name="acknowledge"]').click();
    await page.click('[data-action="burn"]');
    assert.match(page.text(), /already burned 1DEV for a node\. Use Recover/);
    await page.click('[data-action="recover"]');
    assert.match(page.text(), /could not be read completely/);
    await page.click('[data-action="recover"]');
    assert.match(page.text(), /code of this wallet’s burn was restored/);
    // the outcome, then the tab as after any burn (the restored code is in Settings)
    assert.deepEqual(activateParts(), ['heading', 'notice-success', 'record', 'manage']);
    assert.deepEqual(shownLines(), ['Activate a node', 'The code of this wallet’s burn was restored.',
      ...recordLines('Not recorded on the QNet network yet.',
        'Records this wallet’s light node on the QNet network. It costs no fee and burns nothing.', 'Record on the network'), MANAGE]);
    assert.deepEqual(shownActions(), ['record']);
    assert.equal(page.$('.code-box'), null);
    assert.equal(page.$('[data-action="recover"]'), null, 'Recover goes once the wallet has its code');
    assertManageLine();
  });

  // EXT-R1-01: the burn asks the QNet network whether the wallet already has a node before anything is signed; a node
  // (a phone-only activation paid on aiqnet.io) points to Recover, and no answer is "nothing burned, try again".
  it('a burn the QNet network cannot clear goes back to the overview with the reason and Recover, never "maybe sent"', async () => {
    for (const [code, text] of [['NODE_EXISTS', /already has a node\. Use Recover my code on the Activate tab/],
      ['NETWORK', /QNet nodes could not be reached/]]) {
      await openWallet({ 'activation.burn': () => fail(code) });
      await page.click('[data-tab="activate"]');
      // Recover is its title and its button, with no paragraph on how it works (owner, 28.09)
      assert.equal(page.$('[data-action="recover"]').textContent, 'Recover my code');
      assert.doesNotMatch(page.text(), /with no fee\. It never burns anything|Price from the QNet nodes/);
      await page.click('[data-action="choose-light"]');
      page.$('input[name="acknowledge"]').click();
      await page.click('[data-action="burn"]');
      assert.match(page.text(), text, code);
      assert.doesNotMatch(page.text(), /If the burn reached Solana/, code);
      assert.ok(page.$('[data-action="choose-light"]'), `${code}: back on the overview`);
      assert.ok(page.$('[data-action="recover"]'), `${code}: Recover is offered`);
      page.close();
    }
  });

  // R4-ESA-01: a burn no code derives from (a Full node, another token account) is still this wallet's burn:
  // the refusal says so, and Recover does not answer "no burn".
  it('a burn no code derives from is named on a new burn and on Recover, never "no burn" (R4-ESA-01)', async () => {
    await openWallet({
      'activation.burn': () => fail('BURN_UNUSABLE'),
      'activation.recover': () => fail('BURN_UNUSABLE'),
    });
    await page.click('[data-tab="activate"]');
    await page.click('[data-action="choose-light"]');
    page.$('input[name="acknowledge"]').click();
    await page.click('[data-action="burn"]');
    assert.match(page.text(), /in a form no QNet app derives a code from/);
    assert.ok(page.$('[data-action="choose-light"]'), 'back on the overview with the reason');
    await page.click('[data-action="recover"]');
    assert.match(page.text(), /in a form no QNet app derives a code from/);
    assert.doesNotMatch(page.text(), /No burn/i);
  });

  // EXT-F2: a burn on its way is read again on its own while the popup is visible; there is no Check again button
  it('a pending burn blocks a new burn and is read again on its own until it settles', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let settled = false;
    await openWallet({
      'activation.status': () => (settled ? { activation: activationRecord('light'), pending: null, busy: false } : {
        activation: null,
        pending: { burnTx: BURN_TX, nodeType: 'light', burnAmount: 1500, solanaAddress: ADDRESSES.solana, cluster: 'devnet', createdAt: 1 },
        busy: false,
      }),
    });
    await page.click('[data-tab="activate"]');
    assert.match(page.text(), /Burn waiting for Solana/);
    assert.match(page.text(), /The wallet checks it again on its own\./);
    assert.equal(page.$('[data-action="check-again"]'), null, 'no Check again button');
    assert.equal(page.$('[data-action="choose-light"]'), null, 'no burn is offered');
    assert.doesNotMatch(page.text(), /Burn 1DEV on Solana to get/, 'no invitation to burn beside a burn on its way');
    assert.equal(page.$('[data-action="recover"]'), null);
    assert.equal(page.callsOf('activation.lookup').length, 1);
    mock.timers.tick(TIMINGS.ACTIVATE_RECHECK_MS);
    await page.settle();
    assert.equal(page.callsOf('activation.lookup').length, 2, 'read again after ACTIVATE_RECHECK_MS');
    assert.match(page.text(), /Burn waiting for Solana/);
    // hidden: no read; shown again: the next tick reads
    page.document.hidden = true;
    mock.timers.tick(TIMINGS.ACTIVATE_RECHECK_MS);
    await page.settle();
    assert.equal(page.callsOf('activation.lookup').length, 2, 'no read while the popup is hidden');
    page.document.hidden = false;
    settled = true;
    mock.timers.tick(TIMINGS.ACTIVATE_RECHECK_MS);
    await page.settle();
    // the settled burn: the tab of a wallet with its code
    assert.deepEqual(activateParts(), ['heading', 'record', 'manage']);
    assert.deepEqual(shownLines(), ['Activate a node', ...recordLines('Not recorded on the QNet network yet.',
      'Records this wallet’s light node on the QNet network. It costs no fee and burns nothing.', 'Record on the network'), MANAGE]);
    assert.deepEqual(shownActions(), ['record']);
    assertOnlyTheLine();
    assertManageLine();
    // an activation is never read again on its own (only the record of its light node is)
    const reads = page.callsOf('activation.lookup').length;
    mock.timers.tick(TIMINGS.ACTIVATE_RECHECK_MS * 3);
    await page.settle();
    assert.equal(page.callsOf('activation.lookup').length, reads);
  });

  it("an 'activation' event refreshes the overview but never interrupts a confirmation", async () => {
    await openWallet();
    await page.click('[data-tab="activate"]');
    page.emit('activation');
    await page.settle();
    assert.equal(page.callsOf('activation.lookup').length, 2);
    await page.click('[data-action="choose-light"]');
    page.emit('activation');
    await page.settle();
    assert.equal(page.callsOf('activation.lookup').length, 2);
    assert.ok(page.$('[data-action="burn"]'));
  });

  // EXT-R4-01: every step of a light registration (the worker's retry alarm) sent an 'activation' event that rebuilt the
  // whole overview: the revealed code was hidden again, and the Record on the network actions were drawn anew.
  it("an 'activation' event over an activation redraws only the record line: the Record button and the line stay (EXT-R4-01)", async () => {
    const view = (state, automatic = false, extra = {}) => ({
      nodeId: core.lightNodeId(core.KAT.qnetAddress), state, attempts: 1, lastError: null, txHash: null, updatedAt: 1, automatic, ...extra,
    });
    let activation = activationRecord('light');
    let registration = view('queued', true, { deferred: true });
    await openWallet({ 'activation.status': () => ({ activation, pending: null, busy: false, registration }) });
    await page.click('[data-tab="activate"]');
    const line = page.$('.tab-body a');
    const record = page.$('[data-action="record"]');
    assert.ok(record, 'deferred: Record on the network is offered');
    const reads = page.callsOf('activation.lookup').length;
    const prices = page.callsOf('activation.price').length;
    const expectKept = (step) => {
      assert.equal(page.$('.tab-body a'), line, `${step}: the overview is not rebuilt`);
      assert.equal(page.callsOf('activation.price').length, prices, `${step}: no rebuild of the overview`);
      assertOnlyTheLine();
    };

    // a step that keeps Record on the network offered: the line changes, the button stays as it is
    registration = view('refused');
    page.emit('activation');
    await page.settle();
    assert.equal(page.callsOf('activation.lookup').length, reads + 1);
    assert.match(page.text(), /did not accept the record/);
    assert.equal(page.$('[data-action="record"]'), record);
    expectKept('refused');

    // queued -> admitted -> onchain: the automatic attempt takes over, then the chain lists the node
    registration = view('admitted', true);
    page.emit('activation');
    await page.settle();
    assert.match(page.text(), /Recording on the QNet network/);
    assert.equal(page.$('[data-action="record"]'), null, 'nothing left to record by hand');
    expectKept('admitted');
    // the chain lists the node: the card goes in place (owner, 06.10)
    const card = recordCard();
    registration = view('onchain');
    page.emit('activation');
    await page.settle();
    assert.equal(recordCard(), card, 'the same card');
    assert.ok(card.classList.contains('hidden'));
    assert.doesNotMatch(shownText(), /QNet network/);
    assert.deepEqual(activateParts(), ['heading', 'record:hidden', 'manage']);
    assert.deepEqual(shownActions(), [], 'the line and nothing else');
    expectKept('onchain');

    // anything else about the activation changed (here its amount, which the tab does not draw): the overview again
    activation = { ...activationRecord('light'), burnAmount: 3000 };
    page.emit('activation');
    await page.settle();
    assert.equal(page.callsOf('activation.price').length, prices + 1);
    assert.doesNotMatch(page.text(), /3000 1DEV/, 'no burn details');
    assert.notEqual(page.$('.tab-body a'), line);
    assert.deepEqual(activateParts(), ['heading', 'record:hidden', 'manage']);
  });

  // EXT-R4-01: the Record on the network button stays while the registration moves on and Record stays offered, and an
  // attempt made from it redraws the actions from its answer.
  it('Record on the network: an attempt redraws the actions from its answer; a refused attempt offers the button again (EXT-R4-01)', async () => {
    const view = (state, automatic = false) => ({
      nodeId: core.lightNodeId(core.KAT.qnetAddress), state, attempts: 1, lastError: null, txHash: null, updatedAt: 1, automatic,
    });
    let registration = view('clock');
    await openWallet({
      'activation.status': () => ({ activation: activationRecord('light'), pending: null, busy: false, registration }),
      'activation.register': () => ({ registration: view('refused') }),
    });
    await page.click('[data-tab="activate"]');
    const pressed = page.$('[data-action="record"]');
    await page.click('[data-action="record"]');
    assert.deepEqual(page.callsOf('activation.register').map((entry) => entry.params), [{}]);
    assert.match(page.text(), /did not accept the record/);
    assert.notEqual(page.$('[data-action="record"]'), pressed, 'the actions are drawn from the answer');
    assert.equal(page.$('[data-action="record"]').disabled, false, 'Record on the network is offered again');
  });
});

describe('popup: settings', () => {
  // Owner, 06.10: after the password the phrase is shown at once, then Copy and Done: no press-and-hold, no timer and no
  // clipboard text.
  it('shows the phrase at once after the password, then Copy and Done: no hold, no timer, no clipboard text', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_750_000_000_000 });
    await openWallet({
      'vault.reveal': ({ password }) => (password === PASSWORD ? { mnemonic: core.KAT.mnemonic } : fail('BAD_PASSWORD')),
    });
    await page.click('[data-tab="settings"]');
    await page.click('[data-action="reveal-phrase"]');
    // one confirmation line before the phrase is revealed (owner, 28.09)
    assert.match(page.text(), /Anyone with these words controls your funds and your node activation\./);
    assert.equal(page.$$('.tab-body .notice').length, 1);
    assert.doesNotMatch(page.text(), /QNet support never asks for them|Before you continue/);
    assert.ok(!page.text().includes('abandon'), 'nothing before the password');
    const password = page.$('input[name="password"]');
    assertHardened(password);
    type(password, 'wrong');
    await page.click('[data-action="reveal"]');
    assert.match(page.text(), /Wrong password/);
    assert.ok(!page.text().includes('abandon'));
    type(page.$('input[name="password"]'), PASSWORD);
    page.$('[data-action="reveal"]').click();
    assert.equal(page.$('input[name="password"]').value, '');
    await page.settle();
    assert.deepEqual(page.callsOf('vault.reveal').map((entry) => entry.params).at(-1), { password: PASSWORD });
    // the words at once, Copy and Done, nothing else
    const words = core.KAT.mnemonic.split(' ').map((word, index) => `${index + 1}. ${word}`).join('\n');
    assert.equal(page.$('.phrase').textContent, words);
    assert.deepEqual(shownLines(), ['Recovery phrase', words, 'Copy', 'Done']);
    assert.deepEqual(shownActions(), ['copy-phrase', 'done']);
    assert.equal(page.$('[data-action="hold-phrase"]'), null, 'no press-and-hold');
    assert.equal(page.$$('.tab-body .notice').length, 0, 'no warning beside the words');
    assert.doesNotMatch(page.text(), /clipboard|Hides in|Hold to show/);
    mock.timers.tick(TIMINGS.REVEAL_AUTO_HIDE_MS * 2);
    await page.settle();
    assert.equal(page.$('.phrase').textContent, words, 'no timer hides it');
    assert.equal(page.clipboard.writes.length, 0, 'nothing reaches the clipboard without the Copy button');
    // Done goes back to Settings and the words leave the page
    await page.click('[data-action="done"]');
    assert.ok(page.$('[data-action="reveal-phrase"]'));
    assert.ok(!page.text().includes('abandon'));
  });

  it('copies the phrase only by its Copy button and clears the clipboard after a minute, silently', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_750_000_000_000 });
    await openWallet({ 'vault.reveal': () => ({ mnemonic: core.KAT.mnemonic }) });
    await page.click('[data-tab="settings"]');
    await page.click('[data-action="reveal-phrase"]');
    assert.doesNotMatch(page.text(), /cannot be copied|Write them on paper/);
    assert.equal(page.$('[data-action="copy-phrase"]'), null, 'no Copy button before the password');
    type(page.$('input[name="password"]'), PASSWORD);
    await page.click('[data-action="reveal"]');
    assert.doesNotMatch(page.text(), /Anyone who can read your clipboard|The clipboard is cleared/);
    assert.deepEqual(page.clipboard.writes, [], 'nothing copied unasked');
    await page.click('[data-action="copy-phrase"]');
    assert.equal(page.clipboard.text, core.KAT.mnemonic, 'the words in one line, as an import takes them');
    assert.match(page.text(), /Recovery phrase copied/);
    mock.timers.tick(59_999);
    assert.equal(page.clipboard.text, core.KAT.mnemonic);
    mock.timers.tick(1);
    await page.settle();
    assert.equal(page.clipboard.text, '', 'cleared after 60 s');
    // the Copy button goes with the screen
    await page.click('[data-action="done"]');
    assert.equal(page.$('[data-action="copy-phrase"]'), null);
  });

  it('a phrase the Copy button put on the clipboard goes with the wallet when it is deleted (R16)', async () => {
    await openWallet({
      'vault.reveal': () => ({ mnemonic: core.KAT.mnemonic }),
      'vault.wipe': () => ({ wiped: true }),
    });
    await page.click('[data-tab="settings"]');
    await page.click('[data-action="reveal-phrase"]');
    type(page.$('input[name="password"]'), PASSWORD);
    await page.click('[data-action="reveal"]');
    await page.click('[data-action="copy-phrase"]');
    assert.equal(page.clipboard.text, core.KAT.mnemonic);
    await page.click('[data-action="done"]');
    await page.click('[data-action="delete-wallet"]');
    type(page.$('input[name="password"]'), PASSWORD);
    type(page.$('input[name="confirm"]'), 'DELETE');
    await page.click('[data-action="confirm-delete"]');
    assert.equal(page.clipboard.text, '');
    assert.equal(page.location.reloads, 1);
  });

  it('deletes the wallet only with DELETE typed exactly and the password', async () => {
    let wiped = null;
    await openWallet({ 'vault.wipe': (params) => { wiped = params; return { wiped: true }; } }, { localStorage: { left: '1' } });
    await page.click('[data-tab="settings"]');
    await page.click('[data-action="delete-wallet"]');
    const wipe = page.$('[data-action="confirm-delete"]');
    type(page.$('input[name="password"]'), PASSWORD);
    type(page.$('input[name="confirm"]'), 'delete');
    assert.equal(wipe.disabled, true);
    type(page.$('input[name="confirm"]'), 'DELETE');
    assert.equal(wipe.disabled, false);
    await page.click('[data-action="confirm-delete"]');
    assert.deepEqual(wiped, { password: PASSWORD, confirm: 'DELETE' });
    assert.deepEqual(page.clipboard.writes, [''], 'clipboard emptied (R16)');
    assert.equal(page.localStorage.length, 0);
    assert.equal(page.location.reloads, 1);
  });

  // Owner, 28.09: the screen is its title and fields; the change says "Password changed." and nothing more.
  it('changes the password with no explanatory paragraph, and says "Password changed."', async () => {
    await openWallet({ 'vault.changePassword': () => ({ changed: true }) });
    await page.click('[data-tab="settings"]');
    await page.click('[data-action="change-password"]');
    assert.equal(page.$('.tab-body .heading .lead'), null);
    assert.doesNotMatch(page.text(), /made earlier still opens with the old password/);
    type(page.$('input[name="password"]'), PASSWORD);
    type(page.$('input[name="new-password"]'), 'a much longer passphrase');
    type(page.$('input[name="confirm-password"]'), 'a much longer passphrase');
    await page.click('[data-action="save-password"]');
    assert.equal(page.$('.toast').textContent, 'Password changed.');
  });

  it('saves the auto-lock choice and disconnects a site; an IDN origin carries a warning', async () => {
    let sites = [
      { origin: 'https://aiqnet.io', originDisplay: 'aiqnet.io', idn: false, grantedAt: 1, chains: ['qnet', 'solana'] },
      { origin: 'https://xn--qnt-9ma.aiqnet.io', originDisplay: 'qnét.aiqnet.io', idn: true, grantedAt: 2, chains: ['qnet', 'solana'] },
    ];
    await openWallet({
      'settings.set': ({ autoLockMinutes }) => ({ autoLockMinutes, language: 'en' }),
      'sites.list': () => ({ sites }),
      'sites.revoke': ({ origin }) => {
        sites = sites.filter((site) => site.origin !== origin);
        return { revoked: true };
      },
    });
    await page.click('[data-tab="settings"]');
    assert.deepEqual(page.$$('.segmented [data-value]').map((node) => node.getAttribute('data-value')).slice(2),
      ['5', '15', '30', '60', 'never']);
    assert.equal(page.$('[data-value="15"]').getAttribute('aria-pressed'), 'true');
    await page.click('[data-value="30"]');
    assert.deepEqual(page.callsOf('settings.set').map((entry) => entry.params), [{ autoLockMinutes: 30 }]);
    assert.equal(page.$('[data-value="30"]').getAttribute('aria-pressed'), 'true');
    // Owner, 28.09: "where is never?" Never is a choice with one short line when chosen
    assert.equal(page.$('[data-value="never"]').textContent, 'Never');
    await page.click('[data-value="never"]');
    assert.deepEqual(page.callsOf('settings.set').at(-1).params, { autoLockMinutes: 'never' });
    assert.equal(page.$('[data-value="never"]').getAttribute('aria-pressed'), 'true');
    assert.equal(page.$('.toast').textContent, 'Auto-lock is off.');
    assert.match(page.text(), /International domain name, shown as https:\/\/xn--qnt-9ma\.aiqnet\.io/);
    await page.click('[data-action="revoke"]');
    assert.deepEqual(page.callsOf('sites.revoke').map((entry) => entry.params), [{ origin: 'https://aiqnet.io' }]);
    assert.equal(page.$$('[data-action="revoke"]').length, 1);
    assert.match(page.text(), /Version3\.1\.0/);
  });

  it('checks a new password locally, then changes it with the current one', async () => {
    let changed = null;
    await openWallet({ 'vault.changePassword': (params) => { changed = params; return { changed: true }; } });
    await page.click('[data-tab="settings"]');
    await page.click('[data-action="change-password"]');
    assertAllInputsHardened(page);
    type(page.$('input[name="password"]'), PASSWORD);
    assert.match(page.text(), /× At least 8 characters/);
    type(page.$('input[name="new-password"]'), 'short');
    type(page.$('input[name="confirm-password"]'), 'short');
    await page.click('[data-action="save-password"]');
    assert.match(page.text(), /The password needs at least 8 characters/);
    type(page.$('input[name="new-password"]'), 'a much longer passphrase');
    type(page.$('input[name="confirm-password"]'), 'a much longer passphrasf');
    await page.click('[data-action="save-password"]');
    assert.match(page.text(), /Passwords do not match/);
    assert.equal(changed, null);
    // 8 characters typed twice, nothing else checked (owner decision of 2026-09-28)
    const current = page.$('input[name="password"]');
    type(page.$('input[name="new-password"]'), '12345678');
    type(page.$('input[name="confirm-password"]'), '12345678');
    assert.match(page.text(), /✓ At least 8 characters/);
    assert.match(page.text(), /✓ Passwords match/);
    await page.click('[data-action="save-password"]');
    assert.deepEqual(changed, { password: PASSWORD, newPassword: '12345678' });
    assert.equal(current.value, '');
    assert.ok(page.$('[data-action="reveal-phrase"]'), 'back on the settings list');
  });
});

describe('popup: round 5 notices', () => {
  // R5-EXTQ-02: the worker replaces a refused transfer by default; the review says which one, and why only one applies.
  it('the review names the refused transfer the new one takes the place of (R5-EXTQ-02)', async () => {
    const outstanding = [{ nonce: '4', to: RECIPIENT, amountNano: '1500000000', feeNano: '31500', createdAt: 1, stale: false, refused: true }];
    let sent = null;
    await openWallet({
      'qnet.preview': (params) => ({
        from: ADDRESSES.qnet, to: params.to, amountNano: '1500000000', feeNano: '31500', totalNano: '1500031500',
        nonce: '4', balanceNano: '10999968500', verified: true, verification: 'proof', outstanding, replacesNonce: '4',
        recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true, recentSame: false },
      }),
      'qnet.send': (params) => {
        sent = params;
        return { txHash: null, status: 'submitted', nonce: '4', from: ADDRESSES.qnet };
      },
    });
    await page.click('[data-tab="send"]');
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '1.5');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /A node refused your earlier transfer of 1\.5 QNC to 5fce39…27531f \(nonce 4\), but it may still go through/);
    await page.click('[data-action="confirm-send"]');
    assert.deepEqual(sent, { to: RECIPIENT, amount: '1.5', expectedFeeNano: '31500', expectedNonce: '4' });
  });

  // XP-R5-03: this device's own burn that another device's older burn beat is named on the Activate tab.
  it('the Activate tab names this device\'s burn that another device\'s older burn beat (XP-R5-03)', async () => {
    const own = core.base58Encode(new Uint8Array(64).fill(7));
    await openWallet({
      'activation.status': () => ({
        activation: activationRecord('light'), pending: null, busy: false,
        superseded: { burnTx: own, nodeType: 'light', burnAmount: 1500, solanaAddress: ADDRESSES.solana, cluster: 'devnet', createdAt: 1 },
      }),
    });
    await page.click('[data-tab="activate"]');
    // the warning below the manage line, the one part another burn brings (owner, 06.10)
    assert.deepEqual(activateParts(), ['heading', 'record', 'manage', 'superseded']);
    assert.deepEqual(shownActions(), ['record', 'superseded-burn']);
    assertOnlyTheLine();
    assert.match(page.text(), /Another device with this recovery phrase burned first/);
    assert.match(page.text(), /The burn of 1500 1DEV this device sent also went through/);
    await page.click('[data-action="superseded-burn"]');
    assert.ok(page.tabsCreated.at(-1).url.includes(own));
  });
});

// Owner, 29.09: no Refresh button. The balances, the token list and the history on screen read themselves again when
// their view opens, every TIMINGS.POPUP_REFRESH_MS while the popup is visible (paused while it is hidden), on the
// worker's 'balance' event (a site's send, activation or claim finished) and on a network change; one read at a time.
describe('popup: balances and history read themselves again', () => {
  const qncBalance = (balanceNano) => ({ balanceNano, nonce: '3', verified: true, verification: 'proof', blockHeight: 1234 });
  // a few event-loop turns, for a read that is still out (page.settle waits for none to be)
  const turns = async (count = 10) => {
    for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it('Assets has no Refresh button; its balances are read every 15 s while visible, none while hidden, and the network switch reads the other', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    let balance = '12500000000';
    await openWallet({ 'qnet.balance': () => qncBalance(balance) });
    assert.equal(page.$('[data-action="refresh"]'), null);
    assert.deepEqual(page.$$('.tab-body .actions button').map((node) => node.getAttribute('data-action')), ['go-send', 'go-receive']);
    assert.equal(page.callsOf('qnet.balance').length, 1, 'read once when the popup opens');
    const account = page.$('.card.account');
    const card = page.$('.token-row').parentNode;

    balance = '20000000000';
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS - 1);
    await page.settle();
    assert.equal(page.callsOf('qnet.balance').length, 1);
    mock.timers.tick(1);
    await page.settle();
    assert.equal(page.callsOf('qnet.balance').length, 2);
    assert.match(page.$('.token-amount').textContent, /^20 QNC$/);
    assert.equal(page.$('.card.account'), account, 'the address card stays');
    assert.equal(page.$('.token-row').parentNode, card, 'the token card is filled again, not replaced');
    // the same balance again: nothing is redrawn
    const row = page.$('.token-row');
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await page.settle();
    assert.equal(page.callsOf('qnet.balance').length, 3);
    assert.equal(page.$('.token-row'), row);

    // hidden: no read; shown again: one read at once, then every 15 s again
    page.document.hidden = true;
    page.document.visibilityState = 'hidden';
    fire(page.document, 'visibilitychange');
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS * 4);
    await page.settle();
    assert.equal(page.callsOf('qnet.balance').length, 3);
    balance = '1000000000';
    page.document.hidden = false;
    page.document.visibilityState = 'visible';
    fire(page.document, 'visibilitychange');
    await page.settle();
    assert.equal(page.callsOf('qnet.balance').length, 4);
    assert.match(page.$('.token-amount').textContent, /^1 QNC$/);
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await page.settle();
    assert.equal(page.callsOf('qnet.balance').length, 5);

    // the other network's balances were read after the open (owner, 04.10): the switch shows them at once, reads them
    // once more behind them, and the ticks follow it
    assert.equal(page.callsOf('solana.balances').length, 1, 'read in the background after the open');
    await page.click('.network-switch [data-value="solana"]');
    assert.match(page.$('.tab-body').textContent, /2 SOL/, 'drawn at once from what was read');
    await page.settle();
    assert.equal(page.callsOf('solana.balances').length, 2);
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await page.settle();
    assert.equal(page.callsOf('solana.balances').length, 3);
    assert.equal(page.callsOf('qnet.balance').length, 5);
    // a tab without balances reads nothing
    await page.click('[data-tab="receive"]');
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS * 2);
    await page.settle();
    assert.equal(page.callsOf('solana.balances').length, 3);
  });

  it('a tick while a read is out is skipped; a \'balance\' event from the worker reads once more right after it', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    let hold = null;
    let release = null;
    await openWallet({
      'qnet.balance': () => (hold ? hold : qncBalance('12500000000')),
    });
    hold = new Promise((resolve) => {
      release = () => resolve(qncBalance('30000000000'));
    });
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await turns();
    assert.equal(page.callsOf('qnet.balance').length, 2, 'the tick read starts');
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    page.emit('balance');
    await turns();
    assert.equal(page.callsOf('qnet.balance').length, 2, 'no second read while one is out');
    hold = null;
    release();
    await page.settle();
    assert.equal(page.callsOf('qnet.balance').length, 3, 'the event read once after it, the skipped tick none');
    assert.match(page.$('.token-amount').textContent, /^12\.5 QNC$/);
    page.emit('balance');
    await page.settle();
    assert.equal(page.callsOf('qnet.balance').length, 4, 'while the wallet is shown, an event reads at once');
  });

  it('a first read that failed shows Retry until a later read succeeds', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    let down = true;
    await openWallet({ 'qnet.balance': () => (down ? fail('NETWORK') : qncBalance('12500000000')) });
    assert.ok(page.$('[data-action="retry"]'));
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await page.settle();
    assert.ok(page.$('[data-action="retry"]'), 'a failed read keeps what is shown');
    down = false;
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await page.settle();
    assert.equal(page.$('[data-action="retry"]'), null);
    assert.match(page.$('.token-amount').textContent, /^12\.5 QNC$/);
  });

  it('the send form reads what is available again while it is shown', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    let spendable = '12500000000';
    await openWallet({ 'qnet.balance': () => ({ ...qncBalance('12500000000'), spendableNano: spendable }) });
    await page.click('[data-tab="send"]');
    assert.equal(page.$('.tab-body .hint').textContent, 'Available: 12.5 QNC');
    type(page.$('input[name="amount"]'), '1');
    spendable = '2000000000';
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await page.settle();
    assert.equal(page.$('.tab-body .hint').textContent, 'Available: 2 QNC');
    assert.equal(page.$('input[name="amount"]').value, '1', 'what is typed stays');
  });

  it('History reads the rows listed so far again in one request, redraws only a change, and stops past 50 rows', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const item = (n) => ({
      hash: `h${n}`, direction: 'in', from: RECIPIENT, to: ADDRESSES.qnet, amountNano: '1000000000', feeNano: '0',
      timestamp: 1_700_000_000_000 - n, status: 'included',
    });
    let all = Array.from({ length: 25 }, (_, n) => item(n));
    const pageOf = (from, limit) => {
      const items = all.slice(from, from + limit);
      return { items, cursor: all.length > from + limit ? `c${from + limit}` : null, pending: [] };
    };
    await openWallet({
      'qnet.history': ({ cursor, limit }) => pageOf(cursor === undefined ? 0 : Number(cursor.slice(1)), limit),
    });
    await page.click('[data-tab="history"]');
    assert.equal(page.$$('.history-row').length, 20);
    await page.click('[data-action="more"]');
    assert.equal(page.$$('.history-row').length, 25);
    const first = page.$('.history-row');
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await page.settle();
    // the first page read after the open, read again when the tab shows it, More, then the rows listed so far
    assert.deepEqual(page.callsOf('qnet.history').map((entry) => entry.params),
      [{ limit: 20 }, { limit: 20 }, { cursor: 'c20', limit: 20 }, { limit: 40 }]);
    assert.equal(page.$('.history-row'), first, 'the same rows: nothing redrawn');
    // a new transfer arrives
    all = [item(-1), ...all];
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await page.settle();
    assert.equal(page.$$('.history-row').length, 26);
    assert.ok(page.$('[data-action="more"]').classList.contains('hidden'));
    // paged past one request's worth of rows: the list stays as paged (the tab opens again on the 26 rows it last
    // listed, read again at once, and two More add 40)
    all = Array.from({ length: 90 }, (_, n) => item(n));
    await page.click('[data-tab="assets"]');
    await page.click('[data-tab="history"]');
    assert.equal(page.$$('.history-row').length, 26);
    await page.click('[data-action="more"]');
    await page.click('[data-action="more"]');
    assert.equal(page.$$('.history-row').length, 66);
    const reads = page.callsOf('qnet.history').length;
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS * 2);
    await page.settle();
    assert.equal(page.callsOf('qnet.history').length, reads);
  });

  it('History paged to its end keeps reading its rows while they fit one request, and stops once they do not', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const item = (n) => ({
      hash: `h${n}`, direction: 'in', from: RECIPIENT, to: ADDRESSES.qnet, amountNano: '1000000000', feeNano: '0',
      timestamp: 1_700_000_000_000 - n, status: 'included',
    });
    let all = Array.from({ length: 45 }, (_, n) => item(n));
    const pageOf = (from, limit) => {
      const items = all.slice(from, from + limit);
      return { items, cursor: all.length > from + limit ? `c${from + limit}` : null, pending: [] };
    };
    await openWallet({
      'qnet.history': ({ cursor, limit }) => pageOf(cursor === undefined ? 0 : Number(cursor.slice(1)), limit),
    });
    await page.click('[data-tab="history"]');
    await page.click('[data-action="more"]');
    await page.click('[data-action="more"]');
    assert.equal(page.$$('.history-row').length, 45);
    assert.ok(page.$('[data-action="more"]').classList.contains('hidden'));
    // 45 rows (the last More asked for 20 and got 5): one request of 50 reads them all
    all = [item(-1), ...all];
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS);
    await page.settle();
    assert.deepEqual(page.callsOf('qnet.history').at(-1).params, { limit: LIMITS.HISTORY_PAGE_MAX });
    assert.equal(page.$$('.history-row').length, 46);

    // 55 rows paged to their end: more than one request holds, so the list stays as paged
    all = Array.from({ length: 55 }, (_, n) => item(n));
    await page.click('[data-tab="assets"]');
    await page.click('[data-tab="history"]');
    await page.click('[data-action="more"]');
    await page.click('[data-action="more"]');
    assert.equal(page.$$('.history-row').length, 55);
    const reads = page.callsOf('qnet.history').length;
    mock.timers.tick(TIMINGS.POPUP_REFRESH_MS * 2);
    await page.settle();
    assert.equal(page.callsOf('qnet.history').length, reads);
    assert.equal(page.$$('.history-row').length, 55);
  });
});

// Decision 35 and EXT-F1/F2: the Activate tab reads activation.lookup (the vault, aiqnet.io's record, the QNet network and
// the search of the wallet's own address) and offers the Get code cards only when every source said "none".
describe('popup: activate, one code per wallet (decision 35)', () => {
  const view = (name, extra = {}) => lookupOf({}, { view: name, ...extra });
  const PAID = Object.freeze({
    state: 'recorded', nodeType: 'light', way: 'payment', burnTx: BURN_TX, burnAmount: 1500, until: null, paidOnSite: true,
    codeMasked: MASKED, createdAt: 1_700_000_000_000,
  });

  it('while the wallet is checked there are no price cards; the tab reads again on its own and offers them once every source said none', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let current = view('checking', { search: 'searching' });
    await openWallet({ 'activation.lookup': () => current });
    await page.click('[data-tab="activate"]');
    assert.match(page.text(), /Checking this wallet: the QNet network, Solana and aiqnet\.io…/);
    for (const action of ['choose-light', 'choose-super', 'recover', 'check-again']) assert.equal(page.$(`[data-action="${action}"]`), null, action);
    assert.doesNotMatch(page.text(), /1500 1DEV|3000 1DEV/);
    assert.doesNotMatch(page.text(), /Burn 1DEV on Solana to get/, 'no invitation to burn while the wallet is checked');
    current = view('none');
    mock.timers.tick(TIMINGS.ACTIVATE_RECHECK_MS);
    await page.settle();
    assert.equal(page.callsOf('activation.lookup').length, 2);
    assert.ok(page.$('[data-action="choose-light"]'));
    assert.ok(page.$('[data-action="choose-super"]'), 'a Light or a Super code, chosen once');
    // where each node runs: a Light node in QNet Wallet on a phone or tablet, a Super node only on a server (decision 36)
    assert.match(page.text(), /Runs in QNet Wallet on a phone or tablet\./);
    assert.match(page.text(), /Runs on your own server with the QNet node software\./);
    assert.match(page.text(), /Burn 1DEV on Solana to get this wallet’s node activation code\./);
    // none: no more reads
    mock.timers.tick(TIMINGS.ACTIVATE_RECHECK_MS * 3);
    await page.settle();
    assert.equal(page.callsOf('activation.lookup').length, 2);
  });

  // decision 36: a payment address's burn waits for nothing once final (it is recorded for good), so an activation
  // elsewhere is a reservation or a burn on its way, of either way
  it('an activation starting elsewhere, from this extension or a payment address, is said so, with no cards, and read again', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const elsewhere = /An activation of this wallet is starting in another browser, on another device or through a one-time payment address on aiqnet\.io\./;
    for (const [state, text] of [['reserved', elsewhere], ['sending', elsewhere]]) {
      if (page) page.close();
      await openWallet({ 'activation.lookup': () => view('elsewhere', { record: { ...PAID, state, codeMasked: null, createdAt: null } }) });
      await page.click('[data-tab="activate"]');
      assert.match(page.text(), text, state);
      assert.equal(page.$('[data-action="choose-light"]'), null, state);
      assert.doesNotMatch(page.text(), /Burn 1DEV on Solana to get/, `${state}: no invitation to burn`);
      mock.timers.tick(TIMINGS.ACTIVATE_RECHECK_MS);
      await page.settle();
      assert.equal(page.callsOf('activation.lookup').length, 2, `${state}: read again`);
    }
  });

  it('a node the network knows with no code here: said so with Recover; a burn no code derives from: said so; no cards either way', async () => {
    await openWallet({ 'activation.lookup': () => view('node', { network: 'exists' }) });
    await page.click('[data-tab="activate"]');
    // its warning and Recover, nothing else
    assert.deepEqual(activateParts(), ['heading', 'notice-warn', 'recover']);
    assert.deepEqual(shownLines(), ['Activate a node',
      'This wallet already has a node on the QNet network. Recover my code below looks for its code.', 'Already burned?', 'Recover my code']);
    assert.deepEqual(shownActions(), ['recover']);
    assert.match(page.text(), /This wallet already has a node on the QNet network\. Recover my code below looks for its code\./);
    assert.equal(page.$('[data-action="recover"]').textContent, 'Recover my code');
    assert.equal(page.$('[data-action="choose-light"]'), null);
    assert.doesNotMatch(page.text(), /Burn 1DEV on Solana to get/, 'no invitation to burn beside a node');
    page.close();
    await openWallet({ 'activation.lookup': () => view('unusable', { search: 'unusable' }) });
    await page.click('[data-tab="activate"]');
    assert.match(page.text(), /in a form no QNet app derives a code from/);
    assert.equal(page.$('[data-action="choose-light"]'), null);
    assert.equal(page.$('[data-action="recover"]'), null);
  });

  it('a source that cannot answer is named, with Retry and no cards', async () => {
    for (const [reason, text] of [['RECORD_UNAVAILABLE', /aiqnet\.io could not be reached, so it could not confirm that this wallet has no burn\./],
      ['NETWORK', /The QNet nodes could not be reached\./], ['SOLANA_UNAVAILABLE', /Solana could not be read\./],
      ['HISTORY_TOO_LONG', /too long to search in one go/]]) {
      let reads = 0;
      if (page) page.close();
      await openWallet({
        'activation.lookup': () => {
          reads += 1;
          return reads === 1 ? view('unavailable', { reason }) : view('none');
        },
      });
      await page.click('[data-tab="activate"]');
      assert.match(page.text(), text, reason);
      assert.equal(page.$('[data-action="choose-light"]'), null, reason);
      assert.doesNotMatch(page.text(), /Burn 1DEV on Solana to get/, `${reason}: no invitation to burn`);
      await page.click('[data-action="retry"]');
      assert.ok(page.$('[data-action="choose-light"]'), `${reason}: Retry reads again`);
    }
  });

  // Owner, 06.10: a code aiqnet.io's record holds for this wallet shows as the vault's does: masked with one press to show
  // it and the manage line; no paid-on-site line, no burn details and no record card (the vault records nothing of it).
  it('aiqnet.io\'s record of a payment burn is this wallet\'s code: the tab has the manage line only, Settings the code', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_750_000_000_000 });
    let copies = 0;
    await openWallet({
      'activation.lookup': () => view('record', { record: PAID }),
      'activation.copy': () => {
        copies += 1;
        return { code: CODE };
      },
    });
    await page.click('[data-tab="activate"]');
    assert.deepEqual(activateParts(), ['heading', 'manage']);
    assert.deepEqual(shownLines(), ['Activate a node', MANAGE]);
    assert.deepEqual(shownActions(), []);
    assertOnlyTheLine();
    assertManageLine();
    assert.doesNotMatch(page.text(), /burned on aiqnet\.io|belongs to this wallet/);
    assert.doesNotMatch(page.text(), /Burn 1DEV on Solana to get/);
    assert.equal(page.$('[data-action="choose-light"]'), null);
    assert.equal(page.$('[data-action="recover"]'), null);
    assert.equal(page.$('.tab-body input[type="password"]'), null);
    // Settings: the record's code, masked, one press shows it
    await page.click('[data-tab="settings"]');
    assert.equal(page.$('.code-box').textContent, MASKED);
    assert.equal(copies, 0, 'the code comes into the page only on request');
    await page.click('[data-action="show-code"]');
    assert.equal(copies, 1);
    assert.deepEqual(page.callsOf('activation.copy').map((entry) => entry.params), [{}]);
    assert.equal(page.$('.code-box').textContent, CODE);
    page.close();
    // the vault's own burn that aiqnet.io's record of another burn beat: named below the line, it gives no second code
    await openWallet({
      'activation.lookup': () => view('record', {
        record: PAID, keptBurn: { burnTx: core.KAT.activation.burnTx, nodeType: 'light', burnAmount: 1200, solanaAddress: ADDRESSES.solana, cluster: 'devnet', createdAt: 1 },
      }),
    });
    await page.click('[data-tab="activate"]');
    assert.deepEqual(activateParts(), ['heading', 'manage', 'kept-burn']);
    assert.deepEqual(shownLines(), ['Activate a node', MANAGE,
      'aiqnet.io keeps another burn of this wallet as its activation: its code is the one in Settings. The burn of 1200 1DEV this extension keeps gives no second activation code.',
      'Open in Solana Explorer']);
    assert.deepEqual(shownActions(), ['kept-burn']);
    assertOnlyTheLine();
    await page.click('[data-action="kept-burn"]');
    assert.deepEqual(page.tabsCreated.at(-1), { url: `https://explorer.solana.com/tx/${core.KAT.activation.burnTx}?cluster=devnet` });
    page.close();
    // a Super code aiqnet.io's record keeps: the same tab
    await openWallet({
      'activation.lookup': () => view('record', { record: { ...PAID, nodeType: 'super', way: 'extension', paidOnSite: false } }),
      'activation.copy': () => ({ code: 'QNET-SFEFD9-706058-537636' }),
    });
    await page.click('[data-tab="activate"]');
    assert.deepEqual(activateParts(), ['heading', 'manage']);
    assert.deepEqual(shownLines(), ['Activate a node', MANAGE]);
    assert.deepEqual(shownActions(), []);
    assertOnlyTheLine();
    await page.click('[data-tab="settings"]');
    await page.click('[data-action="copy-code"]');
    assert.equal(page.clipboard.text, 'QNET-SFEFD9-706058-537636', 'copied at once, no warning');
    assert.doesNotMatch(page.text(), /start nothing alone|burn’s receipt/);
    mock.timers.tick(TIMINGS.CLIPBOARD_CLEAR_MS);
    await page.settle();
    assert.equal(page.clipboard.text, '', 'and cleared, silently');
  });

  it('a burn aiqnet.io refuses, or holds elsewhere, goes back to the overview with the reason, never "maybe sent"', async () => {
    for (const [code, text] of [['ACTIVATION_RECORDED', /aiqnet\.io holds its burn/], ['ACTIVATION_RESERVED', /starting in another browser/],
      ['RECORD_UNAVAILABLE', /aiqnet\.io could not be reached/]]) {
      if (page) page.close();
      await openWallet({ 'activation.burn': () => fail(code) });
      await page.click('[data-tab="activate"]');
      await page.click('[data-action="choose-light"]');
      page.$('input[name="acknowledge"]').click();
      await page.click('[data-action="burn"]');
      assert.match(page.text(), text, code);
      assert.doesNotMatch(page.text(), /If the burn reached Solana/, code);
      assert.equal(page.callsOf('activation.lookup').length, 2, `${code}: the overview read again`);
    }
  });
});

// Owner, 04.10: QNet and Solana each list their own history, as the balances are apart; a row is one line whatever the
// amount, with the asset's own icon, and the row itself opens the transaction in its explorer.
describe('popup: the two histories (owner, 04.10)', () => {
  const SIG = (n) => core.base58Encode(new Uint8Array(64).fill(n));
  const solRow = (n, extra = {}) => ({
    signature: SIG(n), asset: 'sol', direction: 'in', counterparty: SOLANA_RECIPIENT, amountRaw: '2000000000', feeLamports: null,
    timestamp: 1_700_000_000_000, status: 'confirmed', burn: false, ...extra,
  });

  it('Solana: its own rows with the SOL and 1DEV icons, a burn named as one, More with the cursor, a row opens Solana Explorer', async () => {
    await openWallet({
      'solana.history': ({ cursor }) => (cursor === undefined
        ? { items: [solRow(1), solRow(2, { asset: '1dev', direction: 'out', amountRaw: '1500000000', burn: true, counterparty: null })], cursor: 'next' }
        : { items: [solRow(3, { direction: 'out', status: 'failed' })], cursor: null }),
    });
    await page.click('.network-switch [data-value="solana"]');
    await page.click('[data-tab="history"]');
    await page.settle();
    assert.deepEqual(page.$$('.history-row .row-title').map((node) => node.textContent), ['Received', 'Burned']);
    assert.deepEqual(page.$$('.history-row .amount').map((node) => node.textContent), ['+2 SOL', '−1,500 1DEV']);
    assert.deepEqual(page.$$('.history-row .history-icon').map((node) => node.getAttribute('src')), ['../icons/sol-token.png', '../icons/1dev-token.png']);
    assert.equal(page.callsOf('qnet.history').filter((entry) => entry.params.cursor !== undefined).length, 0, 'no QNet rows here');
    await page.click('[data-action="more"]');
    assert.deepEqual(page.callsOf('solana.history').at(-1).params, { cursor: 'next', limit: 10 });
    // a confirmed row says no state; the failed send says Failed and carries the failed mark (owner, 06.10)
    assert.deepEqual(page.$$('.history-row').map((node) => node.querySelector('.history-status')?.textContent ?? null), [null, null, 'Failed']);
    assert.deepEqual(page.$$('.history-row .history-action').map((node) => node.className.replace('history-action history-action-', '')),
      ['received', 'burn', 'failed']);
    assert.ok(page.$('[data-action="more"]').classList.contains('hidden'));
    // no View button: the row opens its detail, where Solana Explorer is (owner, 06.10)
    assert.equal(page.$$('.tab-body button').filter((node) => node.textContent === 'View').length, 0);
    await page.click('[data-action="open-detail"]');
    await page.click('.history-detail [data-action="explorer"]');
    assert.deepEqual(page.tabsCreated.at(-1), { url: `https://explorer.solana.com/tx/${SIG(1)}?cluster=devnet` });
    await page.click('.history-detail [data-action="back"]');
    // back on QNet: the QNet list, with the QNC icon
    await page.click('.network-switch [data-value="qnet"]');
    await page.settle();
    assert.equal(page.$('.tab-body .message').textContent, 'No transactions yet');
  });

  // Owner, 06.10: a row writes its amount as the app does (compactly, never scaled, at most half the row); its detail
  // gives the exact figure.
  it('QNet: a row says what happened beside its amount written compactly, with the QNC icon, whatever the amount', async () => {
    const huge = { hash: 'h1', direction: 'in', from: RECIPIENT, to: ADDRESSES.qnet, amountNano: '18446744073709551615', feeNano: '0',
      timestamp: 1_700_000_000_000, status: 'included' };
    await openWallet({ 'qnet.history': () => ({ items: [huge], cursor: null, pending: [] }) });
    await page.click('[data-tab="history"]');
    const row = page.$('.history-row');
    assert.equal(row.querySelector('.history-main .row-title').textContent, 'Received');
    assert.deepEqual([...row.querySelector('.amount').children].map((node) => [node.className, node.textContent]),
      [['amount-number', '+18.45B'], ['amount-symbol', 'QNC']]);
    assert.ok(row.querySelector('.amount').parentNode === row, 'the amount is a column of the row, after what happened');
    assert.equal(page.$('.history-row .history-icon').getAttribute('src'), '../icons/qnc-token.png');
    await page.click('[data-action="open-detail"]');
    assert.equal(page.$('.history-detail .detail-amount').textContent, '+18446744073.709551615 QNC');
    await page.click('.history-detail [data-action="explorer"]');
    assert.deepEqual(page.tabsCreated.at(-1), { url: 'https://aiqnet.io/explorer/tx/h1' });
  });
});

// Owner, 04.10: switching QNet and Solana was slow. What this session read last shows at once (the worker's view cache
// when the popup opens), is read again behind it, and the other network is read in the background after an open.
describe('popup: what was read shows at once (owner, 04.10)', () => {
  it('draws the cached balances and history at once, reads them again behind, and reads the other network after the open', async () => {
    let release = null;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    await openWallet({
      'wallet.cached': () => ({
        qnetBalance: { balanceNano: '7000000000', nonce: '1', verified: true, verification: 'proof', blockHeight: 5 },
        qnetHistory: null,
        solanaBalances: null,
        solanaHistory: { items: [{ signature: core.base58Encode(new Uint8Array(64).fill(4)), asset: 'sol', direction: 'in', counterparty: null,
          amountRaw: '1000000000', feeLamports: null, timestamp: 1_700_000_000_000, status: 'confirmed', burn: false }], cursor: null },
      }),
      'qnet.balance': async () => {
        await slow;
        return { balanceNano: '8000000000', nonce: '1', verified: true, verification: 'proof', blockHeight: 6 };
      },
    });
    assert.match(page.$('.token-amount').textContent, /^7 QNC$/, 'drawn from the cache before the read answers');
    release();
    await page.settle();
    assert.match(page.$('.token-amount').textContent, /^8 QNC$/, 'the read behind it redraws it');
    // the other network and the histories were read in the background after the open
    assert.equal(page.callsOf('solana.balances').length, 1);
    assert.deepEqual(page.callsOf('solana.history').map((entry) => entry.params), [{ limit: 10 }]);
    assert.deepEqual(page.callsOf('qnet.history').map((entry) => entry.params), [{ limit: 20 }]);
    // a switch shows what was read at once
    await page.click('.network-switch [data-value="solana"]');
    assert.match(page.$('.tab-body').textContent, /2 SOL/);
  });

});

// Decision 38: the wallet key unlinks the light node from the device that runs it. Owner, 06.10: that happens on
// aiqnet.io's Device tab (its qnet_unlinkNodeDevice request, signed by this wallet in the approval window); the popup's
// Activate tab neither reads nor shows the device and has no Unlink of its own, and its one line leads to aiqnet.io/node.
// handlers() answers neither node.unlinkView nor node.unlink, so every other test would fail on such a request too.
describe('popup: the light node\'s device (decision 38)', () => {
  const DAY = 1_790_035_200;
  const deviceView = { mode: 'confirm', reason: null, nodeId: core.lightNodeId(ADDRESSES.qnet), platform: 'ios', linkedSince: DAY };
  // a device the network names: the popup still asks nothing about it
  const device = {
    'node.unlinkView': () => deviceView,
    'node.unlink': () => assert.fail('the popup never unlinks the device'),
  };
  const assertNoDevice = (step) => {
    assert.equal(page.callsOf('node.unlinkView').length, 0, `${step}: the device is not read`);
    assert.equal(page.callsOf('node.unlink').length, 0, `${step}: nothing is unlinked`);
    assert.equal(page.$('[data-action="unlink"]'), null, `${step}: no Unlink`);
    assert.doesNotMatch(page.text(), /Device|Linked since|iPhone or iPad|Unlink/, step);
  };

  it('the Activate tab of a light node neither reads nor shows its device and offers no Unlink: the line leads to aiqnet.io/node', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    await openWallet({
      ...device,
      'activation.status': () => ({ activation: activationRecord('light'), pending: null, busy: false, registration: null }),
    });
    await page.click('[data-tab="activate"]');
    mock.timers.tick(1);
    await page.settle();
    assert.deepEqual(activateParts(), ['heading', 'record', 'manage']);
    assertNoDevice('light activation');
    assertManageLine();
    // an 'activation' event redraws the overview without reading the device either
    page.emit('activation');
    await page.settle();
    mock.timers.tick(TIMINGS.REGISTRATION_POLL_MS);
    await page.settle();
    assertNoDevice('after an event');
  });

  it('no view of the tab asks for the device: a Super code, aiqnet.io\'s record, a node, none, a burn just made', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const record = { state: 'recorded', nodeType: 'light', way: 'payment', burnTx: BURN_TX, burnAmount: 1500, until: null, paidOnSite: true, codeMasked: MASKED, createdAt: 1 };
    const views = [
      ['super', lookupOf({ activation: activationRecord('super') })],
      ['record', lookupOf({}, { view: 'record', record })],
      ['node', lookupOf({}, { view: 'node', network: 'exists' })],
      ['none', lookupOf({})],
    ];
    for (const [name, lookup] of views) {
      if (page) page.close();
      await openWallet({ ...device, 'activation.lookup': () => lookup });
      await page.click('[data-tab="activate"]');
      mock.timers.tick(TIMINGS.ACTIVATE_RECHECK_MS);
      await page.settle();
      assertNoDevice(name);
    }
    page.close();
    await openWallet({ ...device, 'activation.burn': () => ({ status: 'finalized', code: CODE, activation: activationRecord('light') }) });
    await page.click('[data-tab="activate"]');
    await page.click('[data-action="choose-light"]');
    page.$('input[name="acknowledge"]').click();
    await page.click('[data-action="burn"]');
    mock.timers.tick(TIMINGS.REGISTRATION_POLL_MS);
    await page.settle();
    assert.deepEqual(activateParts(), ['heading', 'record', 'manage']);
    assertNoDevice('after a burn');
    assertManageLine();
  });
});

// Owner, 06.10: no field takes the cursor on its own, anywhere, the lock screen included (this replaces the 04.10 rule
// that let the lock screen focus its password field). A field is focused only by a click or Tab.
describe('popup: the cursor (owner, 06.10)', () => {
  const browserFocus = (input) => {
    input.focus();
    const event = new FakeEvent('focusin');
    event.target = input;
    page.document.dispatchEvent(event);
  };

  it('no screen focuses a field: the lock screen, a wrong password, Reset wallet, Send, Reveal phrase, Export key', async () => {
    await openWallet({ 'vault.status': () => lockedStatus(), 'vault.unlock': () => fail('BAD_PASSWORD') });
    const password = page.$('input[name="password"]');
    assert.equal(page.document.activeElement, null, 'the lock screen leaves the cursor alone');
    type(password, 'nope');
    await page.click('[data-action="unlock"]');
    assert.match(page.text(), /Wrong password/);
    assert.equal(page.document.activeElement, null, 'a wrong password does not put the cursor back in the field');
    await page.click('[data-action="forgot-password"]');
    assert.equal(page.document.activeElement, null);
    page.close();
    await openWallet();
    for (const [tab, action] of [['send', null], ['settings', 'reveal-phrase'], ['settings', 'export-key']]) {
      await page.click(`[data-tab="${tab}"]`);
      if (action) await page.click(`[data-action="${action}"]`);
      assert.equal(page.document.activeElement, null, `${tab} ${action ?? ''}`);
    }
  });

  it('a focus the browser gives a field before the user did anything is given back; after a click or a key it stays', async () => {
    await openWallet({ 'vault.status': () => lockedStatus() });
    const password = page.$('input[name="password"]');
    browserFocus(password);
    assert.equal(page.document.activeElement, null, 'the first focus the browser gives is refused');
    fire(page.document, 'pointerdown', { button: 0 });
    browserFocus(password);
    assert.equal(page.document.activeElement, password, 'a click into the field focuses it');
  });

  it('no page script calls focus() on anything', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const name of ['popup.js', 'approve.js', 'setup.js', 'kit.js', 'common.js']) {
      const source = await readFile(new URL(`../dist/ui/${name}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /\.focus\(/, name);
      assert.doesNotMatch(source, /autofocus/, name);
    }
  });
});

// Owner, 06.10 (the sandbox round): balances paint at once from the last verified read with a quiet "Updating…", any QNet
// token can be sent, a history row opens its detail, the private key is exported as the phrase is, and the header and the
// tab bar keep a gutter at the edges.
const GOLD = core.qnetAddressFromPublicKey(new Uint8Array(1952).fill(11));
const goldToken = (balanceBase = '7250000') => ({ contract: GOLD, name: 'Gold Coin', symbol: 'GOLD', decimals: 6, balanceBase });
const cachedQnet = (balanceNano) => ({ qnetBalance: { balanceNano, spendableNano: balanceNano, nonce: '1', verified: true, verification: 'proof', blockHeight: null },
  qnetHistory: null, solanaBalances: null, solanaHistory: null, qnetTokens: null });

describe('popup: balances at once (owner, 06.10)', () => {
  it('draws the kept balance with "Updating…" until the read behind it ends; a failed read says the figure is the last one read', async () => {
    let release = null;
    let fails = false;
    await openWallet({
      'wallet.cached': () => cachedQnet('7000000000'),
      'qnet.balance': async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
        if (fails) fail('NETWORK');
        return { balanceNano: '8000000000', spendableNano: '8000000000', nonce: '1', verified: true, verification: 'proof', blockHeight: null };
      },
    });
    assert.match(page.$('.token-amount').textContent, /^7 QNC$/);
    assert.equal(page.$('.asset-status').textContent, 'Updating…');
    release();
    await page.settle();
    assert.match(page.$('.token-amount').textContent, /^8 QNC$/);
    assert.equal(page.$('.asset-status').textContent, '', 'quiet once read');
    page.close();
    fails = true;
    await openWallet({
      'wallet.cached': () => cachedQnet('7000000000'),
      'qnet.balance': async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
        return fail('NETWORK');
      },
    });
    release();
    await page.settle();
    assert.match(page.$('.token-amount').textContent, /^7 QNC$/, 'the last balance stays');
    assert.equal(page.$('.asset-status').textContent, 'Could not update: this is the last balance the wallet read.');
  });

  it('a slow token list never holds the balance back: each is drawn as soon as it is read', async () => {
    let releaseTokens = null;
    await openWallet({
      'wallet.cached': () => cachedQnet('7000000000'),
      'qnet.balance': () => ({ balanceNano: '8000000000', spendableNano: '8000000000', nonce: '1', verified: true, verification: 'proof', blockHeight: null }),
      'qnet.tokens': async () => {
        await new Promise((resolve) => {
          releaseTokens = resolve;
        });
        return { tokens: [goldToken()], complete: true };
      },
    });
    await page.settle();
    assert.match(page.$('.token-amount').textContent, /^8 QNC$/, 'the balance is drawn while the token list is still read');
    assert.equal(page.$('.asset-status').textContent, '');
    assert.deepEqual(page.$$('.token-row .token-name').map((node) => node.textContent), ['QNC']);
    releaseTokens();
    await page.settle();
    assert.deepEqual(page.$$('.token-row .token-name').map((node) => node.textContent), ['QNC', 'GOLD']);
  });

  it('a balance no committee certificate verified yet is said to be not confirmed, never drawn as if it were', async () => {
    await openWallet({
      'qnet.balance': () => ({ balanceNano: '5000000000', spendableNano: '5000000000', nonce: '1', verified: false, verification: 'none', blockHeight: null }),
    });
    assert.match(page.$('.token-amount').textContent, /^5 QNC$/);
    assert.equal(page.$('.asset-status').textContent, 'This balance is not confirmed yet.');
  });

  it('lists the built-in QNet tokens the wallet holds after QNC, by symbol and name, with their balances', async () => {
    await openWallet({ 'qnet.tokens': () => ({ tokens: [goldToken(), { ...goldToken(null), contract: RECIPIENT, symbol: '', name: 'Unread' }], complete: false }) });
    await page.settle();
    assert.deepEqual(page.$$('.token-row .token-name').map((node) => node.textContent), ['QNC', 'GOLD', 'Unread']);
    assert.deepEqual(page.$$('.token-row .token-amount').map((node) => node.textContent), ['12.5 QNC', '7.25 GOLD', '— Unread']);
    assert.equal(page.$$('.token-row .token-letter').map((node) => node.textContent).join(''), 'GU', 'a token has its letter, no image');
    assert.ok(page.callsOf('qnet.tokens').length >= 1);
  });
});

describe('popup: any QNet token can be sent (owner, 06.10)', () => {
  const tokenPreview = (extra = {}) => ({
    kind: 'tokenTransfer', from: ADDRESSES.qnet, contract: GOLD, method: 'transfer', gasLimit: '45093', feeNano: '450930', depositNano: '0',
    totalNano: '450930', nonce: '4', balanceNano: '12500000000', verified: true, verification: 'proof', outstanding: [], replacesNonce: null,
    inFlight: false, to: RECIPIENT, amountBase: '2500000', tokenBalance: '7250000', duplicate: false, token: GOLD, name: 'Gold Coin', symbol: 'GOLD',
    decimals: 6, amount: '2.5', reserved: false, burn: false, recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true, recentSame: false },
    ...extra,
  });

  it('the Send tab says Send on QNet, lists QNC and the tokens, and reviews and sends a token by its own path', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let sent = null;
    await openWallet({
      'qnet.tokens': () => ({ tokens: [goldToken()], complete: true }),
      'qnet.tokenPreview': () => tokenPreview(),
      'qnet.tokenSend': (params) => {
        sent = params;
        return { txHash: null, status: 'submitted', nonce: '4', from: ADDRESSES.qnet };
      },
    });
    await page.click('[data-tab="send"]');
    assert.equal(page.$('.tab-body h2').textContent, 'Send on QNet');
    const picker = page.$('select[name="asset"]');
    // a token's option names its short contract too (M-5)
    assert.deepEqual(picker.querySelectorAll('option').map((node) => [node.getAttribute('value'), node.textContent]),
      [['QNC', 'QNC'], [GOLD, `GOLD · ${core.contractShortId(GOLD)}`]]);
    assert.equal(page.$('.tab-body label[for]').textContent, 'Asset');
    picker.value = GOLD;
    fire(picker, 'change');
    assert.match(page.text(), /Amount \(GOLD\)/);
    assert.match(page.text(), /Available: 7\.25 GOLD/);
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '2.50');
    await page.click('[data-action="review"]');
    assert.deepEqual(page.callsOf('qnet.tokenPreview').map((entry) => entry.params), [{ token: GOLD, to: RECIPIENT, amount: '2.5' }]);
    assert.equal(page.callsOf('qnet.preview').length, 0, 'never the QNC review');
    const text = page.text();
    for (const shown of ['Gold Coin (GOLD)', 'Token contract', '2.5 GOLD', '0.00045093 QNC', 'Token balance', '7.25 GOLD', 'Nonce']) {
      assert.ok(text.includes(shown), shown);
    }
    const send = page.$('[data-action="confirm-send"]');
    assert.equal(send.disabled, true, 'arms after the value delay');
    mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    await page.click('[data-action="confirm-send"]');
    assert.deepEqual(sent, { token: GOLD, to: RECIPIENT, amount: '2.5', expectedFeeNano: '450930', expectedDepositNano: '0', expectedNonce: '4' });
    assert.equal(page.$('.tab-body h2').textContent, 'Sent');
  });

  it('a token review that a balance does not cover, or whose token balance is unread, cannot be sent; QNet-named and burn tokens are flagged', async () => {
    await openWallet({
      'qnet.tokens': () => ({ tokens: [goldToken()], complete: true }),
      'qnet.tokenPreview': () => tokenPreview({ tokenBalance: '100', reserved: true, burn: true }),
    });
    await page.click('[data-tab="send"]');
    const picker = page.$('select[name="asset"]');
    picker.value = GOLD;
    fire(picker, 'change');
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '2.5');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /The token balance does not cover the amount\./);
    assert.match(page.text(), /named after QNet’s own coin/);
    assert.match(page.text(), /destroys every token sent to it/);
    assert.equal(page.$('[data-action="confirm-send"]').disabled, true);
    await page.click('[data-action="back"]');
    assert.equal(page.$('select[name="asset"]').value, GOLD, 'back to the form with the token chosen');
    assert.equal(page.$('input[name="amount"]').value, '2.5');
  });

  it('an amount with more decimals than the token has is refused before any request', async () => {
    await openWallet({ 'qnet.tokens': () => ({ tokens: [{ ...goldToken(), decimals: 2 }], complete: true }) });
    await page.click('[data-tab="send"]');
    const picker = page.$('select[name="asset"]');
    picker.value = GOLD;
    fire(picker, 'change');
    type(page.$('input[name="to"]'), RECIPIENT);
    type(page.$('input[name="amount"]'), '1.234');
    await page.click('[data-action="review"]');
    assert.match(page.text(), /at most 2 decimals/);
    assert.equal(page.callsOf('qnet.tokenPreview').length, 0);
  });
});

describe('popup: a history row opens its detail (owner, 06.10)', () => {
  const HASH = 'ab'.repeat(32);
  const row = (extra = {}) => ({
    hash: HASH, direction: 'out', from: ADDRESSES.qnet, to: RECIPIENT, amountNano: '2500000000', feeNano: '150000', timestamp: 1_700_000_000_000,
    status: 'included', nonce: null, kind: 'transfer', block: 2068632, ...extra,
  });

  it('QNet: type, status, amount, token, both sides as copy controls, block, time, fee, the hash to copy and the explorer', async () => {
    await openWallet({ 'qnet.history': () => ({ items: [row()], cursor: null, pending: [] }) });
    await page.click('[data-tab="history"]');
    await page.click('[data-action="open-detail"]');
    const detail = page.$('.history-detail');
    const text = detail.textContent;
    for (const shown of ['Sent', 'Type', 'Status', 'Confirmed', '−2.5 QNC', 'Token', 'QNC', 'From', 'To', 'Block', '2068632', 'Time', 'Network fee',
      '0.00015 QNC', 'Transaction', HASH]) {
      assert.ok(text.includes(shown), shown);
    }
    page.clipboard.writes.length = 0;
    await page.click('.history-detail [data-action="copy-value"]');
    assert.deepEqual(page.clipboard.writes, [HASH]);
    const recipient = detail.querySelectorAll('[data-action="copy-address"]').find((node) => node.textContent === RECIPIENT);
    recipient.click();
    await page.settle();
    assert.equal(page.clipboard.writes.at(-1), RECIPIENT);
    await page.click('.history-detail [data-action="explorer"]');
    assert.deepEqual(page.tabsCreated.at(-1), { url: `https://aiqnet.io/explorer/tx/${HASH}` });
  });

  it('an unverified row is looked up on two nodes and reads as confirmed with its block when they list it; a dropped one says why', async () => {
    await openWallet({
      'qnet.history': () => ({
        items: [row({ status: 'unverified', block: null })],
        cursor: null,
        pending: [row({ hash: '', status: 'dropped', nonce: '9', block: undefined })],
      }),
      'qnet.txLookup': ({ hash }) => ({ status: hash === HASH ? 'in_block' : 'unknown', blockHeight: 4321 }),
    });
    await page.click('[data-tab="history"]');
    const rows = page.$$('[data-action="open-detail"]');
    rows[1].click();
    await page.settle();
    assert.deepEqual(page.callsOf('qnet.txLookup').map((entry) => entry.params), [{ hash: HASH }]);
    assert.ok(page.$('.history-detail').textContent.includes('Confirmed'));
    assert.ok(page.$('.history-detail').textContent.includes('4321'));
    await page.click('.history-detail [data-action="back"]');
    page.$$('[data-action="open-detail"]')[0].click();
    await page.settle();
    const dropped = page.$('.history-detail').textContent;
    assert.ok(dropped.includes('Not found'));
    assert.ok(dropped.includes('The network no longer holds this transaction and it did not go through.'));
    assert.ok(dropped.includes('Nonce'));
    assert.equal(page.$('.history-detail [data-action="explorer"]'), null, 'no hash, no explorer link');
  });

  it('a token row shows the token and its amount; Solana rows show their mint, sides and signature', async () => {
    const tokenRow = row({ kind: 'token', direction: 'in', from: RECIPIENT, to: ADDRESSES.qnet, amountNano: '0', feeNano: '0',
      token: { contract: GOLD, symbol: 'GOLD', decimals: 6 }, amountBase: '1250000' });
    const SIG = core.base58Encode(new Uint8Array(64).fill(6));
    await openWallet({
      'qnet.history': () => ({ items: [tokenRow], cursor: null, pending: [] }),
      'solana.history': () => ({ items: [{ signature: SIG, asset: '1dev', direction: 'out', counterparty: SOLANA_RECIPIENT, amountRaw: '1500000',
        feeLamports: '5000', timestamp: 1_700_000_000_000, status: 'confirmed', burn: false }], cursor: null }),
    });
    await page.click('[data-tab="history"]');
    assert.equal(page.$('.history-row .amount').textContent, '+1.25 GOLD');
    await page.click('[data-action="open-detail"]');
    assert.ok(page.$('.history-detail').textContent.includes('Token contract'));
    assert.ok(page.$('.history-detail').textContent.includes(GOLD));
    await page.click('.network-switch [data-value="solana"]');
    await page.settle();
    await page.click('[data-action="open-detail"]');
    const text = page.$('.history-detail').textContent;
    for (const shown of ['−1.5 1DEV', 'Token mint', SOLANA.ONE_DEV_MINT, ADDRESSES.solana, SOLANA_RECIPIENT, '0.000005 SOL', 'Signature', SIG]) {
      assert.ok(text.includes(shown), shown);
    }
    await page.click('.history-detail [data-action="explorer"]');
    assert.deepEqual(page.tabsCreated.at(-1), { url: `https://explorer.solana.com/tx/${SIG}?cluster=devnet` });
  });
});

// M-5 (owner, 06.10): a token named after QNet's own coin, or with a hidden or format character in its symbol or name (the
// worker shows each such character as U+FFFD), is never drawn as if it were QNC: the warning mark before its symbol, the
// short contract id under every token row, "symbol · short contract" in the Send picker, and the danger notice in the
// detail of its History row. L-13: a list that leaves tokens out says so.
describe('popup: tokens named after QNC, and a list that leaves tokens out (M-5, L-13)', () => {
  const FAKE = core.qnetAddressFromPublicKey(new Uint8Array(1952).fill(12));
  const BIDI = core.qnetAddressFromPublicKey(new Uint8Array(1952).fill(13));
  const fake = { contract: FAKE, name: 'QNC', symbol: 'QNC', decimals: 9, balanceBase: '1000000000000', reserved: true };
  // "\u202eCNQ" as the worker shows it (core.tokenLabel), in a list kept from a read that carried no flag
  const bidi = { contract: BIDI, name: '', symbol: '\ufffdCNQ', decimals: 0, balanceBase: '5' };
  // a look-alike the popup flags by itself (core.usesReservedName): Cyrillic Es for the C
  const lookalike = { ...goldToken(), contract: RECIPIENT, name: 'Coin', symbol: 'QN\u0421' };

  it('Assets marks them, and every token row names its short contract id', async () => {
    await openWallet({ 'qnet.tokens': () => ({ tokens: [goldToken(), fake, bidi, lookalike], complete: true }) });
    await page.settle();
    assert.deepEqual(page.$$('.token-row .token-name').map((node) => node.textContent),
      ['QNC', 'GOLD', '\u26a0 QNC', '\u26a0 \ufffdCNQ', '\u26a0 QN\u0421']);
    assert.deepEqual(page.$$('.token-row .token-name').map((node) => node.classList.contains('token-reserved')),
      [false, false, true, true, true]);
    assert.deepEqual(page.$$('.token-row .token-contract').map((node) => node.textContent),
      [GOLD, FAKE, BIDI, RECIPIENT].map((contract) => core.contractShortId(contract)));
    assert.deepEqual(page.$$('.token-row .token-amount').map((node) => node.textContent),
      ['12.5 QNC', '7.25 GOLD', '1000 \u26a0 QNC', '5 \u26a0 \ufffdCNQ', '7.25 \u26a0 QN\u0421']);
    // the real QNC row: no mark, no contract line
    assert.equal(page.$$('.token-row')[0].querySelector('.token-contract'), null);
    assert.equal(page.$('.tab-body .tokens-omitted').classList.contains('hidden'), true, 'every token listed: no note');
  });

  it('the Send picker names each token by its symbol and short contract, a marked one with its mark', async () => {
    await openWallet({ 'qnet.tokens': () => ({ tokens: [goldToken(), fake], complete: true }) });
    await page.click('[data-tab="send"]');
    assert.deepEqual(page.$('select[name="asset"]').querySelectorAll('option').map((node) => node.textContent),
      ['QNC', `GOLD · ${core.contractShortId(GOLD)}`, `\u26a0 QNC · ${core.contractShortId(FAKE)}`]);
    const picker = page.$('select[name="asset"]');
    picker.value = FAKE;
    fire(picker, 'change');
    assert.match(page.text(), /Amount \(\u26a0 QNC\)/);
  });

  it('History marks a received token named after QNC, and its detail says it is not QNC', async () => {
    // the token named after QNC is the newer row, listed first
    const at = Date.now();
    const row = (contract, symbol, reserved) => ({
      hash: (reserved ? 'cd' : 'ef').repeat(32), direction: 'in', from: RECIPIENT, to: ADDRESSES.qnet, amountNano: '0', feeNano: '0',
      timestamp: reserved ? at - 60000 : at - 120000, status: 'included', nonce: null, kind: 'token', block: 5,
      token: { contract, symbol, decimals: 9, reserved }, amountBase: '1000000000000',
    });
    await openWallet({ 'qnet.history': () => ({ items: [row(FAKE, 'QNC', true), row(GOLD, 'GOLD', false)], cursor: null, pending: [] }) });
    await page.click('[data-tab="history"]');
    assert.deepEqual(page.$$('.history-row .amount-symbol').map((node) => node.textContent), ['\u26a0 QNC', 'GOLD']);
    await page.click('[data-action="open-detail"]');
    assert.match(page.text(), /This token is named after QNet’s own coin, but it is not QNC\./);
    assert.equal(page.$$('.tab-body .notice-danger').length, 1);
    await page.click('[data-action="back"]');
    page.$$('[data-action="open-detail"]')[1].click();
    await page.settle();
    assert.doesNotMatch(page.text(), /not QNC/, 'a token of its own name has no such notice');
  });

  it('says "Some tokens are not shown" under Assets and the Send picker while the list leaves tokens out (L-13)', async () => {
    let complete = false;
    await openWallet({ 'qnet.tokens': () => ({ tokens: [goldToken()], complete }) });
    await page.settle();
    const note = () => page.$('.tab-body .tokens-omitted');
    assert.equal(note().textContent, 'Some tokens are not shown.');
    assert.equal(note().classList.contains('hidden'), false);
    await page.click('[data-tab="send"]');
    assert.equal(note().textContent, 'Some tokens are not shown.');
    assert.equal(note().classList.contains('hidden'), false);
    // a read that lists them all takes it away
    complete = true;
    page.emit('balance');
    await page.settle();
    assert.equal(note().classList.contains('hidden'), true);
    await page.click('[data-tab="assets"]');
    assert.equal(note().classList.contains('hidden'), true);
    assert.equal(note().textContent, '');
  });
});

// Owner, 06.10: Lock in the header is a lock glyph in the header's text colour, its name the tooltip and the accessible label.
describe('popup: the Lock icon (owner, 06.10)', () => {
  it('is an icon button named Lock in the UI language, as tooltip and for screen readers', async () => {
    await openWallet();
    const lock = page.$('.topbar [data-action="lock"]');
    assert.equal(lock.textContent, '', 'a glyph, no text');
    assert.equal(lock.getAttribute('aria-label'), 'Lock');
    assert.equal(lock.getAttribute('title'), 'Lock');
    assert.equal(lock.getAttribute('type'), 'button');
    assert.ok(lock.classList.contains('btn-ghost') && lock.classList.contains('icon-button'));
    assert.equal(lock.querySelector('.lock-icon').getAttribute('aria-hidden'), 'true');
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new URL('../dist/ui/popup.css', import.meta.url), 'utf8');
    const rule = css.match(/\n\.lock-icon \{([^}]*)\}/)?.[1] ?? '';
    assert.match(rule, /background-color: currentColor;/);
    assert.match(rule, /-webkit-mask: url\("data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"\) center \/ contain no-repeat;/);
    page.close();
    await openWallet({ 'settings.get': () => ({ autoLockMinutes: 15, language: 'ru' }) });
    // the Russian table is a module the page imports: the header comes once it is loaded
    for (let turn = 0; turn < 400 && page.$('.topbar') === null; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await page.settle();
    const localized = page.$('.topbar [data-action="lock"]');
    assert.equal(localized.getAttribute('aria-label'), 'Заблокировать');
    assert.equal(localized.getAttribute('title'), 'Заблокировать');
  });
});

// M-4: what the store's 2.1.x left behind. The page storage (where 2.x kept a copy of its password) goes as soon as the
// popup opens; the encrypted wallet it kept in chrome.storage.local goes only behind the user's confirmation in Settings.
describe('popup: what an earlier version left (M-4)', () => {
  it('with no vault yet, the first screen says the earlier wallet is here and leads to setup, which moves it', async () => {
    await openWallet({ 'vault.status': () => ({ ...lockedStatus(), exists: false, earlier: true }) });
    assert.match(page.text(), /This browser keeps the wallet of an earlier version of QNet Wallet\./);
    assert.doesNotMatch(page.text(), /No wallet in this browser yet/);
    const open = page.$('[data-action="open-setup"]');
    assert.equal(open.textContent, 'Unlock your earlier wallet');
    await page.click('[data-action="open-setup"]');
    assert.deepEqual(page.tabsCreated.map((tab) => tab.url), [page.chrome.runtime.getURL('ui/setup.html')]);
  });

  it('empties the page storage an earlier version left as soon as it opens', async () => {
    await openWallet({}, { localStorage: { qnet_wallet_password_hash: 'cGFzc3dvcmRxbmV0X3NhbHRfMjAyNQ==', qnet_wallet_unlocked: 'true' } });
    assert.equal(page.localStorage.length, 0);
  });

  it('Settings offers to remove the earlier wallet while it is there, behind one confirmation', async () => {
    let earlier = true;
    await openWallet({
      'vault.status': () => ({ ...unlockedStatus(), earlier }),
      'vault.removeEarlier': () => {
        earlier = false;
        return { removed: true };
      },
    });
    await page.click('[data-tab="settings"]');
    assert.match(page.text(), /Wallet of the earlier version/);
    assert.match(page.text(), /An earlier version of QNet Wallet left its encrypted wallet in this browser\./);
    await page.click('[data-action="remove-earlier"]');
    assert.equal(page.callsOf('vault.removeEarlier').length, 0, 'one confirmation first');
    assert.match(page.text(), /After this, that wallet opens only with its own recovery phrase\. If you imported that phrase here, nothing is lost\./);
    await page.click('[data-action="cancel-remove-earlier"]');
    assert.equal(page.callsOf('vault.removeEarlier').length, 0, 'Cancel removes nothing');
    await page.click('[data-action="remove-earlier"]');
    await page.click('[data-action="confirm-remove-earlier"]');
    assert.deepEqual(page.callsOf('vault.removeEarlier').map((entry) => entry.params), [{ confirm: 'REMOVE' }]);
    assert.equal(page.$('[data-action="remove-earlier"]'), null);
    assert.doesNotMatch(shownText(), /Wallet of the earlier version/);
    assert.match(page.text(), /The earlier version’s wallet was removed from this browser\./);
    page.close();
    // nothing left by an earlier version: no such section
    await openWallet();
    await page.click('[data-tab="settings"]');
    assert.equal(page.$('[data-action="remove-earlier"]'), null);
    assert.doesNotMatch(page.text(), /earlier version/);
  });
});

describe('popup: private key export (owner, 06.10)', () => {
  const QNET_KEY = 'cd'.repeat(32);

  it('asks for the password behind the warning, then shows the key at once with Copy and Done: no hold, no account block, no clipboard text', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_750_000_000_000 });
    await openWallet({
      'vault.exportKey': ({ password, network }) => {
        if (password !== PASSWORD) fail('BAD_PASSWORD');
        return network === 'qnet' ? { network, address: ADDRESSES.qnet, privateKey: QNET_KEY } : { network, address: ADDRESSES.solana, privateKey: 'solkey' };
      },
    });
    await page.click('[data-tab="settings"]');
    assert.match(page.text(), /Private key/);
    await page.click('[data-action="export-key"]');
    assert.match(page.text(), /Anyone with this key controls this account and everything in it\./);
    assert.match(page.text(), /QNet: the 32-byte seed the wallet derives its ML-DSA-65 key pair from, as 64 hex characters\./);
    await page.click('.tab-body [data-value="solana"]');
    assert.match(page.text(), /Solana: the 64-byte secret key in base58\./);
    await page.click('.tab-body [data-value="qnet"]');
    const password = page.$('input[name="password"]');
    assertHardened(password);
    type(password, 'wrong');
    await page.click('[data-action="export"]');
    assert.equal(password.value, '');
    assert.match(page.text(), /Wrong password/);
    assert.ok(!page.text().includes(QNET_KEY));
    type(page.$('input[name="password"]'), PASSWORD);
    await page.click('[data-action="export"]');
    assert.deepEqual(page.callsOf('vault.exportKey').map((entry) => entry.params).at(-1), { password: PASSWORD, network: 'qnet' });
    // the key at once, Copy and Done, nothing else: no account or address block, no hold, no clipboard text
    assert.equal(page.$('.key-box').textContent, QNET_KEY);
    assert.deepEqual(shownLines(), ['Private key', QNET_KEY, 'Copy', 'Done']);
    assert.deepEqual(shownActions(), ['copy-key', 'done']);
    assert.equal(page.$('[data-action="hold-key"]'), null);
    assert.ok(!page.text().includes(ADDRESSES.qnet), 'no address block');
    assert.doesNotMatch(page.text(), /Account|clipboard|Hides in/);
    mock.timers.tick(TIMINGS.REVEAL_AUTO_HIDE_MS * 2);
    await page.settle();
    assert.equal(page.$('.key-box').textContent, QNET_KEY, 'no timer hides it');
    assert.equal(page.clipboard.writes.length, 0, 'nothing copied unasked');
    await page.click('[data-action="copy-key"]');
    assert.equal(page.clipboard.text, QNET_KEY);
    assert.match(page.text(), /Private key copied\./);
    mock.timers.tick(60_000);
    await page.settle();
    assert.equal(page.clipboard.text, '', 'cleared after 60 s, silently');
    // Done: the key leaves the page with the screen
    await page.click('[data-action="done"]');
    assert.ok(!page.text().includes(QNET_KEY));
    assert.ok(page.$('[data-action="export-key"]'));
  });
});

describe('popup: header and tab bar gutter (owner, 06.10)', () => {
  it('the header and the tab bar keep a side gutter; tabs stay on one line and the bar scrolls when a language needs it', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new URL('../dist/ui/popup.css', import.meta.url), 'utf8');
    const rule = (selector) => css.match(new RegExp(`\\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    assert.match(rule('.topbar'), /padding: 0 16px;/);
    assert.match(rule('.tabs'), /padding: 0 12px;/);
    assert.match(rule('.tabs'), /overflow-x: auto;/);
    assert.match(rule('.tab'), /white-space: nowrap;/);
    assert.match(rule('.tab'), /flex: 1 0 auto;/);
  });
});
