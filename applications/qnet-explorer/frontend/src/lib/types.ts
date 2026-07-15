// ============================================================================
// QNet Explorer Types - L1 Blockchain Data Structures
// ============================================================================

export interface BlockTransaction {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  fee?: string;
  timestamp: number;
  nonce?: number;
  status: string;
  gas_used?: number;
  data?: string;
}

export interface HeartbeatEntry {
  timestamp: number;
  node_id: string;
  node_address: string;
  node_type: string;
  reputation: number;
  commitment_hash?: string;
  samples_count?: number;
}

export interface ConsensusData {
  commits_count: number;
  reveals_count: number;
  next_leader: string;
  eligible_nodes_count: number;
  fees_collected?: number;
  pool2_total_fees?: number;
  pool3_total_activations?: number;
  heartbeat_entries: HeartbeatEntry[];
  epoch?: number;
  round?: number;
}

export interface Block {
  // Core identifiers
  hash: string;
  height: number;
  timestamp: number;
  
  // Chain linkage
  previous_hash: string;
  merkle_root: string;
  
  // Block metadata
  block_type: 'MICROBLOCK' | 'MACROBLOCK';
  version?: number;
  
  // Producer info
  producer: string;
  producer_address: string;
  
  // Transaction data
  tx_count: number;
  transactions: BlockTransaction[];
  total_gas_used?: number;
  
  // Proof-of-History (VTS)
  poh_hash?: string;
  poh_count: number;
  
  // State
  state_root?: string;
  
  // Cryptographic signature (ML-DSA-65 / FIPS 204)
  signature_type: string;
  signature?: string;
  cert_serial?: string;
  
  // Quantum Random Beacon
  qrb_output?: string;
  
  // Block metrics
  size_bytes?: number;
  
  // MacroBlock consensus data
  consensus_data?: ConsensusData;
  
  // Related microblocks (for MacroBlock)
  micro_blocks?: string[];
}

// Network statistics
export interface NetworkStats {
  current_height: number;
  total_transactions: number;
  total_accounts: number;
  active_validators: number;
  tps: number;
  avg_block_time: number;
}

// Transaction details (extended)
export interface TransactionDetail extends BlockTransaction {
  block_height: number;
  block_hash: string;
  confirmations: number;
  signature?: string;
  signature_type?: string;
  input_data?: string;
}

// Address/Account info
export interface AddressInfo {
  address: string;
  balance: string;
  nonce: number;
  tx_count: number;
  first_seen: number;
  last_seen: number;
  is_contract: boolean;
  node_id?: string;
  node_type?: string;
  reputation?: number;
}

// Transaction (extended)
export interface Transaction extends BlockTransaction {
  block_height?: number;
  block_hash?: string;
  confirmations?: number;
  signature?: string;
  signature_type?: string;
  input_data?: string;
  gas_price?: number;
  gas_limit?: number;
}

// Network metrics
export interface NetworkMetrics {
  tps: number;
  avg_block_time: number;
  pending_tx_count: number;
  total_gas_used: number;
  active_nodes: number;
  network_hashrate?: number;
}

// Node info
export interface NodeInfo {
  node_id: string;
  address: string;
  node_type: 'SUPER' | 'LIGHT';
  reputation: number;
  is_active: boolean;
  last_heartbeat?: number;
  uptime_percentage?: number;
  blocks_produced?: number;
}

// System metrics
export interface SystemMetrics {
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  network_in: number;
  network_out: number;
  uptime: number;
}

// Alert
export interface Alert {
  id: string;
  type: 'warning' | 'error' | 'info';
  message: string;
  timestamp: number;
  resolved: boolean;
  source?: string;
}

// Search result
export interface SearchResult {
  type: 'block' | 'transaction' | 'address' | 'node' | 'token' | 'contract';
  id: string;
  hash: string;
  display: string;
  details?: string;
  data?: Record<string, unknown>;
}

// API response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Paginated response
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  has_more: boolean;
}

// Activation request
export interface ActivationRequest {
  wallet_address: string;
  node_type: 'light' | 'super';
  signature: string;
  public_key: string;
}

// Activation status
export interface ActivationStatus {
  is_activated: boolean;
  node_type?: 'light' | 'super';
  activated_at?: number;
  activation_tx?: string;
}

// Swap details (1DEV -> QNC)
export interface SwapDetails {
  rate: number;
  min_amount: number;
  max_amount: number;
  fee_percentage: number;
}

// Swap request
export interface SwapRequest {
  from_token: string;
  to_token: string;
  amount: number;
  wallet_address: string;
  signature: string;
}

