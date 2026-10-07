// Shared test helpers: the app's known answers, a local mock node, the built command line, and a small builder of
// WebAssembly modules. Fixtures under fixtures/ are answers recorded from the public testnet nodes with GET
// requests (2026-09-25): account.json, balproof.json, tx.json, height.json. Shapes of POST answers and of routes with
// no live example (deploy, token) are the node handlers' own (development/qnet-integration/src/rpc), noted where used.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const CLI = path.resolve(HERE, '../dist/cli.js');

export const V = JSON.parse(readFileSync(path.join(ROOT, 'applications/qnet-mobile/src/crypto/__vectors__/tx-vectors.json'), 'utf8'));
export const vector = (name) => V.vectors.find((v) => v.name === name);
export const fixture = (name) => readFileSync(path.join(HERE, 'fixtures', name), 'utf8');

// A password the wallets' new-password rule accepts (at least 8 characters).
export const STRONG_PASSWORD = 'Wz9#qTr4@Lm2xKp7!';

export const tempHome = () => mkdtemp(path.join(os.tmpdir(), 'qnet-sdk-test-'));

/**
 * The mobile light client's own source, bundled into a module of its own (so its memory is not the SDK's), for tests
 * that serve checkpoints signed by a committee of test keys: its checkpoint hash, epoch commitment, registry root and
 * trust floor. As in build.mjs, packages come from this package's lockfile and DilithiumCrypto is the wallet core's
 * shim.
 */
