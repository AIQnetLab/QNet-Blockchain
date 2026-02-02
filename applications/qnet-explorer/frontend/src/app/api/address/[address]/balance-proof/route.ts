/**
 * v3.14: Balance Proof API (OPTIONAL - for trustless verification)
 * 
 * NOTE: Explorer already shows data from PostgreSQL!
 * This endpoint is ONLY for users who want cryptographic verification.
 * 
 * v3.14: DISTRIBUTED load - uses random Genesis node, no single point of failure
 */

import { NextRequest, NextResponse } from 'next/server';
import { sha3_256 } from 'js-sha3';

// ALL Genesis nodes - load distributed randomly (no single point of failure!)
const GENESIS_NODES = [
    'http://154.38.160.39:8001',   // North America
    'http://62.171.157.44:8001',   // Europe
    'http://161.97.86.81:8001',    // Europe
    'http://5.189.130.160:8001',   // Europe
    'http://162.244.25.114:8001',  // Europe
];

// Primary from env (for sync-service), with random Genesis fallback
const PRIMARY_NODE_URL = process.env.QNET_API_URL || getRandomGenesisNode();

// Get random Genesis node (distributes load!)
function getRandomGenesisNode(): string {
    return GENESIS_NODES[Math.floor(Math.random() * GENESIS_NODES.length)];
}

// Minimum reputation for verification nodes
const MIN_REPUTATION_FOR_VERIFICATION = 0.70;

// Cache for discovered high-reputation nodes (server-side cache)
interface DiscoveredNode {
  url: string;
  reputation: number;
  nodeType: string;
}
let discoveredNodesCache: DiscoveredNode[] = [];
let cacheLastUpdated = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * v3.14: Discover active HIGH-REPUTATION nodes from network
 * Uses RANDOM Genesis node for discovery (no single point of failure!)
 */
async function discoverHighRepNodes(): Promise<DiscoveredNode[]> {
  // Return cached nodes if fresh
  if (discoveredNodesCache.length > 0 && (Date.now() - cacheLastUpdated) < CACHE_TTL) {
    return discoveredNodesCache;
  }
  
  // Use random Genesis node for discovery (distributes load!)
  const randomGenesis = getRandomGenesisNode();
  
  try {
    const response = await fetch(`${randomGenesis}/api/v1/peers`, {
      signal: AbortSignal.timeout(5000),
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.peers && Array.isArray(data.peers)) {
        // Filter by HIGH REPUTATION only
        const highRepNodes = data.peers
          .filter((peer: { address?: string; reputation?: number; node_type?: string }) => 
            peer.address && 
            peer.address.includes(':') &&
            !peer.address.startsWith('0.0.0.0') &&
            (peer.reputation || 0) >= MIN_REPUTATION_FOR_VERIFICATION
          )
          .map((peer: { address: string; reputation: number; node_type: string }) => ({
            url: `http://${peer.address}`,
            reputation: peer.reputation,
            nodeType: peer.node_type || 'unknown'
          }))
          .sort((a: DiscoveredNode, b: DiscoveredNode) => b.reputation - a.reputation)
          .slice(0, 50);
        
        if (highRepNodes.length >= 1) {
          discoveredNodesCache = highRepNodes;
          cacheLastUpdated = Date.now();
          return highRepNodes;
        }
      }
    }
  } catch (err) {
    // Discovery failed, use Genesis nodes as fallback
  }
  
  // Fallback: ALL Genesis nodes (distributed, no single point of failure!)
  return GENESIS_NODES.map(url => ({ url, reputation: 0.90, nodeType: 'genesis' }));
}

// Get random high-reputation node URL for load balancing
async function getNodeUrl(): Promise<string> {
  const nodes = await discoverHighRepNodes();
  // Random from discovered (load distribution)
  const selected = nodes[Math.floor(Math.random() * nodes.length)];
  return selected.url;
}

// Get node URLs for verification (returns multiple for consensus)
async function getNodesForVerification(count: number = 5): Promise<string[]> {
  const nodes = await discoverHighRepNodes();
  // Shuffle and take up to 'count' nodes
  const shuffled = shuffleArray(nodes);
  return shuffled.slice(0, count).map(n => n.url);
}

// Helper: Shuffle array (Fisher-Yates)
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Convert uint64 to bytes (little-endian, same as Rust)
function uint64ToBytes(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(value), true); // little-endian
  return new Uint8Array(buffer);
}

