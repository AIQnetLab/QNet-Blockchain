// The node rows of the header's account menu (B-SPEC 5.2), from the reads My node shares (the wallet's node on the
// network, its light node's status, its super node's status, its newest epochs): with a node, My node, Node balance,
// Device and History, each with one datum; without one, My node and Activate. A datum not read yet is null ("—").

import { canMove, deviceName, isLinkedState, nodeState, superState, type HistoryView, type NodeStatusView, type SuperStatusView } from './cabinet/node-view.ts';
import { TAB_HREF } from './cabinet/tabs.ts';
import type { Read, WalletNodeView } from './cabinet/wallet-activation.ts';
import { int } from './format.ts';
import { t } from './texts.ts';
import { formatQnc } from './token-format.ts';

export type RowTone = 'signal' | 'ember' | null;

export interface AccountRow {
  key: 'node' | 'balance' | 'device' | 'history' | 'activate';
  label: string;
  href: string;
  datum: string | null;
  tone: RowTone;
  // The node's state mark: the live dot while it runs, the ring when it does not or there is no node.
  mark: 'live' | 'ring' | null;
}

export interface AccountReads {
  network: Read<WalletNodeView>;
  light: Read<NodeStatusView>;
  superNode: Read<SuperStatusView>;
  history: Read<HistoryView>;
}

const ok = <T,>(r: Read<T>): T | null => (r.phase === 'ok' ? r.value : null);

const STATE_WORD: Record<string, string> = {
  online: t('badge_online'),
  offline: t('badge_offline'),
  waiting: t('badge_waiting'),
  no_device: t('account_no_device'),
  device_pending: t('account_device_pending'),
  pending: t('badge_waiting'),
};

export const BALANCE_HREF = `${TAB_HREF.overview}#balance`;

// Whether the wallet's node runs now (the header's live dot), not known (null) until read.
export function nodeOnline(reads: AccountReads): boolean | null {
  const light = ok(reads.light);
  const sup = ok(reads.superNode);
  if (light?.registered) return nodeState(light) === 'online';
  if (sup?.registered) return superState(sup) === 'online';
  if (reads.network.phase === 'loading') return null;
  return false;
}

export interface NodeLine {
  nodeType: 'light' | 'super';
  // "Light node · Online"
  words: string;
  mark: 'live' | 'ring';
}

// Each node the wallet has on the network, light first, with its state in words: the account menu's My node row and My
// node's identity line read the same words.
export function nodeLines(reads: AccountReads): NodeLine[] {
  const light = ok(reads.light);
  const sup = ok(reads.superNode);
  const lines: NodeLine[] = [];
  if (light?.registered) {
    const state = nodeState(light);
    lines.push({ nodeType: 'light', words: t('account_light', { state: STATE_WORD[state] ?? t('badge_offline') }), mark: state === 'online' ? 'live' : 'ring' });
  }
  if (sup?.registered) {
    const state = superState(sup);
    lines.push({ nodeType: 'super', words: t('account_super', { state: STATE_WORD[state] ?? t('badge_offline') }), mark: state === 'online' ? 'live' : 'ring' });
  }
  return lines;
}

export function accountRows(reads: AccountReads): AccountRow[] {
  const network = ok(reads.network);
  const light = ok(reads.light);
  const sup = ok(reads.superNode);
  const hasLight = light?.registered === true;
  const hasSuper = sup?.registered === true;

  // No node only when the network says so; a read that failed is not known ("—").
  if (network?.state === 'none' && !hasLight && !hasSuper) {
    return [
      { key: 'node', label: t('account_node'), href: TAB_HREF.overview, datum: t('account_no_node'), tone: null, mark: 'ring' },
      { key: 'activate', label: t('nav_activate'), href: TAB_HREF.activate, datum: t('account_step', { step: 2, steps: 4 }), tone: 'ember', mark: null },
    ];
  }

  const lines = nodeLines(reads);
  const node = lines.length > 1 ? t('account_both') : lines[0]?.words ?? null;
  const mark: AccountRow['mark'] = lines.length === 0 ? null : lines.some((l) => l.mark === 'live') ? 'live' : 'ring';

  const balanceNano = hasLight ? light.balanceNano : hasSuper ? sup.balanceNano : null;
  const balance = balanceNano === null ? null : `${formatQnc(balanceNano)} QNC`;

  // A device that runs the node by its name, or by its state where the name is not known (a node of an earlier version,
  // an address only viewed); an unlinked one is no device.
  let device: string | null = null;
  if (hasLight) {
    const state = nodeState(light);
    device = state === 'no_device' ? t('account_no_device') : isLinkedState(state) ? (light.device ? deviceName(light.device) : null) ?? STATE_WORD[state] ?? null : null;
  } else if (hasSuper) device = t('account_server', { state: (STATE_WORD[superState(sup)] ?? t('badge_offline')).toLowerCase() });

  const newest = ok(reads.history)?.rows[0] ?? null;
  const history = newest ? t('account_epoch', { epoch: int(newest.epoch) }) : null;

  return [
    { key: 'node', label: t('account_node'), href: TAB_HREF.overview, datum: node, tone: null, mark },
    { key: 'balance', label: t('account_balance'), href: BALANCE_HREF, datum: balance, tone: canMove(balanceNano) ? 'signal' : null, mark: null },
    { key: 'device', label: t('nav_device'), href: TAB_HREF.device, datum: device, tone: null, mark: null },
    { key: 'history', label: t('nav_history'), href: TAB_HREF.history, datum: history, tone: newest?.result === 'missed' ? 'ember' : null, mark: null },
  ];
}
