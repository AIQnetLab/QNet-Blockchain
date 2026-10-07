// Shapes of the transactions the shared builders return (applications/qnet-mobile/src/crypto/TxBuilders.js).
// Every integer is its exact decimal text: u64 values pass 2^53.

/** A u64 as decimal digits, no sign, no leading zeros. */
export type U64 = string;
/** A u64 given as a bigint, a safe integer or decimal digits. */
export type U64Input = bigint | number | string;

interface TxBase {
  readonly path: string;
  readonly from: string;
  readonly nonce: U64;
  readonly gasPrice: U64;
  readonly gasLimit: U64;
  /** The most the fee can be: (gasPrice + gasPrice / 2) x gasLimit, in nano-QNC. Unused gas is refunded. */
  readonly maxFeeNano: U64;
  /** The exact text the transaction signs. */
  readonly preimage: string;
}

export interface TransferTx extends TxBase {
  readonly kind: 'transfer';
  readonly to: string;
  readonly amountNano: U64;
}

export interface TokenTransferTx extends TxBase {
  readonly kind: 'tokenTransfer';
  readonly contract: string;
  readonly method: 'transfer';
  readonly args: readonly [string, U64];
  readonly to: string;
  /** Base units of the token. */
  readonly amount: U64;
  readonly callData: string;
  readonly intrinsicGas: U64;
}

export interface ContractCallTx extends TxBase {
  readonly kind: 'contractCall';
  readonly contract: string;
  readonly method: string;
  /** Call input as lowercase hex, or null for none. */
  readonly args: string | null;
  readonly callData: string;
  readonly intrinsicGas: U64;
  /** Gas left for the contract's code: gasLimit - intrinsicGas. */
  readonly fuel: U64;
}

export interface ContractDeployTx extends TxBase {
  readonly kind: 'contractDeploy';
  readonly codeSize: U64;
  readonly codeHash: string;
  readonly codeBase64: string;
  readonly deployData: string;
  readonly intrinsicGas: U64;
  /** Where the chain will place the contract: derived from the sender and the nonce. */
  readonly contractAddress: string;
}

export type Tx = TransferTx | TokenTransferTx | ContractCallTx | ContractDeployTx;

export interface TransferParams {
  from: string;
  to: string;
  amountNano: U64Input;
  nonce: U64Input;
  gasPrice?: U64Input;
  gasLimit?: U64Input;
}

export interface TokenTransferParams {
  from: string;
  token: string;
  to: string;
  /** Base units of the token (the decimal amount times 10^decimals). */
  amount: U64Input;
  nonce: U64Input;
  gasPrice?: U64Input;
  gasLimit?: U64Input | null;
}

export interface ContractCallParams {
  from: string;
  contract: string;
  method: string;
  /** Call input as even-length hex, or null. */
  args?: string | null;
  nonce: U64Input;
  gasPrice?: U64Input;
  /** Explicit gas limit; leave out to use the intrinsic gas plus `fuel`. */
  gasLimit?: U64Input | null;
  /** Fuel budget for the contract's code (default WASM_DEFAULT_FUEL). Not together with gasLimit. */
  fuel?: number | null;
}

export interface ContractDeployParams {
  from: string;
  code: Uint8Array;
  nonce: U64Input;
  gasPrice?: U64Input;
  gasLimit?: U64Input | null;
}

export interface TxRoute {
  readonly path: string;
  readonly maxBodyBytes: number;
}
