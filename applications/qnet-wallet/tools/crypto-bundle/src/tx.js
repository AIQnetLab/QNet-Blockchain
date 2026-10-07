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
  CANONICAL_BURN_ADDRESS, DEPLOY_BASE_GAS, DEPLOY_GAS_PER_BYTE, MAX_GAS_LIMIT, MAX_WASM_CODE_BYTES, TX_ROUTES,
  WASM_DEFAULT_FUEL, WASM_MIN_FUEL,
} = builders;

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
