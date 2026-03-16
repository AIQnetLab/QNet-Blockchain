// ─────────────────────────────────────────────────────────────────────────────
// QNet SDK — Core types
// ─────────────────────────────────────────────────────────────────────────────

/** Hex-encoded 32-byte block hash */
export type BlockHash = string;

/** QNet EON address (e.g. "19chexeon15chex4...") */
export type QNetAddress = string;

export type NodeType = 'genesis' | 'super' | 'light';

export interface QNetConfig {
  /** Base URL of any genesis node API, e.g. "http://154.38.160.39:9876" */
  endpoint: string;
  /** Optional API key for protected endpoints */
  apiKey?: string;
  /** Request timeout in milliseconds (default 15000) */
  timeoutMs?: number;
}

// ── Block types ───────────────────────────────────────────────────────────────

export interface MicroBlock {
  height: number;
  hash: BlockHash;
  previousHash: BlockHash;
  producer: string;
  timestamp: number;
  transactionCount: number;
  merkleRoot: string;
  blockType: 'MICROBLOCK' | 'MACROBLOCK';
  pohHash?: string;
}

export interface MacroBlock extends MicroBlock {
  blockType: 'MACROBLOCK';
  epoch: number;
  totalTransactions: number;
  stateRoot: string;
}

// ── Transaction types ─────────────────────────────────────────────────────────

export type TransactionType =
  | 'TRANSFER'
  | 'CONTRACT_DEPLOY'
  | 'CONTRACT_CALL'
  | 'REWARD_CLAIM'
  | 'EMISSION';

export interface Transaction {
  hash: string;
  from: QNetAddress;
  to?: QNetAddress;
  value: string;          // QNC amount in smallest unit (string to avoid u64 overflow)
  fee: string;
  nonce: number;
  type: TransactionType;
  data?: string;          // hex-encoded calldata
  signature: string;      // hex-encoded Ed25519 or Dilithium signature
  blockHeight: number;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed';
}

export interface SendTransactionParams {
  from: QNetAddress;
  to: QNetAddress;
  value: string;
  fee?: string;
  data?: string;
  /** Hex-encoded Dilithium3 (ML-DSA-65) or Ed25519 signature */
  signature: string;
  signatureType?: 'ed25519' | 'dilithium3';
}

// ── Account / Wallet ──────────────────────────────────────────────────────────

export interface AccountBalance {
  address: QNetAddress;
  balance: string;         // QNC in smallest unit
  balanceFormatted: string; // human-readable "123.456 QNC"
  nonce: number;
  pendingRewards: string;
  lockedUntilHeight: number;
}

export interface WalletKeys {
  qnetAddress: QNetAddress;
  publicKeyHex: string;
  /** Present only when generated locally — never transmitted */
  privateKeyHex?: string;
  keyType: 'ed25519' | 'dilithium3';
}

// ── Node / Network ────────────────────────────────────────────────────────────

export interface NodeStatus {
  nodeId: string;
  nodeType: NodeType;
  version: string;
  latestHeight: number;
  latestHash: BlockHash;
  peersConnected: number;
  isSynced: boolean;
  uptimeSeconds: number;
  blockProductionRate: number; // blocks/minute
}

export interface NetworkStats {
  latestHeight: number;
  activeNodes: number;
  tps: number;           // transactions per second (last 60s)
  totalTransactions: number;
  totalStaked: string;   // QNC
  currentEpoch: number;
}

// ── Rewards ───────────────────────────────────────────────────────────────────

export interface PendingRewards {
  address: QNetAddress;
  pendingQNC: string;
  lastClaimedHeight: number;
  eligibleSince: number;
}

export interface RewardClaimResult {
  txHash: string;
  amount: string;
  height: number;
}

// ── Faucet ────────────────────────────────────────────────────────────────────

export interface FaucetClaimResult {
  devTxHash?: string;
  solTxHash?: string;
  devAmount: number;
  solAmount: number;
}
