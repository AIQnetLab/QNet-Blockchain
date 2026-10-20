// The explorer in concept B (B-SPEC 6.2 to 6.6): Latest blocks keep their length as heads arrive, list amounts split
// into a number and a linked unit, sides and suggestions written one way, live tables that move no element, every route
// with its own loading state, every entity through the one EntityLink, and parts that render only for their own data.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import {
  RECENT_BLOCKS, ageText, blocksMissing, emptyListText, fillBlocks, listSummary, nextBlocks, partyKind, recentBlock, signatureName,
  splitAmount, suggestionView, txStatusView,
} from '../explorer-view.ts';
import { EPOCH_BLOCKS, epochProgress } from '../cabinet/epochs.ts';
import { accountView, readRecord, tokensPath } from '../explorer-reads.ts';
import { within } from '../deadline.ts';
import { createServer } from 'node:http';
import { SRC, code, read } from './source.mjs';

const HASH = (n) => n.toString(16).padStart(64, '0');
const block = (height) => ({ height, hash: HASH(height), timestamp: 1_792_400_000_000 + height * 1000 });
const ADDRESS = '4f1c9a2b3c4d5e6f708eon1a2b3c4d5e6f7081d9b40c1';

test('Latest blocks: a new head takes the top, the oldest row leaves, the length never changes', () => {
  assert.equal(RECENT_BLOCKS, 14);
  const seed = Array.from({ length: 12 }, (_, i) => block(100 - i));
  const next = nextBlocks(seed, block(101), 12);
  assert.equal(next.length, 12);
  assert.deepEqual(next.map((b) => b.height), [101, 100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90]);
  // A head that skips heights brings them as rows linked by height, without a hash until one is known.
  const skip = nextBlocks(seed, block(104), 12);
  assert.deepEqual(skip.slice(0, 5).map((b) => [b.height, b.hash === null]), [[104, false], [103, true], [102, true], [101, true], [100, false]]);
  assert.equal(skip.length, 12);
  // A jump far ahead fills the list with the newest heights only.
  assert.deepEqual(nextBlocks(seed, block(10_000), 12).map((b) => b.height), Array.from({ length: 12 }, (_, i) => 10_000 - i));
  // A head that is not newer changes nothing; the same height completes a row known without its hash.
  assert.equal(nextBlocks(seed, block(100), 12), seed);
  assert.equal(nextBlocks(seed, block(97), 12), seed);
  const partial = [{ height: 7, hash: null, timestamp: null }];
  assert.deepEqual(nextBlocks(partial, block(7), 12), [block(7)]);
  // With nothing from the server the first head brings its height and those under it, so the list has its length at once.
  const first = nextBlocks([], block(500), 12);
  assert.deepEqual(first.map((b) => b.height), Array.from({ length: 12 }, (_, i) => 500 - i));
  assert.deepEqual(first.slice(1).map((b) => b.hash), Array(11).fill(null));
  assert.deepEqual(nextBlocks([], block(3), 12).map((b) => b.height), [3, 2, 1, 0]);
});

test('Latest blocks: rows the head stream left without a hash are filled in place by height from a read of the newest', () => {
  const seed = Array.from({ length: 12 }, (_, i) => block(100 - i));
  // A head that skipped heights: its rows have heights and links but no hash, until the read fills them.
  const skipped = nextBlocks(seed, block(104), 12);
  assert.equal(blocksMissing(skipped, 12), true);
  const read = Array.from({ length: 20 }, (_, i) => block(104 - i));
  const filled = fillBlocks(skipped, read, 12);
  assert.deepEqual(filled.map((b) => b.height), skipped.map((b) => b.height));
  assert.deepEqual(filled.map((b) => b.hash), Array.from({ length: 12 }, (_, i) => HASH(104 - i)));
  assert.equal(blocksMissing(filled, 12), false);
  // Rows that had their hash keep the same objects; a read that adds nothing gives back the same list.
  assert.equal(filled[0], skipped[0]);
  assert.equal(fillBlocks(filled, read, 12), filled);
  // A read behind the stream (the index lagging) fills what it has and never adds a row above the list's top.
  const behind = fillBlocks(skipped, Array.from({ length: 20 }, (_, i) => block(102 - i)), 12);
  assert.deepEqual(behind.slice(0, 3).map((b) => [b.height, b.hash === null]), [[104, false], [103, true], [102, false]]);
  assert.equal(fillBlocks(seed, [block(150), ...read], 12)[0].height, 100);
  // The server list did not come (the explorer) or the list starts from the head alone (home): the read fills it down.
  const single = [block(500)];
  assert.equal(blocksMissing(single, 14), true);
  assert.deepEqual(fillBlocks(single, Array.from({ length: 20 }, (_, i) => block(500 - i)), 14).map((b) => b.height), Array.from({ length: 14 }, (_, i) => 500 - i));
  assert.equal(blocksMissing([], 12), false);
  assert.deepEqual(fillBlocks([], read, 12), []);
  // A row of the index's blocks table, its 64-bit columns as digit strings, with its producer and transaction count.
  assert.deepEqual(recentBlock({ height: '4104880', hash: HASH(1), timestamp: '1792400000000', producer: 'genesis_node_003', producer_address: null, tx_count: '7' }), {
    height: 4_104_880, hash: HASH(1), timestamp: 1_792_400_000_000, producer: 'genesis_node_003', producerAddress: null, txCount: 7,
  });
  // A body the network pruned before the index read it: the count is not known, not zero.
  assert.equal(recentBlock({ height: 5, hash: HASH(5), timestamp: null, producer: 'genesis', tx_count: null }).txCount, null);
  // The hook reads only while something is missing, at most every 2 s, from the one list route (15 s after a fruitless read).
  const hook = code('components/explorer/useRecentBlocks.ts');
  assert.match(hook, /const missing = blocksMissing\(blocks, limit\);/);
  assert.match(hook, /if \(!missing \|\| busy\.current \|\| Date\.now\(\) < nextAt\.current \|\| document\.visibilityState === 'hidden'\) return;/);
  assert.match(hook, /fetch\(`\/api\/blocks\?latest=\$\{limit\}`, \{ cache: 'no-store' \}\)/);
  assert.match(hook, /const READ_MS = 2_000;\nconst IDLE_MS = 15_000;/);
  // The newest blocks come to every visitor from the head snapshot, no query of their own; only a history page (?at=)
  // reads the index.
  const route = code('app/api/blocks/route.ts');
  const latestPath = route.slice(route.indexOf("const asked = Math.trunc(Number(params.get('latest')));"));
  assert.match(latestPath, /const \{ blocks \} = await headHub\.snapshot\(\);/);
  assert.doesNotMatch(latestPath.slice(0, latestPath.indexOf('} catch')), /getLatestBlocks/);
  // The home page's live column and the explorer's strip are the same list (one mechanism), with its slide and hold.
  const home = code('app/HomeClient.tsx');
  assert.match(home, /useLiveBlocks\(seed, RECENT_BLOCKS, box, list\);/);
  assert.match(code('components/explorer/LatestBlocks.tsx'), /useLiveBlocks\(seed, RECENT_BLOCKS, view, list\);/);
  assert.doesNotMatch(home, /function useNodeCounts|NODE_COUNTS_MS/);
  assert.match(home, /import \{ useNodeCounts, type NodeCounts \} from '@\/hooks\/useNodeCounts';/);
});

