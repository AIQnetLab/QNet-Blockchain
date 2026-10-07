// The setup tab on a browserless DOM with a scripted worker (requests checked against the router
// table). R11: refuses when a vault exists, typed backup check, a copy only by the Copy button with its warning
// (cleared after 60 s and at the end of setup), no download, phrase handed over once and then dropped; the success
// screen stays until the user presses Done, which closes the tab (owner, 28.09: nothing closes by itself);
// EXT-SEC-M2: a failed write keeps the phrase for another try.
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/lib/qnet-core.js';
import { readFile } from 'node:fs/promises';
import { fire, type } from './helpers/ui-dom.mjs';
import { fail, openPage } from './helpers/ui-page.mjs';

const ADDRESSES = Object.freeze({ qnet: core.KAT.qnetAddress, solana: core.KAT.solanaAddress });
const PASSWORD = 'correct horse battery staple';
const noVault = () => ({ exists: false, unlocked: false, lockDeadline: null, addresses: null, signingEnabled: true, backoffUntil: null });

function handlers(overrides = {}) {
  return {
    'settings.get': () => ({ autoLockMinutes: null, language: 'en' }),
    'vault.status': noVault,
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

function assertAllInputsHardened() {
  for (const input of page.$$('input, textarea')) {
    if (input.getAttribute('type') === 'checkbox') continue;
    for (const [name, value] of [['spellcheck', 'false'], ['autocomplete', 'off'], ['autocapitalize', 'off'], ['autocorrect', 'off'], ['data-gramm', 'false']]) {
      assert.equal(input.getAttribute(name), value, `${input.getAttribute('name')} ${name}`);
    }
  }
}

const shownWords = () => page.$$('.word').map((node) => node.textContent);

async function fillVerification(words, { wrong = false } = {}) {
  const inputs = page.$$('input[name]').filter((input) => input.getAttribute('name').startsWith('word-'));
  assert.equal(inputs.length, 3);
  for (const input of inputs) {
    const position = Number(input.getAttribute('name').slice('word-'.length));
    type(input, wrong ? 'zoo' : ` ${words[position - 1].toUpperCase()} `);
  }
  await page.click('[data-action="verify"]');
  return inputs;
}

async function choosePassword(password = PASSWORD, confirmation = password) {
  type(page.$('input[name="new-password"]'), password);
  type(page.$('input[name="confirm-password"]'), confirmation);
  await page.click('[data-action="submit"]');
}

describe('setup', () => {
  it('refuses to create or import while a wallet exists, and only offers to close', async () => {
    page = await openPage('setup', { handlers: handlers({ 'vault.status': () => ({ ...noVault(), exists: true }) }) });
    assert.match(page.text(), /A wallet already exists/);
    assert.match(page.text(), /Settings → Delete wallet/);
    assert.equal(page.$('[data-action="create"]'), null);
    assert.equal(page.$('[data-action="import"]'), null);
    await page.click('[data-action="close"]');
    assert.deepEqual(page.tabsRemoved, [77]);
  });

  it('loads its layout stylesheet next to popup.css', async () => {
    page = await openPage('setup', { handlers: handlers() });
    assert.deepEqual(page.$$('link').map((node) => [node.getAttribute('rel'), node.getAttribute('href')]), [['stylesheet', 'setup.css']]);
  });

  it('create: words only after Show, typed check of 3 words, the shown phrase sent once, then forgotten; Done closes the tab', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_750_000_000_000 });
    let created = null;
    page = await openPage('setup', {
      handlers: handlers({
        'vault.create': (params) => {
          created = params;
          return { ...ADDRESSES, lockDeadline: Date.now() + 900000 };
        },
      }),
    });
    await page.click('[data-action="create"]');
    assert.deepEqual(shownWords(), [], 'hidden until the user asks');
    assert.equal(page.$('[data-action="continue"]').disabled, true);
    assert.ok(page.$$('button').every((node) => !/copy|download|save/i.test(node.textContent)), 'no copy control before the words show');
    await page.click('[data-action="reveal-words"]');
    const words = shownWords();
    assert.equal(words.length, 12);
    assert.deepEqual(page.$$('button').filter((node) => /copy|download|save/i.test(node.textContent)).map((node) => node.getAttribute('data-action')),
      ['copy-phrase'], 'one Copy button, no download');
    // EXT-VAULT-05: the words cannot be selected, copied, cut or dragged out
    const grid = page.$('.word-grid');
    for (const eventType of ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart']) {
      assert.equal(fire(grid, eventType), false, `${eventType} is refused`);
    }
    assert.equal(core.validateMnemonic(words.join(' ')), true);
    await page.click('input[name="written"]');
    await page.click('[data-action="continue"]');

    const wrong = await fillVerification(words, { wrong: true });
    assert.ok(wrong.every((input) => input.value === ''), 'typed words cleared');
    assert.match(page.text(), /The words do not match/);
    await page.click('[data-action="reveal-words"]');
    assert.deepEqual(shownWords(), words, 'the same phrase after a failed check');
    await page.click('input[name="written"]');
    await page.click('[data-action="continue"]');
    assertAllInputsHardened();
    await fillVerification(words);

    assertAllInputsHardened();
    // the rule of both wallets: 8 characters, typed twice, shown live; nothing else
    assert.match(page.text(), /× At least 8 characters/);
    await choosePassword('seven77');
    assert.match(page.text(), /The password needs at least 8 characters/);
    await choosePassword(PASSWORD, `${PASSWORD}!`);
    assert.match(page.text(), /Passwords do not match/);
    assert.equal(created, null);
    const first = page.$('input[name="new-password"]');
    type(first, PASSWORD);
    type(page.$('input[name="confirm-password"]'), PASSWORD);
    assert.match(page.text(), /✓ At least 8 characters/);
    assert.match(page.text(), /✓ Passwords match/);
    await choosePassword();
    assert.equal(first.value, '');
    assert.deepEqual(created, { mnemonic: words.join(' '), password: PASSWORD });
    assert.equal(page.callsOf('vault.create').length, 1);

    assert.match(page.text(), /Your wallet is ready/);
    assert.ok(page.text().includes(ADDRESSES.qnet) && page.text().includes(ADDRESSES.solana));
    assert.deepEqual(shownWords(), []);
    assert.ok(!page.text().includes(words.join(' ')));
    assert.deepEqual(page.tabsRemoved, []);
    await page.click('[data-action="close"]');
    assert.deepEqual(page.tabsRemoved, [77]);
    assert.equal(page.app.textContent, '', 'the page is emptied');
  });

  // Owner, 28.09: the success screen appeared and then closed by itself; now the user presses Done to go on.
  it('the success screen never closes or leaves by itself: only Done closes the tab', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_750_000_000_000 });
    page = await openPage('setup', { handlers: handlers({ 'vault.import': () => ({ ...ADDRESSES, lockDeadline: Date.now() + 900000 }) }) });
    await page.click('[data-action="import"]');
    type(page.$('textarea[name="phrase"]'), core.KAT.mnemonic);
    await page.click('[data-action="continue"]');
    await choosePassword();
    assert.match(page.text(), /Your wallet is ready/);
    assert.doesNotMatch(page.text(), /closes in|seconds/, 'no countdown');
    assert.doesNotMatch(page.text(), /encrypted in this browser and was removed/, 'no paragraph on what happened inside');
    const done = page.$('[data-action="close"]');
    assert.equal(done.textContent, 'Done');
    // far past any close delay and the idle drop: still on the success screen, the tab still open
    mock.timers.tick(60 * 60 * 1000);
    await page.settle();
    assert.deepEqual(page.tabsRemoved, []);
    assert.equal(page.window.closed, false);
    assert.match(page.text(), /Your wallet is ready/);
    assert.ok(page.text().includes(ADDRESSES.qnet) && page.text().includes(ADDRESSES.solana));
    assert.equal(page.$('[data-action="close"]'), done);
    await page.click('[data-action="close"]');
    assert.deepEqual(page.tabsRemoved, [77]);
  });

  it('import: refuses an invalid phrase locally and sends a pasted variant in canonical form', async () => {
    let imported = null;
    page = await openPage('setup', {
      handlers: handlers({
        'vault.import': (params) => {
          imported = params;
          return { ...ADDRESSES, lockDeadline: 1 };
        },
      }),
    });
    await page.click('[data-action="import"]');
    const phrase = page.$('textarea[name="phrase"]');
    assertAllInputsHardened();
    type(phrase, `${'abandon '.repeat(12)}`);
    await page.click('[data-action="continue"]');
    assert.match(page.text(), /not a valid recovery phrase/);
    assert.equal(phrase.value.length > 0, true, 'kept for correction');

    const words = core.KAT.mnemonic.split(' ');
    type(phrase, `  ${words.slice(0, 4).join('  ').toUpperCase()}\r\n${words.slice(4, 8).join('\t')}\n${words.slice(8).join(' ')}  `);
    await page.click('[data-action="continue"]');
    assert.equal(phrase.value, '');
    assert.doesNotMatch(page.text(), /Extra spaces, line breaks and capitals were removed/, 'no note on the canonical form');
    assert.doesNotMatch(page.text(), /code/, 'twelve or 24 words and a password, nothing else');
    await choosePassword();
    assert.deepEqual(imported, { mnemonic: core.KAT.mnemonic, password: PASSWORD });
  });

  it('keeps the phrase for another try when the vault write fails (EXT-SEC-M2)', async () => {
    let attempts = 0;
    page = await openPage('setup', {
      handlers: handlers({
        'vault.create': () => {
          attempts += 1;
          return attempts === 1 ? fail('VAULT_CORRUPT') : { ...ADDRESSES, lockDeadline: 1 };
        },
      }),
    });
    await page.click('[data-action="create"]');
    await page.click('[data-action="reveal-words"]');
    const words = shownWords();
    await page.click('input[name="written"]');
    await page.click('[data-action="continue"]');
    await fillVerification(words);
    await choosePassword();
    assert.match(page.text(), /failed its integrity check/);
    assert.ok(page.$('input[name="new-password"]'), 'still on the password step');
    await choosePassword();
    assert.equal(attempts, 2);
    assert.deepEqual(page.callsOf('vault.create').map((entry) => entry.params.mnemonic), [words.join(' '), words.join(' ')]);
    assert.match(page.text(), /Your wallet is ready/);
  });

  it('drops the phrase and shows the refusal when another tab created a wallet first', async () => {
    page = await openPage('setup', { handlers: handlers({ 'vault.import': () => fail('VAULT_EXISTS') }) });
    await page.click('[data-action="import"]');
    type(page.$('textarea[name="phrase"]'), core.KAT.mnemonic);
    await page.click('[data-action="continue"]');
    await choosePassword();
    assert.match(page.text(), /A wallet already exists/);
    assert.equal(page.$('[data-action="submit"]'), null);
  });

  it('import: takes 12 or 24 words and a password, and offers nothing else', async () => {
    page = await openPage('setup', { handlers: handlers() });
    await page.click('[data-action="import"]');
    assert.deepEqual(page.$$('input, textarea').map((node) => node.getAttribute('name')), ['phrase']);
    assert.doesNotMatch(page.text(), /\bcode\b/i);
  });
});

