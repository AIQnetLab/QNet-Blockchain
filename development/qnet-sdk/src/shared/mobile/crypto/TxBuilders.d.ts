// Types of applications/qnet-mobile/src/crypto/TxBuilders.js, which build.mjs compiles into the SDK.
import type {
  ContractCallParams, ContractCallTx, ContractDeployParams, ContractDeployTx, TokenTransferParams, TokenTransferTx,
  TransferParams, TransferTx, TxRoute, U64Input,
} from '../../../types.js';

export const MAX_GAS_LIMIT: number;
export const DEPLOY_BASE_GAS: number;
export const DEPLOY_GAS_PER_BYTE: number;
export const MAX_WASM_CODE_BYTES: number;
export const WASM_DEFAULT_FUEL: number;
export const WASM_MIN_FUEL: number;
export const CANONICAL_BURN_ADDRESS: string;
export const TX_ROUTES: Readonly<{ transfer: TxRoute; call: TxRoute; deploy: TxRoute }>;

export class TxBuildError extends Error {
  code: string;
}

export function toU64String(value: U64Input): string;
export function contractCallData(contract: string, method: string, args: unknown): string;
export function contractCallIntrinsicGas(callData: string): number;
export function wasmCodeHash(code: Uint8Array): string;
export function contractDeployData(code: Uint8Array): string;
export function contractDeployIntrinsicGas(deployData: string): number;
export function deriveContractAddress(from: string, nonce: U64Input): string;
export function buildTransfer(params: TransferParams): TransferTx;
export function buildTokenTransfer(params: TokenTransferParams): TokenTransferTx;
export function buildContractCall(params: ContractCallParams): ContractCallTx;
export function buildContractDeploy(params: ContractDeployParams): ContractDeployTx;
export function transferRequestJson(tx: object, signatureHex: string, publicKeyHex?: string | null): string;
export function contractCallRequestJson(tx: object, signatureHex: string, publicKeyHex?: string | null): string;
export function contractDeployRequestJson(tx: object, signatureHex: string, publicKeyHex: string): string;
