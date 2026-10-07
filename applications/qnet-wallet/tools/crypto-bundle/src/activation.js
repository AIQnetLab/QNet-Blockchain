import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { isValidQnetAddress } from '../../../../qnet-mobile/src/crypto/WalletIdentity.js';
import { fail } from './errors.js';
import { isValidSolanaAddress, isValidSolanaSignature } from './solana.js';
import { toU64String } from './tx.js';

export const ACTIVATION_CODE_RE = /^QNET-[LS][0-9A-F]{5}-[0-9A-F]{6}-[0-9A-F]{6}$/;
export const ACTIVATION_NODE_TYPES = ['light', 'super'];

const sha3Hex = (text) => bytesToHex(sha3_256(utf8ToBytes(text)));

function nodeTypeOf(nodeType) {
  const type = typeof nodeType === 'string' ? nodeType.toLowerCase() : '';
  if (!ACTIVATION_NODE_TYPES.includes(type)) fail('INVALID_NODE_TYPE');
  return type;
}

// Whole 1DEV, as the node's u64 burn_amount; the decimal spelling is part of the XOR key.
function burnAmountOf(amount) {
  const text = toU64String(amount);
  if (text === '0') fail('INVALID_AMOUNT');
  return text;
}

/**
 * The activation code of a 1DEV burn. Byte-identical to mobile generateActivationCodeLocally (HEAD
 * 749281e, WalletManager.js) and the node's generate_quantum_activation_code / stateless verifier:
 *   key  = sha3_256("tx:type:amount")[0:32 hex chars], used as ASCII bytes
 *   seg1 = L|S + sha3_256("ts:tx:type")[0:5]
 *   seg2 = hex(address char codes XOR key)[0:6]
 *   seg3 = (hex(...)[6:10] + sha3_256("entropy:address:tx:type")[0:4])[0:6]
 */
export function generateActivationCode(nodeType, solanaAddress, burnTx, burnAmount) {
  const type = nodeTypeOf(nodeType);
  if (!isValidSolanaAddress(solanaAddress)) fail('INVALID_ADDRESS');
  return codeOf(type, solanaAddress, burnTx, burnAmount);
}

/**
 * The activation code of a light burn aiqnet.io's one-time payment key made for a wallet: the same format with the
 * wallet's QNet address in place of the burner's, so the code reads as this wallet's code. The burn is found through
 * the node's registration record of the wallet's light node (burn_tx → wallet).
 */
export function walletActivationCode(qnetAddress, burnTx, burnAmount) {
  if (!isValidQnetAddress(qnetAddress)) fail('INVALID_ADDRESS');
  return codeOf('light', qnetAddress, burnTx, burnAmount);
}

function codeOf(type, address, burnTx, burnAmount) {
  if (!isValidSolanaSignature(burnTx)) fail('INVALID_BURN_TX');
  const amount = burnAmountOf(burnAmount);

  const key = sha3Hex(`${burnTx}:${type}:${amount}`).substring(0, 32);
  const encHex = Array.from(address, (c, i) =>
    (c.charCodeAt(0) ^ key.charCodeAt(i % key.length)).toString(16).padStart(2, '0'),
  ).join('').toUpperCase();

  const segment1 = (type === 'super' ? 'S' : 'L') + sha3Hex(`ts:${burnTx}:${type}`).substring(0, 5).toUpperCase();
  const segment2 = (encHex + '000000').substring(0, 6);
  const walletPart2 = (encHex.substring(6, 10) + '0000').substring(0, 4);
  const entropy = sha3Hex(`entropy:${address}:${burnTx}:${type}`).substring(0, 4).toUpperCase();
  const segment3 = (walletPart2 + entropy).substring(0, 6);
  return `QNET-${segment1}-${segment2}-${segment3}`;
}

/** { code, nodeType } for what a user typed (case and whitespace ignored, as mobile), or null. */
export function parseActivationCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/\s+/g, '');
  if (!ACTIVATION_CODE_RE.test(code)) return null;
  return { code, nodeType: code[5] === 'S' ? 'super' : 'light' };
}

/** Whether `code` is exactly the code of this burn. */
export function activationCodeMatches(code, nodeType, solanaAddress, burnTx, burnAmount) {
  const parsed = parseActivationCode(code);
  if (!parsed) return false;
  try {
    return generateActivationCode(nodeType, solanaAddress, burnTx, burnAmount) === parsed.code;
  } catch {
    return false;
  }
}
