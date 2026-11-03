// Transaction builders compiled from the mobile source (crypto/TxBuilders.js), the one copy the app and the SDK use
// too. Their failures reach callers as CoreError with the same code.
import * as builders from '../../../../qnet-mobile/src/crypto/TxBuilders.js';
import { CoreError } from './errors.js';

const asCore = (fn) => (...args) => {
  try {
    return fn(...args);
  } catch (error) {
    if (error instanceof builders.TxBuildError) throw new CoreError(error.code);
    throw error;
  }
};

export const {
  CANONICAL_BURN_ADDRESS, DEPLOY_BASE_GAS, DEPLOY_GAS_PER_BYTE, EXPIRY_REFUSALS, MAX_GAS_LIMIT, MAX_TX_LIFETIME_BLOCKS,
  MAX_WASM_CODE_BYTES, TX_ROUTES, TX_V2_LIFETIME_BLOCKS, WASM_DEFAULT_FUEL, WASM_MIN_FUEL,
} = builders;

// The V2 form (a signed last height): which form a transaction signs from a node's account answer, the typed refusals
// and their one re-sign, the last height a stored body signed, and the height that ends it.
export const txExpiryFromAccount = asCore(builders.txExpiryFromAccount);
export const expiryRefusalOf = asCore(builders.expiryRefusalOf);
export const resignFormOf = asCore(builders.resignFormOf);
export const validUntilOf = asCore(builders.validUntilOf);
export const expiredAt = asCore(builders.expiredAt);
// The one V2 expiry every signer and the worker build (this build's network id, the height checked; null is V1).
export const expiryAt = asCore(builders.expiryAt);

export const toU64String = asCore(builders.toU64String);
export const contractCallData = asCore(builders.contractCallData);
export const contractCallIntrinsicGas = asCore(builders.contractCallIntrinsicGas);
export const contractDeployData = asCore(builders.contractDeployData);
export const contractDeployIntrinsicGas = asCore(builders.contractDeployIntrinsicGas);
export const wasmCodeHash = asCore(builders.wasmCodeHash);
export const deriveContractAddress = asCore(builders.deriveContractAddress);
export const buildTransfer = asCore(builders.buildTransfer);
export const buildTokenTransfer = asCore(builders.buildTokenTransfer);
export const buildContractCall = asCore(builders.buildContractCall);
export const buildContractDeploy = asCore(builders.buildContractDeploy);
export const transferRequestJson = asCore(builders.transferRequestJson);
export const contractCallRequestJson = asCore(builders.contractCallRequestJson);
export const contractDeployRequestJson = asCore(builders.contractDeployRequestJson);
