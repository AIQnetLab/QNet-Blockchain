// Total earned: what the wallet's moves took to it in all, from the explorer archive's moves replayed by the chain's own
// watermark rule (a move the archive keeps cut short read whole from the chain), plus the node balance, both of one
// moment: the balance read from the node that gives the history's first page just before it, the moves only when they
// replay to that node's watermark. Anything less is "could not be read" beside the balance, never a wrong number. The
// same for a light, a super and a genesis node, a connected wallet and a view.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIMS_SQL, MOVES_SQL, MOVE_READS, MOVE_ROWS, PROOFS_RE, REGISTRATION_SQL, TIMES_SQL, completeMoves, createEpochArchive, movedTotal, wholeEntries,
} from '../../server/cabinet/epoch-archive.ts';
import { MOVE_BLOCK_MAX_BYTES, MOVE_NODES_ASKED, MOVE_RETRY_MS, createMovePayloads, payloadFrom } from '../../server/cabinet/move-payload.ts';
import { createNodeProxy, earnedOf, historyView, parsePendingAt } from '../../server/cabinet/node-proxy.ts';
import { earnedView, formatQnc, parseHistoryView } from '../cabinet/node-view.ts';
import { code } from './source.mjs';
import { TEXTS } from './texts-helper.mjs';

const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const NODE = 'light_mobile_6526ab8fd00ff8ca';
const key = (epoch) => 160 * (epoch + 1);
// A move as the archive's MOVES_SQL gives it: its amount and its payload (a proof left in changes nothing).
const move = (entries, amount = String(entries.reduce((sum, [, a]) => sum + BigInt(a), 0n))) => ({
  amount,
  data: JSON.stringify({ claims: entries.map(([epoch, a]) => ({ amount: Number(a), epoch: key(epoch), proof: [['ab', true]] })) }),
});
// Exact amounts above 2^53 stay digits: the payload is written with them as text.
const bigMove = (entries) => ({
  amount: String(entries.reduce((sum, [, a]) => sum + BigInt(a), 0n)),
  data: `{"claims":[${entries.map(([epoch, a]) => `{"amount":${a},"epoch":${key(epoch)},"proof":[]}`).join(',')}]}`,
});

test('the moves replayed by the chain\'s rule: each epoch above the watermark once, a move sent twice counts once', () => {
  assert.deepEqual(movedTotal([]), { nano: '0', watermark: 0 });
  const a = move([[1, '3000000000'], [2, '4000000000']]);
  const b = move([[3, '5000000000']]);
  assert.deepEqual(movedTotal([a, b]), { nano: '12000000000', watermark: key(3) });
  // The same move sent again credits nothing.
  assert.deepEqual(movedTotal([a, a, b]), { nano: '12000000000', watermark: key(3) });
  // A move that lists epochs moved before credits only the rest.
  assert.deepEqual(movedTotal([a, move([[2, '4000000000'], [3, '5000000000']])]), { nano: '12000000000', watermark: key(3) });
  // The chain credits a move's epochs in key order, whatever order the payload lists them in.
  assert.deepEqual(movedTotal([move([[3, '5'], [2, '4']])]), { nano: '9', watermark: key(3) });
  // Exact past 2^53.
  assert.deepEqual(movedTotal([bigMove([[1, '9223372036854775807'], [2, '9223372036854775807']])]), { nano: '18446744073709551614', watermark: key(2) });
  // As the archive reads it, without the proofs.
  assert.deepEqual(movedTotal([{ amount: '7', data: `{"claims":[{"amount":3,"epoch":${key(1)},},{"amount":4,"epoch":${key(2)},}]}` }]), { nano: '7', watermark: key(2) });
});

