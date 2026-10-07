// The bundle's one ML-DSA-65 signing step, shared by its typed signers (transfers, calls, the light node messages).
// Not part of the bundle's API (index.js does not export it): nothing outside those signers can sign a text with it.
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { eonFromPublicKeyBytes } from '../../../../qnet-mobile/src/crypto/WalletIdentity.js';
import { assertBytes } from './bytes.js';
import { fail } from './errors.js';

export const ML_DSA65 = { PUBLIC_KEY_BYTES: 1952, SECRET_KEY_BYTES: 4032, SIGNATURE_BYTES: 3309 };

// Signs `preimage` for the account `from` (FIPS 204, empty context, as the node verifies) and checks the signature
// under the account key before returning it.
export function signChecked(from, preimage, secretKey, publicKey) {
  assertBytes(secretKey, ML_DSA65.SECRET_KEY_BYTES);
  assertBytes(publicKey, ML_DSA65.PUBLIC_KEY_BYTES);
  if (eonFromPublicKeyBytes(publicKey) !== from) fail('KEY_ADDRESS_MISMATCH');
  const message = utf8ToBytes(preimage);
  const signature = ml_dsa65.sign(message, secretKey);
  if (signature.length !== ML_DSA65.SIGNATURE_BYTES || !ml_dsa65.verify(signature, message, publicKey)) {
    fail('SIGNATURE_SELF_CHECK_FAILED');
  }
  return signature;
}
