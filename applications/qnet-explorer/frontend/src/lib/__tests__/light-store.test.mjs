// The balance check's light client across restarts (src/server/light/store.ts, lineage.ts follow(), refresh.ts and
// scripts/light-pin.mjs): a restart resumes from the checkpoints it verified before, a store from another pin or with a
// bad field is not believed, the follower keeps both parity chains at the certified head with no request, the store
// keeps the GALC v2 capsule and a restart verifies it again, the build-time walk and the follower root at a capsule when
// one is served, and a new pin verifies every step from the committed pin, never from a capsule, with block 0's hash the
// nodes name. Run: npm run test:wallet
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACKER, CAPSULE_OPTIONS, ELIGIBLE, NODES, REG_ROOT, beaconOf, capsuleAt, genesisSig, network, pinAt, proofFor, read } from './light-helpers.mjs';
import { PERSIST_PER_PARITY, createLightClient, pinIdentity, topPerParity } from '../../server/light/lineage.ts';
import { fileCheckpointStore, memoryCheckpointStore, storeFileProblem } from '../../server/light/store.ts';
import { agreedMacroblockHash, agreedNetworkId, macroblockHash, networkIdOf, proveNewPin, replacePinBlock, walkToHead } from '../../server/light/refresh.ts';
import { CAPSULE_PATH } from '../../server/light/galc.ts';
import { GALC_V2_MINT_INTERVAL, NETWORK_ID } from '../../server/light/pin.ts';

const K = 100;
const TOP = 112;
const ROOT = 'ab'.repeat(32);
const rootOf = () => ROOT;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const noPause = async () => {};
const light = (net, extra = {}) => createLightClient({ nodes: () => NODES, fetchText: net.fetchText, pin: pinAt(K), ...extra });
const proofsAsked = (net) => net.asked.filter(([, p]) => /\/macroblock\/\d+\/proof$/.test(p)).map(([, p]) => Number(/(\d+)\/proof$/.exec(p)[1]));
const stored = (store) => store.content.checkpoints.map((c) => c.index);
const record = (index, over = {}) => ({ index, stateRoot: ROOT, eligibleRaw: ELIGIBLE, beacon: beaconOf(index), registryRoot: REG_ROOT, ...over });
const copy = (store) => memoryCheckpointStore(structuredClone(store.content));

// A store holding the checkpoints a walk to TOP and TOP - 1 verified from pinAt(K).
async function walkedStore(top = TOP, pin = pinAt(K)) {
  const store = memoryCheckpointStore();
  const lc = light(network({ nodes: NODES, top, stateRootOf: rootOf }), { store, pin });
  assert.deepEqual(await lc.certifiedRootAt(top, 30_000), { root: ROOT });
  assert.deepEqual(await lc.certifiedRootAt(top - 1, 30_000), { root: ROOT });
  await lc.flush();
  return store;
}

test('a restart resumes from the checkpoints verified before it: nothing below them is asked again', async () => {
  const store = await walkedStore();
  assert.deepEqual(stored(store), [112, 111, 110, 109, 108, 107, 106, 105, 104, 103, 102, 101]);
  assert.deepEqual(store.content.pin, pinIdentity(pinAt(K)));
  const net = network({ nodes: NODES, top: TOP + 2, stateRootOf: rootOf });
  const lc = light(net, { store });
  assert.deepEqual(await lc.certifiedRootAt(TOP, 1000), { root: ROOT });
  assert.deepEqual(await lc.certifiedRootAt(TOP - 1, 1000), { root: ROOT });
  assert.deepEqual(proofsAsked(net), [], 'the stored checkpoints answer');
  assert.deepEqual(await lc.certifiedRootAt(TOP + 2, 30_000), { root: ROOT });
  assert.deepEqual([...new Set(proofsAsked(net))], [TOP + 2], 'one step from the stored top');
});