test('a move that cannot be read whole gives no total, never a wrong one', () => {
  const a = move([[1, '3'], [2, '4']]);
  // The archive cut the payload short: the listed amounts fall short of the move's own total.
  const cut = { amount: '12', data: a.data };
  assert.equal(movedTotal([cut]), null);
  assert.equal(movedTotal([cut, move([[3, '5']])]), null);
  assert.equal(movedTotal([{ amount: '7', data: a.data.slice(0, a.data.indexOf(`"epoch":${key(2)}`)) }]), null);
  // More listed than moved, an epoch key that is none, an entry without an amount, no entry, an amount that is not whole.
  assert.equal(movedTotal([{ amount: '6', data: a.data }]), null);
  assert.equal(movedTotal([{ amount: '3', data: '{"claims":[{"amount":3,"epoch":100}]}' }]), null);
  assert.equal(movedTotal([{ amount: '3', data: `{"claims":[{"epoch":${key(1)}}]}` }]), null);
  assert.equal(movedTotal([{ amount: '0', data: '' }]), null);
  for (const amount of ['x', '-1', '1.5', null, 7]) assert.equal(movedTotal([{ amount, data: a.data }]), null, String(amount));
  // A wallet with more moves than the read takes.
  assert.equal(movedTotal(Array.from({ length: MOVE_ROWS + 1 }, (_, i) => move([[i + 1, '1']]))), null);
  assert.deepEqual(movedTotal(Array.from({ length: 3 }, (_, i) => move([[i + 1, '1']]))), { nano: '3', watermark: key(3) });
});

// A super or genesis node moves hundreds of epochs at once (a genesis wallet's third move took 201): the archive keeps a
// transaction's data to 100,000 characters (src/indexer/transform.ts), so the payload of such a move is cut short there
// and its listed amounts fall short of its total. Its whole payload comes from a genesis node's microblock at its height,
// taken only when its amounts add up to the move's own total; then the total replays to the node's watermark and every
// epoch the move took names it.
const PROOF = (i) => Array.from({ length: 8 }, (_, j) => [`${String(i).padStart(4, '0')}${'ab'.repeat(30)}`, j % 2 === 0]);
const GENESIS_EPOCH = '10476347500000';
const span = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => [from + i, GENESIS_EPOCH]);
// A move as the chain carries it, its proofs in, and as the archive keeps it: cut to 100,000 characters, the proofs left
// out by MOVES_SQL.
const chainMove = (hash, block, entries) => {
  const data = JSON.stringify({ claims: entries.map(([epoch, a], i) => ({ amount: Number(a), epoch: key(epoch), proof: PROOF(i) })) });
  return { hash, block: String(block), amount: String(entries.reduce((sum, [, a]) => sum + BigInt(a), 0n)), data };
};
const archived = (m) => ({ ...m, data: m.data.slice(0, 100_000).replace(PROOFS_RE, '') });
const MOVES = [chainMove('aa'.repeat(32), 852109, span(1, 57)), chainMove('bb'.repeat(32), 2068589, span(58, 139)), chainMove('cc'.repeat(32), 4967463, span(140, 340)), chainMove('dd'.repeat(32), 4995221, span(341, 342))];
const TOTAL = String(BigInt(GENESIS_EPOCH) * 342n);

