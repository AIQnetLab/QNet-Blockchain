// Fees as the chain charges them (core/qnet-state/src/transaction.rs): MIN_GAS_PRICE, gas_limits::TRANSFER and
// CONTRACT_CALL, effective_gas_price, gas_debit, the ContractCall intrinsic gas and the storage deposit.
export const NANO_PER_QNC = 1_000_000_000;
export const GAS_PRICE = 10;                    // MIN_GAS_PRICE, nanoQNC per gas
export const TRANSFER_GAS_LIMIT = 10_000;       // gas_limits::TRANSFER
export const CONTRACT_CALL_BASE_GAS = 100_000;  // gas_limits::CONTRACT_CALL
export const CONTRACT_CALL_GAS_PER_BYTE = 5;
export const STORAGE_DEPOSIT_NANO = 10_000_000; // refundable, per new QRC-20 balance entry
// The node's token and NFT deploy handlers set these; the deploy signature covers them.
export const DEPLOY_GAS_PRICE = 1000;
export const DEPLOY_GAS_LIMIT = 50_000;

// Every wallet TX carries an ML-DSA-65 signature, so the chain charges gas_price + gas_price/2 (u64 division).
export const effectiveGasPrice = (gasPrice) => gasPrice + Math.floor(gasPrice / 2);
export const feeNano = (gasPrice, gasLimit) => effectiveGasPrice(gasPrice) * gasLimit;
export const TRANSFER_FEE_NANO = feeNano(GAS_PRICE, TRANSFER_GAS_LIMIT); // 150_000
export const TRANSFER_FEE_QNC = TRANSFER_FEE_NANO / NANO_PER_QNC;        // 0.00015

// Apply refuses a call whose intrinsic gas exceeds its gas_limit; the intrinsic gas is the exact limit.
export const contractCallGasLimit = (dataByteLen) => CONTRACT_CALL_BASE_GAS + CONTRACT_CALL_GAS_PER_BYTE * dataByteLen;