// Concatenate byte arrays
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// Verify Merkle proof locally
// CRITICAL: Must match Rust implementation exactly!
// Rust uses raw bytes, not hex strings for hashing
function verifyMerkleProof(
  address: string,
  balance: number,
  nonce: number,
  proof: Array<{ sibling: string; is_right: boolean }>,
  expectedRoot: string
): boolean {
  try {
    const encoder = new TextEncoder();
    
    // Hash address (same as Rust: b"QNET_ADDR:" + address.as_bytes())
    const addrHash = sha3_256(concatBytes(
      encoder.encode('QNET_ADDR:'),
      encoder.encode(address)
    ));
    
    // Hash account data (same as Rust: b"QNET_ACCOUNT:" + balance(8) + nonce(8) + pending_rewards(8) + address)
    // CRITICAL: Use raw bytes, not hex strings!
    const accountDataBytes = concatBytes(
      encoder.encode('QNET_ACCOUNT:'),
      uint64ToBytes(balance),           // 8 bytes little-endian
      uint64ToBytes(nonce),             // 8 bytes little-endian
      uint64ToBytes(0),                 // pending_rewards = 0 for basic proof
      encoder.encode(address)           // address string bytes
    );
    let currentHash = sha3_256(accountDataBytes);
    
    // Walk up the Merkle tree
    for (let i = 0; i < proof.length; i++) {
      const { sibling, is_right } = proof[i];
      
      // Verify bit matches direction
      const byteIdx = Math.floor(i / 8);
      const bitIdx = 7 - (i % 8);
      const addrByte = byteIdx < 32 ? 
        parseInt(addrHash.substring(byteIdx * 2, byteIdx * 2 + 2), 16) : 0;
      const expectedBit = ((addrByte >> bitIdx) & 1) === 1;
      
      if (is_right !== expectedBit) {
        return false;
      }
      
      // Combine hashes (convert hex to bytes first!)
      const siblingBytes = hexToBytes(sibling);
      const currentBytes = hexToBytes(currentHash);
      
      const combinedBytes = is_right
        ? concatBytes(siblingBytes, currentBytes)
        : concatBytes(currentBytes, siblingBytes);
      
      // Hash the combination
      currentHash = sha3_256(combinedBytes);
    }
    
    return currentHash === expectedRoot;
  } catch (err) {
    console.error('[MERKLE] Verification error:', err);
    return false;
  }
}

// Helper: hex string to bytes
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// Verify state_root from multiple nodes (2/3 consensus)
// v3.13: Uses HIGH-REPUTATION nodes only for trustworthy verification
async function verifyStateRootConsensus(
  stateRoot: string,
  blockHeight: number
): Promise<boolean> {
  const macroBlockIndex = Math.floor(blockHeight / 90);
  
  // v3.13: Get HIGH-REP nodes only (distributes load + ensures quality!)
  const nodesToQuery = await getNodesForVerification(5);
  
  if (nodesToQuery.length < 2) {
    console.warn('[BALANCE-PROOF] Not enough high-rep nodes for consensus verification');
    return false;
  }
  
  const queries = nodesToQuery.map(async (nodeUrl) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const response = await fetch(`${nodeUrl}/api/v1/macroblock/${macroBlockIndex}`, {
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) return null;
      
      const macroblock = await response.json();
      return macroblock.state_root || null;
    } catch {
      return null;
    }
  });
  
  const results = await Promise.all(queries);
  const validResults = results.filter((r): r is string => r !== null);
  
  if (validResults.length < 2) {
    return false;
  }
  
  const matchCount = validResults.filter(r => r === stateRoot).length;
  const threshold = Math.ceil(validResults.length * 2 / 3);
  
  return matchCount >= threshold;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  try {
    const { address } = await params;
    
    if (!address || address.length > 64) {
      return NextResponse.json({
        success: false,
        error: 'Invalid address',
      }, { status: 400 });
    }
    
    // Fetch balance with proof from node (uses discovered nodes!)
    const nodeUrl = await getNodeUrl();
    const response = await fetch(`${nodeUrl}/api/v1/account/${address}/balance/proof`, {
      next: { revalidate: 10 }, // Cache for 10 seconds
    });
    
    if (!response.ok) {
      return NextResponse.json({
        success: false,
        verified: false,
        error: 'Failed to fetch balance proof',
      });
    }
    
    const data = await response.json();
    
    if (!data.merkle_proof || data.merkle_proof.length === 0) {
      return NextResponse.json({
        success: true,
        verified: false,
        balance: (data.balance || 0) / 1e9,
        balanceNano: data.balance || 0,
        error: 'No Merkle proof available',
      });
    }
    
    // Step 1: Verify Merkle proof locally
    const proofValid = verifyMerkleProof(
      address,
      data.balance || 0,
      data.nonce || 0,
      data.merkle_proof,
      data.state_root
    );
    
    // Step 2: Verify state_root consensus (if proof valid)
    let stateRootVerified = false;
    if (proofValid) {
      stateRootVerified = await verifyStateRootConsensus(
        data.state_root,
        data.block_height
      );
    }
    
    const verified = proofValid && stateRootVerified;
    
    return NextResponse.json({
      success: true,
      verified,
      balance: (data.balance || 0) / 1e9,
      balanceNano: data.balance || 0,
      nonce: data.nonce || 0,
      blockHeight: data.block_height || 0,
      stateRoot: data.state_root || '',
      proofSize: data.merkle_proof?.length || 0,
      proofValid,
      stateRootVerified,
    });
  } catch (err) {
    console.error('[BALANCE-PROOF] Error:', err);
    return NextResponse.json({
      success: false,
      verified: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 });
  }
}

