import { QNetClient } from './client';
import { QNetAddress, Transaction } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// QNet Contract Interaction
// ─────────────────────────────────────────────────────────────────────────────

export interface DeployContractParams {
  /** Hex-encoded contract bytecode (init-code) */
  bytecode: string;
  /** ABI-encoded constructor arguments, if any */
  constructorArgs?: string;
  /** Deployer wallet address */
  from: QNetAddress;
  /** Hex-encoded Dilithium3 (ML-DSA-65) signature over the deployment payload */
  signature: string;
  /** Gas limit for deployment (default 5_000_000) */
  gasLimit?: number;
  /** Optional QNC value to send with the deployment */
  value?: string;
}

export interface CallContractParams {
  /** Deployed contract address */
  contractAddress: QNetAddress;
  /** Hex-encoded ABI calldata (function selector + encoded args) */
  calldata: string;
  /** Caller wallet address */
  from: QNetAddress;
  /** Hex-encoded Dilithium3 (ML-DSA-65) signature over the call payload */
  signature?: string;
  gasLimit?: number;
  /** QNC value attached to the call */
  value?: string;
}

export interface ContractCallResult {
  txHash: string;
  blockHeight: number;
  gasUsed: number;
  returnData: string;   // hex-encoded return bytes
  logs: ContractLog[];
  status: 'success' | 'reverted';
  revertReason?: string;
}

export interface ContractLog {
  address: QNetAddress;
  topics: string[];
  data: string;
  blockHeight: number;
  txHash: string;
}

export interface DeployContractResult {
  contractAddress: QNetAddress;
  txHash: string;
  blockHeight: number;
  gasUsed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calldata encoding helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a QNet-native function selector + arguments into calldata.
 *
 * QNet uses a simple encoding:
 *   [0..4]   4-byte selector (big-endian u32)
 *   [4..]    ABI-packed arguments
 *
 * @example
 * // Call transfer(to, amount) with selector 0x00000001
 * const calldata = encodeCalldata(1, [
 *   { type: 'address', value: '19chex...' },
 *   { type: 'uint64',  value: 1_000_000_000n },
 * ]);
 */
export function encodeCalldata(
  selector: number,
  args: Array<{ type: 'uint64' | 'address' | 'bytes' | 'bool'; value: unknown }>,
): string {
  const parts: number[] = [];

  // 4-byte selector
  parts.push(
    (selector >>> 24) & 0xFF,
    (selector >>> 16) & 0xFF,
    (selector >>>  8) & 0xFF,
     selector         & 0xFF,
  );

  for (const arg of args) {
    switch (arg.type) {
      case 'uint64': {
        const n = BigInt(String(arg.value));
        for (let shift = 56n; shift >= 0n; shift -= 8n) {
          parts.push(Number((n >> shift) & 0xFFn));
        }
        break;
      }
      case 'bool': {
        parts.push(arg.value ? 1 : 0);
        break;
      }
      case 'address': {
        const hex = String(arg.value).replace(/^0x/, '');
        for (let i = 0; i < hex.length; i += 2) {
          parts.push(parseInt(hex.slice(i, i + 2), 16));
        }
        break;
      }
      case 'bytes': {
        const hex = String(arg.value).replace(/^0x/, '');
        const len = hex.length / 2;
        // prepend 4-byte length
        parts.push((len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF);
        for (let i = 0; i < hex.length; i += 2) {
          parts.push(parseInt(hex.slice(i, i + 2), 16));
        }
        break;
      }
    }
  }

  return '0x' + parts.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decode a uint64 value from the start of a hex return-data string.
 */
export function decodeUint64(returnData: string): bigint {
  const hex = returnData.replace(/^0x/, '').slice(0, 16).padStart(16, '0');
  return BigInt('0x' + hex);
}

/**
 * Decode a bool value from return data (last byte).
 */
export function decodeBool(returnData: string): boolean {
  const hex = returnData.replace(/^0x/, '');
  return hex.slice(-2) === '01';
}

// ─────────────────────────────────────────────────────────────────────────────
// ContractHandle — bound to a deployed contract address
// ─────────────────────────────────────────────────────────────────────────────

/**
 * High-level handle for interacting with a deployed QNet contract.
 *
 * @example
 * const token = new ContractHandle(client, '19chex...contractAddress...');
 *
 * // Read balance
 * const result = await token.call({
 *   calldata: encodeCalldata(4, [{ type: 'address', value: myAddress }]),
 *   from: myAddress,
 * });
 * const balance = decodeUint64(result.returnData);
 *
 * // Write — transfer tokens
 * const tx = await token.send({
 *   calldata: encodeCalldata(1, [
 *     { type: 'address', value: recipientAddress },
 *     { type: 'uint64',  value: 500_000_000n },
 *   ]),
 *   from: myAddress,
 *   signature: myDilithiumSig,
 * });
 */
export class ContractHandle {
  constructor(
    private readonly client: QNetClient,
    public readonly address: QNetAddress,
  ) {}

  /**
   * Read-only call — does not create a transaction.
   * Executes the contract locally and returns the result.
   */
  async call(params: Omit<CallContractParams, 'contractAddress'>): Promise<ContractCallResult> {
    return this.client.callContract({ ...params, contractAddress: this.address });
  }

  /**
   * State-mutating call — broadcasts a signed transaction.
   * `params.signature` is required.
   */
  async send(params: Omit<CallContractParams, 'contractAddress'> & { signature: string }): Promise<ContractCallResult> {
    return this.client.sendContractCall({ ...params, contractAddress: this.address });
  }

  /**
   * Fetch all logs emitted by this contract in block range `[from, to]`.
   */
  async getLogs(fromHeight: number, toHeight: number): Promise<ContractLog[]> {
    return this.client.getContractLogs(this.address, fromHeight, toHeight);
  }
}