// The recovery phrase leaves this page by its Copy button only: an explicit click, the warning next to it, and the
// clipboard emptied after TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS (or when the tab gets the focus back after that) and at the
// end of setup, which closes the tab before that timer would run.
describe('setup: the Copy button of the new phrase', () => {
  it('copies the shown words on an explicit click only, with the warning next to it, and clears them after a minute', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    page = await openPage('setup', { handlers: handlers() });
    await page.click('[data-action="create"]');
    assert.equal(page.$('[data-action="copy-phrase"]'), null, 'no Copy button while the words are hidden');
    await page.click('[data-action="reveal-words"]');
    const words = shownWords();
    assert.match(page.text(), /Anyone who can read your clipboard can take your wallet\. The clipboard is cleared in 60 seconds/);
    // the words screen: one line on who the words give the wallet to, and the copy line (owner, 28.09)
    assert.match(page.text(), /Anyone with these words controls your wallet\./);
    assert.doesNotMatch(page.text(), /Keep it safe|A phrase in a file, a screenshot or the clipboard can be stolen|Nobody can restore it/);
    assert.doesNotMatch(page.text(), /There is no copy or download/);
    assert.deepEqual(page.clipboard.writes, [], 'nothing copied unasked');
    await page.click('[data-action="copy-phrase"]');
    assert.equal(page.clipboard.text, words.join(' '));
    assert.match(page.text(), /Recovery phrase copied/);
    mock.timers.tick(59_999);
    assert.equal(page.clipboard.text, words.join(' '));
    mock.timers.tick(1);
    assert.equal(page.clipboard.text, '', 'cleared after 60 s');
    // a copy the deadline finds without the focus goes as soon as the tab has it again
    await page.click('[data-action="copy-phrase"]');
    page.document.focused = false;
    mock.timers.tick(60_000);
    assert.equal(page.clipboard.text, words.join(' '));
    page.document.focused = true;
    fire(page.window, 'focus');
    assert.equal(page.clipboard.text, '');
  });

  it('empties the clipboard of a copied phrase when the wallet is set up, before the tab closes', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let created = null;
    page = await openPage('setup', {
      handlers: handlers({ 'vault.create': (params) => { created = params; return { ...ADDRESSES, lockDeadline: 1 }; } }),
    });
    await page.click('[data-action="create"]');
    await page.click('[data-action="reveal-words"]');
    const words = shownWords();
    await page.click('[data-action="copy-phrase"]');
    assert.equal(page.clipboard.text, words.join(' '));
    await page.click('input[name="written"]');
    await page.click('[data-action="continue"]');
    await fillVerification(words);
    await choosePassword();
    assert.deepEqual(created, { mnemonic: words.join(' '), password: PASSWORD });
    assert.match(page.text(), /Your wallet is ready/);
    assert.equal(page.clipboard.text, '', 'cleared at the end of setup');
  });

});

