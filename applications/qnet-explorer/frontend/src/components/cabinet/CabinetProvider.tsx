'use client';

// The wallet the node cabinet shows, shared by its pages: the address, its light node id and how the page learned
// it (src/lib/cabinet/wallet-choice.ts). Remembered in this browser only, until Disconnect; nothing goes into a URL.
// With no wallet chosen, the QNet extension's wallet is taken up by itself once the extension's silent qnet_accounts
// shows it approved this site, unless Disconnect was the last word here (extensionReconnect).
// Also whether the cabinet sends QNet Wallet its `link` and `claim` requests yet (src/server/phone-flows.ts, read by
// the layout), the activation the QNet extension reported here for a wallet (src/lib/cabinet/kept-activation.ts), and
// where the wallet's activation stands from every source (src/lib/cabinet/wallet-activation.ts, unified plan R1 and R6):
// the network (its node of either type), the server's activation record with the search of the wallet's own Solana
// address, and the QNet extension that holds the wallet (qnet_getActivation, never a window). Every page shows that one
// state, and none offers a burn unless it is `none`.
// The site's header shows the same wallet on every page (useHeldWallet) and keeps a wallet it connected with the same
// step (chooseWallet); a change made in another tab reaches this one through the storage event.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWallet } from '@/contexts/AppContext';
import { useNodeStatus, useSuperStatus, useWalletNode } from '@/hooks/useNodeStatus';
import { usePaymentRecords } from '@/hooks/usePaymentRecords';
import {
  DISCONNECTED_KEY, WALLET_KEY, awaitsExtension, choiceView, clearChoice, extensionReconnect, loadChoice, loadDisconnected, saveChoice, saveDisconnected,
  type WalletChoice,
} from '@/lib/cabinet/wallet-choice';
import { ACTIVATIONS_KEY, keepAnswer, loadKept, type KeptActivation, type KeptActivations } from '@/lib/cabinet/kept-activation';
import { SCAN_CACHE_MS, parseActivationRecord, type ActivationRecordView, type ScanView } from '@/lib/cabinet/burn-record';
import { WATCH_MAX_MS, activationView, nextStep, watchInterval, type ActivationView, type ExtensionRead, type Read } from '@/lib/cabinet/wallet-activation';
import { superNodeId, type ActivationAnswer } from '@/lib/qnet-link';

interface CabinetValue {
  // False until the remembered choice was read and, while the extension's first answer may still set the wallet, until
  // that answer came (awaitsExtension).
  ready: boolean;
  choice: WalletChoice | null;
  nodeId: string | null;
  walletHash: string | null;
  // An address typed on the page: shown, never acted for.
  viewOnly: boolean;
  // The site's CABINET_PHONE_FLOWS: `link` and `claim` requests to QNet Wallet are offered.
  phoneFlows: boolean;
  // The activation the QNet extension reported in this browser for the shown wallet, or null.
  activation: KeptActivation | null;
  // Where the shown wallet's activation stands, from every source (wallet-activation.ts).
  view: ActivationView;
  // The server's record of the shown wallet, when read.
  record: ActivationRecordView | null;
  // The super node id the page follows for the shown wallet: the one the network lists, else the wallet's own.
  superId: string | null;
  // Reads every source again now (after an answer of the extension, a burn, a Try again).
  refreshActivation: () => void;
  choose: (choice: WalletChoice) => void;
  // Disconnect: the wallet goes, and the extension's wallet is not taken up by itself until a tap connects one.
  forget: () => void;
  // Leaves a typed address for the connect screen (ConnectFirst); not a Disconnect, so it leaves no mark.
  leaveView: () => void;
  // Keeps a checked activation answer of the extension for the wallet it names.
  keepActivation: (answer: ActivationAnswer) => void;
}

const CabinetContext = createContext<CabinetValue | undefined>(undefined);

// Told when the remembered wallet changes in this tab; other tabs hear the storage event.
const HELD_EVENT = 'qnet-held-wallet';

// How often the server's record is read again: while a reservation, a burn on its way or a payment burn waiting for
// consent stands, and otherwise.
const RECORD_BUSY_MS = 10_000;
const RECORD_IDLE_MS = 30_000;
// The search of the wallet's Solana address is asked for at most this often when it failed or did not finish: two tabs
// stay within the server's 10 searches per client per 10 minutes.
const SCAN_RETRY_MS = 120_000;
// The extension (shared contract C5): while it searches, while a burn is on its way, while it is locked or not
// connected, and otherwise.
// Within the contract's 3-5 s, and slow enough that two tabs stay under the extension's 30 calls a minute per site.
const EXT_SEARCHING_MS = 5_000;
const EXT_BUSY_MS = 10_000;
const EXT_LOCKED_MS = 15_000;
const EXT_IDLE_MS = 60_000;

