// What the screens say about a node's refusal of a transaction (L-12). A node answers in its own English, often its
// internal error ("Failed to add transaction to mempool: InvalidTransaction(…)"): that text never reaches a result card.
import { errorKey, errorText } from '../i18n';

// The refusals the wallet knows, by the words the nodes use for them; the first that matches names the class.
const CLASSES = [
  ['key', /pk_unresolved/i],
  ['rate', /rate.?limit|too many requests|HTTP 429/i],
  ['busy', /mempool (is )?full|busy|unavailable|temporar|HTTP 5\d\d/i],
  ['balance', /insufficient (balance|funds)|not enough (balance|funds)/i],
  ['nonce', /nonce/i],
];
// Each class's words.
const REASON = {
  key: 'tx_refusal_key', rate: 'tx_refusal_rate', busy: 'tx_refusal_busy', balance: 'tx_refusal_balance',
  nonce: 'tx_refusal_nonce', other: 'tx_refusal_other',
};

/** The class of a node's refusal: 'key', 'rate', 'busy', 'balance', 'nonce', or 'other'; null when there is none. */
export function refusalClass(raw) {
  const s = typeof raw === 'string' ? raw : (raw && typeof raw.message === 'string' ? raw.message : '');
  if (!s.trim()) return null;
  const hit = CLASSES.find(([, re]) => re.test(s));
  return hit ? hit[0] : 'other';
}

/** Why a node refused, in the app's language: a short phrase for "Not accepted yet ({reason})". */
export function refusalReason(t, raw) {
  return t(REASON[refusalClass(raw) || 'other']);
}

/**
 * The text of a send that did not go through, for its result card: an error code the app knows says its own text; a
 * node's refusal of a known class says the operation's text (`fallbackKey`) with that reason as its detail; anything
 * else (a refusal the wallet does not know, an internal error) says the operation's text alone. Never the raw words.
 */
export function sendErrorText(t, err, fallbackKey) {
  if (err && typeof err === 'object' && errorKey(err)) return errorText(t, err, fallbackKey);
  const cls = refusalClass(err);
  return cls && cls !== 'other' ? `${t(fallbackKey)}\n${t('err_detail', { detail: t(REASON[cls]) })}` : t(fallbackKey);
}
