// Every entity the site names leads to its page in one look (B-SPEC 5.7, owner 19.10): blocks, transactions,
// addresses, node ids, tokens, QNC, epochs and Solana transactions, with one set of short forms and the site's one
// number format. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entity, epochHref, isAddressShape } from '../entity.ts';
import { epochOfHeight } from '../cabinet/epochs.ts';
import { ago, endsIn, epochMs, inWords, int, short, span, when, day } from '../format.ts';
import { code, read } from './source.mjs';

const ADDRESS = '4f1c9a8e2b7d03c5a91eon7b20e6d4c8f13a5e2d9b40c';
const HASH = '345652a3c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708a034a48';
const SOLANA = '3xT9kVq2pZ8mN4bR6sW1yE7uH5jC9gF2aD8kL4nP6qS1tV3xY5zB7mYc7Ws';

test('a block by its height or hash, a transaction and an address go to their pages, written short', () => {
  assert.deepEqual(entity('block', 4087305), { href: '/explorer/block/4087305', text: '4,087,305', title: '4087305', external: false });
  assert.equal(entity('block', '4087305').href, '/explorer/block/4087305');
  assert.equal(entity('block', 0).text, '0');
  assert.deepEqual(entity('block', HASH), { href: `/explorer/block/${HASH}`, text: '345652a3…034a48', title: HASH, external: false });
  assert.deepEqual(entity('tx', HASH), { href: `/explorer/tx/${HASH}`, text: '345652a3…034a48', title: HASH, external: false });
  assert.equal(entity('tx', HASH, { full: true }).text, HASH);
  assert.deepEqual(entity('address', ADDRESS), { href: `/explorer/address/${ADDRESS}`, text: '4f1c9a…d9b40c', title: ADDRESS, external: false });
  assert.equal(entity('address', ADDRESS, { compact: true }).text, '4f1c…b40c');
  // The one ellipsis character, never three dots.
  for (const kind of ['tx', 'address']) assert.doesNotMatch(entity(kind, kind === 'tx' ? HASH : ADDRESS).text, /\.\.\./);
});

test('names without a page are text in the same look: system accounts, node ids without an address; an epoch leads to its first block', () => {
  assert.deepEqual(entity('address', 'system_rewards_pool'), { href: null, text: 'system_rewards_pool', title: 'system_rewards_pool', external: false });
  assert.equal(isAddressShape('system_rewards_pool'), false);
  assert.equal(entity('node', 'genesis_node_003').href, null);
  assert.equal(entity('node', 'genesis_node_003').text, 'genesis_node_003');
  // Up to 16 characters whole; longer: the prefix through its last "_", "…" and the last 8.
  assert.equal(entity('node', 'super_node_c78c3017a4f93464').text, 'super_node_…a4f93464');
  assert.equal(short('node', 'light_mobile_9c41f0e28a138a13'), 'light_mobile_…8a138a13');
  // A node whose address is known (a block's producer_address) links to that address.
  const producer = entity('node', 'genesis_node_003', { address: ADDRESS });
  assert.equal(producer.href, `/explorer/address/${ADDRESS}`);
  assert.equal(producer.text, 'genesis_node_003');
  // Owner 19.10: epochs are clickable. Epoch N holds blocks N × 14,400 on (src/lib/cabinet/epochs.ts), so it leads to
  // its first block; the readouts' epoch uses the same rule.
  assert.deepEqual(entity('epoch', 283), { href: '/explorer/block/4075200', text: 'Epoch 283', title: 'Epoch 283, from block 4,075,200', external: false });
  assert.equal(epochHref(epochOfHeight(4_104_881)), '/explorer/block/4104000');
  assert.equal(entity('epoch', 1283).text, 'Epoch 1,283');
  assert.equal(entity('epoch', 'soon').href, null);
  assert.match(code('components/explorer/ChainReadouts.tsx'), /value=\{reading \? reading\.value : epoch\}\s*href=\{!reading && at \? epochHref\(at\.epoch\) : undefined\}/);
  // A value of another shape is no hash: text, never a link to a page that cannot exist.
  assert.equal(entity('tx', 'not a hash').href, null);
  assert.equal(entity('block', '12ab').href, null);
});

test('tokens, QNC and Solana transactions', () => {
  assert.deepEqual(entity('token', ADDRESS, { symbol: 'QUSD' }), { href: `/explorer/token/${ADDRESS}`, text: 'QUSD', title: ADDRESS, external: false });
  assert.deepEqual(entity('qnc', ''), { href: '/explorer/qnc', text: 'QNC', title: 'QNC', external: false });
  const sol = entity('solana-tx', SOLANA);
  assert.equal(sol.external, true);
  assert.match(sol.href, new RegExp(`^https://explorer\\.solana\\.com/tx/${SOLANA}\\?cluster=(devnet|mainnet)`));
  assert.equal(sol.text, '3xT9kV…mYc7Ws');
});

