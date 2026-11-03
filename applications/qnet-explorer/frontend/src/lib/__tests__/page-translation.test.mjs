// A browser's page translation on the activation page. Translation replaces text nodes: a value it rewrites is wrong (an
// address, an amount, a code), and a text node the page updates after it was replaced no longer shows (a countdown
// stops). So addresses, amounts, codes and live readouts sit in an element of their own marked translate="no", and the
// words around them stay translatable: the site speaks QNet Wallet's eleven languages, and a reader may still translate a
// page into another. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CATALOGS } from '../../i18n/catalogs.ts';
import { LOCALES } from '../languages.ts';
import * as texts from '../texts.ts';
import { missParts } from '../cabinet/last-miss.ts';
import { emptyListText } from '../explorer-view.ts';
import { code, read, sourceFiles } from './source.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// The classes of the elements that hold a value the page shows as data.
const VALUE_CLASSES = ['ent', 'cab-code', 'amount-v', 'cab-send-amt', 'cab-meter-v'];
const ACTIVATION = ['NodeActivate', 'ActivateSteps', 'LinkWaiting', 'ExtensionActivate', 'NextSteps'].map((n) => `components/cabinet/${n}.tsx`);

// Every JSX opening tag with a literal className, with its class tokens.
function valueTags(src) {
  return [...src.matchAll(/<[A-Za-z]+\b[^<>]*?className="([^"]*)"[^<>]*?>/g)]
    .filter((m) => m[1].split(/\s+/).some((c) => VALUE_CLASSES.includes(c)))
    .map((m) => m[0]);
}

// The site's one entity component (EntityLink, Amount, AmountUnit) is held to the same in site-entity.test.mjs.
test('the activation page: every address, amount, code and readout is out of page translation', () => {
  let seen = 0;
  for (const file of ACTIVATION) {
    for (const tag of valueTags(code(file))) {
      seen += 1;
      assert.match(tag, /translate="no"/, `${file}: ${tag}`);
    }
  }
  // The payment step's amounts are the one Amount's (site-entity.test.mjs), no longer written here by hand.
  assert.ok(seen >= 9, `${seen}`);
  assert.equal(code('components/cabinet/ActivateSteps.tsx').match(/<Amount /g)?.length, 1);
  // The check number the user compares with QNet Wallet's.
  assert.match(code('components/cabinet/ActivateSteps.tsx'), /rich\('act_check', \{ number: <span translate="no">\{formatCheckNumber\(record\.answer\.checkNumber\)\}<\/span> \}\)/);
});

