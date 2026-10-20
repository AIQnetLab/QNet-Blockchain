// My node's sections (the cabinet's tabs), each at its own address, and where a wallet is on the way to a running
// node. Pure functions: the pages and the tests read the same rules.

import type { AccountRow } from '../account-menu.ts';
import type { NodeType } from '../qnet-link.ts';
import { t, type MessageKey } from '../texts.ts';
import { wayOf, type ActivationView, type ViewState } from './wallet-activation.ts';

// Overview (status and next step, the node balance, the node's details, the latest epochs), Activate (only while it
// is the way on), Device (linking a phone or tablet, the device's status; a super node's server status) and History
// (every epoch).
export const TABS = ['overview', 'activate', 'device', 'history'] as const;
export type Tab = (typeof TABS)[number];

// Each section is a page of its own, so back, forward and a reload keep it; Activate stays the only page that loads
// the payment key. Overview names itself, so the landing rule of a bare /node leaves it alone.
export const TAB_HREF: Record<Tab, string> = {
  overview: '/node?tab=overview',
  activate: '/node/activate',
  device: '/node/device',
  history: '/node/history',
};

// How it works: readable without a wallet, in the header's Docs menu and linked from the connect screen.
export const GUIDE_HREF = '/docs/how-it-works';

// The sections My node had before 29.09 and where each one is now: /node?tab=<name> goes there, and so do the old pages
// (next.config.js redirects /node/devices, /node/claim, /node/code and /node/guide to the same places).
export const MOVED_TABS: Readonly<Record<string, string>> = Object.freeze({
  devices: TAB_HREF.device,
  balance: TAB_HREF.overview,
  code: TAB_HREF.overview,
  guide: GUIDE_HREF,
});
export const MOVED_PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/node/devices': TAB_HREF.device,
  '/node/claim': TAB_HREF.overview,
  '/node/code': TAB_HREF.overview,
  '/node/guide': GUIDE_HREF,
});

// My node's pages (the header's wallet control stays on them after a connect).
export const isNodePath = (pathname: string | null): boolean => pathname === '/node' || (pathname ?? '').startsWith('/node/');

// The connect card's id: the header's Connect wallet leads to /node#connect.
export const CONNECT_ID = 'connect';

// /node?tab=<name> for another section, or for one that moved: that section's page.
export function tabRoute(tab: unknown): string | null {
  if (typeof tab !== 'string' || tab === 'overview') return null;
  if (Object.prototype.hasOwnProperty.call(MOVED_TABS, tab)) return MOVED_TABS[tab];
  return (TABS as readonly string[]).includes(tab) ? TAB_HREF[tab as Tab] : null;
}

// Activate is offered only while the wallet has no node, no burn and nothing on its way from any source (the state
// `none`, wallet-activation.ts), while an activation of this browser for this wallet is unfinished, and on its own page;
// never for an address only viewed (`viewOnly`), unless that page is open.
export function visibleTabs(state: ViewState | null, openActivation: boolean, current: Tab, viewOnly = false): Tab[] {
  return TABS.filter((tab) => tab !== 'activate' || current === 'activate' || (!viewOnly && (state === 'none' || openActivation)));
}

// The states with no node on the network yet: the sections list Overview (and Activate while it is the way on); Device
// and History join once a node exists, and their pages still open directly with their empty line.
const NO_NODE_STATES: ReadonlySet<ViewState> = new Set<ViewState>(['none', 'reserved', 'sending', 'burned', 'recording']);

const TAB_LABEL: Record<Tab, MessageKey> = {
  overview: 'nav_overview',
  activate: 'nav_activate',
  device: 'nav_device',
  history: 'nav_history',
};

export interface NavItem {
  tab: Tab;
  href: string;
  label: string;
  // One datum beside the name; null while it is not read ("—").
  datum: string | null;
  tone: AccountRow['tone'];
}

