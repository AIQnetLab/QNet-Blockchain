/**
 * Messages a website asks the wallet to sign (qnet_signMessage), with the QNet browser extension's rules
 * (applications/qnet-wallet/tools/crypto-bundle/src/message.js): the same signed bytes, and the same refusals of
 * hidden characters and disguised protocol prefixes. Pinned by __tests__/fixtures/offchain_message_vectors.json,
 * generated from the extension's bundle, which lists every code point the extension refuses.
 *
 * A dApp signature is kept apart from everything the chain accepts twice over: the signed bytes carry a header
 * and the requesting origin, and the ML-DSA-65 signature uses a FIPS 204 context the node never uses (it
 * verifies transactions with an empty context). A message that starts with any protocol prefix is refused too.
 *
 * The same envelope carries aiqnet.io's record messages (buildSiteRecord, signSiteRecord: the extension's site-record
 * signer), which only the wallet's own code builds and no website can have signed through qnet_signMessage.
 */
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { eonFromPublicKeyBytes, isValidQnetAddress } from './WalletIdentity';
import { isSolanaAddress } from '../utils/solanaFormat';

export const OFFCHAIN_MESSAGE_HEADER = 'QNet Signed Message:\n';
export const OFFCHAIN_MESSAGE_CONTEXT = 'QNET_OFFCHAIN_MSG_v1';
export const OFFCHAIN_MESSAGE_MAX_BYTES = 4096;
// Every preimage family the node or the light-node protocol has a wallet sign, 'register:' (light-node
// registration) and 'migrate:' (device migration) included, the untagged consent and claim families,
// 'qnet_dev_' for the device messages (the wallet-signed rebind among them), the burner's owner bind of a payment
// address, and aiqnet.io's burn record and node reservation, which only signSiteRecord signs (written folded, as the
// check compares them). The list must equal the extension bundle's, which __tests__/OffchainMessage.test.js reads
// directly.
export const PROTOCOL_PREFIXES = Object.freeze([
  'q1337|',
  'qnet_register:',
  'qnet_onchain_reg:',
  'delegate_ping:',
  'token_refresh:',
  'ping:',
  'selfattest:',
  'register:',
  'migrate:',
  'client_node_reg:',
  'claim_rewards:',
  'qnet_claim_v1:',
  'qnet_dev_',
  'qnet_burn_owner_v2:',
  'qnetburnrecordv1',
  'qnetnodereservationv1',
]);
// The two messages of aiqnet.io's records a wallet signs for the site's origin, each known by its first line: a burn
// record and a node reservation. signSiteRecord signs nothing else.
export const SITE_RECORD_HEADS = Object.freeze(['QNet burn record v1\n', 'QNet node reservation v1\n']);

const PUBLIC_KEY_BYTES = 1952;
const SECRET_KEY_BYTES = 4032;
const SIGNATURE_BYTES = 3309;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// The extension's rule, character for character: everything the approval sheet would not show as the text
// that is signed. C0/C1 controls other than tab and line breaks, every format character (bidi controls,
// zero-width characters, soft hyphen, BOM, tag characters), private-use and unassigned code points, the line
// and paragraph separators, the characters that render as nothing: variation selectors, the combining
// grapheme joiner, the Khmer inherent vowels, the Mongolian free variation selectors, the Hangul fillers and
// the braille blank, and the typographic spaces a sheet draws at a sliver of a character or less (U+2000-U+200A,
// U+202F, U+205F), which a verifier still splits on. Literals, so the build expands the property classes into
// explicit ranges.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Co}\p{Cn}\u2028\u2029\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u2000-\u200A\u202F\u205F\u{E0100}-\u{E01EF}]/u;
// A carriage return breaks the line on the sheet only right before a line feed (CRLF); alone it is drawn as
// nothing, while a verifier that splits lines on CR reads a line break the user never saw.
const LONE_CARRIAGE_RETURN = /\r(?!\n)/;
// Stripped anywhere before the protocol-prefix check, so no invisible or space character in front of or
// inside a prefix can hide it.
// eslint-disable-next-line no-control-regex
const PREFIX_NOISE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Co}\p{Cn}\u2028\u2029\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u2000-\u200A\u202F\u205F\u{E0100}-\u{E01EF}\p{Z}\s]/gu;
const LONGEST_PREFIX = 21;

