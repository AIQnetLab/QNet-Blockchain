// The 1DEV token: an SPL token on Solana devnet, the cluster the QNet network verifies activation burns on
// (BURN_CLUSTER in src/lib/qnet-link.ts). One source for the faucet and the node cabinet.
import { BURN_CLUSTER } from './qnet-link.ts';

export const ONE_DEV_MINT = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
export const ONE_DEV_DECIMALS = 6;
export const ONE_DEV_UNIT = 10n ** BigInt(ONE_DEV_DECIMALS);
export const SOL_DECIMALS = 9;

// A burn on the Solana explorer of that cluster.
export const solanaTxUrl = (signature: string): string => `https://explorer.solana.com/tx/${signature}?cluster=${BURN_CLUSTER}`;

// The network of this release's activations and of its testnet faucet, from that cluster: devnet is testnet, whose tokens
// have no value and which the site's testnet faucet sends. A constant of the release, never a server setting, so a
// deployment that sets nothing never tells a visitor to send real tokens to an address the site reads only on devnet
// (SITE-R3-01).
export const ACTIVATION_NETWORK: 'testnet' | 'mainnet' = BURN_CLUSTER === 'devnet' ? 'testnet' : 'mainnet';
