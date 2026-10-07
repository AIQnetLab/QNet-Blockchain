// @aiqnet/sdk: runs in web pages and in Node. Pages connect to the user's QNet wallet (findWallet) and never hold keys;
// servers verify wallet sign-ins (verifySignIn). The node client and key files are in '@aiqnet/sdk/node'.
export {
  QNetError, QNetNodeError, QNetProviderError, PROVIDER_ERROR_CODES,
} from './errors.js';
export {
  findWallet, QNetWallet, WALLET_RDNS,
  type MessageSignature, type SendResult, type TransactionStatus, type WalletAccounts, type WalletChannel, type WalletProvider,
} from './provider.js';
export {
  createNonceStore, createSignInMessage, createSignInNonce, parseSignInMessage, verifySignIn, QNET_CHAIN_ID,
  NONCE_BINDING_MAX_CHARS, NONCE_BINDING_MIN_CHARS, SIGNIN_DEFAULT_TTL_MS, SIGNIN_MAX_VALIDITY_MS,
  type NonceStore, type SignedSignIn, type SignInFields, type SignInMessageInput, type VerifySignInOptions,
} from './signin.js';
export {
  addressFromPublicKey, buildContractCall, buildContractDeploy, buildTokenTransfer, buildTransfer, CANONICAL_BURN_ADDRESS,
  CHAIN_TAG, contractCallData, contractCallIntrinsicGas, contractDeployData, contractDeployIntrinsicGas, DEPLOY_BASE_GAS,
  DEPLOY_GAS_PER_BYTE, deriveContractAddress, isValidAddress, MAX_GAS_LIMIT, MAX_WASM_CODE_BYTES, MIN_GAS_PRICE,
  ML_DSA65_SIZES, requestBody, signTransaction, TOKEN_ENTRY_DEPOSIT_NANO, toU64String, TRANSFER_GAS, TX_ROUTES,
  verifyTransactionSignature, WASM_DEFAULT_FUEL, WASM_MIN_FUEL, wasmCodeHash,
} from './tx.js';
export {
  generateEntropy, isValidRecoveryPhrase, keypairFromEntropy, keypairFromRecoveryPhrase, recoveryPhraseToEntropy,
  type QNetKeypair,
} from './keys.js';
export { formatUnits, parseUnits, QNC_DECIMALS } from './units.js';
export {
  checkModule, HOST_FUNCTIONS, VM_MAX_CODE_BYTES, VM_MAX_FUNCTIONS, VM_MAX_MEMORY_PAGES,
  type ModuleCheck, type ModuleReport,
} from './wasm.js';
export type {
  ContractCallParams, ContractCallTx, ContractDeployParams, ContractDeployTx, TokenTransferParams, TokenTransferTx,
  TransferParams, TransferTx, Tx, TxRoute, U64, U64Input,
} from './types.js';
