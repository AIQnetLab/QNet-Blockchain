import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import {
  QNetConfig,
  MicroBlock,
  MacroBlock,
  Transaction,
  SendTransactionParams,
  AccountBalance,
  NodeStatus,
  NetworkStats,
  PendingRewards,
  RewardClaimResult,
  RewardClaimQuote,
  DilithiumSigner,
  FaucetClaimResult,
} from './types';
import type {
  DeployContractParams,
  DeployContractResult,
  CallContractParams,
  ContractCallResult,
  ViewContractParams,
  ContractViewResult,
  ContractLogsResult,
} from './contract';
import { QNET_CHAIN_TAG } from './wallet';

/**
 * Refuse to hand the node's string to the wallet's signing key unless it is unmistakably a claim.
 *
 * The claim flow used to sign `quote.signMessage` verbatim with the SAME key that signs
 * `q{chain_id}|transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}`, and nothing rebuilt or checked the
 * `qnet_claim_v1` prefix — so the prefix separated nothing and a malicious node could return a
 * transfer-shaped string and drain the wallet.
 *
 * The node's preimage is `q{chain_id}|qnet_claim_v1:{wallet}:{timestamp}:{hex(sha3_256(claims_data))}`. This SDK
 * has no sha3 dependency, so it pins everything else: the domain tag, the wallet it is signing for,
 * the timestamp it will echo, and that the tail is a 32-byte hex digest and nothing else. A transfer
 * — or any other domain — cannot satisfy it. Callers that want the digest verified too should hash
 * `quote.claimsData` themselves and compare before signing; the mobile wallet does exactly that.
 */
