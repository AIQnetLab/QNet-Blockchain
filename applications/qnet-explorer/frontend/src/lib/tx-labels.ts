// How the explorer names the chain's transaction types and system accounts in the QNet app's view (its in-app browser,
// a page it opened with ?from=app, and every page before the wallet is detected; src/lib/activate-view.ts). The store
// builds carry no reward or activation wording, so there the emission to node balances reads as the node balance it
// is, and a node activation as a change of the node's status (SD-11). Outside that view the chain's own names stay.

// The explorer's type names (src/lib/tx-mapping.ts) and their names in the app's view.
const IN_APP_TYPES: Record<string, string> = { Reward: 'Node balance', Activation: 'Node status' };

export function txTypeLabel(type: string, full: boolean): string {
  if (full) return type;
  if (IN_APP_TYPES[type]) return IN_APP_TYPES[type];
  if (/reward|emission/i.test(type)) return IN_APP_TYPES.Reward;
  if (/activation/i.test(type)) return IN_APP_TYPES.Activation;
  return type;
}

// A system account shown by name (system_rewards_pool, an emission account): its reward or emission word reads as the
// node balance in the app's view.
export function txPartyLabel(party: string, full: boolean): string {
  return full ? party : party.replace(/rewards?|emission/gi, 'node_balance');
}

// The facts of a transaction's data card (tx_type_data) the app's view shows: only those known to say nothing of a
// burn, its amount or rewards (a registration's burn_tx, burn_wallet and burn_amount stay out, SITE-R2-01). A key the
// indexer or a node adds later stays out of that view until it is listed here.
const IN_APP_DATA_KEYS = new Set(['genesis_id', 'epoch', 'eligible_count', 'batch_id', 'transfer_count', 'node_id', 'node_type']);

export function txDataEntries(data: Record<string, unknown> | null | undefined, full: boolean): [string, unknown][] {
  if (!data || typeof data !== 'object') return [];
  const entries = Object.entries(data);
  return full ? entries : entries.filter(([key]) => IN_APP_DATA_KEYS.has(key));
}