test('a move the archive keeps cut short is read whole from the chain, and the total and every moved epoch follow', async () => {
  assert.ok(MOVES[2].data.length > 100_000, 'the 201-epoch move passes what the archive keeps');
  const rows = MOVES.map(archived);
  assert.equal(wholeEntries(rows[2]), null, 'cut: its listed amounts fall short of its total');
  assert.equal(movedTotal(rows), null);
  // Read whole: the total of every move, up to the last epoch moved, the node's own watermark.
  const asked = [];
  const whole = async (hash, height, amount) => {
    asked.push([hash, height, amount]);
    const m = MOVES.find((x) => x.hash === hash);
    return m ? m.data.replace(PROOFS_RE, '') : null;
  };
  const completed = await completeMoves(rows, whole);
  assert.deepEqual(asked, [[MOVES[2].hash, 4967463, MOVES[2].amount]], 'only the cut move is read');
  assert.deepEqual(movedTotal(completed), { nano: TOTAL, watermark: key(342) });
  // Without a reader, or when it gives none, the rows stay and give no total.
  assert.equal(movedTotal(await completeMoves(rows)), null);
  assert.equal(movedTotal(await completeMoves(rows, async () => null)), null);
  // At most MOVE_READS payloads a read: a wallet with more gets the rest on later reads.
  let reads = 0;
  await completeMoves(Array.from({ length: MOVE_READS + 3 }, () => rows[2]), async () => { reads += 1; return null; });
  assert.equal(reads, MOVE_READS);
  // A payload the reader keeps costs none of them: the next read fetches the rest and the total follows, each payload
  // fetched once.
  const many = Array.from({ length: MOVE_READS + 3 }, (_, i) => ({
    hash: (i + 16).toString(16).repeat(32), block: String(10_000 + i), amount: '5', whole: `{"claims":[{"amount":5,"epoch":${key(i + 1)}}]}`,
  }));
  const fetchedMoves = [];
  const reader = createMovePayloads({
    fetchFn: async (url) => {
      const height = Number(new URL(url).pathname.split('/').pop());
      fetchedMoves.push(height);
      const m = many.find((x) => Number(x.block) === height);
      return new Response(JSON.stringify({ height, transactions: [{ hash: m.hash, data: m.whole }] }), { status: 200 });
    },
    nodes: ['https://node1.example'], random: () => 0, now: () => 1_000_000,
  });
  const cutRows = many.map(({ hash, block, amount }) => ({ hash, block, amount, data: '{"claims":[' }));
  const firstRead = await completeMoves(cutRows, reader);
  assert.equal(firstRead.filter((r) => wholeEntries(r) === null).length, 3, 'the first read leaves three cut');
  assert.equal(movedTotal(firstRead), null);
  assert.deepEqual(movedTotal(await completeMoves(cutRows, reader)), { nano: String(5 * many.length), watermark: key(many.length) });
  assert.equal(fetchedMoves.length, many.length, 'each payload fetched once');
  // The archive's page facts and total, with the reader: every epoch the cut move took names it, its amount exact.
  const archive = createEpochArchive(async (text) => ({
    rows: text === MOVES_SQL ? rows : text === CLAIMS_SQL ? rows.slice(2) : [],
  }), () => 1_000_000, whole);
  const facts = await archive(WALLET, 'genesis_node_001', [key(342), key(341), key(338)], true);
  assert.deepEqual(facts.moved, { nano: TOTAL, watermark: key(342) });
  assert.deepEqual(facts.claims.get(key(338)), { tx: MOVES[2].hash, amountNano: GENESIS_EPOCH });
  assert.deepEqual(facts.claims.get(key(341)), { tx: MOVES[3].hash, amountNano: GENESIS_EPOCH });
  // The page then carries the total with the balance: no "could not be read".
  const node = { wallet: WALLET, rows: [], more: false, lastClaimed: key(342) };
  assert.deepEqual(earnedOf(node, facts, { nano: '188574255000000', firstUnclaimed: key(343) }), { movedNano: TOTAL, balanceNano: '188574255000000' });
});

