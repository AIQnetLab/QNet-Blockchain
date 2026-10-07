// A wallet's QNet key from its 12- or 24-word recovery phrase, derived exactly as the wallet extension and the app
// derive it: the extension's own recovery-phrase rules and key derivation (tools/crypto-bundle), compiled here.
import { entropyToSeed, generateEntropy as newEntropy, mnemonicToEntropy, validateMnemonic } from '#wallet-core/mnemonic.js';
import { deriveQnetKeypair } from '#wallet-core/wallet.js';
import { QNetError, mapped } from './errors.js';

export interface QNetKeypair {
  readonly address: string;
  readonly publicKey: Uint8Array;
  /** 4032 bytes. Wipe it with `secretKey.fill(0)` when done. */
  readonly secretKey: Uint8Array;
}

/** Whether `phrase` is a valid 12- or 24-word recovery phrase (any spacing or case). */
export const isValidRecoveryPhrase = (phrase: string): boolean => validateMnemonic(phrase);

/** The 16 or 32 bytes of entropy a recovery phrase encodes (INVALID_MNEMONIC otherwise). */
export const recoveryPhraseToEntropy: (phrase: string) => Uint8Array = mapped(mnemonicToEntropy);

/** Fresh entropy for a new key: 32 bytes (a 24-word phrase) by default. */
export const generateEntropy: (words?: 12 | 24) => Uint8Array = mapped((words: 12 | 24 = 24) => newEntropy(words));

/** The QNet keypair of the phrase `entropy` encodes. The seed is wiped before this returns. */
export const keypairFromEntropy: (entropy: Uint8Array) => QNetKeypair = mapped((entropy: Uint8Array) => {
  if (!(entropy instanceof Uint8Array) || (entropy.length !== 16 && entropy.length !== 32)) throw new QNetError('INVALID_ENTROPY');
  const seed = entropyToSeed(entropy);
  try {
    return deriveQnetKeypair(seed);
  } finally {
    seed.fill(0);
  }
});

/** The QNet keypair of a recovery phrase. */
export function keypairFromRecoveryPhrase(phrase: string): QNetKeypair {
  const entropy = recoveryPhraseToEntropy(phrase);
  try {
    return keypairFromEntropy(entropy);
  } finally {
    entropy.fill(0);
  }
}
