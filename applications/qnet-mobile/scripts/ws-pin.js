#!/usr/bin/env node
/**
 * Generates WS_CHECKPOINT, the weak-subjectivity pin in src/config/genesisConsensus.js, from the live chain.
 * Refresh it for every release (see README.md, "Release: refresh the light-client pin").
 *
 * Why: the phone proves a balance by walking each macroblock's committee lineage up from a trusted root.
 * Rooted at genesis that walk is idx/2 proofs long, and nodes prune old committee signatures, so an unpinned
 * phone never verifies anything. The pin roots the walk at a recent macroblock K.
 *
 * What it trusts (MOBNET-R4-07): the pin committed now, and nothing it is told at release time. The walk starts at
 * that pin's anchors and verifies every macroblock from it up to K exactly as the phone verifies it
 * (src/crypto/QcLightClient): committee derived from the macroblock two below, committee keys bound to that
 * macroblock's QC-signed registry_root, at least a quorum of distinct valid ML-DSA-65 votes, and the epoch
 * commitment. So whoever answers for the genesis names at release time (a DNS or TLS-terminator compromise, a
 * compromised HTTP layer) cannot root the new pin in keys of their own: they would have to forge committee votes
 * that verify from the previous pin. The new pin records which pin it was proven from (`provenFrom`), and the
 * release check (scripts/release-check.js) refuses a pin without that link. The five genesis names are asked over
 * HTTPS (read-only GETs), and every node that answers (at least --quorum of the five) must serve identical data for
 * each macroblock too: the recomputed checkpoint hash, eligible producers, ban list, and (for K) MacroBlock::hash.
 * One proof per macroblock, so a pin more than a few days old takes a while; refresh it for every release, and
 * within the nodes' signature retention (about 15 days), or the old signatures are gone.
 *
 * --bootstrap is for a chain that has no committed pin to prove from (or one that can no longer be walked): the
 * base anchors K-W-1 and K-W are then taken from genesis-node agreement alone, the W macroblocks above them are
 * verified from there, and the pin is written with `provenFrom: null`, which the release check refuses unless it is
 * told the release is a bootstrap (release-check.js --allow-bootstrap). It trusts the genesis names at release time.
 *
 * Usage, from applications/qnet-mobile:
 *   node scripts/ws-pin.js           print the pin, proven from the committed one
 *   node scripts/ws-pin.js --write   and rewrite WS_CHECKPOINT in src/config/genesisConsensus.js
 * Options: --margin N (macroblocks below the lowest head, default 4)
 *          --quorum N (answering genesis nodes required, default 4)
 *          --bootstrap [--window N (default 64)]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src') + path.sep;
const CONFIG = path.join(ROOT, 'src', 'config', 'genesisConsensus.js');
const MACROBLOCK_INTERVAL = 90;
const TIMEOUT_MS = 20000;

// The light client is ES-module source for Metro; compile it for Node on the fly, and hand its native
// ML-DSA import a noble verifier (the same substitution the extension bundle makes).
const SHIM_ID = 'qnet-ws-pin:dilithium';
let mlDsa65 = null;
Module._cache[SHIM_ID] = {
  id: SHIM_ID, filename: SHIM_ID, loaded: true,
  exports: {
    verifyDilithium: async (message, sigHex, pkHex) => {
      try {
        return mlDsa65.verify(Buffer.from(sigHex, 'hex'), Buffer.from(message, 'utf8'), Buffer.from(pkHex, 'hex'));
      } catch (_) {
        return false;
      }
    },
  },
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.startsWith(SRC) && /(^|\/)DilithiumCrypto$/.test(request)) return SHIM_ID;
  return resolve.call(this, request, parent, ...rest);
};
const loadJs = Module._extensions['.js'];
Module._extensions['.js'] = function (module, filename) {
  if (!filename.startsWith(SRC)) return loadJs(module, filename);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
  });
  module._compile(code, filename);
};

const lc = require('../src/crypto/QcLightClient');
const { GENESIS_NODES_HTTPS } = require('../src/config/nodes');
const { WS_CHECKPOINT: CURRENT_PIN } = require('../src/config/genesisConsensus');
const { sha3_256 } = require('js-sha3');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isInteger(v) || v < 0) throw new Error(`--${name} needs a whole number`);
  return v;
}
const flag = (name) => process.argv.includes(`--${name}`);

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function fail(msg) {
  throw new Error(msg);
}

// Everything about macroblock j the phone relies on, as one comparable string.
function proofFingerprint(j, proof) {
  if (!proof || proof.error) fail(`macroblock ${j}: ${proof ? proof.error : 'no answer'}`);
  const cp = proof.checkpoint;
  if (proof.index !== j || !cp || Math.floor((cp.window_head_height || 0) / MACROBLOCK_INTERVAL) !== j) {
    fail(`macroblock ${j}: the proof is for another index`);
  }
  return [lc.checkpointHash(cp), proof.eligible_raw || '', JSON.stringify(proof.banned || [])].join('|');
}

// MacroBlock::hash (core/qnet-state block.rs): SHA3-256(height ‖ timestamp ‖ previous_hash ‖ state_root ‖
// micro_blocks), u64 little-endian. `height` of a macroblock is its index.
function macroblockHash(mb) {
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const hex32 = (h) => {
    if (!/^[0-9a-f]{64}$/.test(String(h))) fail('malformed macroblock hash field');
    return Buffer.from(h, 'hex');
  };
  return sha3_256(Buffer.concat([
    u64(mb.height), u64(mb.timestamp), hex32(mb.previous_hash), hex32(mb.state_root),
    ...(mb.micro_blocks || []).map(hex32),
  ]));
}

// One answer every responding genesis node agrees on, or a failure naming the disagreement.
async function agreed(nodes, what, pathOf, fingerprint) {
  const answers = await Promise.all(nodes.map((n) => getJson(n + pathOf).then((v) => ({ n, v }), (e) => ({ n, e }))));
  const ok = answers.filter((a) => !a.e);
  if (ok.length < nodes.length) {
    fail(`${what}: ${answers.filter((a) => a.e).map((a) => `${a.n} (${a.e.message})`).join(', ')} did not answer`);
  }
  const prints = ok.map((a) => fingerprint(a.v));
  if (new Set(prints).size !== 1) fail(`${what}: the genesis nodes disagree`);
  return ok[0].v;
}

async function verifyQc(proof, committee, pubkeys, quorum) {
  const message = 'QNET_BFT2_VOTE:' + lc.checkpointHash(proof.checkpoint);
  const members = new Set(committee);
  const valid = new Set();
  const signers = (proof.qc && proof.qc.signers) || [];
  const sigs = (proof.qc && proof.qc.sigs) || [];
  if (signers.length !== sigs.length) return false;
  for (let i = 0; i < signers.length && valid.size < quorum; i++) {
    const s = signers[i];
    if (!members.has(s) || valid.has(s) || !pubkeys[s]) continue;
    const sig = lc.parseDilithiumSig(sigs[i]);
    if (sig && await Module._cache[SHIM_ID].exports.verifyDilithium(message, sig, pubkeys[s])) valid.add(s);
  }
  return valid.size >= quorum;
}

// Verifies macroblock j as the phone does, from the anchor two below; returns j's own anchor.
async function verifyStep(j, proof, anchorBelow, registryNode) {
  const committee = lc.sampleCommittee([...anchorBelow.eligibleIds].sort(), j, anchorBelow.beacon);
  const quorum = lc.checkpointQuorum(proof.checkpoint, committee);
  if (quorum == null) fail(`macroblock ${j}: carries a recovery anchor`);
  const pubkeys = await lc.resolvePubkeys(committee, anchorBelow.registryRoot, (j - 2) * MACROBLOCK_INTERVAL,
    proof.committee_pubkeys || {}, (h) => getJson(`${registryNode}/api/v1/registry/height/${h}`), quorum);
  if (!pubkeys) fail(`macroblock ${j}: committee keys do not bind to the registry of macroblock ${j - 2}`);
  if (!(await verifyQc(proof, committee, pubkeys, quorum))) fail(`macroblock ${j}: fewer than ${quorum} valid committee votes`);
  const eligible = Buffer.from(proof.eligible_raw || '', 'hex');
  if (lc.epochCommitment(eligible, committee, proof.banned || []) !== proof.checkpoint.epoch_commitment) {
    fail(`macroblock ${j}: epoch commitment mismatch`);
  }
  return anchorOf(proof);
}

function anchorOf(proof) {
  const ids = lc.decodeEligibleNodeIds(Buffer.from(proof.eligible_raw || '', 'hex'));
  if (!ids.length) fail(`macroblock ${proof.index}: no eligible producers`);
  return { eligibleIds: ids, beacon: proof.checkpoint.beacon, registryRoot: proof.checkpoint.registry_root, proof };
}

// `provenFrom`: { index, hash } of the pin this one was proven from, or null for a bootstrap pin.
function renderPin(k, hash, anchors, note, provenFrom) {
  const entry = (i) => {
    const p = anchors[i].proof;
    return [
      `    ${i}: {`,
      `      eligible_raw: '${p.eligible_raw}',`,
      `      beacon: '${p.checkpoint.beacon}',`,
      `      registry_root: '${p.checkpoint.registry_root}',`,
      '    },',
    ].join('\n');
  };
  return [
    '// <ws-pin>',
    `// ${note}`,
    'export const WS_CHECKPOINT = {',
    `  index: ${k},`,
    `  hash: '${hash}',`,
    provenFrom ? `  provenFrom: { index: ${provenFrom.index}, hash: '${provenFrom.hash}' },` : '  provenFrom: null,',
    '  anchors: {',
    entry(k),
    entry(k - 1),
    '  },',
    '};',
    '// </ws-pin>',
  ].join('\n');
}

async function main() {
  const windowSize = arg('window', 64);
  const margin = arg('margin', 4);
  const quorum = arg('quorum', 4);
  // Proven from the committed pin unless a bootstrap is asked for by name (MOBNET-R4-07).
  const bootstrap = flag('bootstrap');
  const fromCurrent = !bootstrap;
  ({ ml_dsa65: mlDsa65 } = await import('@noble/post-quantum/ml-dsa.js'));

  const heights = await Promise.all(GENESIS_NODES_HTTPS.map((n) =>
    getJson(`${n}/api/v1/height`).then((r) => ({ n, h: Number(r.height) }), () => ({ n, h: NaN }))));
  const nodes = heights.filter((x) => Number.isSafeInteger(x.h) && x.h > 0).map((x) => x.n);
  if (nodes.length < quorum) fail(`only ${nodes.length} genesis nodes answered; --quorum is ${quorum}`);
  const head = Math.min(...heights.filter((x) => nodes.includes(x.n)).map((x) => x.h));
  const k = Math.floor(head / MACROBLOCK_INTERVAL) - margin;

  let base;
  const anchors = {};
  if (fromCurrent) {
    if (!(CURRENT_PIN.index > 0) || !lc.wsPinIsWellformed()) {
      fail('no well-formed pin is committed to prove the new one from; a first pin needs --bootstrap');
    }
    base = CURRENT_PIN.index;
    if (base + 2 > k) fail(`the committed pin ${base} is not two macroblocks below the new one ${k}: nothing to refresh`);
    for (const i of [base, base - 1]) {
      const a = CURRENT_PIN.anchors[i];
      anchors[i] = {
        eligibleIds: lc.decodeEligibleNodeIds(Buffer.from(a.eligible_raw, 'hex')),
        beacon: a.beacon, registryRoot: a.registry_root, proof: null,
      };
    }
  } else {
    base = k - windowSize;
    if (base < 3) fail('the chain is too young for a pin');
    for (const i of [base - 1, base]) {
      anchors[i] = anchorOf(await agreed(nodes, `macroblock ${i}`, `/api/v1/macroblock/${i}/proof`, (v) => proofFingerprint(i, v)));
    }
  }

  for (let j = base + 1; j <= k; j++) {
    const proof = await agreed(nodes, `macroblock ${j}`, `/api/v1/macroblock/${j}/proof`, (v) => proofFingerprint(j, v));
    anchors[j] = await verifyStep(j, proof, anchors[j - 2], nodes[j % nodes.length]);
    delete anchors[j - 2];
    if ((j - base) % 16 === 0 || j === k) process.stderr.write(`verified ${j - base}/${k - base}\r`);
  }
  process.stderr.write('\n');

  const mb = await agreed(nodes, `macroblock ${k} header`, `/api/v1/macroblock/${k}`, macroblockHash);
  const hash = macroblockHash(mb);
  const note = `Generated by scripts/ws-pin.js on ${new Date().toISOString().slice(0, 10)} from ${nodes.length} genesis nodes `
    + `(head ${head}; ${k - base} macroblocks QC-verified${fromCurrent
      ? ` from the previous pin ${base}` : '; bootstrap: base anchors from genesis-node agreement'}).`;
  const block = renderPin(k, hash, anchors, note, fromCurrent ? { index: base, hash: CURRENT_PIN.hash } : null);

  if (flag('write')) {
    const src = fs.readFileSync(CONFIG, 'utf8');
    const re = /\/\/ <ws-pin>[\s\S]*?\/\/ <\/ws-pin>/;
    if (!re.test(src)) fail('genesisConsensus.js has no <ws-pin> markers');
    fs.writeFileSync(CONFIG, src.replace(re, block));
    console.log(`WS_CHECKPOINT = ${k} written to src/config/genesisConsensus.js`);
  } else {
    console.log(block);
  }
}

main().catch((e) => {
  console.error(`ws-pin: ${e.message}`);
  process.exit(1);
});