test('a move\'s whole payload: the microblock\'s transaction of its hash, its amounts the move\'s total, read once', async () => {
  const big = MOVES[2];
  const block = (txs) => ({ height: 4967463, transactions: txs });
  const fetched = [];
  let answer = block([{ hash: 'ee'.repeat(32), data: '{}' }, { hash: big.hash, data: big.data, amount: Number(big.amount) }]);
  const fetchFn = async (url) => {
    fetched.push(new URL(url).pathname);
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  let t = 1_000_000;
  const read = createMovePayloads({ fetchFn, nodes: ['https://node1.example', 'https://node2.example'], random: () => 0, now: () => t });
  const data = await read(big.hash, 4967463, big.amount);
  assert.equal(data, big.data.replace(PROOFS_RE, ''), 'its payload without the proofs');
  assert.doesNotMatch(data, /"proof"/);
  assert.deepEqual(fetched, ['/api/v1/microblock/4967463']);
  // Kept for good: a move in a block never changes.
  t += 86_400_000;
  assert.equal(await read(big.hash, 4967463, big.amount), data);
  assert.equal(fetched.length, 1);
  // A transaction whose amounts are not the move's total, or a block without it, gives none: asked again after a while,
  // from at most MOVE_NODES_ASKED nodes.
  assert.equal(payloadFrom(block([{ hash: big.hash, data: big.data }]), big.hash, String(BigInt(big.amount) + 1n)), null);
  assert.equal(payloadFrom(block([{ hash: 'ee'.repeat(32), data: big.data }]), big.hash, big.amount), null);
  assert.equal(payloadFrom({ transactions: 'x' }, big.hash, big.amount), null);
  answer = block([]);
  fetched.length = 0;
  assert.equal(await read(MOVES[1].hash, 2068589, MOVES[1].amount), null);
  assert.equal(fetched.length, MOVE_NODES_ASKED);
  assert.equal(await read(MOVES[1].hash, 2068589, MOVES[1].amount), null);
  assert.equal(fetched.length, MOVE_NODES_ASKED, 'none read again at once');
  t += MOVE_RETRY_MS + 1;
  answer = block([{ hash: MOVES[1].hash, data: MOVES[1].data }]);
  assert.equal(await read(MOVES[1].hash, 2068589, MOVES[1].amount), MOVES[1].data.replace(PROOFS_RE, ''));
  // A node over its budget is not asked.
  fetched.length = 0;
  const none = createMovePayloads({ fetchFn, nodes: ['https://node1.example'], budget: () => false });
  assert.equal(await none(big.hash, 4967463, big.amount), null);
  assert.deepEqual(fetched, []);
  // The microblock's body is read up to a bound; the route builds its archive with the process's reader.
  assert.equal(MOVE_BLOCK_MAX_BYTES, 8 * 1024 * 1024);
  assert.match(code('server/cabinet/move-payload.ts'), /const data = payloadFrom\(await read\(`\$\{base\}\/api\/v1\/microblock\/\$\{height\}`\), hash, amount\);/);
});

test('the archive reads every move of the wallet only for the first page, and a failed read of them leaves the other facts', async () => {
  // Every move to the wallet from the pool, in chain order, with its hash and block, the proofs left out in the database,
  // one row past the limit.
  assert.match(MOVES_SQL, /^SELECT hash, block::text AS block, amount::text AS amount, regexp_replace\(COALESCE\(data, ''\), '"proof"\\s\*:\\s\*\\\[\[\^\{\}\]\*\\\]', '', 'g'\) AS data FROM transactions/);
  assert.match(MOVES_SQL, /WHERE to_address = \$1 AND tx_type = 'RewardDistribution' AND from_address = 'system_rewards_pool'\s+ORDER BY transactions\.block ASC, tx_index ASC LIMIT 5001$/);
  assert.equal(MOVE_ROWS, 5_000);
  const asked = [];
  const rows = { [MOVES_SQL]: [move([[1, '3'], [2, '4']])], [REGISTRATION_SQL]: [], [CLAIMS_SQL]: [], [TIMES_SQL]: [] };
  const archive = createEpochArchive(async (text, params) => {
    asked.push([text, params]);
    return { rows: rows[text] };
  });
  const first = await archive(WALLET, NODE, [key(2)], true);
  assert.deepEqual(first.moved, { nano: '7', watermark: key(2) });
  assert.deepEqual(asked.filter(([text]) => text === MOVES_SQL).map(([, params]) => params), [[WALLET]]);
  const later = await archive(WALLET, NODE, [key(2)]);
  assert.equal(later.moved, null);
  assert.equal(asked.filter(([text]) => text === MOVES_SQL).length, 1, 'a later page reads no moves');
  const failing = createEpochArchive(async (text) => {
    if (text === MOVES_SQL) throw new Error('db');
    return { rows: [] };
  });
  const facts = await failing(WALLET, NODE, [key(2)], true);
  assert.equal(facts.moved, null);
  assert.equal(facts.registeredHeight, null);
  assert.ok(facts.times instanceof Map);
});

test('one moment: the balance read just before the page goes with its watermark, and the moves only when they replay to it', () => {
  const node = { wallet: WALLET, rows: [], more: false, lastClaimed: key(2) };
  const facts = (moved) => ({ registeredHeight: null, superHeight: null, claims: new Map(), times: new Map(), moved });
  const balance = { nano: '5000000000', firstUnclaimed: key(3) };
  assert.deepEqual(earnedOf(node, facts({ nano: '7000000000', watermark: key(2) }), balance), { movedNano: '7000000000', balanceNano: '5000000000' });
  assert.deepEqual(earnedOf(node, facts({ nano: '7000000000', watermark: key(2) }), { nano: '0', firstUnclaimed: null }), { movedNano: '7000000000', balanceNano: '0' });
  // The archive has not reached the latest move, or holds one the node has not applied yet: the balance alone.
  const alone = { movedNano: null, balanceNano: '5000000000' };
  assert.deepEqual(earnedOf(node, facts({ nano: '3000000000', watermark: key(1) }), balance), alone);
  assert.deepEqual(earnedOf(node, facts({ nano: '9000000000', watermark: key(3) }), balance), alone);
  // A move landed between the balance and the page: the balance still counts epochs the page calls moved, so neither.
  assert.equal(earnedOf(node, facts({ nano: '7000000000', watermark: key(2) }), { nano: '5000000000', firstUnclaimed: key(2) }), null);
  // No balance: nothing. No archive, no moves read, or a node that names no watermark: the balance alone.
  assert.equal(earnedOf(node, facts({ nano: '7', watermark: key(2) }), null), null);
  assert.deepEqual(earnedOf(node, null, balance), alone);
  assert.deepEqual(earnedOf(node, facts(null), balance), alone);
  assert.deepEqual(earnedOf({ ...node, lastClaimed: null }, facts({ nano: '7', watermark: key(2) }), balance), alone);
  // A wallet that never moved: its watermark is 0, its moves none.
  assert.deepEqual(earnedOf({ ...node, lastClaimed: 0 }, facts({ nano: '0', watermark: 0 }), balance), { movedNano: '0', balanceNano: '5000000000' });
  // The page carries it; the page reads it exactly.
  const view = historyView(node, facts({ nano: '7000000000', watermark: key(2) }), balance);
  assert.deepEqual(view.earned, { movedNano: '7000000000', balanceNano: '5000000000' });
  assert.deepEqual(parseHistoryView(view), view);
  assert.equal(historyView(node, facts({ nano: '7', watermark: key(2) })).earned, null, 'no balance given: a later page');
  // The node's answer: the balance with its first unpaid epoch, else nothing to tie it to.
  assert.deepEqual(parsePendingAt({ pending_rewards_nano: 5_000_000_000, first_unclaimed_epoch: key(3) }), { nano: '5000000000', firstUnclaimed: key(3) });
  assert.deepEqual(parsePendingAt({ pending_rewards_nano: 0, first_unclaimed_epoch: null }), { nano: '0', firstUnclaimed: null });
  assert.equal(parsePendingAt({ pending_rewards_nano: 5 }), null);
  assert.equal(parsePendingAt({ pending_rewards_nano: 5, first_unclaimed_epoch: -1 }), null);
  assert.equal(parsePendingAt({ first_unclaimed_epoch: 1 }), null);
});

test('the history route: the first page reads the balance from its node just before the page and carries the total; a later page does not', async () => {
  const history = (offset) => ({
    node_id: NODE, wallet: WALLET, last_claimed_epoch: key(2), pagination: { has_more: offset === 0 },
    history: [{ epoch: key(offset === 0 ? 4 : 3), status: 'claimable', amount_qnc: 5, shard_certified: null }],
  });
  const calls = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: `${u.pathname}${u.search}` });
    if (u.pathname.startsWith('/api/v1/rewards/pending/')) return new Response(JSON.stringify({ pending_rewards_nano: 5_000_000_000, first_unclaimed_epoch: key(4) }), { status: 200 });
    if (u.pathname.startsWith('/api/v1/rewards/history/')) return new Response(JSON.stringify(history(Number(u.searchParams.get('offset') ?? 0))), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const p = createNodeProxy({ fetchFn, random: () => 0.5, now: () => 1_000_000, clientKey: () => ({ ok: true, ip: '203.0.113.8' }), scope: 'earned', devOrigins: false });
  const archive = async (wallet, nodeId, keys, withMoves) => ({
    registeredHeight: null, superHeight: null, claims: new Map(), times: new Map(), moved: withMoves ? { nano: '7000000000', watermark: key(2) } : null,
  });
  const get = (query = '') => new Request(`https://aiqnet.io/api/cabinet/node/${NODE}/history${query}`, { headers: { host: 'aiqnet.io' } });
  const first = await (await p.history(get(), NODE, archive)).json();
  assert.deepEqual(first.earned, { movedNano: '7000000000', balanceNano: '5000000000' });
  assert.deepEqual(parseHistoryView(first), first);
  assert.deepEqual(calls.map((c) => c.path), [`/api/v1/rewards/pending/${NODE}`, `/api/v1/rewards/history/${NODE}?limit=30`]);
  assert.equal(calls[0].host, calls[1].host, 'the same node');
  const later = await (await p.history(get('?page=1'), NODE, archive)).json();
  assert.equal(later.earned, null);
  assert.equal(calls.length, 3, 'a later page asks no balance');
  // Without the archive, no total and no balance read.
  const bare = createNodeProxy({ fetchFn, random: () => 0.5, now: () => 1_000_000, clientKey: () => ({ ok: true, ip: '203.0.113.8' }), scope: 'earned-bare', devOrigins: false });
  calls.length = 0;
  assert.equal((await (await bare.history(get(), NODE)).json()).earned, null);
  assert.deepEqual(calls.map((c) => c.path), [`/api/v1/rewards/history/${NODE}?limit=30`]);
});

