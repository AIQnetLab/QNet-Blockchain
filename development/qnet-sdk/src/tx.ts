// The wallet transaction builders, compiled from their one source (applications/qnet-mobile/src/crypto/TxBuilders.js)
// with failures as QNetError, plus signing and the exact request body. Known answers: the app's
// __vectors__/tx-vectors.json, checked by test/vectors.test.mjs against this build.
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import * as builders from '#mobile/crypto/TxBuilders.js';
import { QNET_CHAIN_TAG, eonFromPublicKeyBytes, isValidQnetAddress as isEon } from '#mobile/crypto/WalletIdentity.js';
import { GAS_PRICE, STORAGE_DEPOSIT_NANO, TRANSFER_GAS_LIMIT } from '#mobile/config/fees.js';
import { QNetError, mapped } from './errors.js';
import type {
  ContractCallParams, ContractCallTx, ContractDeployParams, ContractDeployTx, TokenTransferParams, TokenTransferTx,
  TransferParams, TransferTx, Tx, TxRoute, U64Input,
} from './types.js';

export const CHAIN_TAG: string = QNET_CHAIN_TAG;
export const MAX_GAS_LIMIT: number = builders.MAX_GAS_LIMIT;
export const DEPLOY_BASE_GAS: number = builders.DEPLOY_BASE_GAS;
export const DEPLOY_GAS_PER_BYTE: number = builders.DEPLOY_GAS_PER_BYTE;
export const MAX_WASM_CODE_BYTES: number = builders.MAX_WASM_CODE_BYTES;
export const WASM_DEFAULT_FUEL: number = builders.WASM_DEFAULT_FUEL;
export const WASM_MIN_FUEL: number = builders.WASM_MIN_FUEL;
export const CANONICAL_BURN_ADDRESS: string = builders.CANONICAL_BURN_ADDRESS;
export const TX_ROUTES: Readonly<{ transfer: TxRoute; call: TxRoute; deploy: TxRoute }> = builders.TX_ROUTES;
export const MIN_GAS_PRICE: number = GAS_PRICE;
export const TRANSFER_GAS: number = TRANSFER_GAS_LIMIT;
/** Refundable QNC a token transfer moves to escrow when the recipient holds none of the token yet. */
export const TOKEN_ENTRY_DEPOSIT_NANO: number = STORAGE_DEPOSIT_NANO;

export const ML_DSA65_SIZES = Object.freeze({ publicKey: 1952, secretKey: 4032, signature: 3309 });

export const isValidAddress = (value: unknown): value is string => isEon(value);
export const addressFromPublicKey: (publicKey: Uint8Array) => string = mapped((publicKey: Uint8Array) => {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== ML_DSA65_SIZES.publicKey) throw new QNetError('INVALID_PUBLIC_KEY');
  return eonFromPublicKeyBytes(publicKey);
});

export const toU64String: (value: U64Input) => string = mapped(builders.toU64String);
export const contractCallData: (contract: string, method: string, args: string | null | readonly (string | number)[]) => string =
  mapped(builders.contractCallData);
export const contractCallIntrinsicGas: (callData: string) => number = mapped(builders.contractCallIntrinsicGas);
export const wasmCodeHash: (code: Uint8Array) => string = mapped(builders.wasmCodeHash);
export const contractDeployData: (code: Uint8Array) => string = mapped(builders.contractDeployData);
export const contractDeployIntrinsicGas: (deployData: string) => number = mapped(builders.contractDeployIntrinsicGas);
export const deriveContractAddress: (from: string, nonce: U64Input) => string = mapped(builders.deriveContractAddress);

export const buildTransfer: (params: TransferParams) => TransferTx = mapped(builders.buildTransfer);
export const buildTokenTransfer: (params: TokenTransferParams) => TokenTransferTx = mapped(builders.buildTokenTransfer);
export const buildContractCall: (params: ContractCallParams) => ContractCallTx = mapped(builders.buildContractCall);
export const buildContractDeploy: (params: ContractDeployParams) => ContractDeployTx = mapped(builders.buildContractDeploy);

const hexOf = (bytes: Uint8Array, length: number, code: string): string => {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new QNetError(code);
  return bytesToHex(bytes);
};

