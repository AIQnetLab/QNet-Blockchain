// Page helpers: ui/common.js (t, loadLocale, el, call, onWalletEvent, copyText, clearCopiedNow, holdToReveal,
// openSetup), ui/kit.js (amounts, addresses, errors, links) and the English strings table.
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PAYMENT_REQUEST, SOLANA, SUPPORTED_LANGUAGES, TIMINGS, UI_PAGES, VIEW_EVENT_CHANNEL } from '../dist/background/config.js';
import { ERROR_MESSAGES } from '../dist/background/errors.js';
import * as core from '../dist/lib/qnet-core.js';
import * as common from '../dist/ui/common.js';
import * as kit from '../dist/ui/kit.js';
import EN from '../dist/ui/i18n/en.js';
import { EXTENSION_ID, OTHER_EXTENSION_ID, createEvent } from './helpers/chrome-mock.mjs';
import { importApp } from './helpers/app-modules.mjs';
import { fire, installDom, type } from './helpers/ui-dom.mjs';

const BASE = `chrome-extension://${EXTENSION_ID}`;
const WORKER_SENDER = { id: EXTENSION_ID, url: `${BASE}/background/sw.js`, origin: BASE };

let dom;
let sent;
let reply;
let tabsCreated;
const savedFetch = globalThis.fetch;

beforeEach(() => {
  dom = installDom();
  sent = [];
  reply = null;
  tabsCreated = [];
  globalThis.chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path = '') => `${BASE}/${path}`,
      onMessage: createEvent(),
      sendMessage: async (message) => {
        sent.push(JSON.parse(JSON.stringify(message)));
        return typeof reply === 'function' ? reply(message) : reply;
      },
    },
    tabs: {
      create: async (props) => {
        tabsCreated.push(props);
        return { id: 9 };
      },
    },
  };
});

afterEach(async () => {
  mock.timers.reset();
  globalThis.fetch = async () => ({ ok: false });
  await common.loadLocale('en');
  globalThis.fetch = savedFetch;
  delete globalThis.chrome;
  dom.uninstall();
});