export async function lightClientSource() {
  const { build } = await import('esbuild');
  const SDK = path.resolve(HERE, '..');
  const shim = path.join(ROOT, 'applications/qnet-wallet/tools/crypto-bundle/src/shims/DilithiumCrypto.js');
  const out = await build({
    entryPoints: [path.join(ROOT, 'applications/qnet-mobile/src/crypto/QcLightClient.js')],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    plugins: [{
      name: 'sdk-resolution',
      setup(b) {
        b.onResolve({ filter: /^\.\/DilithiumCrypto(\.js)?$/ }, () => ({ path: shim }));
        b.onResolve({ filter: /^[^./]/ }, (a) => (a.pluginData?.fromSdk || a.path === 'buffer' ? undefined
          : b.resolve(a.path, { kind: a.kind, resolveDir: SDK, pluginData: { fromSdk: true } })));
      },
    }],
  });
  const file = path.join(await tempHome(), 'qc-light-client.mjs');
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

/**
 * A checkpoint lineage above the release's anchor, signed by a committee of one test key (ML-DSA-65), for walks the
 * SDK's own light client verifies. `base` is the first macroblock of it, `anchor(j)` macroblock j as a kept checkpoint
 * that an anchors store hands the client (trusted like the release's anchor, so a walk can start there), `proof(j)` its
 * proof as a node serves it, `event(j)` an event whose logs root is macroblock j's, and `route(request, servedUpTo)`
 * the mock node's answers: proofs up to `servedUpTo`, the registry snapshot, and log proofs of the events made.
 */
export async function testLineage() {
  const lc = await lightClientSource();
  const { ml_dsa65 } = await import('@noble/post-quantum/ml-dsa.js');
  const { sha3_256 } = await import('@noble/hashes/sha3.js');
  const { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } = await import('@noble/hashes/utils.js');
  const { logLeaf } = await import('../dist/node.js');
  const ID = 'test_committee_node';
  const keys = ml_dsa65.keygen(new Uint8Array(32).fill(9));
  const entries = [{
    node_id: ID, wallet: `w_${ID}`, reg_height: 90, reg_index: 0, node_type: 'super', burn: '',
    vrf_pk_sha3: bytesToHex(sha3_256(keys.publicKey)),
  }];
  const registryRoot = lc.recomputeRegistryRoot(entries);
  const beacon = 'bb'.repeat(32);
  // bincode Vec<EligibleProducer { node_id, reputation: u32 }>
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const eligible = Buffer.concat([u64(1), u64(ID.length), Buffer.from(ID), Buffer.alloc(4, 0x58)]).toString('hex');
  const contract = vector('tokenTransfer').input.token;
  const byTx = new Map();
  const event = (j) => {
    const txHash = bytesToHex(sha3_256(utf8ToBytes(`event at macroblock ${j}`)));
    const leaf = logLeaf(txHash, 0, contract, hexToBytes('ab'));
    const blockRoot = bytesToHex(sha3_256(concatBytes(utf8ToBytes('log-leaf'), hexToBytes(leaf))));
    const logsRoot = bytesToHex(sha3_256(concatBytes(utf8ToBytes('logw-leaf'), hexToBytes(blockRoot))));
    const e = { j, txHash, logIndex: 0, contract, data: 'ab', leaf, blockRoot, logsRoot };
    byTx.set(txHash, e);
    return e;
  };
  const proofs = new Map();
  const proof = (j) => {
    if (!proofs.has(j)) {
      const cp = {
        index: j, parent_qc: null, window_head_height: j * 90, window_mb_hashes: [], state_root: '00'.repeat(32), beacon,
        epoch_commitment: lc.epochCommitment(hexToBytes(eligible), [ID], []), reward_root: '00'.repeat(32),
        registry_root: registryRoot, logs_root: event(j).logsRoot, dilithium_pk_root: '00'.repeat(32),
        reward_epoch_root: '00'.repeat(32), total_supply: '0', timestamp: 0, proposer: ID, recovery_anchor: null,
      };
      const sig = ml_dsa65.sign(utf8ToBytes(`QNET_BFT2_VOTE:${lc.checkpointHash(cp)}`), keys.secretKey);
      const len = Buffer.alloc(4);
      len.writeUInt32LE(sig.length);
      const signed = Buffer.concat([len, Buffer.from(sig)]);
      proofs.set(j, {
        index: j, checkpoint: cp, eligible_raw: eligible, banned: [], committee_pubkeys: { [ID]: bytesToHex(keys.publicKey) },
        qc: { signers: [ID], sigs: [`dilithium_sig_${ID}_${signed.toString('base64')}`] },
      });
    }
    return proofs.get(j);
  };
  const route = (r, servedUpTo = Infinity) => {
    const m = /^\/api\/v1\/macroblock\/(\d+)\/proof$/.exec(r.path);
    if (m) return Number(m[1]) <= servedUpTo ? { json: proof(Number(m[1])) } : undefined;
    if (r.path.startsWith('/api/v1/registry/height/')) return { json: { entries } };
    if (r.path === '/api/v1/logs/proof') {
      const e = byTx.get(r.query.get('tx_hash'));
      if (!e) return undefined;
      return { json: { leaf: e.leaf, proof: [], block_root: e.blockRoot, window_proof: [], logs_root: e.logsRoot, window_end: e.j * 90 } };
    }
    return undefined;
  };
  const anchor = (j) => ({ [j]: { eligible_ids: [ID], beacon, registry_root: registryRoot } });
  // Far enough above the release's anchor that nothing of the real lineage is near.
  return { base: lc.trustFloorIndex() + 1000, anchor, proof, event, route };
}

export const TEMPLATES = path.join(ROOT, 'contracts/target/wasm32-unknown-unknown/release');
export const template = (name) => {
  const file = path.join(TEMPLATES, name);
  return existsSync(file) ? file : null;
};

/** Runs the built command line with `input` on standard input (not a terminal). */
export function runCli(args, { input = '', env = {} } = {}) {
  const childEnv = { ...process.env, ...env };
  if (!('QNET_HOME' in env)) delete childEnv.QNET_HOME;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: childEnv, timeout: 120_000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * A local HTTP server standing in for a node. `route(req)` returns {json} | {text, status} | undefined (404);
 * every request is recorded with its method, path, query, headers and body.
 */
export async function mockNode(route) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://127.0.0.1');
    const entry = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    requests.push(entry);
    let out;
    try {
      out = await route(entry);
    } catch (error) {
      out = { status: 500, text: String(error) };
    }
    if (!out) out = { status: 404, text: 'not found' };
    const text = out.text ?? (typeof out.json === 'string' ? out.json : JSON.stringify(out.json));
    res.writeHead(out.status ?? 200, { 'content-type': out.text !== undefined ? 'text/plain' : 'application/json' });
    res.end(text);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---- WebAssembly modules byte by byte ----

export const leb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const name = (s) => [...leb(Buffer.byteLength(s)), ...Buffer.from(s)];
const vec = (items) => [...leb(items.length), ...items.flat()];
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
const I32 = 0x7f;
const I64 = 0x7e;
export const T = { i32: I32, i64: I64, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70 };

/**
 * A module from parts; the defaults make the smallest valid contract: memory 1..1 exported as "memory" and one
 * entry "run" that does nothing. `bodies` are instruction bytes (an `end` is added); `sections` adds raw
 * [id, bytes] sections, placed in the binary's section order.
 */
export function wasmModule({
  types = [[[], []]],
  imports = [],
  funcs = [0],
  tables = [],
  memory = [1, 1],
  memories = null,
  globals = [],
  exports = [['memory', 0x02, 0], ['run', 0x00, 0]],
  bodies = null,
  locals = [],
  data = [],
  sections = [],
} = {}) {
  const parts = [];
  parts.push([1, vec(types.map(([p, r]) => [0x60, ...vec(p.map((t) => [t])), ...vec(r.map((t) => [t]))]))]);
  if (imports.length) parts.push([2, vec(imports.map(([m, n, desc]) => [...name(m), ...name(n), ...desc]))]);
  if (funcs.length) parts.push([3, vec(funcs.map((t) => leb(t)))]);
  if (tables.length) parts.push([4, vec(tables)]);
  const mems = memories ?? (memory ? [memory] : []);
  if (mems.length) parts.push([5, vec(mems.map((m) => (m.length === 2 ? [0x01, ...leb(m[0]), ...leb(m[1])] : [0x00, ...leb(m[0])])))]);
  if (globals.length) parts.push([6, vec(globals)]);
  if (exports.length) parts.push([7, vec(exports.map(([n, kind, index]) => [...name(n), kind, ...leb(index)]))]);
  const code = (bodies ?? funcs.map(() => [])).map((instr) => {
    const body = [...vec(locals.map(([count, type]) => [...leb(count), type])), ...instr, 0x0b];
    return [...leb(body.length), ...body];
  });
  if (funcs.length) parts.push([10, vec(code)]);
  if (data.length) parts.push([11, vec(data)]);
  parts.push(...sections);
  const ORDER = [1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11, 0];
  parts.sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...parts.flatMap(([id, bytes]) => section(id, bytes))]);
}

export const customSection = (label, size) => [0, [...name(label), ...new Array(size).fill(0)]];