test('a store walked from another pin is not believed; one from the pin this one was proven from is, above the new pin', async () => {
  const store = await walkedStore();
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf });
  const other = light(net, { store: copy(store), pin: { ...pinAt(K), hash: 'cd'.repeat(32) } });
  assert.deepEqual(await other.certifiedRootAt(TOP, 30_000), { root: ROOT });
  assert.ok(proofsAsked(net).includes(102), 'walked from its own pin again');

  const newer = { ...pinAt(104), hash: 'ef'.repeat(32), provenFrom: { index: K, hash: pinIdentity(pinAt(K)).id } };
  const net2 = network({ nodes: NODES, top: TOP, stateRootOf: rootOf });
  const lc = light(net2, { store: copy(store), pin: newer });
  assert.deepEqual(await lc.certifiedRootAt(TOP, 1000), { root: ROOT });
  assert.deepEqual(await lc.certifiedRootAt(105, 1000), { root: ROOT });
  assert.deepEqual(proofsAsked(net2), []);
  assert.deepEqual(await lc.certifiedRootAt(104, 1000), { unprovable: 'below_floor' }, 'nothing at or below the new pin');
  assert.equal(lc.verifiedCheckpoint(104), null);
});

test('every stored field is checked again: a record at the pin, a malformed root or eligible set is dropped', async () => {
  const store = memoryCheckpointStore({ pin: pinIdentity(pinAt(K)), checkpoints: [
    record(112), record(110, { stateRoot: 'AB'.repeat(32) }), record(K), record(108, { eligibleRaw: '00' }),
    record(111, { eligibleRaw: ELIGIBLE.toUpperCase() }), record(109, { beacon: 'x' }),
  ] });
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf });
  const lc = light(net, { store });
  await lc.ready();
  assert.equal(lc.highestVerifiedIndex(), 112);
  assert.deepEqual([110, K, 108, 111, 109].map((j) => lc.verifiedCheckpoint(j)), [null, null, null, null, null]);
  assert.deepEqual(await lc.certifiedRootAt(112, 1000), { root: ROOT });
  assert.deepEqual(proofsAsked(net), []);
  // An unreadable file is no store: the walk starts from the pin.
  const dir = mkdtempSync(join(tmpdir(), 'light-store-'));
  try {
    const file = join(dir, 'light-checkpoints.json');
    writeFileSync(file, '{"format":1,"pin":');
    const fresh = network({ nodes: NODES, top: TOP, stateRootOf: rootOf });
    const lf = light(fresh, { store: fileCheckpointStore(file) });
    assert.deepEqual(await lf.certifiedRootAt(104, 30_000), { root: ROOT });
    assert.deepEqual([...new Set(proofsAsked(fresh))], [102, 104]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file store writes whole files, readable by the site\'s user only, and reads back what it wrote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-store-'));
  try {
    const file = join(dir, 'data', 'light-checkpoints.json');
    const store = fileCheckpointStore(file);
    assert.equal(await store.load(), null);
    const lineage = { pin: { index: K, id: 'ab'.repeat(32) }, checkpoints: [record(112), record(111)] };
    await store.save(lineage);
    assert.deepEqual(await store.load(), lineage);
    assert.match(readFileSync(file, 'utf8'), /"state_root": "(ab)+"/);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    await store.save({ ...lineage, checkpoints: [record(114)] });
    assert.deepEqual((await store.load()).checkpoints.map((c) => c.index), [114]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A store anyone but the site's user could have written is no store: the walk starts from the pin, and the next save
// puts a file of the site's own in its place.
test('a store file that is a link, another user\'s, or writable by others is not read', async () => {
  const st = (o = {}) => ({ isFile: () => o.file ?? true, isSymbolicLink: () => o.link ?? false, mode: o.mode ?? 0o100600, uid: o.uid ?? 1000 });
  assert.equal(storeFileProblem(st(), 1000), null);
  assert.equal(storeFileProblem(st({ mode: 0o100644 }), 1000), null, 'readable by others is no threat to what it says');
  assert.equal(storeFileProblem(st({ link: true }), 1000), 'symlink');
  assert.equal(storeFileProblem(st({ file: false }), 1000), 'not_a_file');
  assert.equal(storeFileProblem(st({ uid: 0 }), 1000), 'foreign_owner');
  assert.equal(storeFileProblem(st({ mode: 0o100620 }), 1000), 'writable_by_others');
  assert.equal(storeFileProblem(st({ mode: 0o100602 }), 1000), 'writable_by_others');
  assert.equal(storeFileProblem(st({ mode: 0o100666, uid: 0 }), null), null, 'no modes or owners to look at (Windows)');
  assert.equal(storeFileProblem(st({ link: true }), null), 'symlink');

  const dir = mkdtempSync(join(tmpdir(), 'light-store-'));
  try {
    const lineage = { pin: pinIdentity(pinAt(K)), checkpoints: [record(112), record(111)] };
    const file = join(dir, 'light-checkpoints.json');
    await fileCheckpointStore(file).save(lineage);
    assert.deepEqual(await fileCheckpointStore(file).load(), lineage);
    if (process.platform !== 'win32') {
      chmodSync(file, 0o666);
      assert.equal(await fileCheckpointStore(file).load(), null, 'writable by others');
      const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf });
      const lc = light(net, { store: fileCheckpointStore(file) });
      assert.deepEqual(await lc.certifiedRootAt(104, 30_000), { root: ROOT });
      assert.ok(proofsAsked(net).includes(102), 'walked from the pin');
      await lc.flush();
      assert.equal(statSync(file).mode & 0o777, 0o600, 'replaced by a file of the site\'s own');
      assert.equal(Math.max(...(await fileCheckpointStore(file).load()).checkpoints.map((c) => c.index)), 104);
    }
    // A link is not followed, wherever it points.
    const link = join(dir, 'link.json');
    let linked = true;
    try { symlinkSync(file, link); } catch { linked = false; }
    if (linked) assert.equal(await fileCheckpointStore(link).load(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a save keeps what another process stored further up, eight a chain, and replaces a store that contradicts it', async () => {
  const store = memoryCheckpointStore();
  const net = network({ nodes: NODES, top: 130, stateRootOf: rootOf });
  const lc = light(net, { store });
  assert.deepEqual(await lc.certifiedRootAt(128, 30_000), { root: ROOT });
  assert.deepEqual(await lc.certifiedRootAt(127, 30_000), { root: ROOT });
  // The build-time walk wrote 130 meanwhile: kept, and taken in.
  store.content = { pin: pinIdentity(pinAt(K)), checkpoints: [record(130)] };
  await lc.flush();
  assert.deepEqual(stored(store), topPerParity([130, ...Array.from({ length: 28 }, (_, i) => 101 + i)], PERSIST_PER_PARITY));
  assert.equal(stored(store).filter((j) => j % 2 === 0).length, PERSIST_PER_PARITY);
  assert.equal(stored(store)[0], 130);
  assert.ok(lc.verifiedCheckpoint(130));
  // A stored checkpoint contradicting one verified here: the store's set is not believed and is replaced.
  store.content = { pin: pinIdentity(pinAt(K)), checkpoints: [record(126, { stateRoot: 'cd'.repeat(32) }), record(140)] };
  await lc.walk(129);
  await lc.flush();
  assert.equal(store.content.checkpoints.find((c) => c.index === 126).stateRoot, ROOT);
  assert.ok(!stored(store).includes(140));
});

test('follow() walks both parity chains to the certified head with no request, then asks nothing until it moves', async () => {
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf });
  const store = memoryCheckpointStore();
  const lc = light(net, { store });
  const stop = lc.follow(40);
  for (let i = 0; i < 400 && !(lc.verifiedCheckpoint(TOP) && lc.verifiedCheckpoint(TOP - 1)); i++) await sleep(25);
  assert.ok(lc.verifiedCheckpoint(TOP) && lc.verifiedCheckpoint(TOP - 1), 'both chains at the head');
  const asked = net.asked.length;
  await sleep(250);
  assert.equal(net.asked.length, asked, 'at the head (a halted chain): no proof, and the head read once a minute');
  stop();
  await lc.flush();
  assert.deepEqual(stored(store).slice(0, 2), [TOP, TOP - 1]);
});

test('the build-time walk reaches the head and the one below, every step verified, and leaves them to the server', async () => {
  const store = memoryCheckpointStore();
  const r = await walkToHead({ light: light(network({ nodes: NODES, top: TOP, stateRootOf: rootOf }), { store }), budgetMs: 60_000, pause: noPause });
  assert.deepEqual({ outcome: r.outcome, head: r.head, targets: r.targets, highest: r.highest }, { outcome: 'reached', head: TOP, targets: [TOP, TOP - 1], highest: TOP });
  assert.deepEqual(stored(store).slice(0, 2), [TOP, TOP - 1]);
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf });
  assert.deepEqual(await light(net, { store }).certifiedRootAt(TOP, 1000), { root: ROOT });
  assert.deepEqual(proofsAsked(net), [], 'the server started after the build answers at once');
  // A step no node serves honestly stops it there: nothing above is stored, nothing is taken on the nodes' word.
  const forged = (path, honest) => (path.endsWith('/macroblock/106/proof') ? { body: proofFor(106, 'ff'.repeat(32), { signWith: ATTACKER }) } : honest(path));
  const bad = memoryCheckpointStore();
  const r2 = await walkToHead({ light: light(network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, forged])) }), { store: bad }),
    budgetMs: 60_000, pause: noPause });
  assert.equal(r2.outcome, 'refused');
  assert.ok(!stored(bad).some((j) => j >= 106 && j % 2 === 0), stored(bad).join());
  const none = await walkToHead({ light: light(network({ nodes: NODES, top: TOP, stateRootOf: rootOf })), budgetMs: 0, pause: noPause });
  assert.equal(none.outcome, 'budget');
});