test('the request\'s countdown keeps counting under translation: the time in an element of its own, the words translatable', () => {
  const waiting = code('components/cabinet/LinkWaiting.tsx');
  const countdown = waiting.slice(waiting.indexOf('function Countdown('), waiting.indexOf('export function QrCode('));
  assert.match(countdown, /return <>\{rich\('link_waiting', \{ time: <span className="num" translate="no">\{`\$\{Math\.floor\(left \/ 60\)\}:\$\{String\(left % 60\)\.padStart\(2, '0'\)\}`\}<\/span> \}\)\}<\/>;/);
  // A bare text node the page rewrote every second is what translation froze.
  assert.doesNotMatch(countdown, /\{t\('link_waiting'/);
});

test('the page stays translatable: no page-wide opt-out, and the language it is written in is named', () => {
  const layout = code('app/layout.tsx');
  assert.match(layout, /<html lang=\{locale\} dir=\{dir\} /);
  assert.doesNotMatch(layout, /translate=|notranslate/);
  for (const file of ACTIVATION) assert.doesNotMatch(code(file), /notranslate|translate="yes"/, file);
});

// The product names in a sentence the page shows are elements of their own marked translate="no", so a browser's page
// translation keeps them as they are while the words around them stay translatable.
const NAMED = new Set(Object.keys(CATALOGS.en).filter((k) => LOCALES.some((l) => texts.nameParts(CATALOGS[l][k]).some((p) => typeof p !== 'string'))));

// lib/rich.tsx compiled as the site compiles it, its one import of the site pointed at the module the test loaded.
function richModule() {
  const options = { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
  const js = ts.transpileModule(read('lib/rich.tsx'), { compilerOptions: options }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)((spec) => (spec === './texts' ? texts : require(spec)), module, module.exports);
  return module.exports;
}
const { renderToStaticMarkup } = require('react-dom/server');
const { createElement, Fragment } = require('react');
const html = (node) => renderToStaticMarkup(createElement(Fragment, null, node));
const ENTITIES = { '&#x27;': "'", '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>' };
const words = (markup) => markup.replace(/<[^>]*>/g, '').replace(/&#x27;|&quot;|&amp;|&lt;|&gt;/g, (e) => ENTITIES[e]);

test('a sentence the page shows keeps QNet Blockchain, QNet Wallet and QNet Link out of page translation, in every language', () => {
  assert.deepEqual([...texts.PRODUCT_NAMES], ['QNet Blockchain', 'QNet Wallet', 'QNet Link']);
  assert.deepEqual(texts.nameParts('Open QNet Wallet on QNet Blockchain.'), ['Open ', { product: 'QNet Wallet' }, ' on ', { product: 'QNet Blockchain' }, '.']);
  assert.deepEqual(texts.nameParts('No name here.'), ['No name here.']);
  assert.ok(NAMED.size > 300, `${NAMED.size} texts hold a name`);
  const { named, richOf, sayOf } = richModule();
  assert.equal(named('No name here.'), 'No name here.', 'a text without a name stays one text node');
  for (const locale of LOCALES) {
    const t = texts.translator(locale, CATALOGS[locale]);
    // say: the sentence whole, each name in its own element, nothing of a name left outside one.
    const said = html(sayOf(t)('balance_lead'));
    assert.match(said, /<span translate="no">QNet Blockchain<\/span>/, locale);
    assert.equal(words(said), t('balance_lead'), locale);
    assert.doesNotMatch(said.replace(/<span translate="no">QNet (?:Blockchain|Wallet|Link)<\/span>/g, ''), /QNet (?:Blockchain|Wallet|Link)/, locale);
    // rich: the words around a slot the same way, the slot's element as given.
    const owner = html(richOf(t)('act_owner', { wallet: createElement('b', null, 'W') }));
    assert.match(owner, /<span translate="no">QNet Blockchain<\/span>/, locale);
    assert.match(owner, /<b>W<\/b>/, locale);
    // Two names in one sentence.
    assert.equal(html(sayOf(t)('wallet_extension_failed')).match(/<span translate="no">QNet Wallet<\/span>/g)?.length, 2, locale);
  }
  // A message the page put together as a string goes through named() as well, and an element passes as it is: the request
  // lines, a table's empty and failed lines, and a missed epoch's line, in every language.
  const element = createElement('b', null, 'QNet Wallet');
  assert.equal(named(element), element);
  assert.equal(code('components/ui/RequestState.tsx').match(/\{named\(children\)\}/g)?.length, 3);
  const table = code('components/ui/DataTable.tsx');
  assert.match(table, /\{named\(empty \?\? t\('table_empty'\)\)\}/);
  assert.match(table, /\{error && <p className="tbl-error" role="alert">\{named\(error\)\}<\/p>\}/);
  assert.match(code('components/cabinet/NodeStatus.tsx'), /\{rich\(what, \{ epoch: <EpochNumber epoch=\{miss\.epoch\} \/> \}\)\} \{named\(rest\)\}/);
  for (const locale of LOCALES) {
    const t = texts.translator(locale, CATALOGS[locale]);
    for (const [shown, name] of [
      [html(named(missParts({ epoch: 9, reason: 'woken_no_answer', delivered: true }, 'android', t).rest)), 'QNet Wallet'],
      [html(named(emptyListText([], t))), 'QNet Blockchain'],
    ]) {
      assert.match(shown, new RegExp(`<span translate="no">${name}</span>`), locale);
      assert.doesNotMatch(shown.replace(/<span translate="no">QNet (?:Blockchain|Wallet|Link)<\/span>/g, ''), /QNet (?:Blockchain|Wallet|Link)/, locale);
    }
  }
});

// The props of the site's components that are text the page shows, and those a component writes into an attribute.
const TEXT_PROPS = {
  PageHead: ['title', 'kicker', 'lead'], Section: ['title', 'lead'], Group: ['title', 'meta'], Step: ['title'], Fact: ['label'],
  Readout: ['label', 'sub'], ActionBlock: ['title'], Row: ['label'], LinkButtons: ['lead', 'button', 'note'], DataTable: ['caption', 'title'],
  DocRow: ['name', 'what'],
};
const ATTRIBUTE_PROPS = { Readouts: ['label'], QrCode: ['label'], Copy: ['ariaLabel', 'label'] };
// Texts with a name the page builds as a string and shows later, each with the way it reaches the page through say's
// element (lib/rich.tsx named); metadata is no text of the page.
const STRING_SITES = {
  'app/layout.tsx': [['meta_description', 'meta_keywords'], /export async function generateMetadata\(\): Promise<Metadata> \{[^]*?description: t\('meta_description'\),\n\s*keywords: t\('meta_keywords'\),/],
  'components/cabinet/NextSteps.tsx': [['act_linked_answer', 'act_mismatch', 'link_answer_rejected', 'act_stale', 'act_refused_wallet_has_node', 'act_refused'], /\{notice && <Failed>\{notice\}<\/Failed>\}/],
  'app/explorer/blocks/BlocksClient.tsx': [['blocks_ask_ahead'], /\{askError \? named\(askError\) : '\\u00a0'\}/],
  'app/explorer/address/[address]/AddressClient.tsx': [['proof_network_down'], /\{result\.error \? named\(result\.error\) : t\('proof_failed'\)\}/],
};
// A key computed at run time whose texts hold no name: a transaction's data labels.
const COMPUTED_PLAIN = { 'app/explorer/tx/[hash]/TransactionClient.tsx': ['key', (k) => k.startsWith('tx_data_')] };
// Every t() call of a .ts helper whose key holds a name or is computed, by its key or its argument as written: `shown`,
// the page's element that shows that text through named() or rich(), as file and pattern; `plain`, a computed key whose
// texts hold no name (a state word, a platform's, a tab's or a transaction type's name, a list's joiner), metadata, or
// the translator itself.
const HELPER_TEXTS = {
  'lib/cabinet/last-miss.ts': {
    calls: ['delivery', 'notice.todo', 'what'],
    shown: ['components/cabinet/NodeStatus.tsx', /\{rich\(what, \{ epoch: <EpochNumber epoch=\{miss\.epoch\} \/> \}\)\} \{named\(rest\)\}/],
  },
  'lib/explorer-view.ts': { calls: ['list_waiting', 'how'], shown: ['components/ui/DataTable.tsx', /\{named\(empty \?\? t\('table_empty'\)\)\}/] },
  'lib/account-menu.ts': { calls: ["STATE_WORD[state] ?? 'badge_offline'", 'STATE_WORD[state]'], plain: true },
  'lib/tx-labels.ts': { calls: ['key', 'IN_APP_TYPES[type]', 'IN_APP_TYPES.Reward', 'IN_APP_TYPES.Activation'], plain: true },
  'lib/cabinet/node-view.ts': { calls: ['PLATFORM_TEXT[d.platform]', 'short'], plain: true },
  'lib/cabinet/tabs.ts': { calls: ['TAB_LABEL[tab]'], plain: true },
  'i18n/server.ts': { calls: ['description'], plain: true },
  'lib/texts.ts': { calls: ['k'], plain: true },
};

// The literal keys an argument can be (a key, or a choice between keys), or null when it is computed at run time.
function keysOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return keysOf(node.expression);
  if (ts.isConditionalExpression(node)) {
    const a = keysOf(node.whenTrue);
    const b = keysOf(node.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

// Up from a call through what passes its value on as it is: parentheses, a conditional's branches, && || ?? right.
const PASSING = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
function carried(node) {
  let at = node;
  for (;;) {
    const p = at.parent;
    if (ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== at) || (ts.isBinaryExpression(p) && p.right === at && PASSING.has(p.operatorToken.kind))) at = p;
    else return at;
  }
}
const tagOf = (holder) => holder.parent.parent.parent.tagName.getText();

// What a t(...) or say(...) call of a .tsx source does that the rule refuses, or null.
function refusal(node, file) {
  const arg = node.arguments[0];
  const keys = keysOf(arg);
  const plain = COMPUTED_PLAIN[file]?.[0] === arg.getText() ? Object.keys(CATALOGS.en).filter(COMPUTED_PLAIN[file][1]) : null;
  const named = (keys ?? plain)?.some((k) => NAMED.has(k)) ?? true;
  const holder = carried(node).parent;
  const inJsx = ts.isJsxExpression(holder);
  const attribute = inJsx && ts.isJsxAttribute(holder.parent);
  if (node.expression.text === 'say') return attribute && /^[a-z]/.test(tagOf(holder)) ? 'say in an attribute' : null;
  if (named && inJsx && (ts.isJsxElement(holder.parent) || ts.isJsxFragment(holder.parent))) {
    // An SVG picture's text (the guide's drawings of the app) is no sentence of the page.
    const tag = holder.parent.openingElement?.tagName.getText();
    return tag === 'text' || tag === 'tspan' ? null : 'a child shown through t';
  }
  if (named && attribute) {
    const owner = tagOf(holder);
    const prop = holder.parent.name.getText();
    if ((TEXT_PROPS[owner] ?? []).includes(prop)) return `${owner}.${prop} shown through t`;
    if (/^[A-Z]/.test(owner) && keys !== null && !(ATTRIBUTE_PROPS[owner] ?? []).includes(prop)) return `${owner}.${prop} takes a name through t`;
    return null;
  }
  if (!inJsx && keys?.some((k) => NAMED.has(k))) {
    const site = STRING_SITES[file];
    return site && keys.every((k) => site[0].includes(k)) ? null : `${keys.join(' ')} built as a string`;
  }
  return null;
}

test('every text with a product name the page shows goes through say or rich; t keeps attributes and code', () => {
  const found = [];
  let said = 0;
  const check = (file, src) => {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length > 0 && ['t', 'say'].includes(node.expression.text)) {
        if (node.expression.text === 'say') said += 1;
        const why = refusal(node, file);
        if (why) found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${why}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  for (const file of sourceFiles().filter((f) => f.endsWith('.tsx'))) check(file, read(file));
  assert.deepEqual(found, []);
  assert.ok(said > 200, `${said} texts through say`);
  // Each text built as a string reaches the page through an element that keeps its names.
  for (const [file, [, shown]] of Object.entries(STRING_SITES)) assert.match(code(file), shown, file);
  // A .ts helper's text with a name, or computed, is listed with the element that shows it (or as holding none), and
  // every listed one is still there.
  const helperCalls = (src, file) => {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out = [];
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments.length > 0) {
        const keys = keysOf(node.arguments[0]);
        if (!keys || keys.some((k) => NAMED.has(k))) out.push(keys ? keys.join(' ') : node.arguments[0].getText());
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  };
  const helpers = Object.fromEntries(sourceFiles().filter((f) => f.endsWith('.ts')).map((f) => [f, helperCalls(read(f), f)]).filter(([, calls]) => calls.length));
  assert.deepEqual(Object.fromEntries(Object.entries(helpers).map(([f, calls]) => [f, [...new Set(calls)].sort()])),
    Object.fromEntries(Object.entries(HELPER_TEXTS).map(([f, { calls }]) => [f, [...calls].sort()])));
  for (const [file, { shown, plain }] of Object.entries(HELPER_TEXTS)) {
    if (plain) assert.equal(shown, undefined, file);
    else assert.match(code(shown[0]), shown[1], file);
  }
  assert.deepEqual(helperCalls("const a = t('list_waiting'); const b = t('try_again'); const c = t(k);", 'probe.ts'), ['list_waiting', 'k']);
  // The check itself: a child, a choice of children and a text prop through t, a text built with a name, and say in an
  // attribute are each found; an attribute through t and a sentence through say are not.
  for (const [src, n] of [
    ["const a = <p>{t('balance_lead')}</p>;", 1], ["const a = <p>{ok ? t('balance_lead') : null}</p>;", 1], ['const a = <p>{t(key)}</p>;', 1],
    ["const a = <PageHead title={t('balance_lead')} />;", 1], ["const s = t('balance_lead');", 1], ["const a = <p title={say('balance_lead')}>x</p>;", 1],
    ["const a = <p aria-label={t('balance_lead')}>x</p>;", 0], ["const a = <p>{say('balance_lead')}</p>;", 0], ["const a = <p>{t('try_again')}</p>;", 0],
  ]) {
    const before = found.length;
    check('probe.tsx', src);
    assert.equal(found.length - before, n, src);
  }
});
