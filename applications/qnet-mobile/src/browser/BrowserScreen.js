/**
 * The in-app browser (spec: mobile-browser). A general web browser in which a site can connect the wallet
 * through the QNet provider (the extension's protocol, channel 'mobile'). Security (audit R21/R22):
 *  - https only (plain-http loopback in development builds); no other scheme is loaded or handed to another app;
 *  - no file access, no mixed content, no new windows, no downloads or file picker, no camera, microphone or
 *    location (patches/react-native-webview+14.0.1.patch). One limit, on iOS below 18.4 only: WebKit gives the app
 *    no say over a page's upload sheet there, so scripts stop file inputs (in the page's world and in the app's own
 *    content world, shadow roots included), and a page built to get around them may still show the system sheet;
 *    nothing is uploaded unless the user picks a file (MB4-01);
 *  - tabs (browser/tabs), in memory only: each has its own WebView, navigation and page session, so no page is
 *    answered with, or told of, another tab's requests, and only the page of the tab in front gets a sheet;
 *  - an incognito browsing session: cookies and site storage start empty with the first page opened and end once no
 *    tab holds a page ("Clear browsing data" closes every tab, and on Android wipes at once what the session left on
 *    the phone: webViewEvents clearNeedsWipe); a new tab never clears another's (webViewEvents incognitoFor: on
 *    Android the tabs share one session, on iOS each tab has its own);
 *  - a page whose tab goes behind, under the start page or out of view with the whole browser has its audio and video
 *    paused (bridge PAUSE_MEDIA_SCRIPT); it goes on running;
 *  - the provider is injected into the top frame only, and a request's origin is the one the WebView reported;
 *  - every confirmation is a native sheet the page cannot draw over (browser/DappSheet).
 * Node activation is never offered here: the provider has no such method.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Share, ScrollView, ActivityIndicator, Keyboard, findNodeHandle, AppState,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { WebView } from 'react-native-webview';
import Svg, { Path, Circle } from 'react-native-svg';
import { providerScript, PAGE_OPENED_METHOD } from './providerScript';
import { readBridgeMessage, responseScript, eventScript, PageSession, PAUSE_MEDIA_SCRIPT } from './bridge';
import { createDappProvider, pageError, ProviderError, CODES, visibleLabel } from './dappProvider';
import { createGrantStore } from './grants';
import {
  addressToUrl, describeUrl, navigationDecision, walletOriginOf, isWalletOnlyPage, parseWebUrl, EXPLORER_PAGE,
} from './url';
import { loadHistory, rememberPage, clearHistory } from './history';
import { loadStartIsNewDocument, incognitoFor, clearNeedsWipe } from './webViewEvents';
import {
  MAX_TABS, canAddTab, createTabs, findTab, addTab, selectTab, closeTab, closeAllTabs, updateTab, openInTab, startsSession,
  remountTab, loseTab, holdsPage, startLoad, showNav, dropPending,
} from './tabs';
import { loadCachedHistory } from '../services/HistoryCache';
import { TRANSFER_FEE_NANO, STORAGE_DEPOSIT_NANO } from '../config/fees';
import { refusalHeals } from '../services/PendingTx';

const EON_RE = /^[0-9a-f]{19}eon[0-9a-f]{23}$/;

/**
 * What the send sheet's recipient warnings rest on (MOBNET-R2-03, the extension's ES-01 rule). `counterparties`
 * (known): the addresses this wallet signed transfers to (sealed, WalletManager.sentRecipients) and its unconfirmed
 * transfers, never an incoming sender. The cached history can only add warnings: `paid` (addresses it shows this
 * wallet paying: more look-alike candidates) and `senders` (addresses that sent to this wallet: an "only ever
 * sent to you" note). A dust sender therefore never silences the first-time warning, and a flood of incoming rows
 * never pushes a real payee out of the look-alike base.
 */
export async function recipientContext(address, sentTo, pendingLive) {
  const own = String(address || '').toLowerCase();
  const eon = (a) => (typeof a === 'string' && EON_RE.test(a.toLowerCase()) && a.toLowerCase() !== own ? a.toLowerCase() : null);
  const known = new Set();
  for (const a of Array.isArray(sentTo) ? sentTo : []) { const v = eon(a); if (v) known.add(v); }
  for (const p of Array.isArray(pendingLive) ? pendingLive : []) {
    const v = p && p.kind === 'transfer' ? eon(p.to) : null;
    if (v) known.add(v);
  }
  const paid = new Set();
  const senders = new Set();
  let rows = [];
  try { rows = await loadCachedHistory(address); } catch (_) { rows = []; }
  for (const r of Array.isArray(rows) ? rows : []) {
    const from = r && typeof r.from === 'string' ? r.from.toLowerCase() : '';
    const to = r && typeof r.to === 'string' ? r.to.toLowerCase() : '';
    if (from === own && eon(to)) paid.add(to);
    if (to === own && eon(from)) senders.add(from);
  }
  return { counterparties: [...known], paid: [...paid], senders: [...senders] };
}

/**
 * A token transfer or a contract call the user confirmed, through the wallet's call path: { success, txHash, nonce }
 * once a node took it, else { success: false, nonce, refusal, refusalUncertain } (unknown: it may still land; the chain
 * settles it by nonce), with the refusal a node gave, as the wallet's QNC send reports it.
 */
export async function contractSend(walletManager, d, credential, opts) {
  try {
    const call = { contract: d.contract, method: d.method, args: d.args, gasLimit: Number(d.gasLimit) };
    const data = d.type === 'tokenTransfer'
      ? await walletManager.qrc20Transfer(d.token, d.to, d.amountBase, credential, opts)
      : await walletManager.callWasmContract(call, credential, opts);
    return { success: true, txHash: data.tx_hash, nonce: data.submitNonce };
  } catch (e) {
    if (e && e.unknown) {
      return { success: false, nonce: e.unknown.nonce, refusal: e.unknown.refusal || null, refusalUncertain: !!e.unknown.refusalUncertain };
    }
    throw e;
  }
}

/**
 * What the provider's `send` answers for a send the wallet reported as `r`: submitted once a node took it; otherwise
 * unknown, with the refusal a node gave, final when every node it went to answered and waiting cannot heal it (the
 * wallet marks it stopped and never sends it again: WalletManager._sendPending).
 */
export function sendAnswer(r) {
  if (r && r.success) return { txHash: r.txHash, status: 'submitted', nonce: r.nonce, refusal: null, refusalFinal: false };
  const refusal = r && typeof r.refusal === 'string' && r.refusal ? r.refusal : null;
  return {
    txHash: null, status: 'unknown', nonce: r ? r.nonce : null, refusal,
    refusalFinal: !!refusal && !refusalHeals(refusal) && !r.refusalUncertain,
  };
}

