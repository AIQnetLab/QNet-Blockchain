import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { eonFromPublicKeyBytes } from '../../../../qnet-mobile/src/crypto/WalletIdentity.js';
import { assertBytes, concatBytes } from './bytes.js';
import { fail } from './errors.js';
import { ML_DSA65 } from './wallet.js';

// dApp messages are signed apart from everything the chain accepts, twice over: the bytes carry this
// header plus the requesting origin, and the ML-DSA-65 signature uses a FIPS 204 context the node never
// uses (it verifies transactions with an empty context), so no dApp signature can pass as a transaction.
export const OFFCHAIN_MESSAGE_HEADER = 'QNet Signed Message:\n';
export const OFFCHAIN_MESSAGE_CONTEXT = 'QNET_OFFCHAIN_MSG_v1';
export const OFFCHAIN_MESSAGE_MAX_BYTES = 4096;

// Every preimage family the node or the light-node protocol signs. A message that starts with one of
// them is refused even though the wrapper already keeps it from verifying as one. 'register:' and 'migrate:'
// are the node's wallet-signed light-node registration (registration_api.rs) and device migration (rpc
// mod.rs) preimages (XP-R3-05). The consent and claim families also stand untagged, and 'qnet_dev_' covers the device
// messages, the wallet-signed rebind among them (light-node-messages.md sections 4 and 5). 'qnet_burn_owner_v2:' is the
// payment key's owner bind, and the last two are aiqnet.io's records of a wallet (a burn record, a node reservation) as
// the prefix check folds them: only the wallet signs those, through signSiteRecord (CONTRACTS.md decision 36).
export const PROTOCOL_PREFIXES = [
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
];

// The first line of each text aiqnet.io keeps as a wallet's own word (decision 36): a burn record and a node
// reservation. signSiteRecord signs only these; signOffchainMessage refuses them by their protocol prefix.
export const SITE_RECORD_HEADS = ['QNet burn record v1\n', 'QNet node reservation v1\n'];

const CONTEXT_BYTES = utf8ToBytes(OFFCHAIN_MESSAGE_CONTEXT);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Everything the approval window would not show as the text that is signed: C0/C1 controls other than
// tab, line feed and a carriage return before a line feed, every format character (bidi controls, zero-width
// characters, soft hyphen, BOM, tag characters), private-use and unassigned code points, the line and paragraph
// separators, the characters that render as nothing: variation selectors, the combining grapheme joiner, the
// Khmer inherent vowels, the Mongolian free variation selectors, the Hangul fillers and the braille blank, and the
// typographic spaces the approval's box draws at a sliver of a character or less (U+2000-U+200A, U+202F, U+205F),
// which a verifier still splits on (R5-EXT-UI-01).
const HIDDEN_CHARACTERS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\p{Cf}\\p{Co}\\p{Cn}'
  + '\\u2028\\u2029\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u2800\\u3164\\uFE00-\\uFE0F\\uFFA0'
  + '\\u2000-\\u200A\\u202F\\u205F\\u{E0100}-\\u{E01EF}]', 'u');
// A carriage return breaks the line in the approval window only right before a line feed (CRLF); alone it is drawn
// as nothing, while a verifier that splits lines on CR, LF or CRLF (a line splitter, a header parser) reads a line
// break the user never saw (R5-EXT-UI-01).
const LONE_CARRIAGE_RETURN = /\r(?!\n)/;
// Stripped anywhere before the protocol-prefix check, so no invisible or space character in front of or
// inside a prefix can hide it.
const PREFIX_NOISE = new RegExp(`${HIDDEN_CHARACTERS.source.slice(0, -1)}\\p{Z}\\s]`, 'gu');

export function hasProtocolPrefix(message) {
  if (typeof message !== 'string') return false;
  const head = message.replace(PREFIX_NOISE, '').normalize('NFKC').toLowerCase();
  return PROTOCOL_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * Whether the approval window shows `text` exactly as it is: no lone surrogate, hidden character or lone carriage
 * return (a signed message, and the text form of a contract call's input or a token's name).
 */
export function isVisibleText(text) {
  return typeof text === 'string' && !LONE_SURROGATE.test(text) && !HIDDEN_CHARACTERS.test(text) && !LONE_CARRIAGE_RETURN.test(text);
}

function assertOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 255) fail('INVALID_ORIGIN');
  let url;
  try {
    url = new URL(origin);
  } catch {
    return fail('INVALID_ORIGIN');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  if (!schemeOk || url.origin !== origin) fail('INVALID_ORIGIN');
  return origin;
}

