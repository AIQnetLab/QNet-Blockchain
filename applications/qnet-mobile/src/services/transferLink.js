/**
 * QNet Wallet's transfer link (docs/protocols/qnet-link-v1.md section 15): a page asks this app for one SOL or 1DEV
 * transfer with https://link.aiqnet.io/send#to=<address>[&mint=<mint>]&amount=<decimal>, a verified link only this app
 * opens (Android App Link, iOS Universal Link), so a test network's request never reaches a wallet of another network.
 * It is read strictly here, then by the QR scan's own reader (utils/solanaRequest solanaScanToForm) into the Solana
 * Send form, which the user reviews and confirms. The app registers no custom URL scheme, so no solana: link is read.
 */
import { decodeKey } from '../crypto/SolanaTx';
import { solanaScanToForm } from '../utils/solanaRequest';
import { SOLANA_TOKENS } from './SolanaSend';

const TRANSFER_PATH = 'https://link.aiqnet.io/send';
const TRANSFER_LINK_PREFIX = `${TRANSFER_PATH}#`;

// A plain decimal above zero in whole tokens, no trailing zero after the point (the extension's transfer rule).
const AMOUNT_RE = /^(0|[1-9]\d{0,19})(\.\d{0,17}[1-9])?$/;
// Room for the longest link (172 characters: both addresses at 44, the longest amount); a longer text is not read.
const MAX_LINK = 200;

/** Whether a URL names the transfer link's path (whatever follows it): such a URL is never a QNet Link request. */
export function isTransferLink(url) {
  if (typeof url !== 'string' || !url.startsWith(TRANSFER_PATH)) return false;
  const next = url.charAt(TRANSFER_PATH.length);
  return next === '' || next === '#' || next === '?' || next === '/';
}

/**
 * { to, mint, amount } of a transfer link, mint null for SOL; null for anything else: the whole string, no decoding,
 * the keys to, mint (optional) and amount each once in that order and no other, addresses base58 of 32 bytes.
 */
export function parseTransferLink(url) {
  if (typeof url !== 'string' || url.length > MAX_LINK || !url.startsWith(TRANSFER_LINK_PREFIX)) return null;
  const pairs = url.slice(TRANSFER_LINK_PREFIX.length).split('&');
  const keys = pairs.length === 3 ? ['to', 'mint', 'amount'] : ['to', 'amount'];
  if (pairs.length !== keys.length) return null;
  const v = {};
  for (let i = 0; i < keys.length; i++) {
    const parts = pairs[i].split('=');
    if (parts.length !== 2 || parts[0] !== keys[i]) return null;
    v[keys[i]] = parts[1];
  }
  if (!decodeKey(v.to) || (v.mint !== undefined && !decodeKey(v.mint))) return null;
  if (!AMOUNT_RE.test(v.amount) || v.amount === '0') return null;
  return { to: v.to, mint: v.mint === undefined ? null : v.mint, amount: v.amount };
}

/**
 * What a URL the system handed over asks of the Solana Send form: solanaScanToForm's { value } or { note }, or null
 * when it is not a transfer request (a QNet Link URL among them). A transfer link that does not parse is
 * `scan_request_invalid`; its mint and its amount are judged by the scan's reader (token held, the token's decimals).
 */
export function readTransferLink(url) {
  if (isTransferLink(url)) {
    const r = parseTransferLink(url);
    if (!r) return { note: 'scan_request_invalid' };
    return solanaScanToForm(`solana:${r.to}?amount=${r.amount}${r.mint ? `&spl-token=${r.mint}` : ''}`, SOLANA_TOKENS);
  }
  return null;
}
