// The explorer's pages at phone width and their amounts: every table scrolls inside its card, the list's From → To
// never runs into the next column whatever the names, no stale rule of the old light theme reaches the dark one, one
// monospace stack the platform has, and QNC amounts exact and grouped as English writes them. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { QNC_DECIMALS, formatQnc, formatQncTruncated, formatTokenAmount } from '../token-format.ts';
import { quoteBigInts } from '../../indexer/transform.ts';
import * as nodeView from '../cabinet/node-view.ts';
import { SRC, read, code } from './source.mjs';

const CSS = read('app/globals.css') + read('app/mobile-fixes.css');
const SHEET = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
// Every rule of the sheet as [selector, body], those inside a media query included.
const RULES = [...SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);

const sources = (dir) => readdirSync(new URL(`${dir}/`, SRC), { recursive: true })
  .filter((name) => /\.tsx?$/.test(name)).map((name) => `${dir}/${name.replace(/\\/g, '/')}`);
const SOURCES = sources('app').concat(sources('components'));

test('QNC amounts are exact from the nano QNC, grouped as English writes them, by one formatter', () => {
  assert.equal(QNC_DECIMALS, 9);
  // A float made 70149622.859999999 of this block amount.
  assert.equal(formatQnc('70149622860000000'), '70,149,622.86');
  assert.equal(formatQnc('18446744073709551615'), '18,446,744,073.709551615');
  assert.equal(formatQnc('2909459675400000'), '2,909,459.6754');
  assert.equal(formatQnc('1'), '0.000000001');
  assert.equal(formatQnc('1000000000'), '1');
  assert.equal(formatQnc('0'), '0');
  assert.equal(formatQnc(1_500_000_000), '1.5');
  assert.equal(formatQnc(BigInt('1234567000000000001')), '1,234,567,000.000000001');
  assert.equal(formatQnc('not a number'), '0');
  assert.equal(formatQnc(undefined), '0');
  // The cabinet's formatters are the same functions.
  assert.equal(nodeView.formatQnc, formatQnc);
  assert.equal(nodeView.formatUnits, formatTokenAmount);
});