test('the line: the total and its split when the history\'s balance is the one the page shows; read again, else could not be read', () => {
  const earned = { movedNano: '7000000000', balanceNano: '5000000000' };
  assert.deepEqual(earnedView(earned, '5000000000'), { kind: 'total', totalNano: '12000000000', movedNano: '7000000000', balanceNano: '5000000000' });
  // Exact past 2^53.
  assert.equal(earnedView({ movedNano: '9007199254740993', balanceNano: '1' }, '1').totalNano, '9007199254740994');
  // A page that shows no balance (History) names the history's own.
  assert.equal(earnedView(earned, null).kind, 'total');
  // A move or a new epoch between the two reads: read again, then could not be read, with the balance the page shows.
  assert.deepEqual(earnedView(earned, '0'), { kind: 'reading' });
  assert.deepEqual(earnedView(earned, '0', true), { kind: 'unknown', balanceNano: '0' });
  // No answer: could not be read, with the balance the page shows when it shows one.
  assert.deepEqual(earnedView(null, '5000000000'), { kind: 'unknown', balanceNano: '5000000000' });
  assert.deepEqual(earnedView(null, null), { kind: 'unknown', balanceNano: null });
  // The balance read without its moves: no total, and History names that balance.
  assert.deepEqual(earnedView({ movedNano: null, balanceNano: '5000000000' }, null), { kind: 'unknown', balanceNano: '5000000000' });
  assert.deepEqual(earnedView({ movedNano: null, balanceNano: '5000000000' }, '5000000000'), { kind: 'unknown', balanceNano: '5000000000' });
  assert.deepEqual(earnedView({ movedNano: null, balanceNano: '5000000000' }, '0'), { kind: 'reading' });
  assert.deepEqual(parseHistoryView({ registeredEpoch: 0, archived: true, rows: [], more: false, earned: { movedNano: null, balanceNano: '5' } })?.earned, { movedNano: null, balanceNano: '5' });
  assert.equal(parseHistoryView({ registeredEpoch: 0, archived: true, rows: [], more: false, earned: { movedNano: null, balanceNano: null } }), null);
  // The words, and amounts as the balance writes them: readings named "Total earned" and "Moved to the wallet".
  assert.equal(TEXTS.ro_total_earned, 'Total earned');
  assert.equal(TEXTS.ro_moved, 'Moved to the wallet');
  assert.equal(TEXTS.earned_unknown, 'Could not be read.');
  assert.equal(TEXTS.earned_reading, 'Reading the latest moves again…');
  for (const key of ['earned_total', 'earned_split', 'earned_unknown_split']) assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, key), false, key);
  assert.equal(formatQnc('12345678901234'), '12,345.678901234');
});

