// Stands in for qnet-mobile/src/crypto/DilithiumCrypto.js inside the bundle. QcLightClient needs only
// verifyDilithium, with the native module's contract: UTF-8 message string, hex of the 3309-byte detached
// signature, hex of the 1952-byte public key, pure ML-DSA-65 (FIPS 204, empty context) as the node signs.
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const SIG_HEX_LEN = 3309 * 2;
const PK_HEX_LEN = 1952 * 2;
const HEX = /^[0-9a-fA-F]*$/;

export async function verifyDilithium(message, signatureHex, publicKeyHex) {
  if (typeof message !== 'string' || typeof signatureHex !== 'string' || typeof publicKeyHex !== 'string') {
    return false;
  }
  if (signatureHex.length !== SIG_HEX_LEN || publicKeyHex.length !== PK_HEX_LEN) return false;
  if (!HEX.test(signatureHex) || !HEX.test(publicKeyHex)) return false;
  try {
    return ml_dsa65.verify(hexToBytes(signatureHex), utf8ToBytes(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
