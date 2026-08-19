import { QNetClient } from './client';
import { QNetAddress } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// QNet Contract Interaction
//
// QNet executes WebAssembly modules in a deterministic interpreter. A contract
// exports entry functions typed () -> (); a call selects one by NAME and passes
// opaque argument bytes. See docs/developers/smart-contracts.md.
// ─────────────────────────────────────────────────────────────────────────────

export interface DeployContractParams {
  /** Deployer wallet address */
  from: QNetAddress;
  /** Hex-encoded WASM module bytes */
  code: string;
  /** Replay-protection nonce, bound into the signed message */
  nonce: number;
  /**
   * Hex-encoded ML-DSA-65 signature over
   * `q{chainId}|contract_deploy:{from}:{sha3_256(module bytes)}:{nonce}`
   */
  dilithiumSignature: string;
  /** Hex-encoded ML-DSA-65 public key; its EON address must equal `from` */
  dilithiumPublicKey: string;
}

export interface CallContractParams {
  /** Deployed contract address */
  contractAddress: QNetAddress;
  /** Caller wallet address */
  from: QNetAddress;
  /** Exported entry function to run (defaults to `run` on the node) */
  method: string;
  /** Arguments: a hex string of the opaque bytes the contract reads with `get_call_args` */
  args?: string;
  /** Replay-protection nonce, bound into the signed message */
  nonce: number;
  /** Gas limit; the interpreter's fuel is what remains after the intrinsic gas */
  gasLimit?: number;
  /** Gas price in nanoQNC per gas unit */
  gasPrice?: number;
  /**
   * Hex-encoded ML-DSA-65 signature over
   * `q{chainId}|contract_call:{from}:{sha3_256(calldata bytes)}:{nonce}`.
   * Required for a state-changing call, unused by a view.
   */
  dilithiumSignature?: string;
  /** Hex-encoded ML-DSA-65 public key; may be omitted once committed on-chain */
  dilithiumPublicKey?: string;
}

/** Response of a submitted state-changing call: the transaction is queued, not yet applied. */
export interface ContractCallResult {
  success: boolean;
  tx_hash?: string;
  contract_address?: QNetAddress;
  method?: string;
  gas_limit?: number;
  message?: string;
  error?: string;
}

export interface ViewContractParams {
  /** Deployed contract address */
  contractAddress: QNetAddress;
  /** Caller wallet address; some token reads default to it */
  from: QNetAddress;
  /** `storageGet` reads one storage key; token targets accept their own read methods */
  method: string;
  /** Positional string arguments the view handlers read */
  args?: string[];
}

/** Response of a read-only call (`is_view: true`), answered from committed state. */
export interface ContractViewResult {
  success: boolean;
  is_view: boolean;
  contract_address: QNetAddress;
  method: string;
  /** Handler-shaped value: a storage read, a token field, or an error object */
  result: unknown;
  gas_used: number;
}

/** One persisted event, as returned by `GET /api/v1/logs`. */
export interface ContractLog {
  height: number;
  tx_hash: string;
  contract: QNetAddress;
  /** Hex-encoded payload passed to `emit_log` */
  data: string;
}

export interface ContractLogsResult {
  success: boolean;
  from: number;
  to: number;
  /** Lowest height whose logs this node still holds */
  oldest_available: number;
  /** Set when the request reached below the prune floor: results under it are incomplete */
  pruned_below?: number;
  count: number;
  logs: ContractLog[];
}

export interface DeployContractResult {
  success: boolean;
  tx_hash?: string;
  contract?: { contract_address: QNetAddress; creator: QNetAddress };
  message?: string;
  error?: string;
  details?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Byte helpers
//
// Contract arguments travel as a hex string and are hex-decoded into the bytes
// the contract reads; event payloads and return data come back hex-encoded.
// The meaning of those bytes is defined by the contract, not by the protocol.
// ─────────────────────────────────────────────────────────────────────────────

/** Hex-encode argument bytes for `CallContractParams.args`. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Decode a hex payload (with or without a `0x` prefix) into bytes. */
export function fromHex(hex: string): Uint8Array {
  const body = hex.replace(/^0x/, '');
  if (body.length % 2 !== 0 || /[^0-9a-fA-F]/.test(body)) {
    throw new Error('Not a hex string');
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ContractHandle — bound to a deployed contract address
// ─────────────────────────────────────────────────────────────────────────────

/**
 * High-level handle for interacting with a deployed QNet WASM contract.
 *
 * @example
 * const counter = new ContractHandle(client, '19chex...contractAddress...');
 *
 * // Run the "run" entry point (state-changing, signed)
 * await counter.send({
 *   from: myAddress,
 *   method: 'run',
 *   nonce: myNextNonce,
 *   dilithiumSignature: mySignature,
 * });
 *
 * // Read the counter back from the event it emitted
 * const logs = await counter.getLogs(fromHeight, toHeight);
 * const value = fromHex(logs.logs[0].data).slice(0, 8);
 */
export class ContractHandle {
  constructor(
    private readonly client: QNetClient,
    public readonly address: QNetAddress,
  ) {}

  /** Read one storage key from committed state. No signature, no transaction. */
  async storageGet(key: string, from: QNetAddress): Promise<ContractViewResult> {
    return this.client.viewContract({
      contractAddress: this.address,
      from,
      method: 'storageGet',
      args: [key],
    });
  }

  /** State-changing call — submits a signed transaction to the mempool. */
  async send(
    params: Omit<CallContractParams, 'contractAddress'> & { dilithiumSignature: string },
  ): Promise<ContractCallResult> {
    return this.client.callContract({ ...params, contractAddress: this.address });
  }

  /** Events emitted by this contract in block range `[from, to]` (at most 500 blocks). */
  async getLogs(fromHeight: number, toHeight: number): Promise<ContractLogsResult> {
    return this.client.getContractLogs(this.address, fromHeight, toHeight);
  }
}