describe('ui common: text', () => {
  it('t() looks up the table, substitutes $1..$9, keeps $$ as a dollar and returns an unknown key as is', async () => {
    assert.equal(common.t('passwordTooShort', [8]), 'The password needs at least 8 characters.');
    assert.equal(common.t('passwordMinChars'), 'At least  characters', 'a missing substitution is empty');
    assert.equal(common.t('no_such_key'), 'no_such_key');
    assert.equal(common.t('minutes', ['$$1']), '$$1 min', 'a substituted value is not expanded again');
  });

  it('loadLocale() switches t(), the document language and direction; anything unknown is English', async () => {
    const root = globalThis.document.documentElement;
    await common.loadLocale('ru');
    assert.equal(common.currentLanguage(), 'ru');
    assert.equal(common.t('lockUnlock'), 'Разблокировать');
    assert.equal(common.t('passwordTooShort', [8]), 'Пароль должен содержать не менее 8 символов.');
    assert.equal(root.getAttribute('lang'), 'ru');
    assert.equal(root.getAttribute('dir'), 'ltr');
    await common.loadLocale('ar');
    assert.equal(root.getAttribute('dir'), 'rtl');
    assert.equal(common.t('lockButton'), 'قفل');
    for (const code of ['xx', 'EN', '../en', '__proto__', null]) {
      await common.loadLocale(code);
      assert.equal(common.currentLanguage(), 'en', String(code));
      assert.equal(common.t('lockUnlock'), EN.lockUnlock);
      assert.equal(root.getAttribute('dir'), 'ltr');
    }
    assert.ok(!SUPPORTED_LANGUAGES.includes('xx'));
  });

  it('the shipped messages.json files carry the manifest strings only', async () => {
    const shipped = JSON.parse(await readFile(new URL('../dist/_locales/en/messages.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(shipped).sort(), ['extDescription', 'extName']);
    for (const key of Object.keys(shipped)) assert.ok(!Object.hasOwn(EN, key), `${key} would shadow a UI key`);
  });
});

describe('ui common: DOM helpers', () => {
  it('el() builds text nodes only and refuses handler, style, srcdoc and script URLs', () => {
    const node = common.el('div', { className: 'a b', text: '<b>x</b>', attrs: { 'data-x': 1 } }, common.el('span', {}, 'child'), null, false);
    assert.equal(node.textContent, '<b>x</b>child');
    assert.equal(node.children.length, 1);
    assert.equal(node.getAttribute('data-x'), '1');
    assert.throws(() => common.el('div', { attrs: { onclick: 'x()' } }));
    assert.throws(() => common.el('div', { attrs: { style: 'color:red' } }));
    assert.throws(() => common.el('iframe', { attrs: { srcdoc: '<p>' } }));
    assert.throws(() => common.el('a', { attrs: { href: ' javascript:alert(1)' } }));
    assert.throws(() => common.el('img', { attrs: { src: 'data:image/png;base64,AA' } }));
    assert.equal(common.el('img', { attrs: { src: '../icons/icon-16.png' } }).getAttribute('src'), '../icons/icon-16.png');
  });

  it('hardenSecretInput and wipeInputs cover spellcheck, autofill, grammar tools and .value', () => {
    const root = common.el('div');
    const input = common.hardenSecretInput(common.el('input'));
    const area = common.hardenSecretInput(common.el('textarea'));
    root.append(input, common.el('p', {}, area));
    for (const [name, value] of [['spellcheck', 'false'], ['autocomplete', 'off'], ['autocapitalize', 'off'], ['autocorrect', 'off'],
      ['data-gramm', 'false'], ['data-gramm_editor', 'false'], ['data-enable-grammarly', 'false'], ['data-lt-active', 'false']]) {
      assert.equal(input.getAttribute(name), value);
      assert.equal(area.getAttribute(name), value);
    }
    input.value = 'secret';
    area.value = 'words';
    common.wipeInputs(root);
    assert.equal(input.value, '');
    assert.equal(area.value, '');
  });

  it('refuseFramed() throws inside a frame', () => {
    assert.doesNotThrow(() => common.refuseFramed());
    dom.window.top = {};
    assert.throws(() => common.refuseFramed(), /framed/);
  });

  it('shortAddress keeps both ends', () => {
    assert.equal(common.shortAddress('abcdefghijklmnopqrstuvwxyz', 4), 'abcd…wxyz');
    assert.equal(common.shortAddress('short', 4), 'short');
    assert.equal(common.shortAddress(null), '');
  });
});

describe('ui common: worker messages', () => {
  it('call() sends exactly {type, id, params} and maps the reply', async () => {
    reply = (message) => ({ id: message.id, ok: true, result: { fine: true } });
    assert.deepEqual(await common.call('vault.status'), { fine: true });
    assert.deepEqual(Object.keys(sent[0]).sort(), ['id', 'params', 'type']);
    assert.match(sent[0].id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.deepEqual(sent[0].params, {});
    await common.call('vault.status');
    assert.notEqual(sent[1].id, sent[0].id);

    reply = (message) => ({ id: message.id, ok: false, error: { code: 'BACKOFF', message: ERROR_MESSAGES.BACKOFF, retryAfterMs: 2000 } });
    await assert.rejects(common.call('vault.unlock', { password: 'x' }), (error) => error instanceof common.UiError
      && error.code === 'BACKOFF' && error.retryAfterMs === 2000 && error.message === ERROR_MESSAGES.BACKOFF);
    reply = () => ({ id: 'other', ok: true, result: 1 });
    await assert.rejects(common.call('vault.status'), (error) => error.code === 'INTERNAL');
    reply = () => {
      throw new Error('Could not establish connection');
    };
    await assert.rejects(common.call('vault.status'), (error) => error.code === 'INTERNAL');
  });

  it("onWalletEvent() accepts only this extension's worker", () => {
    const seen = [];
    const stop = common.onWalletEvent((event) => seen.push(event));
    const deliver = (message, sender) => globalThis.chrome.runtime.onMessage.dispatch(message, sender);
    deliver({ channel: VIEW_EVENT_CHANNEL, event: 'locked', data: null }, WORKER_SENDER);
    deliver({ channel: VIEW_EVENT_CHANNEL, event: 'locked' }, { ...WORKER_SENDER, tab: { id: 3 } });
    deliver({ channel: VIEW_EVENT_CHANNEL, event: 'locked' }, { ...WORKER_SENDER, id: OTHER_EXTENSION_ID });
    deliver({ channel: VIEW_EVENT_CHANNEL, event: 'locked' }, { id: EXTENSION_ID, url: 'https://aiqnet.io/' });
    deliver({ channel: VIEW_EVENT_CHANNEL, event: 'locked' }, { id: EXTENSION_ID, url: `${BASE}/ui/popup.html` });
    deliver({ channel: 'other', event: 'locked' }, WORKER_SENDER);
    deliver({ channel: VIEW_EVENT_CHANNEL, event: 'unlockEverything' }, WORKER_SENDER);
    assert.deepEqual(seen, ['locked']);
    stop();
    deliver({ channel: VIEW_EVENT_CHANNEL, event: 'wiped' }, WORKER_SENDER);
    assert.deepEqual(seen, ['locked']);
  });

  it('openSetup() opens ui/setup.html in a tab and closes the popup', async () => {
    await common.openSetup();
    assert.deepEqual(tabsCreated, [{ url: `${BASE}/${UI_PAGES.setup}` }]);
    assert.equal(dom.window.closed, true);
  });
});

describe('ui common: clipboard and reveal', () => {
  it('copyText() clears the clipboard after the delay when nothing else was copied and the page has focus', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    await common.copyText('QNET-L00000-000000-000000', { clearAfterMs: TIMINGS.CLIPBOARD_CLEAR_MS });
    assert.equal(dom.clipboard.text, 'QNET-L00000-000000-000000');
    mock.timers.tick(TIMINGS.CLIPBOARD_CLEAR_MS - 1);
    assert.equal(dom.clipboard.text, 'QNET-L00000-000000-000000');
    mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(dom.clipboard.text, '');

    await common.copyText('first', { clearAfterMs: 1000 });
    await common.copyText('an address');
    mock.timers.tick(1000);
    assert.equal(dom.clipboard.text, 'an address', 'a later copy is not cleared by the earlier timer');

    await common.copyText('second', { clearAfterMs: 1000 });
    dom.document.focused = false;
    mock.timers.tick(1000);
    assert.equal(dom.clipboard.text, 'second', 'without focus the page cannot write the clipboard');
    dom.document.focused = true;
    await common.copyText('');
    assert.equal(dom.clipboard.text, '', "copyText('') empties the clipboard");
    await assert.rejects(common.copyText(null));
  });

  it('copyText() with untilFocused clears on the next focus a copy the deadline found without the focus', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    await common.copyText('the recovery phrase', { clearAfterMs: TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS, untilFocused: true });
    dom.document.focused = false;
    mock.timers.tick(TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS);
    assert.equal(dom.clipboard.text, 'the recovery phrase', 'without focus the page cannot write the clipboard');
    dom.document.focused = true;
    fire(dom.window, 'focus');
    assert.equal(dom.clipboard.text, '', 'cleared as soon as the page has the focus again');

    // a later copy of this page is never cleared by the earlier copy's wait for the focus
    await common.copyText('the recovery phrase', { clearAfterMs: 1000, untilFocused: true });
    dom.document.focused = false;
    mock.timers.tick(1000);
    dom.document.focused = true;
    await common.copyText('an address');
    fire(dom.window, 'focus');
    assert.equal(dom.clipboard.text, 'an address');

    // without untilFocused the deadline without the focus gives up, as before
    await common.copyText('a code', { clearAfterMs: 1000 });
    dom.document.focused = false;
    mock.timers.tick(1000);
    dom.document.focused = true;
    fire(dom.window, 'focus');
    assert.equal(dom.clipboard.text, 'a code');
  });

  it('clearCopiedNow() empties a copy still waiting for its timer, and nothing else', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    await common.copyText('the recovery phrase', { clearAfterMs: TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS, untilFocused: true });
    common.clearCopiedNow();
    assert.equal(dom.clipboard.text, '');
    const writes = dom.clipboard.writes.length;
    common.clearCopiedNow();
    mock.timers.tick(TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS);
    assert.equal(dom.clipboard.writes.length, writes, 'nothing pending: no write, and the old timer writes nothing either');
    await common.copyText('an address');
    common.clearCopiedNow();
    assert.equal(dom.clipboard.text, 'an address', 'a copy without a timer is not cleared');
  });

  it('holdToReveal() shows the secret only while held and forgets it after the delay', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const control = common.el('button');
    const target = common.el('div');
    let expired = 0;
    const windowListeners = dom.window.listenerCount('blur');
    common.holdToReveal(control, target, 'word word word', { autoHideMs: 5000, placeholder: '•••', onExpire: () => { expired += 1; } });
    assert.equal(target.textContent, '•••');
    fire(control, 'pointerdown', { button: 0 });
    assert.equal(target.textContent, 'word word word');
    assert.equal(control.getAttribute('aria-pressed'), 'true');
    fire(control, 'pointerup');
    assert.equal(target.textContent, '•••');
    fire(control, 'pointerdown', { button: 2 });
    assert.equal(target.textContent, '•••', 'not on a right click');
    fire(control, 'keydown', { key: 'a' });
    assert.equal(target.textContent, '•••');
    fire(control, 'keydown', { key: 'Enter' });
    assert.equal(target.textContent, 'word word word');
    fire(control, 'keyup', { key: 'Enter' });
    fire(control, 'pointerdown', { button: 0 });
    fire(control, 'pointerleave');
    assert.equal(target.textContent, '•••');
    fire(control, 'pointerdown', { button: 0 });
    fire(dom.window, 'blur');
    assert.equal(target.textContent, '•••');
    fire(control, 'pointerdown', { button: 0 });
    dom.document.visibilityState = 'hidden';
    fire(dom.document, 'visibilitychange');
    assert.equal(target.textContent, '•••');
    dom.document.visibilityState = 'visible';

    fire(control, 'pointerdown', { button: 0 });
    mock.timers.tick(5000);
    assert.equal(expired, 1);
    assert.equal(target.textContent, '•••', 'hidden at expiry even while held');
    assert.equal(control.disabled, true);
    fire(control, 'pointerdown', { button: 0 });
    assert.equal(target.textContent, '•••');
    assert.equal(dom.window.listenerCount('blur'), windowListeners, 'listeners removed');
  });

  it('holdToReveal() dispose hides at once, never calls onExpire and uses the default delay otherwise', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const control = common.el('button');
    const target = common.el('div');
    let expired = 0;
    const dispose = common.holdToReveal(control, target, 'code', { onExpire: () => { expired += 1; } });
    fire(control, 'pointerdown', { button: 0 });
    assert.equal(target.textContent, 'code');
    dispose();
    assert.equal(target.textContent, '');
    fire(control, 'pointerdown', { button: 0 });
    assert.equal(target.textContent, '');
    mock.timers.tick(TIMINGS.REVEAL_AUTO_HIDE_MS);
    assert.equal(expired, 0);
  });
});

