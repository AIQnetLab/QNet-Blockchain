/**
 * QNet Mobile - Node Configuration
 * v3.35: Centralized Genesis node configuration
 * v4.10: Centralized Solana RPC configuration with fallback endpoints
 * 
 * IMPORTANT: Do NOT duplicate this list elsewhere!
 * Import from this file: import { GENESIS_NODES, getSolanaRpcUrl } from '../config/nodes';
 */

// ---------------------------------------------------------------------------
// v14.5: HTTPS-FIRST BOOTSTRAP (MITM mitigation)
// ---------------------------------------------------------------------------
// Previous configuration used plaintext HTTP for all 5 genesis nodes. Any
// on-path attacker (public Wi-Fi, hostile ISP, compromised router) could:
//   • read wallet addresses + FCM push tokens as they were registered,
//   • substitute responses (fake balance, fake peer list),
//   • replay / manipulate activation flows.
//
// v14.5 defaults to HTTPS endpoints (the genesis servers terminate TLS on
// port 443 behind nginx). The legacy HTTP fallback remains available only
// when the runtime explicitly opts in via `process.env.QNET_ALLOW_HTTP=1`
// (e.g. for local development against an unprovisioned host), and even then
// a console warning is emitted to remind operators of the MITM risk.
//
// For mainnet mobile builds `QNET_ALLOW_HTTP` is unset → HTTPS is enforced.
// ---------------------------------------------------------------------------
export const GENESIS_NODES_HTTPS = [
  'https://154.38.160.39:8001',   // Genesis 001 - North America
  'https://62.171.157.44:8001',   // Genesis 002 - Europe
  'https://161.97.86.81:8001',    // Genesis 003 - Europe
  'https://5.189.130.160:8001',   // Genesis 004 - Europe
  'https://162.244.25.114:8001',  // Genesis 005 - Europe
];

export const GENESIS_NODES_HTTP_LEGACY = [
  'http://154.38.160.39:8001',
  'http://62.171.157.44:8001',
  'http://161.97.86.81:8001',
  'http://5.189.130.160:8001',
  'http://162.244.25.114:8001',
];

const _allowInsecure = (() => {
  try {
    // React Native / Node contexts
    // eslint-disable-next-line no-undef
    return typeof process !== 'undefined' && process?.env?.QNET_ALLOW_HTTP === '1';
  } catch (_) {
    return false;
  }
})();

if (_allowInsecure && typeof console !== 'undefined') {
  // eslint-disable-next-line no-console
  console.warn(
    '[QNET][WARN] QNET_ALLOW_HTTP=1 — using plaintext bootstrap URLs. ' +
      'Traffic (wallet addresses, push tokens) is susceptible to MITM. ' +
      'For mainnet do NOT set this flag.'
  );
}

export const GENESIS_NODES = _allowInsecure
  ? GENESIS_NODES_HTTP_LEGACY
  : GENESIS_NODES_HTTPS;

// Node discovery settings
export const NODE_DISCOVERY = {
  CACHE_TTL_MS: 5 * 60 * 1000,      // 5 minutes cache TTL
  MIN_REPUTATION: 0.7,               // 70% minimum reputation
  MAX_STALE_SECS: 300,               // 5 minutes max node age
  MAX_SYNC_LAG_BLOCKS: 5,            // Max 5 blocks behind
  DISCOVERY_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes refresh
};

// v4.10: Solana RPC endpoints with fallback (ordered by priority)
// Public endpoints have strict rate limits (~10 req/s), fallbacks help avoid 429 errors
export const SOLANA_RPC_ENDPOINTS = {
  devnet: [
    'https://api.devnet.solana.com',
  ],
  mainnet: [
    'https://api.mainnet-beta.solana.com',
  ],
};

// v4.10: Track which endpoint index to use (round-robin on 429)
let _solanaRpcIndex = { devnet: 0, mainnet: 0 };

/**
 * Get Solana RPC URL based on network setting
 * v4.10: Centralized — no more hardcoded URLs scattered through codebase
 */
export function getSolanaRpcUrl(isTestnet = true) {
  const network = isTestnet ? 'devnet' : 'mainnet';
  const endpoints = SOLANA_RPC_ENDPOINTS[network];
  const idx = _solanaRpcIndex[network] % endpoints.length;
  return endpoints[idx];
}

/**
 * Rotate to next RPC endpoint on rate limit (429) error
 * Call this when you get a 429 to try the next endpoint
 */
export function rotateSolanaRpc(isTestnet = true) {
  const network = isTestnet ? 'devnet' : 'mainnet';
  _solanaRpcIndex[network]++;
}

// Get random Genesis node (for initial bootstrap only)
export function getRandomGenesisNode() {
  return GENESIS_NODES[Math.floor(Math.random() * GENESIS_NODES.length)];
}