// NFKC folds full-width and other compatibility forms of a prefix onto it ('ｑ1337|' is 'q1337|'). A runtime
// whose normalize() is missing or broken cannot fold, so it refuses any non-ASCII character where a prefix
// could sit rather than miss a disguised one.
const NFKC_WORKS = (() => {
  try {
    return '\uFF51\u2460\u212A'.normalize('NFKC') === 'q1K';
  } catch (_) {
    return false;
  }
})();

export function _foldForPrefixCheck(text, nfkcWorks = NFKC_WORKS) {
  const stripped = text.replace(PREFIX_NOISE, '');
  if (nfkcWorks) return stripped.normalize('NFKC').toLowerCase();
  const head = Array.from(stripped).slice(0, LONGEST_PREFIX).join('');
  // eslint-disable-next-line no-control-regex
  return /[^\u0000-\u007F]/.test(head) ? null : stripped.toLowerCase();
}

/** A refusal with a stable code: INVALID_ORIGIN, INVALID_MESSAGE, PROTOCOL_PREFIX, MESSAGE_TOO_LONG, вЂ¦ */
export class OffchainMessageError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OffchainMessageError';
    this.code = code;
  }
}

const fail = (code) => { throw new OffchainMessageError(code); };

// UTF-8 without TextEncoder (not every Hermes build has it); lone surrogates are refused before this runs.
export function utf8Bytes(text) {
  const out = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

const CONTEXT_BYTES = utf8Bytes(OFFCHAIN_MESSAGE_CONTEXT);

/** A lone surrogate, a lone carriage return, or any character the approval sheet would not show. */
export function hasHiddenCharacter(message) {
  return LONE_SURROGATE.test(message) || HIDDEN_CHARACTERS.test(message) || LONE_CARRIAGE_RETURN.test(message);
}

export function hasProtocolPrefix(message) {
  if (typeof message !== 'string') return false;
  const head = _foldForPrefixCheck(message);
  if (head === null) return true;
  return PROTOCOL_PREFIXES.some((prefix) => head.startsWith(prefix));
}

// The extension's rule: https, or plain-http loopback, and exactly an origin.
function assertOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 255) fail('INVALID_ORIGIN');
  const m = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/.exec(origin);
  if (!m) fail('INVALID_ORIGIN');
  const [, scheme, host, port] = m;
  // A host ending in a number is an IPv4 address to URL parsers: only its canonical dotted form is an origin.
  const last = host.split('.').pop();
  if (/^(\d+|0x[0-9a-f]*)$/.test(last) && !/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host)) {
    fail('INVALID_ORIGIN');
  }
  const loopback = host === 'localhost' || host === '127.0.0.1';
  if (scheme === 'http' && !loopback) fail('INVALID_ORIGIN');
  if (port !== undefined && (port === (scheme === 'https' ? '443' : '80') || Number(port) < 1 || Number(port) > 65535 || /^0/.test(port))) {
    fail('INVALID_ORIGIN');
  }
  return origin;
}

