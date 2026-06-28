/**
 * QNet Mobile - Node Configuration
 * v3.35: Centralized Genesis node configuration
 * v4.10: Centralized Solana RPC configuration with fallback endpoints
 * 
 * IMPORTANT: Do NOT duplicate this list elsewhere!
 * Import from this file: import { GENESIS_NODES, getSolanaRpcUrl } from '../config/nodes';
 */

// Bootstrap genesis nodes. The nodes serve plain HTTP on :8001 (no TLS terminator
// is deployed). This transport carries only PUBLIC chain data + SIGNED txs — fund
// safety rests on the Dilithium/Ed25519 signatures, not TLS. Default is HTTP; HTTPS
// is opt-in (QNET_FORCE_HTTPS=1) for once a real TLS endpoint exists — enabling it
// without one makes every request fail.
export const GENESIS_NODES_HTTP = [
  'http://154.38.160.39:8001',    // Genesis 001
  'http://62.171.157.44:8001',    // Genesis 002
  'http://161.97.86.81:8001',     // Genesis 003
  'http://5.189.130.160:8001',    // Genesis 004
  'http://162.244.25.114:8001',   // Genesis 005
];

export const GENESIS_NODES_HTTPS = [
  'https://154.38.160.39:8001',
  'https://62.171.157.44:8001',
  'https://161.97.86.81:8001',
  'https://5.189.130.160:8001',
  'https://162.244.25.114:8001',
];

const _forceHttps = (() => {
  try {
    return typeof process !== 'undefined' && process?.env?.QNET_FORCE_HTTPS === '1';
  } catch (_) {
    return false;
  }
})();

export const GENESIS_NODES = _forceHttps ? GENESIS_NODES_HTTPS : GENESIS_NODES_HTTP;

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