export const BOOKMARK_URL = EXPLORER_PAGE;
const PENDING_PER_PAGE = 16;
const NOTICE_MS = 4000;
// Below this toolbar width (a 320 dp phone) Forward moves into the ⋮ menu, so the address keeps room for its domain.
const COMPACT_TOOLBAR = 360;
// A page title as the tab overview shows it: its hidden characters replaced, cut as the recent pages cut it.
const TITLE_MAX = 80;

const ICON = '#9aa3b5';
const glyph = (d, color = ICON, size = 22) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path d={d} stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

function LockGlyph({ color }) {
  return (
    <Svg width={13} height={13} viewBox="0 0 24 24">
      <Path d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z" stroke={color} strokeWidth={2.2} fill="none" strokeLinejoin="round" />
    </Svg>
  );
}

function MenuGlyph() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Circle cx={12} cy={5.5} r={1.6} fill={ICON} />
      <Circle cx={12} cy={12} r={1.6} fill={ICON} />
      <Circle cx={12} cy={18.5} r={1.6} fill={ICON} />
    </Svg>
  );
}

const BrowserScreen = forwardRef(function BrowserScreen({
  visible, wallet, credential, walletManager, t, onSheet, confirmAction, onSent, dev = false, rtl = false,
}, ref) {
  // Each tab's page: its WebView, its page session (bound to the tab: an answer goes into that tab only) and its
  // unanswered requests (nav:doc → count). Dropped with the tab.
  const pages = useRef(new Map()).current;
  const nextTab = useRef(1);
  const makeTab = () => {
    const id = `tab${nextTab.current++}`;
    pages.set(id, { session: new PageSession(id), inflight: new Map(), web: React.createRef() });
    return id;
  };
  const [tabState, setTabState] = useState(() => createTabs(makeTab()));
  // The tabs as of their last change, for the provider's callbacks and the WebViews' events between renders.
  const tabsRef = useRef(tabState);
  const update = (change) => {
    const next = change(tabsRef.current);
    if (next === tabsRef.current) return;
    tabsRef.current = next;
    setTabState(next);
  };
  const [overview, setOverviewShown] = useState(false); // the tab overview
  const overviewRef = useRef(false);
  const setOverview = (shown) => { overviewRef.current = shown; setOverviewShown(shown); };
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [menu, setMenu] = useState(false);
  const menuButtonRef = useRef(null);
  const [notice, setNotice] = useState('');
  const [recent, setRecent] = useState([]);
  const [barWidth, setBarWidth] = useState(0);
  // Android: a hidden web view that wipes what a cleared session left on the phone (webViewEvents.clearNeedsWipe); its
  // key while one is due, else 0.
  const [wiper, setWiper] = useState(0);
  const script = useMemo(() => providerScript({ dev }), [dev]);

  // Current values for the provider's callbacks, which outlive renders.
  const live = useRef({});
  live.current = { visible, wallet, credential, t, onSheet, onSent };
  const actionsRef = useRef(null);
  // Whether the app is in front, as AppState says it the moment it changes (no render in between): a page gets no sheet
  // and an approval signs nothing from the background, and an approval right after Face ID sees the app active again
  // (DappSheet untilActive, MB-01).
  const appActive = useRef(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => { appActive.current = next === 'active'; });
    return () => sub.remove();
  }, []);

  useEffect(() => { loadHistory().then(setRecent); }, []);

  const webOf = (id) => {
    const p = pages.get(id);
    return p ? p.web.current : null;
  };

  // A page that is no longer on screen (its tab went behind or under the start page, or the browser is hidden) has its
  // audio and video paused (bridge PAUSE_MEDIA_SCRIPT).
  const pauseMedia = (id) => {
    const web = webOf(id);
    if (web) web.injectJavaScript(PAUSE_MEDIA_SCRIPT);
  };

  // A hidden browser (another tab, the lock screen) keeps no focus, no keyboard, no open menu and no tab overview, and
  // plays nothing.
  useEffect(() => {
    if (visible) return;
    setEditing(false);
    setMenu(false);
    setOverview(false);
    Keyboard.dismiss();
    for (const id of pages.keys()) pauseMedia(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Whether the page `binding` came from (without one: the tab in front) is what the user sees: its tab in front and
  // on its page, with no tab overview over it. A page of any other tab gets no sheet (4001).
  const pageOnScreen = (binding) => {
    const s = tabsRef.current;
    const tab = findTab(s, binding ? binding.tab : s.active);
    return !!tab && tab.id === s.active && !tab.home && tab.source !== null && !overviewRef.current;
  };

  const engine = useMemo(() => {
    const grants = createGrantStore(walletManager, () => live.current.credential, { dev });
    // What this wallet's unsettled transactions may still take of each balance read (dappProvider spendableNano), and
    // why a balance could not be read: 'foreign', 'unconfirmed' or 'unanswered' (the sheet says which).
    const balanceRead = (balance, tokenBalance) => ({
      spends: balance && balance.ok && Array.isArray(balance.pending) ? balance.pending : [],
      balanceProblem: balance && balance.ok ? null : (balance && balance.error) || 'unanswered',
      ...(tokenBalance !== null ? {
        tokenSpends: tokenBalance && tokenBalance.ok && Array.isArray(tokenBalance.pending) ? tokenBalance.pending : [],
        tokenProblem: tokenBalance && tokenBalance.ok ? null : (tokenBalance && tokenBalance.error) || 'unanswered',
      } : {}),
    });
    const accountsOf = (w) => {
      const solana = w && (w.solanaAddress || w.address);
      return w && w.qnetAddress && solana ? { qnet: w.qnetAddress, solana } : null;
    };
    return createDappProvider({
      now: () => Date.now(),
      state: (binding) => {
        const w = live.current.wallet;
        const unlocked = !!w && !!live.current.credential;
        return {
          unlocked,
          interactive: unlocked && !!live.current.visible && appActive.current && pageOnScreen(binding),
          accounts: accountsOf(w),
          walletId: w && w.qnetAddress ? w.qnetAddress.toLowerCase() : '',
        };
      },
      grants,
      feeNano: () => TRANSFER_FEE_NANO,
      signMessage: (origin, message) => walletManager.signOffchainMessage(origin, message, live.current.credential),
      tokenInfo: (contract) => walletManager.agreedTokenInfo(contract),
      contractKind: (address) => walletManager.agreedContractKind(address),
      // The balances a send is decided by are committee-certified (WalletManager.certifiedQncForSend and
      // checkedTokenBalance: a proof read a moment ago, else one verified read within its deadline), less what this
      // wallet's own transactions since that checkpoint took, counted up to the nonce the plan confirms; never one
      // node's word nor what genesis nodes agree on. One that cannot be had is none, and says why (balanceProblem).
      prepareSend: async (d) => {
        const from = live.current.wallet.qnetAddress;
        const token = d.type === 'tokenTransfer';
        const planned = walletManager.previewSend(from);
        const nonce = planned.then((p) => p.confirmed, () => null);
        const [plan, balance, sentTo, added, tokenBalance, need] = await Promise.all([
          planned,
          walletManager.certifiedQncForSend(from, { nonce }).catch(() => null),
          walletManager.sentRecipients().catch(() => []),
          d.type === 'transfer' ? [] : walletManager.addedTokens().catch(() => []),
          token ? walletManager.checkedTokenBalance(d.token, from, d.decimals, { nonce }).catch(() => null) : null,
          token ? walletManager.qrc20TransferQncNeedNano(d.token, d.to, d.amountBase).catch(() => null) : null,
        ]);
        const listed = (contract) => added.find((c) => (c.contract_address || c.contract) === contract) || null;
        // The decimals the user's token list recorded for this token decide what an amount means (MOBNET-R3-05): a
        // network answer that differs from them signs nothing.
        const record = token ? listed(d.token) : null;
        if (record && Number(record.decimals) !== d.decimals) throw Object.assign(new Error('decimals'), { code: 'TOKEN_DECIMALS' });
        const recipients = await recipientContext(from, sentTo, plan.live)
          .catch(() => ({ counterparties: [], paid: [], senders: [] }));
        return {
          nonce: plan.nonce,
          confirmed: plan.confirmed,
          balanceNano: balance && balance.ok ? balance.balanceNano : null,
          verified: !!(balance && balance.ok && balance.verified),
          ...balanceRead(balance, token ? tokenBalance || { ok: false, error: 'unanswered' } : null),
          ...recipients,
          // This wallet's unconfirmed transactions: a site's send waits for them, or replaces the one at the confirmed
          // nonce + 1, never goes in addition (dappProvider); the sheet warns about the same payment made a moment ago.
          pending: plan.live,
          replaceNonce: plan.replace ? plan.replace.nonce : null,
          replaceHash: plan.replace ? plan.replace.bodyHash : null,
          recent: plan.recent,
          ...(token ? {
            tokenBalanceBase: tokenBalance && tokenBalance.ok ? tokenBalance.balanceBase : null,
            tokenVerified: !!(tokenBalance && tokenBalance.ok && tokenBalance.verified),
            // An unreadable recipient balance counts as none: the deposit is shown rather than missed.
            depositNano: need ? String(need.depositNano) : String(STORAGE_DEPOSIT_NANO),
            listed: !!record,
          } : {}),
        };
      },
      // A send's balances (and a token transfer's deposit) read again just before signing, as the preview reads them: the
      // provider signs nothing on a balance it could not read or that no longer covers the send.
      recheckSend: async (d) => {
        const from = live.current.wallet.qnetAddress;
        const token = d.type === 'tokenTransfer';
        const [balance, tokenBalance, need] = await Promise.all([
          walletManager.certifiedQncForSend(from).catch(() => null),
          token ? walletManager.checkedTokenBalance(d.token, from, d.decimals).catch(() => null) : null,
          token ? walletManager.qrc20TransferQncNeedNano(d.token, d.to, d.amountBase).catch(() => null) : null,
        ]);
        return {
          balanceNano: balance && balance.ok ? balance.balanceNano : null,
          ...balanceRead(balance, token ? tokenBalance || { ok: false, error: 'unanswered' } : null),
          ...(token ? {
            tokenBalanceBase: tokenBalance && tokenBalance.ok ? tokenBalance.balanceBase : null,
            depositNano: need ? String(need.depositNano) : String(STORAGE_DEPOSIT_NANO),
          } : {}),
        };
      },
      // The wallet's own send paths: nonce rules and kept signed bytes (services/PendingTx), signed only if the
      // nonce is still the one the sheet showed, the user's choice about unconfirmed transactions still holds, and it
      // is the confirmed nonce + 1 (a site's send never goes in addition to an earlier one: `oneInFlight`).
      send: async (d) => {
        const credential = live.current.credential;
        const opts = { expectNonce: d.nonce, choice: d.choice, oneInFlight: true };
        let r;
        if (d.type === 'transfer') {
          const n = Number(d.amountNano); // a safe integer: dappProvider caps a site's transfer (SAFE_AMOUNT_NANO)
          r = await walletManager.sendQNC(d.to, n / 1e9, credential, { ...opts, amountNano: n });
        } else {
          r = await contractSend(walletManager, d, credential, opts);
        }
        if (live.current.onSent) live.current.onSent(r);
        return sendAnswer(r);
      },
      transactionStatus: ({ from, nonce }) => walletManager.transactionStatusAt(from, Number(nonce)),
      // The page that asked is still the one in its tab (a closed tab's page never is).
      isCurrent: (binding) => {
        const p = binding ? pages.get(binding.tab) : null;
        return !!p && p.session.isCurrent(binding);
      },
      // An event goes to every tab that shows a page of `origin` (the injected script checks the origin again).
      emit: (origin, event, data) => {
        if (!origin) return;
        const code = eventScript(origin, event, data);
        for (const p of pages.values()) {
          if (p.session.origin === origin && p.web.current) p.web.current.injectJavaScript(code);
        }
      },
      onChange: (view) => live.current.onSheet(view ? { view, actions: actionsRef.current } : null),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  actionsRef.current = actionsRef.current || {
    approve: (id, pick) => engine.approve(id, pick),
    reject: (id) => engine.reject(id),
    dismiss: (id) => engine.dismiss(id),
    loadPreview: (id) => engine.loadPreview(id),
  };

  // Locking ends every open request (4100) and granted pages see no accounts; unlocking gives them back, in every tab.
  const unlocked = !!wallet && !!credential;
  const wasUnlocked = useRef(unlocked);
  useEffect(() => {
    if (wasUnlocked.current && !unlocked) engine.locked();
    if (!wasUnlocked.current && unlocked) {
      for (const origin of new Set([...pages.values()].map((p) => p.session.origin))) engine.unlocked(origin);
    }
    wasUnlocked.current = unlocked;
  }, [unlocked, engine, pages]);

  useEffect(() => () => {
    engine.cancelWhere(() => true, CODES.DISCONNECTED);
    live.current.onSheet(null);
  }, [engine]);

  // An answer goes into the tab that asked, and only while its page is the one that asked.
  const respond = (binding, answer) => {
    const p = pages.get(binding.tab);
    if (p && p.session.isCurrent(binding) && p.web.current) p.web.current.injectJavaScript(responseScript(binding, answer));
  };

  // `userInitiated`: the user moved the page (address bar, back, forward, reload, home); otherwise the page moved
  // itself, and a sheet it left behind after arming counts as a rejection (dappProvider.pageChanged).
  const pageMoved = (id, userInitiated = false) => {
    const p = pages.get(id);
    if (p) p.inflight.clear();
    engine.pageChanged({ userInitiated: userInitiated === true });
  };

  // What a tab's page does is said only while that tab is in front.
  const say = (id, key) => {
    if (id === tabsRef.current.active) setNotice(live.current.t(key));
  };

  const onMessage = async (id, event) => {
    const p = pages.get(id);
    if (!p) return;
    const { session, inflight } = p;
    const msg = readBridgeMessage(event && event.nativeEvent, { dev });
    if (!msg.ok) {
      if (msg.reply) {
        if (session.sawRequest(msg.reply.origin, msg.reply.doc)) pageMoved(id);
        respond(session.bind(msg.reply), { ok: false, error: pageError(new ProviderError(CODES.INVALID)) });
      }
      return;
    }
    if (session.sawRequest(msg.origin, msg.doc)) pageMoved(id);
    // A new document announced itself (its provider's first message): the page changed above if it did; nothing to answer.
    if (msg.method === PAGE_OPENED_METHOD) return;
    const binding = session.bind(msg);
    const key = `${binding.nav}:${binding.doc}`;
    const count = inflight.get(key) || 0;
    if (count >= PENDING_PER_PAGE) {
      respond(binding, { ok: false, error: pageError(new ProviderError(CODES.USER_REJECTED)) });
      return;
    }
    inflight.set(key, count + 1);
    let answer;
    try {
      answer = { ok: true, result: await engine.request({ origin: msg.origin, binding }, msg.method, msg.params) };
    } catch (e) {
      answer = { ok: false, error: pageError(e) };
    }
    const left = (inflight.get(key) || 1) - 1;
    if (left > 0) inflight.set(key, left);
    else inflight.delete(key);
    respond(binding, answer);
  };

  const openRef = useRef(null); // `openIn` below, for a navigation refused in favour of the explorer
  // Android refuses a navigation to a wallet-only aiqnet.io page natively and reports it here (the patched
  // RNCWebViewClient reportWalletOnly: `walletOnly`), so every platform says the same and opens the explorer the same:
  // a load (a link, a redirect, a form) takes the path below; the page's own history change it left by going back is
  // said as onNavState says it on iOS, the explorer opening only when there was nothing to go back to.
  // A top-frame navigation let through shows its address at once, as loading (tabs.startLoad): a tapped link is seen to
  // open the moment it is tapped, not only once its server answers. Android asks here while its UI thread waits; one it
  // cannot wait for is refused there and asked again without waiting, and JS then loads it (the patched
  // RNCWebViewClient askJsToLoad), so a link tapped while the app is busy opens late rather than never.
  const onShouldStart = (id, request) => {
    if (request.walletOnly === true && request.committed === true && request.loaded !== true) {
      say(id, 'browser_blocked_site');
      if (request.wentBack !== true) setTimeout(() => { if (openRef.current) openRef.current(id, EXPLORER_PAGE); }, 0);
      return false;
    }
    const topFrame = request.isTopFrame !== false;
    const decision = navigationDecision(request.url, { dev, topFrame });
    if (!decision.allow && topFrame && decision.reason !== 'invalid') {
      say(id, { insecure: 'browser_blocked_insecure', site: 'browser_blocked_site' }[decision.reason] || 'browser_blocked_external');
      // A wallet-only aiqnet.io page: the explorer opens in its place, in the same tab, once this navigation is refused.
      if (decision.redirect) setTimeout(() => { if (openRef.current) openRef.current(id, decision.redirect); }, 0);
    }
    if (decision.allow && topFrame && pages.has(id) && describeUrl(request.url)) update((s) => startLoad(s, id, request.url));
    return decision.allow;
  };

  // The page's origin follows navigation-state events only, and the patched WebView gives those the URL of the document
  // on screen (iOS: at didCommitNavigation; Android: the last doUpdateVisitedHistory, which its finish events carry too,
  // so an aborted navigation's onPageFinished names the page still shown). A navigation that starts and then fails, is
  // cancelled or aborts (a 204) never changes it (MBL-02, MB2-01). The address bar shows the same, except while the tab
  // loads an address (`pending`: opened by the user, or a top-frame navigation let through): that one is shown, without
  // the lock, until the next navigation-state event, which puts back the page on screen when nothing committed.
  const onNavState = (id, e) => {
    const p = pages.get(id);
    if (!p) return;
    const url = typeof e.url === 'string' ? e.url : '';
    // A wallet-only aiqnet.io page reached without a load (history.pushState, a site's client routing: iOS reports it
    // here only) is left at once and never becomes the address, the origin or a Recent entry (MB-04).
    if (isWalletOnlyPage(parseWebUrl(url))) {
      if (p.web.current) p.web.current.stopLoading();
      say(id, 'browser_blocked_site');
      if (e.canGoBack && p.web.current) p.web.current.goBack();
      else setTimeout(() => { if (openRef.current) openRef.current(id, EXPLORER_PAGE); }, 0);
      return;
    }
    const nav = { url, title: e.title || '', canGoBack: !!e.canGoBack, canGoForward: !!e.canGoForward, loading: !!e.loading };
    update((s) => showNav(s, id, nav));
    if (p.session.navigated(walletOriginOf(url, { dev }))) pageMoved(id);
  };

  // A load-start event that means a new document committed in the top frame (webViewEvents): whatever was on screen is
  // gone, so a sheet it left counts as left, the same origin included (MB2-04). Where the event also comes for history
  // updates, the new document's own first message tells instead (PAGE_OPENED_METHOD).
  const onLoadStart = (id) => {
    const p = pages.get(id);
    if (!p || !loadStartIsNewDocument()) return;
    p.session.newDocument();
    pageMoved(id);
  };

  // Progress events say whether a page is loading (before it commits too); they never touch the address.
  const onProgress = (id, e) => {
    const n = (e && e.nativeEvent) || {};
    update((s) => updateTab(s, id, (tab) => {
      const progress = n.progress || 0;
      const loading = typeof n.loading === 'boolean' ? n.loading : tab.nav.loading;
      if (tab.progress === progress && tab.nav.loading === loading) return tab;
      return { ...tab, progress, nav: tab.nav.loading === loading ? tab.nav : { ...tab.nav, loading } };
    }));
  };

  // A page that finished loading goes into the recent pages, unless its tab is gone (closed, or every tab by "Clear
  // browsing data": history.js then answers the empty list for a page it was remembering meanwhile).
  const onLoadEnd = (id, e) => {
    const n = e && e.nativeEvent;
    if (!pages.has(id) || !n || n.code || typeof n.url !== 'string' || isWalletOnlyPage(parseWebUrl(n.url))) return;
    rememberPage(n.url, n.title).then(setRecent);
  };

  // Tab `id` opens `url`, its address in the address bar at once.
  const openIn = (id, url) => {
    if (!pages.has(id)) return;
    // An address typed or picked from the recent list gets the same policy as a page's navigation (a WebView does
    // not ask onShouldStartLoadWithRequest for the page it is given as its source on every platform).
    const decision = navigationDecision(url, { dev, topFrame: true });
    if (!decision.allow) {
      say(id, { insecure: 'browser_blocked_insecure', site: 'browser_blocked_site' }[decision.reason] || 'browser_address_invalid');
      if (!decision.redirect) return;
    }
    const target = decision.allow ? url : decision.redirect;
    // A WebView never loads again the page it shows when given it as its source: that page is loaded again instead.
    const tab = findTab(tabsRef.current, id);
    const web = webOf(id);
    const again = holdsPage(tab) && !tab.lost && tab.nav.url === target && web;
    pages.get(id).session.reset();
    pageMoved(id, true);
    update((s) => openInTab(s, id, target));
    if (again) web.reload();
    setWiper(0); // a page is open again; after a clear its web view starts the session, and wipes, itself
    if (id === tabsRef.current.active) {
      setEditing(false);
      setMenu(false);
    }
  };
  openRef.current = openIn;
  const open = (url) => openIn(tabsRef.current.active, url);

  const submitAddress = () => {
    const r = addressToUrl(input, { dev });
    if (r.error) {
      setNotice(t(r.error === 'scheme' ? 'browser_address_scheme' : 'browser_address_invalid'));
      return;
    }
    open(r.url);
  };

  // The user moved the page (back, forward, reload, home): what it was loading is not shown any more.
  const userNavigated = (id) => {
    const p = pages.get(id);
    if (p) p.session.reset();
    pageMoved(id, true);
    update((s) => dropPending(s, id));
  };

  // The tab in front goes back in its own history; false when it has nothing to go back to.
  const goBack = () => {
    const tab = findTab(tabsRef.current, tabsRef.current.active);
    const web = tab ? webOf(tab.id) : null;
    if (!tab || tab.home || tab.source === null || !tab.nav.canGoBack || !web) return false;
    userNavigated(tab.id);
    web.goBack();
    return true;
  };

  const goForward = () => {
    const id = tabsRef.current.active;
    userNavigated(id);
    const web = webOf(id);
    if (web) web.goForward();
  };

  // A sheet on screen is modal: no tab opens, closes or comes forward while one is up (DappSheet covers the browser).
  const sheetOpen = () => engine.current() !== null;

  // What belonged to the tab that was in front goes with it: the address being typed, the menu, a notice.
  const resetChrome = () => {
    setEditing(false);
    setMenu(false);
    setInput('');
    setNotice('');
  };

  // Nothing another tab asked for waits for a sheet over the tab now in front.
  const endOtherTabs = (id) => engine.cancelWhere((a) => !a.binding || a.binding.tab !== id, CODES.USER_REJECTED);

  // The page a tab reopens in a new WebView: the one it showed, when the navigation policy still lets it in, else the
  // one it was given last.
  const resumeUrl = (tab) => {
    const url = tab.nav.url;
    return url && navigationDecision(url, { dev, topFrame: true }).allow ? url : tab.source.uri;
  };

  // Android: the render process of a tab's WebView died (every tab's, when the app's one renderer went). The tab in front
  // reopens its page at once in a new WebView; a tab behind drops its dead one and reopens when it comes forward, so the
  // tabs do not all load again at the same moment.
  const onRenderGone = (id) => {
    userNavigated(id);
    const tab = findTab(tabsRef.current, id);
    if (!holdsPage(tab)) return;
    if (id === tabsRef.current.active) update((st) => remountTab(st, id, resumeUrl(tab)));
    else update((st) => loseTab(st, id));
  };

  // A lost tab that came forward (switched to, or next after the tab in front closed) gets its new WebView.
  const frontTab = findTab(tabState, tabState.active);
  const frontLost = !!frontTab && frontTab.lost;
  useEffect(() => {
    const tab = findTab(tabsRef.current, tabsRef.current.active);
    if (tab && tab.lost) update((st) => remountTab(st, tab.id, resumeUrl(tab)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontLost, tabState.active]);

  const switchTo = (id) => {
    const s = tabsRef.current;
    const tab = findTab(s, id);
    if (sheetOpen() || !tab) return false;
    if (s.active !== id) pauseMedia(s.active);
    update((st) => selectTab(st, id));
    setOverview(false);
    resetChrome();
    endOtherTabs(id);
    return true;
  };

  const newTab = () => {
    if (sheetOpen()) return false;
    if (!canAddTab(tabsRef.current)) {
      setNotice(t('browser_tabs_full', { max: MAX_TABS }));
      return false;
    }
    pauseMedia(tabsRef.current.active);
    const id = makeTab();
    update((s) => addTab(s, id));
    setOverview(false);
    resetChrome();
    endOtherTabs(id);
    return true;
  };

  const closeTabById = (id) => {
    if (sheetOpen() || !findTab(tabsRef.current, id)) return;
    const wasFront = tabsRef.current.active === id;
    pages.delete(id);
    const freshId = tabsRef.current.tabs.length === 1 ? makeTab() : null;
    update((s) => closeTab(s, id, freshId));
    // Its page's requests end with it (4001), and nothing is answered into it any more.
    engine.pageChanged({ userInitiated: true });
    if (wasFront) resetChrome();
  };

  // Every tab closes and one fresh tab is left. No WebView of the old tabs stays, so their browsing session ends with
  // them (webViewEvents.incognitoFor), and every request of their pages ends (4001).
  const closeEveryTab = () => {
    pages.clear();
    const id = makeTab();
    update(() => closeAllTabs(id));
    engine.pageChanged({ userInitiated: true });
    setOverview(false);
    resetChrome();
  };

  // Closing every tab signs the user out of every site open in them: asked first whenever a tab holds a page.
  const closeAll = () => {
    if (sheetOpen()) return;
    if (!tabsRef.current.tabs.some(holdsPage)) {
      closeEveryTab();
      return;
    }
    confirmAction(t('browser_close_all_title'), t('browser_close_all_body'), () => {
      if (!sheetOpen()) closeEveryTab();
    }, t('browser_close_all_tabs'));
  };

  const clearData = () => {
    closeEveryTab();
    clearHistory();
    setRecent([]);
    // Android: what the session left on the phone is wiped now, not when the next page opens (webViewEvents).
    if (clearNeedsWipe()) setWiper((k) => (k % 1000) + 1);
  };

  const openOverview = () => {
    if (sheetOpen()) return;
    setEditing(false);
    setMenu(false);
    Keyboard.dismiss();
    setOverview(true);
  };

  useImperativeHandle(ref, () => ({
    // Android back: the tab overview, the menu or the typed address closes first, then the tab in front goes back in its
    // own history; false when there is nothing to go back to here.
    handleBack: () => {
      if (overviewRef.current) { setOverview(false); return true; }
      if (menu) { setMenu(false); return true; }
      if (editing) { setEditing(false); return true; }
      return goBack();
    },
    revoke: (origin) => engine.revoke(origin),
    // Every open request of the browser ends as rejected (4001): a QNet Link request came in, and nothing of the
    // browser may sit over or under it (MOBLINK-R2-03).
    cancelAll: () => engine.cancelWhere(() => true, CODES.USER_REJECTED),
    clearData,
  }));

  const { tabs, active } = tabState;
  const front = findTab(tabState, active) || tabs[0];
  const { nav, progress, pending } = front;
  // The address bar: the address being loaded while there is one, else the page on screen.
  const shownUrl = pending || nav.url;
  const page = describeUrl(shownUrl);
  const showPage = !front.home && front.source !== null;
  const loading = nav.loading || !!pending;
  const full = !canAddTab(tabState);
  const compact = barWidth > 0 && barWidth < COMPACT_TOOLBAR;

  const addressBar = () => {
    if (editing || !showPage) {
      return (
        <TextInput
          style={s.addressInput}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={submitAddress}
          onBlur={() => setEditing(false)}
          placeholder={t('browser_address_placeholder')}
          placeholderTextColor="#667085"
          autoFocus={editing}
          selectTextOnFocus
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          importantForAutofill="no"
          textContentType="URL"
          keyboardType="url"
          returnKeyType="go"
          accessibilityLabel={t('browser_address_label')}
        />
      );
    }
    // An address still loading has no lock and no emphasis: only the page on screen gets them.
    return (
      <TouchableOpacity
        style={s.addressShown}
        onPress={() => { setInput(shownUrl); setEditing(true); }}
        accessibilityRole="button"
        accessibilityLabel={page ? page.host : t('browser_address_label')}
        testID={pending ? 'browser-address-loading' : 'browser-address'}
      >
        {page && page.secure && !pending ? <LockGlyph color="#00d4ff" /> : null}
        <Text style={s.addressText} numberOfLines={1} ellipsizeMode="head">
          {page ? (
            <>
              <Text style={s.addressPrefix}>{page.prefix}</Text>
              <Text style={pending ? s.addressPrefix : s.addressDomain}>{page.domain}</Text>
              {page.port ? <Text style={s.addressPrefix}>{`:${page.port}`}</Text> : null}
            </>
          ) : shownUrl}
        </Text>
      </TouchableOpacity>
    );
  };

  // `mirror`: an arrow that points the other way in a right-to-left language.
  const toolButton = (label, d, onPress, disabled = false, mirror = false) => (
    <TouchableOpacity
      style={[s.tool, disabled && s.toolOff]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
    >
      <View style={mirror && rtl ? s.mirror : null}>{glyph(d)}</View>
    </TouchableOpacity>
  );

  const startPage = () => (
    <ScrollView style={s.start} contentContainerStyle={s.startBody} keyboardShouldPersistTaps="handled">
      <TouchableOpacity style={s.tile} onPress={() => open(BOOKMARK_URL)} accessibilityRole="button" testID="bookmark-aiqnet">
        <View style={s.tileMark}><Text style={s.tileMarkText}>Q</Text></View>
        <View style={s.tileText}>
          <Text style={s.tileTitle}>aiqnet.io</Text>
          <Text style={s.tileSub} numberOfLines={2}>{t('browser_bookmark_explorer')}</Text>
        </View>
      </TouchableOpacity>
      <Text style={s.sectionTitle}>{t('browser_recent')}</Text>
      {recent.length === 0 ? <Text style={s.empty}>{t('browser_recent_empty')}</Text> : recent.map((e) => {
        const d = describeUrl(e.url);
        return (
          <TouchableOpacity key={e.url} style={s.recentRow} onPress={() => open(e.url)} accessibilityRole="button">
            <Text style={s.recentTitle} numberOfLines={1}>{e.title || (d ? d.host : e.url)}</Text>
            <Text style={s.recentUrl} numberOfLines={1} ellipsizeMode="middle">{e.url}</Text>
          </TouchableOpacity>
        );
      })}
      <TouchableOpacity
        style={s.clearButton}
        onPress={() => confirmAction(t('browser_clear_title'), t('browser_clear_body'), clearData)}
        accessibilityRole="button"
      >
        <Text style={s.clearText}>{t('browser_clear')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );

  // Every tab with a page keeps its WebView, so its page stays loaded; only the page of the tab in front is shown and
  // takes touches, and the others are hidden from screen readers too.
  const tabPage = (tab) => {
    const p = pages.get(tab.id);
    if (!p || tab.source === null || tab.lost) return null;
    const { id } = tab;
    const shown = id === active && !tab.home;
    return (
      <View
        key={id}
        style={[s.web, shown ? s.shown : s.hidden]}
        pointerEvents={shown ? 'auto' : 'none'}
        importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
        accessibilityElementsHidden={!shown}
      >
        <WebView
          key={tab.webKey}
          ref={p.web}
          source={tab.source}
          originWhitelist={dev ? ['https://*', 'http://localhost*', 'http://127.0.0.1*'] : ['https://*']}
          onShouldStartLoadWithRequest={(request) => onShouldStart(id, request)}
          injectedJavaScriptBeforeContentLoaded={script}
          injectedJavaScript={script}
          injectedJavaScriptForMainFrameOnly
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
          onMessage={(e) => onMessage(id, e)}
          javaScriptEnabled
          domStorageEnabled
          incognito={incognitoFor(startsSession(tab))}
          cacheEnabled={false}
          thirdPartyCookiesEnabled={false}
          sharedCookiesEnabled={false}
          mixedContentMode="never"
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          geolocationEnabled={false}
          paymentRequestEnabled={false}
          mediaCapturePermissionGrantType="deny"
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction
          allowsLinkPreview={false}
          allowsBackForwardNavigationGestures
          dataDetectorTypes="none"
          saveFormDataDisabled
          webviewDebuggingEnabled={false}
          setDisplayZoomControls={false}
          onNavigationStateChange={(e) => onNavState(id, e)}
          onLoadStart={() => onLoadStart(id)}
          onLoadProgress={(e) => onProgress(id, e)}
          onLoadEnd={(e) => onLoadEnd(id, e)}
          onRenderProcessGone={() => onRenderGone(id)}
          onContentProcessDidTerminate={() => { const web = webOf(id); if (web) web.reload(); }}
          renderError={(domain, code, description) => (
            <View style={s.errorView}>
              <Text style={s.errorTitle}>{t('browser_error_title')}</Text>
              <Text style={s.errorText}>{t('browser_error_body')}</Text>
              {description ? <Text style={s.errorDetail}>{String(description)}</Text> : null}
            </View>
          )}
          renderLoading={() => <ActivityIndicator color="#00d4ff" style={s.loading} />}
          style={s.webview}
        />
      </View>
    );
  };

  // What a tab is called in the overview: its page's title and host, or the start page.
  const tabText = (tab) => {
    if (tab.home || tab.source === null) return { title: t('browser_home'), host: '' };
    const url = tab.nav.url || tab.source.uri;
    const d = describeUrl(url);
    const host = d ? d.host : '';
    return { title: visibleLabel(tab.nav.title, TITLE_MAX) || host || visibleLabel(url, TITLE_MAX), host };
  };

  const tabOverview = () => (
    <View style={s.overview} accessibilityViewIsModal testID="browser-tab-overview">
      <View style={s.overviewHeader}>
        <Text style={s.overviewTitle} numberOfLines={1}>{t('browser_tabs_count', { count: tabs.length })}</Text>
        <TouchableOpacity style={s.overviewDone} onPress={() => setOverview(false)} accessibilityRole="button">
          <Text style={s.overviewDoneText}>{t('common_done')}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={s.start} contentContainerStyle={s.overviewBody}>
        {tabs.map((tab) => {
          const { title, host } = tabText(tab);
          const inFront = tab.id === active;
          return (
            <View key={tab.id} style={[s.tabRow, inFront && s.tabRowFront]}>
              <TouchableOpacity
                style={s.tabMain}
                onPress={() => switchTo(tab.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: inFront }}
                testID={`browser-tab-${tab.id}`}
              >
                <Text style={[s.tabTitle, inFront && s.tabTitleFront]} numberOfLines={1}>{title}</Text>
                {host ? <Text style={s.tabHost} numberOfLines={1} ellipsizeMode="head">{host}</Text> : null}
              </TouchableOpacity>
              <TouchableOpacity
                style={s.tabClose}
                onPress={() => closeTabById(tab.id)}
                accessibilityRole="button"
                accessibilityLabel={t('browser_close_tab', { title })}
                testID={`browser-tab-close-${tab.id}`}
              >
                {glyph('M6 6l12 12M18 6L6 18', ICON, 18)}
              </TouchableOpacity>
            </View>
          );
        })}
        {full ? <Text style={s.tabsNote}>{t('browser_tabs_full', { max: MAX_TABS })}</Text> : null}
        <View style={s.overviewActions}>
          <TouchableOpacity
            style={[s.overviewButton, full && s.toolOff]}
            onPress={newTab}
            disabled={full}
            accessibilityRole="button"
            accessibilityState={{ disabled: full }}
            testID="browser-new-tab"
          >
            <Text style={s.overviewButtonText}>{t('browser_new_tab')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.overviewButton} onPress={closeAll} accessibilityRole="button" testID="browser-close-all">
            <Text style={s.overviewButtonText}>{t('browser_close_all_tabs')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );

  const menuItems = [
    // On a tablet the share sheet is a popover: it points at the menu button it came from.
    showPage ? [t('browser_share'), () => {
      setMenu(false);
      Share.share({ message: nav.url }, { anchor: findNodeHandle(menuButtonRef.current) || undefined }).catch(() => {});
    }] : null,
    showPage ? [t('browser_copy'), () => { setMenu(false); Clipboard.setString(nav.url); setNotice(t('browser_copied')); }] : null,
    // A narrow toolbar has no Forward button (COMPACT_TOOLBAR): it is here instead, while there is a page to go to.
    compact && showPage && nav.canGoForward ? [t('browser_forward'), () => { setMenu(false); goForward(); }] : null,
    [t('browser_new_tab'), () => { setMenu(false); newTab(); }],
    [t('browser_home'), () => {
      // Its page stays loaded under the start page (the browsing session goes on) but no longer plays.
      pauseMedia(active);
      userNavigated(active);
      setMenu(false);
      update((st) => updateTab(st, active, { home: true }));
      setInput('');
    }],
    [t('browser_clear'), () => { setMenu(false); confirmAction(t('browser_clear_title'), t('browser_clear_body'), clearData); }],
  ].filter(Boolean);

  // Android: the hidden web view that wipes a cleared session's data, only while no tab holds a page (so no tab is
  // signed out by it); it goes once it has loaded its blank page, or once a page is opened.
  const wipeView = () => (wiper && !tabs.some(holdsPage) ? (
    <View style={s.wiper} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <WebView
        key={`wipe${wiper}`}
        testID="browser-wiper"
        source={{ uri: 'about:blank' }}
        originWhitelist={['about:blank']}
        onShouldStartLoadWithRequest={() => false}
        incognito
        cacheEnabled={false}
        javaScriptEnabled={false}
        domStorageEnabled={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        saveFormDataDisabled
        webviewDebuggingEnabled={false}
        onLoadEnd={() => setWiper(0)}
      />
    </View>
  ) : null);

  // While the tab overview is up it is the only thing a screen reader reaches: the toolbar, the notices and the pages
  // under it are hidden.
  const underOverview = overview
    ? { importantForAccessibility: 'no-hide-descendants', accessibilityElementsHidden: true }
    : { importantForAccessibility: 'auto', accessibilityElementsHidden: false };

  return (
    <View style={s.pane}>
      <View style={s.chrome} {...underOverview} testID="browser-chrome">
        <View style={s.toolbar} onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}>
          {toolButton(t('browser_back'), 'M15 5l-7 7 7 7', goBack, !showPage || !nav.canGoBack, true)}
          {compact ? null : toolButton(t('browser_forward'), 'M9 5l7 7-7 7', goForward, !showPage || !nav.canGoForward, true)}
          <View style={s.addressBox}>{addressBar()}</View>
          {showPage && loading
            ? toolButton(t('browser_stop'), 'M6 6l12 12M18 6L6 18', () => {
              update((st) => dropPending(st, active));
              const web = webOf(active);
              if (web) web.stopLoading();
            })
            : toolButton(t('browser_reload'), 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6', () => {
              userNavigated(active);
              const web = webOf(active);
              if (web) web.reload();
            }, !showPage)}
          <TouchableOpacity
            style={s.tool}
            onPress={openOverview}
            accessibilityRole="button"
            accessibilityLabel={t('browser_tabs_count', { count: tabs.length })}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            testID="browser-tabs"
          >
            <View style={s.tabCount}><Text style={s.tabCountText}>{tabs.length}</Text></View>
          </TouchableOpacity>
          <TouchableOpacity ref={menuButtonRef} style={s.tool} onPress={() => setMenu((m) => !m)} accessibilityRole="button" accessibilityLabel={t('browser_menu')}>
            <MenuGlyph />
          </TouchableOpacity>
        </View>
        {showPage && loading && progress < 1 ? (
          <View style={s.progressTrack}><View style={[s.progressBar, { width: `${Math.max(5, Math.round(progress * 100))}%` }]} /></View>
        ) : <View style={s.progressTrack} />}
        {page && page.idn && showPage ? <Text style={s.idn}>{t('browser_idn_notice')}</Text> : null}
        {notice ? <Text style={s.notice} accessibilityLiveRegion="polite">{notice}</Text> : null}
        <View style={s.content}>
          {tabs.map(tabPage)}
          {showPage ? null : startPage()}
        </View>
      </View>
      {wipeView()}
      {menu ? (
        <>
          <TouchableOpacity style={s.menuBackdrop} activeOpacity={1} onPress={() => setMenu(false)} />
          <View style={s.menuCard}>
            {menuItems.map(([label, onPress]) => (
              <TouchableOpacity key={label} style={s.menuItem} onPress={onPress} accessibilityRole="button">
                <Text style={s.menuText}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      ) : null}
      {overview ? tabOverview() : null}
    </View>
  );
});

export default BrowserScreen;

const s = StyleSheet.create({
  pane: { flex: 1, backgroundColor: '#11131f' },
  chrome: { flex: 1 },
  toolbar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 6, backgroundColor: '#16213e',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(0, 212, 255, 0.3)',
  },
  tool: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  toolOff: { opacity: 0.35 },
  addressBox: { flex: 1, minWidth: 0, marginHorizontal: 2 },
  addressInput: {
    height: 36, borderRadius: 18, backgroundColor: '#0f1424', color: '#ffffff', paddingHorizontal: 12, paddingVertical: 0,
    fontSize: 14, borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.35)',
  },
  addressShown: {
    height: 36, borderRadius: 18, backgroundColor: '#0f1424', paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  addressText: { flex: 1, fontSize: 14, writingDirection: 'ltr' },
  addressPrefix: { color: '#8a93a6' },
  addressDomain: { color: '#ffffff', fontWeight: '700' },
  // The tab count: a small outlined square, like the tabs button of a phone's own browser.
  tabCount: {
    minWidth: 20, height: 20, paddingHorizontal: 3, borderRadius: 5, borderWidth: 2, borderColor: ICON,
    alignItems: 'center', justifyContent: 'center',
  },
  tabCountText: { color: ICON, fontSize: 11, fontWeight: '700' },
  progressTrack: { height: 2, backgroundColor: 'transparent' },
  progressBar: { height: 2, backgroundColor: '#00d4ff' },
  idn: { color: '#ffaa00', fontSize: 12, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#2a220d' },
  notice: { color: '#ffffff', fontSize: 13, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#23304f' },
  content: { flex: 1 },
  web: { ...StyleSheet.absoluteFillObject },
  wiper: { position: 'absolute', top: 0, start: 0, width: 1, height: 1, opacity: 0 },
  shown: { zIndex: 1 },
  hidden: { opacity: 0 },
  webview: { flex: 1, backgroundColor: '#ffffff' },
  loading: { position: 'absolute', top: 16, alignSelf: 'center' },
  start: { flex: 1, backgroundColor: '#11131f' },
  startBody: { padding: 16, paddingBottom: 32, width: '100%', maxWidth: 640, alignSelf: 'center' },
  tile: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a2e', borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.3)', marginBottom: 20,
  },
  tileMark: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#00d4ff', alignItems: 'center', justifyContent: 'center', marginEnd: 12 },
  tileMarkText: { color: '#11131f', fontSize: 22, fontWeight: '800' },
  tileText: { flex: 1, minWidth: 0 },
  tileTitle: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  tileSub: { color: '#9aa3b5', fontSize: 13, marginTop: 2 },
  sectionTitle: { color: '#9aa3b5', fontSize: 13, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase' },
  empty: { color: '#667085', fontSize: 13, marginBottom: 16 },
  recentRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a3350' },
  recentTitle: { color: '#ffffff', fontSize: 14 },
  recentUrl: { color: '#667085', fontSize: 12, marginTop: 2, writingDirection: 'ltr' },
  clearButton: {
    marginTop: 20, alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  clearText: { color: '#00d4ff', fontSize: 14, fontWeight: '600' },
  errorView: { ...StyleSheet.absoluteFillObject, backgroundColor: '#11131f', alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorTitle: { color: '#ffffff', fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  errorText: { color: '#9aa3b5', fontSize: 13, textAlign: 'center' },
  errorDetail: { color: '#667085', fontSize: 12, textAlign: 'center', marginTop: 8, writingDirection: 'ltr' },
  mirror: { transform: [{ scaleX: -1 }] },
  menuBackdrop: { ...StyleSheet.absoluteFillObject, zIndex: 50 },
  menuCard: {
    position: 'absolute', top: 46, end: 8, minWidth: 200, maxWidth: '90%', backgroundColor: '#16213e', borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.3)', paddingVertical: 4, zIndex: 51, elevation: 12,
  },
  menuItem: { paddingVertical: 12, paddingHorizontal: 16 },
  menuText: { color: '#ffffff', fontSize: 15 },
  // The tab overview covers the whole browser pane; the pages stay loaded under it.
  overview: { ...StyleSheet.absoluteFillObject, backgroundColor: '#11131f', zIndex: 40, elevation: 10 },
  overviewHeader: {
    flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingStart: 16, paddingEnd: 4, backgroundColor: '#16213e',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(0, 212, 255, 0.3)',
  },
  overviewTitle: { flex: 1, minWidth: 0, color: '#ffffff', fontSize: 16, fontWeight: '700' },
  overviewDone: { minWidth: 44, minHeight: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  overviewDoneText: { color: '#00d4ff', fontSize: 15, fontWeight: '600' },
  overviewBody: { padding: 16, paddingBottom: 32, width: '100%', maxWidth: 640, alignSelf: 'center' },
  tabRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a2e', borderRadius: 12, borderWidth: 1,
    borderColor: '#2a3350', marginBottom: 10,
  },
  tabRowFront: { borderColor: '#00d4ff', backgroundColor: 'rgba(0, 212, 255, 0.08)' },
  tabMain: { flex: 1, minWidth: 0, minHeight: 56, paddingVertical: 8, paddingStart: 14, justifyContent: 'center' },
  tabTitle: { color: '#ffffff', fontSize: 15 },
  tabTitleFront: { fontWeight: '700' },
  tabHost: { color: '#667085', fontSize: 12, marginTop: 2, writingDirection: 'ltr' },
  tabClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginEnd: 4 },
  tabsNote: { color: '#ffaa00', fontSize: 13, lineHeight: 19, marginTop: 2, marginBottom: 8 },
  overviewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  overviewButton: {
    flexGrow: 1, flexBasis: 140, minHeight: 44, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14,
    borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.3)', alignItems: 'center', justifyContent: 'center',
  },
  overviewButtonText: { color: '#00d4ff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