describe('setup: secrets on screen', () => {
  it('hides the shown words on a screen lock or a hidden tab, and empties a typed phrase (R2-ESM-07)', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    page = await openPage('setup', { handlers: handlers() });
    await page.click('[data-action="create"]');
    await page.click('[data-action="reveal-words"]');
    const words = shownWords();
    assert.equal(words.length, 12);
    page.emit('locked');
    await page.settle();
    assert.deepEqual(shownWords(), [], 'the OS screen lock hides them');
    await page.click('[data-action="reveal-words"]');
    assert.deepEqual(shownWords(), words, 'the same phrase, shown again on request');
    page.document.hidden = true;
    page.document.visibilityState = 'hidden';
    fire(page.document, 'visibilitychange');
    assert.deepEqual(shownWords(), [], 'a hidden tab hides them');
    page.document.hidden = false;
    page.document.visibilityState = 'visible';
    await page.click('[data-action="reveal-words"]');
    mock.timers.tick(2 * 60 * 1000);
    assert.deepEqual(shownWords(), [], 'and they hide on their own after a while');

    await page.click('[data-action="back"]');
    await page.click('[data-action="import"]');
    const input = page.$('textarea[name="phrase"]');
    type(input, core.KAT.mnemonic);
    page.emit('locked');
    assert.equal(input.value, '', 'a pasted phrase does not wait in a locked screen');
  });

  // R3-EXT-UI-01: the idle drop covers a phrase typed or pasted into Import too, and another window taking the
  // focus hides the word grid and clears a typed phrase, as the popup's reveal hides on blur.
  it('clears a phrase left in Import after ten idle minutes, and hides secrets when the window loses the focus (R3-EXT-UI-01)', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    page = await openPage('setup', { handlers: handlers() });
    await page.click('[data-action="import"]');
    const input = page.$('textarea[name="phrase"]');
    type(input, core.KAT.mnemonic);
    mock.timers.tick(10 * 60 * 1000);
    await page.settle();
    assert.equal(input.value, '', 'the idle drop clears the Import field');
    type(input, core.KAT.mnemonic);
    fire(page.window, 'blur');
    assert.equal(input.value, '', 'another window has the focus: the typed phrase goes');
    await page.click('[data-action="back"]');
    await page.click('[data-action="create"]');
    await page.click('[data-action="reveal-words"]');
    assert.equal(shownWords().length, 12);
    fire(page.window, 'blur');
    await page.settle();
    assert.deepEqual(shownWords(), [], 'the grid goes back behind "Show the words"');
  });

  // R3-EXT-UI-02: a phrase pasted into Import leaves the current clipboard at once, and again on every way out of the
  // step, as the mobile app's clearPastedPhrase. R4-EXT-UI-02: the screen never claims the words left every clipboard;
  // it keeps to one short line (owner, 28.09).
  it('empties the clipboard after a phrase is pasted into Import, and never claims more (R3-EXT-UI-02, R4-EXT-UI-02)', async () => {
    page = await openPage('setup', { handlers: handlers({ 'vault.import': () => ({ ...ADDRESSES, lockDeadline: 1 }) }) });
    await page.click('[data-action="import"]');
    assert.doesNotMatch(page.text(), /removed from the clipboard/);
    assert.match(page.text(), /Type or paste your 12 or 24 words\./);
    const input = page.$('textarea[name="phrase"]');
    page.clipboard.text = core.KAT.mnemonic;
    fire(input, 'paste');
    type(input, core.KAT.mnemonic);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(page.clipboard.text, '', 'cleared right after the paste');
    page.clipboard.writes.length = 0;
    await page.click('[data-action="continue"]');
    assert.deepEqual(page.clipboard.writes, [''], 'and again when the step is left');
    // a typed phrase never touches the clipboard
    page.close();
    page = await openPage('setup', { handlers: handlers() });
    await page.click('[data-action="import"]');
    type(page.$('textarea[name="phrase"]'), core.KAT.mnemonic);
    await page.click('[data-action="continue"]');
    assert.deepEqual(page.clipboard.writes, []);
  });

  // Owner decision of 2026-09-28: no word, sequence or guessability check; 8 characters typed twice are enough.
  it('takes any password of 8 characters typed twice, and checks nothing else', async () => {
    let imported = null;
    page = await openPage('setup', { handlers: handlers({ 'vault.import': (params) => { imported = params; return { ...ADDRESSES, lockDeadline: 1 }; } }) });
    await page.click('[data-action="import"]');
    type(page.$('textarea[name="phrase"]'), core.KAT.mnemonic);
    await page.click('[data-action="continue"]');
    await choosePassword('1234567');
    assert.match(page.text(), /at least 8 characters/);
    assert.equal(imported, null);
    await choosePassword('12345678');
    assert.deepEqual(imported, { mnemonic: core.KAT.mnemonic, password: '12345678' });
  });

  it('drops a phrase nobody touched for ten minutes (R2-ESM-07)', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    page = await openPage('setup', { handlers: handlers() });
    await page.click('[data-action="create"]');
    await page.click('[data-action="reveal-words"]');
    const words = shownWords();
    mock.timers.tick(10 * 60 * 1000);
    await page.settle();
    assert.ok(page.$('[data-action="create"]'), 'back on the welcome screen');
    await page.click('[data-action="create"]');
    await page.click('[data-action="reveal-words"]');
    assert.notDeepEqual(shownWords(), words, 'a new phrase: the old one is gone');
  });

  it('never lets the words be selected (EXT-VAULT-05)', async () => {
    const css = await readFile(new URL('../dist/ui/popup.css', import.meta.url), 'utf8');
    const rule = /\.word-grid \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(rule, /(^|\s)user-select: none;/);
  });
});

