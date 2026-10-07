// A scripted network that certifies its state for real. A committee of one ML-DSA-65 key signs each macroblock's
// checkpoint, whose state root is the root of a reference state tree built here the way the node builds its tree
// (buckets of the leading 40 key bits, 40 tree levels above them), and the pinned nodes serve certified account and token
// proofs (proof_format 2) against it, or, for a node marked old, the older live-root body that ignores the `mb` query.
// The light client the bundle compiles verifies every step itself: the macroblocks two below the first one are imported
// as anchors an earlier session kept (install), so its walk starts there.
import { existsSync } from 'node:fs';
import * as core from '../../dist/lib/qnet-core.js';
import { QNET } from '../../dist/background/config.js';

const NOBLE = new URL('../../tools/crypto-bundle/node_modules/@noble/post-quantum/ml-dsa.js', import.meta.url);
/** Whether the bundle's own ML-DSA-65 library is installed (npm run bundle:install): the committee signs with it. */
export const NOBLE_INSTALLED = existsSync(NOBLE);
const { ml_dsa65: mlDsa } = NOBLE_INSTALLED ? await import(NOBLE.href) : {};

/** The first macroblock a net certifies: above the release's weak-subjectivity pin, so the walk starts at our anchors. */
export const FIRST_INDEX = core.trustFloorIndex() + 4000;
export const ZERO = '00'.repeat(32);

const utf8 = (text) => new TextEncoder().encode(text);
const H2 = (a, b) => core.sha3_256Hex(core.concatBytes(core.hexToBytes(a), core.hexToBytes(b)));
const DEFAULTS = [ZERO];
for (let d = 1; d <= 256; d++) DEFAULTS.push(H2(DEFAULTS[d - 1], DEFAULTS[d - 1]));
const bitOf = (key, i) => (parseInt(key.substr((i >> 3) * 2, 2), 16) >> (7 - (i % 8))) & 1;
const tagged = (k, v) => core.sha3_256Hex(core.hexToBytes(`b5${k}${v}`));
const fold = (level) => {
  let cur = level;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? H2(cur[i], cur[i + 1]) : cur[i]);
    cur = next;
  }
  return cur[0];
};
const sorted = (entries) => [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1));

// The hash of the subtree at `depth` holding `entries` (all sharing its prefix).
function nodeHash(entries, depth) {
  if (depth === 216) return entries.length ? fold(sorted(entries).map(([k, v]) => tagged(k, v))) : DEFAULTS[216];
  if (entries.length === 0) return DEFAULTS[depth];
  const split = 256 - depth;
  return H2(nodeHash(entries.filter(([k]) => bitOf(k, split) === 0), depth - 1),
    nodeHash(entries.filter(([k]) => bitOf(k, split) === 1), depth - 1));
}

/**
 * A reference state tree over [keyHex, leafHex] entries: {root, prove(key)} where prove gives {kind, steps, entries}
 * exactly as the node's prover does (inclusion, absence, absence_in_bucket).
 */
export function stateTree(entries) {
  const all = sorted(entries);
  const root = nodeHash(all, 256);
  const prove = (key) => {
    const bucket = all.filter(([k]) => k.slice(0, 10) === key.slice(0, 10));
    const steps = [];
    const at = bucket.findIndex(([k]) => k === key);
    if (at >= 0) {
      let level = bucket.map(([k, v]) => tagged(k, v));
      let idx = at;
      while (level.length > 1) {
        if ((idx ^ 1) < level.length) steps.push({ sibling: level[idx ^ 1], is_right: (idx & 1) === 1 });
        const next = [];
        for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? H2(level[i], level[i + 1]) : level[i]);
        level = next;
        idx = Math.floor(idx / 2);
      }
    }
    for (let depth = 216; depth < 256; depth++) {
      // the sibling subtree at `depth`: the key's leading 256 - depth bits with the last of them flipped
      const own = 255 - depth;
      const sib = all.filter(([k]) => {
        for (let i = 0; i < own; i++) if (bitOf(k, i) !== bitOf(key, i)) return false;
        return bitOf(k, own) !== bitOf(key, own);
      });
      steps.push({ sibling: nodeHash(sib, depth), is_right: bitOf(key, own) === 1 });
    }
    const kind = at >= 0 ? 'inclusion' : (bucket.length ? 'absence_in_bucket' : 'absence');
    return { kind, steps, entries: at < 0 && bucket.length ? bucket.map(([k, v]) => ({ key: k, leaf: v })) : undefined };
  };
  return { root, prove };
}