/**
 * The exact JSON the node's route for `tx` reads. The public key rides along until the chain holds it (pass null
 * once the account's `hasPublicKey` is true); a deploy always carries it.
 */
export const requestBody: (tx: Tx, signature: Uint8Array, publicKey: Uint8Array | null) => string = mapped(
  (tx: Tx, signature: Uint8Array, publicKey: Uint8Array | null) => {
    const sig = hexOf(signature, ML_DSA65_SIZES.signature, 'INVALID_SIGNATURE');
    const pk = publicKey === null ? null : hexOf(publicKey, ML_DSA65_SIZES.publicKey, 'INVALID_PUBLIC_KEY');
    switch (tx?.kind) {
      case 'transfer':
        return builders.transferRequestJson(tx, sig, pk);
      case 'tokenTransfer':
      case 'contractCall':
        return builders.contractCallRequestJson(tx, sig, pk);
      case 'contractDeploy':
        if (pk === null) throw new QNetError('INVALID_PUBLIC_KEY');
        return builders.contractDeployRequestJson(tx, sig, pk);
      default:
        throw new QNetError('INVALID_CALL');
    }
  },
);

// The transaction the builders make from `tx`'s own fields: what is signed is always their text, never a caller's.
const rebuilt = mapped((tx: Tx): Tx => {
  const common = { from: tx.from, nonce: tx.nonce, gasPrice: tx.gasPrice, gasLimit: tx.gasLimit };
  switch (tx?.kind) {
    case 'transfer':
      return builders.buildTransfer({ ...common, to: tx.to, amountNano: tx.amountNano });
    case 'tokenTransfer':
      return builders.buildTokenTransfer({ ...common, token: tx.contract, to: tx.to, amount: tx.amount });
    case 'contractCall':
      return builders.buildContractCall({ ...common, contract: tx.contract, method: tx.method, args: tx.args });
    case 'contractDeploy':
      return builders.buildContractDeploy({ ...common, code: base64Bytes(tx.codeBase64) });
    default:
      throw new QNetError('INVALID_CALL');
  }
});

function base64Bytes(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new QNetError('INVALID_CODE');
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * ML-DSA-65 over the transaction's preimage (FIPS 204, empty context: what the node verifies), with the key checked
 * against `tx.from` first and the signature checked after. The preimage is rebuilt from the fields by the shared
 * builders and must equal `tx.preimage`.
 */
export function signTransaction(tx: Tx, secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== ML_DSA65_SIZES.secretKey) throw new QNetError('INVALID_ENTROPY');
  if (addressFromPublicKey(publicKey) !== tx?.from) throw new QNetError('KEY_ADDRESS_MISMATCH');
  if (typeof tx.preimage !== 'string' || rebuilt(tx).preimage !== tx.preimage || !tx.preimage.startsWith(QNET_CHAIN_TAG)) {
    throw new QNetError('INVALID_CALL');
  }
  const message = utf8ToBytes(tx.preimage);
  const signature = ml_dsa65.sign(message, secretKey);
  if (signature.length !== ML_DSA65_SIZES.signature || !ml_dsa65.verify(signature, message, publicKey)) {
    throw new QNetError('SIGNATURE_SELF_CHECK_FAILED');
  }
  return signature;
}

/**
 * Whether `signature` is `publicKey`'s signature of `tx` as the node checks it: the node verifies the text it rebuilds
 * from the request's fields, so the transaction is rebuilt here from `tx`'s own fields by the shared builders, every
 * field of the rebuilt one (the signed text `preimage` among them) must equal `tx`'s, and eon(pk) must be `from`. A
 * transaction whose fields say something other than what was signed is false, whatever its `preimage`.
 */
export function verifyTransactionSignature(tx: Tx, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    if (addressFromPublicKey(publicKey) !== tx.from) return false;
    if (typeof tx.preimage !== 'string' || !tx.preimage.startsWith(QNET_CHAIN_TAG)) return false;
    const fields = tx as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(rebuilt(tx))) {
      if (JSON.stringify(fields[key]) !== JSON.stringify(value)) return false;
    }
    return ml_dsa65.verify(signature, utf8ToBytes(tx.preimage), publicKey);
  } catch {
    return false;
  }
}