describe('ui kit', () => {
  it('canonicalAmount() accepts plain positive decimals only', () => {
    const cases = [
      ['1', 9, '1'], ['01.50', 9, '1.5'], ['.5', 9, '0.5'], ['1.', 9, '1'], [' 2 ', 9, '2'],
      ['0.000000001', 9, '0.000000001'], ['18446744073.709551615', 9, '18446744073.709551615'],
      ['0', 9, null], ['0.000', 9, null], ['1,5', 9, null], ['-1', 9, null], ['1e3', 9, null], ['', 9, null], ['.', 9, null],
      ['0.0000000001', 9, null], ['1.0000001', 6, null], ['18446744073.709551616', 9, null], ['1 000', 9, null],
    ];
    for (const [text, decimals, expected] of cases) assert.equal(kit.canonicalAmount(text, decimals), expected, text);
  });

  it('looksLikeKnownAddress() flags same-edges look-alikes only', () => {
    const known = 'AbCd1234567890efghWxYz';
    assert.equal(kit.looksLikeKnownAddress(known, [known]), false);
    assert.equal(kit.looksLikeKnownAddress('AbCd00000000000000WxYz', [known]), true);
    assert.equal(kit.looksLikeKnownAddress('AbCd00000WxYz', [known]), false);
    assert.equal(kit.looksLikeKnownAddress('ZbCd1234567890efghWxYz', [known]), false);
  });

  it('errorText() is the table text of the code, never the router message or a local exception text', () => {
    assert.equal(kit.errorText(new common.UiError('BACKOFF', { retryAfterMs: 1500 })), 'Too many attempts. Try again in 2 s.');
    assert.equal(kit.errorText(new common.UiError('BAD_PASSWORD', { message: ERROR_MESSAGES.BAD_PASSWORD })), EN.err_BAD_PASSWORD);
    assert.equal(kit.errorText(new common.UiError('NODE_REJECTED', { message: 'from the router' })), EN.err_NODE_REJECTED);
    assert.equal(kit.codeText('err_INTERNAL'), EN.err_INTERNAL);
    assert.equal(kit.codeText('__proto__'), EN.err_INTERNAL);
    assert.equal(kit.errorText(new common.UiError('BURN_EXISTS', { message: ERROR_MESSAGES.BURN_EXISTS })), EN.err_BURN_EXISTS);
    assert.equal(kit.errorText(new Error('seed abandon abandon')), EN.err_INTERNAL);
    assert.equal(kit.errorText(new common.UiError('SOMETHING_NEW')), EN.err_INTERNAL);
    assert.equal(kit.errorCode(new TypeError('x')), 'INTERNAL');
  });

  // The rule of both wallets: at least 8 characters, typed twice, nothing else (owner decision of 2026-09-28).
  it('newPasswordFields() turns the length line from × to ✓, says whether the two match and reads only that', () => {
    const fresh = kit.newPasswordFields(core);
    const [, length, , match] = fresh.nodes;
    const message = kit.messageLine();
    assert.equal(length.textContent, '× At least 8 characters');
    assert.equal(length.className, 'hint');
    assert.equal(match.className, 'hint hidden');
    type(fresh.first, 'seven77');
    assert.equal(length.textContent, '× At least 8 characters');
    assert.equal(fresh.read(message), null);
    assert.equal(message.node.textContent, 'The password needs at least 8 characters.');
    type(fresh.first, '12345678');
    assert.equal(length.textContent, '✓ At least 8 characters');
    assert.equal(length.className, 'hint hint-ok');
    type(fresh.second, '1234567');
    assert.equal(match.textContent, 'Passwords do not match');
    assert.equal(match.className, 'hint hint-bad');
    assert.equal(fresh.read(message), null);
    assert.equal(message.node.textContent, 'Passwords do not match');
    assert.equal(fresh.second.value, '');
    assert.equal(match.className, 'hint hidden');
    type(fresh.second, '12345678');
    assert.equal(match.textContent, '✓ Passwords match');
    assert.equal(match.className, 'hint hint-ok');
    assert.equal(fresh.read(message), '12345678', 'no other check: a short common password of 8 is taken');
    fresh.first.value = '';
    fresh.second.value = '';
    fresh.refresh();
    assert.equal(length.textContent, '× At least 8 characters');
    assert.equal(match.className, 'hint hidden');
  });

  it('addressText() sets the first and last six characters apart', () => {
    const node = kit.addressText('ABCDEF0123456789uvwxyz');
    assert.deepEqual(node.children.map((child) => [child.className, child.textContent]),
      [['addr-edge', 'ABCDEF'], ['addr-mid', '0123456789'], ['addr-edge', 'uvwxyz']]);
    assert.equal(node.textContent, 'ABCDEF0123456789uvwxyz');
  });

  it('kvList() gives a whole address the full width of the list below its label; other values stay beside theirs', () => {
    const list = kit.kvList([
      ['Amount', '1 QNC'],
      ['To', kit.addressText(core.KAT.qnetAddress)],
      ['From', kit.addressCopy(core.KAT.solanaAddress, 'Solana address')],
    ]);
    assert.deepEqual(list.children.map((child) => [child.localName, child.className]), [
      ['dt', ''], ['dd', ''],
      ['dt', 'kv-wide'], ['dd', 'kv-wide kv-addr'],
      ['dt', 'kv-wide'], ['dd', 'kv-wide kv-addr'],
    ]);
  });

  it('opens https pages only and builds explorer links for the build cluster', () => {
    kit.openTab('https://aiqnet.io/x');
    kit.openTab(`${'http'}://aiqnet.io/x`);
    kit.openTab('javascript:alert(1)');
    kit.openTab('not a url');
    assert.deepEqual(tabsCreated, [{ url: 'https://aiqnet.io/x' }]);
    assert.equal(kit.qnetTxUrl('a/b'), 'https://aiqnet.io/explorer/tx/a%2Fb');
    assert.equal(kit.solanaTxUrl('Sig'), 'https://explorer.solana.com/tx/Sig?cluster=devnet');
  });

  it('whileBusy() disables the controls while the task runs, even when it fails; countdown() ticks to done', async () => {
    const control = common.el('button');
    await assert.rejects(kit.whileBusy([control], async () => {
      assert.equal(control.disabled, true);
      throw new Error('x');
    }));
    assert.equal(control.disabled, false);
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
    const ticks = [];
    let done = false;
    kit.countdown(4000, (seconds) => ticks.push(seconds), () => { done = true; });
    for (let second = 0; second < 3; second += 1) mock.timers.tick(1000);
    assert.deepEqual(ticks, [3, 2, 1]);
    assert.equal(done, true);
  });
});