// The macroblock header a node serves (/api/v1/macroblock/{index}), the same fields on every node unless `edit` says,
// and block 0's header (NETWORK_ID unless `block0` names another).
const header = (j, edit = (h) => h) => edit({ index: j, height: j, timestamp: 1_700_000_000 + j, micro_blocks_count: 2,
  micro_blocks: ['11'.repeat(32), '22'.repeat(32)], state_root: ROOT, consensus_data: { next_leader: 'x' }, previous_hash: '33'.repeat(32) });
const BLOCK0 = '/api/v1/blocks/headers?from=0&limit=1';
const block0Body = (hash) => ({ from: 0, head: 3_521_702, items: [{ body: true, hash, height: 0, previous_hash: '00'.repeat(32) }] });
const headers = (edit, block0 = NETWORK_ID) => (path, honest) => {
  if (path === BLOCK0) return { body: block0Body(block0) };
  const m = /^\/api\/v1\/macroblock\/(\d+)$/.exec(path);
  return m ? { body: header(Number(m[1]), edit) } : honest(path);
};
const pinRun = { networkId: NETWORK_ID, galcInterval: GALC_V2_MINT_INTERVAL };

test('MacroBlock::hash is the node\'s: height, time, previous hash, state root and the microblock hashes', () => {
  const h = header(108);
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const want = createHash('sha3-256').update(Buffer.concat([u64(108), u64(h.timestamp), Buffer.from(h.previous_hash, 'hex'),
    Buffer.from(h.state_root, 'hex'), ...h.micro_blocks.map((x) => Buffer.from(x, 'hex'))])).digest('hex');
  assert.equal(macroblockHash(h), want);
  assert.equal(macroblockHash({ ...h, state_root: 'zz' }), null);
});

