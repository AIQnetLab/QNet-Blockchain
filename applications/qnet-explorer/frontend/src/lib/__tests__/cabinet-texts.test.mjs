// The site's texts (src/lib/texts.ts), English only: the node cabinet, the link page and the Support page. The
// {placeholder} filling and English numbers, the words shared with the app and the extension in their English, no
// word for earnings, the Support page's in-app part free of platforms and activation, every key a page uses, and no
// language switch, locale choice or right-to-left handling anywhere; then the cabinet's button and card system at
// phone and tablet widths, the wallet choice kept in the browser, the one reading of a node's state, and the
// balance in English digits. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { TEXTS, format, number, pageTitle, t, templateParts } from '../texts.ts';
import { WALLET_KEY, choiceView, clearChoice, isHeldWallet, loadChoice, ownSolanaOf, parseChoice, saveChoice } from '../cabinet/wallet-choice.ts';
import { canMove, formatQnc, formatUnits, nodeState } from '../cabinet/node-view.ts';

const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const SRC = new URL('../../', import.meta.url);
const REPO = new URL('../../../../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
// Typography that is not wording: curly or straight apostrophes, the extension's soft hyphens, case.
const norm = (s) => s.replace(/­/g, '').replace(/[’']/g, "'").toLowerCase();
const APP = (await import(new URL('applications/qnet-mobile/src/i18n/locales/en.js', REPO).href)).default;
const EXT = (await import(new URL('applications/qnet-wallet/dist/ui/i18n/en.js', REPO).href)).default;
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const sources = (dir) => readdirSync(new URL(dir, SRC), { recursive: true })
  .map((n) => `${dir}${n.replace(/\\/g, '/')}`)
  .filter((n) => /\.(tsx?|css)$/.test(n) && !n.includes('__tests__') && !n.includes('__release__'));

test('placeholders are filled by name, numbers are English, a sentence splits around its links', () => {
  assert.equal(format('Node balance: {amount} QNC', { amount: '1.5' }), 'Node balance: 1.5 QNC');
  assert.equal(format('{a} of {b}', { a: 1 }), '1 of {b}');
  assert.equal(format('{constructor}', {}), '{constructor}');
  assert.equal(t('balance', { amount: '12.5' }), 'Node balance: 12.5 QNC');
  assert.equal(t('counted', { counted: 3, total: 64 }), 'Counted epochs: 3 of the last 64');
  // A key looked up by code that has no text shows as the key itself.
  assert.equal(t('link_error_NOPE'), 'link_error_NOPE');
  assert.equal(number(1234567), '1,234,567');
  assert.equal(number(18446744073709551615n), '18,446,744,073,709,551,615');
  assert.equal(pageTitle('activate_title', 'cabinet_title'), `${TEXTS.activate_title} - My node - QNet`);
  assert.deepEqual(templateParts('Install it (see {walletPage}), then {nodePage}.'), ['Install it (see ', { name: 'walletPage' }, '), then ', { name: 'nodePage' }, '.']);
  assert.deepEqual(templateParts('{a}'), [{ name: 'a' }]);
});

test('every text is trimmed, with no stray braces or doubled spaces', () => {
  assert.ok(Object.keys(TEXTS).length > 300);
  for (const [key, text] of Object.entries(TEXTS)) {
    assert.ok(typeof text === 'string' && text.trim() === text && text.length > 0, key);
    assert.doesNotMatch(text.replace(/\{\w+\}/g, 'X'), /[{}]|undefined|\s{2}/, key);
  }
  // Nothing is left of the language menu.
  assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, 'lang_label'), false);
});

test('the words shared with QNet Wallet are the app\'s own English', () => {
  const label = (s) => s.replace(/\s*:$/, '');
  const same = (site, appText, key) => assert.equal(norm(site), norm(appText), key);
  same(TEXTS.no_node, APP.node_none, 'no_node');
  same(TEXTS.no_device, APP.node_no_device, 'no_device');
  same(TEXTS.badge_online, APP.node_status_online, 'badge_online');
  same(TEXTS.badge_offline, APP.node_status_offline, 'badge_offline');
  same(TEXTS.action_move, APP.node_move, 'action_move');
  if (APP.node_move_min !== undefined) same(TEXTS.balance_min, APP.node_move_min, 'balance_min');
  same(TEXTS.ui_app_node_tab, APP.tab_node, 'ui_app_node_tab');
  same(TEXTS.claim_title, label(APP.node_balance), 'claim_title');
  same(TEXTS.ext_type_light, APP.node_title_light, 'ext_type_light');
  same(TEXTS.ext_type_super, APP.node_title_super, 'ext_type_super');
  same(TEXTS.wallet_enter_label, APP.link_qnet_address, 'wallet_enter_label');
  same(TEXTS.act_refund_label, APP.link_solana_address, 'act_refund_label');
  same(TEXTS.cancel, APP.cancel, 'cancel');
  same(TEXTS.copied, APP.common_copied, 'copied');
  same(TEXTS.try_again, APP.common_try_again, 'try_again');
  assert.ok(norm(APP.node_unreachable).startsWith(norm(TEXTS.unreachable)), 'unreachable');
  // A device that cannot prove its hardware: the page quotes the app's own sentence (light-node-messages section 1).
  for (const key of ['link_error_BIND_REFUSED', 'act_done_device']) assert.ok(norm(TEXTS[key]).includes(norm(APP.node_cant_run)), key);
  assert.ok(norm(TEXTS.balance).startsWith(norm(APP.node_balance)), 'balance');
  for (const [key, value] of [['answered_yes', APP.node_answered_yes_untimed], ['answered_no', APP.node_answered_no]]) {
    assert.ok(norm(TEXTS[key]).startsWith(norm(APP.node_answered)) && norm(TEXTS[key]).endsWith(norm(value)), key);
  }
  // The app's label and count. A genesis counts over the epochs it indexed, the last 64 at most, so neither the app
  // nor the page says "since registration".
  same(TEXTS.counted, `${APP.node_counted} ${APP.node_counted_last.replace('{n}', '{counted}').replace('{m}', '{total}')}`, 'counted');
  assert.doesNotMatch(TEXTS.counted, /since registration/);
  // Unified plan section 3.1: the English of the words the app and the cabinet share.
  assert.equal(TEXTS.no_node, 'This wallet has no node.');
  assert.equal(TEXTS.no_device, 'The node does not run on any device now.');
  assert.equal(TEXTS.badge_online, 'Online');
  assert.equal(TEXTS.badge_offline, 'Offline');
  assert.equal(TEXTS.answered_no, 'Answered this epoch: Not yet');
  assert.equal(TEXTS.counted, 'Counted epochs: {counted} of the last {total}');
  assert.deepEqual(placeholders(TEXTS.counted), ['counted', 'total']);
  assert.equal(TEXTS.balance, 'Node balance: {amount} QNC');
  assert.equal(TEXTS.action_move, 'Move to wallet');
  assert.equal(TEXTS.balance_min, 'The node balance can be moved to the wallet once it reaches 1 QNC.');
  assert.equal(TEXTS.action_link_device, 'Link a device');
  assert.equal(TEXTS.unreachable, 'The QNet network could not be reached.');
  assert.equal(TEXTS.eligibility, 'A light node runs on one phone or tablet at a time, in QNet Wallet; a super node runs on a server with the QNet node software.');
});

test('the extension\'s buttons, tabs and fields are named as the extension names them', () => {
  const has = (text, part, what) => assert.ok(norm(text).includes(norm(part)), what);
  for (const key of ['code_no_registration']) has(TEXTS[key], EXT.recordButton, key);
  // The extension's own "Recover my code" (XC-09), named only where its Activate tab shows it: beside a check that could
  // not finish. Elsewhere the code is simply on that tab once known (it finds a burn of the wallet by itself), so those
  // texts send there, not to a button.
  has(TEXTS.check_solana, `"${EXT.recoverButton}"`, 'check_solana');
  for (const key of ['ext_fact_recover', 'ext_lead_pending', 'ext_in_flight']) {
    has(TEXTS[key], `${EXT.tab_activate} tab`, key);
    assert.ok(!norm(TEXTS[key]).includes(norm(EXT.recoverButton)), key);
  }
  // The step that runs a light node reads "Link a device", the extension's and QNet Wallet's word for it.
  assert.equal(TEXTS.progress_link, TEXTS.action_link_device);
  for (const key of ['ext_failure_timeout', 'ext_failure_failed', 'ext_failure_unverifiable']) has(TEXTS[key], EXT.tab_activate, key);
  assert.equal(norm(TEXTS.act_code), norm(EXT.codeLabel), 'act_code');
});

test('no text speaks of earnings: the node balance is what it is', () => {
  for (const [key, text] of Object.entries(TEXTS)) assert.doesNotMatch(text, /reward|\bmining\b|\bearn|\bincome\b|\bprofit/i, key);
});

// The page as the QNet app's view renders it: every `{full && …}` block (shown only outside that view) removed.
function inAppView(src) {
  let out = src;
  for (;;) {
    const at = out.indexOf('{full && ');
    if (at < 0) return out;
    let depth = 0;
    let end = at;
    for (; end < out.length; end++) {
      if (out[end] === '{') depth++;
      else if (out[end] === '}' && --depth === 0) break;
    }
    assert.ok(end < out.length, 'balanced guard');
    out = out.slice(0, at) + out.slice(end + 1);
  }
}
const keysIn = (src) => [...src.matchAll(/\b(?:t|rich)\('([a-z0-9_]+)'/g)].map((m) => m[1]);

test('the Support page in the app\'s view names no platform and points to no activation', () => {
  const page = code('app/support/page.tsx');
  // Owner, 04.10: self-service only; the page renders no review request.
  assert.doesNotMatch(page, /SupportRequest/);
  const shown = new Set(keysIn(inAppView(page)));
  const hidden = keysIn(page).filter((k) => !shown.has(k));
  assert.deepEqual(hidden.sort(), ['support_contact_bugs', 'support_contact_bugs_link', 'support_contact_community', 'support_contact_docs', 'support_epochs_android', 'support_epochs_apple', 'support_epochs_wake', 'support_epochs_wake_link', 'support_move', 'support_move_title', 'support_move_wallet_link']);
  for (const key of shown) {
    assert.doesNotMatch(TEXTS[key], /iPhone|iPad|Android|\biOS\b|aiqnet\.io\/(docs|activate)|\/node\b/, key);
    assert.doesNotMatch(TEXTS[key], /activat|\bburn|1DEV/i, key);
  }
  for (const key of keysIn(page)) assert.ok(key.startsWith('support_'), key);
  // No review step anywhere on the site: what the user does is move the node to another device.
  for (const [key, text] of Object.entries(TEXTS).filter(([k]) => !/^support_(form|case)_/.test(k))) {
    assert.doesNotMatch(text, /a person reviews|ask for a review|appeal/i, key);
  }
  assert.match(TEXTS.support_device_lead, /run it on another phone or tablet: install QNet Wallet there from the app store, open this wallet with its recovery phrase and tap Use this device on the Node tab\./);
});

test('every key a page uses has its text, and they show text only through it', () => {
  const used = new Set();
  const files = [...readdirSync(new URL('components/cabinet/', SRC)).map((n) => `components/cabinet/${n}`), 'app/support/page.tsx', 'components/SupportRequest.tsx', 'app/l/page.tsx', 'app/l/LinkButtons.tsx'];
  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(/\b(?:t|rich)\('([a-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/(?:label|title): '([a-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/title="([a-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/return '([a-z0-9_]+)';/g)) used.add(m[1]);
    for (const m of text.matchAll(/: '((?:history|support_case)_[a-z_]+)'/g)) used.add(m[1]);
    // No English sentence written into a component: every text node is a {t(...)} or a formatted value.
    assert.doesNotMatch(text, />[A-Z][a-z]+ [a-z]+[^<{]*</, file);
    // Nor a message the site's wallet control writes (src/contexts/AppContext.tsx).
    assert.doesNotMatch(text, />\{(error|message)\}</, file);
  }
  // The pages' titles.
  for (const dir of ['app/node/', 'app/docs/how-it-works/', 'app/support/', 'app/l/']) {
    for (const name of readdirSync(new URL(dir, SRC), { recursive: true }).filter((n) => /\.tsx$/.test(n))) {
      for (const m of read(`${dir}${name.replace(/\\/g, '/')}`).matchAll(/pageTitle\(([^)]*)\)/g)) {
        for (const k of m[1].matchAll(/'([a-z0-9_]+)'/g)) used.add(k[1]);
      }
    }
  }
  assert.match(read('app/node/page.tsx'), /description: t\('cabinet_description'\)/);
  for (const key of used) assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, key), key);
  // The failure texts of a link request are looked up by code.
  for (const failure of ['busy', 'network', 'refused', 'expired', 'unreadable', 'insecure', 'rate_limited']) {
    assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, `link_${failure}`), failure);
  }
});

test('English only: no language switch, no locale choice, no second table, no right-to-left handling', () => {
  assert.equal(existsSync(new URL('i18n', SRC)), false);
  assert.equal(existsSync(new URL('components/LanguageMenu.tsx', SRC)), false);
  for (const file of sources('')) {
    const text = code(file);
    assert.doesNotMatch(text, /LanguageMenu|lang-menu|qnet_lang|useI18n|I18nProvider|requestLocale|messagesOf|accept-language|document\.cookie/i, file);
    assert.doesNotMatch(text, /\bdir=|\[dir=|unicode-bidi|<bdi\b|direction:\s*(ltr|rtl)/, file);
  }
  // The pages that had a language: no select, no lang or dir of their own, the root's English only.
  for (const file of ['components/cabinet/CabinetFrame.tsx', 'app/support/page.tsx', 'app/l/page.tsx', 'app/node/layout.tsx', 'app/support/layout.tsx']) {
    const text = code(file);
    assert.doesNotMatch(text, /<select|\blang=|locale/, file);
  }
  assert.match(read('app/layout.tsx'), /<html lang="en"/);
  // The node layout reads no request header; it renders per request for the server's CABINET_PHONE_FLOWS.
  const layout = code('app/node/layout.tsx');
  assert.doesNotMatch(layout, /cookies\(\)|headers\(\)/);
  assert.match(layout, /export const dynamic = 'force-dynamic';/);
  // Every page title is static and English.
  for (const page of ['app/node/page.tsx', 'app/node/activate/page.tsx', 'app/node/device/page.tsx', 'app/node/history/page.tsx', 'app/docs/how-it-works/page.tsx', 'app/support/layout.tsx', 'app/l/page.tsx']) {
    assert.match(read(page), /export const metadata: Metadata = \{ title: pageTitle\(/, page);
  }
});

// The rules of one selector block of the site's stylesheet, as written: the first block that starts a line with
// exactly that selector (in `within`, a media query's text, or the whole sheet).
const CSS = read('app/globals.css');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function block(selector, within = CSS) {
  const m = new RegExp(`^[ \\t]*${escape(selector)} \\{`, 'm').exec(within);
  assert.ok(m, selector);
  return within.slice(m.index, within.indexOf('}', m.index));
}
function media(query) {
  const at = CSS.lastIndexOf(`@media (${query}) {`);
  assert.ok(at >= 0, query);
  let depth = 0;
  for (let i = CSS.indexOf('{', at); i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(at, i + 1);
  }
  assert.fail(query);
}

test('the cabinet\'s buttons: primary filled, secondary outlined, one size, a finger-sized target, focus and disabled states', () => {
  const button = block('.cabinet .qnet-button');
  for (const rule of ['min-height: 44px;', 'border-radius: 8px;', 'padding: 0.625rem 1.25rem;', 'font-size: 0.8125rem;', 'letter-spacing: 0.06em;', 'background: #00e5f0;', 'max-width: 100%;']) {
    assert.ok(button.includes(rule), rule);
  }
  assert.match(block('.cabinet .qnet-button.secondary'), /background: transparent;/);
  assert.match(block('.cabinet .qnet-button:focus-visible'), /outline: 2px solid #00ffff;/);
  assert.match(CSS, /\.cabinet \.qnet-button:disabled,\n\.cabinet \.qnet-button:disabled:hover \{\n {2}opacity: 0\.45;\n {2}cursor: not-allowed;/);
  // A primary action is `qnet-button activate-primary`, a secondary one `qnet-button secondary`; nothing else.
  for (const name of readdirSync(new URL('components/cabinet/', SRC))) {
    for (const m of read(`components/cabinet/${name}`).matchAll(/className=\{?[`"]qnet-button([^`"]*)[`"]/g)) {
      assert.match(m[1], /^ (activate-primary|secondary|secondary activate-copy|\$\{extension \? 'secondary' : 'activate-primary'\})$/, `${name}: ${m[1]}`);
    }
  }
  // The pages' pills and the text buttons on their own line are as tall.
  assert.match(block('.cabinet-nav-link'), /min-height: 44px;/);
  assert.match(block('.cabinet .activate-link-button'), /min-height: 44px;/);
  assert.match(block('.cabinet-input'), /min-height: 44px;[\s\S]*font-size: 1rem;/);
});

test('phones and tablets: the input row stacks, buttons take the row, the sections share one row, no row wider than the screen', () => {
  const phone = media('max-width: 640px');
  assert.match(block('.cabinet-row', phone), /flex-direction: column;/);
  assert.match(block('.cabinet-row .qnet-button', phone), /width: 100%;/);
  assert.match(block('.cabinet-actions', phone), /flex-direction: column;\n {4}align-items: stretch;/);
  // Three or four sections (owner, 29.09): one row of equal pills, a little tighter below 420 px.
  assert.match(block('.cabinet-nav', phone), /display: grid;\n {4}grid-auto-flow: column;\n {4}grid-auto-columns: minmax\(0, 1fr\);/);
  assert.match(block('.cabinet-nav-link', media('max-width: 419px')), /padding-inline: 0\.25rem;\n {4}font-size: 0\.8125rem;/);
  // Wider screens: one row that wraps.
  assert.match(block('.cabinet-nav'), /flex-wrap: wrap;/);
  assert.match(block('.cabinet-row'), /display: flex;\n {2}align-items: stretch;/);
  // Flex children may shrink below their content, so a long address or the history table never widens the page.
  assert.match(CSS, /\.cabinet > \*,\n\.cabinet \.activate-card > \*,[\s\S]*?\{\n {2}margin: 0;\n {2}min-width: 0;\n\}/);
  assert.match(block('.cabinet-input'), /min-width: 0;/);
  assert.match(block('.cabinet-table-wrap'), /overflow-x: auto;/);
  // The history table's cells break between words, never inside an epoch or an amount; a wider table scrolls.
  assert.match(block('.cabinet-table'), /overflow-wrap: normal;/);
  assert.match(block('.activate-card'), /overflow-wrap: anywhere;/);
  // The eligibility line stays readable on a phone (the explorer's own header shrinks its line to 0.7rem).
  assert.match(block('.cabinet .explorer-header .section-subtitle', phone), /font-size: 0\.9375rem;/);
});

test('the wallet choice: kept as the address, its source and the Solana address it shared only; a QR answer is not a held wallet', () => {
  const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
  const area = new Map();
  const storage = { getItem: (k) => area.get(k) ?? null, setItem: (k, v) => area.set(k, v), removeItem: (k) => area.delete(k) };
  saveChoice(storage, { qnet: WALLET, source: 'app-qr' });
  assert.deepEqual([...area.keys()], [WALLET_KEY]);
  assert.equal(area.get(WALLET_KEY), JSON.stringify({ qnet: WALLET, source: 'app-qr' }));
  assert.deepEqual(loadChoice(storage), { qnet: WALLET, source: 'app-qr' });
  saveChoice(storage, { qnet: WALLET, source: 'extension', solana: SOL });
  assert.deepEqual(loadChoice(storage), { qnet: WALLET, source: 'extension', solana: SOL });
  assert.equal(isHeldWallet({ qnet: WALLET, source: 'app-qr' }), false);
  for (const source of ['extension', 'entered', 'app']) assert.equal(isHeldWallet({ qnet: WALLET, source }), true, source);
  // The Solana address the page relies on (refunds, whose burn): never one a QR answer gave.
  assert.equal(ownSolanaOf({ qnet: WALLET, source: 'extension', solana: SOL }), SOL);
  assert.equal(ownSolanaOf({ qnet: WALLET, source: 'app', solana: SOL }), SOL);
  assert.equal(ownSolanaOf({ qnet: WALLET, source: 'app-qr', solana: SOL }), null);
  assert.equal(ownSolanaOf({ qnet: WALLET, source: 'entered' }), null);
  assert.equal(ownSolanaOf(null), null);
  assert.deepEqual(choiceView({ qnet: WALLET, source: 'app' }), { qnet: WALLET, nodeId: 'light_mobile_6526ab8fd00ff8ca', walletHash: '74940b0126365748' });
  for (const bad of ['', '{}', 'null', '[]', JSON.stringify({ qnet: WALLET }), JSON.stringify({ qnet: WALLET, source: 'app', x: 1 }),
    JSON.stringify({ qnet: `${WALLET.slice(0, -1)}0`, source: 'app' }), JSON.stringify({ qnet: WALLET, source: 'relay' }), 'x'.repeat(300),
    JSON.stringify({ qnet: WALLET, source: 'app', solana: 'x' }), JSON.stringify({ qnet: WALLET, source: 'entered', solana: SOL })]) {
    assert.equal(parseChoice(bad), null, bad);
  }
  clearChoice(storage);
  assert.equal(area.size, 0);
  // Blocked storage: nothing kept, nothing thrown.
  const blocked = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
  saveChoice(blocked, { qnet: WALLET, source: 'app' });
  assert.equal(loadChoice(blocked), null);
  clearChoice(blocked);
  assert.equal(loadChoice(null), null);
});

test('one reading of a node\'s state: Online never from anything but a linked device the network does not call back', () => {
  const base = { registered: true, pending: false, deviceBound: true, answeredThisEpoch: false, needsReactivation: false, counted: { sinceRegistration: 1, counted: 0, lastCountedEpoch: null }, features: [], balanceNano: null };
  assert.equal(nodeState(base), 'online');
  assert.equal(nodeState({ ...base, needsReactivation: true }), 'offline');
  assert.equal(nodeState({ ...base, deviceBound: false }), 'no_device');
  assert.equal(nodeState({ ...base, deviceBound: false, needsReactivation: true }), 'no_device');
  assert.equal(nodeState({ ...base, registered: false }), 'none');
  assert.equal(nodeState({ ...base, registered: false, pending: true }), 'pending');
  // The public status's device, once the node names it, is the state (contract of 04.10).
  const device = (state) => ({ ...base, needsReactivation: true, device: { platform: 'ios', linkedSince: 1_790_000_000, lastAnswerEpoch: null, state } });
  assert.equal(nodeState(device('online')), 'online');
  assert.equal(nodeState(device('offline')), 'offline');
  assert.equal(nodeState(device('other_device_pending')), 'device_pending');
  assert.equal(nodeState(device('unlinked')), 'no_device');
  assert.equal(nodeState({ ...device('online'), registered: false }), 'none');
  assert.equal(canMove(null), false);
  assert.equal(canMove('999999999'), false);
  assert.equal(canMove('1000000000'), true);
});

// SITE-4: the check number is the one barrier against a forged QR answer, so its question says the page shows the
// number and asks whether QNet Wallet shows the same: never a sentence that reads as QNet Wallet showing it.
test('the check-number question names this page as the one that shows the number', () => {
  assert.match(TEXTS.act_check, /^This page shows the check number \{number\}\. Does QNet Wallet show the same number\?$/);
  assert.equal(TEXTS.act_check.match(/QNet/g)?.length, 1);
  assert.ok(TEXTS.act_check.indexOf('{number}') < TEXTS.act_check.indexOf('QNet'));
  assert.doesNotMatch(TEXTS.act_check, /^It /);
});

test('the balance is exact, in English digits and separators', () => {
  assert.equal(formatQnc('12500000000'), '12.5');
  assert.equal(formatQnc('1000000000'), '1');
  assert.equal(formatQnc('1'), '0.000000001');
  assert.equal(formatQnc('1234567000000001'), '1,234,567.000000001');
  assert.equal(formatQnc('0'), '0');
  assert.equal(formatQnc('18446744073709551615'), '18,446,744,073.709551615');
  assert.equal(formatUnits(1_500_000n, 6), '1.5');
  assert.equal(formatUnits(1_234_000_001n, 6), '1,234.000001');
  assert.equal(formatUnits(5n, 9), '0.000000005');
});
