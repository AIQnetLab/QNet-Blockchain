/**
 * QNet Mobile - Node Configuration
 * v3.35: Centralized Genesis node configuration
 * 
 * IMPORTANT: Do NOT duplicate this list elsewhere!
 * Import from this file: import { GENESIS_NODES } from '../config/nodes';
 */

// Genesis node public API endpoints (infrastructure backbone)
// These nodes are always available for initial bootstrap
export const GENESIS_NODES = [
  'http://154.38.160.39:8001',   // Genesis 001 - North America
  'http://62.171.157.44:8001',   // Genesis 002 - Europe
  'http://161.97.86.81:8001',    // Genesis 003 - Europe
  'http://5.189.130.160:8001',   // Genesis 004 - Europe
  'http://162.244.25.114:8001',  // Genesis 005 - Europe
];

// Node discovery settings
export const NODE_DISCOVERY = {
  CACHE_TTL_MS: 5 * 60 * 1000,      // 5 minutes cache TTL
  MIN_REPUTATION: 0.7,               // 70% minimum reputation
  MAX_STALE_SECS: 300,               // 5 minutes max node age
  MAX_SYNC_LAG_BLOCKS: 5,            // Max 5 blocks behind
  DISCOVERY_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes refresh
};

// Get random Genesis node (for initial bootstrap only)
export function getRandomGenesisNode() {
  return GENESIS_NODES[Math.floor(Math.random() * GENESIS_NODES.length)];
}

