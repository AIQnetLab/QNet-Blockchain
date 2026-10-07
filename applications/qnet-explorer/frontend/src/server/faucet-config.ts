// The faucet's key and network, for the faucet route (src/app/api/faucet/claim/route.ts).

import { ACTIVATION_NETWORK } from '../lib/one-dev.ts';
import { signerFromSecretKey, type Signer } from './solana-tx.ts';

// The key is read ONLY from the runtime secret FAUCET_PRIVATE_KEY (a JSON byte-array, injected by the deploy's
// secrets manager). It is never logged and there is no on-disk fallback: the wallet must not be recoverable from
// repo or config files. Null when unset or malformed, so callers fail closed. The caller zeroes `seed` after use.
export function loadFaucetSigner(): Signer | null {
  const raw = process.env.FAUCET_PRIVATE_KEY;
  if (!raw) return null;
  try {
    return signerFromSecretKey(JSON.parse(raw));
  } catch {
    // Never surface the key material in the error path.
    return null;
  }
}

// The network is the release's (ACTIVATION_NETWORK, from BURN_CLUSTER): never a request's Host header, and never a
// setting either. The site reads and burns only on that cluster, so a setting that said 'mainnet' on a devnet release
// (or one left unset, once read as 'mainnet') told visitors to send real SOL to addresses nobody could ever move it
// from (SITE-R3-01).
export function faucetEnvironment(): 'testnet' | 'mainnet' {
  return ACTIVATION_NETWORK;
}
