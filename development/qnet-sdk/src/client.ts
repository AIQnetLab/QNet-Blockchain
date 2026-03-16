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
  FaucetClaimResult,
} from './types';
import type {
  DeployContractParams,
  DeployContractResult,
  CallContractParams,
  ContractCallResult,
  ContractLog,
} from './contract';

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
   * Claim pending rewards.
   *
   * @param address       - Node wallet address
   * @param signature     - Dilithium3 (ML-DSA-65) signature over `"CLAIM_REWARDS:<address>"`
   * @param signatureType - default `"dilithium3"`
   */
  async claimRewards(
    address: string,
    signature: string,
    signatureType: 'dilithium3' | 'ed25519' = 'dilithium3',
  ): Promise<RewardClaimResult> {
    return this.post<RewardClaimResult>('/api/v1/rewards/claim', {
      address,
      signature,
      signatureType,
    });
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
   * Deploy a new contract to the QNet PQ-EVM.
   * Returns the deployed contract address and transaction hash.
   */
  async deployContract(params: DeployContractParams): Promise<DeployContractResult> {
    return this.post<DeployContractResult>('/api/v1/contract/deploy', {
      from:            params.from,
      bytecode:        params.bytecode,
      constructorArgs: params.constructorArgs ?? '',
      gasLimit:        params.gasLimit ?? 5_000_000,
      value:           params.value ?? '0',
      signature:       params.signature,
    });
  }

  /**
   * Execute a read-only contract call (no transaction, no gas cost).
   */
  async callContract(params: CallContractParams): Promise<ContractCallResult> {
    return this.post<ContractCallResult>('/api/v1/contract/call', {
      to:       params.contractAddress,
      from:     params.from,
      data:     params.calldata,
      gasLimit: params.gasLimit ?? 1_000_000,
      value:    params.value ?? '0',
    });
  }

  /**
   * Send a signed state-mutating call to a deployed contract.
   */
  async sendContractCall(params: CallContractParams & { signature: string }): Promise<ContractCallResult> {
    return this.post<ContractCallResult>('/api/v1/contract/send', {
      to:        params.contractAddress,
      from:      params.from,
      data:      params.calldata,
      gasLimit:  params.gasLimit ?? 1_000_000,
      value:     params.value ?? '0',
      signature: params.signature,
    });
  }

  /**
   * Fetch contract event logs for a given address in block range `[from, to]`.
   */
  async getContractLogs(
    address: string,
    fromHeight: number,
    toHeight: number,
  ): Promise<ContractLog[]> {
    return this.get<ContractLog[]>(
      `/api/v1/contract/${address}/logs?from=${fromHeight}&to=${toHeight}`,
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