test('the circulating supply is cut to two decimals by the same formatter, on the home page and in the stats route', () => {
  assert.equal(formatQncTruncated('12345678901234', 2), '12,345.67');
  assert.equal(formatQncTruncated('999999999', 2), '0.99', 'cut, never rounded up');
  assert.equal(formatQncTruncated('12345600000000', 2), '12,345.60');
  assert.equal(formatQncTruncated(BigInt('1000000000'), 2), '1.00');
  assert.equal(formatQncTruncated('0', 2), '0.00');
  assert.equal(formatQncTruncated('18446744073709551615', 2), '18,446,744,073.70');
  assert.equal(formatQncTruncated('1500000000', 0), '1');
  for (const file of ['app/page.tsx', 'app/api/network/stats/route.ts']) {
    const src = code(file);
    assert.match(src, /circulatingSupply: Number\(emissionNano \/ 1_000_000_000n\),\s*circulatingFormatted: formatQncTruncated\(emissionNano, 2\),/, file);
    assert.doesNotMatch(src, /padStart\(9|\\B\(\?=/, file);
  }
});

test('the block, transaction and address pages write QNC through formatQnc, never through a float', () => {
  const block = code('app/explorer/block/[hash]/page.tsx');
  assert.match(block, /\{formatQnc\(block\.consensus_data\.fees_collected\)\} QNC/);
  assert.match(block, /\{formatQnc\(block\.consensus_data\.pool3_total_activations\)\} QNC/);
  assert.match(block, /<td>\{formatQnc\(tx\.amount\)\} QNC<\/td>/);
  assert.match(code('app/explorer/tx/[hash]/page.tsx'), /\{' — '\}\{formatQnc\(r\.amount\)\} QNC/);
  // The proven balance's route and page are pinned in light-client.test.mjs.
  for (const page of ['app/explorer/block/[hash]/page.tsx', 'app/explorer/tx/[hash]/page.tsx', 'app/explorer/address/[address]/page.tsx']) {
    const src = code(page);
    assert.doesNotMatch(src, /1e9|toFixed\(9\)|parseFloat\(|Number\([^)]*amount|const formatAmount/i, page);
  }
  assert.match(code('app/api/qnc/route.ts'), /formatQnc\(typeof raw === 'string' \? raw : String\(raw \?\? '0'\)\)/);
});

test('a block the index does not hold yet keeps an amount beyond 2^53 exact from the node\'s JSON', () => {
  const body = '{"block":{"height":7,"transactions":[{"hash":"aa","from":"a","to":"b","amount":9007199254740993,"gas_price":1,"gas_limit":10000}]}}';
  const amountOf = (data) => String(data.block.transactions[0].amount || 0);
  assert.equal(formatQnc(amountOf(JSON.parse(quoteBigInts(body)))), '9,007,199.254740993');
  // Parsed as numbers, the last nano is lost.
  assert.equal(formatQnc(amountOf(JSON.parse(body))), '9,007,199.254740992');
  const route = code('app/api/blocks/[hash]/route.ts');
  assert.match(route, /const data = JSON\.parse\(quoteBigInts\(await response\.text\(\)\)\);/);
  assert.doesNotMatch(route, /response\.json\(\)/);
  assert.match(route, /amount: String\(t\.amount \|\| 0\),/);
});

test('every table sits in a wrapper that scrolls sideways, so a card never clips it', () => {
  const WRAPPERS = ['table-wrapper', 'cabinet-table-wrap'];
  for (const name of WRAPPERS) assert.match(SHEET, new RegExp(`^\\.${name} \\{[^}]*overflow-x: auto;`, 'm'), name);
  // The innermost open <div> around a table is the wrapper.
  const around = (src, at) => {
    const open = [];
    for (const m of src.slice(0, at).matchAll(/<div\b(?:[^>]*?\bclassName="([^"]*)")?[^>]*>|<\/div>/g)) {
      if (m[0] === '</div>') open.pop();
      else if (!m[0].endsWith('/>')) open.push(m[1] ?? '');
    }
    return open.at(-1);
  };
  let tables = 0;
  for (const file of SOURCES) {
    const src = code(file);
    for (const m of src.matchAll(/<table\b/g)) {
      tables++;
      assert.ok(WRAPPERS.includes(around(src, m.index)), `${file}: a table outside a scroll wrapper`);
    }
  }
  assert.ok(tables >= 12, String(tables));
});

test('the list\'s From → To stays on one line and takes the width it needs, whatever the names', () => {
  const rules = RULES.filter(([selector]) => /\.col-addresses\b/.test(selector));
  assert.ok(rules.length > 0);
  for (const [selector, body] of rules) assert.doesNotMatch(body, /max-width|width:|overflow|text-overflow/, selector);
  const cell = rules.find(([selector]) => selector === '.col-addresses')[1];
  assert.match(cell, /white-space: nowrap;/);
  // The arrow is a word of its own, between spaces.
  assert.match(code('app/explorer/ExplorerClient.tsx'), /\)\}\n\s*\{' '\}<span className="arr">→<\/span>\{' '\}\n/);
});

test('no rule of the old light theme or the old phone search layout reaches the dark explorer', () => {
  // Table cells and the explorer list's panels take the dark theme's colours only.
  const TABLE = /(?:^|[\s,>+~])(?:table|thead|tbody|tr|th|td)\b|\.[\w-]*table\b/;
  let checked = 0;
  for (const [selector, body] of RULES) {
    if (!TABLE.test(selector) && !/\.(?:activity|explorer)-/.test(selector)) continue;
    checked++;
    assert.doesNotMatch(body, /#f8f9fa|#f0f0f0|#e9ecef|#eee\b|#333\b|#666\b|background(?:-color)?: (?:#fff(?:fff)?|white)\b/i, selector);
  }
  assert.ok(checked >= 60, String(checked));
  // The search field keeps its button beside it at every width, and only the button's own rules size it: the small
  // phone's narrower padding included.
  for (const [selector, body] of RULES.filter(([s]) => /\.explorer-search\b/.test(s))) assert.doesNotMatch(body, /flex-direction: column/, selector);
  for (const [selector, body] of RULES) {
    const qualified = selector.split(',').map((s) => s.trim()).filter((s) => /\.search-btn(?![\w-])/.test(s) && !/^\.search-btn(:hover| svg)?$/.test(s));
    if (qualified.length > 0) assert.doesNotMatch(body, /padding|margin/, selector);
  }
  const small = SHEET.slice(SHEET.lastIndexOf('@media (max-width: 420px) {'));
  assert.match(small, /^\s*\.search-btn \{ padding: 0 0\.6rem; min-height: 44px; \}/m);
});

test('text keeps its size on a phone, and monospace text takes one stack of the platform\'s own fonts', () => {
  const html = SHEET.match(/(?:^|\n)html \{([^}]*)\}/)[1];
  assert.match(html, /-webkit-text-size-adjust: 100%;/);
  assert.match(html, /(^|[^-])text-size-adjust: 100%;/);
  assert.match(SHEET, /:root \{\s*--font-mono: ui-monospace, Menlo, Consolas, monospace;\s*\}/);
  assert.doesNotMatch(CSS, /@font-face/);
  // Every family is that token or a sans-serif stack, so no other monospace stack is written anywhere in the sheet.
  const families = [...SHEET.matchAll(/font-family: ([^;]+);/g)].map((m) => m[1].trim());
  for (const family of families) assert.ok(family === 'var(--font-mono)' || family === 'inherit' || /, sans-serif$/.test(family), family);
  assert.ok(families.filter((f) => f === 'var(--font-mono)').length >= 25);
  for (const m of SHEET.matchAll(/(?:^|[\s;{])font: ([^;]+);/g)) assert.equal(m[1].trim(), 'inherit');
  // Outside the sheet: inline styles and the guide's pictures name the token; the background's canvas reads it once.
  for (const file of SOURCES) {
    const src = code(file);
    for (const m of src.matchAll(/fontFamily[:=]\s*\{?\s*['"]([^'"]+)['"]/g)) {
      if (/mono/i.test(m[1])) assert.equal(m[1], 'var(--font-mono)', file);
    }
    const named = src.match(/monospace|Menlo|Consolas/g) ?? [];
    assert.equal(named.length, file === 'components/MatrixRain.tsx' ? 1 : 0, file);
  }
  const art = code('components/cabinet/GuideArt.tsx');
  assert.match(art, /const MONO = \{ fontFamily: 'var\(--font-mono\)' \};/);
  assert.match(art, /style=\{MONO\}/);
  assert.doesNotMatch(art, /fontFamily[=:]\s*\{?[^}\n]*MONO/);
  const rain = code('components/MatrixRain.tsx');
  assert.match(rain, /const font = `\$\{fontSize\}px \$\{getComputedStyle\(document\.documentElement\)\.getPropertyValue\('--font-mono'\)\.trim\(\) \|\| 'monospace'\}`;/);
  // Setting the canvas's size resets its font, so the font is set again after it.
  assert.match(rain, /canvas\.height = window\.innerHeight;\s*ctx\.font = font;/);
  assert.equal((rain.match(/ctx\.font = /g) ?? []).length, 1);
});
