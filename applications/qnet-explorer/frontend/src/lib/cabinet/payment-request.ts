// What the activation page asks the user to send to a payment address, as standard payment request texts for a QR
// code: `solana:<address>?amount=<amount>&spl-token=<mint>&label=QNet%20activation` for the 1DEV (the mint of the
// release's cluster), and the same without `spl-token` for the SOL. A wallet that scans one fills in the address, the
// token and the amount; one request carries one token, so the SOL has a code of its own. Amounts are decimal, in whole
// tokens, as the request form writes them. Pure.

import { FUNDING_SOL_LAMPORTS } from './burn-tx.ts';
import { ONE_DEV_MINT, SOL_DECIMALS } from '../one-dev.ts';

export const REQUEST_LABEL = 'QNet activation';

// Base units of a token with `decimals` places as a plain decimal, without grouping or trailing zeros.
export function decimalAmount(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const fraction = (raw % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? `${raw / unit}` : `${raw / unit}.${fraction}`;
}

export function paymentRequest(address: string, amount: string, splToken: string | null = null): string {
  const query = [`amount=${amount}`, ...(splToken ? [`spl-token=${splToken}`] : []), `label=${encodeURIComponent(REQUEST_LABEL)}`];
  return `solana:${address}?${query.join('&')}`;
}

// The activation price in 1DEV to the payment address.
export const oneDevRequest = (address: string, price: number): string => paymentRequest(address, String(price), ONE_DEV_MINT);

// The SOL the burn needs, to the payment address.
export const fundingSol = (): string => decimalAmount(FUNDING_SOL_LAMPORTS, SOL_DECIMALS);
export const solRequest = (address: string): string => paymentRequest(address, fundingSol());