test('a new pin is a checkpoint the walk verified from the committed pin, its hash named alike by the nodes', async () => {
  const committed = { ...pinAt(K), hash: 'aa'.repeat(32) };
  const store = memoryCheckpointStore();
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, headers()])) });
  const lc = light(net, { store, pin: committed });
  const r = await proveNewPin({ light: lc, budgetMs: 60_000, pause: noPause, nodes: NODES, fetchText: net.fetchText, pin: committed, date: '2026-10-12', ...pinRun });
  assert.ok('block' in r, JSON.stringify(r.error));
  assert.equal(r.index, TOP - 4);
  assert.equal(r.walk.capsule, null, 'no capsule asked for');
  assert.ok(!net.asked.some(([, p]) => p === CAPSULE_PATH));
  const mod = await import(`data:text/javascript;base64,${Buffer.from(r.block).toString('base64')}`);
  // Block 0's hash every node named, and the cadence, in the wallets' lines.
  assert.equal(mod.NETWORK_ID, NETWORK_ID);
  assert.equal(mod.GALC_V2_MINT_INTERVAL, GALC_V2_MINT_INTERVAL);
  assert.ok(r.block.endsWith(`export const NETWORK_ID = '${NETWORK_ID}';\n// Macroblocks between two genesis-signed capsules: the node's GALC_V2_MINT_INTERVAL.\n`
    + 'export const GALC_V2_MINT_INTERVAL = 10;\n// </ws-pin>'));
  const pin = mod.WS_CHECKPOINT;
  assert.equal(pin.index, 108);
  assert.equal(pin.hash, macroblockHash(header(108)));
  assert.deepEqual(pin.provenFrom, { index: K, hash: 'aa'.repeat(32) });
  assert.deepEqual(pin.anchors[108], { eligible_raw: ELIGIBLE, beacon: beaconOf(108), registry_root: REG_ROOT });
  assert.deepEqual(pin.anchors[107], { eligible_raw: ELIGIBLE, beacon: beaconOf(107), registry_root: REG_ROOT });
  // pin.ts takes the block between its markers, nothing else of the file changes.
  const source = read('applications/qnet-explorer/frontend/src/server/light/pin.ts');
  const next = replacePinBlock(source, r.block);
  assert.equal(next.replace(r.block, '<pin>'), source.replace(/\/\/ <ws-pin>[\s\S]*?\/\/ <\/ws-pin>/, '<pin>'));
  // The new pin keeps the store walked from the committed one (here up to the head) and verifies onwards from it.
  assert.equal((await walkToHead({ light: lc, budgetMs: 60_000, pause: noPause })).outcome, 'reached');
  const net2 = network({ nodes: NODES, top: TOP + 2, stateRootOf: rootOf });
  const next2 = light(net2, { store, pin });
  assert.equal(next2.trustFloorIndex(), 109);
  assert.deepEqual(await next2.certifiedRootAt(TOP + 2, 30_000), { root: ROOT });
  assert.deepEqual([...new Set(proofsAsked(net2))], [TOP + 2]);
  assert.deepEqual(await light(network({ nodes: NODES, top: TOP, stateRootOf: rootOf }), { pin }).certifiedRootAt(110, 30_000), { root: ROOT },
    'from its anchors alone');
  // A pin is walked in the same run from the committed pin: a client holding a store's checkpoints, or rooted at
  // another pin, gives none.
  const fromStore = light(network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, headers()])) }),
    { store: copy(store), pin: committed });
  assert.match((await proveNewPin({ light: fromStore, budgetMs: 60_000, pause: noPause, nodes: NODES, fetchText: net.fetchText, pin: committed, ...pinRun })).error,
    /did not verify in this run/);
  const elsewhere = light(network({ nodes: NODES, top: TOP, stateRootOf: rootOf }), { pin: pinAt(102) });
  assert.match((await proveNewPin({ light: elsewhere, budgetMs: 60_000, pause: noPause, nodes: NODES, fetchText: net.fetchText, pin: committed, ...pinRun })).error,
    /not rooted at the committed pin 100/);
  // Nodes naming another block 0 serve another chain: no pin from them, refused before any walk.
  const chain = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, headers(undefined, 'ab'.repeat(32))])) });
  assert.equal((await proveNewPin({ light: light(chain, { pin: committed }), budgetMs: 60_000, pause: noPause, nodes: NODES, fetchText: chain.fetchText, pin: committed,
    ...pinRun })).error, `the nodes serve block 0 ${'ab'.repeat(32)}, the committed NETWORK_ID is ${NETWORK_ID}: another chain`);
  assert.deepEqual(proofsAsked(chain), []);
  // Headers whose state root is not the one the walk verified name no hash, though every node serves the same one.
  const otherRoot = Object.fromEntries(NODES.map((n) => [n, headers((h) => ({ ...h, state_root: 'cd'.repeat(32) }))]));
  const netOther = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: otherRoot });
  assert.ok('hash' in await agreedMacroblockHash(108, NODES, netOther.fetchText), 'unbound, the nodes agree');
  assert.deepEqual(await agreedMacroblockHash(108, NODES, netOther.fetchText, ROOT), { error: 'the nodes disagree on macroblock 108' });
  const lcOther = light(netOther, { pin: committed });
  assert.equal((await proveNewPin({ light: lcOther, budgetMs: 60_000, pause: noPause, nodes: NODES, fetchText: netOther.fetchText, pin: committed, ...pinRun })).error,
    'the nodes disagree on macroblock 108');
  // Nodes that disagree on the macroblock, or too few that answer, give no pin.
  const split = Object.fromEntries(NODES.map((n, i) => [n, headers(i === 2 ? (h) => ({ ...h, timestamp: h.timestamp + 1 }) : undefined)]));
  assert.deepEqual(await agreedMacroblockHash(108, NODES, network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: split }).fetchText),
    { error: 'the nodes disagree on macroblock 108' });
  const few = Object.fromEntries(NODES.map((n, i) => [n, i < 3 ? () => 'throw' : headers()]));
  assert.match((await agreedMacroblockHash(108, NODES, network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: few }).fetchText)).error,
    /^2 nodes answered/);
});