// My node's sections as the rail (web) and the thumb bar (phone) list them, each with one datum taken from the rows the
// header's account menu shows (account-menu.ts accountRows), so the two never disagree: Overview the node balance (or
// that there is no node), Device the device or the server, History the newest epoch, Activate its step while it is the
// one to do now (`step`, journey().current).
export function navItems(
  state: ViewState | null, openActivation: boolean, current: Tab, viewOnly: boolean, rows: readonly Pick<AccountRow, 'key' | 'datum' | 'tone'>[], step: number | null,
): NavItem[] {
  const row = (key: AccountRow['key']) => rows.find((r) => r.key === key) ?? null;
  const noNode = state !== null && NO_NODE_STATES.has(state);
  const balance = row('balance');
  const datum = (tab: Tab): Pick<NavItem, 'datum' | 'tone'> => {
    switch (tab) {
      case 'overview':
        return balance ? { datum: balance.datum, tone: balance.tone } : { datum: noNode ? t('account_no_node') : row('node')?.datum ?? null, tone: null };
      case 'device':
        return { datum: row('device')?.datum ?? null, tone: null };
      case 'history':
        return { datum: row('history')?.datum ?? null, tone: row('history')?.tone ?? null };
      case 'activate':
        return step === 1 ? { datum: t('account_step', { step: 2, steps: JOURNEY.length }), tone: 'ember' } : { datum: null, tone: null };
    }
  };
  return visibleTabs(state, openActivation, current, viewOnly)
    .filter((tab) => !noNode || tab === 'overview' || tab === 'activate' || tab === current)
    .map((tab) => ({ tab, href: TAB_HREF[tab], label: t(TAB_LABEL[tab]), ...datum(tab) }));
}

// Connect, Activate, then for a light node Link a device and Running, for a super node Run the server and Running.
export const JOURNEY = ['connect', 'activate', 'link', 'running'] as const;
export const SUPER_JOURNEY = ['connect', 'activate', 'server', 'running'] as const;
export type JourneyStep = (typeof JOURNEY)[number] | (typeof SUPER_JOURNEY)[number];

export function journeySteps(nodeType: NodeType | null): readonly JourneyStep[] {
  return nodeType === 'super' ? SUPER_JOURNEY : JOURNEY;
}

// How many steps are done, and the one to do now; null while the wallet's state is not known, or when all are done. A
// known burn marks Activate done (SITE-F10): its record on the network is the Overview's own card.
export function journey(connected: boolean, view: ActivationView | null): { done: number; current: number | null; nodeType: NodeType | null } {
  const nodeType = view ? wayOf(view) : null;
  const at = (done: number, current: number | null) => ({ done, current, nodeType });
  if (!connected) return at(0, 0);
  if (!view) return at(1, null);
  switch (view.state) {
    case 'loading':
    case 'locked':
    case 'unknown':
      return at(1, null);
    case 'none':
    case 'reserved':
    case 'sending':
      return at(1, 1);
    case 'burned':
    case 'recording':
      return at(2, 2);
    default: {
      if (view.nodes.includes('light')) {
        if (view.light === 'online') return at(4, null);
        if (view.light === 'offline' || view.light === 'device_pending') return at(3, 3);
        if (view.light === 'no_device') return at(2, 2);
        // Listed, its status not read yet: nothing past Activate is shown as done.
        return at(2, null);
      }
      if (view.superNode === 'online') return at(4, null);
      // Registered: its server ran; Running waits for it to answer, or for the network to admit it.
      if (view.superNode === 'offline' || view.superNode === 'waiting') return at(3, 3);
      return at(3, null);
    }
  }
}

// The journey strip shows only while a step after Activate is open (Link a device or Run the server, or Running while the
// device or server has not answered): never on Activate, whose numbered steps say where it is, and never once running.
export function showJourney(tab: Tab, connected: boolean, view: ActivationView | null): boolean {
  if (tab === 'activate') return false;
  const { current } = journey(connected, view);
  return current !== null && current >= 2;
}

// The section a bare /node opens for a wallet: Activate only when it has no node, no burn and nothing on its way (and it
// is not only viewed), else Overview; null while the state is not known.
export function landingTab(state: ViewState | null, viewOnly: boolean): Tab | null {
  if (state === null || state === 'loading') return null;
  return state === 'none' && !viewOnly ? 'activate' : 'overview';
}