test('the line on the Overview\'s balance of a light and a super node and on History, the same for a view', () => {
  const home = code('components/cabinet/NodeHome.tsx');
  // One node balance group for a light and a super node: the figure, then the total earned against the balance it shows.
  assert.equal(home.match(/<Balance nodeId=\{nodeId\} balanceNano=\{status\.balanceNano\}>/g)?.length, 2);
  assert.match(home, /<p className="cab-figure" [^\n]*>[\s\S]*?<\/p>[\s\S]*?<Earned nodeId=\{nodeId\} balanceNano=\{balanceNano\} \/>/);
  const history = code('components/cabinet/NodeHistory.tsx');
  assert.match(history, /<div className="cab-earned"><Earned nodeId=\{nodeId\} balanceNano=\{null\} \/><\/div>\s*<Group>\s*<Epochs nodeId=\{nodeId\} show="all" \/>/);
  const line = history.slice(history.indexOf('export function Earned('), history.indexOf('function EpochCard('));
  // One shared read with the epochs (a view's on its own address, as theirs); read again while the balances differ, at
  // once and then after the site's copy.
  assert.match(line, /const \{ viewOnly \} = useCabinet\(\);\s*const \{ state, refresh \} = useNodeHistory\(nodeId, viewOnly\);/);
  assert.match(line, /const differs = earned !== null && balanceNano !== null && earned\.balanceNano !== balanceNano;/);
  assert.match(line, /\}, tries === 0 \? 0 : HISTORY_KEPT_MS \+ 1_000\);/);
  // Dashes while the history is read the first time, then its view.
  assert.match(line, /const shown = state\.phase === 'loading' \? null : earnedView\(earned, balanceNano, tries >= EARNED_RETRIES\);/);
  assert.match(line, /const sub = shown\?\.kind === 'reading' \? t\('earned_reading'\) : shown\?\.kind === 'unknown' \? t\('earned_unknown'\) : undefined;/);
  assert.match(line, /<Readout label=\{t\('ro_total_earned'\)\} value=\{qnc\(total\?\.totalNano\)\} amount=\{\{\}\} sub=\{sub\} wide \/>/);
  // History, which shows no balance of its own above, names the history's balance as a third reading, also while the
  // moves cannot be totalled (a super or genesis node's move the archive keeps cut short, an archive behind).
  assert.match(line, /const balance = shown\?\.kind === 'total' \|\| shown\?\.kind === 'unknown' \? shown\.balanceNano : null;/);
  assert.match(line, /\{balanceNano === null && <Readout label=\{t\('balance_title'\)\} value=\{qnc\(balance\)\}/);
  // Public chain data: a view only reads its own address, and the line shows the same.
  assert.equal(line.match(/viewOnly/g)?.length, 2, 'public chain data: no difference for a view');
  // The site keeps a page as long as the line waits for.
  assert.match(code('server/cabinet/node-proxy.ts'), /export const HISTORY_CACHE_MS = HISTORY_KEPT_MS;/);
});
