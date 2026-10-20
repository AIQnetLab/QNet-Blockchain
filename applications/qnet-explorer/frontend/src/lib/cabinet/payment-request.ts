// What the activation page asks the user to send to a payment address: the activation price in 1DEV (ONE_DEV_MINT, the
// mint of the release's cluster) and the SOL the burn needs, one transfer each, for what the address still lacks of it.
// A phone opens a wallet app with the transfer's link (requestLink, PHONE_LINK); the QNet extension takes the same
// transfer as its provider request. Amounts are plain decimals in whole tokens. Pure.

import { FUNDING_SOL_LAMPORTS } from './burn-tx.ts';
import { ACTIVATION_NETWORK, ONE_DEV_DECIMALS, ONE_DEV_MINT, ONE_DEV_UNIT, SOL_DECIMALS } from '../one-dev.ts';
import { TRANSFER_LINK_PREFIX } from '../qnet-link.ts';
import type { SolanaTransfer } from '../qnet-provider.ts';

export const REQUEST_LABEL = 'QNet Blockchain node activation';

export type FundingToken = 'oneDev' | 'sol';
export const FUNDING_DECIMALS: Record<FundingToken, number> = { oneDev: ONE_DEV_DECIMALS, sol: SOL_DECIMALS };

// Base units of a token with `decimals` places as a plain decimal, without grouping or trailing zeros.
export function decimalAmount(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const fraction = (raw % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? `${raw / unit}` : `${raw / unit}.${fraction}`;
}

// The SOL the burn needs.
export const fundingSol = (): string => decimalAmount(FUNDING_SOL_LAMPORTS, SOL_DECIMALS);

// What the payment address still lacks of each token, in base units, from its balance read (none read yet: all of it).
export function fundingLeft(balance: { oneDev: bigint; sol: bigint } | null, price: number): Record<FundingToken, bigint> {
  const lack = (need: bigint, has: bigint): bigint => (has < need ? need - has : 0n);
  return { oneDev: lack(BigInt(price) * ONE_DEV_UNIT, balance?.oneDev ?? 0n), sol: lack(FUNDING_SOL_LAMPORTS, balance?.sol ?? 0n) };
}

// Which transfer has arrived, from the payment address's balance read: at least the amount asked.
export function fundingReceived(balance: { oneDev: bigint; sol: bigint } | null, price: number): Record<FundingToken, boolean> {
  const left = fundingLeft(balance, price);
  return { oneDev: balance !== null && left.oneDev === 0n, sol: balance !== null && left.sol === 0n };
}

// The transfer that brings the address what it still lacks of `token`; none once it lacks nothing.
export function fundingTransfer(address: string, token: FundingToken, left: bigint): SolanaTransfer | null {
  if (left <= 0n) return null;
  return { to: address, mint: token === 'oneDev' ? ONE_DEV_MINT : null, amount: decimalAmount(left, FUNDING_DECIMALS[token]) };
}

// The link a phone's button opens, one release constant: 'request' the standard solana: link (mainnet, any wallet app);
// 'transfer' QNet Wallet's transfer link (testnet, which only QNet Wallet opens, so no other cluster's wallet takes it).
export type PhoneLink = 'transfer' | 'request';
export const PHONE_LINK: PhoneLink = ACTIVATION_NETWORK === 'mainnet' ? 'request' : 'transfer';

// A phone's link for a transfer (docs/protocols/qnet-link-v1.md section 15 for the transfer link).
export function requestLink({ to, mint, amount }: SolanaTransfer, link: PhoneLink = PHONE_LINK): string {
  if (link === 'transfer') return `${TRANSFER_LINK_PREFIX}to=${to}${mint ? `&mint=${mint}` : ''}&amount=${amount}`;
  const query = [`amount=${amount}`, ...(mint ? [`spl-token=${mint}`] : []), `label=${encodeURIComponent(REQUEST_LABEL)}`];
  return `solana:${to}?${query.join('&')}`;
}

// The buttons the card shows: the extension's transfer once it takes it, on any device; else a phone's links; else
// none, and the manual way only.
export function fundingButtons(phone: boolean, extensionSends: boolean): 'extension' | 'links' | null {
  if (extensionSends) return 'extension';
  return phone ? 'links' : null;
}
