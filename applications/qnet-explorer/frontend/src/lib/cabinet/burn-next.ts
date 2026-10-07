// The next step of a known burn of a wallet with no node on the QNet network (components/cabinet/NextSteps.tsx Burned;
// owner, 06.10: a light node runs in the app, and an activation started on a phone finishes on that phone). The code is
// always shown first; then, by the burn's node type and the way it was made:
// - a super node's burn: its server (only the QNet extension activates one);
// - a payment address's burn: the browser that holds its record goes on in the Activate tab; any other browser
//   registers the node with QNet Wallet's consent, the site completing it from its record;
// - a burn made from the wallet's own Solana address (by the extension or an older app, found by the site's record,
//   the extension's answer or the search of that address): QNet Wallet's consent too, with that address's owner bind,
//   which QNet Wallet signs with the same recovery phrase's Solana key. Only a burn the QNet extension in this browser
//   made, and records itself, is left to it.
// Pure: the tests route every source and way through it.

import type { KnownBurn } from './wallet-activation.ts';

export type BurnNext =
  | { step: 'server' }
  | { step: 'resume' }
  // `burner`: null finishes a payment address's burn from the site's record; else the wallet's own Solana address that
  // made the burn, whose owner bind QNet Wallet signs.
  | { step: 'finish'; burner: string | null }
  | { step: 'recording' };

export interface BurnContext {
  // This browser holds the unfinished payment record of this very burn.
  here: boolean;
  // The wallet's own Solana address as the page knows it (shared by the extension or QNet Wallet), or null.
  solana: string | null;
  // The QNet extension in this browser holds the wallet and answered for this very burn: it records the node itself.
  extensionRecords: boolean;
}

export function burnNext(burn: KnownBurn, ctx: BurnContext): BurnNext {
  if (burn.nodeType === 'super') return { step: 'server' };
  if (burn.way === 'payment') return ctx.here ? { step: 'resume' } : { step: 'finish', burner: null };
  if (ctx.extensionRecords) return { step: 'recording' };
  const burner = burn.burner ?? ctx.solana;
  return burner ? { step: 'finish', burner } : { step: 'recording' };
}