// "QNet Signed Message:\n" + origin + "\n" + utf8ByteLength(message) + "\n" + message, for a visible message of at most
// OFFCHAIN_MESSAGE_MAX_BYTES.
function envelope(origin, message) {
  assertOrigin(origin);
  if (typeof message !== 'string' || message.length === 0) fail('INVALID_MESSAGE');
  if (!isVisibleText(message)) fail('INVALID_MESSAGE');
  const body = utf8ToBytes(message);
  if (body.length > OFFCHAIN_MESSAGE_MAX_BYTES) fail('MESSAGE_TOO_LONG');
  return concatBytes(utf8ToBytes(`${OFFCHAIN_MESSAGE_HEADER}${origin}\n${body.length}\n`), body);
}

// ML-DSA-65 of envelope bytes with OFFCHAIN_MESSAGE_CONTEXT; self-verified.
function signEnvelope(bytes, secretKey, publicKey) {
  assertBytes(secretKey, ML_DSA65.SECRET_KEY_BYTES);
  assertBytes(publicKey, ML_DSA65.PUBLIC_KEY_BYTES);
  const signature = ml_dsa65.sign(bytes, secretKey, { context: CONTEXT_BYTES });
  if (!ml_dsa65.verify(signature, bytes, publicKey, { context: CONTEXT_BYTES })) {
    fail('SIGNATURE_SELF_CHECK_FAILED');
  }
  return { signature, publicKey, address: eonFromPublicKeyBytes(publicKey) };
}

function verifyEnvelope(build, signature, publicKey) {
  try {
    const bytes = build();
    assertBytes(signature, ML_DSA65.SIGNATURE_BYTES);
    assertBytes(publicKey, ML_DSA65.PUBLIC_KEY_BYTES);
    return ml_dsa65.verify(signature, bytes, publicKey, { context: CONTEXT_BYTES });
  } catch {
    return false;
  }
}

/**
 * The exact bytes a dApp message signature covers:
 * "QNet Signed Message:\n" + origin + "\n" + utf8ByteLength(message) + "\n" + message.
 */
export function buildOffchainMessage(origin, message) {
  assertOrigin(origin);
  if (typeof message !== 'string' || message.length === 0) fail('INVALID_MESSAGE');
  if (!isVisibleText(message)) fail('INVALID_MESSAGE');
  if (hasProtocolPrefix(message)) fail('PROTOCOL_PREFIX');
  return envelope(origin, message);
}

/** ML-DSA-65 over buildOffchainMessage(origin, message) with OFFCHAIN_MESSAGE_CONTEXT; self-verified. */
export function signOffchainMessage(origin, message, secretKey, publicKey) {
  return signEnvelope(buildOffchainMessage(origin, message), secretKey, publicKey);
}

export function verifyOffchainMessage(origin, message, signature, publicKey) {
  return verifyEnvelope(() => buildOffchainMessage(origin, message), signature, publicKey);
}

/**
 * The bytes of a record aiqnet.io keeps as the wallet's own word (decision 36): the envelope of a dApp message, for a
 * message that starts with one of SITE_RECORD_HEADS only (INVALID_MESSAGE otherwise), without the protocol-prefix refusal
 * those heads meet.
 */
export function buildSiteRecord(origin, message) {
  if (typeof message !== 'string' || !SITE_RECORD_HEADS.some((head) => message.startsWith(head))) fail('INVALID_MESSAGE');
  return envelope(origin, message);
}

/** ML-DSA-65 over buildSiteRecord(origin, message) with OFFCHAIN_MESSAGE_CONTEXT; self-verified. Never a dApp's signer. */
export function signSiteRecord(origin, message, secretKey, publicKey) {
  return signEnvelope(buildSiteRecord(origin, message), secretKey, publicKey);
}

export function verifySiteRecord(origin, message, signature, publicKey) {
  return verifyEnvelope(() => buildSiteRecord(origin, message), signature, publicKey);
}
