#!/usr/bin/env node
// Known answers for the move of a node balance into the wallet on aiqnet.io's request (qnet-link-v1.md section 14, the
// `claim` request that names the node; light-node-messages.md section 4, the claim quote): for each wallet of
// light-node.vectors.json its light and super node ids, the claim quote of each signed by the wallet key, and full QNet
// Link exchanges of the `claim` request naming the light or the super node (request bytes, reqHash, link, session
// bodies, key, AAD, plaintext, ciphertext), with the requests a relay refuses and the answers a site refuses. The
// earlier `claim` request, which named no node, is among the refused ones. SHA-2, SHA-3, SHAKE256, PBKDF2, X25519, HKDF
// and AES-GCM come from node:crypto, BLAKE3 and the encodings from the light node generator, ML-DSA-65 (FIPS 204,
// deterministic, empty context) from the @noble/post-quantum a client package resolves.
// Checked by the site (src/lib/__tests__/cabinet-claim.test.mjs), the extension (test/node-claim-vectors.test.mjs) and
// the app (__tests__/NodeClaimVectors.test.js).
//
//   node docs/protocols/tools/node-claim-vectors.mjs            write ../node-claim.vectors.json
//   node docs/protocols/tools/node-claim-vectors.mjs --check    exit 1 if the file differs from a fresh run

import {
  createCipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, pbkdf2Sync,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CHAIN_TAG, LINK2, M, NOBLE_PACKAGES, aadOf, blake3, checkNumber, eonOf, lightNodeId, mldsaVerify, openAnswer, reqHashOf,
  sha3Hex, walletHash,
} from './light-node-vectors.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SOURCE = resolve(HERE, '../light-node.vectors.json');
const OUT = resolve(HERE, '../node-claim.vectors.json');

// The request of a `claim` session (section 14.4): exactly these keys, in this order.
const REQUEST_KEYS = ['walletHash', 'nodeId'];
const WALLET_HASH_RE = /^[0-9a-f]{16}$/;
const LIGHT_ID_RE = /^light_mobile_[0-9a-f]{16}$/;
const SUPER_ID_RE = /^super_node_[0-9a-f]{16}$/;
const CLAIM_MIN_NANO = 1_000_000_000n;
const T = 1790000000;

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
const utf8 = (s) => Buffer.from(s, 'utf8');
const sha256 = (b) => createHash('sha256').update(b).digest();
const shake256x32 = (b) => createHash('shake256', { outputLength: 32 }).update(b).digest();
const label = (name, part) => `qnet-node-claim/vector/${name}/${part}`;

/** The super node id of a wallet: "super_node_" + first 16 hex of BLAKE3("SUPER_NODE_PRIVACY_" + wallet). */
export const superNodeId = (wallet) => `super_node_${hex(blake3(utf8(`SUPER_NODE_PRIVACY_${wallet}`))).slice(0, 16)}`;

// ---- ML-DSA-65 ----

async function loadMlDsa() {
  for (const p of NOBLE_PACKAGES) {
    const dir = join(REPO, p);
    if (!existsSync(join(dir, 'package.json'))) continue;
    let file;
    try {
      file = createRequire(join(dir, 'package.json')).resolve('@noble/post-quantum/ml-dsa.js');
    } catch {
      continue;
    }
    const { ml_dsa65: ml } = await import(pathToFileURL(file).href);
    return ml;
  }
  throw new Error('no @noble/post-quantum in the client packages: run npm ci in applications/qnet-wallet/tools/crypto-bundle');
}

const ML = await loadMlDsa();
const mldsaSign = (secretKey, text) => Buffer.from(ML.sign(utf8(text), secretKey, { extraEntropy: false }));

// ---- QNet Link revision 2 ----

const PKCS8_X25519 = unhex('302e020100300506032b656e04220420');
const SPKI_X25519 = unhex('302a300506032b656e032100');
const x25519Priv = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const x25519Pub = (raw) => createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
const x25519Public = (priv) => createPublicKey(x25519Priv(priv)).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
const x25519Shared = (priv, pub) => diffieHellman({ privateKey: x25519Priv(priv), publicKey: x25519Pub(pub) });

function clamp(bytes) {
  const k = Buffer.from(bytes);
  k[0] &= 248; k[31] &= 127; k[31] |= 64;
  return k;
}

const linkKey = (shared, id) => Buffer.from(hkdfSync('sha256', shared, unhex(id), utf8(LINK2.HKDF_INFO), 32));