test('the component: one look, the full value in the title and the name, an amount whose unit is the link', () => {
  const link = code('components/ui/EntityLink.tsx');
  assert.match(link, /const e = entity\(kind, value, \{ full, address, symbol, compact \}\);/);
  assert.match(link, /<IntentLink className=\{cls\} href=\{e\.href\} title=\{e\.title\} aria-label=\{e\.title\} style=\{cut\}>\{content\}<\/IntentLink>/);
  assert.doesNotMatch(link, /from 'next\/link'/);
  // An entity's page is never read ahead as its link comes into view (a list of fifty rows was fifty page reads per
  // screen), only as the visitor points at it, focuses it or touches it.
  const intent = code('components/ui/IntentLink.tsx');
  assert.match(intent, /prefetch=\{false\}/);
  for (const on of ['onMouseEnter', 'onFocus', 'onTouchStart']) assert.ok(intent.includes(`${on}={(e) => { ahead(); ${on}?.(e); }}`), on);
  assert.match(intent, /const ahead = \(\) => router\.prefetch\(href\);/);
  const readouts = code('components/ui/Readouts.tsx');
  assert.match(readouts, /<IntentLink className="ro-v" href=\{href\}/);
  assert.doesNotMatch(readouts, /from 'next\/link'/);
  // The site's navigation keeps Next.js's own read-ahead.
  assert.doesNotMatch(code('components/Header.tsx'), /prefetch=\{false\}/);
  assert.match(link, /<span className=\{cls\} title=\{e\.title\} style=\{cut\}>\{content\}<\/span>/);
  assert.match(link, /target="_blank" rel="noopener noreferrer"/);
  // No arrow after a link off the site (owner 19.10): it is shown by its colour and underline.
  assert.doesNotMatch(link, /className="arr"/);
  // Owner 20.10: a shortened value shows as much as its cell allows (a table's flexible column, a side of From / To):
  // the head of the whole value cut with "…" and the tail of its short form, at the narrowest four characters of the
  // head, "…" and the tail. A block height, only grouped, has nothing more to show.
  assert.match(link, /const at = !full && !compact && label === undefined && CUTS\.has\(kind\) \? e\.text\.indexOf\('…'\) : -1;/);
  assert.match(link, /const cut = at > 0 \? \(\{ '--ent-min': `\$\{Math\.min\(e\.text\.length, tail\.length \+ 5\)\}ch` \} as CSSProperties\) : undefined;/);
  assert.match(link, /<span className="ent-short">\{e\.text\}<\/span>\n\s*<span className="ent-mid">\n\s*<span className="ent-mid-h">\{raw\.slice\(0, raw\.length - tail\.length\)\}<\/span>\n\s*<span className="ent-mid-t">\{tail\}<\/span>/);
  for (const [kind, value, tail] of [['address', ADDRESS, ADDRESS.slice(-6)], ['tx', HASH, HASH.slice(-6)], ['node', 'super_node_c78c3017a4f93464', 'a4f93464']]) {
    const text = entity(kind, value).text;
    assert.equal(text.slice(text.indexOf('…') + 1), tail, kind);
  }
  const base = read('styles/base.css');
  assert.match(base, /:is\(\.tbl-fit, \.ent-fit\) \.ent-cut \{ display: inline-flex; max-width: 100%; min-width: var\(--ent-min\); vertical-align: bottom; \}/);
  assert.match(base, /\.ent-mid-h \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: inherit; \}/);
  assert.match(base, /^\.ent-mid \{ display: none; \}$/m);
  assert.match(base, /\.ent-cut > \.ent-mid \{ display: flex; min-width: 0; text-decoration: inherit; user-select: all; \}/);
  // A reading's unit takes its figure's width and spacing (owner 20.10: QNC and 0 the same size).
  assert.match(base, /:is\(\.ro-v, \.cab-figure\) \.ent-unit \{ font-stretch: inherit; letter-spacing: inherit; \}/);
  assert.doesNotMatch(read('styles/cabinet.css'), /\.cab-figure \.ent-unit \{/);
  // A second view of an entity its row links is the same look in Fog, not a second link.
  assert.match(link, /if \(!e\.href \|\| !link\) \{/);
  // An address in full is spaced by margins between spans, so a selection copies it exactly.
  assert.match(link, /<span className="addr-part">\{value\.slice\(0, 19\)\}<\/span>\s*<span className="addr-part addr-eon">eon<\/span>/);
  assert.doesNotMatch(link, /\{' '\}|&nbsp;/);
  // The number is text; the unit with its icon links to the token or QNC page.
  const amount = link.slice(link.indexOf('export function Amount('));
  assert.match(amount, /<span className="amount-v num">\{value\}<\/span> <AmountUnit token=\{token\} symbol=\{symbol\} logo=\{logo\} \/>/);
  const unit = link.slice(link.indexOf('export function AmountUnit('), link.indexOf('export const unitText'));
  assert.match(unit, /<IntentLink className="ent ent-unit" href=\{isToken \? `\/explorer\/token\/\$\{token\}` : '\/explorer\/qnc'\} title=\{isToken \? token! : 'QNC'\}>/);
  assert.match(unit, /<TokenIcon address=\{token\} symbol=\{symbol\} logo=\{logo\} size="text" \/>\{symbol \|\| 'Token'\}/);
  assert.match(unit, /<TokenIcon native size="text" \/>QNC/);
  const css = code('styles/base.css');
  assert.match(css, /a\.ent \{\n {2}color: var\(--signal\); text-decoration: underline;/);
  assert.match(css, /\.ent \{ font-family: var\(--font-mono\); font-stretch: 80%; white-space: nowrap; color: var\(--paper\); \}/);
});

test('numbers in one format, times in words and exact times', () => {
  assert.equal(int(0), '0');
  assert.equal(int(1000), '1,000');
  assert.equal(int(4087305), '4,087,305');
  assert.equal(int(4087305.9), '4,087,305');
  assert.equal(inWords(30), 'about 1 min');
  assert.equal(inWords(2295), 'about 38 min');
  assert.equal(inWords(3600), 'about 1 h');
  assert.equal(inWords(11_520), 'about 3 h 12 min');
  assert.equal(endsIn(2295), 'Ends in 2,295 blocks, about 38 min');
  assert.equal(endsIn(1), 'Ends in 1 block, about 1 min');
  assert.equal(ago(400), 'now');
  assert.equal(ago(5_000), '5s ago');
  assert.equal(ago(-3_000), 'now');
  assert.equal(ago(3 * 60_000), '3m ago');
  assert.equal(ago(2 * 86_400_000), '2d ago');
  assert.equal(epochMs(1_789_000_000), 1_789_000_000_000);
  assert.equal(epochMs(1_789_000_000_000), 1_789_000_000_000);
  // Visitor's time zone, English month, 24 hours; across midnight the second date is written too.
  assert.equal(when(new Date(2026, 9, 19, 4, 7, 12).getTime()), 'Oct 19, 2026, 04:07:12');
  assert.equal(day(new Date(2026, 9, 2, 13).getTime()), 'Oct 2, 2026');
  assert.equal(span(new Date(2026, 9, 19, 0, 7).getTime(), new Date(2026, 9, 19, 4, 7).getTime()), 'Oct 19, 00:07 – 04:07');
  assert.equal(span(new Date(2026, 9, 18, 20, 7).getTime(), new Date(2026, 9, 19, 0, 7).getTime()), 'Oct 18, 20:07 – Oct 19, 00:07');
});

// REAL.md 7.7 (owner 19.10, rule 4: everything that names an entity is clickable): My node named epochs as plain text
// ("Not counted: epoch 283" under the strip, "Last answer Epoch 287" on Device). Every epoch My node names now leads to
// its first block: in sentences and labels by its number (EpochNumber), in a readout by the readout's link.
test('every epoch My node names is a link to its first block', async () => {
  const { missParts, missText, MISS_REASONS } = await import('../cabinet/last-miss.ts');
  const { TEXTS, t } = await import('../texts.ts');
  // The miss line is one text: its first part names the epoch where a page puts the link, the rest follows unchanged.
  for (const reason of MISS_REASONS) {
    for (const platform of ['android', 'ios', null]) {
      const miss = { epoch: 12_345, reason, delivered: null };
      const { what, rest } = missParts(miss, platform);
      assert.match(TEXTS[what], /\{epoch\}/, `${reason} names its epoch`);
      assert.equal(missText(miss, platform), `${t(what, { epoch: '12,345' })} ${rest}`, `${reason} ${platform}`);
    }
  }
  const link = '<EpochNumber epoch=';
  const charts = code('components/cabinet/EpochCharts.tsx');
  assert.match(charts, /const epoch = shown === null \? null : <EpochNumber epoch=\{shown\.epoch\} \/>;/);
  assert.match(charts, /rich\('strip_missed', \{ epoch \}\) : rich\('strip_epoch', \{ epoch, result: resultText\(shown\.result\) \}\)/);
  assert.match(charts, /rich\('per_epoch_axis', \{ from: <EpochNumber epoch=\{bars\[0\]\.epoch\} \/>, to: <EpochNumber epoch=\{bars\[bars\.length - 1\]\.epoch\} \/> \}\)/);
  const status = code('components/cabinet/NodeStatus.tsx');
  assert.match(status, /return <>\{rich\(what, \{ epoch: <EpochNumber epoch=\{miss\.epoch\} \/> \}\)\} \{rest\}<\/>;/);
  assert.match(status, /rich\('device_miss_label', \{ epoch: <EpochNumber epoch=\{miss\.epoch\} \/> \}\)/);
  // Device: "Epoch 287" in the last answer's readout, the number the one EntityLink, at the readout's size.
  assert.match(status, /<Readout label=\{t\(device \? 'device_last' : 'device_last_counted'\)\} value=\{null\}>\s*<span className="ro-v" style=\{\{ '--ro-len': readoutLength\(t\('device_epoch', \{ epoch: number\(last\) \}\)\) \} as CSSProperties\}>\s*\{rich\('device_epoch', \{ epoch: <EpochNumber epoch=\{last\} \/> \}\)\}/);
  assert.doesNotMatch(status, /epochHref/);
  assert.match(read('styles/cabinet.css'), /\.cab \.ro-v \.ent \{ font-stretch: inherit; letter-spacing: inherit; \}/);
  // The strip's first and last epoch, and each bar's epoch under the chart: links too, no longer hidden from readers.
  assert.match(charts, /<span className="cab-strip-x">\s*<span>\{cells\.length > 0 \? <EpochNumber epoch=\{cells\[0\]\.epoch\} \/> : ' '\}<\/span>\s*<span>\{cells\.length > 0 \? <EpochNumber epoch=\{cells\[cells\.length - 1\]\.epoch\} \/> : ' '\}<\/span>/);
  assert.match(charts, /<div className="cab-pe-x" style=\{cols\}>\s*\{data \? bars\.map\(\(b\) => <span key=\{b\.epoch\}><EpochNumber epoch=\{b\.epoch\} \/><\/span>\) : /);
  assert.doesNotMatch(charts, /number\(b\.epoch\)|number\(cells\[/);
  // Overview: the epoch in the Epoch reading's label.
  assert.match(code('components/cabinet/NodeHome.tsx'), /const epochLabel = \(epoch: ReactNode\) => rich\('ro_epoch', \{ epoch \}\);/);
  assert.match(code('components/explorer/ChainReadouts.tsx'), /reading\.label\(at \? <EpochNumber epoch=\{at\.epoch\} \/> : '—'\)/);
  // History: each epoch and the epoch in each reason line.
  const history = code('components/cabinet/NodeHistory.tsx');
  assert.match(history, /cell: \(row\) => <EpochNumber epoch=\{row\.epoch\} \/>/);
  assert.match(history, /<MissText miss=\{row\.miss\} platform=\{devicePlatform\} \/>/);
  // The move's answer: "up to epoch N".
  assert.match(code('components/cabinet/NodeClaim.tsx'), /epoch: report\.epoch \? <EpochNumber epoch=\{Number\(report\.epoch\)\} \/> : '',/);
  // No visible text of My node writes an epoch through plain t() any more; a cell's own name (aria-label) stays words.
  for (const file of ['EpochCharts', 'NodeStatus', 'NodeHome', 'NodeHistory', 'NodeClaim', 'NodeDevices']) {
    const src = code(`components/cabinet/${file}.tsx`);
    assert.doesNotMatch(src, /t\('(strip_missed|per_epoch_axis|device_miss_label|ro_epoch|claim_ok_part)'/, file);
    assert.doesNotMatch(src, /missText\(/, file);
    if (file !== 'EpochCharts') assert.doesNotMatch(src, /t\('strip_epoch'/, file);
  }
  assert.match(charts, /const cellWords = \(cell: StripCell\) => t\('strip_epoch', \{ epoch: number\(cell\.epoch\), result: resultText\(cell\.result\) \}\);/);
  assert.ok(charts.includes(link) && status.includes(link));
  // The link itself: the number, to the epoch's first block.
  assert.deepEqual(entity('epoch', 283), { href: '/explorer/block/4075200', text: 'Epoch 283', title: 'Epoch 283, from block 4,075,200', external: false });
});