// M-4: about 47 store users of 2.1.x update into this version. While the wallet 2.x kept in chrome.storage.local is in
// this browser (vault.status `earlier`), the first screen offers to unlock it with its password and move it into this
// version (vault.migrate: the password alone only checks it; with a new password it becomes the vault), or to use the
// recovery phrase instead (Import), or to create a new wallet. A wrong password removes nothing, and what 2.x left goes
// only when the worker moved it or the user confirmed its removal.
describe('setup: the wallet of an earlier version (M-4)', () => {
  const OLD = 'the password of 2.1.3';
  const earlierStatus = (extra = {}) => ({ ...noVault(), earlier: true, ...extra });
  const migrate = (params) => {
    if (params.password !== OLD) fail('BAD_PASSWORD');
    return params.newPassword === undefined ? { checked: true } : { ...ADDRESSES, lockDeadline: 1 };
  };
  const actions = () => page.$$('[data-action]').map((node) => node.getAttribute('data-action'));

  it('offers to unlock the earlier wallet, to use the recovery phrase instead, or to create a new wallet', async () => {
    page = await openPage('setup', { handlers: handlers({ 'vault.status': () => earlierStatus() }) });
    assert.match(page.text(), /Your wallet from the earlier version/);
    assert.match(page.text(), /This browser keeps the wallet of an earlier version of QNet Wallet\. Unlock it with its password to move it to this version\./);
    assert.deepEqual(actions(), ['earlier-unlock', 'import', 'create']);
    assert.deepEqual(page.$$('[data-action]').map((node) => node.textContent),
      ['Unlock your earlier wallet', 'Use my recovery phrase instead', 'Create a new wallet']);
    await page.click('[data-action="import"]');
    assert.ok(page.$('textarea[name="phrase"]'), 'Import');
    await page.click('[data-action="back"]');
    assert.deepEqual(actions(), ['earlier-unlock', 'import', 'create'], 'back on the same first screen');
    assert.equal(page.callsOf('vault.migrate').length, 0);
    page.close();
    // no earlier wallet: the usual first screen
    page = await openPage('setup', { handlers: handlers() });
    assert.equal(page.$('[data-action="earlier-unlock"]'), null);
    assert.match(page.text(), /Set up QNet Wallet/);
  });

  it('a wrong password says so and moves nothing; the right one leads to the new password, then the wallet is moved', async () => {
    page = await openPage('setup', { handlers: handlers({ 'vault.status': () => earlierStatus(), 'vault.migrate': migrate }) });
    await page.click('[data-action="earlier-unlock"]');
    assert.match(page.text(), /Unlock your earlier wallet/);
    assert.match(page.text(), /Enter the password of the earlier version\. Next you choose the password of this version\./);
    assertAllInputsHardened();
    const password = page.$('input[name="earlier-password"]');
    assert.equal(password.getAttribute('type'), 'password');
    await page.click('[data-action="earlier-continue"]');
    assert.match(page.text(), /Enter your password\./);
    assert.equal(page.callsOf('vault.migrate').length, 0, 'nothing sent without a password');
    type(password, 'wrong');
    await page.click('[data-action="earlier-continue"]');
    assert.equal(password.value, '', 'cleared at once');
    assert.match(page.text(), /Wrong password\./);
    assert.ok(page.$('input[name="earlier-password"]'), 'still on this step');
    type(page.$('input[name="earlier-password"]'), OLD);
    await page.click('[data-action="earlier-continue"]');
    assert.deepEqual(page.callsOf('vault.migrate').map((entry) => entry.params), [{ password: 'wrong' }, { password: OLD }],
      'the password alone only checks it');
    // the new password of this version
    assert.ok(page.$('input[name="new-password"]'));
    assert.equal(page.$('[data-action="submit"]').textContent, 'Move my wallet');
    assert.ok(!page.text().includes(OLD));
    await page.click('[data-action="back"]');
    assert.ok(page.$('input[name="earlier-password"]'), 'Back asks for the earlier password again');
    type(page.$('input[name="earlier-password"]'), OLD);
    await page.click('[data-action="earlier-continue"]');
    await choosePassword();
    assert.deepEqual(page.callsOf('vault.migrate').at(-1).params, { password: OLD, newPassword: PASSWORD });
    assert.match(page.text(), /Your wallet is ready/);
    assert.ok(page.text().includes(ADDRESSES.qnet) && page.text().includes(ADDRESSES.solana));
    // the worker removed the earlier copy itself once the new vault was read back: nothing to offer
    assert.equal(page.$('[data-action="remove-earlier"]'), null);
    assert.equal(page.callsOf('vault.removeEarlier').length, 0);
  });

  it('keeps to the backoff of unlock: a countdown holds Continue, from the status too', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_750_000_000_000 });
    page = await openPage('setup', {
      handlers: handlers({ 'vault.status': () => earlierStatus(), 'vault.migrate': () => fail('BACKOFF', { retryAfterMs: 5000 }) }),
    });
    await page.click('[data-action="earlier-unlock"]');
    type(page.$('input[name="earlier-password"]'), 'wrong');
    await page.click('[data-action="earlier-continue"]');
    const next = page.$('[data-action="earlier-continue"]');
    assert.equal(next.disabled, true);
    assert.match(page.text(), /Too many attempts\. Try again in 5 s\./);
    mock.timers.tick(5000);
    await page.settle();
    assert.equal(next.disabled, false);
    page.close();
    page = await openPage('setup', {
      handlers: handlers({ 'vault.status': () => earlierStatus({ backoffUntil: Date.now() + 30_000 }), 'vault.migrate': migrate }),
    });
    await page.click('[data-action="earlier-unlock"]');
    assert.equal(page.$('[data-action="earlier-continue"]').disabled, true);
    assert.match(page.text(), /Try again in 30 s/);
  });

  it('an earlier wallet that opens but holds no usable recovery phrase sends the user to Import', async () => {
    page = await openPage('setup', { handlers: handlers({ 'vault.status': () => earlierStatus(), 'vault.migrate': () => fail('VAULT_CORRUPT') }) });
    await page.click('[data-action="earlier-unlock"]');
    type(page.$('input[name="earlier-password"]'), OLD);
    await page.click('[data-action="earlier-continue"]');
    assert.match(page.text(), /The earlier wallet opened but holds no recovery phrase this version can use\. Import the wallet with its recovery phrase instead\./);
    await page.click('[data-action="import"]');
    assert.ok(page.$('textarea[name="phrase"]'));
  });

  it('Use my recovery phrase instead: Import, then the last screen offers to remove the earlier wallet behind one confirmation', async () => {
    let removed = null;
    page = await openPage('setup', {
      handlers: handlers({
        'vault.status': () => earlierStatus(),
        'vault.import': () => ({ ...ADDRESSES, lockDeadline: 1 }),
        'vault.removeEarlier': (params) => {
          removed = params;
          return { removed: true };
        },
      }),
    });
    await page.click('[data-action="import"]');
    type(page.$('textarea[name="phrase"]'), core.KAT.mnemonic);
    await page.click('[data-action="continue"]');
    await choosePassword();
    assert.match(page.text(), /Your wallet is ready/);
    assert.match(page.text(), /Wallet of the earlier version/);
    await page.click('[data-action="remove-earlier"]');
    assert.equal(removed, null, 'one confirmation first');
    assert.match(page.text(), /After this, that wallet opens only with its own recovery phrase\./);
    await page.click('[data-action="cancel-remove-earlier"]');
    assert.equal(removed, null, 'Cancel removes nothing');
    await page.click('[data-action="remove-earlier"]');
    await page.click('[data-action="confirm-remove-earlier"]');
    assert.deepEqual(removed, { confirm: 'REMOVE' });
    assert.match(page.text(), /The earlier version’s wallet was removed from this browser\./);
    assert.equal(page.$('[data-action="remove-earlier"]'), null);
    // a refusal (the session locked meanwhile) is said, and nothing is claimed
    page.close();
    page = await openPage('setup', {
      handlers: handlers({
        'vault.status': () => earlierStatus(),
        'vault.import': () => ({ ...ADDRESSES, lockDeadline: 1 }),
        'vault.removeEarlier': () => fail('LOCKED'),
      }),
    });
    await page.click('[data-action="import"]');
    type(page.$('textarea[name="phrase"]'), core.KAT.mnemonic);
    await page.click('[data-action="continue"]');
    await choosePassword();
    await page.click('[data-action="remove-earlier"]');
    await page.click('[data-action="confirm-remove-earlier"]');
    assert.doesNotMatch(page.text(), /was removed/);
    assert.ok(page.$('[data-action="confirm-remove-earlier"]'), 'still offered');
  });

  it('drops the checked earlier password after ten idle minutes, and empties the page storage 2.x left', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    page = await openPage('setup', {
      handlers: handlers({ 'vault.status': () => earlierStatus(), 'vault.migrate': migrate }),
      localStorage: { qnet_wallet_password_hash: 'cGFzc3dvcmRxbmV0X3NhbHRfMjAyNQ==', qnet_wallet_encrypted: 'e30=' },
    });
    assert.equal(page.localStorage.length, 0, 'the page storage 2.x left goes at once');
    await page.click('[data-action="earlier-unlock"]');
    type(page.$('input[name="earlier-password"]'), OLD);
    await page.click('[data-action="earlier-continue"]');
    assert.ok(page.$('input[name="new-password"]'));
    mock.timers.tick(10 * 60 * 1000);
    await page.settle();
    assert.ok(page.$('[data-action="earlier-unlock"]'), 'back on the first screen');
    assert.equal(page.$('input[name="new-password"]'), null);
  });
});