test('a list amount: its number as text, its unit apart; a transaction that moves nothing has none', () => {
  assert.deepEqual(splitAmount('124,918.60 QNC'), { value: '124,918.60', unit: 'QNC' });
  assert.deepEqual(splitAmount('12.5 QUSD'), { value: '12.5', unit: 'QUSD' });
  assert.deepEqual(splitAmount(' 0.000000001 QNC '), { value: '0.000000001', unit: 'QNC' });
  for (const none of ['0', '0 QNC', '0.00 QNC', '', null, undefined, 'QNC']) assert.equal(splitAmount(none), null, String(none));
  // The cell: the number is Paper text, the unit with its icon the link (components/ui/EntityLink.tsx Amount).
  const cells = code('components/explorer/cells.tsx');
  assert.match(cells, /return <Amount value=\{`\$\{sign\}\$\{parts\.value\}`\} token=\{parts\.token\} symbol=\{parts\.token \? parts\.unit : null\} logo=\{logo\} \/>;/);
  // An address's own list writes the side with the number (+ in, − out), the same cell otherwise.
  assert.match(code('app/explorer/address/[address]/AddressClient.tsx'), /<TxAmount parts=\{rowAmount\(t\)\} sign=\{t\.from === address \? '−' : '\+'\} \/>/);
  assert.match(code('components/ui/EntityLink.tsx'), /<span className="amount" title=\{`\$\{value\} \$\{unitText\(\{ token, symbol \}\)\}`\}>\n\s*<span className="amount-v num">\{value\}<\/span> <AmountUnit token=\{token\} symbol=\{symbol\} logo=\{logo\} \/>\n\s*<\/span>/);
});

test('a side of a transaction: an address, the batch marker, a system account, or a node id', () => {
  assert.equal(partyKind(ADDRESS), 'address');
  assert.equal(partyKind('batch_transfers'), 'batch');
  assert.equal(partyKind('system_rewards_pool'), 'system');
  assert.equal(partyKind('genesis'), 'system');
  assert.equal(partyKind('genesis_node_003'), 'node');
  assert.equal(partyKind('super_node_c78c3017a4f93464'), 'node');
  for (const none of ['N/A', '', null, undefined]) assert.equal(partyKind(none), 'none');
  // One name for the signature scheme; anything else as the record says it.
  for (const raw of ['ML-DSA-65', 'mldsa65', 'Dilithium3', ' dilithium ']) assert.equal(signatureName(raw), 'ML-DSA-65', raw);
  assert.equal(signatureName('System TX'), 'System TX');
  assert.equal(signatureName(''), null);
  // The node id links to its address only when the record carries one (src/lib/entity.ts).
  assert.match(code('components/explorer/cells.tsx'), /case 'node':\n\s*return <EntityLink kind="node" value=\{value as string\} address=\{address\} full=\{whole\} \/>;/);
});

test('ages: "now" and counts, the genesis for a record without a real time, digit strings read as numbers', () => {
  const now = 1_792_400_100_000;
  assert.equal(ageText(now, now), 'now');
  assert.equal(ageText(now - 5_000, now), '5s ago');
  assert.equal(ageText(String(now - 180_000), now), '3m ago');
  assert.equal(ageText(Math.floor((now - 7_200_000) / 1000), now), '2h ago');
  assert.equal(ageText(now + 3_000, now), 'now', 'a clock a little ahead never reads as the future');
  for (const genesis of [0, null, undefined, '0', 1_600_000_000_000]) assert.equal(ageText(genesis, now), 'Genesis', String(genesis));
  // One clock for the page: ages refresh by themselves, the table around them never renders for them.
  const ago = code('components/explorer/Ago.tsx');
  assert.match(ago, /useSyncExternalStore\(on \? subscribe : still, current, onServer\);/);
  assert.match(ago, /if \(document\.visibilityState !== 'visible'\) return;/);
});

test('the list\'s datum and empty line, and how a suggestion is written', () => {
  assert.equal(listSummary(['Transfer', 'Swap'], false, 1), 'Transfer, Swap · newest first');
  assert.equal(listSummary([], true, 1), 'All types · oldest first');
  assert.equal(listSummary([], false, 3), 'Page 3 · newest first');
  assert.equal(emptyListText(['Transfer', 'Swap']), 'No Transfer or Swap transactions yet');
  assert.equal(emptyListText([]), 'Waiting for activity on QNet Blockchain…');
  assert.deepEqual(suggestionView({ type: 'block', label: 'Block #4090481', sublabel: 'Block height', href: '/explorer/block/4090481' }), { kind: 'Block', value: '4,090,481', note: 'Block height' });
  assert.deepEqual(suggestionView({ type: 'block', label: 'Block #7', sublabel: 'matched by hash', href: '/explorer/block/7' }).note, 'Found by its hash');
  const tx = suggestionView({ type: 'tx', label: 'Transaction', sublabel: 'abc · not yet indexed', href: `/explorer/tx/${HASH(255)}` });
  assert.deepEqual(tx, { kind: 'TX', value: '00000000…0000ff', note: 'Not in the index yet' });
  assert.deepEqual(suggestionView({ type: 'address', label: 'Address', href: `/explorer/address/${ADDRESS}` }).value, '4f1c9a…9b40c1');
  assert.deepEqual(suggestionView({ type: 'token', label: 'QUSD', symbol: 'QUSD', sublabel: `Q Dollar · 4f1c9a2b3c…b40c11`, href: `/explorer/token/${ADDRESS}` }), { kind: 'Token', value: 'QUSD', note: 'Q Dollar' });
  // The server echoes the query unencoded: a '%' that is no escape is written as typed, never thrown during render.
  const typed = '0123456789abcdef012eon%zz3456789abcdef0123456789';
  assert.deepEqual(suggestionView({ type: 'address', label: 'Address', href: `/explorer/address/${typed}` }), { kind: 'Address', value: '012345…456789', note: 'Address' });
  assert.equal(suggestionView({ type: 'tx', label: 'Transaction', href: '/explorer/tx/ab%E0%A4%A' }).value, 'ab%E0%A4%A');
});