// A whole address on one line (owner, 29.09): the popup's boxes and the type size of popup.css, as arithmetic. The
// headless check (scripts/overflow-check.mjs) measures the rendered lines in every language.
describe('ui kit: a whole address on one line', () => {
  // The longest address (QNet; Solana has at most 44), the widest advance in the monospace list (--font-mono) in em,
  // a classic scrollbar beside a scrolling screen, and the smallest type the popup may use.
  const LONGEST = 45;
  const ADVANCE_EM = 0.602;
  const SCROLLBAR_PX = 17;
  const FLOOR_PX = 10.5;
  const read = async (file) => (await readFile(new URL(`../dist/ui/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  // the declarations of every rule whose whole selector is `selector` (not one entry of a longer list)
  const block = (css, selector) => {
    const head = `\n${selector} {\n`;
    const bodies = [];
    for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + 1)) {
      if (css[at - 1] !== ',') bodies.push(css.slice(at + head.length - 1, css.indexOf('\n}', at)));
    }
    assert.ok(bodies.length > 0, `${selector} in the stylesheet`);
    return bodies.join('\n');
  };
  const has = (css, selector, declaration) => assert.ok(block(css, selector).includes(`  ${declaration};`), `${selector}: ${declaration}`);

  it('the address takes the type size at which 45 characters fill its box, within the popup at 360 px with or without a scrollbar', async () => {
    const css = await read('popup.css');
    // the boxes a whole address sits in, and their gutters
    has(css, 'body.page-popup', 'width: 360px');
    has(css, '.tab-body', 'padding: 14px 12px 64px');
    has(css, '.screen-pad', 'padding: 20px 12px');
    for (const box of ['.card', '.kv', '.addr-box']) {
      assert.match(block(css, box), /\n {2}padding: (?:10px )?12px;/, `${box}: 12 px at the sides`);
      assert.match(block(css, box), /\n {2}border: 1px solid/, `${box}: 1 px border`);
    }
    // the copy control reaches 5 px into the box's padding (in a list, through its row) and keeps 4 px of its own
    has(css, '.account-address', 'width: calc(100% + 10px)');
    has(css, '.account-address', 'margin: 0 -5px');
    has(css, '.account-address', 'padding: 6px 4px');
    has(css, '.account-address', 'border: 1px solid transparent');
    has(css, '.kv dd.kv-addr:has(> .account-address)', 'margin-inline: -5px');
    has(css, '.kv dd.kv-addr > .account-address', 'width: 100%');
    // the size container and the type size
    has(css, '.account-address,\n.kv dd.kv-addr', 'container-type: inline-size');
    const fit = block(css, '.account-address .addr,\n.kv-addr .addr');
    const [, min, ratio, max] = /\n {2}font-size: clamp\(([\d.]+)px, 100cqi \/ ([\d.]+), ([\d.]+)px\);/.exec(fit) ?? [];
    assert.ok(min && ratio && max, 'font-size: clamp(<floor>px, 100cqi / <ratio>, <cap>px)');
    assert.equal(Number(min), FLOOR_PX);
    assert.ok(Number(ratio) >= LONGEST * ADVANCE_EM, `${ratio} em holds ${LONGEST} characters of ${ADVANCE_EM} em`);
    assert.ok(!/white-space: nowrap/.test(fit), 'a box too narrow for the floor wraps the address instead of spilling it');

    const box = 360 - 2 * 12 - 2 * (12 + 1);
    const control = box + 2 * 5 - 2 * (1 + 4);
    assert.equal(box, 310);
    assert.equal(control, box, 'the copy control keeps the full width of its box');
    for (const width of [box, box - SCROLLBAR_PX]) {
      const size = Math.min(Number(max), Math.max(Number(min), width / Number(ratio)));
      assert.ok(width / Number(ratio) >= FLOOR_PX, `${width} px: the floor is not reached (${size.toFixed(2)} px)`);
      assert.ok(LONGEST * ADVANCE_EM * size <= width, `${width} px: 45 characters at ${size.toFixed(2)} px fit`);
    }
  });

  it('the approval window sizes its address blocks the same way, and they fit its narrowest width', async () => {
    const css = await read('approve.css');
    const popup = await read('popup.css');
    const [, ratio] = /font-size: clamp\([\d.]+px, 100cqi \/ ([\d.]+), [\d.]+px\);/.exec(popup);
    has(css, '.ap-card', 'container-type: inline-size');
    has(css, '.ap-address', `font-size: clamp(${FLOOR_PX}px, 100cqi / ${ratio}, 13px)`);
    has(css, '.page-approve #app', 'padding: 16px');
    const card = 360 - 2 * 16 - 2 * (12 + 1);
    const size = card / Number(ratio);
    assert.ok(size >= FLOOR_PX && LONGEST * ADVANCE_EM * size <= card, `${card} px card: ${size.toFixed(2)} px`);
  });

  it('the setup tab\'s column takes the tab\'s width: an address, a size container, gives it none of its own', async () => {
    const css = await read('setup.css');
    has(css, '.page-setup #app', 'width: 100%');
    has(css, '.page-setup #app', 'max-width: 640px');
  });
});

// The Solana send's recipient field: a plain address, or a payment request read as the app reads one (owner, 29.09):
// amount, token, references and memo go into the send, label and message are shown as text.
describe('ui kit: the Solana recipient and payment request', () => {
  const A = core.KAT.solanaAddress;
  const MINT = SOLANA.ONE_DEV_MINT;
  const REF = [1, 2, 3, 4, 5].map((n) => core.solanaAddressFromPublicKey(new Uint8Array(32).fill(0x60 + n)));
  const parse = (text) => kit.parseSolanaRecipient(text, core.isValidSolanaAddress);
  const none = { amount: null, mint: null, references: [], memo: null, label: null, message: null };
  const plain = (address) => ({ ok: true, request: false, address, ...none });
  const request = (fields) => ({ ok: true, request: true, address: A, ...none, ...fields });
  const refused = (reason) => ({ ok: false, reason });

  it('takes a plain address as it is, trimmed', () => {
    assert.deepEqual(parse(A), plain(A));
    assert.deepEqual(parse(`  ${A}\n`), plain(A));
    assert.deepEqual(parse(MINT), plain(MINT));
  });

  it('takes a payment request: amount, token, references, memo, label and message in any order, form-decoded', () => {
    assert.deepEqual(parse(`solana:${A}`), request({}));
    assert.deepEqual(parse(`SOLANA:${A}?`), request({}), 'the scheme in any case, an empty query');
    assert.deepEqual(parse(`solana:${A}?amount=1.5`), request({ amount: '1.5' }));
    assert.deepEqual(parse(`solana:${A}?message=Thanks%21&spl-token=${MINT}&reference=${REF[0]}&amount=0.000001&memo=order-7`
      + `&reference=${REF[1]}&label=Caf%C3%A9%20%2B%20bar&`),
    request({ amount: '0.000001', mint: MINT, references: [REF[0], REF[1]], memo: 'order-7', label: 'Café + bar', message: 'Thanks!' }));
    assert.deepEqual(parse(`solana:${A}?label=&message=`), request({}), 'an empty label or message is none');
    // form encoding, as request generators write it: '+' is a space and %2B a plus, in names too
    assert.deepEqual(parse(`solana:${A}?memo=order+42%2B1&label=a+b`), request({ memo: 'order 42+1', label: 'a b' }));
    assert.deepEqual(parse(`solana:${A}?spl%2Dtoken=${MINT}&%61mount=2`), request({ mint: MINT, amount: '2' }));
    // the site's own payment request, SOL and 1DEV
    assert.deepEqual(parse(`solana:${A}?amount=1500&spl-token=${MINT}&label=QNet%20activation`),
      request({ amount: '1500', mint: MINT, label: 'QNet activation' }));
    assert.deepEqual(parse(`solana:${A}?amount=0.001&label=QNet%20activation`), request({ amount: '0.001', label: 'QNet activation' }));
  });

  it('any other part is ignored; a label or message given twice shows the first', () => {
    for (const part of ['redirect=x', 'AMOUNT=1', 'Label=x', 'spl_token=x', 'references=x', 'unknown', 'x=%20']) {
      assert.deepEqual(parse(`solana:${A}?amount=1&${part}`), request({ amount: '1' }), part);
    }
    assert.deepEqual(parse(`solana:${A}?label=a&label=b&message=c&message=d`), request({ label: 'a', message: 'c' }));
  });

  it('amounts: a plain decimal of up to 20 whole and 30 fraction digits as written; zero asks for none; anything else is refused', () => {
    for (const amount of ['1', '10', '0.5', '1.50', '01', '0010.500000', '0.000000001', `1.${'0'.repeat(29)}1`, '12345678901234567890']) {
      assert.deepEqual(parse(`solana:${A}?amount=${amount}`), request({ amount }), amount);
    }
    for (const amount of ['0', '00', '0.000']) assert.deepEqual(parse(`solana:${A}?amount=${amount}`), request({}), amount);
    assert.deepEqual(parse(`solana:${A}?amount=%31`), request({ amount: '1' }));
    for (const amount of ['', '.5', '1.', '1e3', '-1', '+1', '1%2B1', '1,5', '1%20000', '0x10', 'Infinity', 'NaN', '1.5.1',
      '123456789012345678901', `1.${'0'.repeat(30)}1`]) {
      assert.deepEqual(parse(`solana:${A}?amount=${amount}`), refused('amount'), amount);
    }
    assert.deepEqual(parse(`solana:${A}?amount`), refused('amount'), 'a part with no value is an empty one');
  });

  it('references: up to four distinct addresses, in order; a fifth, a repeat or one that is no address refuses the request', () => {
    const refs = (list) => list.map((r) => `reference=${r}`).join('&');
    assert.deepEqual(parse(`solana:${A}?${refs(REF.slice(0, 4))}`), request({ references: REF.slice(0, 4) }));
    assert.deepEqual(parse(`solana:${A}?reference=${A}`), request({ references: [A] }), 'the recipient itself is an address');
    for (const query of [refs(REF), refs([REF[0], REF[1], REF[0]]), 'reference=bad', 'reference=', `reference=${REF[0]}x`,
      `reference=${encodeURIComponent(` ${REF[0]}`)}`]) {
      assert.deepEqual(parse(`solana:${A}?${query}`), refused('invalid'), query);
    }
  });

  it('memo: at most 200 bytes of UTF-8, not empty, with no control or bidi mark; given twice it refuses the request', () => {
    const memo = (text) => parse(`solana:${A}?memo=${encodeURIComponent(text)}`);
    for (const text of ['x'.repeat(200), 'é'.repeat(100), '😀'.repeat(50), ' ', 'a​b', '<a href="https://pay.example.test">x</a>']) {
      assert.deepEqual(memo(text), request({ memo: text }), text.slice(0, 20));
    }
    for (const text of ['', 'x'.repeat(201), 'é'.repeat(100) + 'x', '😀'.repeat(50) + 'x', 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b',
      'a‮b', 'a⁦b', 'a‎b', 'a؜b']) {
      assert.deepEqual(memo(text), refused('invalid'), JSON.stringify(text.slice(0, 20)));
    }
    assert.deepEqual(parse(`solana:${A}?memo=a&memo=a`), refused('invalid'));
    // a lone surrogate (only pasted text can hold one; percent-encoding cannot) is refused: its UTF-8 would be U+FFFD,
    // not the text shown. Both wallets refuse it (CONTRACTS.md decision 34).
    assert.deepEqual(parse(`solana:${A}?memo=a\uD800b`), refused('invalid'));
  });

  it('refuses a once-only part given twice, a bad token mint, and anything that is not a request', () => {
    assert.deepEqual(parse(`solana:${A}?amount=1&amount=1`), refused('invalid'));
    assert.deepEqual(parse(`solana:${A}?spl-token=${MINT}&spl-token=${MINT}`), refused('invalid'));
    for (const mint of ['', 'nope', 'O0Il', `${MINT}x`]) assert.deepEqual(parse(`solana:${A}?spl-token=${mint}`), refused('token'), mint);
    assert.deepEqual(parse(`solana:${A}?label=%E0%A4%A`), refused('invalid'), 'broken percent-encoding');
    assert.deepEqual(parse(`solana:${A}?x%ZZ=1`), refused('invalid'), 'broken percent-encoding in an ignored part too');
    for (const text of ['', '   ', 'hello', 'solana:', 'solana:?amount=1', `solana:${A}/x`, `solana://${A}`, `solana: ${A}`,
      'solana:https://pay.example.test/request', 'solana:https%3A%2F%2Fpay.example.test', `wallet:${A}`, `${A}?amount=1`,
      core.KAT.qnetAddress, A.slice(0, 20), `solana:${A}?amount=1`.padEnd(2049, 'x'), ` ${A}`.padEnd(2049, ' '), null, undefined, 42, {}]) {
      assert.deepEqual(parse(text), refused('invalid'), String(text).slice(0, 40));
    }
  });

  it('a label or message is plain text: controls, zero-width and bidi characters out, spaces folded, cut at 200 characters', () => {
    const hidden = ['%00', '%07', '%0A', '%1F', '%7F', '%C2%85', '%C2%AD', '%E2%80%8B', '%E2%80%8E', '%E2%80%AE', '%E2%81%A6', '%E2%81%A9',
      '%EF%BB%BF', '%E2%80%A8', '%D8%9C'];
    const parsed = parse(`solana:${A}?label=${hidden.map((c) => `a${c}`).join('')}b&message=%20%20x%09%09y%20`);
    assert.equal(parsed.label, `${'a '.repeat(hidden.length)}b`);
    assert.equal(parsed.message, 'x y');
    assert.equal(parse(`solana:${A}?label=%E2%80%AE%E2%80%8B`).label, null, 'nothing visible is none');
    const long = parse(`solana:${A}?message=${encodeURIComponent('é'.repeat(250))}`).message;
    assert.equal(long, `${'é'.repeat(200)}…`);
    const emoji = parse(`solana:${A}?label=${encodeURIComponent(`${'a'.repeat(199)}😀😀`)}`).label;
    assert.equal(emoji, `${'a'.repeat(199)}😀…`, 'cut by characters, never inside one');
    assert.equal(parse(`solana:${A}?label=${encodeURIComponent('<a href="https://pay.example.test">x</a>')}`).label,
      '<a href="https://pay.example.test">x</a>', 'returned as text for textContent, never parsed');
  });

  it('a validator that throws or answers anything but true is no address', () => {
    assert.deepEqual(kit.parseSolanaRecipient(A, () => {
      throw new Error('boom');
    }), refused('invalid'));
    assert.deepEqual(kit.parseSolanaRecipient(`solana:${A}`, () => 'yes'), refused('invalid'));
  });

  // The app's own reader (applications/qnet-mobile/src/utils/solanaRequest.js), imported read-only: every text of this
  // corpus is taken or refused by both, and what is taken is the same recipient, amount, mint, references and memo.
  it('reads every request as the app does', async (t) => {
    const app = await importApp('utils/solanaRequest.js');
    if (app === null) {
      t.skip('the app\'s modules do not load in this checkout (its dependencies are not installed)');
      return;
    }
    assert.equal(app.MAX_REFERENCES, PAYMENT_REQUEST.REFERENCES_MAX);
    assert.equal(app.MAX_MEMO_BYTES, PAYMENT_REQUEST.MEMO_MAX_BYTES);
    const refs = (n) => REF.slice(0, n).map((r) => `reference=${r}`).join('&');
    const corpus = [
      A, ` ${A}\n`, MINT, `solana:${A}`, `SOLANA:${A}?`, `solana:${A}?amount=12.5&spl-token=${MINT}&${refs(2)}&memo=order%2042&label=x`,
      `solana:${A}?amount=1500&spl-token=${MINT}&label=QNet%20activation`, `solana:${A}?amount=0.001&label=QNet%20activation`,
      `solana:${A}?memo=order+42%2B1`, `solana:${A}?spl%2Dtoken=${MINT}`, `solana:${A}?${refs(4)}`, `solana:${A}?${refs(5)}`,
      `solana:${A}?reference=${REF[0]}&reference=${REF[0]}`, `solana:${A}?reference=bad`, `solana:${A}?memo=${'x'.repeat(200)}`,
      `solana:${A}?memo=${'x'.repeat(201)}`, `solana:${A}?memo=${encodeURIComponent('é'.repeat(100))}`,
      `solana:${A}?memo=${encodeURIComponent(`${'é'.repeat(100)}x`)}`, `solana:${A}?memo=`, `solana:${A}?memo=a%0Ab`,
      `solana:${A}?memo=a%E2%80%AEb`, `solana:${A}?memo=a&memo=b`, `solana:${A}?amount=1&amount=2`, `solana:${A}?amount=0`,
      `solana:${A}?amount=0.000`, `solana:${A}?amount=01`, `solana:${A}?amount=1e3`, `solana:${A}?amount=.5`, `solana:${A}?amount=`,
      `solana:${A}?amount=1%2B1`, `solana:${A}?amount=${'1'.repeat(21)}`, `solana:${A}?amount=1.${'0'.repeat(30)}`,
      `solana:${A}?amount=1.${'0'.repeat(31)}`, `solana:${A}?spl-token=nope`, `solana:${A}?spl-token=${MINT}&spl-token=${MINT}`,
      `solana:${A}?label=a&label=b&unknown=1`, `solana:${A}?label=%E0%A4%A`, 'solana:https://pay.example.test/tx',
      'solana:https%3A%2F%2Fpay.example.test', `solana:${A}x`, 'solana:', `wallet:${A}`, core.KAT.qnetAddress, 'hello world', '',
      `solana:${A}?memo=${'x'.repeat(3000)}`,
    ];
    for (const text of corpus) {
      const ours = parse(text);
      const theirs = app.parseSolanaScan(text);
      assert.equal(ours.ok, theirs.ok, text.slice(0, 60));
      if (!ours.ok) continue;
      const { address, amount, mint, references, memo, request: isRequest } = ours;
      assert.deepEqual({ address, amount, mint, references, memo, request: isRequest },
        { address: theirs.address, amount: theirs.amount, mint: theirs.mint, references: theirs.references, memo: theirs.memo,
          request: theirs.request }, text.slice(0, 60));
    }
  });
});
