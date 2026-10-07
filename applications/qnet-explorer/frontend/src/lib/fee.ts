// The fee the chain debits (core/qnet-state transaction.rs gas_debit): an ML-DSA-signed TX pays
// gas_price + gas_price/2 (integer division) per unit of gas; a system TX pays nothing.
export function chainFeeNano(gasPrice: number, gasLimit: number, quantumSigned: boolean): number {
  if (!(gasPrice > 0) || !(gasLimit > 0)) return 0;
  const effective = quantumSigned ? gasPrice + Math.floor(gasPrice / 2) : gasPrice;
  return effective * gasLimit;
}

export function chainFeeNanoBig(gasPrice: bigint, gasLimit: bigint, quantumSigned: boolean): bigint {
  const effective = quantumSigned ? gasPrice + gasPrice / BigInt(2) : gasPrice;
  return effective * gasLimit;
}