export function assertClaimMessageShape(msg: string, wallet: string, timestamp: number): void {
  const expectedPrefix = `${QNET_CHAIN_TAG}qnet_claim_v1:${wallet}:${timestamp}:`;
  if (typeof msg !== 'string' || !msg.startsWith(expectedPrefix)) {
    throw new Error('Node asked the wallet to sign a non-claim message — refusing');
  }
  const digest = msg.slice(expectedPrefix.length);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('Claim message digest is malformed — refusing to sign');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// QNet REST API client
// ─────────────────────────────────────────────────────────────────────────────

export class QNetClient {
  private readonly http: AxiosInstance;
  private readonly config: Required<QNetConfig>;

  constructor(config: QNetConfig) {
    this.config = {
      endpoint: config.endpoint.replace(/\/$/, ''),
      apiKey:    config.apiKey   ?? '',
      timeoutMs: config.timeoutMs ?? 15_000,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }

    this.http = axios.create({
      baseURL: this.config.endpoint,
      timeout: this.config.timeoutMs,
      headers,
    });
  }

  // ── Network ───────────────────────────────────────────────────────────────

  /** Returns the current status of the connected node. */
  async getNodeStatus(): Promise<NodeStatus> {
    const res = await this.get<NodeStatus>('/api/v1/node/status');
    return res;
  }

  /** Returns aggregated network statistics. */
  async getNetworkStats(): Promise<NetworkStats> {
    return this.get<NetworkStats>('/api/v1/network/stats');
  }

  // ── Blocks ────────────────────────────────────────────────────────────────

  /** Returns the latest finalized block. */
  async getLatestBlock(): Promise<MicroBlock> {
    return this.get<MicroBlock>('/api/v1/block/latest');
  }

  /** Fetch a block by height. */
  async getBlock(height: number): Promise<MicroBlock | MacroBlock> {
    if (!Number.isInteger(height) || height < 0) {
      throw new Error(`Invalid block height: ${height}`);
    }
    return this.get<MicroBlock | MacroBlock>(`/api/v1/block/${height}`);
  }

  /**
   * Fetch a range of blocks `[from, to]` (inclusive).
   * Max 100 blocks per call.
   */
  async getBlocks(from: number, to: number): Promise<MicroBlock[]> {
    if (to - from > 100) throw new Error('Range too large (max 100)');
    return this.get<MicroBlock[]>(`/api/v1/blocks?from=${from}&to=${to}`);
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  /** Fetch a transaction by its hash. */
  async getTransaction(hash: string): Promise<Transaction> {
    return this.get<Transaction>(`/api/v1/tx/${hash}`);
  }

  /**
   * Broadcast a signed transaction to the network.
   * The signature must already be attached in `params.signature`.
   */
  async sendTransaction(params: SendTransactionParams): Promise<{ txHash: string }> {
    return this.post<{ txHash: string }>('/api/v1/tx/send', params);
  }

  /** Returns recent transactions for an address (latest-first, max 50). */
  async getAddressTransactions(
    address: string,
    limit = 20,
    offset = 0,
  ): Promise<Transaction[]> {
    return this.get<Transaction[]>(
      `/api/v1/address/${address}/txs?limit=${limit}&offset=${offset}`,
    );
  }

  // ── Account / Balance ─────────────────────────────────────────────────────

  /** Returns the QNC balance and metadata for an address. */
  async getBalance(address: string): Promise<AccountBalance> {
    return this.get<AccountBalance>(`/api/v1/address/${address}/balance`);
  }

  /**
   * Convenience helper — returns the human-readable QNC balance string.
   *
   * @example
   * const balance = await client.getBalanceFormatted("19chexeon...");
   * // → "123.456 QNC"
   */
  async getBalanceFormatted(address: string): Promise<string> {
    const account = await this.getBalance(address);
    return account.balanceFormatted;
  }

  // ── Rewards ───────────────────────────────────────────────────────────────

  /** Returns unclaimed rewards for an address. */
  async getPendingRewards(address: string): Promise<PendingRewards> {
    return this.get<PendingRewards>(`/api/v1/rewards/${address}`);
  }

  /**
   * Step 1 of the claim handshake: ask a node to quote the batch of unclaimed epochs.
   *
   * The node builds the merkle proofs but cannot submit on your behalf — only the recipient wallet's
   * ML-DSA-65 key authorizes a credit, and the signature covers the exact payload. Pass the result to
   * {@link submitRewardClaim}.
   *
   * @param nodeId    - On-chain node id
   * @param wallet    - Node wallet address (must match the on-chain registration)
   * @param signature - ML-DSA-65 signature over `"q<chainId>|claim_rewards:<nodeId>:<wallet>"`
   * @param publicKey - Hex-encoded 1952-byte ML-DSA-65 public key
   */
  async quoteRewardClaim(
    nodeId: string,
    wallet: string,
    signature: string,
    publicKey: string,
  ): Promise<RewardClaimQuote | null> {
    const res = await this.post<Record<string, unknown>>('/api/v1/rewards/claim', {
      node_id: nodeId,
      wallet_address: wallet,
      dilithium_signature: signature,
      dilithium_public_key: publicKey,
    });
    if (!res.needs_signature) {
      // Nothing claimable, or the node refused — surface its own reason.
      if (res.error) throw new Error(`QNetClient [quoteRewardClaim]: ${String(res.error)}`);
      return null;
    }
    return {
      claimsData: String(res.claims_data),
      signMessage: String(res.sign_message),
      claimTimestamp: Number(res.claim_timestamp),
      amountNano: String(res.amount_nano),
      epochsClaimed: Number(res.epochs_claimed ?? 0),
      lastClaimedEpoch: Number(res.last_claimed_epoch ?? 0),
      stoppedAtEpoch: res.stopped_at_epoch == null ? undefined : Number(res.stopped_at_epoch),
      stoppedReason: res.stopped_reason == null ? undefined : String(res.stopped_reason),
    };
  }

  /**
   * Step 2: submit the quoted batch, signed. `claimsData` and `claimTimestamp` MUST be echoed
   * unchanged — both are inside the signed message, and apply re-verifies the signature and every
   * merkle proof.
   */
  async submitRewardClaim(
    nodeId: string,
    wallet: string,
    signature: string,
    publicKey: string,
    quote: RewardClaimQuote,
    claimsSignature: string,
  ): Promise<RewardClaimResult> {
    return this.post<RewardClaimResult>('/api/v1/rewards/claim', {
      node_id: nodeId,
      wallet_address: wallet,
      dilithium_signature: signature,
      dilithium_public_key: publicKey,
      claims_data: quote.claimsData,
      claims_signature: claimsSignature,
      claim_timestamp: quote.claimTimestamp,
    });
  }

  /**
   * Both steps in one call. `sign` is invoked twice: once for the request-auth message and once for
   * the quoted payload. Returns `null` when there is nothing to claim.
   *
   * Verify the quote before signing if you do not fully trust the node you are talking to: an honest
   * batch is strictly ascending and starts just above `lastClaimedEpoch`.
   */
  async claimRewards(
    nodeId: string,
    wallet: string,
    publicKey: string,
    sign: DilithiumSigner,
  ): Promise<RewardClaimResult | null> {
    const authSig = await sign(`${QNET_CHAIN_TAG}claim_rewards:${nodeId}:${wallet}`);
    const quote = await this.quoteRewardClaim(nodeId, wallet, authSig, publicKey);
    if (!quote) return null;
    assertClaimMessageShape(quote.signMessage, wallet, quote.claimTimestamp);
    const claimsSignature = await sign(quote.signMessage);
    return this.submitRewardClaim(nodeId, wallet, authSig, publicKey, quote, claimsSignature);
  }

  // ── Testnet Faucet ────────────────────────────────────────────────────────

  /**
   * Request test tokens from the QNet testnet faucet.
   * Sends 1500 1DEV tokens + 0.001 SOL in one call.
   *
   * @param walletAddress - Recipient Solana devnet address (Base58)
   */
  async requestFaucetTokens(walletAddress: string): Promise<FaucetClaimResult> {
    return this.post<FaucetClaimResult>('/api/faucet/claim', {
      walletAddress,
      amount: 1500,
    });
  }

  // ── Contracts ─────────────────────────────────────────────────────────────

  /**
   * Deploy a WASM module as a contract. The node validates the module against the
   * deploy-time determinism rules before submitting the transaction, and derives the
   * contract address on-chain from `from` and `nonce`.
   */
  async deployContract(params: DeployContractParams): Promise<DeployContractResult> {
    return this.post<DeployContractResult>('/api/v1/wasm/deploy', {
      from:                  params.from,
      code:                  params.code,
      nonce:                 params.nonce,
      dilithium_signature:   params.dilithiumSignature,
      dilithium_public_key:  params.dilithiumPublicKey,
    });
  }

  /**
   * Submit a state-changing contract call. The signature is mandatory; the node
   * queues the transaction and it takes effect when the block applying it is produced.
   */
  async callContract(params: CallContractParams): Promise<ContractCallResult> {
    return this.post<ContractCallResult>('/api/v1/contract/call', {
      from:                 params.from,
      contract_address:     params.contractAddress,
      method:               params.method,
      args:                 params.args ?? '',
      gas_limit:            params.gasLimit ?? 1_000_000,
      gas_price:            params.gasPrice ?? 1_000,
      nonce:                params.nonce,
      dilithium_signature:  params.dilithiumSignature,
      dilithium_public_key: params.dilithiumPublicKey,
      is_view:              false,
    });
  }

  /**
   * Read from committed state without a transaction, signature or fee. The gas fields
   * are structurally required by the endpoint and are not charged for a view.
   */
  async viewContract(params: ViewContractParams): Promise<ContractViewResult> {
    return this.post<ContractViewResult>('/api/v1/contract/call', {
      from:             params.from,
      contract_address: params.contractAddress,
      method:           params.method,
      args:             params.args ?? [],
      gas_limit:        10_000,
      gas_price:        10,
      nonce:            0,
      is_view:          true,
    });
  }

  /**
   * Fetch contract events in block range `[from, to]`. The node caps the scan at 500
   * blocks and reports the height below which its log store has been pruned.
   */
  async getContractLogs(
    address: string,
    fromHeight: number,
    toHeight: number,
  ): Promise<ContractLogsResult> {
    return this.get<ContractLogsResult>(
      `/api/v1/logs?contract=${encodeURIComponent(address)}&from=${fromHeight}&to=${toHeight}`,
    );
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async get<T>(path: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      const res = await this.http.get<T>(path, config);
      return res.data;
    } catch (err) {
      throw this.wrapError(err, `GET ${path}`);
    }
  }

  private async post<T>(path: string, body: unknown, config?: AxiosRequestConfig): Promise<T> {
    try {
      const res = await this.http.post<T>(path, body, config);
      return res.data;
    } catch (err) {
      throw this.wrapError(err, `POST ${path}`);
    }
  }

  private wrapError(err: unknown, context: string): Error {
    if (axios.isAxiosError(err)) {
      const status  = err.response?.status ?? 'network error';
      const message = (err.response?.data as { error?: string })?.error ?? err.message;
      return new Error(`QNetClient [${context}] HTTP ${status}: ${message}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