/** Every leaf field of an account, zero where not given. */
export const accountFields = (fields = {}) => ({
  balance: '0', nonce: '0', is_contract: false, contract_code_hash: null, storage_root: null, heartbeat_epoch: '0',
  heartbeat_slots: 0, heartbeat_final_epoch: '0', heartbeat_final_slots: 0, last_claimed_epoch: '0', banned_at_height: '0',
  is_node: false, ...fields,
});

// ---------------------------------------------------------------- the committee

const MEMBER = 'node_a';
const keypair = NOBLE_INSTALLED ? core.deriveQnetKeypair(new Uint8Array(64).fill(7)) : null;
const ENTRIES = keypair === null ? [] : [{
  node_id: MEMBER, wallet: null, reg_height: 0, reg_index: 0, burn: null, node_type: 'super', vrf_pk_sha3: core.sha3_256Hex(keypair.publicKey),
}];
const REGISTRY_ROOT = keypair === null ? ZERO : core.recomputeRegistryRoot(ENTRIES);
const BEACON = '11'.repeat(32);
// bincode Vec<EligibleProducer{node_id, reputation: u32}> of the one member
const ELIGIBLE_RAW = (() => {
  const id = utf8(MEMBER);
  const out = new Uint8Array(8 + 8 + id.length + 4);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, 1n, true);
  view.setBigUint64(8, BigInt(id.length), true);
  out.set(id, 16);
  view.setUint32(16 + id.length, 70, true);
  return out;
})();
const EPOCH_COMMITMENT = core.epochCommitment(ELIGIBLE_RAW, [MEMBER], []);
const signatures = new Map(); // checkpoint hash -> QC signature string

// The QC signature string as nodes serve it: "dilithium_sig_<id>_" + base64([u32LE len][detached sig][msg]).
function qcSig(checkpointHashHex) {
  if (signatures.has(checkpointHashHex)) return signatures.get(checkpointHashHex);
  const vote = utf8(`QNET_BFT2_VOTE:${checkpointHashHex}`);
  const detached = mlDsa.sign(vote, keypair.secretKey);
  const payload = new Uint8Array(4 + detached.length + vote.length);
  new DataView(payload.buffer).setUint32(0, detached.length + vote.length, true);
  payload.set(detached, 4);
  payload.set(vote, 4 + detached.length);
  const sig = `dilithium_sig_${MEMBER}_${core.base64Encode(payload)}`;
  signatures.set(checkpointHashHex, sig);
  return sig;
}

// The served proof of macroblock `index` whose checkpoint commits `stateRoot`, signed by the committee.
function macroblockProof(index, stateRoot) {
  const checkpoint = {
    index, window_head_height: index * 90, window_mb_hashes: [], state_root: stateRoot, beacon: BEACON, epoch_commitment: EPOCH_COMMITMENT,
    reward_root: ZERO, registry_root: REGISTRY_ROOT, logs_root: ZERO, dilithium_pk_root: ZERO, reward_epoch_root: ZERO, total_supply: 0,
    timestamp: 0, proposer: MEMBER, recovery_anchor: null,
  };
  return {
    index, checkpoint, eligible_raw: core.bytesToHex(ELIGIBLE_RAW), banned: [],
    committee_pubkeys: { [MEMBER]: core.bytesToHex(keypair.publicKey) },
    qc: { signers: [MEMBER], sigs: [qcSig(core.checkpointHash(checkpoint))] },
  };
}

// ---------------------------------------------------------------- the state