const REQUEST: RequestInit = { cache: 'no-store', credentials: 'omit', redirect: 'error' };

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type Held = { choice: WalletChoice | null; disconnected: boolean };

// What this tab kept last: the page reads it before the store, which may be blocked.
let heldHere: Held | null = null;

// The one step that changes the remembered wallet: the Disconnect mark first when it changes, then the wallet, then
// the page is told (My node's pages and the header read both).
function hold(next: WalletChoice | null, disconnected?: boolean): void {
  const storage = localStore();
  if (disconnected !== undefined) saveDisconnected(storage, disconnected);
  if (next) saveChoice(storage, next);
  else clearChoice(storage);
  heldHere = { choice: next, disconnected: disconnected ?? heldHere?.disconnected ?? loadDisconnected(storage) };
  window.dispatchEvent(new Event(HELD_EVENT));
}

// A wallet connected with a tap, here or in the header: it lifts a Disconnect; an address typed only to look does not.
export function chooseWallet(next: WalletChoice): void {
  hold(next, next.source !== 'entered' ? false : undefined);
}

// The server's record of `wallet`, read on load, on return, after a step and on a timer, with the search of the wallet's
// own Solana address at most once per SCAN_CACHE_MS (the server's per-client budget for searches is small).
function useServerRecord(wallet: string | null, solana: string | null, pulse: number) {
  const [read, setRead] = useState<{ wallet: string | null; read: Read<ActivationRecordView> }>({ wallet: null, read: { phase: 'loading' } });
  const [scan, setScan] = useState<{ key: string; at: number; view: ScanView } | null>(null);
  const tried = useRef<{ key: string; at: number } | null>(null);
  const scanRef = useRef(scan);
  scanRef.current = scan;
  const busy = read.read.phase === 'ok' && ['reserved', 'sending'].includes(read.read.value.state);

  useEffect(() => {
    if (!wallet) return;
    let live = true;
    const key = `${wallet}:${solana ?? ''}`;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      const kept = scanRef.current;
      // A search that did not finish is asked again after SCAN_RETRY_MS, not kept as one that did.
      const fresh = kept && kept.key === key && kept.view.complete && now - kept.at < SCAN_CACHE_MS;
      const retried = tried.current && tried.current.key === key && now - tried.current.at < SCAN_RETRY_MS;
      const withScan = solana !== null && !fresh && !retried;
      if (withScan) tried.current = { key, at: now };
      let value: ActivationRecordView | null = null;
      try {
        const res = await fetch(`/api/cabinet/activation/${encodeURIComponent(wallet)}${withScan ? `?solana=${encodeURIComponent(solana)}` : ''}`, REQUEST);
        value = res.status === 200 ? parseActivationRecord(await res.json(), wallet) : null;
      } catch {
        value = null;
      }
      if (!live) return;
      if (value?.scan) setScan({ key, at: Date.now(), view: value.scan });
      // A read that failed keeps an earlier answer that knows something (a record, a reservation, a burn on its way); an
      // earlier "none" is no answer now, so nothing is offered while the record cannot be read (R6).
      setRead((cur) => (value ? { wallet, read: { phase: 'ok', value } }
        : cur.wallet === wallet && cur.read.phase === 'ok' && cur.read.value.state !== 'none' ? cur : { wallet, read: { phase: 'unavailable' } }));
    };
    void load();
    const timer = window.setInterval(() => void load(), busy ? RECORD_BUSY_MS : RECORD_IDLE_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [wallet, solana, busy, pulse]);

  const key = `${wallet}:${solana ?? ''}`;
  const shownScan = scan && scan.key === key && Date.now() - scan.at < 2 * SCAN_CACHE_MS ? scan.view : null;
  return { read: read.wallet === wallet ? read.read : ({ phase: 'loading' } as const), scan: shownScan };
}

// The QNet extension's answer for its own wallet, when the shown wallet is the extension's: asked on load, on return,
// after a step and on a timer that follows its answer.
function useExtensionActivation(applies: boolean, wallet: string | null, pulse: number, busyRecord: boolean): ExtensionRead {
  const { readActivation } = useWallet();
  const [read, setRead] = useState<{ wallet: string | null; read: ExtensionRead }>({ wallet: null, read: { phase: 'na' } });
  useEffect(() => {
    if (!applies || !wallet) return;
    let live = true;
    let timer: number | undefined;
    const ask = async () => {
      window.clearTimeout(timer);
      const got = await readActivation();
      if (!live) return;
      const next: ExtensionRead = got.ok ? { phase: 'ok', value: got.value } : { phase: 'failed', failure: got.failure };
      setRead({ wallet, read: next });
      const status = got.ok ? got.value.status : null;
      const delay = status === 'searching' ? EXT_SEARCHING_MS
        : status === 'pending' || busyRecord ? EXT_BUSY_MS
          : status === 'locked' || status === 'not_connected' || status === 'no_wallet' ? EXT_LOCKED_MS : EXT_IDLE_MS;
      timer = window.setTimeout(() => void ask(), delay);
    };
    void ask();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void ask();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [applies, wallet, pulse, busyRecord, readActivation]);
  if (!applies || !wallet) return { phase: 'na' };
  return read.wallet === wallet ? read.read : { phase: 'loading' };
}

export function CabinetProvider({ phoneFlows, children }: { phoneFlows: boolean; children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [choice, setChoice] = useState<WalletChoice | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [activations, setActivations] = useState<KeptActivations>({});
  const [pulse, setPulse] = useState(0);
  const { providerStatus, providerChannel, accounts, accountsKnown } = useWallet();
  const channel = providerStatus === 'available' ? providerChannel : null;

  useEffect(() => {
    const storage = localStore();
    setChoice(loadChoice(storage));
    setDisconnected(loadDisconnected(storage));
    setLoaded(true);
    setActivations(loadKept(storage));
    // Every change of the remembered wallet in this tab, the header's included.
    const onHeld = () => {
      if (!heldHere) return;
      setChoice(heldHere.choice);
      setDisconnected(heldHere.disconnected);
    };
    // A Disconnect, another wallet or another kept answer in another tab (SITE-F11): this tab's memory of it is over.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== WALLET_KEY && event.key !== DISCONNECTED_KEY && event.key !== ACTIVATIONS_KEY) return;
      heldHere = null;
      const s = localStore();
      setChoice(loadChoice(s));
      setDisconnected(loadDisconnected(s));
      setActivations(loadKept(s));
    };
    window.addEventListener(HELD_EVENT, onHeld);
    window.addEventListener('storage', onStorage);
    // What is left of an expired QNet Link request of any cabinet page goes now. Loaded here, so the header, which
    // reads the remembered wallet on every page, does not carry the request store.
    void import('@/lib/link-store').then(({ purgeSessions }) => {
      void purgeSessions(Date.now());
    });
    return () => {
      window.removeEventListener(HELD_EVENT, onHeld);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const keep = useCallback((next: WalletChoice | null) => hold(next), []);

  const choose = useCallback((next: WalletChoice) => chooseWallet(next), []);

  const forget = useCallback(() => hold(null, true), []);

  const leaveView = useCallback(() => keep(null), [keep]);

  const keepActivation = useCallback((answer: ActivationAnswer) => {
    setActivations((current) => keepAnswer(localStore(), current, answer, Date.now()));
  }, []);

  const refreshActivation = useCallback(() => setPulse((n) => n + 1), []);

  // The extension's wallet as the cabinet takes it up: shown in this render, then kept.
  const taken = loaded ? extensionReconnect(choice, channel, accounts, disconnected) : null;
  useEffect(() => {
    if (taken) keep(taken);
  }, [taken, keep]);
  const current = taken ?? choice;

  // Nothing rather than the connect screen or the extension's earlier wallet for a moment.
  const ready = loaded && !awaitsExtension(choice, channel, accountsKnown, disconnected);

  // Every source of the wallet's activation.
  const wallet = current?.qnet ?? null;
  const cv = current ? choiceView(current) : null;
  const network = useWalletNode(wallet);
  const light = useNodeStatus(cv?.nodeId ?? null);
  const listedSuper = network.state.phase === 'ok' && network.state.value.state === 'registered' && network.state.value.nodeType === 'super'
    ? network.state.value.nodeId : null;
  const superId = wallet ? listedSuper ?? superNodeId(wallet) : null;
  const superRead = useSuperStatus(superId);
  const server = useServerRecord(wallet, current?.solana ?? null, pulse);
  const busyRecord = server.read.phase === 'ok' && ['reserved', 'sending'].includes(server.read.value.state);
  const applies = channel === 'extension' && current !== null && (current.source === 'extension' || accounts?.qnet === current.qnet);
  const asked = useExtensionActivation(applies, wallet, pulse, busyRecord);
  // A wallet chosen from the extension while no extension answers here: its source is not known (nothing is offered);
  // while the page still looks for the extension, it is loading.
  const extensionGone = current?.source === 'extension' && channel !== 'extension';
  const extension: ExtensionRead = !extensionGone ? asked
    : providerStatus === 'detecting' ? { phase: 'loading' } : { phase: 'failed', failure: 'disconnected' };
  const records = usePaymentRecords(pulse);
  const kept = current ? activations[current.qnet] ?? null : null;

  // A step asks every read again, the shared network reads included.
  const { refresh: refreshNetwork } = network;
  const { refresh: refreshLight } = light;
  const { refresh: refreshSuper } = superRead;
  useEffect(() => {
    if (pulse === 0) return;
    refreshNetwork();
    refreshLight();
    refreshSuper();
  }, [pulse, refreshNetwork, refreshLight, refreshSuper]);

  const view = useMemo(() => activationView({
    choice: current, network: network.state, light: light.state, superStatus: superRead.state, server: server.read, scan: server.scan, extension, kept,
    records,
  }), [current, network.state, light.state, superRead.state, server.read, server.scan, extension, kept, records]);

  // While the wallet waits on the network (its record, its phone, its server), the network is read again every few
  // seconds while the page is shown, so every page moves on by itself as soon as the network lists the node or its
  // device (wallet-activation.ts watchInterval), for up to WATCH_MAX_MS from the step's start or the page's return;
  // the reads' own half-minute round goes on, and the watch stops once nothing is awaited.
  const watch = watchInterval(view);
  const step = nextStep(view);
  const watchSuper = view.burn?.nodeType === 'super' || view.nodes.includes('super');
  useEffect(() => {
    if (watch === null) return;
    let until = Date.now() + WATCH_MAX_MS;
    const onVisible = () => {
      if (document.visibilityState === 'visible') until = Date.now() + WATCH_MAX_MS;
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || Date.now() > until) return;
      refreshNetwork();
      refreshLight();
      if (watchSuper) refreshSuper();
    }, watch);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [watch, step, watchSuper, refreshNetwork, refreshLight, refreshSuper]);

  const value = useMemo<CabinetValue>(() => ({
    ready, choice: current, nodeId: cv?.nodeId ?? null, walletHash: cv?.walletHash ?? null, viewOnly: current?.source === 'entered', phoneFlows,
    activation: kept, view, record: server.read.phase === 'ok' ? server.read.value : null, superId, refreshActivation, choose, forget, leaveView,
    keepActivation,
  }), [ready, current, cv?.nodeId, cv?.walletHash, phoneFlows, kept, view, server.read, superId, refreshActivation, choose, forget, leaveView, keepActivation]);

  return <CabinetContext.Provider value={value}>{children}</CabinetContext.Provider>;
}

export function useCabinet(): CabinetValue {
  const value = useContext(CabinetContext);
  if (value === undefined) throw new Error('useCabinet must be used within a CabinetProvider');
  return value;
}

// The address of the wallet My node shows, for the site's header on every page: the one it remembers, or the
// extension's it takes up (extensionReconnect); null before it is read.
export function useHeldWallet(): string | null {
  const { providerStatus, providerChannel, accounts } = useWallet();
  const [kept, setKept] = useState<Held | null>(null);
  useEffect(() => {
    const read = () => {
      const storage = localStore();
      setKept(heldHere ?? { choice: loadChoice(storage), disconnected: loadDisconnected(storage) });
    };
    // Another tab changed the store: this tab's memory of it is over.
    const onStorage = () => {
      heldHere = null;
      read();
    };
    read();
    window.addEventListener(HELD_EVENT, read);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(HELD_EVENT, read);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  if (!kept) return null;
  const channel = providerStatus === 'available' ? providerChannel : null;
  return (extensionReconnect(kept.choice, channel, accounts, kept.disconnected) ?? kept.choice)?.qnet ?? null;
}