test('a live table moves no element: rows keep their place and take the new record\'s cells, each landing tinted', () => {
  const table = code('components/ui/DataTable.tsx');
  assert.match(table, /<Fragment key=\{live \? `slot-\$\{i\}` : key\}>|<tr key=\{live \? `slot-\$\{i\}` : key\}/);
  assert.match(table, /<td key=\{live \? `\$\{key\}:\$\{c\.key\}` : c\.key\} role=\{role\('cell'\)\} data-k=\{c\.key\} data-align=\{c\.align\}>/);
  // The tint is on the cells, which are new for a new record, so it plays for every arrival.
  const base = read('styles/base.css');
  assert.match(base, /\.tbl tbody tr\[data-new='true'\] > td \{ animation: rowin var\(--t-flash\) ease-out; \}/);
  assert.doesNotMatch(base, /\.tbl tbody tr\[data-new='true'\] \{ animation/);
  // The readouts keep two lines under each value.
  const sheet = read('styles/explorer.css');
  assert.match(sheet, /\.ex-ro \.readouts \{ --ro-sub-lines: 2; \}/);
  // The list and the blocks are live tables; a page other than the first is not.
  const list = code('app/explorer/ExplorerClient.tsx');
  assert.match(list, /live=\{isLiveView\}/);
  assert.match(list, /const isLiveView = pos\.page === 1 && pos\.cursor === null && sortOrder === 'desc' && typeFilters\.length === 0;/);
  // Latest blocks (owner 20.10): one strip of cards above All transactions. Each card keeps its place (keyed by its slot)
  // and takes the next block, its content keyed by height so a block's flash plays as it lands; only the list's
  // transform moves. Its lines stack, each cut with "…" at the card's edge: the height, the age, the producer, the count.
  const strip = code('components/explorer/LatestBlocks.tsx');
  assert.match(strip, /<li key=\{i\} className="ex-cell">\n\s*<div key=\{b\.height\} className="ex-cell-in" data-new=\{fresh\}>/);
  assert.match(strip, /<span className="ex-cell-h flash" data-new=\{fresh\} data-v=\{int\(b\.height\)\}>/);
  assert.doesNotMatch(strip, /pad-|Dash/);
  assert.match(sheet, /\.ex-cell-in \{ display: grid; grid-template-rows: 22px repeat\(3, 18px\);/);
  assert.match(sheet, /\.ex-cell-in > \* \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(sheet, /\.ex-cell-in\[data-new='true'\] \{ animation: rowin var\(--t-flash\) ease-out; \}/);
  assert.match(sheet, /\.ex-cell \{\n\s*flex: none; width: var\(--card-w\); height: var\(--card-h\); padding: 12px 16px; border-left: 1px solid var\(--rule\);/);
  // The frame holds a card's height before any block is known, so the first blocks move nothing.
  assert.match(sheet, /\.ex-chain-list \{ display: flex; min-height: var\(--card-h\);/);
  // A list on a layer of its own reported an age that rewidens ("9s ago" to "10s ago") as a layout shift: no will-change.
  assert.doesNotMatch(sheet.slice(sheet.indexOf('.ex-chain-list')), /will-change/);
  // Its bar: a thin line in the rules' colour, none on a touch screen, never the browser's own with its arrows.
  assert.match(sheet, /\.ex-chain-view::-webkit-scrollbar \{ height: 3px; \}/);
  assert.match(sheet, /\.ex-chain-view::-webkit-scrollbar-track, \.ex-chain-view::-webkit-scrollbar-button \{ display: none;/);
  assert.match(sheet, /@supports not selector\(::-webkit-scrollbar\) \{\n\s*\.ex-chain-view \{ scrollbar-width: thin;/);
  // Touch: the whole card opens its block (the height's overlay spans the card, outside the cut lines' clipping), and the
  // height's flash still starts where the height does.
  assert.match(sheet, /@media \(max-width: 720px\), \(pointer: coarse\) \{\n\s*\.ex-cell-in \{ position: relative; \}\n\s*\.ex-cell-h\.flash, \.ex-cell-h a\.ent \{ position: static; \}\n\s*\.ex-cell-h a\.ent::after \{ top: -12px; bottom: -12px; left: -16px; right: -16px; width: auto; height: auto; transform: none; \}/);
  // The home page's live column keeps its rows the same way, and its list is not on a layer of its own either.
  const home = code('app/HomeClient.tsx');
  assert.match(home, /<li key=\{i\} className="blk">\n\s*<div key=\{b\.height\} className="blk-in" data-new=\{landed\.has\(String\(b\.height\)\) \|\| undefined\}>/);
  const homeSheet = read('styles/home.css');
  assert.doesNotMatch(homeSheet, /will-change/);
  assert.match(homeSheet, /\.blk-in \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; grid-template-rows: 24px 18px;/);
  assert.match(homeSheet, /\.blk-in\[data-new\] \.flash::after \{/);
});

// Owner 20.10: Latest blocks on top, All transactions obvious right under it; the strip slides new blocks in from the
// left by a transform, a mouse drags it, and Hide folds it the way the visitor left it on every later visit.
test('the strip slides new blocks in by a transform, drags with a mouse and stays folded as the visitor left it', async () => {
  const { slideCount, slideMs } = await import('../slide.ts');
  assert.equal(slideCount(0, 100), 0, 'the first list does not slide');
  assert.equal(slideCount(100, 100), 0);
  assert.equal(slideCount(100, 103), 3);
  assert.equal(slideCount(100, 99), 0);
  assert.equal(slideMs('500ms'), 500);
  assert.equal(slideMs(' 0.5s '), 500);
  assert.equal(slideMs('fast'), 0);
  assert.match(code('lib/slide.ts'), /el\.style\.transform = row \? `translateX\(\$\{-size\}px\)` : `translateY\(\$\{-size\}px\)`;/);
  // Hide and Show: the server's reading of the cookie at first (the same markup on both sides), the cookie after.
  const strip = code('components/explorer/LatestBlocks.tsx');
  assert.match(strip, /const open = !useSyncExternalStore\(watch, hiddenNow, \(\) => hidden \?\? false\);/);
  assert.match(strip, /document\.cookie = stripCookie\(open, window\.location\.protocol === 'https:'\);/);
  assert.match(code('app/explorer/ExplorerClient.tsx'), /<LatestBlocks seed=\{blocks\} hidden=\{blocksHidden\} \/>/);
  const sheet = read('styles/explorer.css');
  assert.match(sheet, /\.ex-chain\[data-open='false'\] \.ex-chain-body \{\n\s*grid-template-rows: minmax\(0, 0fr\); visibility: hidden;/);
  // A mouse drags the row sideways, and a drag never ends in a click on the link under it.
  assert.match(strip, /if \(!d\.moved && Math\.abs\(e\.clientX - d\.x\) < DRAG_PX\) return;/);
  assert.match(strip, /const onClickCapture = \(e: MouseEvent<HTMLDivElement>\) => \{\n\s*if \(!drag\.current\?\.moved\) return;\n\s*e\.preventDefault\(\);\n\s*e\.stopPropagation\(\);/);
  // The transactions start on a computer's first screen: a tighter band with the readouts beside the title.
  assert.match(code('app/explorer/ExplorerClient.tsx'), /<div className="ex ex-list">/);
  assert.match(sheet, /@media \(min-width: 1181px\) \{\n\s*\.ex-list \.page-head-in \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  assert.match(sheet, /\.ex-list \.page-head-more \{ grid-column: 2; grid-row: 1 \/ -1; margin-top: 0; \}/);
});

test('the explorer\'s first paint carries its data, and each part renders only for its own', () => {
  const page = code('app/explorer/page.tsx');
  // The latest blocks come with the snapshot: the page makes no query of its own.
  assert.match(page, /const s = await headHub\.snapshot\(\);\n\s*blocks = s\.blocks;/);
  // The visitor's folded strip comes with the request, so the page paints it folded from the first byte.
  assert.match(page, /const hidden = stripHidden\(\(await cookies\(\)\)\.get\(STRIP_COOKIE\)\?\.value\);\n\s*return <ExplorerClient initial=\{initial\} blocks=\{blocks\} blocksHidden=\{hidden\} \/>;/);
  assert.match(page, /block: headBlockFacts\(s\),/);
  assert.doesNotMatch(page, /getLatestBlocks|lib\/db/);
  // Light and server nodes as two readings of equal weight (owner 19.10), both from /api/network/stats, written once and
  // in one order (light first) for the home page and the explorer.
  const shared = code('components/explorer/ChainReadouts.tsx');
  assert.match(shared, /<Readout label="Light nodes" value=\{nodes \? int\(nodes\.lightNodes\) : null\} sub="Phones and tablets, last epoch" \/>\s*<Readout label="Server nodes" value=\{nodes \? int\(nodes\.superNodes\) : null\} sub="Super nodes, last epoch" \/>/);
  assert.match(code('components/explorer/NetworkReadouts.tsx'), /<EpochReadout height=\{height\} \/>\s*<NodeCountReadouts nodes=\{nodes\} \/>/);
  assert.match(code('app/HomeClient.tsx'), /<NodeCountReadouts nodes=\{nodes\} \/>\s*<EpochReadout height=\{height\} \/>/);
  for (const file of ['app/HomeClient.tsx', 'components/explorer/NetworkReadouts.tsx', 'components/cabinet/NodeHome.tsx']) {
    const src = code(file);
    assert.doesNotMatch(src, /label="(Light|Server) nodes"|EPOCH_BLOCKS|% EPOCH|endsIn\(/, `${file} writes no epoch or node count reading of its own`);
  }
  assert.match(code('hooks/useNodeCounts.ts'), /fetch\('\/api\/network\/stats', \{ cache: 'no-store' \}\)/);
  // The head moves the readouts and the blocks; the list hears of it through OnHead and renders when its rows change.
  assert.doesNotMatch(code('app/explorer/ExplorerClient.tsx'), /useChainHead/);
  assert.match(code('app/explorer/ExplorerClient.tsx'), /<OnHead every=\{LIVE_REFRESH_MIN_MS\} onHead=\{onHead\} \/>/);
  assert.doesNotMatch(code('app/explorer/address/[address]/AddressClient.tsx'), /useChainHead/);
  const onHead = code('components/explorer/OnHead.tsx');
  assert.match(onHead, /if \(document\.visibilityState === 'hidden' \|\| Date\.now\(\) - last\.current < every\) return;/);
  assert.match(onHead, /return null;/);
  // No page polls on a timer: the token and QNC pages follow the head, at most every 10 s.
  for (const file of ['app/explorer/qnc/QncClient.tsx', 'app/explorer/token/[contract]/TokenClient.tsx', 'app/explorer/address/[address]/AddressClient.tsx']) {
    assert.doesNotMatch(code(file), /setInterval\(/, file);
  }
  assert.match(code('app/explorer/qnc/QncClient.tsx'), /\{first && <OnHead every=\{REFRESH_MS\} onHead=\{refresh\} \/>\}/);
});

test('every explorer route loads as itself: a detail page never shows the list\'s skeleton', () => {
  const routes = ['block/[hash]', 'tx/[hash]', 'address/[address]', 'token/[contract]', 'qnc', 'tokens'];
  // Review 19.10: these pages grew when their client read answered (the holders, the directory, a block's transactions,
  // a transaction's groups, an address's notes, a token's head). The server now renders them with their routes' first
  // answers, read in-process with the visitor's headers; their loading state is the same client view with no answer,
  // which reads nothing.
  const served = {
    'block/[hash]': ['BlockClient', 'blockRoute'], 'tx/[hash]': ['TransactionClient', 'txRoute'], 'address/[address]': ['AddressClient', 'addressRoute'],
    'token/[contract]': ['TokenClient', 'holdersRoute'], qnc: ['QncClient', 'activityRoute'], tokens: ['TokensClient', 'tokensRoute'],
  };
  assert.deepEqual(Object.keys(served).sort(), [...routes].sort());
  for (const [route, [view, handler]] of Object.entries(served)) {
    const file = `app/explorer/${route}/loading.tsx`;
    assert.ok(existsSync(new URL(file, SRC)), file);
    assert.match(code(file), new RegExp(`^\\s*import ${view} from '\\./${view}';\\s*export default function Loading\\(\\) \\{\\s*return <${view} \\/>;\\s*\\}\\s*$`), file);
    const page = code(`app/explorer/${route}/page.tsx`);
    assert.doesNotMatch(page, /'use client'/, route);
    assert.match(page, new RegExp(`firstAnswer\\(${handler}, `), route);
    assert.match(page, new RegExp(`<${view} first=\\{`), route);
    const client = code(`app/explorer/${route}/${view}.tsx`);
    assert.match(client, /^\s*'use client';/, view);
    // Only what the server could not read is read on mount, and the loading state reads nothing.
    assert.match(client, /first === undefined|if \(!first\) return;/, view);
  }
  // One reading of a record answer for the server's first paint and the client's later reads.
  assert.deepEqual(readRecord(200, { success: true, data: { height: 7 } }), { record: { height: 7 }, phase: 'ready' });
  assert.deepEqual(readRecord(404, { success: false, error: 'Block not found' }), { record: null, phase: 'missing' });
  assert.deepEqual(readRecord(400, { success: false }, [400]), { record: null, phase: 'missing' });
  assert.deepEqual(readRecord(502, null), { record: null, phase: 'failed' });
  assert.deepEqual(readRecord(429, { success: false, error: 'Rate limit exceeded' }, [404, 400]), { record: null, phase: 'failed' });
  // The directory's first page is the very read the client makes for page 1 unfiltered, so it is never read twice.
  assert.equal(tokensPath(1), '/api/tokens?page=1&perPage=25');
  assert.equal(tokensPath(2, ' ab '), '/api/tokens?page=2&perPage=25&search=ab');
  const first = code('server/first-answer.ts');
  assert.match(first, /const visitor = new Headers\(await headers\(\)\);/);
  assert.match(first, /new NextRequest\(new URL\(path, 'http:\/\/localhost'\), \{ headers: visitor, signal: AbortSignal\.abort\(\) \}\)/);
  assert.match(first, /return \{ status: res\.status, body: await res\.json\(\) \};/);
  // An explorer page is at least a screen tall: the footer is below the first screen, so the loading state giving way to
  // the page moves nothing in view.
  assert.match(read('styles/explorer.css'), /^\.ex \{ min-height: 100vh; \}$/m);
  // The list's own skeleton has its final geometry: the list's own columns, the strip's frame at a card's height and
  // fifty transaction rows.
  const loading = code('app/explorer/loading.tsx');
  assert.match(loading, /const TX_COLUMNS = listColumns\(false\);/);
  assert.match(loading, /<LatestBlocks seed=\{\[\]\} \/>/);
  assert.match(loading, /<DataTable className="ex-txs-tbl" title="All transactions" [^\n]*loadingRows=\{50\}/);
  assert.match(loading, /<div className="ex ex-list">/);
});

test('no page waits for a node: first answers come from the index, bounded and kept briefly; the client reads the rest', async () => {
  // The wait: the answer when it comes in time, else null and a later answer is dropped.
  assert.equal(await within(50, Promise.resolve('fast')), 'fast');
  const t0 = Date.now();
  assert.equal(await within(40, new Promise(() => {})), null);
  assert.ok(Date.now() - t0 < 400, 'the page goes on without an answer that never comes');
  // No node answer in time: the balance is unknown and read again, never 0; an answer without an account is 0.
  assert.deepEqual(accountView({ answered: false }), { balance_raw: null, genesisAllocation: false, nodeUnread: true });
  assert.deepEqual(accountView({ answered: true, account: null }), { balance_raw: '0', genesisAllocation: false });
  assert.deepEqual(accountView({ answered: true, account: { balance: '123456789012345678901', genesis_allocation: true } }), { balance_raw: '123456789012345678901', genesisAllocation: true });
  assert.deepEqual(accountView({ answered: true, account: { balance: 2500 } }), { balance_raw: '2500', genesisAllocation: false });

  // A node read with the caller's deadline stops at it, asks no further node and puts none in cooldown.
  const hits = [];
  const node = (name) => createServer((req, res) => {
    hits.push(`${name}${req.url}`);
    const answer = () => { res.setHeader('x-node', name); res.end('{}'); };
    if (req.url === '/slow') setTimeout(answer, 1500); else answer();
  });
  const nodes = [node('a'), node('b')];
  await Promise.all(nodes.map((n) => new Promise((r) => n.listen(0, '127.0.0.1', r))));
  process.env.QNET_API_URLS = nodes.map((n) => `http://127.0.0.1:${n.address().port}`).join(',');
  try {
    const { fetchNode } = await import('../node-api.ts');
    const t1 = Date.now();
    assert.equal(await fetchNode('/slow', { deadline: AbortSignal.timeout(100) }), null);
    assert.ok(Date.now() - t1 < 1000, 'the read ends at the deadline');
    // The first node may or may not have seen the request before it was dropped; the second is never asked.
    assert.ok(hits.every((h) => h === 'a/slow'), `no second node is asked once the caller stopped waiting: ${hits}`);
    const res = await fetchNode('/fast');
    assert.equal(res?.headers.get('x-node'), 'a', 'the slow node is not in cooldown');
  } finally {
    delete process.env.QNET_API_URLS;
    for (const n of nodes) { n.closeAllConnections(); n.close(); }
  }

  // The wiring: a first answer's request signal is aborted from the start, so no route waits for a node; the answer is
  // bounded and kept a second by its path (repeated loads and tab switches cost one read); "nothing found" without the
  // nodes is no answer, so the client asks them.
  const first = code('server/first-answer.ts');
  assert.match(first, /export const FIRST_ANSWER_MS = 1_500;/);
  assert.match(first, /export const FIRST_ANSWER_KEEP_MS = 1_000;/);
  assert.match(first, /if \(hit && now - hit\.at < FIRST_ANSWER_KEEP_MS\) return hit\.answer;/);
  assert.match(first, /const answer = await within\(FIRST_ANSWER_MS, \(async \(\) => \{/);
  assert.match(first, /if \(body\?\.nodeUnread === true && body\.success !== true\) return null;/);
  // Routes that read nodes skip them on a first answer and say so: a transaction or block not in the index, a genesis
  // transaction's time. The pages whose data only a node holds (the QNC rich list, a token's record) render with the
  // answer last kept for the path, never awaited, read again in the background once older than 10 s.
  const tx = code('app/api/tx/[hash]/route.ts');
  assert.match(tx, /if \(request\.signal\.aborted\) \{\n\s*return NextResponse\.json\(\{ success: false, error: 'Transaction not found', nodeUnread: true \}, \{ status: 404 \}\);/);
  assert.match(tx, /const timeUnread = finalTimestamp === 0 && dbTx\.block === 0 && request\.signal\.aborted;/);
  const block = code('app/api/blocks/[hash]/route.ts');
  assert.match(block, /if \(deadline\.aborted\) return 'unread';/);
  assert.match(block, /const block = await fetchBlock\(hash, request\.signal\);/);
  assert.match(code('app/explorer/qnc/page.tsx'), /<QncClient first=\{\{ qnc: nodeAnswer\(qncRoute, QNC_PATH\), transfers: await firstAnswer\(activityRoute, QNC_TRANSFERS_PATH\) \}\} \/>/);
  assert.match(code('app/explorer/token/[contract]/page.tsx'), /const token = nodeAnswer\(tokenRoute, tokenPath\(contract, TOKEN_TRANSFERS_FIRST\), \{ contract \}\);/);
  for (const page of ['app/explorer/qnc/page.tsx', 'app/explorer/token/[contract]/page.tsx']) assert.doesNotMatch(code(page), /await nodeAnswer|firstAnswer\((qncRoute|tokenRoute)/, page);
  assert.match(first, /export const NODE_ANSWER_STALE_MS = 10_000;/);
  assert.match(first, /export function nodeAnswer<P extends Record<string, string>>\(route: Route<P>, path: string, params\?: P\): FirstAnswer \| null \{/);
  assert.match(first, /if \(!entry \|\| \(!entry\.reading && now - entry\.at >= NODE_ANSWER_STALE_MS\)\) \{/);
  assert.match(first, /return entry\?\.answer \?\? null;/);
  assert.match(code('app/explorer/tx/[hash]/TransactionClient.tsx'), /if \(!first \|\| initial\?\.record\?\.nodeUnread\) void load\(\);/);
  const route = code('app/api/address/[address]/route.ts');
  assert.match(route, /const deadline = request\.signal;/);
  assert.match(route, /fetchNode\(`\/api\/v1\/account\/\$\{encodeURIComponent\(address\)\}`, \{ deadline \}\)/);
  assert.match(route, /fetchNode\(`\/api\/v1\/account\/\$\{encodeURIComponent\(address\)\}\/tokens`, \{ deadline \}\)/);
  assert.equal([...route.matchAll(/\.\.\.accountView\(account\),/g)].length, 2);
  assert.doesNotMatch(route, /nodeBalanceRaw/);
  const client = code('app/explorer/address/[address]/AddressClient.tsx');
  assert.match(client, /if \(!first \|\| initial\?\.record\?\.nodeUnread\) void fetchAddress\(\);/);
  assert.match(client, /<Readout label="Balance" value=\{system \|\| !d \|\| d\.balance_raw === null \? null : qnc\(d\.balance_raw\)\}/);
});

test('every entity in the explorer goes through the one EntityLink; nothing else there is a link', () => {
  const files = (dir) => readdirSync(new URL(`${dir}/`, SRC), { recursive: true }).filter((n) => /\.tsx$/.test(n)).map((n) => `${dir}/${n.replace(/\\/g, '/')}`);
  const sources = [...files('app/explorer'), ...files('components/explorer')];
  assert.ok(sources.length >= 20, String(sources.length));
  for (const file of sources) {
    const src = code(file);
    assert.doesNotMatch(src, /<Link\b|from 'next\/link'/, file);
    // The search's matches are its options (a listbox of links to the pages they name); no other raw anchor.
    if (!file.endsWith('ExplorerSearch.tsx')) assert.doesNotMatch(src, /<a\b/, file);
    // No copy of a formatter: truncation, ages and times come from src/lib/format.ts.
    assert.doesNotMatch(src, /const (truncate|formatTime|formatTimeAgo|formatDate)\b|\.slice\(0, \d+\)\}\.\.\./, file);
  }
  // The block page links both neighbours in words once the block is known, the next only once the chain has it, a height
  // the chain has not reached the newest block, and its producer when its address is known.
  const blockPage = code('app/explorer/block/[hash]/BlockClient.tsx');
  assert.match(blockPage, /const previous = height > 0;\n\s*const next = head\.height > height;/);
  assert.match(blockPage, /\{previous && <span><span className="fog">Previous <\/span><EntityLink kind="block" value=\{height - 1\} \/><\/span>\}/);
  assert.match(blockPage, /\{next && <span><span className="fog">Next <\/span><EntityLink kind="block" value=\{height \+ 1\} \/><\/span>\}/);
  // REAL.md 7.4: block 0 has no previous block and, until the head is known, no next one; its empty line kept no link's
  // box, so "Next 1" arriving moved the page (CLS 0.0086). With no neighbour the line holds the link-sized slot.
  assert.match(blockPage, /const slot = <span className="ex-neigh-slot" aria-hidden="true">\{'\\u00a0'\}<\/span>;/);
  assert.match(blockPage, /\{!previous && !next && slot\}/);
  assert.match(blockPage, /if \(height !== null && !known && head\.height > 0 && height > head\.height\) \{\n\s*return <span className="ex-neigh"><span><span className="fog">Newest block <\/span><EntityLink kind="block" value=\{head\.height\} \/>/);
  assert.match(blockPage, /if \(height === null \|\| !known\) return <span className="ex-neigh" aria-hidden="true">/);
  // A page whose answer is "missing" shows no readouts or rows that would never fill.
  for (const file of ['app/explorer/block/[hash]/BlockClient.tsx', 'app/explorer/address/[address]/AddressClient.tsx', 'app/explorer/token/[contract]/TokenClient.tsx']) {
    const src = code(file);
    assert.match(src, /const absent = phase === 'missing' && !(b|d);/, file);
    assert.match(src, /more=\{absent \? undefined : \(/, file);
  }
  assert.match(code('app/explorer/address/[address]/AddressClient.tsx'), /\{!system && !absent && \(/);
  assert.match(code('app/explorer/token/[contract]/TokenClient.tsx'), /title=\{absent \? 'Token' : <span className="ex-title-icon">/);
  assert.match(blockPage, /href=\{producerAddress \? `\/explorer\/address\/\$\{producerAddress\}` : undefined\}/);
});

test('one epoch reading for the home page, the explorer and My node: the epoch, the blocks left, the share done', () => {
  assert.deepEqual(epochProgress(4_104_881), { epoch: 285, left: 13_519, done: 881 / EPOCH_BLOCKS });
  assert.deepEqual(epochProgress(14_400), { epoch: 1, left: 14_400, done: 0 });
  assert.deepEqual(epochProgress(14_399), { epoch: 0, left: 1, done: 14_399 / EPOCH_BLOCKS });
  for (const unknown of [0, -5, Number.NaN, 1.5]) assert.equal(epochProgress(unknown), null, String(unknown));
  // The one component: its number links to the epoch's first block; My node gives its own label and value.
  const shared = code('components/explorer/ChainReadouts.tsx');
  assert.match(shared, /const at = epochProgress\(height\);/);
  assert.match(shared, /sub=\{at \? endsIn\(at\.left\) : undefined\}\s*progress=\{at \? at\.done : null\}/);
  assert.equal([...code('components/cabinet/NodeHome.tsx').matchAll(/<ThisEpoch value=/g)].length, 3);
});

test('a transaction\'s status says nothing until its record is read, then confirmed or pending', () => {
  assert.equal(txStatusView(undefined, false), null);
  assert.equal(txStatusView('confirmed', false), null, 'a record from this tab still being read shows no status yet');
  assert.deepEqual(txStatusView('confirmed', true), { value: 'Confirmed', sub: 'In a block', done: true });
  assert.deepEqual(txStatusView('pending', true), { value: 'Pending', sub: 'Waiting for a block', done: false });
  const page = code('app/explorer/tx/[hash]/TransactionClient.tsx');
  assert.match(page, /const status = txStatusView\(tx\?\.status, tx !== null && phase === 'ready'\);/);
  assert.match(page, /<Readout label="Status" value=\{status\?\.value \?\? null\} sub=\{status\?\.sub\} \/>/);
  assert.match(page, /\{status && <Status tone=\{status\.done \? 'done' : 'quiet'\}>\{status\.value\}<\/Status>\}/);
  assert.doesNotMatch(page, /Waiting for a block/);
});

test('the home page\'s live blocks age by the page\'s one clock, held while out of view or during the headline\'s decode', () => {
  const home = code('app/HomeClient.tsx');
  assert.match(home, /<span className="blk-age">\{b\.timestamp \? <Ago ts=\{b\.timestamp\} on=\{near && active\} \/> : '—'\}<\/span>/);
  assert.doesNotMatch(home, /setInterval|setNow/);
  const ago = code('components/explorer/Ago.tsx');
  assert.match(ago, /export function useClock\(on = true\): void \{\n\s*useSyncExternalStore\(on \? subscribe : still, current, onServer\);/);
  assert.match(ago, /export default function Ago\(\{ ts, on = true \}/);
});

test('named groups and named Copy acts: a reader hears which readings, which rows and what each Copy copies', () => {
  assert.match(code('components/ui/Readouts.tsx'), /<div className="readouts" role=\{label \? 'group' : undefined\} data-size=\{size\} aria-label=\{label\}/);
  const detail = code('components/explorer/Detail.tsx');
  assert.match(detail, /return <div role="group" aria-label=\{label\}><dl className="kv">\{children\}<\/dl><\/div>;/);
  assert.match(detail, /<Copy value=\{value\} ariaLabel=\{`Copy \$\{label\}`\} \/>/);
  assert.match(detail, /<Copy value=\{value\} ariaLabel=\{`Copy \$\{name\}`\} \/>/);
  assert.doesNotMatch(detail, /HashValue/);
  const copy = code('components/ui/Copy.tsx');
  assert.match(copy, /aria-label=\{ariaLabel \?\? label\}/);
  assert.match(code('components/ui/EntityLink.tsx'), /<Copy value=\{raw\} ariaLabel=\{`Copy \$\{copyName \?\? COPIES\[kind\]\}`\} \/>/);
  // Where one kind repeats on a page, each Copy is named by its row.
  const tx = code('app/explorer/tx/[hash]/TransactionClient.tsx');
  const names = [...tx.matchAll(/<Party [^>]*copyName="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['from address', 'to address', 'recipient address']);
  assert.match(code('components/explorer/cells.tsx'), /<EntityLink kind="address" value=\{value as string\} full=\{whole\} copy=\{whole\} copyName=\{copyName\} \/>/);
  assert.match(code('app/explorer/block/[hash]/BlockClient.tsx'), /<EntityLink kind="block" value=\{b\.previous_hash\} copy copyName="previous block hash" \/>/);
  // The block page's five hashes each have a Copy of their own name; every whole value under a title names its kind.
  const block = code('app/explorer/block/[hash]/BlockClient.tsx');
  for (const label of ['Merkle root', 'State root', 'VTS hash', 'Signature', 'QRB output']) assert.match(block, new RegExp(`<HashRow label="${label}" value=`), label);
  for (const file of ['app/explorer/block/[hash]/BlockClient.tsx', 'app/explorer/tx/[hash]/TransactionClient.tsx', 'app/explorer/address/[address]/AddressClient.tsx', 'app/explorer/token/[contract]/TokenClient.tsx']) {
    const src = code(file);
    const wholes = [...src.matchAll(/<Whole [^>]*>/g)].map((m) => m[0]);
    assert.ok(wholes.length > 0, file);
    for (const w of wholes) assert.match(w, / name="[a-z ]+"/, `${file}: ${w}`);
  }
});

// B-SPEC 4.4, 5.11, 12.1: the live blocks show each block's producer and transaction count. The head snapshot reads the
// newest 14 blocks once per head (one bounded query), the head event names the head block's, and every live list (the
// home page's column and ticker, Latest blocks, the Last block readout) shows them; each height and each producer whose
// address the index knows is a link.
test('the live blocks carry their producer and transaction count, from one read of the newest blocks per head', async () => {
  const { RECENT_BLOCKS, headBlock, txCountText } = await import('../explorer-view.ts');
  assert.equal(RECENT_BLOCKS, 14);
  const facts = { producer: 'genesis_node_003', producerAddress: ADDRESS, txCount: 3 };
  // The head event's block: a complete row at the top, nothing left to read.
  const head = headBlock({ height: 101, hash: HASH(101), timestamp: 1_792_400_101_000, block: facts });
  assert.deepEqual(head, { height: 101, hash: HASH(101), timestamp: 1_792_400_101_000, ...facts });
  const seed = Array.from({ length: 12 }, (_, i) => ({ ...block(100 - i), ...facts }));
  const next = nextBlocks(seed, head, 12);
  assert.deepEqual(next[0], head);
  assert.equal(blocksMissing(next, 12), false);
  // A head whose event did not name its block (the snapshot's two reads saw different commits): the row waits for one
  // read of the newest blocks, which completes it in place.
  const bare = headBlock({ height: 102, hash: HASH(102), timestamp: 1_792_400_102_000, block: null });
  assert.equal(bare.producer, null);
  const waiting = nextBlocks(next, bare, 12);
  assert.equal(blocksMissing(waiting, 12), true);
  const read = [{ ...block(102), ...facts, txCount: 0 }, ...next];
  const filled = fillBlocks(waiting, read, 12);
  assert.deepEqual([filled[0].producer, filled[0].txCount], ['genesis_node_003', 0]);
  assert.equal(blocksMissing(filled, 12), false);
  assert.deepEqual([txCountText(1), txCountText(0), txCountText(1234), txCountText(null)], ['1 tx', '0 txs', '1,234 txs', '—']);
  // The server: one narrow, bounded read of the newest blocks in each head refresh; the head event and /api/head share one
  // shape with the head block's facts; /api/blocks and the pages read the snapshot and query nothing themselves.
  const db = code('../lib/db.ts');
  assert.match(db, /query<RecentBlockRow>\('SELECT height, hash, timestamp, producer, producer_address, tx_count FROM blocks ORDER BY height DESC LIMIT \$1', \[n\]\)/);
  const hub = code('server/head-hub.ts');
  assert.match(hub, /listTransactions\(\{ limit: MAX_ROWS, sort: 'desc', direction: 'next' \}\),\s*getLatestBlocks\(RECENT_BLOCKS\),\s*\]\);/);
  assert.match(hub, /blocks: latest\.map\(recentBlock\), updatedAt: Date\.now\(\),/);
  assert.match(hub, /return b && b\.height === s\.height && b\.producer !== null \? \{ producer: b\.producer, producerAddress: b\.producerAddress, txCount: b\.txCount \} : null;/);
  assert.match(hub, /block: headBlockFacts\(s\),/);
  assert.match(code('app/api/stream/route.ts'), /const headPayload = \(s: HeadSnapshot\): string => JSON\.stringify\(headEvent\(s\)\);/);
  assert.match(code('app/api/head/route.ts'), /data: headEvent\(s\)/);
  assert.match(code('hooks/useChainHead.ts'), /block: blockFacts\(d\.block\),/);
  assert.match(code('components/explorer/useRecentBlocks.ts'), /setBlocks\(\(cur\) => nextBlocks\(cur, headBlock\(head\), limit\)\);/);
  assert.match(code('app/page.tsx'), /blocks = s\.blocks;/);
  assert.match(code('app/HomeClient.tsx'), /<LiveBlocks seed=\{blocks\} active=\{!decoding\} \/>/);
  // The lists: the producer through the one EntityLink (its address page when known), the count on its own line; a line
  // not known yet stays empty, never a dash.
  const latest = code('components/explorer/LatestBlocks.tsx');
  assert.match(latest, /<span className="ent-fit">\{b\.producer \? <EntityLink kind="node" value=\{b\.producer\} address=\{b\.producerAddress\} \/> : null\}<\/span>/);
  assert.match(latest, /<span>\{b\.txCount !== null \? txCountText\(b\.txCount\) : null\}<\/span>/);
  const home = code('app/HomeClient.tsx');
  assert.match(home, /<span className="blk-txs">\{txCountText\(b\.txCount\)\}<\/span>/);
  assert.match(home, /\{b\.producer \? <EntityLink kind="node" value=\{b\.producer\} address=\{b\.producerAddress\} \/> : <span>—<\/span>\}/);
  assert.match(code('components/explorer/NetworkReadouts.tsx'), /const by = block \? <>By <EntityLink kind="node" value=\{block\.producer\} address=\{block\.producerAddress\} \/><\/> : 'Since the newest block';/);
  // A node id links to its address page only when the index knows the address; otherwise it is text (B-SPEC 5.7).
  const { entity } = await import('../entity.ts');
  assert.equal(entity('node', 'genesis_node_003', { address: ADDRESS }).href, `/explorer/address/${ADDRESS}`);
  assert.equal(entity('node', 'genesis_node_003', { address: null }).href, null);
});