// The signed bytes of a checked origin and message.
function envelope(origin, message) {
  const body = utf8Bytes(message);
  if (body.length > OFFCHAIN_MESSAGE_MAX_BYTES) fail('MESSAGE_TOO_LONG');
  const head = utf8Bytes(`${OFFCHAIN_MESSAGE_HEADER}${origin}\n${body.length}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/**
 * The exact bytes a dApp message signature covers:
 * "QNet Signed Message:\n" + origin + "\n" + utf8ByteLength(message) + "\n" + message.
 */
export function buildOffchainMessage(origin, message) {
  assertOrigin(origin);
  if (typeof message !== 'string' || message.length === 0) fail('INVALID_MESSAGE');
  if (hasHiddenCharacter(message)) fail('INVALID_MESSAGE');
  if (hasProtocolPrefix(message)) fail('PROTOCOL_PREFIX');
  return envelope(origin, message);
}

/**
 * The same bytes for one of aiqnet.io's record messages (SITE_RECORD_HEADS). Their prefixes keep them from ever being
 * a dApp message: only the wallet's own code builds one, from its own facts. Any other text is INVALID_MESSAGE.
 */
export function buildSiteRecord(origin, message) {
  if (typeof message !== 'string' || !SITE_RECORD_HEADS.some((head) => message.startsWith(head))) fail('INVALID_MESSAGE');
  assertOrigin(origin);
  if (hasHiddenCharacter(message)) fail('INVALID_MESSAGE');
  return envelope(origin, message);
}

/**
 * The node reservation a wallet signs for aiqnet.io before a burn (docs/economics/node-activation.md): exact text, LF
 * line breaks, no trailing line break, `time` in decimal Unix seconds, and the burner that will burn (the wallet's own
 * Solana address, or the page's one-time payment address, which burns for a light node only). Every field is checked,
 * so nothing malformed is signed.
 */
export function nodeReservationMessage({ wallet, nodeType, way, burner, time, cluster }) {
  if (!isValidQnetAddress(wallet) || !['light', 'super'].includes(nodeType) || !['extension', 'payment'].includes(way)
      || (way === 'payment' && nodeType !== 'light') || !isSolanaAddress(burner) || !Number.isSafeInteger(time) || time < 0
      || typeof cluster !== 'string' || !/^[a-z]+$/.test(cluster)) {
    fail('INVALID_MESSAGE');
  }
  return `QNet node reservation v1\nwallet: ${wallet}\nnode: ${nodeType}\nway: ${way}\nburner: ${burner}\ntime: ${time}\ncluster: ${cluster}`;
}

const assertBytes = (value, length) => {
  if (!(value instanceof Uint8Array) || value.length !== length) fail('INVALID_KEY');
};

/**
 * ML-DSA-65 over buildOffchainMessage(origin, message) with the FIPS 204 context; self-verified.
 * { signature, publicKey, address } (bytes, bytes, EON).
 */
export function signOffchainMessage(origin, message, secretKey, publicKey) {
  return signEnvelope(buildOffchainMessage(origin, message), secretKey, publicKey);
}

/** ML-DSA-65 over buildSiteRecord(origin, message), exactly as signOffchainMessage signs; self-verified. */
export function signSiteRecord(origin, message, secretKey, publicKey) {
  return signEnvelope(buildSiteRecord(origin, message), secretKey, publicKey);
}

function signEnvelope(bytes, secretKey, publicKey) {
  assertBytes(secretKey, SECRET_KEY_BYTES);
  assertBytes(publicKey, PUBLIC_KEY_BYTES);
  const signature = ml_dsa65.sign(bytes, secretKey, { context: CONTEXT_BYTES });
  if (!ml_dsa65.verify(signature, bytes, publicKey, { context: CONTEXT_BYTES })) fail('SIGNATURE_SELF_CHECK_FAILED');
  return { signature, publicKey, address: eonFromPublicKeyBytes(publicKey) };
}

export function verifyOffchainMessage(origin, message, signature, publicKey) {
  try {
    const bytes = buildOffchainMessage(origin, message);
    assertBytes(signature, SIGNATURE_BYTES);
    assertBytes(publicKey, PUBLIC_KEY_BYTES);
    return ml_dsa65.verify(signature, bytes, publicKey, { context: CONTEXT_BYTES });
  } catch (_) {
    return false;
  }
}
