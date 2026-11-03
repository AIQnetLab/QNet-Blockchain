// How the explorer names the chain's transaction types and system accounts in the page's language, and in the QNet
// app's view (its in-app browser, and every page before the wallet is detected; src/lib/activate-view.ts). The store
// builds carry no reward or activation wording, so there the emission to node balances reads as the node balance it is,
// and a node activation as a change of the node's status. Outside that view the chain's own names stay.

import type { MessageKey, T } from './texts.ts';

// The explorer's type names (src/lib/tx-mapping.ts, also the list's filter values) and the key of each one's words.
const TYPE_KEYS: Record<string, MessageKey> = {
  Transfer: 'tx_type_transfer',
  'Token Transfer': 'tx_type_token_transfer',
  Move: 'tx_type_move',
  Reward: 'tx_type_reward',
  Swap: 'tx_type_swap',
  'Contract Call': 'tx_type_contract_call',
  Contract: 'tx_type_contract',
  Deploy: 'tx_type_deploy',
  Activation: 'tx_type_activation',
  Registration: 'tx_type_registration',
  Heartbeat: 'tx_type_heartbeat',
  'Light Eligibility': 'tx_type_light_eligibility',
  System: 'tx_type_system',
};
// Their names in the app's view.
const IN_APP_TYPES: Record<string, MessageKey> = { Reward: 'balance_title', Activation: 'tx_type_node_status' };

export function txTypeLabel(type: string, full: boolean, t: T): string {
  const named = (key: MessageKey | undefined) => (key ? t(key) : type);
  if (full) return named(TYPE_KEYS[type]);
  if (IN_APP_TYPES[type]) return t(IN_APP_TYPES[type]);
  if (/reward|emission/i.test(type)) return t(IN_APP_TYPES.Reward);
  if (/activation/i.test(type)) return t(IN_APP_TYPES.Activation);
  return named(TYPE_KEYS[type]);
}

// A system account shown by name (system_rewards_pool, an emission account): its reward or emission word reads as the
// node balance in the app's view.
export function txPartyLabel(party: string, full: boolean): string {
  return full ? party : party.replace(/rewards?|emission/gi, 'node_balance');
}

// The facts of a transaction's data card (tx_type_data) the app's view shows: only those known to say nothing of a
// burn, its amount or rewards (a registration's burn_tx, burn_wallet and burn_amount stay out). A key the
// indexer or a node adds later stays out of that view until it is listed here.
const IN_APP_DATA_KEYS = new Set(['genesis_id', 'epoch', 'eligible_count', 'batch_id', 'transfer_count', 'node_id', 'node_type']);

export function txDataEntries(data: Record<string, unknown> | null | undefined, full: boolean): [string, unknown][] {
  if (!data || typeof data !== 'object') return [];
  const entries = Object.entries(data);
  return full ? entries : entries.filter(([key]) => IN_APP_DATA_KEYS.has(key));
}

// The words of each fact the indexer records (src/indexer/transform.ts extractTxTypeData). A fact without words, one a
// node adds, has none: the page shows its field name as written, as code.
const DATA_KEYS: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  ['genesis_id', 'tx_data_genesis_id'],
  ['epoch', 'tx_data_epoch'],
  ['eligible_count', 'tx_data_eligible_count'],
  ['batch_id', 'tx_data_batch_id'],
  ['transfer_count', 'tx_data_transfer_count'],
  ['node_id', 'tx_data_node_id'],
  ['node_type', 'tx_data_node_type'],
  ['burn_tx', 'tx_data_burn_tx'],
  ['burn_wallet', 'tx_data_burn_wallet'],
  ['burn_amount', 'tx_data_burn_amount'],
]);

export const txDataLabel = (key: string): MessageKey | null => DATA_KEYS.get(key) ?? null;
