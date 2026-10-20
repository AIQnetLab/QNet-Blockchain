#!/usr/bin/env node
// The balance check's light client at build time: walks from the checkpoints the store holds, or from the committed pin
// (src/server/light/pin.ts), up to the certified head, every step verified exactly as a request's walk verifies it
// (src/server/light/lineage.ts): the committee from the macroblock two below, its keys bound to that macroblock's
// registry root, a strict quorum of valid ML-DSA-65 votes, the epoch commitment. A GALC v2 capsule the nodes serve
// (src/server/light/galc.ts: four of the five genesis keys, its K and K-1 proven by two nodes each) roots the walk when
// the walk from the store or the pin is long; nodes of today answer 405 and the walk goes from the store or the pin.
// The checkpoints reached, and the capsule, go into the store, so the server started after the build answers at once
// instead of walking thousands of steps first. Nothing is taken on a node's word, and the build writes no tracked file (a
// pull on the host must stay clean).
//
//   node scripts/light-pin.mjs --build      package.json prebuild: skipped under CI or LIGHT_REFRESH=0, bounded by
//                                           LIGHT_REFRESH_BUDGET_S (default 300), never fails the build
//   node scripts/light-pin.mjs              the same walk, unbounded unless --budget-s N; exits 1 short of the head
//   node scripts/light-pin.mjs --write-pin  instead rewrites the pin block of src/server/light/pin.ts with a checkpoint
//                                           --margin N (default 4) below the head, or at --index N (the index the
//                                           wallets pinned, so both pins name one block), walked in that run from the
//                                           committed pin with no store and no capsule, with NETWORK_ID (block 0's
//                                           hash every answering genesis node names, refused when it is not the
//                                           committed one) and GALC_V2_MINT_INTERVAL (--galc-interval N, default
//                                           the committed one)
// --store FILE overrides the store (default LIGHT_STORE_FILE, else data/light-checkpoints.json).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
// A flag given without its value stops the run: it never falls back to the default unnoticed.
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  if (args[i + 1] === undefined || args[i + 1].startsWith('--')) finish(1, `--${name} needs a value`);
  return args[i + 1];
};
const build = flag('build');
const say = (line) => console.log(`[light-pin] ${line}`);
// A build goes on whatever happens here: the server walks from the store or the pin itself.
const finish = (code, line) => {
  (code === 0 ? console.log : console.error)(`[light-pin] ${line}`);
  process.exit(build ? 0 : code);
};

if (build && (process.env.CI || process.env.LIGHT_REFRESH === '0')) finish(0, 'skipped (CI or LIGHT_REFRESH=0)');

// The light client is TypeScript: run again with type stripping unless it is on already.
if (!process.features?.typescript && !process.env.LIGHT_PIN_CHILD) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 6)) finish(1, `Node.js ${process.versions.node} cannot load the light client (22.6 or later)`);
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    fileURLToPath(import.meta.url), ...args],
    { stdio: 'inherit', env: { ...process.env, LIGHT_PIN_CHILD: '1' } });
  process.exit(build ? 0 : (child.status ?? 1));
}

const number = (name, fallback) => {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) finish(1, `--${name} needs a number`);
  return v;
};

async function main() {
  const { createLightClient } = await import('../src/server/light/lineage.ts');
  const { fetchText } = await import('../src/server/light/balance-proof.ts');
  const { defaultStorePath, fileCheckpointStore } = await import('../src/server/light/store.ts');
  const { proveNewPin, replacePinBlock, walkToHead, PIN_MARGIN } = await import('../src/server/light/refresh.ts');
  const { GALC_V2_MINT_INTERVAL, NETWORK_ID, WS_CHECKPOINT } = await import('../src/server/light/pin.ts');
  const { GENESIS_NODES } = await import('../src/lib/genesis-nodes.ts');

  const budgetS = number('budget-s', build ? Number(process.env.LIGHT_REFRESH_BUDGET_S || 300) : Number.POSITIVE_INFINITY);
  const storePath = option('store') ?? defaultStorePath();
  const nodes = GENESIS_NODES;
  const t0 = Date.now();
  const budgetMs = Number.isFinite(budgetS) ? budgetS * 1000 : Number.MAX_SAFE_INTEGER;
  const budgetText = Number.isFinite(budgetS) ? `${budgetS} s` : 'none';
  // 120 reads a minute per node: the running site keeps its own 180 of the 300 a node allows one address. Twelve proofs
  // asked ahead per chain: a long walk is bound by the nodes' answer time, not by that budget.
  const client = (store, capsules) => createLightClient({ nodes: () => nodes, fetchText, store, capsules, readsPerMinute: 120, prefetch: 12 });

  if (flag('write-pin')) {
    // A committed pin is walked from the committed pin in this run, the store neither read nor written and no capsule
    // taken: a pin shipped to every host rests on the pin before it, never on one machine's file or a shortcut.
    const fresh = client(undefined, false);
    const galcInterval = number('galc-interval', GALC_V2_MINT_INTERVAL);
    say(`walking from pin ${WS_CHECKPOINT.index}, no store, no capsule (budget ${budgetText})`);
    const r = await proveNewPin({ light: fresh, budgetMs, margin: number('margin', PIN_MARGIN), index: number('index', undefined), nodes, fetchText,
      pin: WS_CHECKPOINT, networkId: NETWORK_ID, galcInterval });
    if ('error' in r) finish(1, `no new pin: ${r.error} (highest verified ${fresh.highestVerifiedIndex()})`);
    const file = fileURLToPath(new URL('../src/server/light/pin.ts', import.meta.url));
    const next = replacePinBlock(readFileSync(file, 'utf8'), r.block);
    if (next === null) finish(1, 'pin.ts has no <ws-pin> block');
    writeFileSync(file, next);
    finish(0, `pin ${r.index} written to src/server/light/pin.ts, proven from ${WS_CHECKPOINT.index} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }

  const light = client(fileCheckpointStore(storePath), true);
  say(`walking from pin ${WS_CHECKPOINT.index}, the store ${storePath} or a capsule (budget ${budgetText})`);
  const r = await walkToHead({ light, budgetMs });
  const capsule = r.capsule === null ? 'not asked' : r.capsule.ok ? `rooted at ${r.capsule.index}` : r.capsule.reason;
  const line = `${r.outcome}: certified head ${r.head ?? 'unknown'}, verified ${r.highestBefore} -> ${r.highest}, capsule ${capsule}, `
    + `in ${Math.round((Date.now() - t0) / 1000)} s`;
  finish(r.outcome === 'reached' ? 0 : 1, line);
}

main().catch((e) => finish(1, `failed: ${e instanceof Error ? e.message : String(e)}`));
