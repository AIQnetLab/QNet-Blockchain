// ML-DSA-65 verification with an empty context (FIPS 204), as the node verifies a consent: the activation page
// checks QNet Wallet's `link` answer with it, and the site's register route checks the body again.

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import type { ConsentVerifier } from '../qnet-link.ts';

export const verifyConsent: ConsentVerifier = (publicKey, message, signature) => ml_dsa65.verify(signature, message, publicKey);
