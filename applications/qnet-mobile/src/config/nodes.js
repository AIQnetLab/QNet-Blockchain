/**
 * QNet Mobile - Node Configuration: the genesis nodes and the Solana devnet endpoint, in one place.
 *
 * IMPORTANT: Do NOT duplicate this list elsewhere!
 * Import from this file: import { GENESIS_NODES, getSolanaRpcUrl } from '../config/nodes';
 */

// The genesis nodes by address. A node itself serves plain HTTP on :8001; the app never calls these. They
// are kept only as the key for `publicNodeUrl`: a genesis node still names itself by address (in a ping's
// response_url, in the validator list) until its operator sets its public name.
export const GENESIS_NODES_HTTP = [
  'http://154.38.160.39:8001',    // Genesis 001
  'http://62.171.157.44:8001',    // Genesis 002
  'http://161.97.86.81:8001',     // Genesis 003
  'http://5.189.130.160:8001',    // Genesis 004
  'http://162.244.25.114:8001',   // Genesis 005
];

// The same five behind their public names: a TLS terminator on each server in front of :8001, with a
// certificate for the name (scripts/node-tls.sh). This is what the app uses. The Android build carries a
// network security config that refuses cleartext, and iOS ATS refuses it to a public host.
export const GENESIS_NODES_HTTPS = [
  'https://node1.aiqnet.io',
  'https://node2.aiqnet.io',
  'https://node3.aiqnet.io',
  'https://node4.aiqnet.io',
  'https://node5.aiqnet.io',
];

export const GENESIS_NODES = GENESIS_NODES_HTTPS;

// A DNS name of at least two labels whose last label has a letter: an IPv4 literal (all digits) and an
// IPv6 literal (brackets, colons) both fail it, and so does a bare single-label name.
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.arpa', '.home'];

/**
 * The canonical form `https://host` of a node URL, or null when the app must not call it: anything but
 * https on the default port, an IP literal, a local name, credentials, a path, a query or a fragment.
 * A node's api_endpoint is chosen by its operator, so this is the only shape the app accepts from one.
 */
export function canonicalNodeUrl(url) {
  const m = /^https:\/\/([^/?#@\s]+)\/?$/i.exec(String(url || '').trim());
  if (!m) return null;
  let host = m[1].toLowerCase();
  const port = /:(\d*)$/.exec(host);
  if (port) {
    if (port[1] !== '443') return null;
    host = host.slice(0, -port[0].length);
  }
  if (!HOST_RE.test(host) || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return `https://${host}`;
}

/** Whether a node URL may be used at all: see canonicalNodeUrl. */
export const usableNodeUrl = (url) => canonicalNodeUrl(url) !== null;

/** Whether a URL is one of the five genesis names. */
export function isGenesisNodeUrl(url) {
  const c = canonicalNodeUrl(url);
  return c !== null && GENESIS_NODES_HTTPS.includes(c);
}

/**
 * The address the app calls for a URL a node handed it. A genesis node's address maps to its public name;
 * anything else must already be a usable HTTPS name (canonicalNodeUrl), else null.
 */
export function publicNodeUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  const i = GENESIS_NODES_HTTP.indexOf(u);
  if (i >= 0) return GENESIS_NODES_HTTPS[i];
  return canonicalNodeUrl(u);
}

/**
 * Where a ping answer may go: one of the five genesis names, whichever form the node named it in. A ping
 * carries this device's node id and ping key material, so it never goes to a third-party operator.
 */
export function genesisResponseUrl(url) {
  const u = publicNodeUrl(url);
  return u && GENESIS_NODES_HTTPS.includes(u) ? u : null;
}

// The block explorer is the chain's history archive: nodes keep about a day of transactions, the
// explorer keeps all of them, so the wallet pages its history from here.
export const EXPLORER_API = 'https://aiqnet.io';

/**
 * Public page of one transaction. One source, so a moved path is changed in one place. It opens in the system
 * browser with the site's app marker (?from=app), so the site shows its app view there, whose header leads only to
 * the explorer and the policies: no activation, payment, extension or APK page is a few taps from a store build's
 * history row or result card (R3-XPD-01).
 */
export const explorerTxUrl = (hash) => `${EXPLORER_API}/explorer/tx/${encodeURIComponent(hash || '')}?from=app`;

/**
 * The genesis nodes that own a light node's shard, in the order the chain ranks them.
 *
 * A light node's shard is blake3(node_id) mod 5, and a shard is owned by three genesis nodes — its
 * own and the next two around the ring — so a shard survives one of them being down. Both rules are
 * pure functions of the node id, so the device derives the same answer the chain does, with no
 * network call. MUST stay byte-identical to node/mod.rs light_shard_of + light_shard_owners.
 *
 * This matters because the shard owner is the node that records eligibility and commits the epoch
 * bitmap. An answer sent anywhere else has to be relayed to it, and a relay carries the signature
 * without the key it was signed with — which is exactly how a device that rotated its ping key
 * (a reinstall does) ends up attesting into a void.
 */
export function lightShardOwnerUrls(nodeId) {
  if (!nodeId) return GENESIS_NODES.slice();
  let shard;
  try {
    const { blake3 } = require('@noble/hashes/blake3.js');
    const h = blake3(Buffer.from(nodeId, 'utf8'));
    // First 8 bytes as a little-endian u64, exactly as the node reads them.
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(h[i]);
    shard = Number(v % 5n);
  } catch (_) {
    return GENESIS_NODES.slice(); // hashing unavailable: every genesis, rather than nothing
  }
  const owners = [shard % 5, (shard + 1) % 5, (shard + 2) % 5];
  return owners.map(i => GENESIS_NODES[i]).filter(Boolean);
}

// Solana devnet only, in every build, while QNet is a test network: a constant of the build, never a setting.
export const SOLANA_CLUSTER = 'devnet';
export const SOLANA_RPC_ENDPOINTS = ['https://api.devnet.solana.com'];
// A Solana transaction's page on the cluster's public explorer (a Solana send's History detail), opened in the system
// browser; fixed by the build like the cluster.
export const solanaExplorerTxUrl = (signature) => `https://explorer.solana.com/tx/${encodeURIComponent(signature || '')}`
  + (SOLANA_CLUSTER === 'mainnet' ? '' : `?cluster=${SOLANA_CLUSTER}`);
// The devnet 1DEV mint (6 decimals, classic Token program).
export const ONE_DEV_MINT = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';

// Round-robin over the endpoints after a rate-limited (429) answer.
let _solanaRpcIndex = 0;

export function getSolanaRpcUrl() {
  return SOLANA_RPC_ENDPOINTS[_solanaRpcIndex % SOLANA_RPC_ENDPOINTS.length];
}

/** The next endpoint after a rate-limited answer. */
export function rotateSolanaRpc() {
  _solanaRpcIndex++;
  return getSolanaRpcUrl();
}

/** One genesis name at random. */
export function getRandomGenesisNode() {
  return GENESIS_NODES[Math.floor(Math.random() * GENESIS_NODES.length)];
}

/** The five genesis names in random order: spreads load and gives each retry a different node. */
export function shuffledGenesisNodes() {
  const a = GENESIS_NODES.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
