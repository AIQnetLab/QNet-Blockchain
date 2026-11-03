// The explorer's pages at phone width and their amounts: every table scrolls inside its card, the list's From / To
// is never cut whatever the names, no sheet of the old light theme is left, one monospace stack the platform has, and
// QNC amounts exact and grouped as English writes them. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { QNC_DECIMALS, formatQnc, formatQncTruncated, formatTokenAmount } from '../token-format.ts';
import { quoteBigInts } from '../../indexer/transform.ts';
import * as nodeView from '../cabinet/node-view.ts';
import { FLEX_MIN, tableMinWidth, textLength, wordsLength, wordsWidth } from '../geometry.ts';
import { ageForms, txCountText } from '../explorer-view.ts';
import { translator } from '../texts.ts';
import { CATALOGS } from '../../i18n/catalogs.ts';
import { SRC, allSheets, read, code } from './source.mjs';
import { TEXTS, english } from './texts-helper.mjs';

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

// One format whatever the visitor's language, 42,578.81988. A formatter given no locale, or one held in a
// variable, takes the visitor's (42.578,81988, 42 578,81988, other digits), so every one names English literally.
const VISITOR_LOCALE = [
  /\.toLocale(?:String|DateString|TimeString)\((?!\s*['"]en(?:-US)?['"])/,
  /(?:new\s+)?Intl\.(?:NumberFormat|DateTimeFormat|PluralRules|RelativeTimeFormat|ListFormat)\((?!\s*['"]en(?:-US)?['"])/,
  /navigator\.languages?\b/,
];
test('every amount and count is written with comma groups and a decimal point, whatever the visitor\'s locale', () => {
  assert.equal(formatQnc('42578819880000'), '42,578.81988');
  const visitorLocale = (src) => VISITOR_LOCALE.some((p) => p.test(src));
  for (const form of ['n.toLocaleString()', 'n.toLocaleString(lang)', 'Intl.NumberFormat()', 'new Intl.NumberFormat(locale)', 'new Intl.DateTimeFormat(undefined, {})', 'navigator.language']) {
    assert.ok(visitorLocale(form), form);
  }
  for (const form of ["n.toLocaleString('en-US', { maximumFractionDigits: 2 })", "new Intl.NumberFormat('en')", 'new Intl.DateTimeFormat(\n  "en", {})']) {
    assert.ok(!visitorLocale(form), form);
  }
  const all = new Map(['app', 'components', 'contexts', 'hooks', 'lib', 'server', 'indexer'].flatMap(sources)
    .filter((f) => !f.includes('__tests__')).map((f) => [f, code(f)]));
  assert.ok(all.size > 200);
  // Dates and times take the page's language for their month names, never the visitor's locale and never other digits:
  // the formats module's date formatters, built from the page's language (dateLocale: Latin digits in Arabic too).
  const format = all.get('lib/format.ts');
  assert.equal(format.match(/new Intl\.DateTimeFormat\(tag, /g)?.length, 5);
  assert.match(format, /const tag = dateLocale\(locale\);/);
  assert.match(code('lib/languages.ts'), /export const dateLocale = \(locale: Locale\): string => \(locale === 'ar' \? 'ar-u-nu-latn' : locale\);/);
  all.set('lib/format.ts', format.replace(/new Intl\.DateTimeFormat\(tag, /g, "new Intl.DateTimeFormat('en', "));
  for (const [file, src] of all) {
    for (const pattern of VISITOR_LOCALE) assert.doesNotMatch(src, pattern, file);
  }
  // Counts are grouped by number() alone and exact amounts by token-format.ts; there is no other formatter (the lists'
  // two-decimal QNC is gone: they write raw amounts exactly too).
  const calls = (pattern) => [...all].flatMap(([file, src]) => [...src.matchAll(pattern)].map(() => file));
  assert.deepEqual(calls(/\.toLocaleString\(/g), []);
  assert.deepEqual(calls(/\(\\d\{3\}\)\+\(\?!\\d\)/g), ['lib/token-format.ts']);
  // The explorer's pages group their counts through int() of src/lib/format.ts, which is number() itself.
  assert.match(code('lib/format.ts'), /export function int\(n: number \| bigint\): string \{\n\s*return number\(/);
  for (const page of ['app/explorer/address/[address]/AddressClient.tsx', 'app/explorer/block/[hash]/BlockClient.tsx', 'app/explorer/tx/[hash]/TransactionClient.tsx']) {
    assert.match(code(page), /import \{[^}]*\bint\b[^}]*\} from '@\/lib\/format';/, page);
  }
});

test('the circulating supply is cut to two decimals by the same formatter, on the home page and in the stats route', () => {
  assert.equal(formatQncTruncated('12345678901234', 2), '12,345.67');
  assert.equal(formatQncTruncated('999999999', 2), '0.99', 'cut, never rounded up');
  assert.equal(formatQncTruncated('12345600000000', 2), '12,345.60');
  assert.equal(formatQncTruncated(BigInt('1000000000'), 2), '1.00');
  assert.equal(formatQncTruncated('0', 2), '0.00');
  assert.equal(formatQncTruncated('18446744073709551615', 2), '18,446,744,073.70');
  assert.equal(formatQncTruncated('1500000000', 0), '1');
  const route = code('app/api/network/stats/route.ts');
  assert.match(route, /circulatingSupply: Number\(emissionNano \/ 1_000_000_000n\),\s*circulatingFormatted: formatQncTruncated\(emissionNano, 2\),/);
  // The home page takes the emission so far from the head (the snapshot first, then the stream) and cuts it the same way.
  assert.match(code('app/page.tsx'), /emissionNano: String\(s\.stats\.emission_total \|\| '0'\) \};/);
  assert.match(code('app/HomeClient.tsx'), /value=\{stats \? formatQncTruncated\(stats\.emissionNano, 2\) : null\}/);
  for (const file of ['app/page.tsx', 'app/HomeClient.tsx', 'app/api/network/stats/route.ts']) {
    assert.doesNotMatch(code(file), /padStart\(9|\\B\(\?=/, file);
  }
});

test('the block, transaction and address pages write QNC through formatQnc, never through a float', () => {
  const block = code('app/explorer/block/[hash]/BlockClient.tsx');
  assert.match(block, /<QncAmount nano=\{cd\.fees_collected\} \/>/);
  assert.match(block, /<QncAmount nano=\{cd\.pool3_total_activations\} \/>/);
  assert.match(block, /amountCol<BlockTransaction>\(t, \(x\) => <QncAmount nano=\{x\.amount\} \/>/);
  const tx = code('app/explorer/tx/[hash]/TransactionClient.tsx');
  assert.match(tx, /amountCol<\{ i: number; to: string; amount: string \}>\(t, \(r\) => <QncAmount nano=\{r\.amount\} \/>/);
  // A transaction's own amount and fee are the exact nano QNC of the record (a listed row carries the same raw amount).
  assert.match(tx, /const moved = qnc\(tx\.amount_raw \?\? '0'\);/);
  assert.match(tx, /<Readout label=\{t\('tx_fee'\)\} value=\{tx && phase === 'ready' \? qnc\(tx\.fee_raw \?\? '0'\) : null\}/);
  // QncAmount writes nano QNC through formatQnc (qnc() of src/lib/format.ts), its number as text and its unit as the link.
  assert.match(code('components/explorer/cells.tsx'), /return <Amount value=\{qnc\(nano\)\} \/>;/);
  assert.match(code('lib/format.ts'), /export const qnc = \(nano: [^)]*\): string => formatQnc\(nano\);/);
  // The proven balance's route and page are pinned in light-client.test.mjs.
  for (const page of ['app/explorer/block/[hash]/BlockClient.tsx', 'app/explorer/tx/[hash]/TransactionClient.tsx', 'app/explorer/address/[address]/AddressClient.tsx']) {
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
  // The shared table (components/ui/DataTable.tsx) scrolls sideways in its frame on phones and tablets, never narrower
  // than its columns need; from 1,181 px every table fits its frame, so the frame never clips its sticky header there.
  const base = read('styles/base.css');
  const frame = base.slice(base.indexOf('@media (max-width: 1180px) {'));
  assert.match(frame, /^@media \(max-width: 1180px\) \{[\s\S]*?\.tbl-frame\[data-scroll='true'\] \{ overflow-x: auto; overscroll-behavior-x: contain;/);
  assert.match(frame, /\.tbl-frame\[data-scroll='true'\] \.tbl \{ width: max\(100%, var\(--tbl-min, 100%\)\); \}/);
  assert.doesNotMatch(base, /\.tbl-frame\[data-scroll='true'\] \.tbl \{ width: max-content;/);
  // A flexible cell sizes its entities itself (base.css .ent-cut): no container query decides a whole or short form.
  assert.match(base, /^\.tbl-fit \{ min-width: 0; overflow-x: clip; text-overflow: ellipsis; \}$/m);
  assert.doesNotMatch(base, /@container|container: cell/);
  assert.match(code('components/ui/DataTable.tsx'), /<table className="tbl" role=\{role\('table'\)\} style=\{\{ '--tbl-min': `\$\{tableMinWidth\(columns\)\}px` \} as CSSProperties\}>/);
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
      assert.ok(around(src, m.index)?.split(' ').includes('tbl-frame'), `${file}: a table outside a scroll wrapper`);
    }
  }
  // The lists are the one table component now; written out and shared, at least a dozen.
  const lists = SOURCES.reduce((n, file) => n + [...code(file).matchAll(/<DataTable\b/g)].length, 0);
  assert.ok(tables + lists >= 12, String(tables + lists));
});

// What a token's method does is one line of its table: the column is as wide as the longest description in the page's
// language, wider than its 280 px least in some, so a phone scrolls the table sideways instead of cutting the words.
test('a token\'s methods are whole in every language', () => {
  const src = code('app/explorer/token/[contract]/TokenClient.tsx');
  assert.match(src, /textCol<Method>\('desc', t\('tok_what'\), \(m\) => t\(m\.desc\), undefined, undefined, Math\.max\(280, wordsWidth\(\[\.\.\.QRC20_INTERFACE, \.\.\.QRC721_INTERFACE\]\.map\(\(m\) => t\(m\.desc\)\)\)\)\),/);
  const keys = [...src.matchAll(/desc: '(tok_m_\w+)'/g)].map((m) => m[1]);
  assert.equal(keys.length, 14);
  const widest = Math.max(...Object.values(CATALOGS).map((catalog) => wordsWidth(keys.map((k) => catalog[k]))));
  assert.ok(widest > 280, String(widest));
});

// A detail row's Copy keeps its 44 px target over the row's padding (a margin that takes its padding back). Where a longer
// language's word puts it under its value, the gap between the lines is that margin, so the target never covers the
// value's link.
test('a detail row\'s Copy that wraps under its value keeps its target off the value', () => {
  const explorer = read('styles/explorer.css');
  const reach = Number(/\n\.ex \.kv \.act \{ margin-block: -(\d+)px; \}/.exec(explorer)?.[1]);
  const gap = Number(/\n\.ex \.kv :is\(\.ent-copy, \.ex-val\) \{ row-gap: (\d+)px; \}/.exec(explorer)?.[1]);
  assert.ok(reach > 0 && gap >= reach, `row gap ${gap} for a reach of ${reach}`);
  assert.match(code('components/ui/EntityLink.tsx'), /return <span className="ent-copy">\{shown\}<Copy /);
  assert.match(code('components/explorer/Detail.tsx'), /<span className="ex-val">\n\s*<span title=\{value\}>\{short\('hash', value\)\}<\/span>\n\s*<Copy /);
});

// The page's content width at a viewport width, from the tokens (--maxw 1360, --gut clamp(16px, 4vw, 56px)), and the
// width of `span` of its 12 columns (--col-gap 24).
const contentWidth = (w) => Math.min(w, 1360) - 2 * Math.min(56, Math.max(16, 0.04 * w));
const columnsWidth = (w, span) => ((contentWidth(w) - 11 * 24) / 12) * span + (span - 1) * 24;

// The home page's live blocks, from 861 px where the hero shows them as a column: a row's first line is the height and
// its transaction count, its second the producer, which gives way, and the age, whose box holds the language's longest.
// Three of the twelve columns hold both lines in every language from 1,100 px; under it the column takes four.
test('the home page\'s live blocks keep each line inside their column in every language', () => {
  const home = read('styles/home.css');
  assert.match(home, /\n\.stream \{ grid-column: 10 \/ span 3;/);
  assert.match(home, /\n@media \(min-width: 861px\) and \(max-width: 1099px\) \{ \.stream \{ grid-column: 9 \/ span 4; \} \}/);
  assert.match(home, /\n\.blk-in \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; grid-template-rows: 24px 18px; column-gap: 12px;/);
  assert.match(home, /\n\.blk-h \{ grid-column: 1 \/ -1; display: flex; align-items: baseline; gap: 12px;/);
  assert.match(home, /\n\.blk-age \{ grid-area: 2 \/ 2;/);
  assert.match(home, /\n\.blk-by \{ grid-area: 2 \/ 1; display: flex; min-width: 0; white-space: nowrap; overflow: hidden;/);
  const live = code('app/HomeClient.tsx');
  assert.match(live, /<span className="blk-h">\n\s*<span className="flash"[^\n]*\n\s*<span className="blk-txs">\{txCountText\(b\.txCount, t\)\}<\/span>\n\s*<\/span>/);
  assert.match(live, /<span className="blk-by">\n\s*\{b\.producer \? <EntityLink kind="node"[^\n]*\n\s*<\/span>/);
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    const t = translator(locale, catalog);
    // A height to 99,999,999 at 15 px (.62 em a character where a script drops its -.02 em), the gap, the count at 11.5 px.
    const first = 10 * 0.62 * 15 + 12 + textLength(txCountText(99_999, t), 0.62) * 0.62 * 11.5;
    // The age's box in the row's characters (1ch, .62 em) and the gap before it; the producer keeps 48 px of the rest.
    const second = 12 + Math.ceil(wordsLength(ageForms(t))) * 0.62 * 11.5 + 48;
    for (let w = 861; w <= 1440; w++) {
      const room = columnsWidth(w, w <= 1099 ? 4 : 3);
      assert.ok(first <= room && second <= room, `${locale} at ${w}px: ${first.toFixed(0)} and ${second.toFixed(0)} in ${room.toFixed(0)}`);
    }
  }
});

// "<from> to <to>" on one line, a record without a recipient shows its sender alone, the line cut in the
// middle to fit its column at every width.
test('the list\'s From / To: one line, the sender alone without a recipient, each side as whole as its cell allows', async () => {
  // The one flexible column: no width of its own, so it takes what the fixed columns leave; one line of a 44 px row.
  const columns = code('components/explorer/columns.tsx');
  assert.match(columns, /export function fromToCol<R>\(\n[^)]*\): Column<R> \{\n\s*return \{ key: 'ft', header: t\('col_from_to'\), min: FROM_TO_MIN, cell: \(r\) => <FromTo from=\{from\(r\)\} to=\{to\(r\)\} full=\{full\} \{\.\.\.more\?\.\(r\)\} \/> \};/);
  assert.equal(TEXTS.col_from_to, 'From / To');
  assert.match(read('styles/base.css'), /\.tbl td \{ height: var\(--row\);[^}]*white-space: nowrap;/);
  const list = code('app/explorer/ExplorerClient.tsx');
  assert.match(list, /fromToCol<ActivityItem>\(t, \(r\) => r\.from, \(r\) => r\.to, full\)/);
  for (const file of ['app/explorer/ExplorerClient.tsx', 'app/explorer/block/[hash]/BlockClient.tsx', 'app/explorer/loading.tsx']) assert.doesNotMatch(code(file), /\btall\b/, file);
  // "to" is a word of its own between the sides, in Fog, never an arrow; no recipient, no "to".
  const cells = code('components/explorer/cells.tsx');
  assert.match(cells, /<span className="ex-ft ent-fit">\n\s*\{noFrom && fromWord \? <span className="ex-ft-w">\{fromWord\}<\/span> : side\(from\)\}\n\s*\{!noTo && <span className="ex-ft-to">\{t\('party_to'\)\}<\/span>\}\n\s*\{!noTo && side\(to\)\}\n\s*\{noTo && toWord && <span className="ex-ft-w">\{toWord\}<\/span>\}/);
  assert.match(cells, /const noTo = partyKind\(to\) === 'none';/);
  const sheet = read('styles/explorer.css');
  assert.match(sheet, /\.ex-ft \{ display: flex; align-items: baseline; gap: 0 1ch; min-width: 0; max-width: 100%; white-space: nowrap; \}\n\.ex-ft > \* \{ flex: 0 1 auto; \}/);
  assert.doesNotMatch(sheet, /ex-ft-arr|ex-ft-l\b|flex-direction: column; gap: 2px/);
  // Every transaction list uses the one column: the list, a block's, an address's (its own side in Fog), QNC and token
  // transfers (tokens issued or burned have a word for the empty side); no separate From and To columns remain.
  const address = english('app/explorer/address/[address]/AddressClient.tsx');
  assert.match(address, /fromToCol<AddressTx>\(t, \(x\) => x\.from, \(x\) => x\.to, full, \(\) => \(\{ self: address \}\)\),/);
  assert.match(address, /fromToCol<TokenTransfer>\(t, \(x\) => x\.from, \(x\) => x\.to, full, \(\) => \(\{ self: address, fromWord: 'Issued', toWord: 'destroyed' \}\)\),/);
  assert.match(code('app/explorer/qnc/QncClient.tsx'), /fromToCol<QncTransfer>\(t, \(x\) => x\.from, \(x\) => x\.to, full\),/);
  assert.match(english('app/explorer/token/[contract]/TokenClient.tsx'), /fromToCol<TokenTransfer>\(t, \(x\) => x\.from, \(x\) => x\.to, full, \(\) => \(\{ toWord: 'burned' \}\)\),/);
  for (const file of ['app/explorer/qnc/QncClient.tsx', 'app/explorer/token/[contract]/TokenClient.tsx', 'app/explorer/address/[address]/AddressClient.tsx']) {
    assert.doesNotMatch(code(file), /'From', \(|'To', \(|Counterparty/, file);
  }
  // A block's list names no recipient for a record without one, as the other lists do, never the sender again.
  const blockRoute = code('app/api/blocks/[hash]/route.ts');
  assert.doesNotMatch(blockRoute, /to_address \|\| tx\.from_address|\(t\.to as string\) \|\| \(t\.from as string\)/);
  assert.equal(blockRoute.match(/to: (?:tx\.to_address|\(t\.to as string\)) \|\| 'N\/A',/g)?.length, 2);
  // In a sideways frame the column holds both sides in their longest short form (a node id's 20 characters) and "to";
  // an exact amount's column holds 20 characters, its icon and its unit.
  const { FROM_TO_MIN, AMOUNT_W } = await import('../geometry.ts');
  assert.equal(FROM_TO_MIN, Math.ceil(44 * 7.75) + 14);
  assert.equal(AMOUNT_W, 221);
  // The tokens directory, the widest table that still uses a frame, fits its frame where the frame stops scrolling.
  const tokens = tableMinWidth([{ width: 220 }, { width: 104 }, { min: 128 }, { width: 220 }, { width: 156 }, { width: 136 }, { width: 108 }]);
  assert.ok(contentWidth(1181) >= tokens, `${contentWidth(1181)} < ${tokens}`);
  assert.match(code('app/explorer/tokens/TokensClient.tsx'), /<EntityLink kind="address" value=\{x\.contract_address\} link=\{false\} \/>, undefined, undefined, 128\),/);
  assert.equal(FLEX_MIN, 176);
  // The list at 1,181 px, where tables stop stacking: the fixed columns leave From / To room for both short sides.
  assert.match(list, /hashCol<ActivityItem>\(t, \(r\) => r\.hash\),\n\s*typeCol<ActivityItem>\(t, \(r\) => r\.type, full\),/);
  assert.match(list, /amountCol<ActivityItem>\(t, \(r\) => <TxAmount parts=\{rowAmount\(r, t\('token_unnamed'\)\)\} logo=\{r\.tokenLogo\} \/>, t\('col_amount'\), amountW\),\n\s*\{ \.\.\.blockCol<ActivityItem>\(t, \(r\) => r\.block, 92\), \.\.\.block \},\n\s*timeCol<ActivityItem>\(t, \(r\) => r\.timestamp, 72\),/);
  const fixed = 136 + 136 + AMOUNT_W + 92 + 72;
  assert.ok(contentWidth(1181) - fixed >= FROM_TO_MIN, `${contentWidth(1181) - fixed} < ${FROM_TO_MIN}`);
});

// Transaction and block lists are tables on phones too ("let the table simply scroll to the right"): one
// line a row at one height, scrolled sideways inside their frame with the first column pinned and a fade at the right
// while columns follow; the page never scrolls sideways. A list of holders still lays each row out in place below a
// computer's width; its cells keep their table semantics through roles, and only a sort control of the header shows.
test('transaction and block lists scroll sideways in their frame with the first column pinned; holder lists stack', () => {
  const table = code('components/ui/DataTable.tsx');
  assert.match(table, /const role = \(r: string\) => \(stack \? r : undefined\);/);
  assert.match(table, /data-stack=\{stack\}/);
  assert.match(table, /stack\?: 'holders';/);
  assert.match(table, /<td key=\{live \? `\$\{key\}:\$\{c\.key\}` : c\.key\} role=\{role\('cell'\)\} data-k=\{c\.key\} data-align=\{c\.align\}>/);
  for (const r of ["role={role('table')}", "<thead role={role('rowgroup')}>", "<tr role={role('row')}>", "role={role('columnheader')}", "<tbody role={role('rowgroup')}>"]) assert.ok(table.includes(r), r);
  const base = read('styles/base.css');
  // The frame: sideways scroll inside it, the first column pinned over an opaque ground, a fade while columns follow.
  assert.match(base, /\.tbl-frame\[data-scroll='true'\] \{ overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; \}/);
  assert.match(base, /\.tbl-frame\[data-scroll='true'\] \.tbl \{ width: max\(100%, var\(--tbl-min, 100%\)\); \}/);
  // On the reading direction's start and end sides: left and right in a left-to-right page, mirrored in Arabic.
  assert.match(base, /\.tbl-frame\[data-scroll='true'\] \.tbl th:first-child, \.tbl-frame\[data-scroll='true'\] \.tbl td:first-child \{ position: sticky; inset-inline-start: 0; z-index: 2; background: var\(--ink\); \}/);
  assert.match(base, /\.tbl-frame\[data-over='true'\]::after \{\n\s*content: ''; position: absolute; top: 0; inset-inline-end: 0; bottom: 0; width: 24px; pointer-events: none;/);
  // The pinned cell is the containing block of its entity's row overlay, so the overlay never covers another cell's link.
  assert.match(base, /\.tbl tbody td:first-child > a\.ent \{ position: static; \}/);
  // One line a row at one height.
  assert.match(base, /\.tbl td \{ height: var\(--row\); padding: 0; padding-inline-end: 14px; border-bottom: 1px solid var\(--rule\); color: var\(--text\); white-space: nowrap;/);
  // No stacked layout of transactions or blocks is left.
  assert.doesNotMatch(base, /data-stack='tx'|data-stack='blocks'/);
  const wide = base.slice(base.indexOf('@media (max-width: 1180px) {\n  .tbl-frame[data-scroll][data-stack]'));
  assert.match(wide, /^@media \(max-width: 1180px\) \{\n\s*\.tbl-frame\[data-scroll\]\[data-stack\] \{ overflow: visible; \}/);
  // Holders: one line on a tablet, two on a phone (rank and address; balance and share).
  assert.match(wide, /\.tbl-frame\[data-scroll\]\[data-stack='holders'\] \.tbl tbody tr \{\n\s*grid-template-columns: auto minmax\(0, 1fr\) auto auto; grid-template-areas: 'rank address amount pct'; gap: 0 16px; height: var\(--row\);/);
  assert.match(wide, /grid-template-areas: 'rank address pct' 'amount amount amount'; height: var\(--row-2\);/);
  // One column set for both holder lists, each row ranked.
  assert.match(code('components/explorer/columns.tsx'), /export function holderCols<R extends \{ address: string; percent: string; rank: number \}>\(t: T, balance: Get<R, ReactNode>, full: boolean, amounts: readonly \{ value: string; unit: string \}\[\]\): Column<R>\[\] \{/);
  assert.match(code('app/explorer/qnc/QncClient.tsx'), /const holderColumns = useMemo\(\n\s*\(\) => holderCols<QncHolder & \{ rank: number \}>\(t, \(h\) => <Amount value=\{h\.balance\} \/>, full, \(data\?\.holders \?\? \[\]\)\.map\(/);
  assert.match(code('app/explorer/token/[contract]/TokenClient.tsx'), /const rankedHolders = useMemo\(\(\) => \(holders \? holders\.map\(\(h, i\) => \(\{ \.\.\.h, rank: i \+ 1 \}\)\) : null\), \[holders\]\);/);
  for (const file of ['app/explorer/qnc/QncClient.tsx', 'app/explorer/token/[contract]/TokenClient.tsx']) assert.doesNotMatch(code(file), /'pct', 'Share'/, file);
  assert.match(wide, /\.tbl th\[aria-sort\] \{ position: static;/);
  // A stacked row is a grid: a cell that kept the sticky column's z-index would paint the first entity's row overlay above
  // the row's other links.
  assert.match(wide, /\.tbl-frame\[data-scroll\]\[data-stack\] \.tbl tbody td \{\n\s*display: flex;[^}]*position: static; z-index: auto;/);
  // Only the holder lists stack; every transaction list and the block history are tables in their frame.
  for (const [file, holders] of [['app/explorer/ExplorerClient.tsx', 0], ['app/explorer/loading.tsx', 0], ['app/explorer/block/[hash]/BlockClient.tsx', 0], ['app/explorer/address/[address]/AddressClient.tsx', 0], ['app/explorer/qnc/QncClient.tsx', 1], ['app/explorer/token/[contract]/TokenClient.tsx', 1], ['app/explorer/blocks/BlocksClient.tsx', 0]]) {
    const src = code(file);
    assert.doesNotMatch(src, /\bstack="(tx|blocks)"/, file);
    assert.equal(src.match(/<DataTable\b[^>]*?\bstack="holders"/g)?.length ?? 0, holders, file);
  }
});

// The sheets from before the rebuild (the old light theme, the old explorer's tables, badges and search) matched no
// element any more: they are gone, and no sheet of the site names their classes.
test('no rule of the old light theme or the old explorer is left', () => {
  for (const file of ['app/globals.css', 'app/mobile-fixes.css']) assert.equal(existsSync(new URL(file, SRC)), false, file);
  const sheets = allSheets();
  assert.doesNotMatch(sheets, /\.(?:table-wrapper|explorer-search|search-btn|explorer-section|qnet-button|activity-table|type-badge|badge-transfer|node-card)\b/);
  assert.doesNotMatch(sheets.replace(/\/\*[\s\S]*?\*\//g, ''), /#f8f9fa|#f0f0f0|#e9ecef|background(?:-color)?: (?:#fff(?:fff)?|white)\b/i);
});

test('text keeps its size on a phone, and monospace text takes one stack of the platform\'s own fonts', () => {
  const base = read('styles/base.css');
  const tokens = read('styles/tokens.css');
  const sheets = ['base', 'shell', 'home', 'explorer', 'cabinet', 'pages'].map((name) => read(`styles/${name}.css`)).join('\n');
  const html = base.match(/(?:^|\n)html \{([^}]*)\}/)[1];
  assert.match(html, /-webkit-text-size-adjust: 100%;/);
  assert.match(html, /(^|[^-])text-size-adjust: 100%;/);
  // One mono stack: the self-hosted face next/font sets on <html> (src/app/fonts.ts), then the platform's own.
  // A script's own faces (--f-script, styles/i18n.css) and the stand-in come between the face and the platform's.
  assert.match(tokens, /--font-mono: var\(--font-martian\), var\(--f-script\) 'Martian Stand-in', ui-monospace, Menlo, Consolas, monospace;/);
  assert.match(code('app/fonts.ts'), /export const martian = Martian_Mono\(\{[^}]*axes: \['wdth'\],[^}]*variable: '--font-martian',/);
  assert.match(code('app/layout.tsx'), /className=\{`\$\{archivo\.variable\} \$\{cyrillic\.variable\} \$\{martian\.variable\}`\}/);
  assert.doesNotMatch(sheets + tokens, /@font-face/);
  // Every family is one of the tokens or inherited, so no other monospace stack is written anywhere in the sheets.
  for (const m of sheets.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/font-family: ([^;]+);/g)) assert.ok(['var(--font-mono)', 'var(--f-sans)', 'inherit'].includes(m[1].trim()), m[1]);
  assert.ok([...sheets.matchAll(/font-family: var\(--font-mono\);/g)].length >= 25);
  // Outside the sheet: inline styles and the guide's pictures name the token; the background's canvas reads it once.
  for (const file of SOURCES) {
    const src = code(file);
    for (const m of src.matchAll(/fontFamily[:=]\s*\{?\s*['"]([^'"]+)['"]/g)) {
      if (/mono/i.test(m[1])) assert.equal(m[1], 'var(--font-mono)', file);
    }
    const named = src.match(/monospace|Menlo|Consolas/g) ?? [];
    assert.equal(named.length, 0, file);
  }
  const art = code('components/cabinet/GuideArt.tsx');
  assert.match(art, /const MONO = \{ fontFamily: 'var\(--font-mono\)' \};/);
  assert.match(art, /style=\{MONO\}/);
  assert.doesNotMatch(art, /fontFamily[=:]\s*\{?[^}\n]*MONO/);
  // The field's canvas reads the stack once (next/font names the family by a hash) and draws its glyph atlas with it.
  assert.match(code('components/field/Field.tsx'), /const font = getComputedStyle\(document\.documentElement\)\.getPropertyValue\('--font-mono'\)\.trim\(\);/);
  const rain = code('lib/field/rain.ts');
  assert.match(rain, /x\.font = `400 \$\{Math\.round\(cell \* 0\.72\)\}px \$\{this\.font\}`;/);
  assert.equal((rain.match(/\bx\.font = /g) ?? []).length, 1);
});

// One exact format, 42,578.81988, in the lists as on the block, transaction and My node pages: every list API carries
// the raw amount and the page writes it with the one formatter.
test('list amounts are exact like every other amount: raw in the APIs, written by the one formatter', async () => {
  const { rowAmount } = await import('../explorer-view.ts');
  const TOKEN = '4f1c9a2b3c4d5e6f708eon1a2b3c4d5e6f7081d9b40c1';
  assert.deepEqual(rowAmount({ amount_raw: '124918602122777' }), { value: '124,918.602122777', unit: 'QNC' });
  assert.deepEqual(rowAmount({ amount_raw: '42578819880000' }), { value: '42,578.81988', unit: 'QNC' });
  assert.deepEqual(rowAmount({ amount_raw: '18446744073709551615' }), { value: '18,446,744,073.709551615', unit: 'QNC' }, 'past 2^53, exact');
  for (const none of ['0', '', null, undefined]) assert.equal(rowAmount({ amount_raw: none }), null, String(none));
  // A token transfer in the token's own decimals, its unit the token (the link to its page); a call that moves no token
  // shows the QNC it moved.
  assert.deepEqual(rowAmount({ amount_raw: '0', tokenContract: TOKEN, tokenSymbol: 'QUSD', tokenAmountRaw: '12500000', tokenDecimals: 6 }), { value: '12.5', unit: 'QUSD', token: TOKEN });
  assert.equal(rowAmount({ amount_raw: '0', tokenContract: TOKEN, tokenSymbol: 'QUSD' }), null);
  // The APIs: /api/activity rows (the head snapshot's too) and /api/address carry nano QNC; /api/tx its amount and fee.
  const rows = code('lib/enrich-activity.ts');
  assert.match(rows, /amount_raw: String\(tx\.amount \|\| '0'\),/);
  assert.match(rows, /\{ \.\.\.base, \.\.\.token, tokenAmountRaw, tokenDecimals: meta\.decimals \}/);
  assert.doesNotMatch(rows, /\bamount: /);
  const address = code('app/api/address/[address]/route.ts');
  assert.match(address, /amount_raw: String\(tx\.amount \|\| '0'\),/);
  assert.equal(address.match(/\.\.\.accountView\(account\),/g)?.length, 2);
  // The node's account read keeps a balance past 2^53 exact, as the block route does.
  assert.match(address, /return \{ answered: true, account: JSON\.parse\(quoteBigInts\(await res\.text\(\)\)\) \};/);
  assert.match(code('app/api/tx/[hash]/route.ts'), /JSON\.parse\(quoteBigInts\(text\)\)/);
  assert.equal(code('app/api/tx/[hash]/route.ts').match(/fee_raw: feeRaw,/g)?.length, 2);
  // The pages write the raw amount through rowAmount (qnc and amount of src/lib/format.ts) and nothing else.
  assert.match(code('app/explorer/ExplorerClient.tsx'), /<TxAmount parts=\{rowAmount\(r, t\('token_unnamed'\)\)\} logo=\{r\.tokenLogo\} \/>/);
  assert.match(code('app/explorer/qnc/QncClient.tsx'), /<TxAmount parts=\{rowAmount\(x, t\('token_unnamed'\)\)\} \/>/);
  assert.match(code('app/explorer/address/[address]/AddressClient.tsx'), /<Readout label=\{t\('col_balance'\)\} value=\{system \|\| !d \|\| d\.balance_raw === null \? null : qnc\(d\.balance_raw\)\}/);
  // A listed row seeds the transaction page with the same raw amount, never a rounded text.
  assert.match(code('app/explorer/ExplorerClient.tsx'), /from: tx\.from, to: tx\.to, amount_raw: tx\.amount_raw \}/);
  // The float-based two-decimal formatter is gone from the whole site.
  for (const file of SOURCES.concat(sources('lib'), sources('server'))) {
    assert.doesNotMatch(code(file), /\bformatAmount\b|formatTokenAmountWithSymbol/, file);
  }
});

// No "/" key mark inside the search field, and no ring around the input alone standing off it and past the button: the
// field and Search are one group of one height, flush; focus
// marks the whole group with a 2 px Signal edge over its own border, nothing outside it. The words in the empty field
// fit every width: the whole sentence on a computer, a short one on a phone.
test('the explorer search: one group of one height, focus on the group, its words never cut, no key mark', () => {
  const search = code('components/explorer/ExplorerSearch.tsx');
  assert.doesNotMatch(search, /<kbd|ex-search-key|ex-search-box/);
  assert.match(search, /<div className="ex-search-row">\n\s*<input\n[\s\S]*?className="ex-search-q"\n\s*type="search"\n\s*placeholder=" "/);
  assert.match(search, /<span className="ex-search-ph" aria-hidden="true">\n\s*<span className="ex-ph-long">\{t\('search_label'\)\}<\/span>\n\s*<span className="ex-ph-short">\{t\('search_short'\)\}<\/span>\n\s*<\/span>\n\s*<button type="submit" className="btn btn-solid btn-sm ex-search-go">\{t\('search_go'\)\}<\/button>/);
  assert.match(search, /<label className="sr-only" htmlFor=\{`\$\{id\}-q`\}>\{t\('search_label'\)\}<\/label>/);
  assert.equal(TEXTS.search_label, 'Search by block, transaction hash, address or token');
  assert.equal(TEXTS.search_short, 'Block, hash, address or token');
  assert.equal(TEXTS.search_go, 'Search');
  assert.match(search, /if \(e\.key !== '\/' \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey\) return;/);
  assert.match(search, /const height = heightOf\(q\);\n\s*if \(height !== null\) return `\/explorer\/block\/\$\{height\}`;/);
  // Nothing in the field itself draws a border or a ring of its own.
  assert.doesNotMatch(search, /className="field/);
  const sheet = read('styles/explorer.css');
  assert.doesNotMatch(sheet, /ex-search-key|ex-search-box/);
  assert.match(sheet, /\.ex-search-row \{\n\s*display: grid; grid-template-columns: minmax\(0, 1fr\) auto; height: 60px; overflow: hidden; background: var\(--fill-field\);\n\s*border: 1px solid var\(--edge\); border-radius: var\(--radius\);/);
  assert.match(sheet, /\.ex-search-row:focus-within \{ border-color: var\(--signal\); background: var\(--fill-field-focus\); outline: 2px solid var\(--signal\); outline-offset: -2px; \}/);
  assert.match(sheet, /\.ex-search-q:focus-visible \{ outline: none; \}/);
  assert.match(sheet, /\.ex-search-go \{ grid-area: 1 \/ 2; height: 100%; border-radius: 0; \}/);
  assert.match(sheet, /\.ex-search-q:not\(:placeholder-shown\) \+ \.ex-search-ph \{ visibility: hidden; \}/);
  assert.match(sheet, /\.ex-sugg \{\n\s*position: absolute; left: 0; right: 0; top: calc\(100% \+ 4px\);/);
  const phone = sheet.slice(sheet.indexOf('@media (max-width: 720px) {'));
  assert.match(phone, /\.ex-search-row \{ height: 52px; \}\n\s*\.ex-search-q, \.ex-search-ph \{ padding: 0 14px; font-size: 16px; \}\n\s*\.ex-ph-long \{ display: none; \}\n\s*\.ex-ph-short \{ display: inline; \}/);
  // Never cut in any language: words longer than the field take a second line, inside the field's height at its line
  // height.
  const ph = sheet.match(/\n\.ex-search-ph \{([^}]*)\}/)[1];
  assert.doesNotMatch(ph, /nowrap|ellipsis/);
  assert.match(ph, /display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; text-wrap: balance;/);
  assert.match(sheet, /\.ex-search-q, \.ex-search-ph \{ grid-area: 1 \/ 1; min-width: 0; padding: 0 18px; font-size: clamp\(17px, 1\.55vw, 20px\); line-height: 1\.3; \}/);
  assert.ok(2 * 20 * 1.3 <= 60 - 2 && 2 * 16 * 1.3 <= 52 - 2, 'two lines fit the field');
});

// From the latest blocks a person can open the whole block history. /explorer/blocks lists every block
// newest first, BLOCKS_PER_PAGE a page counted down from page 1's first height, with a pager and a jump to a height.
test('the block history: every height once, pages counted from page 1, a typed height opens its page', async () => {
  const { BLOCKS_PER_PAGE, heightOf, blockWindow, blocksAnchor, blocksPage, blocksPageTop } = await import('../explorer-view.ts');
  assert.equal(BLOCKS_PER_PAGE, 50);
  for (const [text, want] of [['17,500', 17500], [' 17 500 ', 17500], ['0', 0], ['007', 7], ['9007199254740991', 9007199254740991]]) assert.equal(heightOf(text), want, text);
  for (const text of ['', 'abc', '-1', '1.5', '12e3', '0x10', '12345678901234567', '9007199254740993']) assert.equal(heightOf(text), null, text);

  // A page: its heights from the top down, the read's rows in place, a height the index lacks as the height alone.
  const row = (h) => ({ height: h, hash: `h${h}`, timestamp: 1_792_000_000_000 + h, producer: 'genesis_node_001', producerAddress: null, txCount: 1 });
  const small = blockWindow(5, [row(5), row(3), row(99)]);
  assert.deepEqual(small.map((b) => b.height), [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(small.map((b) => b.hash), ['h5', null, 'h3', null, null, null]);
  const full = blockWindow(120, Array.from({ length: 60 }, (_, i) => row(130 - i)));
  assert.equal(full.length, 50);
  assert.deepEqual([full[0].height, full[49].height], [120, 71]);

  // Pages from the anchor: page 1 starts there, the last ends at Genesis, the counts are the blocks from 0.
  assert.deepEqual(blocksPage(18450, 18450), { page: 1, pages: 370, total: 18451 });
  assert.equal(blocksPageTop(18450, 370), 0);
  assert.deepEqual(blocksPage(18450, 0), { page: 370, pages: 370, total: 18451 });
  // Every height from the anchor to Genesis on exactly one page.
  for (const anchor of [0, 49, 50, 123, 1000]) {
    const { pages } = blocksPage(anchor, anchor);
    const seen = [];
    for (let n = 1; n <= pages; n++) seen.push(...blockWindow(blocksPageTop(anchor, n), []).map((b) => b.height));
    assert.deepEqual(seen, Array.from({ length: anchor + 1 }, (_, i) => anchor - i), String(anchor));
  }
  // A typed height starts its page and the pages are counted again from the head, so page 1 is never a page behind it.
  assert.equal(blocksAnchor(1000, 18450), 18450);
  assert.equal(blocksAnchor(1000, 18460), 18450);
  assert.deepEqual(blocksPage(blocksAnchor(1000, 18460), 1000), { page: 350, pages: 370, total: 18451 });
  assert.equal(blocksAnchor(500, 500), 500);
  assert.equal(blocksAnchor(900, 500), 500, 'a height past the head starts at the head');
  for (const [top, head] of [[0, 0], [7, 1234], [1233, 1234], [17500, 2_851_200]]) {
    const anchor = blocksAnchor(top, head);
    assert.ok(anchor <= head && head - anchor < 50 && (anchor - top) % 50 === 0, `${top} ${head}`);
  }
});

test('the block history reads one page at a time from the index, and the latest blocks lead to it', () => {
  // One bounded read: a range of the height key, at most BLOCKS_PER_PAGE rows; the newest list still reads the snapshot.
  const db = read('../lib/db.ts');
  assert.match(db, /'SELECT height, hash, timestamp, producer, producer_address, tx_count FROM blocks WHERE height <= \$1 AND height > \$2 ORDER BY height DESC', \[top, top - n\]\);/);
  const route = code('app/api/blocks/route.ts');
  assert.match(route, /const at = heightOf\(atText\);\n\s*if \(at === null\) return NextResponse\.json\(\{ success: false, error: 'Invalid block height' \}, \{ status: 400 \}\);/);
  assert.match(route, /const rows = await getLatestBlocks\(BLOCKS_PER_PAGE, at\);/);
  assert.match(route, /const \{ blocks \} = await headHub\.snapshot\(\);/);
  assert.match(code('lib/explorer-reads.ts'), /export const blocksPath = \(top: number\): string => `\/api\/blocks\?at=\$\{top\}`;/);
  // The page paints with its rows (the route's own answer), placed in the pages from the head.
  const page = code('app/explorer/blocks/page.tsx');
  assert.match(page, /const top = Math\.min\(asked \?\? head, head\);/);
  assert.match(page, /<BlocksClient first=\{await firstAnswer\(blocksRoute, blocksPath\(top\)\)\} top=\{top\} anchor=\{blocksAnchor\(top, head\)\} \/>/);
  assert.match(code('app/explorer/blocks/loading.tsx'), /return <BlocksClient \/>;/);
  const client = code('app/explorer/blocks/BlocksClient.tsx');
  // Fixed rows, every height a link, the hash a second view of the row's block; the pager whenever the page is placed.
  assert.match(client, /textCol<RecentBlock>\('block', t\('col_block'\), \(b\) => <EntityLink kind="block" value=\{b\.height\} \/>, 112\),/);
  assert.match(client, /<EntityLink kind="block" value=\{b\.hash\} link=\{false\} \/>/);
  assert.match(client, /<EntityLink kind="node" value=\{b\.producer\} address=\{b\.producerAddress\} \/>/);
  assert.match(client, /loadingRows=\{BLOCKS_PER_PAGE\}/);
  assert.match(client, /\{at && <Pager page=\{at\.page\} pages=\{at\.pages\} total=\{at\.total\} onPage=\{onPage\} \/>\}/);
  assert.match(client, /go\(\{ anchor: blocksAnchor\(h, newest\), top: h \}\);/);
  // The page's own address, its language included.
  assert.match(client, /const path = window\.location\.pathname;\n\s*window\.history\.replaceState\(null, '', newest \? path : `\$\{path\}\?at=\$\{next\.top\}`\);/);
  // Only the line of newer blocks renders for each head; the table renders for its own rows.
  assert.equal(client.match(/useChainHead\(\)/g)?.length, 1);
  assert.match(client, /function NewerBlocks\([^\n]*\) \{\n\s*const t = useT\(\);\n\s*const \{ height \} = useChainHead\(\);/);
  assert.match(client, /const table = useMemo\(\(\) => \(\n\s*<DataTable/);
  assert.match(read('styles/explorer.css'), /\.ex-newer\[data-on='false'\] \{ visibility: hidden; \}/);
  // The strip of latest blocks names the history as a link of its own.
  assert.match(code('components/explorer/LatestBlocks.tsx'), /<Action kind="act" href="\/explorer\/blocks" className="ex-chain-all">\{t\('ex_all_blocks'\)\}<\/Action>/);
});
