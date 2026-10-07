/**
 * What the QR scan of the Solana Send screen takes: a Solana address, or the standard payment-request text
 * `solana:<address>` with optional query parameters. The request's parameters read here:
 *   amount     a plain decimal in whole units of the token (never an exponent, a sign or a leading dot)
 *   spl-token  the mint of the token asked for; without it the request asks for SOL
 *   reference  up to four addresses the payee finds its payment by; they go into the transfer as read-only accounts
 *   memo       a short text the payee asked to be written with the transfer; it is shown on the review; not empty, at
 *              most 200 bytes of UTF-8, well-formed (no lone surrogate), no control or text-direction character
 * `label` and `message` are ignored: nothing a code carries is shown as a name or opened as a link. Any other parameter
 * is ignored. Anything that is not an address or such a request (a web address, a request whose recipient is a link,
 * any other text) is "Not a Solana address"; a request with a malformed or repeated parameter cannot be read at all.
 * The form is only filled in: the user still reviews and confirms the send, and nothing read is ever opened.
 */
import { decodeKey, toBaseUnits, fromBaseUnits } from '../crypto/SolanaTx';

// Room for a request with every parameter; a longer text is refused before anything is parsed.
const MAX_SCAN_TEXT = 2048;
export const MAX_REFERENCES = 4;
export const MAX_MEMO_BYTES = 200;
const AMOUNT_RE = /^\d{1,20}(?:\.\d{1,30})?$/;
// Control characters and the marks that reorder text on screen: a memo holding one could show other text than it is.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

const utf8Length = (s) => {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};

// A lone surrogate half, which only raw pasted or scanned text can hold (a %-escape of one never decodes): its UTF-8
// is U+FFFD, not the text shown. for..of yields a well-formed pair as one code point, so any surrogate seen is alone.
const hasLoneSurrogate = (s) => {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0xd800 && c <= 0xdfff) return true;
  }
  return false;
};

// A query part as form encoding writes it: '+' is a space (a '+' itself comes as %2B), so a memo "order 42" encoded
// as "order+42" is written into the transfer as the payee asked for it.
const decode = (part) => {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch (_) {
    return null;
  }
};

/**
 * { ok: true, address, amount, mint, references, memo, request } for an address (request false) or a payment request
 * (request true); { ok: false, reason: 'not_solana' | 'invalid' } otherwise. `amount` is the request's decimal text,
 * or null when it names none or zero.
 */
export function parseSolanaScan(text) {
  if (typeof text !== 'string' || text.length > MAX_SCAN_TEXT) return { ok: false, reason: 'not_solana' };
  const s = text.trim();
  if (decodeKey(s)) return { ok: true, address: s, amount: null, mint: null, references: [], memo: null, request: false };
  if (!/^solana:/i.test(s)) return { ok: false, reason: 'not_solana' };

  const body = s.slice('solana:'.length);
  const q = body.indexOf('?');
  const address = q < 0 ? body : body.slice(0, q);
  // The recipient of a request is a bare address; a link there (a request to fetch a transaction) is not taken.
  if (!decodeKey(address)) return { ok: false, reason: 'not_solana' };

  const out = { ok: true, address, amount: null, mint: null, references: [], memo: null, request: true };
  const seen = new Set();
  const query = q < 0 ? '' : body.slice(q + 1);
  for (const pair of query ? query.split('&') : []) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = decode(eq < 0 ? pair : pair.slice(0, eq));
    const value = decode(eq < 0 ? '' : pair.slice(eq + 1));
    if (name === null || value === null) return { ok: false, reason: 'invalid' };
    if (name === 'reference') {
      if (!decodeKey(value) || out.references.includes(value) || out.references.length >= MAX_REFERENCES) {
        return { ok: false, reason: 'invalid' };
      }
      out.references.push(value);
      continue;
    }
    if (!['amount', 'spl-token', 'memo'].includes(name)) continue; // label, message and anything else: ignored
    if (seen.has(name)) return { ok: false, reason: 'invalid' };
    seen.add(name);
    if (name === 'amount') {
      if (!AMOUNT_RE.test(value)) return { ok: false, reason: 'invalid' };
      out.amount = /^[0.]+$/.test(value) ? null : value;
    } else if (name === 'spl-token') {
      if (!decodeKey(value)) return { ok: false, reason: 'invalid' };
      out.mint = value;
    } else {
      if (!value || hasLoneSurrogate(value) || utf8Length(value) > MAX_MEMO_BYTES || UNSAFE_TEXT_RE.test(value)) {
        return { ok: false, reason: 'invalid' };
      }
      out.memo = value;
    }
  }
  return out;
}

/**
 * What a scanned code puts into the Solana Send form, against the tokens the wallet lists (`tokens`: { symbol, mint,
 * decimals }, SOL with a null mint): { value: { address, symbol, amount, request } } or { note } with the text key of
 * the short line the scan shows while the camera keeps scanning. A plain address leaves the token and the amount as
 * they are (symbol and amount null); a request names its token (SOL without spl-token) and its amount, which must fit
 * that token's decimals. `request` carries what the transfer itself must hold for this recipient (references, memo).
 */
export function solanaScanToForm(text, tokens) {
  const r = parseSolanaScan(text);
  if (!r.ok) return { note: r.reason === 'invalid' ? 'scan_request_invalid' : 'scan_not_solana' };
  if (!r.request) return { value: { address: r.address, symbol: null, amount: null, request: null } };
  const token = (tokens || []).find((tk) => (r.mint ? tk.mint === r.mint : tk.mint === null));
  if (!token) return { note: 'scan_token_not_held' };
  let amount = null;
  if (r.amount !== null) {
    try {
      amount = fromBaseUnits(toBaseUnits(r.amount, token.decimals), token.decimals);
    } catch (_) {
      return { note: 'scan_request_invalid' };
    }
  }
  return {
    value: {
      address: r.address,
      symbol: token.symbol,
      amount,
      request: { address: r.address, references: r.references, memo: r.memo },
    },
  };
}