function seal(key, iv, aad, plaintext) {
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(aad);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (obj, keys) => {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
};

/** A `claim` request, checked: exactly walletHash (16 lowercase hex, never null) and nodeId (a light or super id). */
export function checkClaimRequest(request) {
  if (!isPlainObject(request) || !sameKeys(request, REQUEST_KEYS)) return null;
  if (typeof request.walletHash !== 'string' || !WALLET_HASH_RE.test(request.walletHash)) return null;
  if (typeof request.nodeId !== 'string' || !(LIGHT_ID_RE.test(request.nodeId) || SUPER_ID_RE.test(request.nodeId))) return null;
  return request;
}

const requestText = (request) => {
  if (!checkClaimRequest(request)) throw new Error('request');
  return JSON.stringify(Object.fromEntries(REQUEST_KEYS.map((k) => [k, request[k]])));
};

// ---- vectors ----

function buildWallet(view) {
  const seed = pbkdf2Sync(utf8(view.mnemonic.normalize('NFKD')), utf8('mnemonic'), 2048, 64, 'sha512');
  const xi = shake256x32(utf8(`QNET_WALLET_MLDSA65_v1:${hex(seed)}`));
  const { publicKey, secretKey } = ML.keygen(Uint8Array.from(xi));
  if (hex(publicKey) !== view.publicKey || eonOf(Buffer.from(publicKey)) !== view.address) throw new Error(`${view.name}: key`);
  const W = view.address;
  const light = lightNodeId(W);
  const superId = superNodeId(W);
  if (light !== view.nodeId || walletHash(W) !== view.walletHash) throw new Error(`${view.name}: ids`);
  const quote = (nodeId) => {
    const preimage = M.claimRewards(nodeId, W);
    return { nodeId, preimage, signature: hex(mldsaSign(secretKey, preimage)) };
  };
  return {
    secretKey,
    view: {
      name: view.name, address: W, publicKey: view.publicKey, walletHash: view.walletHash, lightNodeId: light, superNodeId: superId,
      claimQuotes: [quote(light), quote(superId)],
    },
  };
}

function claimCases(kat, w24) {
  const W = kat.view.address;
  const L = kat.view.lightNodeId;
  const S = kat.view.superNodeId;
  const wh = kat.view.walletHash;
  const txHash = sha3Hex(label('claim', 'txHash'));
  return [
    ['claim-light-ok', { walletHash: wh, nodeId: L }, { status: 'ok', qnet: W, nodeId: L, amountNano: '12500000000', txHash, stoppedAtEpoch: null }],
    ['claim-super-ok', { walletHash: wh, nodeId: S }, { status: 'ok', qnet: W, nodeId: S, amountNano: '48000000000', txHash, stoppedAtEpoch: null }],
    // A part of the balance: the node's quote stopped at epoch 155 with more epochs left; below 1 QNC too.
    ['claim-super-ok-partial', { walletHash: wh, nodeId: S }, { status: 'ok', qnet: W, nodeId: S, amountNano: '1000000000', txHash, stoppedAtEpoch: '155' }],
    ['claim-light-ok-partial-small', { walletHash: wh, nodeId: L }, { status: 'ok', qnet: W, nodeId: L, amountNano: '400000000', txHash, stoppedAtEpoch: '155' }],
    ['claim-light-empty', { walletHash: wh, nodeId: L }, { status: 'empty', qnet: W, nodeId: L }],
    ['claim-super-empty', { walletHash: wh, nodeId: S }, { status: 'empty', qnet: W, nodeId: S }],
    ['claim-super-rejected', { walletHash: wh, nodeId: S }, { status: 'rejected' }],
    // The chain lists no super node of this wallet.
    ['claim-super-error-no-node', { walletHash: wh, nodeId: S }, { status: 'error', error: 'NO_NODE' }],
    ['claim-light-error-busy', { walletHash: wh, nodeId: L }, { status: 'error', error: 'CLAIM_BUSY' }],
    // No wallet of the app matches the request's wallet.
    ['claim-error-mismatch', { walletHash: w24.view.walletHash, nodeId: w24.view.superNodeId }, { status: 'error', error: 'WALLET_MISMATCH' }],
  ];
}

function buildCase([name, request, answer]) {
  const id = hex(sha256(utf8(label(name, 'id'))).subarray(0, 16));
  const sitePriv = clamp(sha256(utf8(label(name, 'site'))));
  const appPriv = clamp(sha256(utf8(label(name, 'app'))));
  const iv = sha256(utf8(label(name, 'iv'))).subarray(0, 12);
  const sitePub = x25519Public(sitePriv);
  const appPub = x25519Public(appPriv);
  const shared = x25519Shared(appPriv, sitePub);
  if (!shared.equals(x25519Shared(sitePriv, appPub))) throw new Error(`${name}: ECDH mismatch`);
  const key = linkKey(shared, id);
  const text = requestText(request);
  const reqHash = reqHashOf(text);
  const aad = aadOf(id, 'claim', reqHash);
  const plaintext = JSON.stringify({ v: 1, intent: 'claim', ...answer });
  const ct = seal(key, iv, utf8(aad), utf8(plaintext));
  const sessionRequest = { id, sitePub: b64u(sitePub), intent: 'claim', request };
  const check = checkNumber(shared, id);
  return {
    name, intent: 'claim',
    context: { request, now: String(T + 60), consent24h: true },
    sessionId: id, hkdfSalt: id,
    sitePrivateKey: hex(sitePriv), sitePublicKey: hex(sitePub),
    request, requestText: text, reqHash,
    link: `${LINK2.PREFIX}${id}.${b64u(sitePub)}.claim.${reqHash}`,
    sessionRequest,
    sessionView: { ...sessionRequest, reqHash },
    appPrivateKey: hex(appPriv), appPublicKey: hex(appPub), sharedSecret: hex(shared),
    hkdfInfo: LINK2.HKDF_INFO, key: hex(key), aad,
    checkNumber: check, checkNumberShown: false, checkNumberDisplay: `${check.slice(0, 3)} ${check.slice(3)}`,
    plaintext, iv: hex(iv), ciphertext: hex(ct),
    responseRequest: { appPub: b64u(appPub), iv: b64u(iv), ct: b64u(ct) },
  };
}

// Session bodies a relay answers 400: the request of section 14.4 broken one way at a time.
function invalidSessionRequests(cases, kat) {
  const base = cases.find((c) => c.name === 'claim-super-ok').sessionRequest;
  const L = kat.view.lightNodeId;
  const wh = kat.view.walletHash;
  const body = (request, why) => ({ why, body: JSON.stringify({ ...base, request }) });
  return [
    body({ walletHash: null }, 'the earlier claim request, which names no node'),
    body({ walletHash: wh }, 'no nodeId'),
    body({ walletHash: null, nodeId: L }, 'no wallet'),
    body({ walletHash: wh, nodeId: 'genesis_node_001' }, 'a genesis node is no claim request\'s node'),
    body({ walletHash: wh, nodeId: L.toUpperCase() }, 'nodeId not lowercase'),
    body({ walletHash: wh, nodeId: `${L}0` }, 'nodeId too long'),
    body({ walletHash: wh, nodeId: 'light_node_6526ab8fd00ff8ca' }, 'nodeId of no node type'),
    body({ walletHash: wh, nodeId: L, burner: '9z1QsPH2k9xpYY9EQYh8EdPjhnt9CXnsxZZkYgT5Km96' }, 'an extra key'),
    body({ walletHash: wh, nodeId: 7 }, 'nodeId not a string'),
    body({ walletHash: wh.slice(1), nodeId: L }, 'walletHash of 15 characters'),
  ];
}

// Answers a site refuses, each with the case whose session and context it is read in and the check that fails.
function invalidPlaintexts(cases, kat, w24) {
  const of = (name) => cases.find((c) => c.name === name);
  const withAnswer = (name, change, fail, why) => {
    const c = of(name);
    const answer = { ...JSON.parse(c.plaintext), ...change };
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete answer[k];
    return { why, case: name, context: c.context, plaintext: JSON.stringify(answer), fail };
  };
  return [
    withAnswer('claim-super-ok', { nodeId: kat.view.lightNodeId }, 'nodeId', 'the light id answering a request that names the super node'),
    withAnswer('claim-light-ok', { nodeId: kat.view.superNodeId }, 'nodeId', 'the super id answering a request that names the light node'),
    withAnswer('claim-super-ok', { qnet: w24.view.address, nodeId: w24.view.superNodeId }, 'nodeId', 'another wallet and its own node'),
    withAnswer('claim-super-ok', { qnet: w24.view.address }, 'nodeId', 'the node the request names, answered by another wallet'),
    withAnswer('claim-super-empty', { nodeId: w24.view.superNodeId }, 'nodeId', 'another wallet\'s node'),
    withAnswer('claim-super-ok', { amountNano: '999999999' }, 'amountNano', 'a whole balance below 1 QNC'),
    withAnswer('claim-super-ok', { amountNano: '0', stoppedAtEpoch: '155' }, 'amountNano', 'a part of nothing'),
    withAnswer('claim-light-ok', { txHash: 'A'.repeat(64) }, 'txHash', 'txHash not lowercase hex'),
    withAnswer('claim-light-ok', { stoppedAtEpoch: undefined }, 'keys', 'no stoppedAtEpoch'),
    withAnswer('claim-light-ok', { stoppedAtEpoch: 155 }, 'stoppedAtEpoch', 'stoppedAtEpoch as a number'),
    withAnswer('claim-light-empty', { amountNano: '1' }, 'keys', 'an empty answer with an amount'),
  ];
}

function build() {
  const V = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const wallets = V.wallets.map(buildWallet);
  const [kat, w24] = wallets;
  const cases = claimCases(kat, w24).map(buildCase);
  for (const w of wallets) w.secretKey.fill(0);
  return {
    about: 'The move of a node balance into the wallet on aiqnet.io\'s request: the `claim` request names the node, the light '
      + 'or the super node of the wallet it names, and the wallet signs the claim quote of that node. For each wallet of '
      + 'light-node.vectors.json its light and super node ids and both claim quotes, then full QNet Link exchanges of the '
      + 'request naming either node, the session bodies a relay refuses (the earlier request, which named no node, among '
      + 'them) and the answers a site refuses.',
    generator: 'docs/protocols/tools/node-claim-vectors.mjs',
    specs: ['docs/protocols/qnet-link-v1.md#14-revision-2', 'docs/protocols/light-node-messages.md'],
    source: 'docs/protocols/light-node.vectors.json',
    encodings: 'As light-node.vectors.json: preimages are UTF-8 text, keys and ML-DSA-65 signatures lowercase hex (raw '
      + 'FIPS 204, deterministic, empty context), QNet Link wire values unpadded base64url, every u64 a decimal string.',
    constants: {
      chainTag: CHAIN_TAG,
      requestKeys: REQUEST_KEYS,
      nodeIdPatterns: { light: LIGHT_ID_RE.source, super: SUPER_ID_RE.source },
      superNodeIdRule: 'super_node_ + first 16 hex of BLAKE3("SUPER_NODE_PRIVACY_" + wallet)',
      claimMinNano: String(CLAIM_MIN_NANO),
    },
    wallets: wallets.map((w) => w.view),
    cases,
    invalidSessionRequests: invalidSessionRequests(cases, kat),
    invalidPlaintexts: invalidPlaintexts(cases, kat, w24),
  };
}

function selfCheck(v) {
  for (const w of v.wallets) {
    if (superNodeId(w.address) !== w.superNodeId || !SUPER_ID_RE.test(w.superNodeId)) throw new Error(`${w.name}: super id`);
    for (const q of w.claimQuotes) {
      if (q.preimage !== `${CHAIN_TAG}claim_rewards:${q.nodeId}:${w.address}`) throw new Error(`${w.name}: quote preimage`);
      if (!mldsaVerify(unhex(w.publicKey), q.preimage, unhex(q.signature))) throw new Error(`${w.name}: quote signature`);
    }
  }
  for (const c of v.cases) {
    const opened = openAnswer({
      sessionId: c.sessionId, intent: 'claim', reqHash: c.reqHash, sitePrivateKey: c.sitePrivateKey,
      appPub: c.responseRequest.appPub, iv: c.responseRequest.iv, ct: c.responseRequest.ct,
    });
    if (opened !== c.plaintext) throw new Error(`${c.name}: decrypt`);
    if (reqHashOf(c.requestText) !== c.reqHash || !LINK2.RE.test(c.link)) throw new Error(`${c.name}: link`);
  }
  for (const n of v.invalidSessionRequests) {
    if (checkClaimRequest(JSON.parse(n.body).request)) throw new Error(`invalid session request passes: ${n.why}`);
  }
}

function main(argv) {
  const vectors = build();
  selfCheck(vectors);
  const text = `${JSON.stringify(vectors, null, 2)}\n`;
  if (argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error(`${OUT} differs from a fresh run`);
      process.exitCode = 1;
      return;
    }
    console.log(`${OUT} is up to date`);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: ${vectors.cases.length} cases, ${vectors.invalidSessionRequests.length} refused session bodies, `
    + `${vectors.invalidPlaintexts.length} refused answers`);
}

main(process.argv.slice(2));