test('the build runs the walk before next build, skipped under CI, never failing it; the site starts the follower', () => {
  const pkg = JSON.parse(read('applications/qnet-explorer/frontend/package.json'));
  assert.equal(pkg.scripts.prebuild, 'node scripts/light-pin.mjs --build');
  const script = read('applications/qnet-explorer/frontend/scripts/light-pin.mjs');
  assert.match(script, /if \(build && \(process\.env\.CI \|\| process\.env\.LIGHT_REFRESH === '0'\)\) finish\(0,/);
  assert.match(script, /process\.exit\(build \? 0 : code\);/);
  assert.doesNotMatch(script, /--bootstrap|provenFrom: null/, 'no pin from the nodes\' word alone');
  assert.match(script, /const fresh = client\(undefined, false\);[\s\S]*?proveNewPin\(\{ light: fresh,/, 'a new pin is walked with no store and no capsule');
  assert.match(script, /networkId: NETWORK_ID, galcInterval \}\);/);
  assert.match(script, /const light = client\(fileCheckpointStore\(storePath\), true\);/);
  const instrumentation = read('applications/qnet-explorer/frontend/src/instrumentation.ts');
  assert.match(instrumentation, /sharedLightClient\(\)\.follow\(\);/);
  const prover = read('applications/qnet-explorer/frontend/src/server/light/balance-proof.ts');
  assert.match(prover, /createLightClient\(\{ nodes, fetchText, store: fileCheckpointStore\(defaultStorePath\(\)\) \}\)/);
});

// ------------------------------------------------------------------------------------------------ GALC v2 capsules

// The synthetic chain rooted at pinAt(K), its head CAP_TOP, and nodes serving a capsule of it at KC (signed by the
// vectors' test genesis keys).
const KC = 140;
const CAP_TOP = KC + 11;
const capsuleNet = (capsule = capsuleAt(KC, rootOf), top = CAP_TOP) => network({ nodes: NODES, top, stateRootOf: rootOf,
  handlers: Object.fromEntries(NODES.map((n) => [n, (path, honest) => (path === CAPSULE_PATH ? { body: capsule } : honest(path))])) });
const capsuleLight = (net, extra = {}) => light(net, { ...CAPSULE_OPTIONS, ...extra });

test('the store keeps the capsule; a restart takes it back verified again, with no request, and a tampered one is not taken', async () => {
  const store = memoryCheckpointStore();
  const lc = capsuleLight(capsuleNet(), { store });
  assert.deepEqual(await lc.refreshCapsule(), { ok: true, index: KC });
  assert.deepEqual(await lc.certifiedRootAt(CAP_TOP, 30_000), { root: ROOT });
  await lc.flush();
  assert.equal(store.content.capsule.capsule.mb_index, KC);
  assert.deepEqual(Object.keys(store.content.capsule.roots).sort(), [String(KC - 1), String(KC)]);
  // The checkpoints the walk verified carry their checkpoint hashes; the capsule's roots are not stored as checkpoints.
  assert.ok(store.content.checkpoints.every((c) => /^[0-9a-f]{64}$/.test(c.checkpointHash)));
  assert.ok(!stored(store).includes(KC) && !stored(store).includes(KC - 1));
  const net = capsuleNet();
  const again = capsuleLight(net, { store: copy(store) });
  await again.ready();
  assert.equal(again.heldCapsuleIndex(), KC);
  assert.deepEqual(await again.certifiedRootAt(KC, 1000), { root: ROOT });
  assert.deepEqual(await again.certifiedRootAt(CAP_TOP, 1000), { root: ROOT });
  assert.deepEqual(net.asked, [], 'answered from the store');
  // Tampered: a root that is not the signed checkpoint, a signature over another preimage, a capsule of another
  // network, a store from another pin, capsules off: no capsule, and the stored checkpoints still count.
  const tampered = (edit) => {
    const s = copy(store);
    edit(s.content.capsule);
    return s;
  };
  const otherSig = genesisSig('genesis_node_001', 'QNET_GENESIS_CHECKPOINT_v2:another');
  for (const [why, s, extra] of [
    ['root', tampered((c) => { c.roots[String(KC)].checkpoint.state_root = 'cd'.repeat(32); }), {}],
    ['signature', tampered((c) => { c.capsule.sigs[0] = ['genesis_node_001', otherSig]; }), {}],
    ['network', copy(store), { networkId: 'ef'.repeat(32) }],
    ['pin', memoryCheckpointStore({ ...structuredClone(store.content), pin: { index: K, id: 'cd'.repeat(32) } }), {}],
    ['off', copy(store), { capsules: false }],
  ]) {
    const quiet = network({ nodes: NODES, top: CAP_TOP, stateRootOf: rootOf });
    const lt = capsuleLight(quiet, { store: s, ...extra });
    await lt.ready();
    assert.equal(lt.heldCapsuleIndex(), 0, why);
    assert.equal(lt.verifiedCheckpoint(KC), null, why);
    if (why !== 'pin') assert.ok(lt.verifiedCheckpoint(CAP_TOP), `${why}: the checkpoints stay`);
  }
  // A save after a refused capsule leaves it out of the store.
  const refused = tampered((c) => { c.roots[String(KC)].checkpoint.state_root = 'cd'.repeat(32); });
  const lr = capsuleLight(network({ nodes: NODES, top: CAP_TOP + 2, stateRootOf: rootOf }), { store: refused });
  assert.deepEqual(await lr.certifiedRootAt(CAP_TOP + 2, 30_000), { root: ROOT });
  await lr.flush();
  assert.equal(refused.content.capsule, undefined);
});

test('a checkpoint hash and a capsule go through the file store as written; a store without them reads as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-store-'));
  try {
    const file = join(dir, 'light-checkpoints.json');
    const store = fileCheckpointStore(file);
    const capsule = { capsule: capsuleAt(KC, rootOf), roots: { [KC]: { index: KC }, [KC - 1]: { index: KC - 1 } } };
    const lineage = { pin: pinIdentity(pinAt(K)), checkpoints: [record(112, { checkpointHash: 'ee'.repeat(32) }), record(111)], capsule };
    await store.save(lineage);
    assert.deepEqual(await store.load(), lineage);
    assert.match(readFileSync(file, 'utf8'), /"checkpoint_hash": "(ee)+"/);
    // A capsule field of another shape is left out, never the checkpoints with it.
    writeFileSync(file, JSON.stringify({ format: 1, pin: lineage.pin, checkpoints: [], capsule: 'x' }));
    assert.deepEqual(await store.load(), { pin: lineage.pin, checkpoints: [] });
    // A checkpoint hash that is not text is not this code's store.
    writeFileSync(file, JSON.stringify({ format: 1, pin: lineage.pin, checkpoints: [{ index: 112, state_root: ROOT, eligible_raw: ELIGIBLE, beacon: ROOT, registry_root: ROOT, checkpoint_hash: 5 }] }));
    assert.equal(await store.load(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A malformed stored checkpoint hash drops that checkpoint only.
  const lc = light(network({ nodes: NODES, top: TOP, stateRootOf: rootOf }), {
    store: memoryCheckpointStore({ pin: pinIdentity(pinAt(K)), checkpoints: [record(112), record(110, { checkpointHash: 'XY' })] }),
  });
  await lc.ready();
  assert.ok(lc.verifiedCheckpoint(112));
  assert.equal(lc.verifiedCheckpoint(110), null);
});

test('the build-time walk and the follower root at a capsule when one is served; a new pin never does', async () => {
  const store = memoryCheckpointStore();
  const net = capsuleNet();
  const r = await walkToHead({ light: capsuleLight(net, { store }), budgetMs: 60_000, pause: noPause });
  assert.deepEqual({ outcome: r.outcome, head: r.head, capsule: r.capsule, highest: r.highest }, { outcome: 'reached', head: CAP_TOP, capsule: { ok: true, index: KC }, highest: CAP_TOP });
  assert.ok(!proofsAsked(net).some((j) => j < KC - 1), 'nothing walked from the pin');
  assert.equal(store.content.capsule.capsule.mb_index, KC);
  // The follower: the capsule first, then both chains to the head from it.
  const followed = capsuleNet();
  const lf = capsuleLight(followed);
  const stop = lf.follow(40);
  for (let i = 0; i < 400 && !(lf.verifiedCheckpoint(CAP_TOP) && lf.verifiedCheckpoint(CAP_TOP - 1)); i++) await sleep(25);
  stop();
  assert.ok(lf.verifiedCheckpoint(CAP_TOP) && lf.verifiedCheckpoint(CAP_TOP - 1));
  assert.equal(lf.heldCapsuleIndex(), KC);
  assert.ok(!proofsAsked(followed).some((j) => j < KC - 1));
  // Near the head the follower asks for no capsule: the walk from its own checkpoints is short.
  const near = network({ nodes: NODES, top: TOP, stateRootOf: rootOf });
  const ln = capsuleLight(near);
  const stopNear = ln.follow(40);
  for (let i = 0; i < 400 && !(ln.verifiedCheckpoint(TOP) && ln.verifiedCheckpoint(TOP - 1)); i++) await sleep(25);
  stopNear();
  assert.ok(!near.asked.some(([, p]) => p === CAPSULE_PATH));
  // A light client holding a capsule gives no new pin.
  const committed = { ...pinAt(K), hash: 'aa'.repeat(32) };
  const holding = capsuleNet();
  const lh = capsuleLight(holding, { pin: committed });
  assert.deepEqual(await lh.refreshCapsule(), { ok: true, index: KC });
  assert.match((await proveNewPin({ light: lh, budgetMs: 60_000, pause: noPause, nodes: NODES, fetchText: holding.fetchText, pin: committed, ...pinRun })).error,
    /holds a capsule: a new pin is walked from the committed pin by committee signatures alone/);
});

test('block 0\'s hash for a pin: every answering node alike, three at least, from the headers route', async () => {
  assert.equal(networkIdOf(block0Body(NETWORK_ID)), NETWORK_ID);
  for (const bad of [{ items: [] }, { items: [{ height: 1, hash: NETWORK_ID }] }, { items: [{ height: 0, hash: 'XY' }] }, null]) assert.equal(networkIdOf(bad), null);
  const with0 = (answers) => network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n, i) => [n, (path, honest) =>
    (path === BLOCK0 ? answers(i) : honest(path))])) });
  const all = with0(() => ({ body: block0Body(NETWORK_ID) }));
  assert.deepEqual(await agreedNetworkId(NODES, all.fetchText), { networkId: NETWORK_ID });
  assert.ok(all.asked.every(([, p]) => p === BLOCK0), 'never /block/0');
  assert.deepEqual(await agreedNetworkId(NODES, with0((i) => ({ body: block0Body(i === 4 ? 'ab'.repeat(32) : NETWORK_ID) })).fetchText),
    { error: 'the nodes disagree on block 0' });
  assert.deepEqual(await agreedNetworkId(NODES, with0((i) => (i < 3 ? 'throw' : { body: block0Body(NETWORK_ID) })).fetchText),
    { error: '2 nodes answered for block 0, 3 needed' });
});