const addrKey = (address) => core.accountKeyHash(address);
const balanceKey = (holder) => core.storageKeyHash(`balance:${holder}`);
// JSON text in which every value wrapped by num() is written as a bare number literal, exactly (a u64 past 2^53 too).
const num = (value) => ({ numberLiteral: String(value) });
export const jsonText = (body) => JSON.stringify(body, (key, value) => (value && typeof value === 'object' && 'numberLiteral' in value
  ? `<<num:${value.numberLiteral}>>` : value)).replace(/"<<num:(\d+)>>"/g, '$1');
const json = (body, status = 200, headers = {}) => new Response(jsonText(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// One certified state: {index, root, tree, accounts, tokens, storage} with every account's full fields.
function buildState(index, accounts, tokens) {
  const fieldsOf = new Map();
  const storage = new Map();
  for (const [address, fields] of Object.entries(accounts)) fieldsOf.set(address, accountFields(fields));
  for (const [contract, token] of Object.entries(tokens)) {
    const holders = Object.entries(token.holders ?? {}).filter(([, amount]) => amount !== '0');
    const tree = stateTree([
      ...holders.map(([holder, amount]) => [balanceKey(holder), core.storageLeafValue(amount)]),
      [core.storageKeyHash('total_supply'), core.storageLeafValue('1000000000000')],
    ]);
    storage.set(contract, { tree, holders: Object.fromEntries(holders) });
    fieldsOf.set(contract, accountFields({ ...token.account, is_contract: true, contract_code_hash: token.codeHash ?? 'c0de'.repeat(16), storage_root: tree.root }));
  }
  const tree = stateTree([...fieldsOf].map(([address, fields]) => [addrKey(address), core.certifiedAccountLeafHash(address, fields)]));
  return { index, root: tree.root, tree, fieldsOf, storage };
}

// The account fields as a certified body writes them (u64 as decimal text, the slots as numbers).
const bodyFields = (f, prefix = '') => ({
  [`${prefix}balance`]: String(f.balance), [`${prefix}nonce`]: String(f.nonce), heartbeat_epoch: String(f.heartbeat_epoch),
  heartbeat_slots: f.heartbeat_slots, heartbeat_final_epoch: String(f.heartbeat_final_epoch), heartbeat_final_slots: f.heartbeat_final_slots,
  last_claimed_epoch: String(f.last_claimed_epoch), banned_at_height: String(f.banned_at_height), is_contract: f.is_contract,
  is_node: f.is_node, contract_code_hash: f.contract_code_hash, storage_root: f.storage_root,
});

/** The certified account answer for `address` in `state` (spec section 7.2). */
export function accountAnswer(state, address) {
  const p = state.tree.prove(addrKey(address));
  const f = p.kind === 'inclusion' ? state.fieldsOf.get(address) : accountFields();
  return {
    proof_format: 2, address, macroblock_index: state.index, state_height: String(state.index * 90), state_root: state.root,
    exists: p.kind === 'inclusion', proof_kind: p.kind, ...bodyFields(f), merkle_proof: p.steps,
    ...(p.entries ? { bucket_entries: p.entries } : {}),
  };
}

/** The certified token answer for (`contract`, `holder`) in `state` (spec section 7.3). */
export function tokenAnswer(state, contract, holder) {
  const p = state.tree.prove(addrKey(contract));
  const f = p.kind === 'inclusion' ? state.fieldsOf.get(contract) : accountFields();
  const status = p.kind !== 'inclusion' ? 'absent' : (f.is_contract ? 'contract' : 'not_contract');
  const body = {
    proof_format: 2, contract_address: contract, holder, macroblock_index: state.index, state_height: String(state.index * 90),
    state_root: state.root, contract_status: status, account_proof_kind: p.kind, account_proof: p.steps,
    ...(p.entries ? { account_bucket_entries: p.entries } : {}), ...bodyFields(f, 'account_'),
  };
  delete body.is_contract;
  if (status !== 'contract') return body;
  const { tree, holders } = state.storage.get(contract);
  const s = tree.prove(balanceKey(holder));
  return {
    ...body, storage_proof_kind: s.kind, token_balance: holders[holder] ?? '0', storage_proof: s.steps,
    ...(s.entries ? { storage_bucket_entries: s.entries } : {}),
  };
}

/** The older live-root account body (a node from before certified proofs, which ignores the `mb` query). */
export function legacyAccountAnswer(state, address, blockHeight) {
  const p = state.tree.prove(addrKey(address));
  if (p.kind !== 'inclusion') {
    return { address, balance: 0, block_height: 0, error: 'account not found', merkle_proof: [], nonce: 0, proof_valid: false, state_root: '' };
  }
  const f = state.fieldsOf.get(address);
  return {
    address, balance: num(f.balance), nonce: num(f.nonce), block_height: blockHeight, merkle_proof: p.steps, proof_valid: true,
    state_root: state.root, last_claimed_epoch: num(f.last_claimed_epoch), is_node: f.is_node,
  };
}

/** The older live-root token body. */
export function legacyTokenAnswer(state, contract, holder, blockHeight) {
  const f = state.fieldsOf.get(contract);
  const { tree, holders } = state.storage.get(contract);
  return {
    contract_address: contract, holder, token_balance: holders[holder] ?? '0', storage_root: f.storage_root,
    storage_proof: tree.prove(balanceKey(holder)).steps, account_proof: state.tree.prove(addrKey(contract)).steps,
    account_balance: num(f.balance), account_nonce: num(f.nonce), contract_code_hash: f.contract_code_hash, state_root: state.root,
    block_height: blockHeight, proof_valid: true,
  };
}

/**
 * A certified network over QNET.NODES.
 * @param {{accounts?: Record<string, object>, tokens?: Record<string, {holders?: Record<string, string>, account?: object,
 *   codeHash?: string}>, chain?: Record<string, {balance?: string, nonce?: string, pk?: boolean}>|null}} [options]
 *   accounts: address -> leaf fields; tokens: contract -> holders (base units); chain: what GET /api/v1/account/{a} reports
 *   (the chain's nonce now; default: the newest certified state's)
 * @returns {object} the net: route(request), install(), certify(accounts, tokens), states, and knobs for node behaviour
 */
export function certifiedNet({ accounts = {}, tokens = {}, chain = null } = {}) {
  if (!NOBLE_INSTALLED) throw new Error('run npm run bundle:install: the committee signs with the bundle\'s ML-DSA-65');
  const net = {
    states: [buildState(FIRST_INDEX, accounts, tokens)],
    chain,
    // nodes that serve the older live-root bodies and no /api/v1/state/certified
    old: new Set(),
    // nodes that answer nothing (a network failure)
    down: new Set(),
    // node -> what /api/v1/state/certified reports as newest_certified_index (default: the newest state)
    frontier: new Map(),
    // the number of certified views a node holds (spec: 3)
    retained: 3,
    // no node reports a certified head (GET /api/v1/state/certified and the older position route answer 404)
    headless: false,
    // token contracts whose balance proofs every node fails (503)
    unreadable: new Set(),
    requests: [],
    newest() {
      return net.states[net.states.length - 1];
    },
    /** Certifies the next macroblock with this state (accounts and tokens as in certifiedNet). */
    certify(nextAccounts, nextTokens = {}) {
      const state = buildState(net.newest().index + 1, nextAccounts, nextTokens);
      net.states.push(state);
      return state;
    },
    /** A fresh light client rooted at the anchors two below the first certified macroblock (on both parity chains). */
    install() {
      core.clearQcCache();
      const anchor = { eligible_ids: [MEMBER], beacon: BEACON, registry_root: REGISTRY_ROOT };
      core.importVerifiedAnchors({ [FIRST_INDEX - 2]: anchor, [FIRST_INDEX - 1]: anchor });
      return net;
    },
    stateAt(index) {
      return net.states.find((s) => s.index === index) ?? null;
    },
    async route(request) {
      const url = new URL(request.url);
      if (!QNET.NODES.includes(url.origin)) return undefined;
      const node = url.origin;
      const p = url.pathname;
      const answer = net.answer(node, p, url.searchParams, request);
      if (answer === undefined) return undefined;
      net.requests.push(`${node}${p}${url.search}`);
      if (net.down.has(node)) throw new TypeError('node down');
      return answer;
    },
    answer(node, p, query, request) {
      const newest = net.newest();
      const old = net.old.has(node);
      if (p === '/api/v1/state/certified') {
        if (old || net.headless) return json({ error: 'not found' }, 404);
        const top = net.frontier.get(node) ?? newest.index;
        const views = net.states.filter((s) => s.index <= top).slice(-net.retained).reverse();
        return json({
          proof_format: 2, views: views.map((s) => ({ macroblock_index: s.index, state_height: s.index * 90, state_root: s.root })),
          newest_certified_index: top, finalized_height: top * 90 + 30, applied_height: top * 90 + 60, capture: 'ok',
        });
      }
      if (p === '/api/v1/debug/consensus-position') {
        return net.headless ? json({ error: 'not found' }, 404) : json({ last_sealed_mb_index: net.frontier.get(node) ?? newest.index });
      }
      const macro = /^\/api\/v1\/macroblock\/(\d+)\/proof$/.exec(p);
      if (macro) {
        const state = net.stateAt(Number(macro[1]));
        return state === null ? json({ error: 'macroblock_not_found' }) : json(macroblockProof(state.index, state.root));
      }
      if (/^\/api\/v1\/registry\/height\/\d+$/.test(p)) return json({ entries: ENTRIES });
      const accountProof = /^\/api\/v1\/account\/([0-9a-z]+)\/balance\/proof$/.exec(p);
      const tokenProof = /^\/api\/v1\/token\/([0-9a-z]+)\/([0-9a-z]+)\/balance\/proof$/.exec(p);
      if (tokenProof && net.unreadable.has(tokenProof[1])) return json({ proof_format: 2, error: 'busy' }, 503, { 'retry-after': '1' });
      if (accountProof || tokenProof) {
        if (old) {
          const height = newest.index * 90 + 45;
          if (accountProof) return json(legacyAccountAnswer(newest, accountProof[1], height));
          return json(legacyTokenAnswer(newest, tokenProof[1], tokenProof[2], height));
        }
        const mb = query.getAll('mb');
        if (mb.length !== 1) return json({ proof_format: 2, error: 'bad_parameter', parameter: 'mb' }, 400, { 'cache-control': 'no-store' });
        const top = net.frontier.get(node) ?? newest.index;
        const held = net.states.filter((s) => s.index <= top).slice(-net.retained);
        const servable = held.map((s) => s.index).reverse();
        let state;
        if (mb[0] === 'latest') {
          state = held[held.length - 1];
        } else {
          const j = Number(mb[0]);
          state = held.find((s) => s.index === j);
          if (!state && j > top) {
            return json({ proof_format: 2, error: 'macroblock_not_certified', macroblock_index: j, newest_certified_index: top }, 404);
          }
          if (!state) return json({ proof_format: 2, error: 'view_not_retained', servable }, 410);
        }
        const body = accountProof ? accountAnswer(state, accountProof[1]) : tokenAnswer(state, tokenProof[1], tokenProof[2]);
        return json(mb[0] === 'latest' ? { ...body, servable } : body);
      }
      const account = /^\/api\/v1\/account\/([0-9a-z]+)$/.exec(p);
      if (account && request.method === 'GET') {
        const f = newest.fieldsOf.get(account[1]) ?? accountFields();
        const now = { balance: f.balance, nonce: f.nonce, pk: false, ...(net.chain?.[account[1]] ?? {}) };
        return json({ address: account[1], balance: num(now.balance), has_dilithium_pk: now.pk === true, nonce: num(now.nonce) });
      }
      return undefined;
    },
  };
  return net;
}
