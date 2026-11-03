import React, { useState, useEffect, useRef, useMemo, useContext } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  ScrollView,
  Image,
  Platform,
  RefreshControl,
  TouchableWithoutFeedback,
  DeviceEventEmitter,
  Linking,
  AppState,
  Modal,
  Share,
  FlatList,
  KeyboardAvoidingView,
  BackHandler,
  Keyboard,
} from 'react-native';
import { SafeAreaView, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Clipboard from '@react-native-clipboard/clipboard'; // addresses and transaction hashes only
import WalletManager, { VaultCorruptError } from '../components/WalletManager';
import { isValidQnetAddress } from '../crypto/WalletIdentity';
import { usesReservedName, contractShortId, tokenVisible, tokenLabel } from '../utils/tokenSafety';
import { DeviceKeyError } from '../crypto/Vault';
import {
  useProtectedInteraction, deviceIntegrity, deviceAuthenticate, screenReaderApps, setNativeTexts, bootClock,
  guardSeedField, pasteboardChangeCount, clearPasteboardIfChanged, clearClipboard, SECRET_CLIPBOARD_SECONDS,
  reloadApp,
} from '../services/DeviceSecurity';
import { PASSWORD_INPUT_PROPS, SEED_INPUT_PROPS, CONFIRM_INPUT_PROPS, looksPasted } from '../utils/sensitiveInput';
import QRCode from 'react-native-qrcode-svg';
import {
  LAST_ANSWER_KEY,
  selfAttestIfNeeded,
  checkServerNodeStatus,
  getWalletNodeEvents,
  getNodeEpochs,
  getPendingRewards,
  refreshFcmTokenOnServer,
  isTokenRefreshNeeded,
  teardownLightNodeIfForeign,
  forgetIfReplaced,
  stopLightNode,
  bindThisDevice,
  localBinding,
  localNode,
  signStatusWithPingKey,
  resendPendingBinding,
  enrolAgainIfUnleased,
  nodeCheckState,
  endExpiredLink,
  settleUnansweredKey,
  refreshLeaseFromTab,
  readdressIfOwed,
  readUnconfirmedBinding,
  settleUnconfirmedBinding,
} from '../services/PushService';
import { bindingVerdict, linkedHere, readNodeStatus, readLinkPending, readServerNodeListed, serverStatusNames } from '../services/LightNode';
import { openBackgroundSettings, readBackground } from '../services/BackgroundPriority';
import {
  ACCOUNT_EVENT_MS, ACCOUNT_EVENT_READS, ASSETS_POLL_MS, HISTORY_POLL_MS, LIVE_READ_MS, LIVE_SHARE_MS, NODE_STATUS_MS,
  TIP_READ_MS, balanceDue, balanceRead, estimatedHeight, linkingReadMs, liveHeightFits, pollMs, socketRetryMs,
} from '../utils/requestPace';
import { readNodeRecordState, pendingNodeType } from '../services/NodeRecordRead';
import { checkDevice, isThisDevice, showPlayDialog } from '../services/NodeDeviceKey';
import { noteStatus as noteDeviceStatus } from '../services/DeviceEnrolment';
import { nodeLinkActions } from '../services/NodeLinkActions';
import { LEGACY_MOVE, NEW_APP_PLAY_URL, NEW_APP_SITE_URL } from '../config/legacy';
import NodeTab, { lightNodeShown, nodeView, serverStatusAfter } from './NodeTab';
import { getRandomGenesisNode, EXPLORER_API, explorerTxUrl, solanaExplorerTxUrl, ONE_DEV_MINT } from '../config/nodes';
import TxResultCard from '../components/TxResultCard';
import { InfoRow, LinkRow, SettingRow } from '../components/InfoRow';
import { DayHeader, HistoryRow, TxDetail, dateTime } from './HistoryTab';
import {
  txDirection,
  HISTORY_PAGE, fmtTokenBaseUnits, historyRowKey, tokenRowFromEvent, splitExplorerItems,
  mergeHistory, appendHistory, cacheableHistory, nodeNativeRow, txLookupState, historyEntries, historySections,
  rowsToSettle, nonceAnswer, withNonceAnswer, withListing, checkedCachedRows, markInBlock, nodeEventRow, withNodeEvents,
  lookupLedger, tokenRowsToProve, withProofVerdicts, listingKey,
} from '../utils/txHistory';
import { TRANSFER_FEE_NANO, TRANSFER_FEE_QNC } from '../config/fees';
import { amountShare, amountInput } from '../utils/sendAmount';
import { amountText, formatNano, qncText } from '../utils/amountFormat';
import { NO_MASKS, masked, readMasks, writeMask } from '../utils/privacy';
import { useHoldForUser } from '../utils/userAction';
import { refusalReason, sendErrorText } from '../utils/txRefusal';
import { parseLink } from '../services/QNetLink';
import { noteLink, watchLinks } from '../services/LinkInbox';
import { resumeKept, resumeRegistration } from '../services/RegistrationSubmit';
import QNetLinkScreen from './QNetLinkScreen';
import AnswerAway from '../components/AnswerAway';
import BottomBar from '../components/BottomBar';
import Action, { ActionPair, ActionRow } from '../components/ui/Action';
import Field from '../components/ui/Field';
import Head from '../components/ui/Head';
import Menu from '../components/ui/Menu';
import Section, { sectionStyles } from '../components/ui/Section';
import Sheet from '../components/ui/Sheet';
import StartScreen, { START_EDGES, StartField } from '../components/ui/StartScreen';
import Tabs from '../components/ui/Tabs';
import Copyable, { ADDRESS_LINE } from '../components/ui/Copyable';
import SecretCopy from '../components/ui/SecretCopy';
import TokenIcon from '../components/TokenIcons';
import { Checkbox, Toggle } from '../components/ui/Toggle';
import QrScanSheet from '../components/QrScanSheet';
import BrowserScreen, { recipientContext } from '../browser/BrowserScreen';
import DappSheet, { pendingLine } from '../browser/DappSheet';
import SendReview, { recipientWarnings } from '../components/SendReview';
import SolanaSendForm, { cleanAmountInput, useSolanaSends } from './SolanaSend';
import { AssetRow, TokenDetail, TokenPicker, assetMatches, pickId } from './TokenScreens';
import { SOLANA_TOKENS, solanaHistoryRow, solanaToken } from '../services/SolanaSend';
import { tokenFacts } from '../services/TokenFacts';
import { solanaScanToForm } from '../utils/solanaRequest';
import { readTransferLink } from '../services/transferLink';
import { addressParts, groupAddress } from '../utils/addressDisplay';
import { createGrantStore } from '../browser/grants';
import { describeOrigin, handedOverByBrowser } from '../browser/url';
import { mergeTokenBalances, optimisticTokenRow, tokenFigureRow } from '../utils/balanceMerge';
import {
  acceptedBalance, addMove, answerFloor, emptyTransit, moveOutcome, noteLiveWatermark,
  readTransit, runNote, settleMoves, transitRecord, transitTotal, withMoveStates, writeTransit,
} from '../services/ClaimTransit';
import { lastCountedPart, runMove, runMovedNano } from '../services/MoveRun';
import { claimErrorKey, moveNoteText } from '../utils/moveText';
import { autoSendable, refusalHeals } from '../services/PendingTx';
import { loadCachedHistory, saveCachedHistory } from '../services/HistoryCache';
import {
  LANGUAGES, LANGUAGE_KEY, makeT, languageName, savedLanguage, setCurrentLanguage, errorText, CHAIN_NAME,
} from '../i18n';
import { applyLayoutDirection, layoutLags } from '../i18n/direction';
import styles from './WalletScreen.styles';
import { color, setThemeLanguage } from '../theme';
import logger from '../utils/logger';

// Module-level block height cache, shared across all renders: one height read per 15 s at most, and a read in flight is
// shared by every caller (fetchCachedBlockHeight).
const _blockHeightCache = { height: 0, fetchedAt: 0, inFlight: null };

// A balance read that started less than this long ago serves a new call for the same wallet (WalletScreen loadBalance).
const BALANCE_SHARE_MS = 1000;
// The line under the figures on Assets says they are not updated only after QNC reads failed this many times in a row
// over at least this long (owner, 11.10: it never flashes with each read; the first read that lands takes it away).
const STALE_AFTER_FAILS = 2;
const STALE_AFTER_MS = 2 * 60_000;
// History checks token transfers against the committee this many at a time, after the balance read (loadTxHistory).
const HISTORY_PROOF_CONCURRENCY = 2;

// Whether two lists hold the same rows, field for field: a refresh that changed nothing keeps the list on screen, and
// the screen does not render again for it.
const sameRows = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((row, i) => {
  const other = b[i];
  if (row === other) return true;
  if (!row || !other || typeof row !== 'object' || typeof other !== 'object') return false;
  const keys = Object.keys(row);
  return keys.length === Object.keys(other).length && keys.every((k) => row[k] === other[k]);
});

// Minutes without a touch before the wallet locks; the same grace applies to time spent in the background. 'never':
// an open wallet has no inactivity timer and locks only with Lock Wallet, or when the app process ends.
const AUTO_LOCK_CHOICES = ['1', '5', '15', '30', 'never'];
const DEFAULT_AUTO_LOCK = '1';
const autoLockRank = (v) => (v === 'never' ? Infinity : Number(v));

// A QNC send of at least this many QNC asks again for the password (iOS: Face ID / Touch ID / passcode), so a
// phone picked up with the wallet open cannot empty it. The owner's choice; off until set.
// A link that arrives more than this long after the app came to the front, with the in-app browser on screen, was
// handed over by a page of that browser rather than opened by another app.
const LINK_FROM_OUTSIDE_MS = 2000;
// Codes of a send that stopped before anything was signed: "cannot send", never "transaction failed".
const NOTHING_SENT_CODES = ['PENDING_SETTLED', 'PENDING_CHANGED', 'PENDING_CHOICE', 'NONCE_UNKNOWN', 'TOO_MANY_PENDING', 'NONCE_CHANGED',
  'PENDING_UNREADABLE'];

// The longest a pull-to-refresh spinner turns (pullRefresh); the read it started may finish later.
const REFRESH_SPIN_MS = 3_000;
// A full screen keeps clear of the status bar, the notch, the side insets and the system navigation bar on every device
// (a tablet's status bar, Slide Over and Split View differ from a phone's), so nothing on it sits under a system bar.
const SCREEN_EDGES = ['top', 'left', 'right', 'bottom'];
// The open wallet's screen: its header takes the top inset itself, so its colour fills the status bar's area too.
const MAIN_EDGES = ['left', 'right'];
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
// The accounts a private key is exported for, as the extension offers them: the key, its name, the form it is written in.
const KEY_ACCOUNTS = [
  ['qnet', 'private_key_qnet', 'private_key_qnet_format'],
  ['solana', 'private_key_solana', 'private_key_solana_format'],
];
// Every orientation the app supports: an iOS modal is portrait-only unless told otherwise, and a tablet may be held any way.
const MODAL_ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'];
// How often the Node tab's periodic refresh asks for the node's signed status (it also comes on every open and pull).
const SIGNED_STATUS_MS = 5 * 60_000;
// The re-reads of the signed status after Use this device, while the node has not answered yet (rereadAfterUse).
const USE_REREAD_MS = [5000, 15000, 30000, 60000];
// How soon an unlock prompt owed at a cold start looks at the app's state again (autoUnlockRef).
const AUTO_UNLOCK_RECHECK_MS = 750;
// The back-off of the Node tab's read of aiqnet.io's record while it says "none" (loadSiteRecord).
const SITE_RECORD_FIRST_WAIT_MS = 60_000;
const SITE_RECORD_MAX_WAIT_MS = 15 * 60_000;
// How often the open Node tab reads a server node's counted and missed epochs again (an epoch is about four hours).
const SERVER_EPOCHS_MS = 5 * 60_000;
// How often a kept transaction the wallet still sends by itself is looked at away from the Assets tab (MB-R2-01).
const KEPT_SWEEP_MS = 15_000;
// The foreground follow (WalletManager.followTick, wallet-galc plan 2.4): one tick this often while the wallet is open
// and the app in front keeps a verified checkpoint at the head, in the background.
const FOLLOW_MS = 90_000;
// How often the Node tab's epoch clock moves on from the last height read (local: no request).
const CLOCK_TICK_MS = 15_000;

const MIN_PASSWORD = WalletManager.MIN_PASSWORD_LENGTH;
// The one-time offer to a password wallet to open with the screen lock instead (offerDeviceUnlock).


// Per-tab render isolation. Wraps a tab's JSX in a memo boundary keyed on the reactive values that
// tab actually reads (`deps`). The `render` thunk is recreated every parent render, but the custom
// comparator ignores it and re-renders ONLY when a dep changes — so an unrelated setState (balance /
// block-height / WS tick) no longer reconciles the active tab's subtree. `deps` must list every
// reactive value the tab reads (same contract as a useMemo dep array); a missing dep shows stale data
// but never crashes (the thunk still closes over live refs). A `key` per tab guarantees clean remount
// on tab switch, so no cross-tab output can leak.
const TabBox = React.memo(
  function TabBox({ render }) { return render(); },
  (prev, next) =>
    prev.deps.length === next.deps.length &&
    prev.deps.every((v, i) => Object.is(v, next.deps[i]))
);

// The last height read and when (ms), for the epoch clock that counts on from it (requestPace.estimatedHeight).
const heightRead = () => ({ height: _blockHeightCache.height, at: _blockHeightCache.fetchedAt });

function fetchCachedBlockHeight() {
  const now = Date.now();
  if (_blockHeightCache.height > 0 && now - _blockHeightCache.fetchedAt < 15_000) {
    return Promise.resolve(_blockHeightCache.height); // Cache hit — no network call
  }
  if (_blockHeightCache.inFlight) return _blockHeightCache.inFlight;
  _blockHeightCache.inFlight = (async () => {
    try {
      const apiUrl = getRandomGenesisNode();
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`${apiUrl}/api/v1/height`, { method: 'GET', signal: controller.signal }).finally(() => clearTimeout(t));
      if (resp.ok) {
        const data = await resp.json();
        const h = data.height || data.network_height || data.current_height || data.local_height || 0;
        if (Number.isSafeInteger(h) && h > 0) {
          _blockHeightCache.height = h;
          _blockHeightCache.fetchedAt = Date.now();
        }
      }
    } catch (_) { /* silent — return cached/zero */ }
    return _blockHeightCache.height;
  })().finally(() => { _blockHeightCache.inFlight = null; });
  return _blockHeightCache.inFlight;
}

// Display-format a token amount: fixed precision, then strip meaningless trailing zeros —
// "0.00000" → "0", "1.50000" → "1.5", "1.23456" → "1.23456". DISPLAY-ONLY: never feed this
// into math or input fields (those keep full toFixed precision).
const fmtAmount = (value, decimals) =>
  (Number(value) || 0).toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

// The app's mark in the header; the screens that hold no data draw the launch screen's (components/ui/StartScreen).
const APP_MARK = require('../../assets/qnet_logo.png');

// A group of Settings: its kicker over a strong rule, then its rows on the page itself, not on a card.
function SettingGroup({ title, children }) {
  return (
    <View style={styles.settingGroup}>
      <Text style={styles.settingGroupTitle}>{title}</Text>
      {children}
    </View>
  );
}

// An address as the subject of Receive, whole on two lines: a QNet Blockchain address in its own
// structure (19 hex and "eon", then 15 hex and the 8-hex check), any other in groups of four. Display only: what is
// copied is the raw address. Each line is the Assets card's address line (components/ui/Copyable), shrinking to half.
const SUBJECT_LINE = { ...ADDRESS_LINE, minimumFontScale: 0.5 };
function SubjectAddress({ address }) {
  const parts = addressParts(address);
  const groups = parts ? null : groupAddress(address).split(' ');
  const half = groups ? Math.ceil(groups.length / 2) : 0;
  const lines = parts
    ? [[parts[0], parts[1]], [parts[2], parts[3]]]
    : [[groups.slice(0, half).join(' '), ''], [groups.slice(half).join(' '), '']];
  return (
    <View>
      {lines.map(([main, tail], i) => (
        <Text key={i} style={styles.subjectLine} {...SUBJECT_LINE}>
          {main}
          {tail ? <Text style={i === 0 ? styles.subjectQuiet : null}>{` ${tail}`}</Text> : null}
        </Text>
      ))}
    </View>
  );
}

// Published by Orrery Group LLC on aiqnet.io; the app shows the same pages, it does not keep its own copy. Opened in the
// system browser, an ordinary visit to the site. The `from=app` query only names where the visit came from; the site
// shows the same page with or without it.
const LEGAL_LINKS = [
  ['legal_privacy', 'https://aiqnet.io/privacy?from=app'],
  ['legal_terms', 'https://aiqnet.io/terms?from=app'],
  ['legal_support', 'https://aiqnet.io/support?from=app'],
];

// A node type as the app names it ('light' → Light node); a type it does not know is shown as the network names it.
const nodeTitle = (t, type) => (['light', 'super', 'full'].includes(type)
  ? t(`node_title_${type}`) : (type ? String(type) : t('node_title_other')));
// The server (super, genesis) node the wallet's node read names for `owner` (WalletScreen walletNode), which takes the
// Node tab's server card; null for none, a light node, an unknown one or another wallet's.
const serverNodeOf = (node, owner) => (!!node && !node.none && !!owner && node.owner === owner && !!node.nodeType
  && node.nodeType !== 'light' ? node : null);

const WalletScreen = () => {
  // The device's insets: the main screen's header reaches up behind the status bar (and a Dynamic Island) and keeps its
  // title below them. Read from the provider in App.tsx; without one (a test render) they are zero.
  const insets = useContext(SafeAreaInsetsContext) || NO_INSETS;
  const [walletManager] = useState(() => new WalletManager()); // lazy: construct once, not every render
  const [hasWallet, setHasWallet] = useState(false);
  // One rule on every device (WalletManager.DEVICE_AUTH_FLAG): the stored wallet opens with the screen lock or with
  // its password; a new one gets the screen lock whenever the device has one that can hold its secret.
  const [walletDeviceAuth, setWalletDeviceAuth] = useState(false);
  const [deviceAuthAvail, setDeviceAuthAvail] = useState(false);
  const deviceAuth = hasWallet ? walletDeviceAuth : deviceAuthAvail;
  const [wallet, setWallet] = useState(null);
  const [balance, setBalance] = useState(0);
  // The password typed on the create, import and lock screens and, once the wallet is open, the session token (an
  // opaque object, never a string: MVA-R4-03). Text fields and length hints read only the typed text.
  const [password, setPassword] = useState('');
  const typedPassword = typeof password === 'string' ? password : '';
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // The screen's one-shot timers: each one still due when the screen goes ends with it (the unmount cleanup).
  const timersRef = useRef(new Set());
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timersRef.current.delete(timer); fn(); }, ms);
    timersRef.current.add(timer);
    return timer;
  };
  const cancelLater = (timer) => {
    if (timer === null) return;
    clearTimeout(timer);
    timersRef.current.delete(timer);
  };
  // A pull to refresh, per tab (Assets, History, Node): a tab opened while another one's read runs starts idle, since an
  // iOS refresh control mounted already spinning can stay stuck. The spinner ends with the read (its timer with it) or
  // after REFRESH_SPIN_MS; a read still running then lands by itself.
  const [refreshing, setRefreshingState] = useState({ assets: false, history: false, node: false });
  const pullRefresh = async (tab, read) => {
    setRefreshingState((prev) => ({ ...prev, [tab]: true }));
    let spin = null;
    try {
      await Promise.race([Promise.resolve().then(read), new Promise((resolve) => { spin = later(resolve, REFRESH_SPIN_MS); })]);
    } catch (error) {
      logger.error('Error refreshing:', error);
    } finally {
      cancelLater(spin);
      setRefreshingState((prev) => ({ ...prev, [tab]: false }));
    }
  };
  const [showCreateOptions, setShowCreateOptions] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState('');
  const seedPastedRef = useRef(false); // the phrase arrived as one paste (see clearPastedPhrase)
  const seedBoardAtRef = useRef(null); // iOS: the pasteboard's change count when the phrase field appeared
  const seedPhraseRef = useRef(''); // the phrase as typed now, for listeners registered on an older render
  seedPhraseRef.current = seedPhrase;
  const [passwordError, setPasswordError] = useState('');
  const [activeTab, setActiveTab] = useState('assets');
  const [sendAddress, setSendAddress] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [selectedToken, setSelectedToken] = useState('qnc');
  
  // Send on Assets opens the token picker of that network first ('qnet' | 'solana' | null), as top wallets do; a token's
  // own screen ({ network, key } of heldAssets) opens over Assets from its row, and its Send skips the picker.
  const [sendPicker, setSendPicker] = useState(null);
  const [tokenScreen, setTokenScreen] = useState(null);
  // Send Screen state (triggered from Assets) - NOT modal, inline screen
  const [showSendScreen, setShowSendScreen] = useState(false);
  const [sendingToken, setSendingToken] = useState(null); // { symbol: 'QNC', balance: 100.0, network: 'qnet' }
  const [showScan, setShowScan] = useState(false); // the QR scan of the Send screen (components/QrScanSheet)
  // A payment request scanned on the Solana Send screen: { address, references, memo } of the recipient it was for.
  const [solanaRequest, setSolanaRequest] = useState(null);
  const [sendingTransaction, setSendingTransaction] = useState(false);
  // A tap on Send is taken at once (pressSend): `sendChecking` holds the number of the form whose send is being checked,
  // reviewed and sent, so only that form's button turns busy, and the ref keeps a second tap there from reading again.
  const [sendChecking, setSendChecking] = useState(false);
  const sendGuardRef = useRef(false);
  // Which Send form is open: every open and close counts it up, so a send whose form closed (Back, the Assets tab)
  // before the user confirmed it raises nothing more (sendFormOpen).
  const sendFormRef = useRef(0);
  const [txResult, setTxResult] = useState(null); // { success: true/false, txHash, error }
  const [selectedNetwork, setSelectedNetwork] = useState('qnet'); // 'qnet' or 'solana' - default to QNet
  const [tokenBalances, setTokenBalances] = useState({
    owner: null, // QNet address these balances were read for
    qnc: 0,
    sol: 0,
    '1dev': 0
  });
  // The figures on screen, for a read that runs across renders (loadBalance compares a lower unproven QNC read with
  // what is shown: MOBNET-R3-04).
  const shownBalancesRef = useRef(tokenBalances);
  shownBalancesRef.current = tokenBalances;
  // Where the figures on Assets stand for `owner` (owner, 11.10): 'fresh' once a QNC read of this session landed (a 0
  // like any other figure), 'stale' once QNC reads failed STALE_AFTER_FAILS times in a row over STALE_AFTER_MS at least,
  // which the line under them says until the first read that lands; 'idle' before either. A read that starts changes
  // nothing, so the line never comes and goes with the reads. `known` names the figures that are real (read now, or the
  // last verified ones kept from an earlier session): the others show a dash, never a 0 nobody read. `at`: when the QNC
  // figure shown was read. `paused`: the network stopped certifying ({ since }, WalletManager.networkPause), which the
  // line says instead.
  const [balanceStatus, setBalanceStatus] = useState({ owner: null, state: 'idle', at: 0, known: {}, paused: null });
  const qncFailsRef = useRef({ owner: null, count: 0, since: 0 }); // the QNC reads that failed in a row, and since when
  // The moves of a node balance in transit to this wallet (services/ClaimTransit), for Assets, the Node tab and History.
  const [transit, setTransit] = useState(() => emptyTransit());
  const transitRef = useRef(transit);
  transitRef.current = transit;
  // Which figures a read of this session has put on screen for `owner`: a cached figure never replaces one of them.
  const freshFiguresRef = useRef({ owner: null });
  const balanceRunRef = useRef(null); // { owner, promise } of the balance read in flight: one at a time per wallet
  const snapshotSavedRef = useRef({ text: '', at: 0 }); // the last balance snapshot written (WalletManager)
  // QRC-20 tokens: on-chain holdings (from /account/{addr}/tokens) merged with user-persisted
  // custom tokens (AsyncStorage 'qnet_custom_tokens'). Each entry:
  // { contract, name, symbol, decimals, balance (human string) }. Keyed/deduped by contract.
  const [qrcTokens, setQrcTokens] = useState([]); // held + custom, merged for the Assets list
  const qrcTokensRef = useRef(qrcTokens);
  qrcTokensRef.current = qrcTokens;
  const [customTokens, setCustomTokens] = useState([]); // user-added (persisted), balances filled in on load
  // Tokens sent to this wallet unasked that the user chose to show (MOBNET-R2-08): the others stay off the list.
  const [shownTokens, setShownTokens] = useState(new Set());
  const shownTokensRef = useRef(shownTokens);
  shownTokensRef.current = shownTokens;
  const addedTokens = useMemo(
    () => new Set(customTokens.map((c) => c.contract_address || c.contract).filter(Boolean)), [customTokens]);
  const isTokenShown = (contract) => tokenVisible(contract, { hidden: hiddenTokens, added: addedTokens, shown: shownTokens });
  // A token as every screen names it: its symbol, else its name, else "Token", each through tokenLabel (no hidden or
  // format character can reorder it, M-5).
  const tokenTitle = (tk) => tokenLabel(tk.symbol) || tokenLabel(tk.name) || t('tok_default_name');
  const [hiddenTokens, setHiddenTokens] = useState(new Set()); // user-hidden token contracts (spam control)
  // What the screen masks (utils/privacy): every amount, every node name; each kept on the device, off by default.
  const [masks, setMasks] = useState(NO_MASKS);
  const balancesHidden = masks.balances;
  const namesHidden = masks.names;
  const [showHeaderMenu, setShowHeaderMenu] = useState(false); // the header's More menu
  const [headerBottom, setHeaderBottom] = useState(0); // the header's measured bottom edge, where the More menu opens
  const [showTokenManager, setShowTokenManager] = useState(false); // token visibility/search manager
  const [tokenMgrQuery, setTokenMgrQuery] = useState(''); // manager search filter
  // Add-Custom-Token modal
  const [showAddTokenModal, setShowAddTokenModal] = useState(false);
  const [addTokenAddress, setAddTokenAddress] = useState('');
  const [addTokenError, setAddTokenError] = useState('');
  const [addingToken, setAddingToken] = useState(false);
  // v3.29: Track pending TX with proper confirmation polling
  // { txHash, expectedQnc, previousQnc, timestamp, status: 'pending'|'confirmed'|'failed' }
  const pendingTxRef = useRef(null);
  const txPollingRef = useRef(null); // Interval ID for cleanup
  const settleTimerRef = useRef(null); // an accepted send's settlement by nonce after the hash poll (MOBNET-R3-03)
  const outcomeRunRef = useRef(0);   // generation of the unknown-outcome resolver, so an older run steps aside
  // v3.30: TX History with WebSocket real-time updates
  const [txHistory, setTxHistory] = useState([]); // Array of { hash, from, to, amount, status, timestamp, type }
  const txHistoryRef = useRef(txHistory);
  txHistoryRef.current = txHistory;
  const wsRef = useRef(null); // WebSocket connection
  const wsShouldReconnectRef = useRef(true);  // false on unmount ⇒ no resurrecting reconnect
  const wsReconnectTimerRef = useRef(null);   // cancellable reconnect timer
  const wsFailuresRef = useRef(0);            // failed tries in a row (requestPace.socketRetryMs)
  const wsLiveRef = useRef(false);            // the open socket delivered an account event: Assets and History slow
  const wsNextAtRef = useRef(0);              // the earliest next try (ms), kept across a stay in the background
  const wsEventRef = useRef({ timer: null }); // the follow of the account events (followAccountEvent)
  const historyCursorRef = useRef(undefined); // next older explorer page: undefined = not asked yet, null = none left
  const historyLoadingOlderRef = useRef(false);
  const historyRunRef = useRef(null); // { address, fresh, shown, after, promise } of the history read in flight (loadTxHistory)
  // The highest logs floor a genesis node's token-transfer answer reported this session (`oldest_available`): at or below
  // it no node proves a token transfer (utils/txHistory withListing).
  const logsFloorRef = useRef(null);
  // History's lookups by hash this session (utils/txHistory lookupLedger), for the wallet on screen.
  const lookupsRef = useRef(null);
  // The sends History is asking the chain about by their nonce now (settleSentRows), by lowercase hash.
  const settlingRef = useRef(new Set());
  const [historyLoadingOlder, setHistoryLoadingOlder] = useState(false);
  // The History entry whose detail screen is open (screens/HistoryTab TxDetail) and the tab it opened over ('history', or
  // 'assets' from a token's own screen): { tx, tab }, or null.
  const [txDetail, setTxDetail] = useState(null);
  // v3.27: Track Merkle proof verification status for trustless display
  const [balanceVerified, setBalanceVerified] = useState(false);
  const [keptTxs, setKeptTxs] = useState([]); // this wallet's kept transactions (MOBNET-R3-01)
  const [language, setLanguage] = useState('en');
  // Every string on screen comes from the translator (i18n); a new one per language, so memoized rows and tabs
  // follow a change. The layout's direction follows the language as a whole (i18n/direction).
  const t = useMemo(() => { setThemeLanguage(language); return makeT(language); }, [language]);
  // A canonical figure (decimal text or a number) as every screen writes it (utils/amountFormat), with its symbol, masked
  // while `hidden`; fields, signing and the history cache keep the canonical text.
  const shownAmount = (value, symbol, hidden = false) => masked(`${amountText(value)}${symbol ? ` ${symbol}` : ''}`, hidden);
  const termsParts = t('terms_accept_template').split('{terms}');
  const [autoLockTime, setAutoLockTime] = useState(DEFAULT_AUTO_LOCK);
  // The revealed recovery phrase lives only here, in its own overlay, never in the generic alert state;
  // locking, leaving the app and closing the overlay all drop it.
  const [seedReveal, setSeedReveal] = useState(null); // string[] | null
  const [vaultProblem, setVaultProblem] = useState(null); // null | 'corrupt' | 'device_key' | 'unreadable'
  // Android: whether the device key seals the vault ('sealed' | 'unsealed'); null elsewhere or not known yet.
  const [hwSeal, setHwSeal] = useState(null);
  const [showDeletePrompt, setShowDeletePrompt] = useState(false); // Android: the password before Delete
  const [deletePassword, setDeletePassword] = useState('');
  const [showEraseConfirm, setShowEraseConfirm] = useState(false); // type ERASE, then a fresh authentication
  const [eraseNodeHere, setEraseNodeHere] = useState(false); // the wallet's node runs here: the erase says it stops
  const [eraseText, setEraseText] = useState('');
  const [deviceCompromised, setDeviceCompromised] = useState(false);
  const backgroundedAtRef = useRef(0); // 0, or { wall, mono } of the moment the app went to the background
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showExportSeed, setShowExportSeed] = useState(false);
  const [exportWhat, setExportWhat] = useState('phrase'); // what that dialog reveals: 'phrase' or 'key'
  const [exportAccount, setExportAccount] = useState('qnet'); // whose private key: 'qnet' or 'solana'
  const [exportPassword, setExportPassword] = useState('');
  const [revealBusy, setRevealBusy] = useState(false); // the check behind Show is running
  const revealBusyRef = useRef(false);
  // The revealed private keys ({ qnet, solana }, each { address, key }), in their own overlay like the phrase: a key is
  // on screen only while its box is held, and all of it goes on Done, on lock and on leaving the app.
  const [keyReveal, setKeyReveal] = useState(null);
  const [showAutoLockPicker, setShowAutoLockPicker] = useState(false);
  const [freshPrompt, setFreshPrompt] = useState(null); // Android: { reason } while the password is asked again
  const [freshPassword, setFreshPassword] = useState('');
  const freshResolveRef = useRef(null);
  const freshOwnerRef = useRef(null); // who opened the prompt on screen (confirmFresh `owner`)
  // The review of a send before its fresh check (MPLAT-R5-01): { token, to, amount, fee, total, network } while shown.
  const [sendReview, setSendReview] = useState(null);
  const sendReviewResolveRef = useRef(null);
  // This wallet's Solana sends from this device, listed in History and each asked about until the network settles it;
  // the result card of the one on screen follows, and the balances are read again.
  const solanaSends = useSolanaSends(wallet ? (wallet.solanaAddress || wallet.address) : null, (entry) => {
    setTxResult((prev) => {
      if (!prev || prev.solanaSignature !== entry.signature) return prev;
      if (entry.status === 'confirmed') {
        return { ...prev, unknown: false, success: true, title: t('tx_sent_title'), confirmed: true, note: undefined };
      }
      return {
        ...prev, unknown: false, success: false, confirmed: false, title: t('tx_failed_title'),
        error: t(entry.expired ? 'err_SOL_EXPIRED' : 'tx_failed'), note: undefined,
      };
    });
    if (wallet && wallet.publicKey) loadBalance(wallet.publicKey);
  });
  const [showLanguagePicker, setShowLanguagePicker] = useState(false);
  const [importStep, setImportStep] = useState(1); // 1 = password, 2 = seed phrase
  const [showSeedConfirm, setShowSeedConfirm] = useState(false);
  const [seedConfirmWords, setSeedConfirmWords] = useState({});
  const [tempWallet, setTempWallet] = useState(null);
  const [wordChoices, setWordChoices] = useState({});
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [customAlert, setCustomAlert] = useState(null); // {title, message, buttons}
  const [verificationError, setVerificationError] = useState(''); // Error message for seed verification
  const [currentBlockHeight, setCurrentBlockHeight] = useState(0); // Cached network block height
  const [processingValidation, setProcessingValidation] = useState(false); // Move to wallet runs, all its parts
  const [claimSigning, setClaimSigning] = useState(false); // one of its claims is being quoted, signed and sent
  const movingRef = useRef(false); // a move of a node balance is running (a QNet Link claim waits for it)
  movingRef.current = processingValidation;
  // This wallet's node, of every type, as the genesis nodes name it (loadWalletNode): { owner, nodeId, nodeType }, the
  // wallet's record of it until they answer (`stored`); { owner, none: true } once two say the wallet has none; null
  // while unknown. Set with its ref at once (setWalletNode), so a loader running from an older render reads this one.
  const [walletNode, setWalletNodeState] = useState(null);
  const walletNodeRef = useRef(null);
  const setWalletNode = (next) => {
    walletNodeRef.current = next;
    setWalletNodeState(next);
  };
  // The foreground handler is installed with [wallet, password] deps, so it reads the CURRENT tab through a ref.
  const activeTabRef = useRef('assets');
  // This wallet's light node: { nodeId, status (LightNode.readNodeStatus), local (this device's binding), pending,
  // answeredAt }; null until the first read.
  const [lightNodeStatus, setLightNodeStatus] = useState(null);
  // That node on the chain as two genesis nodes report it, with the registration height a signed answer names: History's
  // node event for it (utils/txHistory nodeEventRow), which settles its registration's row as the registry's event does.
  const lightStatusNow = lightNodeStatus && lightNodeStatus.status;
  const lightRegHeight = lightStatusNow && lightStatusNow.onChain === true && lightStatusNow.signed
    && Number.isSafeInteger(lightStatusNow.signed.registeredHeight) ? lightStatusNow.signed.registeredHeight : null;
  const lightRegistration = useMemo(() => (lightRegHeight !== null && wallet?.qnetAddress
    ? nodeEventRow({ nodeId: lightNodeStatus.nodeId, nodeType: 'light', height: lightRegHeight }, wallet.qnetAddress) : null),
  [lightNodeStatus?.nodeId, lightRegHeight, wallet?.qnetAddress]); // eslint-disable-line react-hooks/exhaustive-deps
  const lightNodeStatusRef = useRef(null); // the same, for timers set in an earlier render
  lightNodeStatusRef.current = lightNodeStatus;
  const [lightBalance, setLightBalance] = useState(null); // the light node's balance (nanoQNC)
  const [nodeUseBusy, setNodeUseBusy] = useState(false);
  const [useRefusal, setUseRefusal] = useState(null); // why the network did not take "Use this device": { reason, … }
  const offlineAttestAtRef = useRef(0); // when an Offline light node last got a forced self-attest from this screen
  // The last signed status read: its fields, and the device tags only it carries (ND-7) with the nonce they are for;
  // `verdict` the binding sequence and device-bound answer two owners last gave for this binding (contract 4).
  const signedStatusAtRef = useRef({
    nodeId: null, at: 0, signed: null, keyOurs: null, signer: null, nonce: null, deviceTags: [], noStatusKey: false, verdict: null,
  });
  // How much the system lets the app run in the background (services/BackgroundPriority), for the Node tab's row.
  const [bgState, setBgState] = useState(null);
  // The last read of each node balance ({ nodeId, epoch, at }, requestPace.balanceDue): once per epoch, or after a move.
  const lightBalanceReadRef = useRef(null);
  const serverRewardsRef = useRef(null); // the same for a server node, with the figure read: { …, value }
  // Whether this device can run a node at all (NodeDeviceKey.checkDevice): asked once, at the first open of the Node tab;
  // null until it answered.
  const [deviceCheck, setDeviceCheck] = useState(null);
  const deviceCheckAskedRef = useRef(false);
  const lastHistoryAddrRef = useRef(null); // wallet the loaded history belongs to (a switch clears it, an unlock does not)
  // The height the certified QNC read last covered, and the highest coverage the rows on screen were given:
  // { owner, height, listed } (noteCovered; History's receive labels).
  const coveredRef = useRef({ owner: null, height: -1, listed: -1 });
  const currentOwnerRef = useRef(null); // QNet address of the wallet on screen; late reads for another are dropped
  useEffect(() => { if (wallet?.qnetAddress) currentOwnerRef.current = wallet.qnetAddress; }, [wallet]);
  // The server card's status of the node walletNode names (NodeTab.serverStatusAfter), null while it is being checked.
  const [serverNodeStatus, setServerNodeStatus] = useState(null);
  // The server node's counted and not admitted epochs (PushService.getNodeEpochs): { owner, nodeId, counted,
  // notAdmitted, at }.
  const [serverEpochs, setServerEpochs] = useState(null);
  // What aiqnet.io records of the wallet's node (services/NodeRecordRead): { owner, state, nodeType }; null until read,
  // and after a read that failed.
  const [siteRecord, setSiteRecord] = useState(null);
  // The height the chain registered each node of the wallet on screen at (node-events): { owner, heights: { id: h } }.
  const nodeRegRef = useRef({ owner: null, heights: {} });
  // Current values for the long-lived loaders (the status interval keeps the closures of the render it started in).
  const serverEpochsRef = useRef(null);
  serverEpochsRef.current = serverEpochs;
  const serverNodeStatusRef = useRef(null);
  serverNodeStatusRef.current = serverNodeStatus;
  const lightOnChainRef = useRef(false);
  lightOnChainRef.current = !!lightNodeStatus && !!lightNodeStatus.status && lightNodeStatus.status.onChain === true;
  // The light card shows this wallet's light node, here or on another device, as the Node tab decides it
  // (NodeTab.lightNodeShown): the card a server node's card has under it, read again while it shows.
  const lightShownRef = useRef(false);
  lightShownRef.current = !!lightNodeStatus
    && lightNodeShown(lightNodeStatus, nodeView({ ...lightNodeStatus, height: currentBlockHeight }));
  const [unlockError, setUnlockError] = useState(''); // Error message for unlock screen
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricSupported, setBiometricSupported] = useState(false);
  const [showBiometricPasswordPrompt, setShowBiometricPasswordPrompt] = useState(false);
  const [biometricPassword, setBiometricPassword] = useState('');
  const [lockoutMs, setLockoutMs] = useState(0); // ms remaining in lockout
  const lockoutTimerRef = React.useRef(null);
  // A QNet Link request (screens/QNetLinkScreen): { link, key, settled, afterOther, release } for a URL the OS delivered
  // that parsed as a link, `settled` once the user decided. `release()` tells the link inbox (services/LinkInbox) the
  // screen is done with it: no next link before this one is decided or closed, and a decided one gives way at once.
  const [linkRequest, setLinkRequest] = useState(null);
  // A transfer request from a link waiting to open (openTransferLink): { value, waited, release }; the Send screen it
  // filled in says so (`sendFromLink`). `solanaSending`: the number of the form whose Solana send is being made
  // (SolanaSend onBusy), which a lock does not end.
  const [solanaLink, setSolanaLink] = useState(null);
  const [sendFromLink, setSendFromLink] = useState(false);
  const [solanaSending, setSolanaSending] = useState(false);
  // A send from its tap to its result (not while its review waits for the user), a claim of a node balance (not while a
  // move in parts waits for a block) and Use this device have the network before the background verification
  // (utils/userAction).
  useHoldForUser(((sendChecking || solanaSending) && !sendReview) || sendingTransaction || claimSigning || nodeUseBusy);
  const activeSinceRef = useRef(Date.now()); // when the app last came to the front (0 while it is not)
  // The in-app browser (browser/BrowserScreen): mounted on the first visit to its tab and kept (behind the lock
  // screen too) until the wallet on the phone changes; `browserGen` gives the next wallet a new session.
  const browserRef = useRef(null);
  const [browserStarted, setBrowserStarted] = useState(false);
  const [browserGen, setBrowserGen] = useState(0);
  const [dappSheet, setDappSheet] = useState(null); // { view, actions } of the request on screen
  // A QNet Link request from aiqnet.io ends every open request of the in-app browser (4001): a sheet a page opened
  // earlier must never sit over the verified request, nor stay approvable under it (MOBLINK-R2-03).
  useEffect(() => {
    if (linkRequest && browserRef.current) browserRef.current.cancelAll();
  }, [linkRequest]);
  // It also ends the wallet's own confirmations that were open when it arrived — a send's review or its password
  // prompt, a setting's check: a password typed "for aiqnet.io" must never resume a send made before (MOBLINK-R5-01).
  // A prompt that request opens itself carries its owner and stays.
  const linkRequestRef = useRef(null);
  linkRequestRef.current = linkRequest;
  const linkKey = linkRequest ? linkRequest.key : null;
  useEffect(() => {
    if (linkKey === null) return;
    if (freshResolveRef.current && freshOwnerRef.current !== `link:${linkKey}`) resolveFresh(false);
    if (sendReviewResolveRef.current) resolveSendReview(false);
  }, [linkKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [contentFrame, setContentFrame] = useState(null); // where the tab content sits: the browser covers it
  // iOS starts the app in the background for a silent push or a background fetch, and the screen mounts there too: what
  // needs the app in front reads the real state, never an assumed one (MA-R2-02).
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');
  // The screen-lock prompt the lock screen opens by itself, owed while the app is not in front and run when it comes
  // there (autoUnlockRef, set with the lock screen's state on every render).
  const autoUnlockOwedRef = useRef(false);
  const autoUnlockRef = useRef(null);
  // Android (MPLAT-R4-01): the enabled accessibility services that did not come with the system, read each time the
  // lock screen is up: such a service sees what is typed there and can type and tap for itself, so it is named there,
  // not only before a recovery phrase is shown.
  const [lockReaders, setLockReaders] = useState([]);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [connectedSites, setConnectedSites] = useState(null); // Settings → Connected sites
  const tRef = useRef(null);
  const [vaultChecked, setVaultChecked] = useState(false); // whether "no wallet" is known, not just not yet read
  // Whether the first read of the stored wallet finished: until then the screen shows the app's name only, never the
  // welcome screen of a device without a wallet.
  const [walletKnown, setWalletKnown] = useState(false);
  // A wallet under the screen lock: the system prompt is opening or open, so the lock screen shows no button under it;
  // the Unlock button comes back once the prompt ended without opening the wallet (A1).
  const [unlockPrompting, setUnlockPrompting] = useState(true);
  // The wallet is being deleted from this device (eraseWallet): one plain screen says so until it is done (A2).
  const [erasing, setErasing] = useState(false);

  // Throttle helper to prevent too frequent updates
  const lastActivityEmit = React.useRef(0);
  
  // Function to emit user activity (throttled to once per 5 seconds)
  const handleUserActivity = React.useCallback(() => {
    const now = Date.now();
    if (now - lastActivityEmit.current > 5000) { // Only emit once per 5 seconds
      lastActivityEmit.current = now;
      DeviceEventEmitter.emit('userActivity');
    }
  }, []);

  // Helper function to show custom styled alerts
  const showAlert = (title, message, buttons = [{ text: t('common_ok'), onPress: () => {} }]) => {
    setCustomAlert({ title, message, buttons });
  };

  // The explorer's page of a transaction (the detail screen's and the result card's Explorer): the QNet explorer, or for
  // a Solana send the cluster's public explorer; a page that cannot open leaves the hash copied and says so.
  const handleOpenTx = React.useCallback((hash, chain = 'qnet') => {
    if (!hash) return;
    Linking.openURL(chain === 'solana' ? solanaExplorerTxUrl(hash) : explorerTxUrl(hash)).catch(() => {
      Clipboard.setString(hash);
      setCustomAlert({ title: tRef.current('common_copied'), message: tRef.current('tx_hash_copied'), buttons: [{ text: tRef.current('common_ok'), onPress: () => {} }] });
    });
  }, []);

  // A History row opens its detail screen (stable, so the list's rows never re-bind).
  const openTxDetail = React.useCallback((tx) => { setTxDetail({ tx, tab: 'history' }); }, []);

  useEffect(() => {
    // A reinstall on iOS finds the previous install's Keychain items: they go before anything reads them. On
    // Android an older build's biometric item (the password behind a weak fingerprint key) goes before the lock
    // screen decides whether to offer biometric unlock.
    walletManager.prepareInstall()
      .then(() => walletManager.migrateKeychainGroup())
      .then(() => walletManager.purgeLegacyBiometric())
      .catch(() => {})
      .finally(() => {
        checkWalletExists();
        walletManager.isBiometricEnabled().then(enabled => setBiometricEnabled(enabled));
      });
    loadSettings();
    walletManager.isBiometricSupported().then(supported => setBiometricSupported(supported));
    walletManager.getPasswordLockStatus().then(({ locked, remainingMs }) => {
      if (locked) _startLockoutCountdown(remainingMs);
    });
    // Local checks only; a rooted or jailbroken device gets a warning and no recovery-phrase reveal.
    deviceIntegrity().then((r) => setDeviceCompromised(!!r.compromised));
    // The last update of the old Android package: at every launch, the move to the one QNet Wallet app.
    if (LEGACY_MOVE) {
      const open = (url) => () => { Linking.openURL(url).catch(() => {}); };
      showAlert(t('legacy_move_title'), t('legacy_move_body'), [
        { text: t('node_play_open'), onPress: open(NEW_APP_PLAY_URL) },
        { text: t('legacy_move_site'), onPress: open(NEW_APP_SITE_URL) },
        { text: t('legacy_move_later'), style: 'cancel' },
      ]);
    }
    if (__DEV__) {
      try {
        const { runCompatibilityTest } = require('../crypto/DilithiumCrypto');
        runCompatibilityTest();
      } catch (e) {}
    }
    return () => {
      if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
    };
  }, []);

  // Whether a new wallet can open with the screen lock: asked while there is no wallet, again at each onboarding step
  // and whenever the app comes back to the front (a screen lock may have been set meanwhile).
  // Asked again after a new wallet's screen lock could not keep its secret: the next attempt uses a password.
  const refreshDeviceAuthAvail = () => {
    walletManager.deviceAuthAvailable().then((v) => setDeviceAuthAvail(!!v), () => setDeviceAuthAvail(false));
  };

  // A new wallet's screen lock failed for now (DEVICE_LOCK_RETRY): the same button asks again with the screen lock, or
  // the wallet uses a password instead. That choice marks the device as one without a usable screen lock (for new
  // wallets, until the mark lapses) and the password step appears; `onPassword` runs after it. From the second failure
  // in a row on the same screen, the password is offered as the question itself.
  const deviceLockRetriesRef = useRef(0);
  useEffect(() => { deviceLockRetriesRef.current = 0; }, [showCreateOptions]);
  const offerPasswordAfterRetry = (onPassword) => {
    deviceLockRetriesRef.current += 1;
    const usePassword = {
      text: t('bio_use_password'),
      onPress: async () => {
        deviceLockRetriesRef.current = 0;
        await walletManager.useWalletPassword();
        refreshDeviceAuthAvail();
        if (onPassword) onPassword();
      },
    };
    if (deviceLockRetriesRef.current >= 2) {
      showAlert(t('device_lock_title'), t('device_lock_retry_offer'), [{ text: t('cancel'), style: 'cancel' }, usePassword]);
    } else {
      showAlert(t('error'), t('device_unlock_unavailable'), [{ text: t('common_ok'), style: 'cancel' }, usePassword]);
    }
  };

  useEffect(() => {
    if (hasWallet) return undefined;
    let live = true;
    const probe = () => walletManager.deviceAuthAvailable()
      .then((v) => { if (live) setDeviceAuthAvail(!!v); }, () => { if (live) setDeviceAuthAvail(false); });
    probe();
    const sub = AppState.addEventListener('change', (next) => { if (next === 'active') probe(); });
    return () => { live = false; sub.remove(); };
  }, [hasWallet, showCreateOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Settings of a password wallet offer the move to the screen lock only where the device can hold the secret now.
  useEffect(() => {
    if (!wallet || walletDeviceAuth || activeTab !== 'settings') return undefined;
    let live = true;
    walletManager.deviceAuthAvailable().then((v) => { if (live) setDeviceAuthAvail(!!v); }, () => {});
    return () => { live = false; };
  }, [wallet, walletDeviceAuth, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether `url` is a transfer request (services/transferLink: a payment address's button on a phone), which then fills
  // the Solana Send screen for the user to review and confirm, or says why it cannot; nothing is sent by itself. It
  // waits while the wallet is locked or absent, a QNet Link request waits for the user's decision or a send is under
  // way, and, when it `waited` behind an earlier link, while the form that link opened is on screen. `release()` once
  // it opened or was refused: the inbox hands the next link only then.
  const openTransferLink = (url, release, waited) => {
    const read = readTransferLink(url);
    if (!read) return false;
    const tr = tRef.current || ((k) => k);
    if (read.value) {
      setSolanaLink({ value: read.value, waited, release });
    } else {
      release();
      showAlert(tr('link_refused_title'), tr(read.note));
    }
    return true;
  };

  // QNet Link: URLs come only from the OS (App Links / Universal Links for https://link.aiqnet.io/l and /send; on
  // Android also a site's intent: URL naming this package, which arrives through the same filter as the link itself),
  // each through the link inbox (services/LinkInbox), which keeps it until this screen is done with it and hands them
  // one at a time in the order they came: a screen made anew (Android's Back, a JS restart) hears every link not done
  // yet again. One that is not exactly a link opens nothing and fetches nothing. A /send link is a transfer request
  // (openTransferLink).
  useEffect(() => watchLinks((url, release, { waited }) => {
    const tr = tRef.current || ((k) => k);
    // A link that arrives while the in-app browser is on screen and the app has been in front all along did not
    // come from another app: a page of the in-app browser handed it over (iOS tries a tapped universal link on
    // the app itself). Such a request is never opened, nor read (the browser also refuses link.aiqnet.io).
    const fromBrowser = handedOverByBrowser(activeTabRef.current, activeSinceRef.current, Date.now(), LINK_FROM_OUTSIDE_MS);
    // Its kind alone in the log: a transfer request, a QNet Link request's intent, or neither; never a session id, a
    // secret or an address.
    const kind = fromBrowser ? 'from_browser' : (readTransferLink(url) ? 'transfer' : (parseLink(url) || { intent: 'invalid' }).intent);
    logger.info(`[INFO][LINK] link_arrived kind=${kind} waited=${waited ? 1 : 0}`);
    if (fromBrowser) {
      release();
      showAlert(tr('link_refused_title'), tr('browser_link_refused'));
      return;
    }
    if (openTransferLink(url, release, waited)) return;
    const link = parseLink(url);
    if (!link) {
      release();
      showAlert(tr('link_refused_title'), tr('link_invalid'));
      return;
    }
    // A link never takes the place of a request the user has still to decide: the inbox hands it only once that one is
    // decided or closed, a decided one giving way at once (its answer goes on in the background: services/LinkAnswers),
    // and one that waited says another request arrived. The same link twice is one request.
    setLinkRequest((r) => {
      if (r && r.link.id === link.id) {
        release();
        return r;
      }
      return { link, key: Date.now(), settled: false, afterOther: waited || !!r, release };
    });
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A page in the in-app browser may ask for a confirmation only while the app is in front. The moment the app last
  // came to the front tells a link another app opened from one handed over while it stayed in front.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      setAppActive(next === 'active');
      activeSinceRef.current = next === 'active' ? Date.now() : 0;
      if (next === 'active' && autoUnlockOwedRef.current && autoUnlockRef.current) autoUnlockRef.current();
    });
    // A change that came before this listener: the state it left is read once here.
    setAppActive(AppState.currentState === 'active');
    return () => sub.remove();
  }, []);

  // The lock screen names the apps that can read the screen and act for you, under the password and the screen lock alike.
  useEffect(() => {
    if (wallet || !hasWallet || !appActive) return undefined;
    let live = true;
    screenReaderApps().then((r) => { if (live) setLockReaders(r); }).catch(() => {});
    return () => { live = false; };
  }, [wallet, hasWallet, appActive, walletDeviceAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Android: the bottom bar steps aside while the keyboard is up (a form in a page, the send form).
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);

  // The Node tab: the wallet's node as the genesis nodes name it (loadWalletNode; a super or genesis node takes the server
  // card, read by its id), the light node as its shard owners record it, and aiqnet.io's record of a node the network
  // does not list yet. The app runs a light node; a server node it only shows and moves the balance of.
  useEffect(() => {
    if (activeTab === 'node' && wallet && !LEGACY_MOVE) {
      // The "Epoch ends in" row: one height read now and with each status refresh below, counted on here at one block a
      // second in between (CLOCK_TICK_MS, no request).
      refreshHeight();
      const clockTick = setInterval(() => {
        const h = estimatedHeight(heightRead());
        if (h > 0) setCurrentBlockHeight(h);
      }, CLOCK_TICK_MS);

      // In parallel, not a waterfall: the node the wallet's record names reads its status at once, and a node the
      // genesis nodes name in its place reads its own (linkNode).
      loadWalletNode();
      loadServerNodeStatus();
      loadLightNodeStatus();
      loadSiteRecord({ force: true });
      if (!deviceCheckAskedRef.current) {
        deviceCheckAskedRef.current = true;
        checkDevice().catch(() => ({ capable: false, reason: 'device_unsupported' })).then(setDeviceCheck);
      }

      // Every NODE_STATUS_MS while the tab stays open and the app is in front, through the latest render's loaders: the
      // statuses, the wallet's node while the genesis nodes have not named it, and under a server node the light node
      // only while it has a card there (lightShownRef).
      const statusInterval = setInterval(() => {
        if (AppState.currentState !== 'active') return;
        const load = nodeLoadersRef.current;
        load.refreshHeight();
        if (!walletNodeNamed()) load.loadWalletNode();
        const server = !!serverNodeOf(walletNodeRef.current, currentOwnerRef.current);
        if (server) load.loadServerNodeStatus();
        load.loadSiteRecord();
        if (!server || lightShownRef.current) load.loadLightNodeStatus({ fresh: false });
      }, NODE_STATUS_MS);

      return () => { clearInterval(clockTick); clearInterval(statusInterval); };
    }
  }, [activeTab, wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  // While this wallet's light node is being linked (the QNet Link record kept, the chain not listing the node yet), its
  // status is read again on a short schedule, on every tab, in front only (requestPace.linkingReadMs: every 10 s for the
  // first two minutes after the link, then every minute), not every NODE_STATUS_MS: the tab turns from "linking" to the
  // node as soon as the chain records it. A QNet Link 'ok' reads it at once, which starts this.
  // A binding of "Use this device" or the link sheet sent with no answer is read for on the same schedule until the
  // network names one (PushService.settleUnconfirmedBinding), and so is a light card with no verdict on the open Node
  // tab (the status could not be read, or the owners do not agree yet: `unreadAt`).
  const linkPending = lightNodeStatus && lightNodeStatus.pending;
  const linkingSince = (linkPending && !linkPending.expired && !(lightNodeStatus.status && lightNodeStatus.status.onChain === true)
    && Number.isSafeInteger(linkPending.createdAt) ? linkPending.createdAt : null)
    || (lightNodeStatus && Number.isSafeInteger(lightNodeStatus.unconfirmedAt) ? lightNodeStatus.unconfirmedAt : null)
    || (activeTab === 'node' && lightNodeStatus && Number.isSafeInteger(lightNodeStatus.unreadAt)
      && (!serverNodeOf(walletNode, wallet?.qnetAddress) || lightShownRef.current) ? lightNodeStatus.unreadAt : null);
  useEffect(() => {
    if (!linkingSince || !appActive || !wallet) return undefined;
    let timer = null;
    const next = () => {
      timer = setTimeout(() => {
        if (AppState.currentState === 'active') loadLightNodeStatus({ fresh: false });
        next();
      }, linkingReadMs(Date.now() - linkingSince));
    };
    next();
    return () => clearTimeout(timer);
  }, [linkingSince, appActive, wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  // The registrations this device sent after a consent and kept across a restart (services/RegistrationSubmit), each
  // wallet's own, go again from the open wallet on any tab: one status read of each node says whether the chain lists it.
  const openQnet = wallet ? wallet.qnetAddress : null;
  useEffect(() => {
    if (!openQnet || !appActive || LEGACY_MOVE) return;
    resumeKept({
      readStatus: (nodeId) => readNodeStatus(nodeId),
      // The node of the wallet open when the route took it: its status is read at once.
      onStage: (nodeId) => {
        const owner = currentOwnerRef.current;
        if (owner && walletManager.generateLightNodePseudonym(owner) === nodeId) loadLightNodeStatus({ fresh: true });
      },
    }).catch(() => {});
  }, [openQnet, appActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // One height read (at most one a 15 s, fetchCachedBlockHeight) for the epoch clock, which counts on from it.
  const refreshHeight = () => fetchCachedBlockHeight().then(() => {
    const h = estimatedHeight(heightRead());
    if (h > 0) setCurrentBlockHeight(h);
  }).catch(() => {});

  // This wallet's light node, whichever device or channel registered it: the status from its shard owners (two must
  // agree), this device's binding of it and a pending QNet Link record. Every caller (the 5 min interval, pull-to-refresh,
  // tab effect, foreground) reads the wallet through the ref: an interval's closure may be from an older render.
  // The signed status costs the owners a signature check: the interval (`fresh: false`) asks for it at most every
  // SIGNED_STATUS_MS and keeps the last signed fields in between. The balance is read once per epoch (`rewards`: now,
  // as pull-to-refresh and a move ask).
  const loadLightNodeStatus = async ({ fresh = true, rewards = false } = {}) => {
    const owner = currentOwnerRef.current;
    if (!owner) return;
    const nodeId = walletManager.generateLightNodePseudonym(owner);
    try {
      let local = await localBinding(nodeId);
      // A binding sent with no answer waits for the network's word, which every read while it waits asks for.
      const unconfirmed = await readUnconfirmedBinding(nodeId);
      const last = signedStatusAtRef.current;
      // The last signed answer stands only for the binding it was read for: a new binding (Use this device, a link)
      // must never be judged by what the node said about the one before.
      const same = !!local && last.nodeId === nodeId && last.seq === local.seq;
      const sign = !!unconfirmed || (!!local && (fresh || !same || Date.now() - last.at >= SIGNED_STATUS_MS));
      // This device's binding of the node, or one sent from here with no answer (`waiting`), shown as one being linked
      // here (LightNode.bindingVerdict: `unconfirmed`); the device key that went with it waits for its tag.
      const shownBinding = (bound, waiting) => bound || (waiting ? {
        nodeId, seq: waiting.seq, boundAt: Math.floor(waiting.at / 1000), hw: waiting.enrolled === true, unconfirmed: true,
      } : null);
      const lastAnswerAt = async () => {
        try { return JSON.parse((await AsyncStorage.getItem(LAST_ANSWER_KEY)) || 'null'); } catch (_) { return null; }
      };
      // Puts the card on screen. "Could not ask" is not "no node": the last verdict stays while the network is
      // unreachable. `unreadAt`: since when the card shows no verdict, read again on the linking schedule. A first view
      // (`agreed`) never takes the place of a verdict on screen.
      const putCard = (next, agreed = false) => setLightNodeStatus((prev) => {
        const sameNode = !!prev && prev.nodeId === nodeId;
        const verdictShown = sameNode && !!prev.status && prev.status.onChain !== null;
        if (agreed && verdictShown && !prev.unreadAt) return prev;
        const keep = next.status.onChain === null && !next.pending && verdictShown;
        const settled = !keep && !['checking', 'unreachable'].includes(nodeView(next).state);
        const unreadAt = settled ? null : (sameNode && prev.unreadAt) || Date.now();
        return keep ? { ...prev, stale: true, unreadAt } : { ...next, unreadAt };
      });
      // The card shows as soon as the owners' verdicts settle (LightNode onAgreed), before an owner still out and the
      // checks below; the whole read then takes its place.
      let read = false;
      const showAgreed = (agreed) => Promise.all([readLinkPending(nodeId), lastAnswerAt()]).then(([pending, answeredAt]) => {
        if (read || currentOwnerRef.current !== owner) return;
        putCard({
          nodeId, status: agreed, local: shownBinding(local, unconfirmed), pending, check: null, answeredAt,
          unconfirmedAt: unconfirmed ? unconfirmed.at : null,
        }, true);
      }, () => {});
      const readAt = Date.now();
      // The status is signed with this device's ping key; with none here, or one two owners refuse (a binding that was
      // replaced or withdrawn holds no ping key of this device), the open wallet's key asks instead, so the binding the
      // network holds (B) is known all the same. A background wake never signs with the wallet key (contract 4).
      const walletOpen = () => {
        try { return walletManager.sessionOpen(credentialRef.current) === true; } catch (_) { return false; }
      };
      const walletSign = (id, ts) => (walletOpen() ? walletManager.signNodeStatus(credentialRef.current, id, ts) : null);
      const pingOrWallet = async (id, ts) => (await signStatusWithPingKey(id, ts)) || walletSign(id, ts);
      let status = await readNodeStatus(nodeId, { signStatus: sign ? pingOrWallet : null, onAgreed: showAgreed });
      read = true;
      if (sign && status.keyOurs === false && walletOpen()) {
        status = await readNodeStatus(nodeId, { signStatus: walletSign });
      }
      if (currentOwnerRef.current !== owner) return; // another wallet is on screen now
      if (sign) {
        const verdict = Number.isSafeInteger(status.bindingSeqAgreed)
          ? { bindingSeqAgreed: status.bindingSeqAgreed, deviceBoundAgreed: status.deviceBoundAgreed }
          : (same ? last.verdict : null);
        signedStatusAtRef.current = {
          nodeId, seq: local ? local.seq : null, at: Date.now(), signed: status.signed, keyOurs: status.keyOurs, signer: status.signer,
          nonce: status.nonce, deviceTags: status.deviceTags, noStatusKey: status.noStatusKey, verdict: verdict || null,
        };
      } else if (same && status.onChain === true) {
        status = {
          ...status, signed: last.signed, keyOurs: last.keyOurs, signer: last.signer || null,
          nonce: last.nonce, deviceTags: last.deviceTags, noStatusKey: last.noStatusKey,
        };
      }
      // First the binding sent with no answer, by this read's word only: once the network names it, it is this device's
      // binding (read again); the check below would end the binding it replaced as one another device took over.
      if (unconfirmed && await settleUnconfirmedBinding(nodeId, status)) {
        loadLightNodeStatus({ fresh: true });
        return;
      }
      // No binding sequence in this read (no signed answer, a refused key, no network): the last verdict read for this
      // device's binding stands, both of its halves; with none, the binding stands (LightNode.bindingVerdict).
      const kept = signedStatusAtRef.current;
      if (local && !Number.isSafeInteger(status.bindingSeqAgreed) && kept.nodeId === nodeId && kept.seq === local.seq
          && kept.verdict) {
        status = { ...status, ...kept.verdict };
      }
      if (local && await forgetIfReplaced(nodeId, status, local.seq)) local = null;
      // The signed status names the bound device key by a tag for its nonce (ND-7): a key sent in a message that got no
      // answer (a rotation, an enrolment) is settled by it whatever the binding says of its key (MN-R4-03), and a binding
      // whose key the node took is compared with the owners' tags (light-node-messages section 5.9), for the tab only.
      // No ping key here to sign it with: the node is on another device, as a tag naming another key would say.
      // No key here to sign with tells nothing of the device key (`tagOurs` null, contract 4): it only ever asks for a new
      // device key, never says the node runs elsewhere.
      if (local && status.deviceTags.length > 0) {
        if ((await settleUnansweredKey(nodeId, status)) === 'pending') local = { ...local, hw: true };
        if (local.hw) {
          status = { ...status, tagOurs: await isThisDevice(status.nonce, status.deviceTags).catch(() => null) };
        }
      }
      // The wakes' schedule takes only a status read now with this device's ping key: fields kept from an earlier read
      // may predate a rotation a wake finished since (MN-R3-03), and an answer to the wallet key may describe another
      // device's record.
      if (local) {
        noteDeviceStatus(nodeId, sign && status.signer === 'ping' ? status : { ...status, signed: null }, { readAt }).catch(() => {});
      }
      // The registration this wallet sent after a consent goes again while the chain does not list the node, and is
      // forgotten once it does (RegistrationSubmit); the status is read at once when the route took it.
      resumeRegistration(nodeId, status.onChain, { onStage: () => loadLightNodeStatus({ fresh: true }) }).catch(() => {});
      const pending = await readLinkPending(nodeId);
      // An expired link is shown once as not recorded, then the chain's truth; a binding the network never took goes
      // with it (its ping key, push token and wakes).
      if (pending && pending.expired && await endExpiredLink(nodeId, status, pending)) local = null;
      const answeredAt = await lastAnswerAt();
      // Whether a device check that waits still runs, ended with no verdict or was refused (NodeTab checkState).
      const checkOf = async () => (local && status.signed && status.signed.deviceState === 'check_pending'
        ? nodeCheckState(nodeId, local.seq).catch(() => null) : null);
      const check = await checkOf();
      // A binding sent with no answer that still waits is read for on the linking schedule.
      const waiting = unconfirmed ? await readUnconfirmedBinding(nodeId) : null;
      const shown = shownBinding(local, waiting);
      const card = (c) => ({ nodeId, status, local: shown, pending, check: c, answeredAt, unconfirmedAt: waiting ? waiting.at : null });
      // The card shows before the upkeep below, which waits on device checks and the network; one that went through
      // reads the status again.
      putCard(card(check));
      // The QNet Link sheet's binding, sent again while the chain lists the node with no device bound (U3); from this
      // tab Google Play's dialog may fix a token.
      if (pending && !pending.expired && status.onChain === true
          && await resendPendingBinding(nodeId, status, { interactive: true })) {
        loadLightNodeStatus({ fresh: true });
        return;
      }
      // A binding whose device record waits with no lease (no vendor token went with it, or the oracle could not give one)
      // is taken but never counted: from this tab, in the foreground, the same binding goes again with a token (MN-4).
      if (local && status.signed && status.signed.deviceState === 'check_pending' && await enrolAgainIfUnleased(nodeId, status)) {
        loadLightNodeStatus({ fresh: true });
        return;
      }
      // A lease refresh that went without a token Google Play can fix is tried again from here with its dialog (MN-R4-09).
      if (local && local.hw && await refreshLeaseFromTab(nodeId)) {
        loadLightNodeStatus({ fresh: true });
        return;
      }
      // A re-send the network refused is said at once (NodeTab checkState).
      const checkAfter = await checkOf();
      if (JSON.stringify(checkAfter) !== JSON.stringify(check)) putCard(card(checkAfter));
      // The Background row: read again with every status, so a change made in the system settings shows on return.
      readBackground().then((bg) => setBgState((prev) => (JSON.stringify(prev) === JSON.stringify(bg) ? prev : bg)))
        .catch(() => {});
      // The balance of a node this device shows: bound here, being linked here (NodeTab lightShownHere), or on another
      // device, whose card shows it too.
      if (status.onChain === true && (shown || pending || bindingVerdict(status, shown) === 'elsewhere')) {
        loadLightBalance(nodeId, owner, { force: rewards });
      }
      // A latest miss the owners put down to no push address (or a binding made without a push token) sends this device's
      // push token again, as an open of the app does.
      if (local && status.onChain === true && linkedHere(status, local)) readdressIfOwed(nodeId, status).catch(() => {});
      // Offline here: this device answers again by itself, a forced self-attest at most every ten minutes from here,
      // and the status is read again once it went through.
      if (linkedHere(status, local) && status.needsReactivation && Date.now() - offlineAttestAtRef.current >= 10 * 60_000) {
        offlineAttestAtRef.current = Date.now();
        selfAttestIfNeeded(nodeId, true)
          .then((ok) => { if (ok) loadLightNodeStatus({ fresh: false }); })
          .catch(() => {});
      }
    } catch (error) {
      logger.error('Failed to load Light node status:', error);
    }
  };

  // The light node's balance (the wallet's: every node id of it gives the same figure) from three genesis answers:
  // the largest of those not behind the wallet's claim watermark (ClaimTransit.answerFloor, acceptedBalance: a node
  // behind it still counts epochs the wallet moved, so it never brings a moved amount back). No answer that counts keeps
  // the last figure. Once per epoch and node (requestPace.balanceDue: it changes only when an epoch settles), now when
  // `force` (pull-to-refresh, a move). While a move of the wallet is in transit nothing is read (the tab shows the rest
  // the move left) and nothing is locked.
  const loadLightBalance = async (nodeId, owner, { force = false } = {}) => {
    if (transitTotal(transitRef.current) > 0) return;
    const height = estimatedHeight(heightRead());
    if (!force && !balanceDue(lightBalanceReadRef.current, nodeId, height)) return;
    lightBalanceReadRef.current = balanceRead(nodeId, height);
    const answers = await Promise.all(
      Array.from({ length: 3 }, () => getPendingRewards(nodeId).catch(() => ({ success: false })))
    );
    const figure = acceptedBalance(answers, claimFloor(owner));
    if (figure === null) lightBalanceReadRef.current = null; // the next status read asks again
    if (figure !== null && currentOwnerRef.current === owner && transitTotal(transitRef.current) === 0) setLightBalance(figure);
  };
  
  // What aiqnet.io records of this wallet's node, read while the Node tab is open and the genesis nodes name none (then
  // it adds nothing), said only once two of them say the wallet has none (NodeTab): the state and node type only. A read
  // that fails keeps the last answer for this wallet, and with none the tab shows what the network says.
  // The status interval backs off while the site says "none" or cannot be read: from SITE_RECORD_FIRST_WAIT_MS, doubling to
  // SITE_RECORD_MAX_WAIT_MS (M14: every open Node tab polled the one site host). A record on its way is read at the
  // interval's pace; opening the tab and pull-to-refresh (`force`) always read.
  const siteRecordPollRef = useRef({ owner: null, wait: 0, nextAt: 0 });
  const loadSiteRecord = async ({ force = false } = {}) => {
    const owner = currentOwnerRef.current;
    if (!owner) return;
    const named = walletNodeRef.current;
    if ((named && !named.none && named.owner === owner) || lightOnChainRef.current) return;
    const poll = siteRecordPollRef.current;
    if (!force && poll.owner === owner && Date.now() < poll.nextAt) return;
    const record = await readNodeRecordState(owner);
    if (currentOwnerRef.current !== owner) return;
    const idle = !record || record.state === 'none';
    const wait = idle ? Math.min(poll.owner === owner && poll.wait ? poll.wait * 2 : SITE_RECORD_FIRST_WAIT_MS, SITE_RECORD_MAX_WAIT_MS) : 0;
    siteRecordPollRef.current = { owner, wait, nextAt: Date.now() + wait };
    setSiteRecord((prev) => (record ? { owner, ...record } : (prev && prev.owner === owner ? prev : null)));
  };

  // A server node's counted and not admitted epochs, read only once the chain's registration height of the node is
  // known (node-events), so no epoch before it is counted; at most every SERVER_EPOCHS_MS unless `fresh`.
  const loadServerEpochs = async (nodeId, { fresh = false } = {}) => {
    const owner = currentOwnerRef.current;
    const reg = nodeRegRef.current;
    if (!owner || !nodeId || reg.owner !== owner || !Number.isSafeInteger(reg.heights[nodeId])) return;
    const last = serverEpochsRef.current;
    if (!fresh && last && last.owner === owner && last.nodeId === nodeId && Date.now() - last.at < SERVER_EPOCHS_MS) return;
    const epochs = await getNodeEpochs(nodeId, { walletAddress: owner, registeredHeight: reg.heights[nodeId] }).catch(() => null);
    if (currentOwnerRef.current !== owner || !epochs) return;
    setServerEpochs({ owner, nodeId, counted: epochs.counted, notAdmitted: epochs.notAdmitted || 0, at: Date.now() });
  };

  // The one way a status reaches the server card (NodeTab.serverStatusAfter: only an answer that names the node
  // walletNode links replaces it; anything else keeps the last good one, marked stale), and the one way one is kept: a
  // status that names that node registered goes into the wallet's record, which shows it at once on the next open.
  const showServerStatus = (owner, nodeId, answer) => {
    const node = serverNodeOf(walletNodeRef.current, owner);
    if (currentOwnerRef.current !== owner || !node || node.nodeId !== nodeId) return;
    setServerNodeStatus((prev) => serverStatusAfter(prev, answer, nodeId));
    if (serverStatusNames(answer, nodeId)) {
      walletManager.saveWalletNode({ owner, nodeId, nodeType: node.nodeType, status: answer }).catch(() => {});
    }
  };

  // The node balance a server node's status shows (the wallet's, whichever node id is asked), read by the node's id once
  // per epoch (`rewards`: now, as pull-to-refresh and a move ask). Nothing is read while a move is in transit (the tab
  // shows the rest the move left), and a read with no answer that counts keeps the last figure, never a smaller one.
  const serverBalance = async (owner, nodeId, status, rewards) => {
    const kept = serverRewardsRef.current && serverRewardsRef.current.nodeId === nodeId ? serverRewardsRef.current : null;
    const height = estimatedHeight(heightRead());
    if (transitTotal(transitRef.current) > 0) return kept ? kept.value : status.pendingRewards;
    if (!rewards && kept && !balanceDue(kept, nodeId, height)) return kept.value; // read in this epoch already
    // A claim proof is checked on chain against the reward root, so no node can inflate the claimable; among nodes not
    // behind the wallet's claim watermark (answerFloor) an honest one only under-reports, so the largest of those counts.
    const answers = await Promise.all(
      Array.from({ length: 3 }, () => getPendingRewards(nodeId).catch(() => ({ success: false })))
    );
    const figure = acceptedBalance(answers, claimFloor(owner));
    if (figure !== null) {
      serverRewardsRef.current = { ...balanceRead(nodeId, height), value: figure };
      return figure;
    }
    if (kept) return kept.value;
    const shown = serverNodeStatusRef.current;
    return serverStatusNames(shown, nodeId) && shown.pendingRewards != null ? shown.pendingRewards : status.pendingRewards;
  };

  // One read of the card's node by its id (LightNode.readServerNodeListed): the first answer naming it registered shows at
  // once while nothing good of it is shown, the best with the balance once all are in; two "not registered" leave it being
  // checked, no answer unreachable. One genesis node's by-wallet answer only hints another id, taken once two confirm it.
  const readServerNode = async (owner, node, rewards) => {
    const { nodeId } = node;
    const keptBalance = () => (serverRewardsRef.current && serverRewardsRef.current.nodeId === nodeId
      ? serverRewardsRef.current.value : null);
    let best = null;
    const [listed, hint] = await Promise.all([
      readServerNodeListed(nodeId, {
        onStatus: (status) => {
          best = status;
          if (serverStatusNames(serverNodeStatusRef.current, nodeId)) return;
          const kept = keptBalance();
          showServerStatus(owner, nodeId, kept === null ? status : { ...status, pendingRewards: kept });
        },
      }).catch(() => null),
      checkServerNodeStatus(owner, 1).catch(() => null),
    ]);
    if (currentOwnerRef.current !== owner) return;
    if (best) {
      showServerStatus(owner, nodeId, { ...best, pendingRewards: await serverBalance(owner, nodeId, best, rewards) });
      loadServerEpochs(nodeId);
    } else {
      showServerStatus(owner, nodeId, listed === false ? { success: true, registered: false, nodeId } : { success: false, error: 'network' });
    }
    if (hint && hint.success === true && hint.nodeId && hint.nodeId !== nodeId) {
      const confirmed = await walletManager.confirmServerNode(owner, { nodeType: node.nodeType, nodeId: hint.nodeId })
        .catch(() => null);
      if (confirmed === true) linkNode(owner, { nodeId: hint.nodeId, nodeType: node.nodeType });
    }
  };

  // The server card's status of the node walletNode names (a super or genesis node), read by its id; a read of that node
  // already running serves the call, unless this one reads the balance now (`rewards`) and that one does not.
  const serverReadRef = useRef(null);
  const loadServerNodeStatus = ({ rewards = false } = {}) => {
    const owner = currentOwnerRef.current;
    const node = serverNodeOf(walletNodeRef.current, owner);
    if (!node) return Promise.resolve();
    const running = serverReadRef.current;
    if (running && running.owner === owner && running.nodeId === node.nodeId && (running.rewards || !rewards)) {
      return running.promise;
    }
    const promise = readServerNode(owner, node, rewards)
      .catch(() => showServerStatus(owner, node.nodeId, { success: false, error: 'network' }))
      .finally(() => { if (serverReadRef.current && serverReadRef.current.promise === promise) serverReadRef.current = null; });
    serverReadRef.current = { owner, nodeId: node.nodeId, rewards, promise };
    return promise;
  };

  // The genesis nodes named `node` ({ nodeId, nodeType }) as `owner`'s: shown at once and kept in the wallet's record. A
  // node other than the one shown starts with no status (never another node's) and reads its own.
  const linkNode = (owner, node) => {
    if (currentOwnerRef.current !== owner || !node || !node.nodeId || !node.nodeType) return;
    const cur = walletNodeRef.current;
    const same = !!cur && !cur.none && cur.owner === owner && cur.nodeId === node.nodeId && cur.nodeType === node.nodeType;
    if (same && !cur.stored) return;
    setWalletNode({ owner, nodeId: node.nodeId, nodeType: node.nodeType });
    if (same) return; // the record's node, which the genesis nodes name now
    setServerNodeStatus(null);
    walletManager.saveWalletNode({ owner, nodeId: node.nodeId, nodeType: node.nodeType }).catch(() => {});
    loadServerNodeStatus();
  };

  // Two genesis nodes say the wallet has no node: no server card, and its record goes.
  const unlinkNode = (owner) => {
    if (currentOwnerRef.current !== owner) return;
    setWalletNode({ owner, none: true });
    setServerNodeStatus(null);
    setServerEpochs(null);
    walletManager.forgetWalletNode(owner).catch(() => {});
  };

  // Whether the genesis nodes gave their word on the wallet's node since it opened: a node they named, or none.
  const walletNodeNamed = () => {
    const n = walletNodeRef.current;
    return !!n && n.owner === currentOwnerRef.current && !n.stored;
  };

  // This wallet's node from the genesis nodes (WalletManager.walletNode): linked at once on the first answer naming it;
  // only two authoritative "none" unlink it, card and record with it; with no verdict what is shown stays. node-events
  // gives the registration heights a server node's epochs count from. A read already running serves the call.
  const walletNodeReadRef = useRef(null);
  const loadWalletNode = () => {
    const owner = currentOwnerRef.current;
    if (!owner) return Promise.resolve();
    const running = walletNodeReadRef.current;
    if (running && running.owner === owner) return running.promise;
    const read = async () => {
      const ids = { light: walletManager.generateLightNodePseudonym(owner), super: walletManager.generateSuperNodePseudonym(owner) };
      const [verdict, events] = await Promise.all([
        walletManager.walletNode(owner, { onNamed: (node) => linkNode(owner, node) }).catch(() => null),
        getWalletNodeEvents(owner, ids).catch(() => ({ success: false })),
      ]);
      if (currentOwnerRef.current !== owner) return;
      if (events.success) {
        nodeRegRef.current = { owner, heights: Object.fromEntries(events.nodes.map((n) => [n.nodeId, n.height])) };
      }
      if (verdict === 'none') unlinkNode(owner);
      else if (verdict) linkNode(owner, verdict);
      const server = serverNodeOf(walletNodeRef.current, owner);
      if (server) loadServerEpochs(server.nodeId);
    };
    const promise = read()
      .catch((error) => { logger.error('Failed to load the wallet\'s node:', error); })
      .finally(() => { if (walletNodeReadRef.current && walletNodeReadRef.current.promise === promise) walletNodeReadRef.current = null; });
    walletNodeReadRef.current = { owner, promise };
    return promise;
  };

  // The Node tab's loaders as the latest render made them, for the callers that outlive a render (the status interval,
  // the return to the app), as autoUnlockRef is the lock screen's.
  const nodeLoadersRef = useRef(null);
  nodeLoadersRef.current = { refreshHeight, loadWalletNode, loadServerNodeStatus, loadLightNodeStatus, loadSiteRecord };

  // After Use this device the tab reads the signed status again at USE_REREAD_MS while the node has not answered in this
  // epoch, so the card turns from the waiting notice to Online without a pull. Foreground and this tab only: leaving
  // either stops them (contract 4).
  const useRereadRef = useRef([]);
  const stopRereads = () => {
    for (const timer of useRereadRef.current) clearTimeout(timer);
    useRereadRef.current = [];
  };
  const rereadAfterUse = () => {
    stopRereads();
    useRereadRef.current = USE_REREAD_MS.map((ms) => setTimeout(() => {
      const answered = lightNodeStatusRef.current && lightNodeStatusRef.current.status
        && lightNodeStatusRef.current.status.answered === true;
      if (answered || activeTabRef.current !== 'node' || AppState.currentState !== 'active') { stopRereads(); return; }
      loadLightNodeStatus({ fresh: true });
    }, ms));
  };
  useEffect(() => { if (activeTab !== 'node') stopRereads(); }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => { if (next !== 'active') stopRereads(); });
    return () => { sub.remove(); stopRereads(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Use this device: after the confirmation, which discloses the device check (plan-technical 16.1), and a fresh check of
  // whoever holds the device, the wallet key binds its node to this device with a newer sequence; the device that
  // answered before stops. A refusal is said on the card.
  const handleUseDevice = () => {
    const nodeId = lightNodeStatus && lightNodeStatus.nodeId;
    if (!nodeId || nodeUseBusy) return;
    showAlert(
      t('node_use_title'),
      `${t('node_use_body')}\n\n${t('link_device_check_title')} ${t('link_device_check_body')}`,
      [
        { text: t('cancel'), style: 'cancel' },
        { text: t('legal_privacy'), onPress: () => { Linking.openURL(LEGAL_LINKS[0][1]).catch(() => {}); } },
        { text: t('node_use'), onPress: async () => {
          if (!(await confirmFresh(t('auth_node_use')))) return;
          setNodeUseBusy(true);
          try {
            // The chain's epoch the tab shows decides whether the key rotation fell due (a new key then); the status the
            // card shows is the one the user confirmed on.
            const r = await bindThisDevice({
              signer: walletManager, credential: password, nodeId, device: deviceCheck, interactive: true,
              epoch: currentBlockHeight > 0 ? Math.floor(currentBlockHeight / 14400) : null,
              known: lightNodeStatus.status,
            });
            setUseRefusal(r.ok ? null : {
              reason: r.reason, retryAfterSeconds: r.retryAfterSeconds || null, unknown: r.unknown === true,
            });
            if (r.ok) rereadAfterUse();
          } catch (error) {
            logger.warn('[Node] use this device failed:', (error && error.message) || error);
            setUseRefusal({ reason: 'network' });
          } finally {
            setNodeUseBusy(false);
          }
          await loadLightNodeStatus({ fresh: true });
        } },
      ],
    );
  };

  // No automatic ping interval - user can manually refresh via pull-to-refresh
  
  // The address a move of the node balance pays: always the wallet's QNet (EON) address, for every node type; the node
  // checks the EON format and the address the node's registration names.
  const getWalletAddressForClaim = async () => {
    const qnetAddr = wallet.qnetAddress;
    if (!qnetAddr) throw Object.assign(new Error('This wallet has no QNet address'), { code: 'NO_WALLET' });
    return qnetAddr;
  };

  // A move that did not go: the text of its code (utils/moveText).
  const claimErrorText = (error) => t(claimErrorKey(error));
  
  // Open Send Screen from Assets (click on token) - inline, not modal
  // Open the Send screen. For QRC-20 tokens, pass the extra `token` descriptor
  // { contract, decimals } so handleSendTransaction can route through qrc20Transfer and
  // scale the amount by the token's OWN decimals. Native QNC omits it (contract stays null). On Solana ('solana') the
  // symbol names one of the Solana tokens the Assets list shows, and the Solana Send screen takes over (./SolanaSend).
  const openSendModal = (tokenSymbol, tokenBalance, network, token = null) => {
    sendFormRef.current += 1;
    setSendingToken({
      form: sendFormRef.current,
      symbol: tokenSymbol,
      balance: tokenBalance,
      network: network,
      contract: token ? token.contract : null,
      decimals: token ? token.decimals : null,
      // A token's exact balance (a decimal string) for the percentage buttons, and whether it is named after QNet.
      balanceText: token && typeof token.balanceText === 'string' ? token.balanceText : null,
      reserved: !!(token && token.reserved),
    });
    setSendAddress('');
    setSendAmount('');
    setSolanaRequest(null);
    setSendFromLink(false);
    setTxResult(null);
    setShowScan(false);
    setShowSendScreen(true);
    // The live figure a QNet send is checked against is read from now on, while the form is filled: a tap soon after takes
    // it as it is, or joins the read still running (WalletManager.qncForSend).
    const from = network === 'qnet' && wallet && (wallet.qnetAddress || wallet.address);
    if (from) Promise.resolve().then(() => walletManager.qncForSend(from)).catch(() => {});
  };

  // What the Solana Send screen's scan read goes into its form: the recipient, and for a payment request its token and
  // amount, and what the transfer must hold for that recipient (references, memo). The user still reviews and confirms.
  const applySolanaScan = (value) => {
    setSendAddress(value.address);
    setSolanaRequest(value.request || null);
    if (value.symbol) setSendingToken((prev) => (prev ? { ...prev, symbol: value.symbol } : prev));
    // A request with no amount keeps the one typed, with no more decimal places than its token has.
    if (value.amount) setSendAmount(value.amount);
    else if (value.symbol) setSendAmount((prev) => cleanAmountInput(prev, solanaToken(value.symbol).decimals));
  };

  // A transfer request from a link (openTransferLink) opens once the wallet is open and no QNet Link request waits for
  // the user's decision: the Solana Send screen of its token, filled in as a scan fills it, over the Assets tab. A
  // decided request gives way to it at once, also while a send under way holds the form back (its answer goes on in the
  // background, services/LinkAnswers, and AnswerAway says so). It takes the place of
  // a Send form the user has open, since the request is what the user asked for last; a send under way (checked,
  // reviewed, confirmed, signed or sent, or its result on screen), whether or not its form is still open, ends first,
  // and the request opens right after. One that waited behind an earlier link opens once the form that link opened is
  // closed: they open in their order.
  const sendUnderWay = !!(sendChecking || sendingTransaction || solanaSending || sendReview || txResult);
  const linkFormOpen = showSendScreen && sendFromLink;
  const linkUndecided = !!linkRequest && !linkRequest.settled;
  useEffect(() => {
    if (!solanaLink || !wallet || linkUndecided) return;
    setLinkRequest(null);
    if (sendUnderWay || (solanaLink.waited && linkFormOpen)) return;
    const { value, release } = solanaLink;
    setSolanaLink(null);
    selectTab('assets');
    openSendModal(value.symbol, value.symbol === '1DEV' ? tokenBalances['1dev'] : balance, 'solana');
    applySolanaScan(value);
    setSendFromLink(true);
    noteLink('transfer_form_opened', { token: value.symbol });
    release();
  }, [solanaLink, wallet, linkUndecided, sendUnderWay, linkFormOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // The assets the wallet holds on a network, as the token picker, a token's own screen and the Send form take them: QNC
  // and the QNet tokens the Assets list shows, or SOL and 1DEV; each with the figure Assets shows (masked while balances
  // are hidden), `history` naming its History rows (utils/txHistory assetOf), `known` for one with no contract (no
  // look-alike can be it).
  const heldAssets = (network) => {
    if (network === 'solana') {
      const held = { SOL: [balance, 'sol'], '1DEV': [tokenBalances['1dev'], 'oneDev'] };
      return SOLANA_TOKENS.map((tk) => ({
        key: tk.symbol, network, symbol: tk.symbol, name: '', contract: null, mint: tk.mint, decimals: tk.decimals,
        balance: held[tk.symbol][0], figure: figure(held[tk.symbol][1], fmtAmount(held[tk.symbol][0], 4)),
        reserved: false, known: true, history: `solana:${tk.symbol}`,
      }));
    }
    return [
      {
        key: 'QNC', network, symbol: 'QNC', name: '', contract: null, mint: null, decimals: 9, balance: tokenBalances.qnc,
        figure: figure('qnc', fmtAmount(tokenBalances.qnc, 5)), reserved: false, known: true, history: 'qnc',
      },
      ...qrcTokens.filter((tk) => tk.contract && isTokenShown(tk.contract)).map((tk) => ({
        key: tk.contract,
        network,
        symbol: tokenTitle(tk),
        name: tk.name && tk.name !== tk.symbol ? tokenLabel(tk.name) : '',
        contract: tk.contract,
        mint: null,
        decimals: tk.decimals,
        balance: parseFloat(tk.balance) || 0,
        balanceText: typeof tk.balance === 'string' ? tk.balance : null,
        figure: shownBalance(tokenFigure(tk)),
        reserved: usesReservedName(tk.symbol, tk.name),
        known: false,
        history: tk.contract.toLowerCase(),
      })),
    ];
  };

  // The Send form of an asset: the token picker's choice, or Send on a token's own screen.
  const openSendFor = (asset) => {
    setSendPicker(null);
    openSendModal(asset.symbol, asset.balance, asset.network, asset.contract
      ? { contract: asset.contract, decimals: asset.decimals, balanceText: asset.balanceText, reserved: asset.reserved } : null);
  };

  // A token's own screen, from its row on Assets; its QNet transfers are read again as it opens.
  const openTokenScreen = (network, key) => {
    setTokenScreen({ network, key });
    if (network === 'qnet') loadTxHistory();
  };
  // A token hidden in the token manager while its screen is open closes the screen, so it never comes back by itself.
  useEffect(() => {
    if (tokenScreen && !heldAssets(tokenScreen.network).some((a) => a.key === tokenScreen.key)) setTokenScreen(null);
  }, [tokenScreen, qrcTokens, hiddenTokens, shownTokens, customTokens]); // eslint-disable-line react-hooks/exhaustive-deps
  
  // Open / close the Add-Custom-Token modal.
  const openAddTokenModal = () => {
    setAddTokenAddress('');
    setAddTokenError('');
    setAddingToken(false);
    setShowAddTokenModal(true);
  };
  const closeAddTokenModal = () => {
    setShowAddTokenModal(false);
    setAddTokenAddress('');
    setAddTokenError('');
    setAddingToken(false);
  };

  // Validate a pasted contract address, resolve its token metadata via getTokenInfo, persist it to
  // AsyncStorage 'qnet_custom_tokens' (deduped by contract_address), merge it into the Assets list,
  // and fetch its balance for the current wallet.
  const handleAddCustomToken = async (contractArg) => {
    if (addingToken) return;
    const contract = ((typeof contractArg === 'string' ? contractArg : '') || addTokenAddress || '').trim().toLowerCase();
    if (!contract) { setAddTokenError(t('tok_enter_contract')); return; }
    // A contract address is EON like an account's (derive_contract_address): 45 characters with its checksum.
    if (!isValidQnetAddress(contract)) {
      setAddTokenError(t('tok_invalid_contract'));
      return;
    }
    setAddingToken(true);
    setAddTokenError('');
    try {
      const info = await walletManager.getTokenInfo(contract);
      if (!info) {
        setAddTokenError(t('tok_not_found'));
        setAddingToken(false);
        return;
      }
      const entry = {
        contract_address: contract,
        contract,
        name: info.name,
        symbol: info.symbol,
        decimals: info.decimals,
        logo: info.logo || '',
      };
      // Persist (dedupe by contract_address).
      let persisted = [];
      try {
        const raw = await AsyncStorage.getItem('qnet_custom_tokens');
        persisted = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(persisted)) persisted = [];
      } catch (_) { persisted = []; }
      if (!persisted.some((p) => (p.contract_address || p.contract) === contract)) {
        persisted.push(entry);
        await AsyncStorage.setItem('qnet_custom_tokens', JSON.stringify(persisted));
      }
      setCustomTokens(persisted);

      // Fetch this token's balance for the current wallet and merge into the Assets list.
      const qnetAddr = wallet?.qnetAddress || (await walletManager.getCurrentWallet())?.qnetAddress;
      let balanceStr = '0';
      if (qnetAddr) {
        const bal = await walletManager.getTokenBalanceOf(contract, qnetAddr, info.decimals);
        if (bal.balance != null) balanceStr = bal.balance;
      }
      setQrcTokens((prev) => {
        const next = prev.filter((row) => row.contract !== contract);
        next.push({ contract, name: info.name, symbol: info.symbol, decimals: info.decimals, balance: balanceStr, logo: info.logo || '' });
        return next;
      });
      setTokenMgrQuery('');   // clear search so the just-added token shows in the tracked list
      closeAddTokenModal();
    } catch (e) {
      setAddTokenError(errorText(t, e, 'tok_add_failed'));
      setAddingToken(false);
    }
  };

  // The QNC balance a send is checked against (MOBNET-R3-04; the owner's rule, 18.10): the wallet's figure at a genesis
  // node's live tip, its proof folded, less what this wallet's own transactions that figure does not hold may still take
  // (WalletManager.qncForSend: one read, or the one the Send screen started), as the in-app browser's sheet takes it;
  // never the figure on screen, which may predate a spend. { error } when none can be had: the send is then refused,
  // saying why (sendCheckError).
  const freshQncNano = async () => {
    const addr = wallet && (wallet.qnetAddress || wallet.address);
    const r = addr ? await walletManager.qncForSend(addr).catch(() => null) : null;
    return r && r.ok && /^\d+$/.test(String(r.balanceNano)) ? r : { error: (r && r.error) || 'unanswered' };
  };

  // Why a send check found no balance to check by, said as it is: what one of this wallet's transactions takes is not
  // known yet (try again in a minute), or no answer from the network.
  const sendCheckError = (error) => t(error === 'unconfirmed' ? 'balance_unconfirmed' : 'send_balance_unreadable');

  // What the send may still spend (BigInt): the checked balance less what this wallet's unsettled transactions may
  // still take, the one a replacement signs over excepted (at most one of the two can apply).
  const afterPending = (balance, pending, replaceNonce) => {
    let left = BigInt(balance);
    for (const p of Array.isArray(pending) ? pending : []) if (p.nonce !== replaceNonce) left -= BigInt(p.amount);
    return left > 0n ? left : 0n;
  };

  // Close Send Screen and go back to assets
  const closeSendScreen = () => {
    sendFormRef.current += 1;
    setShowScan(false);
    setShowSendScreen(false);
    setSendingToken(null);
    setTxResult(null);
    setSendAddress('');
    setSendAmount('');
    setSolanaRequest(null);
    setSendFromLink(false);
  };

  // Whether `form` (sendingToken.form) is the Send form still open: a send whose form closed before the user confirmed
  // it raises nothing more, no refusal, dialog, review or check.
  const sendFormOpen = (form) => form === sendFormRef.current;

  // Assets as it opens, its token list with nothing over it: where the Assets tab leads from any screen, and Done on a
  // send the network took.
  const goAssetsHome = () => {
    closeSendScreen();
    setSendPicker(null);
    setTokenScreen(null);
    setTxDetail((d) => (d && d.tab === 'assets' ? null : d));
    setActiveTab('assets');
  };

  /**
   * Which of the three outcomes a result carries. `unknown` is a submit nobody answered: the chain has
   * not decided, so it is neither a success nor a refusal, and the resolver below settles it.
   */
  const txResultState = (r) => (r.unknown ? 'pending' : (r.success ? 'success' : 'failed'));

  /**
   * The chain's state of a result, said at the top of its card in History's words: a move as its record says it now
   * (ClaimTransit.moveOutcome), a send as its confirmation does. A refusal has none: its title says it.
   */
  const txResultStatus = (r) => {
    if (r.move) {
      const o = moveOutcome(transit, r.txHash);
      // A move in parts: the parts before the last are in the wallet, and it moves on while its next part is to go.
      if (o && o.result === 'expired') return r.run && r.run.parts.length > 1 ? 'confirmed' : 'failed';
      if (r.run && r.run.more) return 'moving';
      return o && (o.result === 'done' || o.result === 'partial') ? 'confirmed' : 'moving';
    }
    if (r.unknown) return 'pending';
    if (!r.success) return null;
    return r.confirmed ? 'confirmed' : 'pending';
  };

  /**
   * What the result says under the amount, beyond its status: the caller's own note, or a move's as its record says it
   * now (ClaimTransit.runNote: in transit, done or in part).
   */
  const txResultNote = (r) => {
    if (r.note) return r.note;
    if (r.move) {
      const n = runNote(r.run, moveOutcome(transit, r.txHash), r.stoppedAtEpoch);
      return moveNoteText(t, n, (nano) => qncText(nano, balancesHidden));
    }
    if (r.unknown) return t('tx_note_unknown');
    return null;
  };

  // The amount, hash and block a result shows, and whether the explorer has that hash: a move by its parts' records now
  // (what they put in the wallet, and its last part that counts: MoveRun) while its status and note read its last part;
  // a send has no page once the chain said no block took it (`unrun`), and a Solana one has none here.
  const txResultShown = (r) => {
    if (r.move && r.parts) {
      const outcomeOf = (hash) => moveOutcome(transit, hash);
      const run = { parts: r.parts };
      const counted = lastCountedPart(run, outcomeOf);
      // its one part expired: what it submitted stays on the node, and that hash is in no block
      if (!counted) return { amount: r.amount, hash: r.txHash, block: null, explorer: false };
      return {
        amount: formatNano(runMovedNano(run, outcomeOf).toString()), hash: counted.txHash,
        block: counted.txHash === r.txHash ? r.block : null, explorer: true,
      };
    }
    return { amount: r.amount, hash: r.txHash, block: r.block, explorer: r.chain !== 'solana' && !r.unrun };
  };

  // An unsettled send that a node refused: say what it answered, and whether the wallet sends it again (for up to half
  // an hour, only when waiting can heal the refusal: MOBNET-R3-01) and asks, before the next send, whether that one
  // replaces it (services/PendingTx). Unanswered sends keep the default note.
  // A refusal is final only when every node the send went to answered: a request that went unanswered may have left
  // it with that node (MOBNET-R4-02), so it is reported like one that can heal.
  // The node's reason is said in the app's language (utils/txRefusal, L-12), never in the node's own words.
  const unknownNote = (u) => (u && u.refusal
    ? t(refusalHeals(u.refusal) || u.refusalUncertain ? 'tx_note_refused' : 'tx_note_refused_final', { reason: refusalReason(t, u.refusal) })
    : undefined);

  // This wallet's kept transactions, listed on the Assets tab until they settle (MOBNET-R3-01): whether a node holds
  // each, whether the wallet still sends it by itself and for how long, and "Stop sending" where no node holds it.
  const refreshKept = async (address) => {
    if (!address) return;
    const list = await walletManager.keptTransactions(address).catch(() => null);
    if (!list || (currentOwnerRef.current && address !== currentOwnerRef.current)) return;
    setKeptTxs((prev) => (sameRows(prev, list) ? prev : list));
  };

  // This wallet's unconfirmed transactions stay alive while the app is open: the one at the account's next nonce is
  // sent again when no node holds it (a send "in addition" gets in once the one before applies), for as long as the
  // wallet still sends it (MOBNET-R3-01). The Assets list follows.
  const sendKeptDue = (address) => walletManager.sendDuePending(address).catch(() => {})
    .finally(() => { refreshKept(address); });

  const stopKept = async (p) => {
    const from = wallet && (wallet.qnetAddress || wallet.address);
    if (!from) return;
    // Stopping ends the wallet's own sending; a node that took it earlier may still hold it, and the user is told for
    // how long before deciding (MOBNET-R4-02).
    const left = minutesUntil(p.stopLandsUntil);
    const go = await askAlert(t('kept_stop_title'), left > 0 ? t('kept_stop_body', { minutes: left }) : t('kept_stop_body_final'), [
      { text: t('cancel'), style: 'cancel', value: false },
      { text: t('kept_stop'), style: 'destructive', value: true },
    ]);
    if (go !== true) return;
    const done = await walletManager.stopPendingTransaction(from, p.nonce, p.bodyHash).catch(() => false);
    if (!done) showAlert(t('error'), t('kept_stop_failed'));
    await refreshKept(from);
  };

  // Whole minutes left until `at` (0 once it passed).
  const minutesUntil = (at) => (Number(at) > Date.now() ? Math.max(1, Math.ceil((Number(at) - Date.now()) / 60_000)) : 0);

  // A kept transaction is "not gone through" only once no node can hold it any more (MOBNET-R4-02).
  const keptStatus = (p) => {
    if (p.held) return t('kept_held');
    const landing = minutesUntil(p.mayLandUntil);
    if (p.sending) return t('kept_sending', { minutes: minutesUntil(p.sendsUntil) });
    if (landing > 0) return t('kept_stopped_may_land', { minutes: landing });
    return t('kept_stopped');
  };

  // An alert whose buttons resolve with their `value`. Gone any other way (Back, a lock, another alert in its place), it
  // resolves as its cancel button does, so nothing waiting on it (a send's check, which holds a link) waits for good.
  const askRef = useRef(null);
  const askAlert = (title, message, buttons) => new Promise((resolve) => {
    if (askRef.current) askRef.current.cancel();
    const cancel = buttons.find((b) => b.style === 'cancel');
    const alert = { title, message, buttons: buttons.map((b) => ({ text: b.text, style: b.style, onPress: () => resolve(b.value) })) };
    askRef.current = { alert, cancel: () => resolve(cancel ? cancel.value : undefined) };
    setCustomAlert(alert);
  });
  useEffect(() => {
    const ask = askRef.current;
    if (ask && ask.alert !== customAlert) { askRef.current = null; ask.cancel(); }
  }, [customAlert]);

  /**
   * Before a send (MOBNET-R1-01): while this wallet has unconfirmed transactions, the user sees them and chooses
   * whether the new one replaces the newest of them (the same nonce: only one of the two can go through) or comes
   * in addition (the next nonce: both can). { proceed, choice, live }, `live` the unconfirmed transactions the choice
   * was made about. `kept`: this wallet's kept transactions, when the caller already read them. `formOpen()`: whether
   * the send's form is still open; one closed while this was read asks nothing.
   */
  const decidePendingChoice = async (from, kept = null, formOpen = () => true) => {
    let preview = null;
    const local = kept || await walletManager.pendingTransactions(from).catch(() => []);
    if (local.length > 0) {
      try { preview = await walletManager.previewSend(from); } catch (_) { preview = null; }
      // No confirmed nonce to be had: the send itself will say so (nothing is signed without one).
      if (!preview) return { proceed: true, choice: null };
    }
    const live = preview ? preview.live : [];
    const decided = (d) => ({ ...d, live });
    if (live.length === 0) return decided({ proceed: true, choice: null });
    if (!formOpen()) return decided({ proceed: false, choice: null });
    const body = [t('pending_title', { count: live.length }), live.map((p) => pendingLine(t, p)).join('\n'), t('pending_ask'),
      preview.replace ? t('pending_replace_note') : null,
      preview.canAppend ? t('pending_append_note') : t('pending_append_unavailable')].filter(Boolean).join('\n\n');
    const buttons = [{ text: t('cancel'), style: 'cancel', value: null }];
    if (preview.replace) {
      buttons.push({ text: t('pending_replace'), value: { mode: 'replace', nonce: preview.replace.nonce, bodyHash: preview.replace.bodyHash } });
    }
    if (preview.canAppend) buttons.push({ text: t('pending_append'), value: { mode: 'append' } });
    const choice = await askAlert(t('pending_dialog_title'), body, buttons);
    return decided({ proceed: !!choice, choice: choice || null });
  };

  // Dismissing a result returns the flow that raised it to where it belongs — a send the network took (or may have)
  // opens Assets' token list, a claim reloads the node, a refused send goes back to its filled-in form.
  const dismissTxResult = () => {
    const onDismiss = txResult && txResult.onDismiss;
    setTxResult(null);
    if (onDismiss) onDismiss();
  };

  // Android hardware-back: dismiss the topmost open overlay/modal instead of exiting the app.
  // Returns true (handled) while anything is open; on the home tab returns false so the OS can exit.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const onBack = () => {
      if (linkRequest && wallet && !freshPrompt) return false; // the link screen handles back itself
      if (dappSheet && wallet && !freshPrompt) return false; // so does a browser request's sheet
      if (seedReveal) { setSeedReveal(null); return true; }
      if (keyReveal) { closeKeyReveal(); return true; }
      if (showEraseConfirm) { setShowEraseConfirm(false); setEraseText(''); return true; }
      if (showDeletePrompt) { setShowDeletePrompt(false); setDeletePassword(''); return true; }
      if (freshPrompt) { resolveFresh(false); return true; }
      if (sendReview) { resolveSendReview(false); return true; }
      if (customAlert) { setCustomAlert(null); return true; }
      if (showTermsModal) { setShowTermsModal(false); return true; }
      if (showBiometricPasswordPrompt) { setShowBiometricPasswordPrompt(false); return true; }
      if (showChangePassword) { setShowChangePassword(false); return true; }
      if (showExportSeed) { setShowExportSeed(false); return true; }
      if (showAutoLockPicker) { setShowAutoLockPicker(false); return true; }
      if (showLanguagePicker) { setShowLanguagePicker(false); return true; }
      // Back from the word check returns to the phrase, as the on-screen Back does.
      if (showSeedConfirm) { setShowSeedConfirm(false); setShowCreateOptions('show-seed'); return true; }
      if (showAddTokenModal) { closeAddTokenModal(); return true; }
      if (showTokenManager) { setShowTokenManager(false); return true; }
      if (sendPicker) { setSendPicker(null); return true; }
      if (showHeaderMenu) { setShowHeaderMenu(false); return true; }
      if (txResult) { dismissTxResult(); return true; }
      if (txDetail && activeTab === txDetail.tab) { setTxDetail(null); return true; }
      if (showScan) { setShowScan(false); return true; }
      if (showSendScreen) { closeSendScreen(); return true; }
      if (tokenScreen && activeTab === 'assets') { setTokenScreen(null); return true; }
      if (showSettings) { setShowSettings(false); return true; }
      // Pre-wallet onboarding full-screens: back steps in instead of exiting the app,
      // mirroring the in-form Back buttons (import step 2 → step 1, else → landing).
      if (showCreateOptions) {
        if (showCreateOptions === 'import' && importStep === 2 && !deviceAuth) {
          setImportStep(1); forgetImportPhrase(); setPasswordError(''); setTermsAccepted(false);
        } else {
          // Leaving the phrase screen abandons the unsaved wallet: its phrase and keys go with it.
          setShowCreateOptions(false);
          setTempWallet(null);
          setPassword(''); setConfirmPassword(''); forgetImportPhrase();
          setPasswordError(''); setTermsAccepted(false); setImportStep(1);
        }
        return true;
      }
      // The browser goes back in its own history first; from its first page back leaves the tab.
      if (activeTab === 'browser' && wallet && browserRef.current && browserRef.current.handleBack()) return true;
      if (activeTab && activeTab !== 'assets') { setActiveTab('assets'); return true; }
      return false; // nothing open on the home tab → let the OS exit the app
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [
    customAlert, showTermsModal, showBiometricPasswordPrompt,
    showChangePassword, showExportSeed, showAutoLockPicker,
    showLanguagePicker, showSeedConfirm, showSendScreen, showScan, showSettings,
    showCreateOptions, importStep, activeTab, showAddTokenModal,
    showTokenManager, showHeaderMenu, txResult, txDetail, seedReveal, keyReveal, showEraseConfirm, showDeletePrompt,
    freshPrompt, linkRequest, wallet, dappSheet, sendReview, deviceAuth, sendPicker, tokenScreen,
  ]);


  // The QNet recipient, pasted or typed, is kept without surrounding spaces, so the review, the own-address and
  // known-recipient checks, the pending record and History all see the address that is signed.
  const onRecipientChange = (text) => setSendAddress(String(text).trim());

  // The amount as typed or pasted (utils/sendAmount amountInput, the Solana form's rule too): a dot as the decimal point,
  // at most six places (the chain takes nine), thousands separators only where they group by three, a figure pasted as
  // every screen writes amounts read as written; a text that rule refuses leaves the field as it was. A leading zero
  // goes unless a point follows it.
  const validateAmountInput = (text) => {
    const normalized = amountInput(text, 6, { previous: sendAmount });
    if (normalized === null) return;
    setSendAmount(normalized.length > 1 && normalized[0] === '0' && normalized[1] !== '.' ? normalized.substring(1) : normalized);
  };
  
  // Set amount as percentage of balance (utils/sendAmount, L-9): floored, with no more decimals than the token takes
  // (at most six; QNC five), worked out in whole base units; a native send leaves the fee.
  const setAmountPercentage = (percentage) => {
    if (!sendingToken) return;
    setSendAmount(amountShare({
      contract: sendingToken.contract, decimals: sendingToken.decimals, balanceText: sendingToken.balanceText,
      balance: sendingToken.balance, feeNano: sendingToken.contract ? 0 : TRANSFER_FEE_NANO, percentage,
    }));
  };
  
  // v3.34: Poll TX status until confirmed
  // ARCHITECTURE: Polling only updates UI status (pending → confirmed)
  // It does NOT clear pendingTxRef — that's loadBalance's job!
  // WHY: Polling may confirm TX on Node 1, but loadBalance queries Node 3
  // which hasn't received the block yet → stale balance without protection.
  // loadBalance clears pendingTxRef ONLY when the queried node's balance
  // actually reflects the TX (qncBalance <= expectedQnc).

  // One genesis node's answer about `txHash`: the height of the block that holds it, or null (only in a mempool, not
  // known, no answer). A node answers "found" with status 'pending' for a transaction only its mempool holds, and one of
  // those can still be dropped or lose its nonce (MOBNET-R2-01; utils/txHistory txLookupState).
  const blockOfTx = async (apiUrl, txHash) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${apiUrl}/api/v1/transaction/${txHash}`, {
        method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      });
      if (!response.ok) return null;
      const txData = await response.json();
      return txLookupState(txData, txHash) === 'included' ? txData.transaction.block_height : null;
    } catch (_) {
      return null; // network error: the next attempt asks the next node
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const startTxConfirmationPolling = (txHash, settleWith = null) => {
    const run = ++outcomeRunRef.current; // an answered submit retires any resolver still asking about an older one
    // Clear any existing polling (clearTimeout also cancels a setInterval handle)
    if (txPollingRef.current) {
      clearTimeout(txPollingRef.current);
      txPollingRef.current = null;
    }
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    const startedAt = Date.now();

    // An accepted send is settled by (from, nonce) as well as by its hash (MOBNET-R3-03). Each node that accepts the
    // signed body stamps it with its own receipt time, so a hedged submit or a re-send can put a copy with another
    // hash in a mempool, and that copy may be the one that lands; and an accepted transaction can still lose its
    // nonce (a replacement won, the same phrase signed elsewhere, a mempool drop). The chain's answer at the nonce
    // decides, exactly as for a submit nobody answered. Returns true once settled.
    const settleByNonce = async () => {
      if (!settleWith || !Number.isSafeInteger(settleWith.nonce) || !settleWith.from) return false;
      let res;
      try {
        res = await walletManager.resolveSubmitByNonce(settleWith.from, settleWith.nonce, {
          toAddress: settleWith.to, amountNano: settleWith.amountNano, kind: settleWith.kind || 'transfer',
          method: settleWith.method || null, recipient: settleWith.recipient || null, amountBase: settleWith.amountBase || null,
        });
      } catch (_) {
        return false;
      }
      if (run !== outcomeRunRef.current) return true; // a newer send took over: nothing more to say here
      const mine = (prev) => prev && prev.txHash === txHash;
      const answer = nonceAnswer(res, txHash);
      if (!answer) return false;
      // History takes the same answer as its own read would (utils/txHistory withNonceAnswer): in a block under the
      // copy that landed, Expired, or gone with the transaction that took its nonce listed in its place.
      setTxHistory(prev => withNonceAnswer(prev, txHash, answer));
      if (answer.landed) {
        setTxResult(prev => (mine(prev) ? { ...prev, confirmed: true, txHash: answer.txHash } : prev));
      } else {
        const title = t(res.expired ? 'tx_expired_title' : res.replaced ? 'tx_not_applied_title' : 'tx_unbound_title');
        const error = t(res.expired ? 'tx_note_expired' : res.replaced ? 'tx_note_not_applied' : 'tx_note_unbound');
        // Expired or replaced, no block holds its hash (`unrun`: no explorer page); unbound, it names the transaction
        // that applied at its nonce.
        setTxResult(prev => (mine(prev)
          ? { ...prev, success: false, title, error, note: undefined, unrun: !!(res.expired || res.replaced),
              ...(res.unbound && res.txHash ? { txHash: res.txHash } : {}) }
          : prev));
        if (pendingTxRef.current && pendingTxRef.current.txHash === txHash) pendingTxRef.current = null;
      }
      if (txPollingRef.current) { clearTimeout(txPollingRef.current); txPollingRef.current = null; }
      if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
      if (wallet?.publicKey) loadBalance(wallet.publicKey);
      loadTxHistory();
      return true;
    };

    // From the end of the hash poll's three minutes: the nonce keeps deciding, every half minute, for as long as a
    // node may hold the transaction or the wallet may still send it (half an hour), so a card that said "stays
    // queued" follows what actually happened. Its own timer: a balance refresh that ends the hash poll early does not
    // end this.
    const settleLater = (delayMs) => {
      if (!settleWith || run !== outcomeRunRef.current || Date.now() - startedAt >= 30 * 60_000) { settleTimerRef.current = null; return; }
      settleTimerRef.current = setTimeout(async () => {
        settleTimerRef.current = null;
        if (run !== outcomeRunRef.current) return;
        if (!(await settleByNonce())) settleLater(30000);
      }, delayMs);
    };
    settleLater(180000);

    // Genesis nodes only: a transaction lookup is not proven, so no third-party node decides it.
    const allNodes = walletManager.getTrustedNodes(5);

    let attempts = 0;
    // Self-scheduling backoff: start at 2s, grow ×1.5 up to a 15s cap, and stop
    // at a wall-clock deadline. This avoids an endless fixed-cadence spinner and
    // spaces out requests as confirmation takes longer, instead of a hard 60s cliff.
    const baseDelayMs = 2000;
    const maxDelayMs = 15000;
    const deadline = Date.now() + 180000; // ~3 min total, then declare "still pending"

    const finishStillPending = () => {
      // Deadline reached without confirmation: drop the optimistic hold; the card stays Pending and the nonce keeps
      // deciding (settleLater).
      pendingTxRef.current = null;
      txPollingRef.current = null;
      updateTxStatus(txHash, 'pending');
      if (wallet?.publicKey) {
        loadBalance(wallet.publicKey);
      }
    };

    const poll = async () => {
      attempts++;

      // Rotate through nodes on each attempt for better reliability
      const block = allNodes.length ? await blockOfTx(allNodes[(attempts - 1) % allNodes.length], txHash) : null;
      if (block !== null) {
        // The optimistic hold is not cleared here: loadBalance clears it once the figure it reads holds the send, so a
        // node that has not applied the block yet never shows the old balance again.
        txPollingRef.current = null;
        if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
        // A genesis node has it in a block: the card and History show it confirmed at once, with its block.
        setTxResult(prev => (prev?.txHash === txHash ? { ...prev, confirmed: true, block } : prev));
        setTxHistory(prev => markInBlock(prev, txHash, block));
        if (wallet?.publicKey) loadBalance(wallet.publicKey);
        loadTxHistory();
        return;
      }
      if (run !== outcomeRunRef.current) return;

      // Not found under its hash: from the fourth poll on (about 20 s), every third one asks the chain by nonce.
      if (attempts >= 4 && attempts % 3 === 1 && (await settleByNonce())) return;
      if (run !== outcomeRunRef.current) return;

      // TX not found yet — reschedule with backoff until the deadline.
      if (Date.now() >= deadline) {
        finishStillPending();
        return;
      }
      const nextDelay = Math.min(baseDelayMs * Math.pow(1.5, attempts - 1), maxDelayMs);
      txPollingRef.current = setTimeout(poll, nextDelay);
    };

    txPollingRef.current = setTimeout(poll, baseDelayMs);
  };

  /**
   * Settle a submit nobody answered. The chain decides it by (from, nonce) — no other key can produce a
   * transaction with that nonce — so this asks until the account's nonce reaches ours or the screen runs
   * out of patience. It never turns into a refusal on its own: the mempool may hold the transaction for
   * up to half an hour, and calling that "failed" is exactly the guess this replaces.
   */
  const startUnknownOutcomeResolution = (outcome) => {
    if (txPollingRef.current) { clearTimeout(txPollingRef.current); txPollingRef.current = null; }

    // A newer send supersedes this one: its answer may still arrive, and it must not write over the
    // result that replaced it or steal the poll slot.
    const run = ++outcomeRunRef.current;
    const deadline = Date.now() + 180000;
    // After the first three minutes the card says it is still queued and keeps asking, every half minute, for as
    // long as the mempool may hold it: a transaction that lands later still turns the card into "Sent".
    const giveUpAt = Date.now() + 30 * 60_000;
    let attempts = 0;
    let answered = false; // whether any node ever told us the account's nonce
    let noted = false;

    const ask = async () => {
      attempts++;
      let res = { landed: false };
      try {
        res = await walletManager.resolveSubmitByNonce(outcome.from, outcome.nonce, {
          toAddress: outcome.to, amountNano: outcome.amountNano, kind: outcome.kind || 'transfer',
          method: outcome.method || null, recipient: outcome.recipient || null, amountBase: outcome.amountBase || null,
        });
      } catch (_) {
        // Unreachable node: nothing learned, ask again on the next tick.
      }
      if (run !== outcomeRunRef.current) return;
      answered = answered || !!res.known;

      if (res.landed) {
        txPollingRef.current = null;
        setTxResult(prev => prev && prev.unknown
          ? { ...prev, unknown: false, success: true, title: t('tx_sent_title'),
              txHash: res.txHash || prev.txHash, confirmed: true, note: undefined }
          : prev);
        if (wallet?.publicKey) loadBalance(wallet.publicKey);
        loadTxHistory();
        return;
      }

      // A call or deploy of this wallet applied at that nonce, but nothing binds it to this one: it went through,
      // or one that replaced it did. Never "Sent" on that alone (MOBNET-R2-02).
      if (res.unbound) {
        txPollingRef.current = null;
        setTxResult(prev => prev && prev.unknown
          ? { ...prev, unknown: false, success: false, title: t('tx_unbound_title'), error: t('tx_note_unbound'),
              txHash: res.txHash || prev.txHash, note: undefined }
          : prev);
        if (wallet?.publicKey) loadBalance(wallet.publicKey);
        loadTxHistory();
        return;
      }

      // Another transaction of this wallet took its nonce (one that replaced it, or one the same recovery phrase
      // signed elsewhere): this one can no longer apply (MOBNET-R1-03).
      // No block took it by the last height it signed (expired): it failed and took nothing.
      if (res.replaced || res.expired) {
        txPollingRef.current = null;
        setTxResult(prev => prev && prev.unknown
          ? { ...prev, unknown: false, success: false, title: t(res.expired ? 'tx_expired_title' : 'tx_not_applied_title'),
              error: t(res.expired ? 'tx_note_expired' : 'tx_note_not_applied'), note: undefined }
          : prev);
        if (wallet?.publicKey) loadBalance(wallet.publicKey);
        loadTxHistory();
        return;
      }

      // Until when a node may still hold it (MOBNET-R4-02): no "has not gone through" before then.
      const landing = minutesUntil(res.mayLandUntil);
      if (Date.now() >= deadline) {
        // Say only what was actually learned: the chain answered and does not have it yet (held by a node, refused
        // by every node so far: MOBNET-R2-04, or no longer sent at all: MOBNET-R3-01, which can still go through while
        // a node may hold it: MOBNET-R4-02), or nothing answered at all and the outcome is still unread. Updated
        // whenever that changes, not only once.
        const note = !answered ? t('tx_note_no_node')
          : res.sending === false ? (landing > 0 ? t('tx_note_stopped_may_land', { minutes: landing }) : t('tx_note_stopped'))
            : res.held === false ? t('tx_note_not_held') : t('tx_note_still_queued');
        if (note !== noted) {
          const first = !noted;
          noted = note;
          setTxResult(prev => prev && prev.unknown ? { ...prev, note } : prev);
          if (first && wallet?.publicKey) loadBalance(wallet.publicKey);
        }
      }
      // Asked for as long as the mempool may hold it: a transaction that lands later still turns the card into "Sent".
      if (Date.now() >= giveUpAt && landing === 0) { txPollingRef.current = null; return; }

      txPollingRef.current = setTimeout(ask, noted ? 30000 : Math.min(3000 + attempts * 1000, 10000));
    };

    txPollingRef.current = setTimeout(ask, 3000);
  };

  // Send QNC transaction (real blockchain transaction)
  const handleSendTransaction = async () => {
    if (!sendAddress || !sendAmount || sendingTransaction) return;
    const formOpen = () => sendFormOpen(sendingToken.form);
    // A send is refused on its form while that form is open; once the user confirmed it, wherever the screen is.
    let confirmed = false;
    const refuse = (error) => {
      if (confirmed || formOpen()) setTxResult({ success: false, title: t('send_cannot_title'), error });
    };

    const amount = parseFloat(sendAmount);
    if (isNaN(amount) || amount <= 0) {
      refuse(t('send_invalid_amount'));
      return;
    }

    // A send back to this same wallet: it still pays the fee, but the amount never leaves, so neither the
    // balance nor the history may show it as spent.
    const myQnetAddress = wallet?.qnetAddress || wallet?.address;
    const toSelf = txDirection(myQnetAddress, sendAddress, myQnetAddress) === 'self';

    // QRC-20 gas is paid in QNC (separate balance), NOT in the token itself: a token send needs `amount` of
    // the token here and its fee in QNC (checked below, once the call is sized); native QNC needs amount + fee.
    const isTokenSend = sendingToken.network === 'qnet' && !!sendingToken.contract;
    let tokenAmountBase = null;
    if (isTokenSend) {
      // The amount signed is scaled by the token's decimals: only the ones recorded when the user added the token,
      // never a holdings answer's, which no proof covers (MOBNET-R3-05). A token not added, or whose decimals on this
      // row differ from the record, is refused before anything is signed.
      const recorded = (customTokens || []).find((c) => (c.contract_address || c.contract) === sendingToken.contract);
      if (!recorded || Number(recorded.decimals) !== Number(sendingToken.decimals)) {
        refuse(t('send_token_unrecorded'));
        return;
      }
      try {
        tokenAmountBase = walletManager.toBaseUnits(sendAmount, sendingToken.decimals || 0);
      } catch (e) {
        // More decimals than the token has is said as such (L-9); anything else is not an amount.
        refuse(e && e.code === 'AMOUNT_DECIMALS' ? t('err_AMOUNT_DECIMALS', e.params) : t('send_invalid_amount'));
        return;
      }
    }

    // A QNet recipient is a checksummed EON address, the only kind a key controls (MOBNET-R4-01): 64 hex (a token
    // contract, a transaction id, a mistyped hex value) is refused here, as sendQNC and qrc20Transfer refuse it again
    // before anything is signed.
    if (sendingToken.network === 'qnet') {
      let recipientOk = false;
      try { recipientOk = !!WalletManager.recipientAddress(sendAddress); } catch (_) { recipientOk = false; }
      if (!recipientOk) {
        refuse(t('send_invalid_address'));
        return;
      }
    }

    // What the checks below need, read at once: the QNC balance, a token send's token balance, what the recipient is,
    // and this wallet's kept transactions and past recipients (on the device). The QNC is read now at a genesis node's
    // live tip, not taken from the figure on screen (MOBNET-R3-04), which can predate a spend made in the browser or on
    // another device: a payment the chain would refuse must not become a kept transaction that goes out after a later
    // top-up. No figure to be had refuses the send. The token balance likewise, never the holdings row on screen.
    const isQnetSend = sendingToken.network === 'qnet';
    const senderQnet = wallet.qnetAddress || wallet.address;
    const [qncCheck, held, recipientProblem, keptNow, sentTo] = await Promise.all([
      isQnetSend ? freshQncNano() : null,
      isTokenSend ? walletManager.checkedTokenBalance(sendingToken.contract, myQnetAddress, sendingToken.decimals).catch(() => null) : null,
      isQnetSend ? walletManager.payableRecipientProblem(sendAddress, myQnetAddress).catch(() => 'unchecked') : null,
      isQnetSend ? walletManager.pendingTransactions(senderQnet).then((l) => (Array.isArray(l) ? l : []), () => []) : [],
      isQnetSend ? walletManager.sentRecipients().catch(() => []) : [],
    ]);
    if (!formOpen()) return;
    if (isQnetSend && qncCheck.error) {
      refuse(sendCheckError(qncCheck.error));
      return;
    }
    const qncNano = isQnetSend ? String(qncCheck.balanceNano) : null;
    const qncNow = qncNano !== null ? Number(qncNano) / 1e9 : null;
    if (isTokenSend) {
      if (!held || !held.ok || !/^\d+$/.test(String(held.balanceBase))) {
        refuse(sendCheckError(held && held.error));
        return;
      }
      if (BigInt(tokenAmountBase) > BigInt(held.balanceBase)) {
        refuse(t('send_insufficient_token', {
          need: shownAmount(amount, sendingToken.symbol, balancesHidden),
          balance: shownAmount(held.balance, sendingToken.symbol, balancesHidden),
        }));
        return;
      }
    } else {
      // amount + fee in whole nanoQNC, as the chain debits it
      const needNano = Math.round(amount * 1e9) + TRANSFER_FEE_NANO;
      const haveQnc = sendingToken.symbol === 'QNC' && qncNow !== null ? qncNow : sendingToken.balance;
      if (needNano > Math.round(haveQnc * 1e9)) {
        refuse(t('send_insufficient_qnc', {
          need: shownAmount((needNano / 1e9).toFixed(6), sendingToken.symbol, balancesHidden),
          fee: shownAmount(TRANSFER_FEE_QNC, 'QNC', balancesHidden),
          balance: shownAmount(haveQnc.toFixed(6), sendingToken.symbol, balancesHidden),
        }));
        return;
      }
    }

    // A recipient that is a contract (a built-in token, the token being sent included, a WASM contract) keeps what it is
    // paid for good: no contract sends QNC or a token on. Decided by what two genesis nodes report at once, the certified
    // leaf confirming it in the background (payableRecipientProblem). Refused before the review (read above, with the
    // balance) and read again just before signing, as the extension's confirm does; a recipient no two genesis nodes
    // agree on is not paid either (MOB-BR-R3-01).
    const recipientRefused = async (known) => {
      if (sendingToken.network !== 'qnet') return false;
      const problem = known !== undefined ? known : await walletManager.payableRecipientProblem(sendAddress, myQnetAddress);
      if (!problem) return false;
      refuse(t(problem === 'contract' ? 'send_recipient_contract' : 'send_recipient_unchecked'));
      return true;
    };
    if (await recipientRefused(recipientProblem)) return;

    // This wallet's unconfirmed transactions: the user decides first.
    let pendingChoice = null;
    let spendable = null; // nanoQNC (BigInt) a QNet send may still spend
    if (sendingToken.network === 'qnet') {
      const decision = await decidePendingChoice(senderQnet, keptNow, formOpen);
      if (!decision.proceed) return;
      pendingChoice = decision.choice;
      // What the send may still spend: the balance checked now less what this wallet's unconfirmed transactions may
      // still take (the most each can take, as kept when it was signed), the one a replacement signs over excepted
      // (MB-R2-02), the rule of the in-app browser's sheet (dappProvider spendableNano) and of the extension. A send "in
      // addition" that the earlier ones would leave unpaid is refused before it is signed and kept; for a token send,
      // the tokens they move too.
      const replaceNonce = pendingChoice && pendingChoice.mode === 'replace' ? pendingChoice.nonce : null;
      spendable = afterPending(qncNano, qncCheck.pending, replaceNonce);
      if (isTokenSend) {
        const tokenLeft = afterPending(held.balanceBase, held.pending, replaceNonce);
        if (BigInt(tokenAmountBase) > tokenLeft) {
          const left = walletManager._formatBaseUnits(tokenLeft.toString(), sendingToken.decimals || 0);
          refuse(t('send_insufficient_token', {
            need: shownAmount(amount, sendingToken.symbol, balancesHidden),
            balance: shownAmount(left, sendingToken.symbol, balancesHidden),
          }));
          return;
        }
      }
      const needNow = isTokenSend ? null : BigInt(Math.round(amount * 1e9) + TRANSFER_FEE_NANO);
      if (needNow !== null && spendable < needNow) {
        refuse(t('send_insufficient_qnc', {
          need: shownAmount((Number(needNow) / 1e9).toFixed(6), 'QNC', balancesHidden),
          fee: shownAmount(TRANSFER_FEE_QNC, 'QNC', balancesHidden),
          balance: shownAmount((Number(spendable) / 1e9).toFixed(6), 'QNC', balancesHidden),
        }));
        return;
      }
    }

    // What the send will do, reviewed before anything is asked (MPLAT-R5-01): the whole recipient as it was when Send
    // was tapped (the one signed), the network, the amount, the fee, and the warnings about a recipient this wallet
    // never paid, one that looks like an address it knows, or one that only ever paid it (MOBNET-R2-03).
    let warnings = {};
    if (isQnetSend) {
      const live = keptNow.map((e) => ({ kind: e && e.summary && e.summary.kind, to: e && e.summary && e.summary.to }));
      const context = await recipientContext(senderQnet, sentTo, live).catch(() => ({ counterparties: [], paid: [], senders: [] }));
      warnings = recipientWarnings(sendAddress, senderQnet, context);
    }
    let feeNano = TRANSFER_FEE_NANO;
    if (isTokenSend) {
      try {
        feeNano = walletManager.qrc20TransferFeeNano(sendingToken.contract, sendAddress,
          walletManager.toBaseUnits(sendAmount, sendingToken.decimals || 0));
      } catch (_) { feeNano = null; }
    }
    const feeText = feeNano === null ? '—' : shownAmount(fmtAmount(feeNano / 1e9, 6), 'QNC');
    // The result card's fee row: the fee reviewed, none when it could not be sized.
    const resultFee = feeNano === null ? null : feeText;
    const reviewed = await reviewSend({
      to: sendAddress,
      network: isQnetSend ? CHAIN_NAME : 'Solana',
      amount: shownAmount(sendAmount, sendingToken.symbol),
      fee: feeText,
      // A token's total in two currencies: a line for each (components/InfoRow).
      total: isTokenSend ? [shownAmount(sendAmount, sendingToken.symbol), `+ ${feeText}`]
        : shownAmount(((Math.round(amount * 1e9) + TRANSFER_FEE_NANO) / 1e9).toFixed(6), sendingToken.symbol),
      warnings,
    }, sendingToken.form);
    if (!reviewed) return;

    // Every send asks again who holds the phone, as a site's send in the browser does (MPLAT-R2-01): QNC, QRC-20,
    // SOL and 1DEV alike. On Android that is the system fingerprint or face prompt bound to the vault's key where
    // biometric unlock is set up, else the typed password, whose text the app keeps from accessibility services
    // (SecurityModule, MPLAT-R4-01), with any app that can read the screen named on the prompt; on iOS Face ID /
    // Touch ID / the passcode. The recipient is on that prompt too (MPLAT-R5-01).
    if (!(await confirmFresh(t('send_confirm_reason', { amount: shownAmount(amount, sendingToken.symbol) }), null, sendAddress))) return;
    confirmed = true;

    setSendingTransaction(true);
    try {
      if (await recipientRefused()) return;
      if (isTokenSend) {
        // QRC-20 transfer: scale the human amount by the TOKEN's decimals to u64 base units
        // (BigInt/string math, no float), then call the byte-correct qrc20Transfer SDK. Gas is
        // paid in QNC by the node; the token balance only drops by `amount`.
        const amountBaseUnits = tokenAmountBase; // string, checked against the token balance above
        const decimals = Number(sendingToken.decimals) || 0;
        // The call's fee, and a refundable deposit when the recipient holds none of the token yet, are paid in QNC, out of
        // what the wallet may still spend (MB-R2-02).
        const need = await walletManager.qrc20TransferQncNeedNano(sendingToken.contract, sendAddress, amountBaseUnits);
        const feeQnc = spendable !== null ? Number(spendable) / 1e9 : 0;
        if (spendable === null || BigInt(need.needNano) > spendable) {
          refuse(t(need.depositNano ? 'send_fee_short_deposit' : 'send_fee_short', {
            need: shownAmount((need.needNano / 1e9).toFixed(6), 'QNC', balancesHidden),
            deposit: shownAmount('0.01', 'QNC', balancesHidden),
            balance: shownAmount(fmtAmount(feeQnc, 6), 'QNC', balancesHidden),
          }));
          return;
        }
        const result = await walletManager.qrc20Transfer(
          sendingToken.contract,
          sendAddress,
          amountBaseUnits,
          password,
          { choice: pendingChoice },
        );
        // buildContractCall returns the node's { tx_hash, success, ... } (or throws on non-accept).
        const txHash = result.tx_hash || result.txHash;
        setTxResult({
          success: true,
          title: t('tx_sent_title'),
          txHash,
          amount,
          to: sendAddress,
          counterpartyLabel: t(toSelf ? 'tx_to_self' : 'tx_to'),
          symbol: sendingToken.symbol,
          fee: resultFee,
          onDismiss: goAssetsHome,
        });
        // Same confirmation poll as a native send: the result screen says "waiting" only while it is. The chain settles
        // it by nonce as well, bound to its own transfer event (MOBNET-R3-03).
        let recipient = null;
        try { recipient = WalletManager.canonicalAddress(sendAddress); } catch (_) { recipient = null; }
        const settle = {
          from: senderQnet, nonce: result.submitNonce, kind: 'call', to: sendingToken.contract, method: 'transfer',
          recipient, amountBase: amountBaseUnits,
        };
        if (txHash) startTxConfirmationPolling(txHash, settle);
        // Show the transfer in history immediately as a pending TOKEN row (icon + amount + symbol).
        if (txHash) {
          addPendingTxToHistory(txHash, sendAddress, amount, need.feeNano / 1e9, {
            contract: sendingToken.contract,
            symbol: sendingToken.symbol,
            logo: sendingToken.logo,
            decimals,
            rawBaseUnits: amountBaseUnits,
          }, settle);
        }
        // Optimistic balance update using the TOKEN's decimals (string math): subtract the sent
        // base units from the current base units, then merge back into the Assets list row. A transfer
        // to this same wallet returns them, so its balance is unchanged.
        setQrcTokens((prev) => prev.map((row) => optimisticTokenRow(row, sendingToken.contract, toSelf, amountBaseUnits, decimals, walletManager)));
        return;
      }

      // Get wallet address
      const fromAddress = sendingToken.network === 'qnet'
        ? (wallet.qnetAddress || wallet.address)
        : (wallet.solanaAddress || wallet.address);

      // Call WalletManager to send transaction
      const result = await walletManager.sendTransaction(
        fromAddress,
        sendAddress,
        amount,
        sendingToken.symbol,
        password,
        { choice: pendingChoice },
      );

      if (result.success) {
        const previousBalance = sendingToken.balance;
        // A transfer to this same wallet returns its amount; only the fee actually leaves.
        const leavesNano = toSelf ? 0 : Math.round(amount * 1e9);
        const expectedBalance = sendingToken.symbol === 'QNC'
          ? Math.max(0, Math.round(previousBalance * 1e9) - leavesNano - TRANSFER_FEE_NANO) / 1e9
          : previousBalance;

        // Sent, Pending until the poller finds it in a block (txResultStatus).
        setTxResult({
          success: true,
          title: t('tx_sent_title'),
          txHash: result.txHash,
          amount: amount,
          to: sendAddress,
          counterpartyLabel: t(toSelf ? 'tx_to_self' : 'tx_to'),
          symbol: sendingToken.symbol,
          fee: resultFee,
          note: result.replaced ? t('tx_note_replaced') : undefined,
          onDismiss: goAssetsHome,
        });

        // v3.29: Set pending TX state
        if (sendingToken.symbol === 'QNC') {
          pendingTxRef.current = {
            txHash: result.txHash,
            nonce: Number.isSafeInteger(result.nonce) ? result.nonce : null,
            expectedQnc: expectedBalance,
            previousQnc: previousBalance,
            timestamp: Date.now(),
            status: 'pending'
          };

          // Immediately show expected balance (optimistic update). No proof covers that figure, so the "verified"
          // mark of the previous read goes in the same update (MOBNET-R3-04).
          setBalanceVerified(false);
          setTokenBalances(prev => ({
            ...prev,
            qnc: expectedBalance
          }));

          // v3.30: Add to TX history with pending status
          // Start polling for TX confirmation; the chain settles it by (from, nonce) as well (MOBNET-R3-03).
          const settle = {
            from: result.from, nonce: result.nonce, kind: 'transfer', to: result.to, amountNano: result.amountNano,
          };
          addPendingTxToHistory(result.txHash, sendAddress, amount, TRANSFER_FEE_QNC, null, settle);
          startTxConfirmationPolling(result.txHash, settle);
        }
      } else if (result.unknown) {
        // Nobody answered the submit. The transaction may be in a mempool already, so it is neither
        // sent nor failed until the chain says which — the resolver below asks it, keyed by the nonce.
        setTxResult({
          unknown: true,
          title: t(result.refusal ? 'tx_not_confirmed_title' : 'tx_awaiting_title'),
          amount,
          to: sendAddress,
          counterpartyLabel: t(toSelf ? 'tx_to_self' : 'tx_to'),
          symbol: sendingToken.symbol,
          fee: resultFee,
          note: unknownNote(result),
          onDismiss: goAssetsHome,
        });
        startUnknownOutcomeResolution(result);
      } else {
        // Refused before or by the network — no pending state needed. Nothing signed at all (the unconfirmed
        // transactions changed, or the one to replace went through meanwhile) is not a failed transaction.
        setTxResult({
          success: false, title: t(NOTHING_SENT_CODES.includes(result.code) ? 'send_cannot_title' : 'tx_failed_title'),
          error: sendErrorText(t, { message: result.error, code: result.code }, 'tx_failed'),
        });
      }
    } catch (error) {
      // A token call that went unanswered carries the same unknown outcome; anything else is a refusal.
      if (error && error.unknown) {
        setTxResult({
          unknown: true,
          title: t(error.unknown.refusal ? 'tx_not_confirmed_title' : 'tx_awaiting_title'),
          amount,
          to: sendAddress,
          counterpartyLabel: t(toSelf ? 'tx_to_self' : 'tx_to'),
          symbol: sendingToken.symbol,
          fee: resultFee,
          note: unknownNote(error.unknown),
          onDismiss: goAssetsHome,
        });
        startUnknownOutcomeResolution(error.unknown);
      } else {
        setTxResult({
          success: false, title: t(error && NOTHING_SENT_CODES.includes(error.code) ? 'send_cannot_title' : 'tx_failed_title'),
          error: sendErrorText(t, error, 'tx_failed'),
        });
      }
    } finally {
      setSendingTransaction(false);
    }
  };

  // The Send button: busy from the tap until the send is over (checked, reviewed, refused or sent), and one send at a
  // time on its form, so a second tap reads nothing again; a form opened later is not held by a send left behind.
  const pressSend = async () => {
    const form = sendingToken.form;
    if (sendGuardRef.current === form) return;
    sendGuardRef.current = form;
    setSendChecking(form);
    try {
      await handleSendTransaction();
    } finally {
      if (sendGuardRef.current === form) sendGuardRef.current = false;
      setSendChecking((f) => (f === form ? false : f));
    }
  };

  // A Solana send the network took, or one no endpoint answered (it may still land): listed in History as pending and
  // said so on the result card, which follows the network's answer (useSolanaSends above). Its signature has no page
  // in the QNet explorer, so the card copies it.
  const onSolanaSent = (entry, outcome) => {
    solanaSends.record(entry);
    const owner = wallet && (wallet.solanaAddress || wallet.address);
    setTxResult({
      ...(outcome === 'unknown'
        ? { unknown: true, title: t('tx_awaiting_title'), note: t('tx_note_unknown_solana') }
        : { success: true, title: t('tx_sent_title') }),
      amount: entry.amount,
      symbol: entry.symbol,
      to: entry.to,
      counterpartyLabel: t(entry.to === owner ? 'tx_to_self' : 'tx_to'),
      txHash: entry.signature,
      chain: 'solana',
      solanaSignature: entry.signature,
      onDismiss: goAssetsHome,
    });
    if (wallet && wallet.publicKey) loadBalance(wallet.publicKey);
  };

  // The run of Move to wallet under way (its number: a newer run, another wallet or the screen going ends the one before:
  // endMoveRun), and its wait for the wallet's watermark to show its last part.
  const moveRunRef = useRef(0);
  const transitWaitsRef = useRef(new Set());

  // The moves in transit on screen and in its ref at once: a read in the same tick already sees the change, and so does a
  // move in parts waiting for its last part (moveSettled).
  const applyTransit = (state) => {
    transitRef.current = state;
    setTransit(state);
    transitWaitsRef.current.forEach((check) => check());
  };

  const endMoveRun = () => {
    moveRunRef.current += 1;
    transitWaitsRef.current.forEach((check) => check());
  };
  // What became of the move submitted as `txHash` once the wallet's live or certified watermark ends it (its moveOutcome:
  // 'done', 'partial', 'expired'), or null once `live()` is false, no record names it, or `until` (ms) passed while it is
  // still moving: only the run stops waiting then, the move stays in transit. No clock ends a move (ClaimTransit).
  const moveSettled = (txHash, live, until = null) => new Promise((resolve) => {
    let timer = null;
    const check = () => {
      const o = live() ? moveOutcome(transitRef.current, txHash) : null;
      if (o && o.result === 'moving' && !(Number.isFinite(until) && Date.now() >= until)) return;
      transitWaitsRef.current.delete(check);
      cancelLater(timer);
      resolve(o && o.result !== 'moving' ? o : null);
    };
    transitWaitsRef.current.add(check);
    if (Number.isFinite(until)) timer = later(check, Math.max(0, until - Date.now()));
    check();
  });

  // Every timer the screen owns ends with it, in this one place: a send's follow-up (its hash poll and its settle by
  // nonce, retired by outcomeRunRef too), the reads after Use this device, the one-shot timers (later) and a move in parts.
  useEffect(() => () => {
    outcomeRunRef.current += 1;
    clearTimeout(txPollingRef.current);
    txPollingRef.current = null;
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    stopRereads();
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    endMoveRun();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The moves of a node balance in transit to the wallet on screen (services/ClaimTransit), read when it opens.
  const transitOwner = wallet ? wallet.qnetAddress : null;
  useEffect(() => {
    if (!transitOwner) return undefined;
    let live = true;
    readTransit(transitOwner).then((s) => {
      if (live && currentOwnerRef.current === transitOwner) applyTransit(s);
    }).catch(() => {});
    return () => { live = false; };
  }, [transitOwner]); // eslint-disable-line react-hooks/exhaustive-deps

  // While a move is in transit, or while Assets is in front, the wallet's live figure every LIVE_READ_MS, in front only:
  // its claim watermark ends a move on screen, and on Assets money that came in shows within seconds, unless the
  // address socket is live (its account events ask for the figure: followAccountEvent). A light read of its own,
  // skipped while the balance read of Assets just read one (LIVE_SHARE_MS); the certified read that settles a move's
  // record runs with the follow tick.
  const transitHeld = !!transitOwner && transit.owner === transitOwner && transitTotal(transit) > 0;
  useEffect(() => {
    const owner = wallet && wallet.qnetAddress;
    if (!owner || (activeTab !== 'assets' && !transitHeld)) return undefined;
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active' || (!transitHeld && wsLiveRef.current)) return;
      readLiveFigure(owner, LIVE_READ_MS - LIVE_SHARE_MS);
    }, LIVE_READ_MS);
    return () => clearInterval(timer);
  }, [transitHeld, wallet, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // A move the network took (the Node tab's card, or a QNet Link claim sheet), in transit until the wallet's live figure
  // shows it through (owner, 11.10 and 18.10), and followed to that end at once (followMove). `balanceNano`: the node
  // balance it was made from, whose rest the tab shows meanwhile.
  const recordMove = (nodeId, result, balanceNano) => {
    const owner = currentOwnerRef.current;
    const move = owner ? transitRecord({ nodeId, result, balanceNano }) : null;
    if (!move) return false;
    const cur = transitRef.current;
    const next = addMove(cur && cur.owner === owner ? cur : emptyTransit(owner), move);
    applyTransit(next);
    writeTransit(next);
    followMove(move.txHash);
    return true;
  };

  // A move's claim transaction followed by its hash on the genesis nodes, as a send's is (from 2 s, growing by half up
  // to 15 s, for three minutes): once a block holds it, its History row shows it and the wallet's live figure is read,
  // whose watermark says it went through, in whole or in part (noteLiveTransit). Until then, and after, the live read of
  // a move in transit goes on (LIVE_READ_MS).
  // One follow at a time: a newer one, or the screen going, ends the one before (its run is no longer the current one).
  const moveFollowRef = useRef({ timer: null, run: 0 });
  useEffect(() => {
    const follow = moveFollowRef.current;
    follow.run = Math.max(0, follow.run);
    return () => {
      clearTimeout(follow.timer);
      follow.run = -1;
    };
  }, []);
  const followMove = (txHash) => {
    const owner = currentOwnerRef.current;
    const follow = moveFollowRef.current;
    if (!owner || !txHash || follow.run < 0) return;
    clearTimeout(follow.timer);
    const run = ++follow.run;
    const nodes = walletManager.getTrustedNodes(5);
    const deadline = Date.now() + 180000;
    let attempts = 0;
    const moving = () => {
      const o = moveOutcome(transitRef.current, txHash);
      return follow.run === run && currentOwnerRef.current === owner && !!o && o.result === 'moving';
    };
    const tick = async () => {
      if (!moving() || nodes.length === 0) return;
      attempts += 1;
      const at = await blockOfTx(nodes[(attempts - 1) % nodes.length], txHash);
      if (at !== null && follow.run === run) {
        setTxHistory((prev) => markInBlock(prev, txHash, at));
        // Its result card, if still open, names that block.
        setTxResult((prev) => (prev && prev.txHash === txHash ? { ...prev, block: at } : prev));
        await readLiveFigure(owner);
      }
      if (!moving() || Date.now() >= deadline) return;
      follow.timer = setTimeout(tick, Math.min(2000 * Math.pow(1.5, attempts - 1), 15000));
    };
    follow.timer = setTimeout(tick, 2000);
  };

  // The watermark every node balance read is judged by (ClaimTransit.answerFloor: the wallet's last certified claim
  // watermark, tightened by its live one while a move that one ended waits for its certified settle); null for another
  // wallet, or while none is known.
  const claimFloor = (owner) => {
    const cur = transitRef.current;
    return cur && cur.owner === owner ? answerFloor(cur) : null;
  };

  // What a certified read tells of the moves in transit, in the background: `lastClaimedEpoch` the wallet's claim
  // watermark in a state the committee certified (null: the read certified none), `blockHeight` that state's height. A
  // move seen through, in whole or in part, or expired by its last height, leaves the record and the watermark becomes the
  // wallet's durable floor (ClaimTransit.settleMoves: no clock ends a move). One the live
  // watermark showed through already changes nothing more on screen; a lower watermark of the live figure's height or
  // later puts what that figure ended back in transit.
  const settleTransit = (owner, lastClaimedEpoch, blockHeight = null) => {
    const cur = transitRef.current;
    if (!owner || !cur || cur.owner !== owner) return;
    const { state, settled } = settleMoves(cur, { lastClaimedEpoch, blockHeight });
    if (state !== cur) {
      applyTransit(state);
      writeTransit(state);
    }
    const shown = settled.filter((x) => !x.liveSeen);
    if (shown.length > 0) afterSettled(owner, shown);
  };

  // What the claim watermark of the wallet's live figure (of block `height`) tells of the moves in transit
  // (ClaimTransit.noteLiveWatermark): one it shows through, in whole or in part, ends on screen at once; its record stays
  // until a certified read settles it. The live watermark is held in memory only, so nothing is written.
  const noteLiveTransit = (owner, lastClaimedEpoch, height) => {
    const cur = transitRef.current;
    if (!owner || !cur || cur.owner !== owner) return;
    const { state, settled } = noteLiveWatermark(cur, lastClaimedEpoch, height);
    if (state === cur) return;
    applyTransit(state);
    if (settled.length > 0) afterSettled(owner, settled);
  };

  // A move that left: the node balance (the wallet's, on whichever card shows it) is the rest the move left plus the part
  // the network did not apply, until it is read again at once, with no epoch lock.
  const afterSettled = (owner, settled) => {
    let shown = null;
    for (const { move, returnedNano } of settled) {
      if (move.restNano !== null && move.restNano !== undefined) shown = move.restNano + (returnedNano || 0);
    }
    if (currentOwnerRef.current !== owner) return;
    if (shown !== null) {
      setLightBalance(shown);
      const kept = serverRewardsRef.current;
      if (kept) serverRewardsRef.current = { ...kept, value: shown };
      setServerNodeStatus((prev) => (prev && prev.success ? { ...prev, pendingRewards: shown } : prev));
    }
    lightBalanceReadRef.current = null;
    if (lightShownRef.current) loadLightBalance(walletManager.generateLightNodePseudonym(owner), owner, { force: true }).catch(() => {});
    loadServerNodeStatus({ rewards: true }).catch(() => {});
  };

  // One run of Move to wallet (services/MoveRun), the Node tab's and a QNet Link claim sheet's alike, each part in transit
  // (recordMove): null for an empty balance or while a move runs or is in transit (the ref at once: a second press starts
  // nothing; the balance is the wallet's). Resolves the run with `runId`; throws the first part's error.
  const startMove = async ({ nodeType, nodeId, balanceNano, until = null, onPart = () => {} }) => {
    if (!(balanceNano > 0) || movingRef.current || transitTotal(transitRef.current) > 0) return null;
    movingRef.current = true;
    const runId = ++moveRunRef.current;
    const owner = currentOwnerRef.current;
    const live = () => moveRunRef.current === runId && currentOwnerRef.current === owner;
    setProcessingValidation(true);
    try {
      const walletAddress = await getWalletAddressForClaim();
      const run = await runMove({
        walletManager,
        // The next part signs with the session open now.
        credential: () => credentialRef.current,
        // A part the network took is the wallet's move in transit even when the screen went meanwhile.
        record: (id, result, restNano) => currentOwnerRef.current === owner && recordMove(id, result, restNano),
        settled: (txHash, at) => moveSettled(txHash, live, at),
        pause: (ms) => new Promise((resolve) => { later(resolve, ms); }),
        live,
        signing: setClaimSigning,
        onPart: (view) => onPart({ ...view, runId }),
        now: Date.now,
      }, { nodeType, nodeId, walletAddress, balanceNano, until });
      return { ...run, runId };
    } finally {
      setProcessingValidation(false);
    }
  };

  // Move to wallet on the Node tab: the run, and one card that says it as it happens (txResultNote).
  const moveNodeBalance = async ({ nodeType, nodeId, balanceNano, reload }) => {
    const onDismiss = () => {
      reload();
      if (wallet && wallet.publicKey) loadBalance(wallet.publicKey);
    };
    // The run's card: up with the first part, kept current while on screen (Done or a tab takes it away, the run goes
    // on), up again when the run ends short (a part not sent, or not taken in whole) while no other card is. Its amount
    // and hash come from the parts' records (txResultShown); `amount` is what they submitted, exact to the nano.
    const card = (view, stop) => {
      const last = view.parts[view.parts.length - 1];
      const parts = view.parts.slice();
      return {
        success: true, title: t('claim_submitted_title'), amount: formatNano(view.movedNano.toString()), symbol: 'QNC', move: true,
        // a run that left nothing to quote speaks of no stop
        stoppedAtEpoch: view.whole ? null : last.stoppedAtEpoch, txHash: last.txHash, runId: view.runId, parts,
        run: parts.length > 1 || view.more || stop ? { parts, more: view.more, stop } : null, onDismiss,
      };
    };
    const showRun = (view, stop = null, short = !!stop && !stop.ended) => setTxResult((prev) => (
      (prev && prev.runId === view.runId) || (short && !prev) ? card(view, stop) : prev));
    try {
      const run = await startMove({
        nodeType, nodeId, balanceNano,
        onPart: (view) => (view.parts.length === 1 ? setTxResult(card(view, null)) : showRun(view)),
      });
      if (!run) return;
      if (run.refused) {
        // Nothing was submitted here — the node refused the claim, so it is not a failed transaction.
        setTxResult({ success: false, title: t('claim_cannot_title'), error: claimErrorText(run.refused) });
        return;
      }
      if (run.live && run.parts.length > 0) {
        showRun({ ...run, more: false }, run.stop, run.settled !== null || (!!run.stop && !run.stop.ended));
      }
    } catch (error) {
      // An unanswered claim is unknown, not failed: a re-quote after it lands simply skips the epochs
      // it already paid, so the amount can never be collected twice.
      if (error && error.unknown) {
        setTxResult({
          unknown: true,
          title: t('tx_awaiting_title'),
          symbol: 'QNC',
          note: t('claim_note_unknown'),
          onDismiss,
        });
      } else {
        setTxResult({ success: false, title: t('claim_failed_title'), error: claimErrorText(error) });
      }
    }
  };
  // A server node: the one the genesis nodes name for the wallet (walletNode), whose card shows the balance.
  const handleClaimServerNodeRewards = () => {
    const node = serverNodeOf(walletNodeRef.current, currentOwnerRef.current);
    if (!node) return undefined;
    return moveNodeBalance({
      nodeType: node.nodeType,
      nodeId: node.nodeId,
      balanceNano: serverNodeStatus?.pendingRewards || 0,
      reload: () => loadServerNodeStatus({ rewards: true }),
    });
  };
  const handleMoveLightBalance = () => moveNodeBalance({
    nodeType: 'light',
    nodeId: lightNodeStatus && lightNodeStatus.nodeId,
    balanceNano: lightBalance || 0,
    reload: () => loadLightNodeStatus({ rewards: true }),
  });

  tRef.current = t;
  // Code outside this screen (native prompt titles, the crash screen) speaks the same language.
  useEffect(() => {
    setCurrentLanguage(language);
    setNativeTexts({ authReason: t('auth_default_reason'), obscuredTouch: t('native_obscured_touch') });
  }, [language]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSettings = async () => {
    try {
      const [savedAutoLockTime, lang] = await Promise.all([AsyncStorage.getItem('qnet_autolock_time'), savedLanguage()]);

      // A value outside the choices (the old 60) falls back to the default.
      setAutoLockTime(AUTO_LOCK_CHOICES.includes(savedAutoLockTime) ? savedAutoLockTime : DEFAULT_AUTO_LOCK);
      setLanguage(lang);
      // Every send confirms now (MPLAT-R2-01): the old large-send threshold setting has no use.
      AsyncStorage.removeItem('qnet_send_confirm_qnc').catch(() => {});
    } catch (error) {
      // Silent fail - use defaults
    }
  };

  // A security setting. A longer time takes a fresh check of whoever holds the device (the password, MVA-R2-07); under
  // the screen lock any change takes a fresh device authentication.
  const saveAutoLockTime = async (time) => {
    if (!AUTO_LOCK_CHOICES.includes(time)) return;
    const relaxing = autoLockRank(time) > autoLockRank(autoLockTime);
    if (time !== autoLockTime && (deviceAuth || relaxing)) {
      setShowAutoLockPicker(false);
      if (!(await confirmFresh(t('auth_change_autolock')))) return;
    }
    try {
      await AsyncStorage.setItem('qnet_autolock_time', time);
      setAutoLockTime(time);
      setShowAutoLockPicker(false);
    } catch (error) {
      showAlert(t('error'), t('err_save_setting'));
    }
  };

  // A fresh check of whoever holds the device: the device's screen lock with no reuse (a wallet under the screen lock),
  // or the wallet password, counted by the lockout. Resolves true or false; locking the wallet answers false.
  // A wallet under the screen lock on a device whose screen lock is now off: nothing can confirm who holds it, and the
  // vault secret cannot be read again either, so every caller here (sends, a site's approval, a security setting) is
  // refused and the open session locks (MVA-R3-04). Only Delete and Erase, where the vault may already be
  // unopenable, accept that answer, each with its own rule.
  // `owner`: whoever asked (a QNet Link request's key), so that a prompt is closed with the screen that opened it and a
  // password is never typed for a request that is gone (R4-MOBLINK-01). While a QNet Link request is on screen, a prompt
  // of anyone else is refused rather than opened over it (MOBLINK-R5-01).
  // `recipient`: where a send goes. It is on the prompt itself, the system's biometric prompt included, so a recipient
  // swapped after the review is seen where the send is approved (MPLAT-R5-01).
  const confirmFresh = async (reason, owner = null, recipient = null) => {
    const foreign = () => !!linkRequestRef.current && owner !== `link:${linkRequestRef.current.key}`;
    if (foreign()) return false;
    const detail = recipient ? t('fresh_to', { to: groupAddress(recipient) }) : '';
    if (deviceAuth) {
      // The screen lock that kept the vault secret was removed, maybe set again since: no prompt can confirm anyone for
      // this wallet any more, and the open session is its one way back (MA-1).
      if ((await walletManager.deviceAuthSecretState().catch(() => 'present')) === 'gone') {
        deviceSecretGone();
        return false;
      }
      // What is approved goes where the system draws it in full: the recipient in the prompt's description, and the apps
      // that can read the screen in its subtitle, as for a password wallet (MPLAT-R5-01). The title is one line.
      const lockReadersNow = await screenReaderApps();
      const readersNote = lockReadersNow.length > 0 ? t('readers_confirm_note', { apps: lockReadersNow.join(', ') }) : '';
      const auth = await deviceAuthenticate(reason, { subtitle: readersNote, description: detail });
      if (auth.ok && foreign()) return false;
      if (auth.ok) return true;
      if (auth.code === 'not_set') deviceSecretGone();
      // A prompt that failed (not one the user cancelled) says so: a confirmation never ends in nothing.
      else if (auth.code !== 'cancelled') showAlert(t('error'), t('device_unlock_unavailable'));
      return false;
    }
    // A password wallet (MPLAT-R4-01): the apps that can read the screen and act in other apps are named every time, on
    // the prompt itself; where biometric unlock is set up (Android), the system's CryptoObject-bound fingerprint or face
    // prompt confirms (no accessibility service can see or pass it; a face match still needs a press on it,
    // MVA-R5-02), and the typed password is only the fallback.
    const readers = await screenReaderApps();
    const note = readers.length > 0 ? t('readers_confirm_note', { apps: readers.join(', ') }) : '';
    if (biometricEnabled) {
      const bio = await walletManager.confirmWithBiometrics(reason, note, detail).catch(() => ({ ok: false, fallback: true }));
      if (bio.ok) return !foreign();
      if (!bio.fallback) return false;
    }
    if (foreign()) return false;
    if (freshResolveRef.current) freshResolveRef.current(false);
    return new Promise((resolve) => {
      freshResolveRef.current = resolve;
      freshOwnerRef.current = owner;
      setFreshPassword('');
      setFreshPrompt({ reason, note, recipient: recipient ? groupAddress(recipient) : null });
    });
  };

  // The review of a send (MPLAT-R5-01): everything the send will do, the full recipient first, with its warnings,
  // armed only after it stayed on screen untouched (utils/useArmedConfirm). Resolves true on Confirm, false otherwise.
  // `form` is the Send form the send began on (sendingToken.form): once that form has closed, nothing is asked.
  const reviewSend = (review, form) => {
    if (!sendFormOpen(form)) return Promise.resolve(false);
    if (sendReviewResolveRef.current) sendReviewResolveRef.current(false);
    return new Promise((resolve) => {
      sendReviewResolveRef.current = resolve;
      setSendReview(review);
    });
  };

  const resolveSendReview = (ok) => {
    const resolve = sendReviewResolveRef.current;
    sendReviewResolveRef.current = null;
    setSendReview(null);
    if (resolve) resolve(ok);
  };

  /**
   * A wallet under the screen lock whose secret is gone while it is open (MA-1): removing the screen lock deleted the
   * secret for good, so the wallet cannot open again once it locks. Its open session still holds the data key: the one
   * chance to protect it again, with a new wallet password or, where the screen lock is on again, with the screen lock.
   * Declined, the wallet locks and says the truth: only its recovery phrase opens it now.
   */
  const deviceSecretGone = async () => {
    const token = password;
    if (!wallet || !WalletManager.isSessionToken(token)) return;
    const lockAgain = await walletManager.deviceAuthAvailable().catch(() => false);
    showAlert(t('auth_secret_gone_title'), t('auth_secret_gone_open_body'), [
      { text: t('reprotect_later'), style: 'cancel', onPress: () => {
        lockSession();
        // A screen lock set again brings nothing back, and the text says so rather than that none is set (MA-1).
        if (lockAgain) showAlert(t('auth_secret_gone_title'), t('auth_secret_gone_locked_body'));
        else showAlert(t('auth_passcode_off_title'), t('auth_passcode_off_body'));
      } },
      ...(lockAgain ? [{ text: t('device_unlock_offer_yes'), onPress: () => { reprotectWithScreenLock(token); } }] : []),
      { text: t('reprotect_password'), onPress: () => {
        setNewPassword('');
        setConfirmNewPassword('');
        setShowChangePassword('reprotect');
      } },
    ]);
  };

  const reprotectWithScreenLock = async (token) => {
    let r;
    try {
      r = await walletManager.reprotectWithDeviceAuth(token, t('auth_device_unlock'));
    } catch (error) {
      if (!handleVaultError(error)) showAlert(t('error'), errorText(t, error, 'device_unlock_unavailable'));
      return;
    }
    if (r.ok) showAlert('', t('device_unlock_on'));
    else if (r.unavailable) showAlert(t('error'), t('device_unlock_unavailable'));
    else deviceSecretGone(); // refused: the offer stands while the wallet is open
  };

  // The new password of a wallet whose screen-lock secret is gone (deviceSecretGone).
  const handleReprotectPassword = async () => {
    if (!newPassword || newPassword.length < MIN_PASSWORD) {
      showAlert(t('error'), t('pw_new_too_short', { min: MIN_PASSWORD }));
      return;
    }
    if (newPassword !== confirmNewPassword) {
      showAlert(t('error'), t('pw_new_mismatch'));
      return;
    }
    setLoading(true);
    try {
      await walletManager.reprotectWithPassword(password, newPassword);
    } catch (error) {
      setLoading(false);
      if (!handleVaultError(error)) showAlert(t('error'), errorText(t, error, 'err_change_password'));
      return;
    }
    setLoading(false);
    setShowChangePassword(false);
    setNewPassword('');
    setConfirmNewPassword('');
    setWalletDeviceAuth(false);
    setBiometricEnabled(false);
    walletManager.hardwareSealState().then(setHwSeal).catch(() => setHwSeal(null));
    showAlert(t('success'), t('reprotect_password_done'));
  };

  const resolveFresh = (ok) => {
    const resolve = freshResolveRef.current;
    freshResolveRef.current = null;
    freshOwnerRef.current = null;
    setFreshPrompt(null);
    setFreshPassword('');
    if (resolve) resolve(ok);
  };

  // Closes the fresh prompt when `owner` opened it; a prompt another flow opened meanwhile stays.
  const dropFreshOf = (owner) => {
    if (owner !== null && freshOwnerRef.current === owner) resolveFresh(false);
  };

  const submitFresh = async () => {
    const r = await walletManager.checkPassword(freshPassword);
    if (!r.ok) {
      resolveFresh(false);
      refusePassword(r);
      return;
    }
    resolveFresh(true);
  };

  /**
   * The one way the wallet locks — auto-lock, Lock Wallet, return from the background after the grace time.
   * The session key goes, and so does everything on screen that came from it or could reveal a secret:
   * alerts, the revealed phrase, password fields, open security dialogs, an unsaved new wallet.
   */
  const lockSession = () => {
    // The field that has the focus lets go of it first: the screen holding it goes, and Android would otherwise hand
    // the focus (and the keyboard) to the next field on screen, the lock screen's password. Nothing is focused by itself.
    Keyboard.dismiss();
    walletManager.closeSession();
    // The lock screen comes back plain: under the screen lock the system prompt opens by itself (autoUnlockRef).
    setUnlockPrompting(true);
    setWallet(null);
    setPassword('');
    setConfirmPassword('');
    setCustomAlert(null);
    setSeedReveal(null);
    setTempWallet(null);
    setShowSeedConfirm(false);
    setSeedConfirmWords({});
    setWordChoices({});
    setShowCreateOptions(false);
    forgetImportPhrase();
    setExportPassword('');
    setShowExportSeed(false);
    closeKeyReveal();
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setShowChangePassword(false);
    setBiometricPassword('');
    setShowBiometricPasswordPrompt(false);
    setShowDeletePrompt(false);
    setDeletePassword('');
    setShowEraseConfirm(false);
    setEraseText('');
    setShowAutoLockPicker(false);
    setTxDetail(null);
    resolveFresh(false);
    resolveSendReview(false);
    setShowHeaderMenu(false);
    setSendPicker(null);
    setShowScan(false); // the camera never comes back by itself after an unlock
    setActiveTab('assets');
    // The browser stays under the lock screen; its open request ends (4100) and so does its sheet.
    setDappSheet(null);
    setConnectedSites(null);
    // A link request stays until the user closes it or, once decided, the next link comes: an undecided one waits for
    // the next unlock, and one the user decided comes back with its outcome (or with the work still under way, until the
    // outcome arrives), so what its screen had to say is never lost with a lock.
  };

  // 'never' leaves an open wallet with no grace time at all; the onboarding screens that hold a phrase keep the default.
  const graceMs = () => (autoLockTime === 'never'
    ? (wallet ? Infinity : parseInt(DEFAULT_AUTO_LOCK, 10) * 60 * 1000)
    : (parseInt(autoLockTime, 10) || parseInt(DEFAULT_AUTO_LOCK, 10)) * 60 * 1000);
  // Past the grace time, or a clock that went backwards; with no grace time nothing is ever due.
  const overdue = (elapsed) => {
    const grace = graceMs();
    return grace !== Infinity && (elapsed < 0 || elapsed >= grace);
  };

  // Something secret the onboarding screens hold: a phrase typed or pasted for import, or a new wallet whose phrase
  // is on screen. They lock with the wallet (lockSession) exactly like an open session.
  const onboardingSecretRef = useRef(false);
  onboardingSecretRef.current = !!tempWallet || seedPhrase.length > 0;

  // True when the app comes back from the background after the grace time. Wall-clock time alone can be set
  // back by whoever holds the phone, so the time away is also measured on the boot clock, which counts in sleep
  // and cannot be set: either one reaching the grace time (or going backwards) locks. (MS1-04)
  const lockIsDue = () => {
    const since = backgroundedAtRef.current;
    if (!since) return false;
    return overdue(Date.now() - since.wall);
  };
  const monoLockIsDue = async () => {
    const since = backgroundedAtRef.current;
    if (!since || since.mono === null) return false;
    const now = await bootClock();
    return overdue(now.mono - since.mono);
  };

  // Lock on return from the background: the time away is checked the moment the app is active again, before
  // any refresh runs (the foreground refresh makes the same two checks). Leaving the app also hides a revealed
  // phrase at once, and a recovery phrase typed for import never outlives it (MS1-02).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        const mark = { wall: Date.now(), mono: null };
        backgroundedAtRef.current = mark;
        bootClock().then((c) => { mark.mono = c.mono; }).catch(() => {});
        setSeedReveal(null);
        closeKeyReveal();
        forgetImportPhrase({ leaving: true });
      } else if (next === 'inactive') {
        setSeedReveal(null);
        closeKeyReveal();
      } else if (next === 'active') {
        const holdsSecret = () => !!wallet || onboardingSecretRef.current;
        if (lockIsDue() && holdsSecret()) {
          lockSession();
          setTimeout(() => { backgroundedAtRef.current = 0; }, 0); // after the other listeners of this change read it
        } else {
          monoLockIsDue().catch(() => false)
            .then((due) => {
              if (due && holdsSecret()) { lockSession(); return; }
              // Still open, under the screen lock: a screen lock removed meanwhile (maybe set again) took the vault
              // secret with it, and this is the moment the wallet can still be protected again (MA-1).
              if (wallet && walletDeviceAuth) {
                walletManager.deviceAuthSecretState()
                  .then((s) => { if (s === 'gone') deviceSecretGone(); })
                  .catch(() => {});
              }
            })
            .finally(() => { backgroundedAtRef.current = 0; });
        }
      }
    });
    return () => sub.remove();
  }, [wallet, tempWallet, autoLockTime, walletDeviceAuth, password]); // eslint-disable-line react-hooks/exhaustive-deps

  // The restart a new layout direction takes: the app's JS starts again as at a cold start, so the wallet locks.
  const restartForLayout = () => {
    reloadApp().then((started) => { if (!started) logger.warn('[WARN][I18N] layout restart unavailable'); });
  };

  // A language of the other direction turns the layout once the app's JS starts again (Settings offers the restart).
  const saveLanguage = async (lang) => {
    try {
      await AsyncStorage.setItem(LANGUAGE_KEY, lang);
      applyLayoutDirection(lang);
      setLanguage(lang);
    } catch (error) {
      showAlert(t('error'), t('err_save_language'));
    }
  };

  // Auto-lock timer: an open wallet, and the onboarding screens while they hold a phrase (a new wallet's, or one
  // typed for import), lock after the grace time without a touch. Inactivity is measured on the wall clock and on
  // the boot clock, which cannot be set back; either one reaching the grace time locks.
  const onboardingSecret = !!tempWallet || seedPhrase.length > 0;
  useEffect(() => {
    if ((wallet && hasWallet) || onboardingSecret) {
      // Local refs, not state: a setState per touch would re-render the whole screen.
      const last = { wall: Date.now(), mono: null };
      const mark = () => {
        const at = { wall: Date.now(), mono: null };
        last.wall = at.wall;
        bootClock().then((c) => { if (last.wall === at.wall) last.mono = c.mono; }).catch(() => {});
      };
      mark();
      const subscription = DeviceEventEmitter.addListener('userActivity', mark);

      // Node type and code stay on screen state; everything secret goes.
      const checkAutoLock = setInterval(() => {
        if (overdue(Date.now() - last.wall)) { lockSession(); return; }
        if (last.mono === null) return;
        const since = last.mono;
        bootClock().then((c) => {
          if (since === last.mono && overdue(c.mono - since)) lockSession();
        }).catch(() => {});
      }, 10000); // Check every 10 seconds

      return () => {
        clearInterval(checkAutoLock);
        subscription?.remove();
      };
    }
    return undefined;
  }, [wallet, hasWallet, autoLockTime, onboardingSecret]); // eslint-disable-line react-hooks/exhaustive-deps

  // The foreground follow (wallet-galc plan 2.4): while a wallet is open and the app in front, one
  // WalletManager.followTick every FOLLOW_MS (the certified head, one walk step toward it, the open wallet's QNC proof,
  // the anchors and the capsule kept), on every tab, in the background. Its progress note, the height its certified
  // read covers and the record of a move in transit it settles follow (noteWalk, noteCovered, settleTransit). Locked,
  // there is no wallet here and no session there: nothing runs.
  useEffect(() => {
    const owner = wallet && wallet.qnetAddress;
    if (!owner) return undefined;
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active' || (currentOwnerRef.current && currentOwnerRef.current !== owner)) return;
      Promise.resolve().then(() => walletManager.followTick(owner)).then((r) => {
        if (!r || !r.ok || (currentOwnerRef.current && currentOwnerRef.current !== owner)) return;
        noteWalk(owner, r.verified);
        if (r.verified && r.balance) {
          noteCovered(owner, Number(r.balance.blockHeight));
          settleTransit(owner, r.balance.lastClaimedEpoch, Number(r.balance.blockHeight));
        }
      }).catch(() => {});
    }, FOLLOW_MS);
    return () => clearInterval(timer);
  }, [wallet?.qnetAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Assets tab reads the balances on opening, then every ASSETS_POLL_MS, beside the live figure every LIVE_READ_MS;
  // while the address socket is live, every SOCKET_LIVE_POLL_MS and no LIVE_READ_MS read (requestPace pollMs); nothing
  // while the app is not in front.
  useEffect(() => {
    if (wallet && wallet.publicKey && activeTab === 'assets') {
      loadBalance(wallet.publicKey);
      let balanceTimer = null;
      const next = () => {
        balanceTimer = setTimeout(() => {
          if (AppState.currentState === 'active') loadBalance(wallet.publicKey);
          next();
        }, pollMs(ASSETS_POLL_MS, wsLiveRef.current));
      };
      next();

      // A send's follow-up goes on whichever tab is open; it ends by itself or with the screen (the unmount cleanup).
      return () => clearTimeout(balanceTimer);
    }
  }, [wallet, selectedNetwork, activeTab]); // Reload on any network or tab change

  // A kept transaction the wallet still sends by itself goes out again whatever tab is open, while the app is in front
  // (MB-R2-01): a site's send from the in-app browser has no result card that follows it, and the Assets tab's refresh
  // (which runs the same sweep) does not run behind the browser. Nothing is read while nothing is left to send.
  useEffect(() => {
    const address = wallet && wallet.qnetAddress;
    if (!address || !appActive || activeTab === 'assets') return undefined;
    let live = true;
    const sweep = async () => {
      try {
        const kept = await walletManager.pendingTransactions(address);
        if (live && kept.some((e) => autoSendable(e))) await sendKeptDue(address);
      } catch (_) { /* the next sweep tries again */ }
    };
    const timer = setInterval(sweep, KEPT_SWEEP_MS);
    return () => { live = false; clearInterval(timer); };
  }, [wallet, appActive, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // The History tab: everything on opening (the explorer too), then one genesis node's newest rows every
  // HISTORY_POLL_MS, every SOCKET_LIVE_POLL_MS while the address socket is live (requestPace pollMs); nothing while the
  // app is not in front.
  useEffect(() => {
    if (wallet?.qnetAddress && activeTab === 'history') {
      loadTxHistory(true);
      let historyTimer = null;
      const next = () => {
        historyTimer = setTimeout(() => {
          if (AppState.currentState === 'active') loadTxHistory();
          next();
        }, pollMs(HISTORY_POLL_MS, wsLiveRef.current));
      };
      next();
      return () => clearTimeout(historyTimer);
    }
  }, [wallet, activeTab]);

  // The wallet's node as this device last knew it, shown at once when the wallet opens until the genesis nodes answer:
  // the wallet's record (WalletManager.loadWalletNode), with the last good status of a server node, however old (the
  // card marks it stale once a read does not name the node). Local only: no network, no seed phrase.
  const restoreNodeState = async (w) => {
    if (!w || !w.qnetAddress) return;
    try {
      await walletManager.cleanupActivationStorage();
      const rec = await walletManager.loadWalletNode(w.qnetAddress);
      const shown = walletNodeRef.current;
      if (!rec || currentOwnerRef.current !== rec.owner || (shown && shown.owner === rec.owner)) return;
      setWalletNode({ owner: rec.owner, nodeId: rec.nodeId, nodeType: rec.nodeType, stored: true });
      if (rec.status && serverNodeOf(walletNodeRef.current, rec.owner)) setServerNodeStatus((prev) => prev || rec.status);
      if (activeTabRef.current === 'node') loadServerNodeStatus();
    } catch (_) { /* keep what is on screen */ }
  };

  useEffect(() => {
    if (!wallet || !wallet.address || !password) return;
    restoreNodeState(wallet);
  }, [wallet, password]);

  // Foreground: refresh what is on screen, refresh the push token
  useEffect(() => {
    const handleAppStateChange = async (nextAppState) => {
      if (nextAppState !== 'active' || !wallet || !wallet.publicKey || !password) return;
      // The wallet is locking; nothing runs on its session (wall clock now, boot clock a moment later).
      if (lockIsDue()) return;
      if (await monoLockIsDue().catch(() => false)) return;
      if (!walletManager.sessionOpen(password)) return;

      // Refresh what is ON SCREEN. Coming back from background (screen unlock included) left the
      //       UI on pre-background state: the node status refreshes every 5 min and the history poll only runs
      //       while the History tab is already open, so an activated node and its transactions both
      //       appeared "missing" for seconds after every unlock. Fire the same loads the tab's own
      //       pull-to-refresh would, without the spinner (the node balances once per epoch).
      try {
        const tab = activeTabRef.current;
        const jobs = [];
        if (tab === 'history' && wallet?.qnetAddress) jobs.push(loadTxHistory(true));
        // A move in transit is read for on every tab: the live figure that shows it through ends it, a certified read
        // settles its record.
        if ((tab === 'assets' || transitTotal(transitRef.current) > 0) && wallet?.publicKey) jobs.push(loadBalance(wallet.publicKey));
        if (tab === 'node') {
          // The latest render's loaders: this handler keeps the closures of the render it was installed in.
          const load = nodeLoadersRef.current;
          jobs.push(load.refreshHeight());
          jobs.push(load.loadWalletNode());
          jobs.push(load.loadServerNodeStatus());
          jobs.push(load.loadLightNodeStatus());
          jobs.push(load.loadSiteRecord());
        }
        await Promise.all(jobs.map(p => Promise.resolve(p).catch(() => {})));
      } catch (_) { /* a refresh failure must never block the token refresh below */ }

      // FCM token auto-refresh (debounced, lightweight)
      try {
        const needed = await isTokenRefreshNeeded();
        if (!needed) return;

        const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
        if (!nodeInfoStr) return;
        const nodeInfo = JSON.parse(nodeInfoStr);
        if (!nodeInfo.nodeId) return;

        // Auth is rooted in the Dilithium ping-delegation key inside
        // refreshFcmTokenOnServer — no wallet-seed gossip keypair derivation needed.
        await refreshFcmTokenOnServer(nodeInfo.nodeId);
      } catch (_) { /* silent — next foreground will retry */ }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => { subscription.remove(); };
  }, [wallet, password]);

  // v3.31: Initialize node discovery + WebSocket + TX history when wallet ready
  useEffect(() => {
    if (wallet?.qnetAddress) {
      // Drop the previous wallet's history ONLY on a real switch. The effect also runs when the same
      // wallet is loaded again after an unlock, and clearing there emptied the list every time the
      // screen came back - the user saw their history disappear on each unlock while the chain still
      // held every transaction.
      // Nothing shown yet for this wallet: put the cached rows up while the fetch is in flight.
      if (lastHistoryAddrRef.current !== wallet.qnetAddress && wallet.qnetAddress) {
        // A row an older build kept as confirmed on the archive's word alone reads as unverified (checkedCachedRows),
        // and in a block once the nodes' index no longer reaches its block (withListing).
        const owner = wallet.qnetAddress;
        loadCachedHistory(owner).then(cached => {
          const covered = coveredHeight(owner);
          if (cached.length) setTxHistory(prev => (prev.length ? prev : withListing(checkedCachedRows(cached), null, covered, logsFloorRef.current)));
        }).catch(() => {});
      }
      if (lastHistoryAddrRef.current && lastHistoryAddrRef.current !== wallet.qnetAddress) {
        // Only the screen is cleared. Each wallet's cache is kept under its own address, so switching
        // back shows that wallet's rows again instead of a blank list.
        setTxHistory([]);
        pendingTxRef.current = null;
      }
      if (lastHistoryAddrRef.current !== wallet.qnetAddress) historyCursorRef.current = undefined;
      lastHistoryAddrRef.current = wallet.qnetAddress;

      // Endpoints the genesis nodes agree on, for proof-checked reads (services/NodePool)
      walletManager.loadNodesFromCache().then(() => walletManager.refreshNodeDiscovery()).catch(() => {});

      // Connect WebSocket for real-time notifications
      connectWebSocket();

      // Load TX history
      loadTxHistory(true);
      
      return () => {
        wsShouldReconnectRef.current = false; // stop any resurrecting reconnect
        closeWebSocket();
        wsFailuresRef.current = 0;
        wsNextAtRef.current = 0;
      };
    }
  }, [wallet?.qnetAddress]);

  const checkWalletExists = async () => {
    try {
      let state = await walletManager.vaultState();
      // Which lock the wallet has: a flag that cannot be read (after retries) is never taken for a password wallet, whose
      // field would count every attempt against a wallet that has no password; the storage reads as unreadable, and the
      // recovery screen's Try again asks once more.
      const lock = state === 'none' ? 'no' : await walletManager.deviceAuthState();
      if (lock === 'unknown' && state === 'ok') state = 'unreadable';
      setWalletDeviceAuth(lock === 'yes');
      setHasWallet(state !== 'none');
      // Unreadable wallet data is never deleted by the app: the recovery screen explains and offers a way out.
      // Storage that could not be read at all is never taken for "no wallet" (which would offer Create).
      setVaultProblem(state === 'corrupt' || state === 'unreadable' ? state : null);
      setLoading(false);
      setVaultChecked(state !== 'unreadable');
      setWalletKnown(true);
    } catch (error) {
      setLoading(false);
      setWalletKnown(true);
    }
  };

  // The rule of both wallets (crypto/PasswordStrength): at least MIN_PASSWORD characters, typed twice.
  const validatePassword = () => {
    setPasswordError('');
    if (deviceAuth) return true; // under the screen lock there is no wallet password: the vault secret is generated

    if (typeof password !== 'string' || password.length === 0) {
      setPasswordError(t('pw_required'));
      return false;
    }

    if (password.length < MIN_PASSWORD) {
      setPasswordError(t('pw_too_short', { min: MIN_PASSWORD, left: MIN_PASSWORD - password.length }));
      return false;
    }

    if (!confirmPassword || confirmPassword.length === 0) {
      setPasswordError(t('pw_confirm_required'));
      return false;
    }

    if (password !== confirmPassword) {
      setPasswordError(t('pw_mismatch'));
      return false;
    }

    return true;
  };

  // The live feedback of every new-password form (create, import, change, a new password once the screen lock went):
  // the length line turns from × to ✓ as the password reaches MIN_PASSWORD characters, and once the second field has
  // text, whether the two match.
  const renderPasswordLength = (pw) => {
    const long = pw.length >= MIN_PASSWORD;
    return (
      <Text style={long ? styles.passwordSuccess : styles.passwordHint}>
        {long ? '✓' : '×'} {t('pw_min_chars', { min: MIN_PASSWORD })}
      </Text>
    );
  };

  // Whether the match line shows: once the second field has text, for a mismatch or a match long enough.
  const matchShown = (pw, confirm) => confirm.length > 0 && (pw !== confirm || pw.length >= MIN_PASSWORD);
  const renderPasswordMatch = (pw, confirm) => {
    if (!matchShown(pw, confirm)) return null;
    return pw !== confirm ? <Text style={styles.errorText}>{t('pw_mismatch')}</Text>
      : <Text style={styles.passwordSuccess}>✓ {t('pw_match')}</Text>;
  };

  // A form's error, tucked under its field as the feedback lines are; under a feedback line (`afterLine`) it keeps a
  // gap, which the tuck would otherwise cancel.
  const renderFormError = (error, afterLine) => (error
    ? <Text style={[styles.errorText, afterLine ? styles.errorAfterLine : null]} testID="form-error">{error}</Text> : null);

  // The terms line of the create and import forms: the box, then the sentence with the Terms of Service as a link.
  const renderTermsRow = () => (
    <View style={styles.termsContainer}>
      <Checkbox checked={termsAccepted} onPress={() => setTermsAccepted(!termsAccepted)} accessibilityLabel={t('terms_of_service')} />
      <Text style={styles.termsText}>
        {termsParts[0]}
        <Text style={styles.termsLink} onPress={() => setShowTermsModal(true)} accessibilityRole="link">{t('terms_of_service')}</Text>
        {termsParts[1]}
      </Text>
    </View>
  );

  // A recovery phrase as a list in two columns: each word's number, then the word, a hairline under each line.
  const renderSeedWords = (words) => (
    <View style={styles.seedGrid}>
      {words.map((word, index) => (
        <View key={index} style={styles.seedWordContainer}>
          <View style={styles.seedWordNumberBox}><Text style={styles.seedWordNumber}>{String(index + 1).padStart(2, '0')}</Text></View>
          <Text style={styles.seedWordText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>{word}</Text>
        </View>
      ))}
    </View>
  );

  // Android: before a recovery phrase is shown (a new wallet's) or typed (an import), the enabled accessibility
  // services that did not come with the system are named and the user decides: such a service can read the words
  // on screen and the text typed, and below Android 14 nothing hides them from it. Resolves true to go on.
  const confirmNoScreenReaders = async () => {
    const readers = await screenReaderApps();
    if (readers.length === 0) return true;
    return new Promise((resolve) => {
      showAlert(
        t('readers_title'),
        t('readers_body', { apps: readers.join(', ') }),
        [
          { text: t('cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('readers_continue'), style: 'destructive', onPress: () => resolve(true) },
        ],
      );
    });
  };

  // The local root / jailbreak / hook check, run at the moment a recovery phrase is about to be shown or typed, not
  // only at launch: a hooking framework attached later is seen too (MPLAT-R3-02). On a device that looks compromised
  // the user is told what that means and decides; blocking creation outright would strand them. Resolves true to go on.
  const confirmDeviceIntegrity = async () => {
    const r = await deviceIntegrity();
    setDeviceCompromised(!!r.compromised);
    if (!r.compromised) return true;
    return new Promise((resolve) => {
      showAlert(
        t('rooted_title'),
        t('rooted_body_phrase'),
        [
          { text: t('cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('readers_continue'), style: 'destructive', onPress: () => resolve(true) },
        ],
      );
    });
  };

  // Before a recovery phrase is shown (a new wallet's) or typed (an import): both warnings, each acknowledged.
  const confirmPhraseScreen = async () => (await confirmNoScreenReaders()) && (await confirmDeviceIntegrity());

  /**
   * The import, from the welcome screen (the screen lock as Create reads it) and right after an erase (`fresh`: read
   * from the device now, since a render from before the erase may hold an older answer). Under it there is no password
   * step: the phrase field is the import's first screen, so the checks that otherwise follow the password step run here.
   */
  const startImport = async ({ fresh = false } = {}) => {
    const underLock = fresh ? !!(await walletManager.deviceAuthAvailable().catch(() => false)) : deviceAuthAvail;
    if (fresh) setDeviceAuthAvail(underLock);
    if (underLock && !(await confirmPhraseScreen())) return;
    setPassword('');
    setConfirmPassword('');
    setSeedPhrase('');
    setPasswordError('');
    setTermsAccepted(false);
    setImportStep(1);
    setShowCreateOptions('import');
  };

  const createWallet = async () => {
    // Check terms acceptance
    if (!termsAccepted) {
      setPasswordError(t('terms_required'));
      return;
    }

    if (!validatePassword()) {
      return;
    }

    if (!(await confirmPhraseScreen())) return;

    // Show brief loading state
    setLoading(true);
    try {
      const newWallet = await walletManager.generateWallet();
      setLoading(false);
      
      // Store temporarily and show seed phrase. Under the screen lock there is no password to type or lose: the vault
      // secret is generated when the wallet is saved and goes straight behind the screen lock, so no copy of it sits in
      // this screen's state (MVA-R3-03). A null password marks that choice for the save.
      setTempWallet({ ...newWallet, password: deviceAuth ? null : password });
      setPassword('');
      setConfirmPassword('');
      const words = newWallet.mnemonic.split(' ');
      
      // Select 3 random positions to verify from the 12-word mnemonic  
      const allPositions = [...Array(12).keys()]; // [0, 1, 2, ..., 11]
      const verifyPositions = [];
      
      // Randomly select 3 unique positions
      while (verifyPositions.length < 3) {
        const randomPos = Math.floor(Math.random() * 12);
        if (!verifyPositions.includes(randomPos)) {
          verifyPositions.push(randomPos);
        }
      }
      
      // Sort positions for display
      verifyPositions.sort((a, b) => a - b);
      
      const confirmWords = {};
      const choices = {};
      
      // Generate word choices for each position
      verifyPositions.forEach(pos => {
        confirmWords[pos] = '';
        
        // 3 random words from the recovery-phrase word list + the correct word
        const allWords = walletManager.getBIP39WordList();
        const correctWord = words[pos];
        const randomWords = [];
        
        // Add 3 random incorrect words
        while (randomWords.length < 3) {
          const randomWord = allWords[Math.floor(Math.random() * allWords.length)];
          if (randomWord !== correctWord && !randomWords.includes(randomWord)) {
            randomWords.push(randomWord);
          }
        }
        
        // Mix correct word with random ones - randomize position
        const wordOptions = [...randomWords, correctWord].sort(() => Math.random() - 0.5);
        choices[pos] = wordOptions;
      });
      
      setSeedConfirmWords(confirmWords);
      setWordChoices(choices);
      
      // Show seed phrase and prepare for confirmation
      const formattedSeed = words.map((word, i) => `${i + 1}. ${word}`).join('\n');
      
      setLoading(false);
      
      // Show seed phrase with proper formatting
      setShowCreateOptions('show-seed');
    } catch (error) {
      setLoading(false);
      showAlert(t('error'), errorText(t, error, 'err_create_wallet'));
    }
  };

  const importWalletSteps = async () => {
    setPasswordError('');

    // Check terms acceptance  
    if (!termsAccepted) {
      setPasswordError(t('terms_required'));
      return;
    }

    if (!seedPhrase || seedPhrase.trim().length === 0) {
      setPasswordError(t('import_phrase_required'));
      return;
    }

    // Validate seed phrase word count
    const words = seedPhrase.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      setPasswordError(t('import_word_count', { count: words.length }));
      return;
    }

    // Fast import without loading screen
    try {
      // Keep seed for import, clear after success
      const seedToImport = seedPhrase.trim();
      
      // Show brief loading state
      setLoading(true);
      
      // A stored wallet is never replaced from here (MVA-R2-03): not its vault, and not its screen-lock secret.
      if (!(await walletManager.canStoreNewWallet())) {
        setLoading(false);
        showAlert(t('error'), t('err_WALLET_EXISTS'));
        return;
      }
      const imported = await walletManager.importWallet(seedToImport);

      // Save wallet before showing UI — with quick-crypto PBKDF2 is native (< 1s). Closing the app
      // mid-save would lose the wallet, and the save also clears what a previous wallet left on the
      // device, so it runs before the new wallet's screen and effects read that storage. The screen keeps
      // the session token it returns, never the password. Under the screen lock (no password step was shown): a
      // generated vault secret, taken behind the screen lock before the vault is written, and never held here
      // (MVA-R3-03).
      const typed = typeof password === 'string' && password.length > 0;
      let session;
      if (!typed) {
        try {
          session = await walletManager.storeWalletWithDeviceAuth(imported, t('auth_device_unlock'));
        } catch (e) {
          if (!(e && (e.code === 'DEVICE_LOCK' || e.code === 'DEVICE_LOCK_CANCELLED' || e.code === 'DEVICE_LOCK_RETRY'))) throw e;
          setLoading(false);
          // A refused prompt keeps the screen as it is: Import asks again.
          if (e.code === 'DEVICE_LOCK_CANCELLED') return;
          // A prompt that failed this time: the screen stays, and Import asks again with the screen lock (MA2-02), or
          // the password step appears.
          if (e.code === 'DEVICE_LOCK_RETRY') {
            offerPasswordAfterRetry();
            return;
          }
          deviceLockRetriesRef.current = 0;
          refreshDeviceAuthAvail();
          showAlert(t('device_lock_title'), t('device_lock_body'));
          return;
        }
        deviceLockRetriesRef.current = 0;
        setBiometricEnabled(true);
      } else {
        session = await walletManager.storeWallet(imported, password);
      }
      setWalletDeviceAuth(!typed);
      await teardownLightNodeIfForeign([
        imported.qnetAddress, imported.publicKey, walletManager.generateQNetAddressFromSolana(imported.publicKey),
      ]);
      await clearPastedPhrase();

      resetWalletScopedState(imported.qnetAddress);
      setSeedPhrase('');
      setWallet(WalletManager.publicWallet(imported));
      setPassword(session);
      setHasWallet(true);
      setShowCreateOptions(false);
      setConfirmPassword('');
      setImportStep(1); // Reset to step 1 for next time
      setLoading(false);

      // Switch directly to assets tab without alert
      setActiveTab('assets');
      loadBalance(imported.publicKey, WalletManager.publicWallet(imported));
      wipeKeyArrays(imported);
      return true;
    } catch (error) {
      setLoading(false);
      showAlert(t('error'), errorText(t, error, 'err_import_wallet'));
      return false;
    }
  };

  // An import that does not finish, for whatever reason, keeps the text so a wrong word can be fixed, but a pasted
  // phrase leaves the clipboard all the same (MPLAT-R2-03).
  const importWallet = async () => {
    let done = false;
    try {
      done = (await importWalletSteps()) === true;
    } finally {
      if (!done) clearPastedPhrase();
    }
  };

  // A recovery phrase must not stay on the clipboard once the import is over, whichever way it ends (MPLAT-R2-03,
  // MPLAT-R3-01). The field itself offers no Copy, Cut or Share. Here: text that arrived in one change of two or more
  // words (seedPastedRef: a paste or a keyboard's clipboard chip) means the clipboard holds it, emptied natively on
  // both platforms without reading it (clearClipboard). Otherwise iOS clears anything copied since the phrase field
  // appeared (the pasteboard's change count, so it is never read and no paste prompt appears) when the import ends:
  // Back, the import done or failed, the lock. Not when the app only goes to the background (`leaving`): a copy made in
  // another app meanwhile is not the phrase. Android never reads the clip to compare (that shows a paste notice).
  const clearPastedPhrase = async ({ leaving = false } = {}) => {
    const pasted = seedPastedRef.current;
    seedPastedRef.current = false;
    try {
      if (pasted) {
        await clearClipboard();
        return;
      }
      // Only while the import's phrase field was on screen: before it nothing reached that field, and a phrase
      // copied with its own Copy at creation stays for the app it is being pasted into (it expires by itself).
      if (Platform.OS === 'ios' && !leaving && seedBoardAtRef.current !== null) {
        await clearPasteboardIfChanged(seedBoardAtRef.current);
      }
    } catch (_) { /* nothing to clear */ }
  };

  // The recovery-phrase field is on screen (MPLAT-R3-01): its native guard goes on, and iOS notes the pasteboard's
  // change count so the end of the import can tell whether anything was copied meanwhile.
  const onSeedFieldShown = () => {
    guardSeedField(true);
    if (seedBoardAtRef.current !== null) return;
    pasteboardChangeCount().then((n) => { if (seedBoardAtRef.current === null) seedBoardAtRef.current = n; });
  };

  // A change that brought text at once (utils/sensitiveInput looksPasted: a paste, a keyboard's clipboard chip): the
  // clipboard held the phrase, and it is cleared right away rather than at the end of the import.
  const onSeedPhraseChange = (text) => {
    const prev = seedPhraseRef.current;
    seedPhraseRef.current = text;
    if (looksPasted(prev, text)) {
      seedPastedRef.current = true;
      clearPastedPhrase();
    }
    setSeedPhrase(text);
  };

  // The phrase field left the screen: its guard goes off, and the next field starts a fresh change count.
  const seedFieldShown = !hasWallet && showCreateOptions === 'import' && (importStep === 2 || deviceAuth);
  useEffect(() => {
    if (seedFieldShown) return undefined;
    guardSeedField(false);
    seedBoardAtRef.current = null;
    return undefined;
  }, [seedFieldShown]);

  // The phrase typed or pasted for import leaves the screen: the app goes to the background (`leaving`), the wallet
  // locks, Back is pressed. The field empties and a pasted phrase takes the clipboard with it.
  const forgetImportPhrase = ({ leaving = false } = {}) => {
    setSeedPhrase('');
    clearPastedPhrase({ leaving });
  };

  // The private key arrays of a wallet object that has been sealed in the vault are no longer needed here.
  const wipeKeyArrays = (w) => {
    if (!w) return;
    if (Array.isArray(w.secretKey)) w.secretKey.fill(0);
    if (w.qnetKeypair && Array.isArray(w.qnetKeypair.privateKey)) w.qnetKeypair.privateKey.fill(0);
  };

  const confirmSeedPhrase = async () => {
    // Clear previous error
    setVerificationError('');
    
    if (!tempWallet) {
      setVerificationError(t('seed_data_missing'));
      return;
    }
    
    const words = tempWallet.mnemonic.split(' ');
    const positions = Object.keys(seedConfirmWords).map(Number);
    
    // Check if all required words are filled
    const emptyWords = positions.filter(pos => !seedConfirmWords[pos] || seedConfirmWords[pos].trim() === '');
    if (emptyWords.length > 0) {
      setVerificationError(t('seed_select_word', { n: emptyWords[0] + 1 }));
      return;
    }
    
    // Check if all words match
    const incorrectWords = [];
    for (const pos of positions) {
      if (words[pos].toLowerCase() !== seedConfirmWords[pos].toLowerCase().trim()) {
        incorrectWords.push(pos + 1);
      }
    }
    
    if (incorrectWords.length > 0) {
      setVerificationError(incorrectWords.length === 1
        ? t('seed_word_wrong', { n: incorrectWords[0] })
        : t('seed_words_wrong', { list: `#${incorrectWords.join(', #')}` }));
      return;
    }
    
    // All words correct — save wallet FIRST, then show UI.
    // With react-native-quick-crypto PBKDF2 is native and takes < 1s.
    // We must not show the wallet before it's saved: if the user closes the
    // app before storeWallet completes, the vault is never written to AsyncStorage
    // and the wallet disappears on next launch ("seed phrase reset" bug).
    setLoading(true);
    if (!(await walletManager.canStoreNewWallet())) {
      setLoading(false);
      showAlert(t('error'), t('err_WALLET_EXISTS'));
      return;
    }
    // The screen keeps what the wallet shows (addresses, public keys) and the session token; the phrase,
    // the private keys and the password stay only in the vault.
    const savedWallet = WalletManager.publicWallet(tempWallet);
    // The choice made when the wallet was generated (createWallet): no password means the screen lock.
    const underLock = tempWallet.password == null;
    let session;
    try {
      // Under the screen lock the device must take the vault secret before the vault exists — a device with no screen
      // lock refuses it, and a wallet nobody could reopen after the first lock must never be written. The secret is
      // generated and stored inside the wallet manager, never here (MVA-R3-03).
      session = underLock
        ? await walletManager.storeWalletWithDeviceAuth(tempWallet, t('auth_device_unlock'))
        : await walletManager.storeWallet(tempWallet, tempWallet.password);
    } catch (error) {
      setLoading(false);
      // A refused prompt keeps the screen as it is: the same button asks again.
      if (underLock && error && error.code === 'DEVICE_LOCK_CANCELLED') return;
      // A prompt that failed this time: the same button asks again with the screen lock (MA2-02), or, with a password
      // chosen instead, the wallet is made again from the start with one (the generated wallet has none).
      if (underLock && error && error.code === 'DEVICE_LOCK_RETRY') {
        offerPasswordAfterRetry(() => showAlert(t('device_lock_title'), t('device_lock_body')));
        return;
      }
      if (underLock && error && error.code === 'DEVICE_LOCK') {
        refreshDeviceAuthAvail();
        showAlert(t('device_lock_title'), t('device_lock_body'));
      } else showAlert(t('error'), errorText(t, error, 'err_save_wallet'));
      return;
    }
    wipeKeyArrays(tempWallet);
    deviceLockRetriesRef.current = 0;
    setWalletDeviceAuth(underLock);
    if (underLock) setBiometricEnabled(true);

    // storeWallet has already cleared what a previous wallet left on the device; its light node stops
    // answering here, and the screen follows.
    await teardownLightNodeIfForeign([
      savedWallet.qnetAddress, savedWallet.publicKey, walletManager.generateQNetAddressFromSolana(savedWallet.publicKey),
    ]);
    resetWalletScopedState(savedWallet.qnetAddress);
    setShowSeedConfirm(false);
    setTempWallet(null);
    setWordChoices({});
    setLoading(false);
    setWallet(savedWallet);
    setPassword(session);
    setHasWallet(true);
    setConfirmPassword('');
    setSeedConfirmWords({});

    setActiveTab('assets');
    // A wallet generated just now holds nothing: its figures start at 0 (kept like a verified read), never a dash,
    // until the first read replaces them.
    await walletManager.saveBalanceSnapshot({
      owner: savedWallet.qnetAddress, qnc: 0, qncNano: '0', blockHeight: null, sol: 0, oneDev: 0, tokens: [], at: Date.now(),
    }).catch(() => false);
    showKeptBalances(savedWallet.qnetAddress);
    loadBalance(savedWallet.publicKey, savedWallet);
  };

  const _startLockoutCountdown = (remainingMs) => {
    if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
    setLockoutMs(remainingMs);
    lockoutTimerRef.current = setInterval(() => {
      setLockoutMs(prev => {
        if (prev <= 1000) {
          clearInterval(lockoutTimerRef.current);
          lockoutTimerRef.current = null;
          return 0;
        }
        return prev - 1000;
      });
    }, 1000);
  };

  // A refused password: the countdown when the lockout started, the wrong-password line otherwise.
  const showPasswordRefusal = (r, setError) => {
    if (r && r.locked) {
      _startLockoutCountdown(r.remainingMs);
      setError('');
    } else if (r && r.unrecorded) {
      setError(t('pw_attempt_unrecorded'));
    } else {
      setError(t('incorrect_password'));
      later(() => setError(''), 3000);
    }
  };

  // The vault could not be opened for a reason that is not the password. Only a device key that can never open
  // it again leads to the recovery screen, which offers Erase; a Keystore that did not answer this time is a
  // "try again" with nothing to erase (MVA-R3-02).
  const handleVaultError = (error) => {
    if (error instanceof VaultCorruptError) { setVaultProblem('corrupt'); return true; }
    if (error instanceof DeviceKeyError) {
      if (error.permanent) setVaultProblem('device_key');
      else showAlert(t('qnet_wallet'), t('vault_device_busy'));
      return true;
    }
    return false;
  };

  const handleBiometricUnlock = async () => {
    setUnlockError('');
    setUnlockPrompting(true);
    let r;
    try {
      r = await walletManager.unlockWithBiometrics();
    } catch (error) {
      setUnlockPrompting(false);
      if (!handleVaultError(error)) setUnlockError(t('unlock_failed'));
      return;
    }
    // The prompt ended: the Unlock button can ask again (a prompt owed for the next activation also opens by itself).
    setUnlockPrompting(false);
    if (r.invalidated) {
      setBiometricEnabled(false);
      showAlert(t('bio_off_title'), t('bio_off_body'));
      return;
    }
    if (!r.ok) {
      if (r.locked) _startLockoutCountdown(r.remainingMs);
      // iOS refused the read because the app was not in front (errSecInteractionNotAllowed): nothing failed, and the
      // prompt opens by itself when the app comes to the front (MA-R2-02).
      else if (r.notNow) autoUnlockOwedRef.current = true;
      // The screen lock that kept the secret was removed: only the recovery phrase opens the wallet now (MA-1).
      else if (r.gone) setUnlockError(t('auth_secret_gone'));
      // The attempt could not be recorded first, so nothing was tried; any other refusal that is not a cancel (the
      // prompt failed, or the secret opened nothing and was counted) says so: a passed prompt never does nothing.
      else if (r.unrecorded) setUnlockError(t('unlock_unrecorded'));
      else if (!r.cancelled) setUnlockError(t('unlock_failed'));
      return;
    }
    await _openSession(r.token);
    walletManager.isBiometricEnabled().then(setBiometricEnabled);
    // A password wallet opened by its biometric wrap moves to the screen lock as at a password unlock (O2, D1).
    if (!walletDeviceAuth) moveToDeviceUnlock(null).catch(() => {});
  };

  // Android, once after the update that removed an older build's biometric item: biometric unlock is off, and
  // the user may turn it on again (the per-use biometric key; the password opens the vault once to wrap it).
  const offerBiometricReenroll = async () => {
    if (deviceAuth || !(await walletManager.legacyBiometricNotice({ clear: true }))) return;
    setBiometricEnabled(false);
    showAlert(t('bio_reenroll_title'), t('bio_reenroll_body'), [
      { text: t('bio_reenroll_later'), style: 'cancel', onPress: () => {} },
      { text: t('bio_reenroll_turn_on'), onPress: () => { setBiometricPassword(''); setShowBiometricPasswordPrompt('biometric'); } },
    ]);
  };

  // A wallet under the screen lock: the lock screen is the system prompt itself. It opens as soon as a sealed wallet
  // exists and none is open — first launch and every auto-lock alike; a cancelled prompt leaves the button on screen
  // to repeat it. Only with the app in front (MA-R2-02): a launch in the background (a silent push, a background fetch)
  // or an auto-lock there owes the prompt, and it opens once when the app comes to the front. The prompt's own trip out
  // of the app (the device credential screen) owes nothing, so a cancel never brings it back by itself.
  autoUnlockRef.current = () => {
    autoUnlockOwedRef.current = false;
    if (!(deviceAuth && hasWallet && !wallet && !vaultProblem && lockoutMs <= 0 && !loading)) {
      setUnlockPrompting(false);
      return;
    }
    if (AppState.currentState !== 'active') {
      autoUnlockOwedRef.current = true;
      // At a cold start the state may still read as in the background for a moment after the screen is up: it is
      // looked at again shortly, so the prompt never waits for a change event that already went (A1).
      later(() => {
        if (autoUnlockOwedRef.current && AppState.currentState === 'active' && autoUnlockRef.current) autoUnlockRef.current();
      }, AUTO_UNLOCK_RECHECK_MS);
      return;
    }
    handleBiometricUnlock();
  };
  useEffect(() => {
    autoUnlockRef.current();
  }, [hasWallet, wallet, walletDeviceAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // A password wallet moves to the screen lock (WalletManager.switchToDeviceAuth) with the password just typed, or, after
  // a biometric unlock (`pw` null), with a fresh biometric through the vault's biometric wrap
  // (WalletManager.switchToDeviceAuthWithBiometric); the system prompt reads the new secret back before anything changes.
  const switchDeviceUnlock = async (pw) => {
    let r;
    try {
      r = typeof pw === 'string'
        ? await walletManager.switchToDeviceAuth(pw, t('auth_device_unlock'))
        : await walletManager.switchToDeviceAuthWithBiometric(t('auth_device_unlock'), t('set_device_unlock'));
    } catch (error) {
      // Stopped halfway: either way still opens the wallet; the screen follows what is stored.
      setWalletDeviceAuth(!!(await walletManager.usesDeviceAuth().catch(() => false)));
      if (!handleVaultError(error)) showAlert(t('error'), errorText(t, error, 'device_unlock_unavailable'));
      return;
    }
    if (r.ok) {
      setWalletDeviceAuth(true);
      setBiometricEnabled(true);
      setHwSeal(null);
      showAlert('', t('device_unlock_on'));
    } else if (r.unavailable) {
      showAlert(t('error'), t('device_unlock_unavailable'));
    } else if (r.invalidated) {
      // A fingerprint or face was added since: biometric unlock is off, and the password moves it next time.
      setBiometricEnabled(false);
      showAlert(t('bio_off_title'), t('bio_off_body'));
    } else if (typeof pw === 'string') {
      refusePassword(r);
    }
  };

  // One unlock rule (O2, D1): a password wallet on a device whose screen lock can hold its secret moves there at its
  // next unlock, by password or by its biometric (`pw` null). The dialog says what changes, and the system prompt reads
  // the new secret back; a refused prompt (or a dialog a lock swept away) keeps the password, and the next unlock asks
  // again. True when it was asked.
  const moveToDeviceUnlock = async (pw) => {
    try {
      if (walletDeviceAuth || !(await walletManager.deviceAuthAvailable())) return false;
    } catch (_) {
      return false;
    }
    showAlert(t('set_device_unlock'), t('device_unlock_offer_body'), [
      { text: t('device_unlock_offer_yes'), onPress: () => { switchDeviceUnlock(pw); } },
    ]);
    return true;
  };

  const unlockWallet = async () => {
    if (lockoutMs > 0) return;
    if (!password) {
      setUnlockError(t('incorrect_password'));
      later(() => setUnlockError(''), 3000);
      return;
    }
    await _doUnlock(password);
  };

  const _doUnlock = async (pw) => {
    // Show loading immediately — PBKDF2 verification takes 1-3s
    setLoading(true);
    setUnlockError('');
    let r;
    try {
      r = await walletManager.unlockWithPassword(pw);
    } catch (error) {
      setLoading(false);
      setPassword('');
      if (!handleVaultError(error)) showAlert(t('error'), t('err_open_wallet'));
      return;
    }
    setPassword('');
    if (!r.ok) {
      setLoading(false);
      showPasswordRefusal(r, setUnlockError);
      return;
    }
    await _openSession(r.token);
    if (!(await moveToDeviceUnlock(pw))) offerBiometricReenroll().catch(() => {});
  };

  // An unlocked session: the screen keeps its token (not the password) and the wallet's public view.
  const _openSession = async (token) => {
    setLoading(true);
    let loadedWallet;
    try {
      loadedWallet = await walletManager.loadWallet(token);
    } catch (error) {
      walletManager.closeSession();
      setLoading(false);
      if (!handleVaultError(error)) showAlert(t('error'), errorText(t, error, 'err_open_wallet'));
      return;
    }
    if (loadedWallet._migrated) {
      later(() => {
        Alert.alert(
          t('upgrade_title'),
          t('upgrade_body'),
          [{ text: t('common_ok'), style: 'default' }]
        );
      }, 1000); // Small delay so main UI renders first
    }
    const shown = WalletManager.publicWallet(loadedWallet);
    delete shown._migrated;
    delete shown._migratedFromVersion;
    wipeKeyArrays(loadedWallet);

    setPassword(token);
    setLoading(false);
    // The password field goes with the lock screen: it lets go of the focus first, so no field of the wallet screen
    // (the browser's address bar under it) takes the focus or the keyboard by itself.
    Keyboard.dismiss();
    setWallet(shown);
    walletManager.hardwareSealState().then(setHwSeal).catch(() => setHwSeal(null));

    // A light-node record another wallet left on this device stops answering here.
    teardownLightNodeIfForeign([
      shown.qnetAddress,
      shown.publicKey,
      walletManager.generateQNetAddressFromSolana(shown.publicKey),
    ]);

    // The last verified balances first, then the read.
    showKeptBalances(shown.qnetAddress);
    loadBalance(shown.publicKey, shown);
  };

  // A token proof in flight under `key` is shared by every load that asks for it while it runs; the next one reads anew.
  const tokenReadsRef = useRef(new Map());
  const sharedTokenRead = (key, read) => {
    const running = tokenReadsRef.current.get(key);
    if (running) return running;
    const promise = Promise.resolve().then(read).finally(() => {
      if (tokenReadsRef.current.get(key) === promise) tokenReadsRef.current.delete(key);
    });
    tokenReadsRef.current.set(key, promise);
    return promise;
  };

  // Load QRC-20 tokens for the Assets list: the account's on-chain holdings merged with the
  // user's persisted custom tokens (AsyncStorage 'qnet_custom_tokens'). Custom tokens not present
  // in holdings get their balance fetched individually. Deduped by contract address (held wins for
  // balance freshness). Runs in the SAME effect as balance loading (called from loadBalance).
  const loadQrcTokens = async (qnetAddress) => {
    if (!qnetAddress) return;
    try {
      // 1) On-chain holdings (human-scaled by the decimals the answering node reports; unproven).
      const holdings = await walletManager.getTokenHoldings(qnetAddress);
      const byContract = new Map();
      for (const h of holdings) {
        if (h.contract) byContract.set(h.contract, { ...h, decimalsTrusted: false });
      }

      // 2) Persisted custom tokens — merge in any not already present as a holding, and refresh
      //    their balances (a custom token the wallet has zero of won't appear in holdings).
      let persisted = [];
      try {
        const raw = await AsyncStorage.getItem('qnet_custom_tokens');
        persisted = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(persisted)) persisted = [];
      } catch (_) { persisted = []; }
      const stillCurrent = () => !currentOwnerRef.current || currentOwnerRef.current === qnetAddress;
      if (!stillCurrent()) return;
      setCustomTokens((prev) => (sameRows(prev, persisted) ? prev : persisted));
      // The row on screen whose figure was proven for a state (`figureHeight`) the chain has reached (requestPace
      // liveHeightFits), in the same decimals: an added token keeps that figure with its state and mark. The holdings
      // answer (one node's, unproven, of no stated height) only adds and removes rows and fills the others, so it never
      // takes a row back to a balance from before a send or a receipt; neither does a proven figure of an older state
      // (tokenFigureRow).
      const provenRow = (contract, decimals) => {
        if (currentOwnerRef.current !== qnetAddress) return null;
        const row = (qrcTokensRef.current || []).find((r) => r && r.contract === contract);
        return row && row.decimals === decimals && Number.isSafeInteger(row.figureHeight)
          && liveHeightFits(row.figureHeight, heightRead()) ? row : null;
      };

      await Promise.all(persisted.map(async (c) => {
        const contract = c.contract_address || c.contract;
        if (!contract) return;
        const dec = Number(c.decimals) || 0;
        const held = byContract.get(contract);
        // An added token keeps the decimals and symbol recorded when the user added it: a holdings answer cannot
        // rescale the figure shown (and marked ✓) or the amount a send signs (MOBNET-R3-05). Its base units are
        // scaled with the recorded decimals.
        if (held) {
          byContract.set(contract, {
            ...held,
            name: c.name || c.symbol || held.name || '',
            symbol: c.symbol || held.symbol || '',
            decimals: dec,
            balance: walletManager._formatBaseUnits(held.balanceBase || '0', dec),
            decimalsTrusted: true,
          });
          return;
        }
        // A proven figure on screen needs no unproven read; it stays (below).
        const proven = provenRow(contract, dec);
        const bal = proven ? { balance: proven.balance } : await walletManager.getTokenBalanceOf(contract, qnetAddress, dec);
        // A read that failed is no 0: the row keeps the figure it showed for this wallet, else a dash (null).
        const shownRow = (qrcTokensRef.current || []).find((row) => row && row.contract === contract);
        const kept = shownRow && currentOwnerRef.current === qnetAddress && typeof shownRow.balance === 'string' ? shownRow : null;
        byContract.set(contract, {
          contract,
          name: c.name || c.symbol || '',
          symbol: c.symbol || '',
          decimals: dec,
          balance: bal.balance != null ? bal.balance : (kept ? kept.balance : null),
          logo: c.logo || '',
          decimalsTrusted: true,
        });
      }));

      const list = Array.from(byContract.values()).map((row) => {
        const kept = row.decimalsTrusted && provenRow(row.contract, row.decimals);
        return kept ? { ...row, balance: kept.balance, verified: kept.verified === true, figureHeight: kept.figureHeight } : row;
      });
      if (!stillCurrent()) return;
      setQrcTokens((prev) => (sameRows(prev, list) ? prev : list));

      // Each added token's balance proven, non-blocking: at a genesis node's live tip first (liveTokenFigure, both levels
      // folded to that node's root), then against the committee-QC-anchored state root (the native balance's trust model),
      // which adds the mark once it is of the row's state or newer (tokenFigureRow). Skip hidden tokens (never shown) and
      // cap concurrency so a dust-heavy wallet can't open hundreds of simultaneous proof requests; a proof of the same
      // token still running is shared (sharedTokenRead), so loads at the account-event rate never pile proofs up.
      // Only added tokens: the proof covers base units, and a ✓ must never sit next to a magnitude a node chose
      // (MOBNET-R3-05). A token shown without being added keeps an unproven figure and no mark.
      const added = new Set(persisted.map((c) => c.contract_address || c.contract).filter(Boolean));
      const toProve = list.filter((tk) => tokenVisible(tk.contract, { hidden: hiddenTokens, added, shown: shownTokensRef.current })
        && tk.decimalsTrusted);
      let proofIdx = 0;
      const proveWorker = async () => {
        while (proofIdx < toProve.length) {
          const tk = toProve[proofIdx++];
          const apply = (figure) => {
            if (!figure || !stillCurrent()) return;
            setQrcTokens((prev) => {
              const next = prev.map((row) => (row.contract === tk.contract ? tokenFigureRow(row, figure) : row));
              return next.every((row, i) => row === prev[i]) ? prev : next;
            });
          };
          const key = `${qnetAddress}:${tk.contract}:${tk.decimals}`;
          // A live figure of a block the chain has not reached is of no state it has (requestPace liveHeightFits).
          const live = sharedTokenRead(`live:${key}`, () => walletManager.liveTokenFigure(tk.contract, qnetAddress, tk.decimals))
            .then((f) => apply(f && liveHeightFits(f.blockHeight, heightRead())
              ? { balance: f.balance, blockHeight: f.blockHeight, verified: false } : null), () => {});
          const certified = sharedTokenRead(`certified:${key}`,
            () => walletManager.getTokenBalanceWithProof(tk.contract, qnetAddress, tk.decimals))
            .then((r) => apply(r && r.ok && r.verified ? { balance: r.balance, blockHeight: Number(r.blockHeight), verified: true } : null), () => {});
          await Promise.all([live, certified]);
        }
      };
      for (let w = 0; w < Math.min(5, toProve.length); w++) proveWorker();
    } catch (e) {
      // Non-fatal: keep the last-known token list rather than flashing empty.
      // console.warn('[QRC20] token list load failed:', e.message);
    }
  };

  // Per-token hide list (spam control): contract addresses persisted in AsyncStorage 'qnet_hidden_tokens'.
  // The Assets list filters these out; the token manager toggles them back on.
  const persistHiddenTokens = async (set) => {
    try { await AsyncStorage.setItem('qnet_hidden_tokens', JSON.stringify(Array.from(set))); } catch (_) {}
  };
  const hideToken = (contract) => {
    setHiddenTokens((prev) => { const next = new Set(prev); next.add(contract); persistHiddenTokens(next); return next; });
  };
  const unhideToken = (contract) => {
    setHiddenTokens((prev) => { const next = new Set(prev); next.delete(contract); persistHiddenTokens(next); return next; });
  };
  const persistShownTokens = async (set) => {
    try { await AsyncStorage.setItem('qnet_shown_tokens', JSON.stringify(Array.from(set))); } catch (_) {}
  };
  // Token manager Switch: on ⇒ visible (unhide, and shown although this wallet did not add it), off ⇒ hidden.
  const setTokenVisible = (contract, visible) => {
    if (visible) unhideToken(contract); else hideToken(contract);
    if (contract === 'native:qnc') return;
    setShownTokens((prev) => {
      const next = new Set(prev);
      if (visible) next.add(contract); else next.delete(contract);
      persistShownTokens(next);
      return next;
    });
  };

  // A balance as the screen shows it: the figure, or masked while balances are hidden (utils/privacy).
  const shownBalance = (s) => masked(amountText(s), balancesHidden);
  // A token row's figure, or a dash while none was read for it (a failed read is never a 0).
  const tokenFigure = (tk) => (tk && tk.balance != null ? String(tk.balance) : '—');
  // A figure of the wallet on screen ('qnc', 'sol', 'oneDev'), or a dash while none was read or kept for it.
  const figureKnown = (field) => !!(wallet && balanceStatus.owner === wallet.qnetAddress && balanceStatus.known[field]);
  const figure = (field, text) => shownBalance(figureKnown(field) ? text : '—');
  // The line under Send and Receive (owner, 11.10), steady while it holds: the network stopped certifying, with the
  // time of its last certified state once this device verified it (with no time before); else, once QNC reads failed
  // for a sustained time, when the figures shown were read (or that none could be). Reads that start or end with
  // nothing new change nothing on it. While a long lineage walk keeps QNC from being certified, the line says how far
  // it runs silently: the figures stay as they are until a certified read replaces them.
  const balanceLine = () => {
    if (!wallet || balanceStatus.owner !== wallet.qnetAddress) return null;
    if (balanceStatus.paused) {
      return Number.isFinite(balanceStatus.paused.since)
        ? t('balance_network_paused', { time: dateTime(balanceStatus.paused.since) }) : t('balance_network_paused_untimed');
    }
    if (balanceStatus.state !== 'stale') return null;
    return balanceStatus.known.qnc && balanceStatus.at
      ? t('balance_stale', { time: dateTime(balanceStatus.at) }) : t('balance_unavailable');
  };
  // A switch of the header's More: the amounts ('balances') or the node names ('names') masked, kept on the device.
  const toggleMask = (what) => {
    setMasks((prev) => {
      const next = { ...prev, [what]: !prev[what] };
      writeMask(AsyncStorage, what, next[what]);
      return next;
    });
  };

  // Token-manager search results: native QNC first (always listed so it's hideable, even at 0), then
  // held/custom QRC-20. Normalize the query once and memoize so a keystroke (or unrelated re-render)
  // doesn't re-scan the list. QNC's synthetic contract 'native:qnc' drives its hidden-set toggle.
  const tokenMgrResults = useMemo(() => {
    const qnc = {
      contract: 'native:qnc', symbol: 'QNC', name: 'QNet', decimals: 5, logo: '',
      balance: (Number(tokenBalances.qnc) || 0).toFixed(5),
    };
    const all = [qnc, ...qrcTokens];
    const raw = tokenMgrQuery.trim();
    if (!raw) return all;
    const q = raw.toLowerCase();
    // The token picker's search (TokenScreens assetMatches): its symbol, name or contract holds the text.
    const matches = all.filter((tk) => assetMatches(tk, q));
    // Paste a contract address (EON) to track a token not in the list yet — its row toggle adds it.
    if (!matches.length && isValidQnetAddress(q) && !all.some((tk) => tk.contract === q)) {
      return [{ contract: q, symbol: '', name: '', decimals: 5, logo: '', balance: '0', _addable: true }];
    }
    return matches;
  }, [qrcTokens, tokenMgrQuery, tokenBalances]);

  // Load the persisted hidden-token set and the masks (utils/privacy) on mount.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('qnet_hidden_tokens');
        if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) setHiddenTokens(new Set(arr)); }
      } catch (_) {}
      try {
        const raw = await AsyncStorage.getItem('qnet_shown_tokens');
        if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) setShownTokens(new Set(arr.filter((c) => typeof c === 'string'))); }
      } catch (_) {}
      setMasks(await readMasks(AsyncStorage));
    })();
  }, []);

  // A figure ('qnc', 'sol', 'oneDev') a read of this session put on screen for `owner`: a cached one never replaces it.
  // A QNC figure (early or decided, a 0 too) is a read that landed: the failures in a row start over and the line goes.
  // `readAt`: when the QNC answer was read (its figure and its proof are one read). When nothing changed the status
  // object stays the same, so the screen does not render again for it.
  const noteFreshFigure = (owner, field, readAt = Date.now()) => {
    if (freshFiguresRef.current.owner !== owner) freshFiguresRef.current = { owner };
    freshFiguresRef.current[field] = true;
    if (field === 'qnc') qncFailsRef.current = { owner, count: 0, since: 0 };
    setBalanceStatus((prev) => {
      const same = prev.owner === owner;
      const state = field === 'qnc' ? 'fresh' : (same ? prev.state : 'idle');
      const at = field === 'qnc' ? readAt : (same ? prev.at : 0);
      if (same && prev.known[field] && prev.state === state && prev.at === at) return prev;
      return { owner, state, at, known: { ...(same ? prev.known : {}), [field]: true }, paused: same ? prev.paused : null };
    });
  };

  // A QNC read of `owner` that landed nothing: one more failure in a row. The line says the figures are not updated only
  // once STALE_AFTER_FAILS of them came over STALE_AFTER_MS at least, and stays until a read lands (noteFreshFigure).
  const noteQncFailure = (owner, now = Date.now()) => {
    const last = qncFailsRef.current.owner === owner ? qncFailsRef.current : { owner, count: 0, since: 0 };
    const fails = { owner, count: last.count + 1, since: last.since || now };
    qncFailsRef.current = fails;
    if (fails.count < STALE_AFTER_FAILS || now - fails.since < STALE_AFTER_MS) return;
    setBalanceStatus((prev) => (prev.owner === owner && prev.state !== 'stale' ? { ...prev, state: 'stale' } : prev));
  };

  // How far the lineage walk is while QNC is not certified (WalletManager.walkSteps: null for a short walk), noted
  // after each QNC read and follow tick: the line says it while it holds; a certified read takes it away.
  const noteWalk = (owner, verified) => {
    Promise.resolve().then(() => (verified ? null : walletManager.walkSteps())).catch(() => null).then((steps) => {
      const walk = Number.isSafeInteger(steps) && steps > 0 ? steps : null;
      setBalanceStatus((prev) => (prev.owner !== owner || (prev.walk || null) === walk ? prev : { ...prev, walk }));
    });
  };

  // The height the newest QNC figure read for `owner` covers, or null: a certified read's checkpoint (coveredRef) or the
  // live figure's block (liveFloor), whichever is newer. A received transfer in a block at or below it is in the
  // balance, one above it is in a block and not in it yet, and the archive's row of a block TX_INDEX_RETENTION_BLOCKS or
  // more below it, or a token row at or below the logs floor it clamps, is in a block (utils/txHistory withListing).
  const coveredHeight = (owner) => {
    const certified = coveredRef.current.owner === owner ? coveredRef.current.height : -1;
    const live = liveFloor(owner);
    const height = Math.max(certified, live ? live.blockHeight : -1);
    return height >= 0 ? height : null;
  };

  // The rows on screen with what that height covers now; `certified`: the checkpoint of a certified read for `owner`.
  const noteCovered = (owner, certified = null) => {
    if (!owner) return;
    const cur = coveredRef.current.owner === owner ? coveredRef.current : { owner, height: -1, listed: -1 };
    const height = Number.isSafeInteger(certified) && certified > cur.height ? certified : cur.height;
    coveredRef.current = { owner, height, listed: cur.listed };
    const covered = coveredHeight(owner);
    if (covered === null || covered <= cur.listed) return;
    coveredRef.current = { owner, height, listed: covered };
    if (currentOwnerRef.current && currentOwnerRef.current !== owner) return;
    setTxHistory((prev) => {
      const next = withListing(prev, null, covered, logsFloorRef.current);
      return next.every((r, i) => r === prev[i]) ? prev : next;
    });
  };

  // Whether the network stopped certifying, asked after each read (WalletManager.networkPause): the line says so while
  // it holds. A head that could not be read keeps what was known.
  const notePause = async (owner) => {
    const pause = await Promise.resolve().then(() => walletManager.networkPause()).catch(() => undefined);
    if (pause === undefined || (currentOwnerRef.current && currentOwnerRef.current !== owner)) return;
    const next = pause ? { since: Number.isFinite(pause.since) ? pause.since : null } : null;
    setBalanceStatus((prev) => {
      if (prev.owner !== owner) return prev;
      const same = next ? !!prev.paused && prev.paused.since === next.since : !prev.paused;
      return same ? prev : { ...prev, paused: next };
    });
  };

  // The last verified balances of this wallet, kept from an earlier session (WalletManager.loadBalanceSnapshot), on
  // screen the moment it opens; a figure this session already read stays. Figures already on screen for this wallet (an
  // unlock after a lock) stay as they are, and so does the line under them.
  const showKeptBalances = async (owner) => {
    if (!owner) return;
    setBalanceStatus((prev) => (prev.owner === owner ? prev : { owner, state: 'idle', at: 0, known: {}, paused: null }));
    const snap = await Promise.resolve().then(() => walletManager.loadBalanceSnapshot(owner)).catch(() => null);
    if (!snap || (currentOwnerRef.current && currentOwnerRef.current !== owner)) return;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const fresh = freshFiguresRef.current.owner === owner ? freshFiguresRef.current : {};
    const kept = { qnc: fresh.qnc ? null : num(snap.qnc), sol: fresh.sol ? null : num(snap.sol), oneDev: fresh.oneDev ? null : num(snap.oneDev) };
    setTokenBalances((prev) => mergeTokenBalances(prev, { owner, qnc: kept.qnc, sol: kept.sol, oneDev: kept.oneDev, verified: true }));
    if (kept.sol !== null) setBalance(kept.sol);
    const tokens = Array.isArray(snap.tokens) ? snap.tokens.filter((tk) => tk && typeof tk.contract === 'string'
      && typeof tk.balance === 'string' && /^\d+(\.\d+)?$/.test(tk.balance)) : [];
    if (tokens.length) {
      setQrcTokens((prev) => (prev.length ? prev : tokens.map((tk) => ({
        contract: tk.contract, name: String(tk.name || ''), symbol: String(tk.symbol || ''), decimals: Number(tk.decimals) || 0,
        balance: tk.balance, logo: String(tk.logo || ''), decimalsTrusted: tk.decimalsTrusted === true, verified: false,
      }))));
    }
    setBalanceStatus((prev) => {
      if (prev.owner !== owner) return prev;
      const known = { ...prev.known };
      if (kept.qnc !== null) known.qnc = true;
      if (kept.sol !== null) known.sol = true;
      if (kept.oneDev !== null) known.oneDev = true;
      return { ...prev, known, at: prev.state === 'fresh' ? prev.at : (Number(snap.at) || prev.at) };
    });
  };

  // What the next session shows first: the figures of a read whose QNC a proof certified, with the token rows a proof
  // certified, sealed by WalletManager. Written when they changed, or a minute after the last write.
  // `read`: the SOL and 1DEV figures the same read got (null: not read, the ones on screen are kept).
  const keepBalances = (owner, qnc, read = {}) => {
    const shown = shownBalancesRef.current || {};
    const same = shown.owner === owner;
    const figureOf = (got, onScreen) => (Number.isFinite(got) ? got : (same && Number.isFinite(Number(onScreen)) ? Number(onScreen) : null));
    const snapshot = {
      owner,
      qnc: qnc.balance,
      qncNano: qnc.balanceNano || null,
      blockHeight: Number.isSafeInteger(Number(qnc.blockHeight)) ? Number(qnc.blockHeight) : null,
      sol: figureOf(read.sol, shown.sol),
      oneDev: figureOf(read.oneDev, shown['1dev']),
      tokens: (qrcTokensRef.current || []).filter((tk) => tk && tk.verified && tk.contract).slice(0, 64).map((tk) => ({
        contract: tk.contract, name: tk.name || '', symbol: tk.symbol || '', decimals: Number(tk.decimals) || 0,
        balance: String(tk.balance), logo: typeof tk.logo === 'string' && tk.logo.length <= 8 ? tk.logo : '',
        decimalsTrusted: tk.decimalsTrusted === true,
      })),
    };
    const text = JSON.stringify(snapshot);
    const now = Date.now();
    if (text === snapshotSavedRef.current.text && now - snapshotSavedRef.current.at < 60_000) return;
    snapshotSavedRef.current = { text, at: now };
    Promise.resolve().then(() => walletManager.saveBalanceSnapshot({ ...snapshot, at: now })).catch(() => {});
  };

  // `target` is the wallet to read for; flows that have just created, imported or unlocked one pass it,
  // because the `wallet` state in this closure may still be the previous one (or null).
  // One read at a time per wallet. A call while one started a moment ago for the same wallet (the unlock's and the Assets
  // tab's start together) shares it instead of asking every source again; a call while one has been running longer may
  // be for something that read predates (a feed event, a confirmed send), so one more read follows it.
  // A pull to refresh on Assets ends when the read's QNC figure is on screen, as a wallet that shows its node's answer
  // does; the proof check of that figure goes on in the background and a send still waits for it.
  const figureWaitersRef = useRef([]);
  const figureLanded = () => { figureWaitersRef.current.splice(0).forEach((resolve) => resolve()); };

  // The optimistic hold after a send: the expected (lower) balance stands until a figure read has caught up to the send
  // (its account `nonce` reached the send's, whatever came in meanwhile, or it is at or below the expected one), or two
  // minutes passed. `settle` also ends the hold (the read that decides does; an early figure does not).
  const heldAfterSend = (q, settle, nonce = null) => {
    if (!pendingTxRef.current) return { q, optimistic: false };
    const { expectedQnc, timestamp, nonce: sentAt } = pendingTxRef.current;
    const applied = Number.isSafeInteger(sentAt) && /^\d+$/.test(String(nonce)) && Number(nonce) >= sentAt;
    if (applied || q <= expectedQnc || Date.now() - timestamp >= 120000) {
      if (settle) {
        pendingTxRef.current = null;
        if (txPollingRef.current) { clearInterval(txPollingRef.current); txPollingRef.current = null; }
      }
      return { q, optimistic: false };
    }
    return { q: expectedQnc, optimistic: true }; // block not yet on this node — hold optimistic
  };

  // The newest live figure on screen for the open wallet ({ owner, blockHeight, balance, nonce }): one of an older state,
  // from a node a block behind or a certified read, never goes over it.
  const NO_LIVE_FIGURE = { owner: null, blockHeight: -1, balance: null, nonce: null };
  const liveFigureRef = useRef(NO_LIVE_FIGURE);

  // That figure for `owner`, or null. One whose block the chain's height as the app read it does not reach
  // (requestPace liveHeightFits) is dropped: it no longer refuses later figures or counts received rows in the balance.
  const liveFloor = (owner) => {
    const last = liveFigureRef.current;
    if (!owner || last.owner !== owner) return null;
    if (liveHeightFits(last.blockHeight, heightRead())) return last;
    liveFigureRef.current = NO_LIVE_FIGURE;
    return null;
  };

  // A live figure (WalletManager.liveQncFigure: a genesis node's live tip, its proof folded) on screen for `owner`: QNC at
  // once, not verified (the certified read confirms it in the background), the received History rows it covers in the
  // balance, and the moves in transit its claim watermark shows through ended (noteLiveTransit). One of an older state
  // than the one shown, of a block the chain has not reached, or for another wallet, changes nothing. Whether it was shown.
  const showLiveFigure = (owner, f) => {
    if (!f || !owner || !Number.isFinite(f.balance) || !Number.isSafeInteger(f.blockHeight)) return false;
    if (currentOwnerRef.current && currentOwnerRef.current !== owner) return false;
    if (!liveHeightFits(f.blockHeight, heightRead())) return false;
    const last = liveFloor(owner);
    if (last && f.blockHeight < last.blockHeight) return false;
    liveFigureRef.current = { owner, blockHeight: f.blockHeight, balance: f.balance, nonce: f.nonce ?? null };
    const { q, optimistic } = heldAfterSend(f.balance, false, f.nonce);
    setBalanceVerified(false);
    setTokenBalances((prev) => mergeTokenBalances(prev, { owner, qnc: q, verified: false, optimistic, live: true }));
    noteFreshFigure(owner, 'qnc', Date.now());
    figureLanded();
    noteCovered(owner);
    noteLiveTransit(owner, f.figureClaimedEpoch, f.blockHeight);
    return true;
  };

  // One live read of `owner` put on screen (showLiveFigure): whether it was. The chain's height its block is judged by is
  // read beside it once the last read is TIP_READ_MS old (fetchCachedBlockHeight), never waited for. `maxAgeMs`: a figure
  // read that recently is taken as it is (requestPace LIVE_SHARE_MS).
  const readLiveFigure = (owner, maxAgeMs = 0) => {
    if (!(Date.now() - heightRead().at < TIP_READ_MS)) fetchCachedBlockHeight();
    return Promise.resolve()
      .then(() => walletManager.liveQncFigure(owner, { maxAgeMs }))
      .then((f) => showLiveFigure(owner, f), () => false);
  };

  const loadBalance = (publicKey, target = null) => {
    const owner = (target && target.qnetAddress) || (wallet && wallet.qnetAddress) || null;
    const running = balanceRunRef.current;
    if (owner && running && running.owner === owner) {
      if (Date.now() - running.at >= BALANCE_SHARE_MS) running.again = true;
      return running.promise;
    }
    const entry = { owner, at: Date.now(), again: false, promise: null };
    entry.promise = readBalances(publicKey, target).finally(() => {
      if (balanceRunRef.current === entry) balanceRunRef.current = null;
      if (entry.again) loadBalance(publicKey, target);
    });
    if (owner) balanceRunRef.current = entry;
    return entry.promise;
  };

  // Each figure goes on screen as soon as its own source answers: SOL and 1DEV from Solana, QNC as soon as its answer
  // is read and its Merkle proof folded (not verified yet, while the lineage walk runs; an unverified figure never lowers
  // the one shown), then again once the walk decided.
  const readBalances = async (publicKey, target) => {
    try {
      const currentWallet = target || wallet || await walletManager.getCurrentWallet();
      // Load QRC-20 token holdings in the SAME effect as balances (non-blocking).
      const qnetAddr = currentWallet?.qnetAddress;
      if (qnetAddr) loadQrcTokens(qnetAddr);
      // A read that started for a wallet no longer on screen (a send poller of the previous one, a switch mid-fetch)
      // applies nothing.
      const gone = () => !!(currentOwnerRef.current && qnetAddr && qnetAddr !== currentOwnerRef.current);
      const owner = qnetAddr || null;
      // A read that starts says nothing (owner, 11.10): only another wallet's figures are cleared.
      if (owner) {
        setBalanceStatus((prev) => (prev.owner !== owner ? { owner, state: 'idle', at: 0, known: {}, paused: null } : prev));
      }

      const got = { sol: null, oneDev: null }; // what this read got from Solana, for the kept figures
      const solRead = walletManager.getBalance(publicKey).then((bal) => {
        if (gone() || bal == null) return;
        got.sol = bal;
        setBalance(bal);
        setTokenBalances((prev) => mergeTokenBalances(prev, { owner, sol: bal }));
        if (owner) noteFreshFigure(owner, 'sol');
      }, () => {});
      const oneDevRead = walletManager.getTokenBalance(currentWallet?.solanaAddress || currentWallet?.address || publicKey, ONE_DEV_MINT)
        .then((v) => {
          if (gone() || v == null) return;
          got.oneDev = v;
          setTokenBalances((prev) => mergeTokenBalances(prev, { owner, oneDev: v }));
          if (owner) noteFreshFigure(owner, 'oneDev');
        }, () => {});

      let figureAt = 0; // when the QNC answer was read: its figure lands first, its proof decides later
      // A genesis node's live tip, shown as soon as it comes (showLiveFigure); the certified read below confirms it in the
      // background, and a figure of an older state never goes over it.
      let liveShown = false;
      const liveRead = qnetAddr ? readLiveFigure(qnetAddr, LIVE_SHARE_MS).then((shown) => {
        if (shown && !gone()) { liveShown = true; figureAt = Date.now(); }
      }) : null;
      const shownLive = () => liveFloor(owner);
      const olderThanLive = (h) => !!shownLive() && !(Number(h) >= shownLive().blockHeight);

      const qncResult = await walletManager.getQNCBalanceWithProof(qnetAddr, true, {
        onFigure: (f) => {
          if (gone() || !owner || !Number.isFinite(f.balance) || olderThanLive(f.blockHeight)) return;
          const { q, optimistic } = heldAfterSend(f.balance, false, f.nonce);
          figureAt = Date.now();
          setTokenBalances((prev) => mergeTokenBalances(prev, { owner, qnc: q, verified: false, optimistic }));
          noteFreshFigure(owner, 'qnc', figureAt);
          figureLanded();
        },
      });

      if (gone()) return;

      if (qnetAddr) sendKeptDue(qnetAddr);

      await liveRead;
      if (gone()) return;
      const qncOk = !!qncResult?.ok;
      const isBalanceVerified = qncResult?.verified || false;
      // A certified figure of a state older than the live one on screen confirms the walk, not the figure: the live one
      // stays until a certified state reaches its height.
      const live = shownLive();
      const liveNewer = qncOk && olderThanLive(qncResult.blockHeight);
      const shownVerified = isBalanceVerified && !liveNewer;

      // Resolve the QNC value to apply OUTSIDE the state updater (it mutates refs). The optimistic-send
      // guard holds the expected (lower) balance until the queried node has caught up to our TX.
      let qncToApply = null; // null ⇒ QNC fetch failed: keep last-known, never flash 0
      let optimistic = false;
      if (qncOk) {
        ({ q: qncToApply, optimistic } = heldAfterSend(liveNewer ? live.balance : qncResult.balance, true,
          liveNewer ? live.nonce : qncResult.nonce));
      }
      // One unproven answer lower than the figure shown may be a lagging node, so it does not lower it by itself;
      // two genesis nodes agreeing on the lower figure do (MOBNET-R3-04): a spend made from the browser, the extension
      // or by anyone holding the phrase then shows here instead of the old, higher balance.
      let agreed = false;
      const shown = shownBalancesRef.current;
      if (qncOk && !shownVerified && !liveNewer && !optimistic && qnetAddr && shown && shown.owner === qnetAddr
          && qncToApply < (shown.qnc || 0)) {
        const agreedQnc = await walletManager.agreedGenesisBalance(qnetAddr).catch(() => null);
        if (gone()) return;
        if (agreedQnc !== null && Number.isFinite(agreedQnc)) { qncToApply = agreedQnc; agreed = true; }
      }
      // "Verified by proof" only for the figure a proof covered: never while the optimistic hold after a send
      // shows the expected balance instead (MOBNET-R2-07).
      setBalanceVerified && setBalanceVerified(qncOk && shownVerified && !optimistic);

      // Merge: overwrite a figure ONLY when its fetch succeeded (null/failed ⇒ keep last-known) — and
      // "last-known" is only ever this same address's; another wallet's balances start from zero.
      setTokenBalances(prev => mergeTokenBalances(prev, {
        owner, qnc: qncToApply, verified: shownVerified, optimistic, agreed, live: liveNewer,
      }));
      if (owner && qncOk) noteFreshFigure(owner, 'qnc', figureAt || Date.now());
      // No figure at all: one more failure in a row; the line comes only once they last (noteQncFailure).
      if (owner && !qncOk && !liveShown) noteQncFailure(owner);
      if (owner) noteWalk(owner, qncOk && isBalanceVerified);
      if (owner && qncOk && isBalanceVerified) noteCovered(owner, Number(qncResult.blockHeight));
      if (owner) {
        // The record of a move in transit goes only by a watermark the committee certified (its end on screen came with
        // the live figure).
        const settles = qncOk && isBalanceVerified && !optimistic;
        settleTransit(owner, settles ? qncResult.lastClaimedEpoch : null, settles ? Number(qncResult.blockHeight) : null);
        notePause(owner);
      }

      await Promise.all([solRead, oneDevRead]);
      if (owner && qncOk && isBalanceVerified && !optimistic && !gone()) {
        keepBalances(owner, { balance: qncToApply, balanceNano: qncResult.balanceNano, blockHeight: qncResult.blockHeight }, got);
      }
    } catch (error) {
      // Retry once after a delay if network error
      if (error.message && (error.message.includes('fetch') || error.message.includes('network'))) {
        later(() => {
          if (wallet && wallet.publicKey) {
            loadBalance(wallet.publicKey);
          }
        }, 2000);
      }
    }
  };

  // The address socket's next try (requestPace.socketRetryMs): after a drop, a wait drawn evenly up to a cap that
  // doubles with each failure in a row, 5 minutes at most; after a refusal (closed before it opened: the node's limit of
  // connections, or no network), at least 5 minutes more. No-op after unmount (guard=false), and it dedups its own timer
  // so onerror→close→onclose can't stack reconnects or storm the node set.
  const scheduleWsReconnect = (opened = true) => {
    if (!wsShouldReconnectRef.current) return;
    if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
    const delay = socketRetryMs(wsFailuresRef.current++, { opened });
    wsNextAtRef.current = Date.now() + delay;
    wsReconnectTimerRef.current = setTimeout(() => { wsReconnectTimerRef.current = null; connectWebSocket(); }, delay);
  };

  // An account event for the open wallet (the node's BalanceUpdate on account:{address}: a block at `height` touched
  // it) is a hint, never a figure: ACCOUNT_EVENT_MS later the live figure is read, again while the figure shown is of a
  // state before the newest event's block (a genesis node behind the one that sent it), ACCOUNT_EVENT_READS reads at
  // most; then the token rows, History and the kept transaction now due (sendKeptDue). An event while a follow runs
  // raises its block instead of starting it over, so a wallet touched in every block still gets to the end of each.
  const followAccountEvent = (owner, height) => {
    const running = wsEventRef.current;
    if (running.active && running.owner === owner) {
      running.target = Math.max(running.target, height);
      return;
    }
    if (running.timer) clearTimeout(running.timer);
    const ev = { timer: null, active: true, owner, target: height };
    wsEventRef.current = ev;
    let reads = 0;
    const step = () => {
      ev.timer = setTimeout(async () => {
        ev.timer = null;
        reads += 1;
        await readLiveFigure(owner);
        if (wsEventRef.current !== ev || currentOwnerRef.current !== owner) { ev.active = false; return; }
        const shown = liveFloor(owner);
        if (!(shown && shown.blockHeight >= ev.target) && reads < ACCOUNT_EVENT_READS) return step();
        ev.active = false;
        loadQrcTokens(owner);
        loadTxHistory();
        sendKeptDue(owner);
      }, ACCOUNT_EVENT_MS);
    };
    step();
  };

  // The socket closes with nothing scheduled (the app went to the background, the wallet changed or locked).
  const closeWebSocket = () => {
    if (wsReconnectTimerRef.current) { clearTimeout(wsReconnectTimerRef.current); wsReconnectTimerRef.current = null; }
    if (wsEventRef.current.timer) clearTimeout(wsEventRef.current.timer);
    wsEventRef.current = { timer: null };
    wsLiveRef.current = false;
    if (wsRef.current) {
      wsRef.current.onclose = null; wsRef.current.onerror = null; // teardown must not trigger a reconnect
      try { wsRef.current.close(); } catch (_) {}
      wsRef.current = null;
    }
  };

  // Only in front: the background closes it (the effect below), and the return to the app opens it again.
  const connectWebSocket = () => {
    wsShouldReconnectRef.current = true; // (re-)arm; cleanup disarms on unmount/wallet-switch
    if (AppState.currentState !== 'active') return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;
    const myAddress = wallet?.qnetAddress || '';
    if (!myAddress) return;

    // Genesis nodes only: the subscription names this wallet's address.
    const httpNodes = walletManager.getTrustedNodes(5);
    if (!httpNodes || httpNodes.length === 0) {
      scheduleWsReconnect(); // no nodes yet
      return;
    }

    // /ws/subscribe?channels=… (the node reads the channels from the URL): this wallet's own address only, never the
    // feed of every block, which wakes every open app at once for transactions of others.
    const channels = `account:${myAddress}`;
    const wsNodes = httpNodes.map(url => {
      const wsBase = url.replace('http://', 'ws://').replace('https://', 'wss://');
      return `${wsBase}/ws/subscribe?channels=${encodeURIComponent(channels)}`;
    });
    const wsUrl = wsNodes[Math.floor(Math.random() * wsNodes.length)];
    
    if (!wsUrl) {
      scheduleWsReconnect();
      return;
    }

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        wsLiveRef.current = false;
        wsFailuresRef.current = 0; // a good connection starts the count again
        logger.log('[WS] connected');
      };

      // The node's account event, {"type":"BalanceUpdate","data":{"address","block_height"}}, comes once per block that
      // touched this wallet (a native balance, the fee wallet, a token transfer). It carries no amount: it starts a
      // read (followAccountEvent), and once one came this connection counts as live, so Assets and History poll less
      // often. No event sets a balance, adds a row or marks a transaction confirmed on its own say-so.
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const body = data && data.type === 'BalanceUpdate' ? data.data : null;
          if (wsRef.current !== ws || !body || String(body.address || '').toLowerCase() !== myAddress.toLowerCase()) {
            return;
          }
          const height = Number.isSafeInteger(body.block_height) && body.block_height > 0 ? body.block_height : 0;
          wsLiveRef.current = true;
          followAccountEvent(myAddress, height);
        } catch (e) {
          // Parse error - ignore
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) { wsRef.current = null; wsLiveRef.current = false; }
        scheduleWsReconnect(opened); // guarded + backed-off; no-op after unmount
      };

      ws.onerror = () => {
        try { ws.close(); } catch (_) {} // → onclose → scheduleWsReconnect (single schedule)
      };
    } catch (e) {
      // WS not available - polling will handle it
    }
  };

  // The address socket only while the app is in front: closed on the way to the background, opened again on the return
  // (not before the wait a refusal or a failure set).
  useEffect(() => {
    if (!wallet?.qnetAddress) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        closeWebSocket();
      } else if (next === 'active' && !wsRef.current && !wsReconnectTimerRef.current && wsShouldReconnectRef.current) {
        const wait = wsNextAtRef.current - Date.now();
        if (wait > 0) {
          wsReconnectTimerRef.current = setTimeout(() => { wsReconnectTimerRef.current = null; connectWebSocket(); }, wait);
        } else {
          connectWebSocket();
        }
      }
    });
    return () => sub.remove();
  }, [wallet?.qnetAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  // History = the explorer archive (whole history, paged) + one node (the freshest rows, and the
  // fallback when the explorer is down) + node lifecycle rows from the registry, merged into what is
  // already on screen rather than replacing it. See utils/txHistory.
  const fetchExplorerHistory = async (address, cursor) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const q = `limit=${HISTORY_PAGE}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const r = await fetch(`${EXPLORER_API}/api/address/${address}/history?${q}`, { method: 'GET', signal: ctl.signal });
      if (!r.ok) return null;
      const body = await r.json();
      return body && body.success && Array.isArray(body.items) ? body : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // Decimals/symbol for the ✓ badge come from the wallet's own added-token list, never from a feed.
  const trustedTokenMetaMap = () => new Map(
    (customTokens || []).map(ct => [String(ct.contract || '').toLowerCase(),
      { decimals: Number(ct.decimals) || 0, symbol: ct.symbol }])
  );

  // The sends of this wallet no source lists yet (utils/txHistory rowsToSettle), asked about by their nonce once a History
  // read's rows are on screen, one ask per row at a time. Each answer goes on its row as the result card's does
  // (withNonceAnswer); with none the row stays Pending. Never throws.
  const settleSentRows = (address, rows) => Promise.all(rows.map(async (r) => {
    const key = String(r.hash).toLowerCase();
    if (settlingRef.current.has(key)) return;
    settlingRef.current.add(key);
    try {
      const s = r.settle;
      const res = await walletManager.resolveSubmitByNonce(s.from, s.nonce, {
        toAddress: s.to || null, amountNano: s.amountNano == null ? null : s.amountNano, kind: s.kind || 'transfer',
        method: s.method || null, recipient: s.recipient || null, amountBase: s.amountBase || null,
      }).catch(() => null);
      const answer = nonceAnswer(res, r.hash);
      if (!answer || lastHistoryAddrRef.current !== address) return;
      setTxHistory((prev) => {
        const next = withNonceAnswer(prev, r.hash, answer);
        if (next.length === prev.length && next.every((row, i) => row === prev[i])) return prev;
        saveCachedHistory(address.toLowerCase(), cacheableHistory(next)).catch(() => {});
        return next;
      });
    } finally {
      settlingRef.current.delete(key);
    }
  }));

  // The rows on screen past the newest the listing reads (`listed`: that read's keys, `tip` its figure's height), looked
  // up by hash after a History read, each once a session once two nodes answered (utils/txHistory lookupLedger,
  // WalletManager.lookedUpHistoryRows). Never throws: a lookup that fails is asked again by a later read.
  const lookUpOlderRows = async (address, listed, tip) => {
    if (!lookupsRef.current || lookupsRef.current.owner !== address) lookupsRef.current = lookupLedger(address);
    const ledger = lookupsRef.current;
    let keys = [];
    let answered = [];
    try {
      const rows = ledger.due(txHistoryRef.current, { listed, tip });
      if (rows.length === 0) return;
      keys = rows.map(listingKey);
      ledger.asking(keys);
      const found = await walletManager.lookedUpHistoryRows(address, rows);
      answered = [...found.answered];
      if (found.listed.size === 0 || lastHistoryAddrRef.current !== address) return;
      setTxHistory((prev) => {
        const next = withListing(prev, found.listed, coveredHeight(address), logsFloorRef.current);
        if (next.every((r, i) => r === prev[i])) return prev;
        saveCachedHistory(address.toLowerCase(), cacheableHistory(next)).catch(() => {});
        return next;
      });
    } catch (_) {
      // Nothing changes; a later read asks again.
    } finally {
      ledger.ended(keys, answered);
    }
  };

  // `fresh`: the user asked (tab opened, pull-to-refresh, wallet loaded, return to the app): the explorer is asked then
  // only. Background refreshes (the timer, a socket event) ask one genesis node, which covers the newest rows.
  // One read of a wallet's history at a time, until its rows are on screen (the proofs after them run on): a call while
  // one runs gets that read, and a fresh call during a background one runs once after its rows, so opening History, its
  // poll, a return to the app and a pull never ask twice at once.
  const loadTxHistory = async (fresh = false) => {
    if (!wallet?.qnetAddress) return undefined;
    const address = wallet.qnetAddress;
    const running = historyRunRef.current;
    if (running && running.address === address) {
      if (running.fresh || !fresh) return running.promise;
      running.after = running.after || running.shown.then(() => loadTxHistory(true));
      return running.after;
    }
    let shown;
    const entry = { address, fresh, after: null, promise: null, shown: new Promise((r) => { shown = r; }) };
    const rowsShown = () => {
      if (historyRunRef.current === entry) historyRunRef.current = null;
      shown();
    };
    historyRunRef.current = entry;
    entry.promise = readTxHistory(address, fresh, rowsShown).finally(rowsShown);
    return entry.promise;
  };

  // `rowsShown`: called once the read's rows are merged into the list, before the token proofs run.
  const readTxHistory = async (address, fresh, rowsShown) => {
    try {
      const myAddress = address.toLowerCase();
      const apiUrl = walletManager.trustedNodeUrl(); // history is not proven: a genesis node, not a third party
      const nodeJson = (path) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5000);
        return fetch(`${apiUrl}${path}`, { method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal })
          .then(r => (r.ok ? r.json() : null)).catch(() => null).finally(() => clearTimeout(timer));
      };
      const [explorerPage, nodeNative, tokenFeed, nodeEventsData] = await Promise.all([
        fresh ? fetchExplorerHistory(address, null) : null,
        nodeJson(`/api/v1/account/${address}/transactions?limit=${HISTORY_PAGE}`),
        walletManager.getAccountTokenTransfers(address, HISTORY_PAGE),
        // Node lifecycle comes from the registry: the registration TX leaves the tx index a day later.
        nodeJson(`/api/v1/account/${address}/node-events`),
      ]);
      if (lastHistoryAddrRef.current !== address) return;   // the wallet changed while this was in flight
      const nodeTokenEvents = tokenFeed && Array.isArray(tokenFeed.transfers) ? tokenFeed.transfers : [];
      const reportedFloor = tokenFeed ? tokenFeed.oldestAvailable : null;
      if (Number.isSafeInteger(reportedFloor) && (logsFloorRef.current === null || reportedFloor > logsFloorRef.current)) {
        logsFloorRef.current = reportedFloor;
      }

      const archived = explorerPage ? splitExplorerItems(explorerPage.items, address) : { native: [], tokenEvents: [] };

      // Token events from both feeds, one per (hash, log index). The node's row is the one its inclusion proof can bind,
      // and it shows confirmed at once: a node decodes token transfers only of transactions that applied
      // (utils/txHistory tokenRowFromEvent); the explorer's alone says the transfer is on chain by the archive's word.
      const events = new Map();
      for (const ev of archived.tokenEvents) events.set(`${ev.tx_hash}:${ev.log_index}`, ev);
      for (const ev of (nodeTokenEvents || [])) {
        // A source may return rows unrelated to this wallet: only transfers it is a party to.
        if (String(ev.from || '').toLowerCase() !== myAddress && String(ev.to || '').toLowerCase() !== myAddress) continue;
        const k = `${ev.tx_hash}:${ev.log_index}`;
        events.set(k, { ...ev, archived: !!events.get(k)?.archived, reported: true });
      }
      const trusted = trustedTokenMetaMap();
      const tokenTxs = [...events.values()].map(ev => tokenRowFromEvent(ev, myAddress, trusted));
      const tokenHashes = new Set(tokenTxs.map(row => row.hash));

      // A node's rows are 'reported' until the archive's row for the same transaction replaces them.
      const nodeTxs = (nodeNative && Array.isArray(nodeNative.transactions) ? nodeNative.transactions : [])
        .map(tx => nodeNativeRow(tx, myAddress));
      // The explorer row first: it carries the fee the chain debited. A ContractCall a token event already
      // represents is dropped (no duplicate "0 QNC" row); any other contract call stays.
      const nativeTxs = [...archived.native, ...nodeTxs]
        .filter(tx => !(tx.txType === 'ContractCall' && tokenHashes.has(tx.hash)));

      // Only a list of events is the registry's answer: a refusal (a rate limit's body) or an error keeps the node events
      // on screen, as no answer does, so a registration they settle never turns Unverified again.
      const nodeEvents = nodeEventsData && Array.isArray(nodeEventsData.events) ? nodeEventsData.events : null;
      const nodeEventTxs = (nodeEvents || []).map((ev) => nodeEventRow(
        { nodeId: ev.node_id, nodeType: ev.node_type, height: ev.height, timestamp: ev.timestamp }, myAddress));

      // Nothing answered: what is on screen is the best record there is.
      if (!explorerPage && !nodeNative && !nodeEvents && tokenTxs.length === 0) return;

      // The span the explorer page vouches for: all of history on its last page, down to its oldest row
      // otherwise. Without the explorer nothing already shown is dropped.
      const archivedTimes = [...archived.native, ...tokenTxs.filter(row => row.status !== 'pending')].map(row => row.timestamp || 0);
      const coveredFromMs = !explorerPage ? Infinity
        : (explorerPage.next_cursor && archivedTimes.length ? Math.min(...archivedTimes) : 0);
      if (explorerPage && historyCursorRef.current === undefined) historyCursorRef.current = explorerPage.next_cursor || null;

      // What genesis nodes list (receive labels, wallet-galc plan P1): an archive row is 'unverified' and one node's
      // 'reported' until two genesis nodes list it alike; received QNC is in the balance once the wallet's live figure
      // covers its block, and an archive row whose block the nodes' index no longer reaches is in a block (utils/txHistory
      // withListing). Asked on a refresh the user asked for, and on any other that brought a row one node reports which no
      // earlier read found listed (the extension asks on every History read).
      const covered = coveredHeight(address);
      const listedBefore = new Set((txHistoryRef.current || []).filter((row) => row.listed).map((row) => String(row.hash).toLowerCase()));
      const unlisted = nativeTxs.some((row) => row.status === 'reported' && !listedBefore.has(String(row.hash).toLowerCase()));
      const listed = fresh || unlisted ? await walletManager.agreedHistoryRows(address).catch(() => null) : null;
      if (lastHistoryAddrRef.current !== address) return;

      // Each send from here that no source lists yet is asked about by its nonce once the rows are on screen
      // (settleSentRows): it may have landed under fifty newer rows, or as a hedged copy under another hash.
      const freshRows = withListing([...nativeTxs, ...tokenTxs, ...nodeEventTxs], listed, covered, logsFloorRef.current);
      const unsettled = rowsToSettle(txHistoryRef.current, freshRows, { myAddress });

      // The rows kept from earlier reads are judged too, by the newest figure's height now (withListing).
      const coveredNow = coveredHeight(address);
      setTxHistory(prev => {
        const merged = withListing(mergeHistory(prev, freshRows, {
          myAddress, coveredFromMs, nowMs: Date.now(), nodeEventsOk: nodeEvents !== null,
        }), null, coveredNow, logsFloorRef.current);
        saveCachedHistory(myAddress, cacheableHistory(merged)).catch(() => {});
        return merged;
      });
      // A received transfer in a block the figure read last does not cover yet: the live figure is read now, whatever tab
      // reads History, and its block height credits it (noteCovered).
      if (freshRows.some((row) => row.status === 'included')) readLiveFigure(address);
      rowsShown();
      settleSentRows(address, unsettled);
      lookUpOlderRows(address, listed, coveredNow);

      // In the background, each token transfer's inclusion against a committee-QC-anchored logs_root, for the rows of
      // a block whose logs the genesis nodes still keep (utils/txHistory tokenRowsToProve: by block, never the clock),
      // until a verdict is final (withProofVerdicts); 'consistent' and 'pending' change nothing and are asked again.
      const provable = tokenRowsToProve(tokenTxs, txHistoryRef.current, coveredNow, logsFloorRef.current);
      if (provable.length) {
        // After the balance read in flight, and HISTORY_PROOF_CONCURRENCY at a time: each check may walk to an old
        // macroblock, and a balance read on the same parity chain would otherwise wait behind those walks.
        const balanceRead = balanceRunRef.current;
        if (balanceRead && balanceRead.promise) await balanceRead.promise.catch(() => {});
        if (lastHistoryAddrRef.current !== address) return;
        const verdicts = new Map();
        let nextRow = 0;
        const proveRows = async () => {
          while (nextRow < provable.length) {
            const tx = provable[nextRow++];
            // Bind the proof to THIS row's own fields (contract/from/to/amount/kind/std/token_id).
            const row = {
              tx_hash: tx.hash, log_index: tx.tokenLogIndex, contract: tx.tokenContract,
              from: tx.from, to: tx.to, amount: tx.tokenRawAmount, kind: tx.tokenKind,
              std: tx.tokenStd, token_id: tx.tokenId,
            };
            const s = await walletManager.verifyTokenTransferInclusion(row).catch(() => 'pending');
            if (s === 'verified' || s === 'rejected') verdicts.set(historyRowKey(tx), { verdict: s, row: tx });
          }
        };
        await Promise.all(Array.from({ length: Math.min(HISTORY_PROOF_CONCURRENCY, provable.length) }, proveRows));
        const rejected = [...verdicts.values()].filter((v) => v.verdict === 'rejected').length;
        if (rejected > 0) logger.warn(`[WARN][HISTORY] token_row_proof_rejected rows=${rejected}`);
        if (verdicts.size && lastHistoryAddrRef.current === address) {
          setTxHistory((prev) => {
            const next = withProofVerdicts(prev, verdicts);
            if (next.every((r, i) => r === prev[i])) return prev;
            saveCachedHistory(myAddress, cacheableHistory(next)).catch(() => {});
            return next;
          });
        }
      }
    } catch (e) {
      // API error - keep existing history
    }
  };

  // The next older explorer page, when the list is scrolled to its end.
  const loadOlderHistory = async () => {
    const cursor = historyCursorRef.current;
    if (!wallet?.qnetAddress || typeof cursor !== 'string' || historyLoadingOlderRef.current) return;
    const address = wallet.qnetAddress;
    historyLoadingOlderRef.current = true;
    setHistoryLoadingOlder(true);
    try {
      const page = await fetchExplorerHistory(address, cursor);
      if (!page || lastHistoryAddrRef.current !== address || historyCursorRef.current !== cursor) return;
      const myAddress = address.toLowerCase();
      const { native, tokenEvents } = splitExplorerItems(page.items, address);
      const trusted = trustedTokenMetaMap();
      const tokenRows = tokenEvents.map(ev => tokenRowFromEvent(ev, myAddress, trusted));
      const tokenHashes = new Set(tokenRows.map(row => row.hash));
      const rows = [...native.filter(tx => !(tx.txType === 'ContractCall' && tokenHashes.has(tx.hash))), ...tokenRows];
      historyCursorRef.current = page.next_cursor || null;
      // An older page's rows, judged as every other read's (withListing).
      const covered = coveredHeight(address);
      setTxHistory(prev => {
        const merged = withListing(appendHistory(prev, rows), null, covered, logsFloorRef.current);
        saveCachedHistory(myAddress, cacheableHistory(merged)).catch(() => {});
        return merged;
      });
    } finally {
      historyLoadingOlderRef.current = false;
      setHistoryLoadingOlder(false);
    }
  };

  // v3.30: Add pending TX to history
  // `token` (optional) = { contract, symbol, logo, decimals, rawBaseUnits } marks this pending row as a
  // QRC-20 transfer so it renders with the token's icon + amount + symbol (parity with the confirmed
  // row), instead of a native "QNC" row. On confirm, loadTxHistory replaces it with the enriched row.
  // `settle`: the send's (from, nonce) and what it moved, as the confirmation poll takes it, so every History read asks
  // the chain about the row by its nonce until a source lists it (settleSentRows, utils/txHistory rowsToSettle).
  const addPendingTxToHistory = (txHash, to, amount, fee, token, settle = null) => {
    const pendingTx = {
      hash: txHash,
      from: wallet?.qnetAddress || '',
      to: to,
      amount: token && token.contract ? 0 : amount,
      status: 'pending',
      timestamp: Date.now(),
      type: txDirection(wallet?.qnetAddress, to, wallet?.qnetAddress),
      fee: fee,
      ...(settle ? { settle } : {}),
    };
    if (token && token.contract) {
      pendingTx.tokenContract = token.contract;
      pendingTx.tokenSymbol = token.symbol || '';
      pendingTx.tokenLogo = token.logo || '';
      pendingTx.tokenAmountDisplay = fmtTokenBaseUnits(token.rawBaseUnits, token.decimals);
      pendingTx.tokenMetaTrusted = true; // only an added token can be sent: its symbol and decimals are the record's
    }

    setTxHistory(prev => [pendingTx, ...prev.filter(row => row.hash !== txHash)]);
  };

  // v3.30: Update TX status in history
  const updateTxStatus = (txHash, status) => {
    setTxHistory(prev => prev.map(tx => 
      tx.hash === txHash ? { ...tx, status } : tx
    ));
  };

  // A fresh password check, or under the screen lock a credential that has the wallet manager read the vault secret
  // behind a fresh device authentication: the secret never reaches this screen (MVA-R3-03).
  // { ok, password } — or { ok: false } with the refusal already shown.
  const freshCredential = async (typed, reason) => {
    if (deviceAuth) return { ok: true, password: WalletManager.deviceAuthCredential(reason) };
    if (!typed) {
      showAlert(t('error'), t('pw_enter'));
      return { ok: false };
    }
    return { ok: true, password: typed };
  };

  const refusePassword = (r) => {
    if (r && r.cancelled) return; // a prompt the user dismissed: nothing to report
    if (r && r.locked) {
      const s = Math.ceil((r.remainingMs || 0) / 1000);
      showAlert(t('pw_too_many_title'), t('pw_too_many_body', {
        time: s >= 60 ? t('time_min', { n: Math.ceil(s / 60) }) : t('time_sec', { n: s }),
      }));
    } else if (r && r.unrecorded) {
      showAlert(t('error'), t('pw_attempt_unrecorded'));
    } else {
      showAlert(t('error'), t('incorrect_password'));
    }
  };

  // Settings → Export recovery phrase and Export private key: behind a fresh password check (a fresh device
  // authentication under the screen lock), never on a rooted or jailbroken device, shown in its own protected overlay
  // (renderSeedReveal, renderKeyReveal). An accessibility app that did not come with the device can read the words off
  // the screen: named first.
  const exportSeedPhrase = (readersAcknowledged = false) => revealSecret('phrase', readersAcknowledged);
  const exportPrivateKey = (readersAcknowledged = false) => revealSecret('key', readersAcknowledged);
  const closeExport = () => { setShowExportSeed(false); setExportPassword(''); };

  // One reveal at a time: Show does nothing while the check behind it runs, and says it is verifying.
  const revealSecret = async (kind, readersAcknowledged = false) => {
    if (revealBusyRef.current) return;
    revealBusyRef.current = true;
    setRevealBusy(true);
    try {
      await revealSecretNow(kind, readersAcknowledged);
    } finally {
      revealBusyRef.current = false;
      setRevealBusy(false);
    }
  };

  // A reveal refused under the screen lock is the prompt's answer, never a wrong password: the secret went with a
  // removed screen lock (the open session is the one way back), the prompt failed, or iOS refused it only because the
  // app was not in front (nothing to say). A password wallet gets the password's answer.
  const refuseReveal = (r, failed) => {
    if (!deviceAuth || !r || r.locked) { refusePassword(r); return; }
    if (r.cancelled || r.notNow) return;
    if (r.gone) {
      closeExport();
      deviceSecretGone();
      return;
    }
    if (r.unrecorded) showAlert(t('error'), t('unlock_unrecorded'));
    else showAlert(t('error'), t(r.failed ? 'unlock_failed' : failed));
  };

  const revealSecretNow = async (kind, readersAcknowledged) => {
    // Checked now, not taken from launch: a hooking framework attached since then is seen (MPLAT-R3-02).
    const integrity = await deviceIntegrity();
    setDeviceCompromised(!!integrity.compromised);
    if (integrity.compromised) {
      closeExport();
      showAlert(t('seed_blocked_title'), t(kind === 'key' ? 'private_key_blocked_body' : 'seed_blocked_body'));
      return;
    }
    if (readersAcknowledged !== true) {
      const readers = await screenReaderApps();
      if (readers.length > 0) {
        showAlert(
          t('readers_title'),
          t('readers_body', { apps: readers.join(', ') }),
          [
            { text: t('cancel'), style: 'cancel', onPress: closeExport },
            { text: t('readers_show_anyway'), style: 'destructive', onPress: () => { revealSecret(kind, true); } },
          ],
        );
        return;
      }
    }
    const failed = kind === 'key' ? 'err_show_private_key' : 'err_show_phrase';
    const cred = await freshCredential(exportPassword, t(kind === 'key' ? 'auth_show_private_key' : 'auth_show_phrase'));
    if (!cred.ok) return;
    // The account chosen before the password; only its key is derived and shown.
    const account = exportAccount === 'solana' ? 'solana' : 'qnet';
    try {
      const r = kind === 'key'
        ? await walletManager.revealPrivateKeys(cred.password, account)
        : await walletManager.revealMnemonic(cred.password);
      setExportPassword('');
      if (!r || !r.ok) { refuseReveal(r, failed); return; }
      if (kind === 'key' ? !r[account] : !r.mnemonic) {
        showAlert(t('error'), t(failed));
        return;
      }
      // The app left the front, or the wallet locked, while the vault was opening (seconds of key derivation): the
      // secret is not put on screen. `password` is the session of the render that ran Show; a later unlock makes a new
      // one. 'inactive' is not checked: the device-auth prompt itself runs inside the reveal.
      if (AppState.currentState === 'background' || !walletManager.sessionOpen(password)) { setShowExportSeed(false); return; }
      setShowExportSeed(false);
      if (kind === 'key') {
        setKeyReveal({ [account]: r[account] });
      } else {
        setSeedReveal(r.mnemonic.split(' '));
      }
    } catch (error) {
      if (!handleVaultError(error)) showAlert(t('error'), t(failed));
    } finally {
      setExportPassword('');
    }
  };

  // A new password and a new data key (WalletManager.changePassword); the open session keeps working.
  const handleChangePassword = async () => {
    if (!newPassword || newPassword.length < MIN_PASSWORD) {
      showAlert(t('error'), t('pw_new_too_short', { min: MIN_PASSWORD }));
      return;
    }

    if (newPassword !== confirmNewPassword) {
      showAlert(t('error'), t('pw_new_mismatch'));
      return;
    }

    setLoading(true);
    let changed;
    try {
      changed = await walletManager.changePassword(currentPassword, newPassword);
    } catch (error) {
      setLoading(false);
      setCurrentPassword('');
      if (handleVaultError(error)) return;
      if (error && error.lockout) refusePassword(error.lockout);
      else showAlert(t('error'), errorText(t, error, 'err_change_password'));
      return;
    }
    setLoading(false);
    if (changed && changed.biometricOff) setBiometricEnabled(false);
    showAlert(t('success'), changed && changed.biometricOff ? `${t('password_changed')}\n\n${t('pw_changed_bio_off')}` : t('password_changed'));
    setShowChangePassword(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
  };

  const handleToggleBiometric = async () => {
    if (!biometricSupported) {
      showAlert(t('error'), t('biometric_unavailable'));
      return;
    }
    if (biometricEnabled) {
      const ok = await walletManager.disableBiometricUnlock();
      if (ok) {
        setBiometricEnabled(false);
        showAlert('', t('biometric_disabled_msg'));
      }
    } else {
      // The password opens the vault once, to wrap its data key under the biometric key.
      setShowBiometricPasswordPrompt('biometric');
    }
  };

  // The password prompt of Settings: 'biometric' turns on biometric unlock, 'device' moves the wallet to the screen lock.
  const handleConfirmBiometricEnable = async () => {
    if (showBiometricPasswordPrompt === 'device') {
      const pw = biometricPassword;
      setBiometricPassword('');
      setShowBiometricPasswordPrompt(false);
      await switchDeviceUnlock(pw);
      return;
    }
    const r = await walletManager.checkPassword(biometricPassword);
    if (!r.ok) {
      setBiometricPassword('');
      refusePassword(r);
      return;
    }
    const on = await walletManager.enableBiometricUnlock(biometricPassword);
    setBiometricPassword('');
    setShowBiometricPasswordPrompt(false);
    if (on && on.ok) {
      setBiometricEnabled(true);
      showAlert('', t('biometric_enabled_msg'));
    } else if (on && on.unavailable) {
      showAlert(t('error'), t('biometric_unavailable'));
    } else if (!(on && on.cancelled)) {
      // The prompt failed or the vault could not be written: the setting did not change. A refused prompt says nothing.
      showAlert(t('error'), t('err_save_setting'));
    }
  };

  // Everything on screen that belongs to one wallet, back to empty — run whenever the wallet on this
  // device changes (delete, clear, create, import), so nothing of the previous one is shown or used.
  const resetWalletScopedState = (nextQnetAddress = null) => {
    currentOwnerRef.current = nextQnetAddress;
    outcomeRunRef.current++; // a send-outcome resolver of the previous wallet steps aside
    lastHistoryAddrRef.current = null;
    historyCursorRef.current = undefined;
    setTxDetail(null);
    setTokenBalances({ owner: nextQnetAddress, qnc: 0, sol: 0, '1dev': 0 });
    setBalanceStatus({ owner: nextQnetAddress, state: 'idle', at: 0, known: {}, paused: null });
    qncFailsRef.current = { owner: null, count: 0, since: 0 };
    applyTransit(emptyTransit(nextQnetAddress));
    freshFiguresRef.current = { owner: null };
    balanceRunRef.current = null;
    snapshotSavedRef.current = { text: '', at: 0 };
    setBalance(0);
    setBalanceVerified(false);
    setKeptTxs([]);
    setQrcTokens([]);
    setCustomTokens([]);
    setHiddenTokens(new Set());
    // The tokens the previous wallet chose to show (L-11): another wallet starts with none, in memory as on disk.
    shownTokensRef.current = new Set();
    setShownTokens(new Set());
    setTxHistory([]);
    pendingTxRef.current = null;
    if (txPollingRef.current) { clearInterval(txPollingRef.current); txPollingRef.current = null; }
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    setTxResult(null);
    setShowScan(false);
    setShowSendScreen(false);
    setSendingToken(null);
    setSendPicker(null);
    setTokenScreen(null);
    setWalletNode(null);
    setLightNodeStatus(null);
    setLightBalance(null);
    setUseRefusal(null);
    setServerNodeStatus(null);
    setServerEpochs(null);
    setSiteRecord(null);
    nodeRegRef.current = { owner: null, heights: {} };
    // The browser session (pages, cookies, grants in memory) belonged to the previous wallet.
    setDappSheet(null);
    setConnectedSites(null);
    setBrowserStarted(false);
    setBrowserGen((g) => g + 1);
  };

  /**
   * Erases the wallet from this device: the light node stops, every app key except the language and a screen lock's
   * unusable mark goes (WalletManager.ERASE_ALLOW_LIST), every Keychain item and Keystore key goes, and the screen keeps
   * nothing of it for the next wallet (hidden amounts, the hardware-seal warning). Only after a fresh authentication
   * (see callers).
   */
  const eraseWallet = async () => {
    setErasing(true);
    try {
      // The light node stops FIRST and for good: the ping key signs the unbind (with the device record's release), then
      // at once the ping key, the device key, the push token, the wakes and the node records go, so the deleted wallet's
      // node can answer nothing from here again. The network's answer is awaited only once the wallet's own data is gone,
      // for at most a few seconds: a slow network never leaves a wallet half deleted behind a screen that does nothing.
      const { sent } = await stopLightNode({ waitForNetwork: false, forgetDevice: true });
      resetWalletScopedState(null);
      await walletManager.eraseAllData();
      lockSession();
      setBiometricEnabled(false);
      setWalletDeviceAuth(false);
      setVaultProblem(null);
      setHwSeal(null);
      setMasks(NO_MASKS);
      setHasWallet(false);
      loadSettings();
      await Promise.resolve(sent).catch(() => false);
    } finally {
      setErasing(false);
    }
  };

  // Whether this wallet's light node runs on this device (its binding is here): deleting or erasing the wallet, the only
  // way to another wallet on this device, stops it here, which the confirmation says first in one sentence (owner,
  // 11.10). One wallet per device, so a node record here is this wallet's.
  const nodeRunsHere = async () => {
    try {
      const n = await localNode();
      return !!(n && await localBinding(n.nodeId));
    } catch (_) {
      return false;
    }
  };
  // The erase screen (Forgot? Reset the wallet, the recovery screen) says the same when it opens.
  useEffect(() => {
    if (!showEraseConfirm) return undefined;
    let live = true;
    nodeRunsHere().then((here) => { if (live) setEraseNodeHere(here); });
    return () => { live = false; setEraseNodeHere(false); };
  }, [showEraseConfirm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settings → Delete wallet: confirm (with the node sentence when this wallet's node runs here), then a fresh
  // authentication (the password, or the screen lock). The welcome screen that follows says it is done.
  const deleteWallet = async () => {
    const here = await nodeRunsHere();
    showAlert(
      t('delete_wallet'),
      here ? `${t('node_stops_here')}\n\n${t('delete_wallet_confirm')}` : t('delete_wallet_confirm'),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('common_delete'),
          style: 'destructive',
          onPress: async () => {
            if (!deviceAuth) {
              setDeletePassword('');
              setShowDeletePrompt(true);
              return;
            }
            const auth = await deviceAuthenticate(t('auth_delete_wallet'));
            if (!auth.ok && auth.code !== 'not_set') {
              // A prompt that failed (not one the user cancelled) says so: a confirmation never ends in nothing.
              if (auth.code !== 'cancelled') showAlert(t('error'), t('err_delete_wallet'));
              return;
            }
            try {
              await eraseWallet();
            } catch (error) {
              showAlert(t('error'), errorText(t, error, 'err_delete_wallet'));
            }
          }
        }
      ]
    );
  };

  const confirmDeleteWithPassword = async () => {
    const r = await walletManager.checkPassword(deletePassword);
    setDeletePassword('');
    if (!r.ok) {
      refusePassword(r);
      return;
    }
    setShowDeletePrompt(false);
    try {
      await eraseWallet();
    } catch (error) {
      showAlert(t('error'), errorText(t, error, 'err_delete_wallet'));
    }
  };

  /**
   * Erase and restore from the recovery phrase — the lock screen's "Forgot? Reset the wallet" (either lock) and the
   * recovery screen. Typed ERASE, then a fresh device authentication under the screen lock. A forgotten password, or a
   * vault that cannot be read any more (vaultProblem), cannot be checked, so there the typed confirmation is what stands.
   */
  const confirmErase = async () => {
    if (eraseText.trim().toUpperCase() !== 'ERASE') {
      showAlert(t('erase_not_title'), t('erase_type_confirm', { word: 'ERASE' }));
      return;
    }
    if (deviceAuth) {
      const auth = await deviceAuthenticate(t('auth_erase_wallet'));
      if (!auth.ok && auth.code !== 'not_set') {
        // A prompt that failed (not one the user cancelled) says so: a confirmation never ends in nothing.
        if (auth.code !== 'cancelled') showAlert(t('error'), t('err_erase_wallet'));
        return;
      }
    }
    setShowEraseConfirm(false);
    setEraseText('');
    try {
      await eraseWallet();
    } catch (error) {
      showAlert(t('error'), errorText(t, error, 'err_erase_wallet'));
      return;
    }
    // Erased to be restored: the import opens on its own.
    await startImport({ fresh: true });
  };

  // Terms of Service Modal
  const renderTermsModal = () => {
    if (!showTermsModal) return null;
    
    return (
      <Modal
        visible={showTermsModal}
        animationType="fade"
        transparent={true}
        supportedOrientations={MODAL_ORIENTATIONS}
        onRequestClose={() => setShowTermsModal(false)}
      >
        <View style={styles.termsModal}>
          <Sheet
            t={t}
            title={t('terms_title')}
            onClose={() => setShowTermsModal(false)}
            height="86%"
            actions={(
              <ActionPair
                start={{ label: t('decline'), onPress: () => { setShowTermsModal(false); setTermsAccepted(false); } }}
                end={{ label: t('accept'), onPress: () => { setShowTermsModal(false); setTermsAccepted(true); } }}
              />
            )}
          >
            <Text style={styles.termsModalText}>{t('terms_text')}</Text>
            {LEGAL_LINKS.slice(0, 2).map(([labelKey, url]) => (
              <Text key={url} style={[styles.termsModalText, styles.termsModalLink]} onPress={() => Linking.openURL(url).catch(() => {})} accessibilityRole="link">
                {t(labelKey)}
              </Text>
            ))}
          </Sheet>
        </View>
      </Modal>
    );
  };

  // Custom alert (styled like extension). Every screen renders it, so an alert raised before the wallet opens is shown too.
  const renderCustomAlert = () => {
    if (!customAlert) return null;
    // A way out reads as a text button, what cannot be undone in Ember, the one answer that goes on as the solid one.
    const solidAt = customAlert.buttons.findIndex((b) => b.style !== 'cancel' && b.style !== 'destructive');
    const kindOf = (button, index) => (button.style === 'destructive' ? 'destructive' : (index === solidAt ? 'solid' : 'text'));
    return (
      <Sheet
        t={t}
        level="alert"
        title={customAlert.title}
        actions={(
          <ActionRow>
            {customAlert.buttons.map((button, index) => (
              <Action
                key={index}
                kind={kindOf(button, index)}
                align="center"
                label={button.text}
                onPress={() => {
                  setCustomAlert(null);
                  if (button.onPress) button.onPress();
                }}
              />
            ))}
          </ActionRow>
        )}
      >
        <Text style={styles.modalContent}>{customAlert.message}</Text>
      </Sheet>
    );
  };

  // ── In-app browser ──────────────────────────────────────────────────────────────────────────────────
  // Settings → Connected sites reads the same sealed grants the browser uses (browser/grants).
  const credentialRef = useRef('');
  credentialRef.current = password;
  const grantStore = useMemo(
    () => createGrantStore(walletManager, () => credentialRef.current, { dev: __DEV__ }), [walletManager]);

  const loadConnectedSites = () => {
    grantStore.list().then(setConnectedSites, () => setConnectedSites([]));
  };

  useEffect(() => {
    if (activeTab === 'settings' && wallet) loadConnectedSites();
  }, [activeTab, wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  const revokeSite = async (origin) => {
    try {
      if (browserRef.current) await browserRef.current.revoke(origin);
      else await grantStore.remove(origin);
    } catch (_) { /* the list below shows what is stored */ }
    loadConnectedSites();
  };

  // A send confirmed on a browser sheet: the balance and history follow it like any other send.
  const onDappSent = () => {
    if (wallet && wallet.publicKey) loadBalance(wallet.publicKey);
    loadTxHistory(true);
  };

  // `confirmLabel`: the destructive button's text ("Clear" unless the browser names another action).
  const confirmBrowserAction = (title, message, onConfirm, confirmLabel) => showAlert(title, message, [
    { text: t('cancel'), style: 'cancel' },
    { text: confirmLabel || t('browser_clear_confirm'), style: 'destructive', onPress: onConfirm },
  ]);

  // A tap on a tab shows its first page with nothing over it. A result on screen goes as its Done makes it go; one the
  // Browser tab kept out of sight comes up first, over the tab tapped, on what it was raised over. Assets leaves its
  // forms, token screen, picker, Receive and detail (goAssetsHome), every other tab a detail over it; Browser keeps the
  // page it shows when switched to, and goes to its start page when tapped while open. Node and Settings open nothing
  // else the bar can reach: their sheets and prompts cover it.
  const selectTab = (tab) => {
    setShowHeaderMenu(false);
    if (tab === 'browser') setBrowserStarted(true);
    // A switch reads through the tab's own effect (once, not twice); a tap on the tab already open reads it again.
    if (tab === activeTab && tab === 'assets' && wallet && wallet.publicKey) loadBalance(wallet.publicKey);
    if (tab === activeTab && tab === 'history') loadTxHistory(true);
    if (txResult && activeTab === 'browser' && tab !== 'browser') { setActiveTab(tab); return; }
    if (txResult && activeTab !== 'browser') dismissTxResult();
    if (tab === 'assets') { goAssetsHome(); return; }
    setTxDetail((d) => (d && d.tab === tab ? null : d));
    if (tab === 'browser' && activeTab === 'browser' && browserRef.current) browserRef.current.goHome();
    setActiveTab(tab);
  };

  // What the header's More holds (Settings is a tab of the bottom bar); on the Browser tab the browser bar's More.
  const walletMenuItems = [
    { label: t('tok_manage'), onPress: () => { setShowHeaderMenu(false); setTokenMgrQuery(''); setShowTokenManager(true); } },
    { label: t('tok_hide_balances'), toggle: { value: balancesHidden, onValueChange: () => toggleMask('balances') }, divider: true },
    { label: t('node_hide_names'), toggle: { value: namesHidden, onValueChange: () => toggleMask('names') } },
  ];

  // The browser pane. It is the first child of every screen the open (or locked) wallet can show, under one
  // key, so switching tabs, locking and unlocking keep its pages; it covers the tab content area when its tab
  // is open and is invisible and untouchable otherwise.
  const renderBrowserPane = (where) => {
    if (!browserStarted || !hasWallet) return null;
    const shown = where === 'main' && activeTab === 'browser' && !!wallet && !!contentFrame;
    return (
      <View
        key={`qnet-browser-${browserGen}`}
        style={[
          styles.browserPane,
          contentFrame ? { top: contentFrame.y, height: contentFrame.height } : null,
          !shown && styles.browserPaneHidden,
        ]}
        pointerEvents={shown ? 'auto' : 'none'}
        importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
        accessibilityElementsHidden={!shown}
      >
        <BrowserScreen
          ref={browserRef}
          visible={shown && !linkRequest}
          wallet={wallet}
          credential={wallet ? password : ''}
          walletManager={walletManager}
          t={t}
          onSheet={setDappSheet}
          confirmAction={confirmBrowserAction}
          onSent={onDappSent}
          walletMenu={walletMenuItems}
          dev={__DEV__}
        />
      </View>
    );
  };

  // The review of a send (MPLAT-R5-01). Never drawn over a QNet Link request, which ends it (MOBLINK-R5-01).
  const renderSendReview = () => {
    if (!sendReview || !wallet || linkRequest) return null;
    return (
      <SendReview
        review={sendReview}
        t={t}
        onCancel={() => resolveSendReview(false)}
        onConfirm={() => resolveSendReview(true)}
      />
    );
  };

  // While a QNet Link request is on screen no browser sheet is drawn (its requests end as rejected: see the effect
  // on linkRequest), so the verified aiqnet.io request is always the top layer and takes every touch (MOBLINK-R2-03).
  const renderDappSheet = () => {
    if (!dappSheet || !wallet || linkRequest) return null;
    return (
      <DappSheet
        key={dappSheet.view.id}
        view={dappSheet.view}
        actions={dappSheet.actions}
        t={t}
        authenticate={confirmFresh}
        accounts={{ qnet: wallet.qnetAddress, solana: wallet.solanaAddress || wallet.address }}
      />
    );
  };

  // Screens that show or take a secret: the recovery phrase (shown, checked, typed), any password field. Every screen
  // can be captured (a photo of it is the user's own choice); overlays and non-assistive accessibility services are
  // kept out. Declared before the early returns below, as every hook must be.
  const secretScreen = !!seedReveal || !!keyReveal
    || (!hasWallet && !!showCreateOptions)
    || showSeedConfirm
    // The lock screen is secret only while a password is typed on it; under the device's screen lock it holds nothing.
    || (hasWallet && !wallet && !deviceAuth)
    || showExportSeed || showChangePassword || showBiometricPasswordPrompt
    || showDeletePrompt || showEraseConfirm || !!freshPrompt;
  // They and the screens whose taps move value or approve a request: the send form (with its pending-choice and
  // fresh-check dialogs on top), a browser site's sheet, aiqnet.io's QNet Link request.
  useProtectedInteraction(secretScreen || showSendScreen || !!dappSheet || !!linkRequest);

  // The revealed recovery phrase: shown at once after the check, its Copy button under it (components/ui/SecretCopy,
  // the words themselves copy nothing), then Done, as the extension shows it; the one warning is said before the
  // password. Gone on Done, on lock and on leaving the app.
  const renderSeedReveal = () => {
    if (!seedReveal) return null;
    return (
      <Sheet
        t={t}
        title={t('export_recovery_phrase')}
        actions={<Action label={t('common_done')} onPress={() => setSeedReveal(null)} testID="seed-reveal-done" />}
      >
        {renderSeedWords(seedReveal)}
        <SecretCopy secret={seedReveal.join(' ')} label={t('secret_copy_phrase')} t={t} testID="seed-copy" />
      </Sheet>
    );
  };

  const closeKeyReveal = () => { setKeyReveal(null); };

  // The revealed private key: shown at once after the check, the key of the account chosen before the
  // password (the QNet wallet key or the Solana key) under its name with the form it is written in, in a box, its Copy
  // button under it (components/ui/SecretCopy), then Done, as the extension shows it; the one warning is said before
  // the password. No hold to show, no address. Gone on Done, on lock and on leaving the app. Importing a wallet by a
  // private key is not offered: a wallet is restored from its phrase.
  const renderKeyReveal = () => {
    if (!keyReveal) return null;
    const blocks = KEY_ACCOUNTS.filter(([which]) => keyReveal[which]);
    return (
      <Sheet
        t={t}
        title={t('export_private_key')}
        actions={<Action label={t('common_done')} onPress={closeKeyReveal} testID="key-reveal-done" />}
      >
        {blocks.map(([which, title, format]) => {
          const entry = keyReveal[which] || {};
          return (
            <View key={which} style={styles.keyRevealBlock}>
              <Text style={styles.modalLabel}>{t(title)}</Text>
              {entry.key ? (
                <>
                  <Text style={styles.keyRevealFormat}>{t(format)}</Text>
                  <View style={styles.keyRevealBox}>
                    <Text style={styles.keyRevealKey} selectable={false} testID={'key-shown-' + which}>{entry.key}</Text>
                  </View>
                  <SecretCopy secret={entry.key} label={t('secret_copy_key')} t={t} testID={'key-copy-' + which} />
                </>
              ) : (
                <Text style={styles.modalWarning}>{t('private_key_unavailable')}</Text>
              )}
            </View>
          );
        })}
      </Sheet>
    );
  };

  // Type ERASE, then (under the screen lock) a fresh device authentication: erase this wallet and restore it from its
  // phrase.
  const renderEraseConfirm = () => {
    if (!showEraseConfirm) return null;
    return (
      <Sheet
        t={t}
        title={t('erase_title')}
        actions={(
          <ActionPair
            start={{ label: t('cancel'), onPress: () => { setShowEraseConfirm(false); setEraseText(''); } }}
            end={{ kind: 'destructive', align: 'center', label: t('erase_button'), onPress: confirmErase }}
          />
        )}
      >
        {eraseNodeHere ? <Text style={styles.modalWarning} testID="erase-node-here">{t('node_stops_here')}</Text> : null}
        <Text style={styles.modalWarning}>{t('erase_warning')}</Text>
        <Text style={styles.modalContent}>{t('erase_type_confirm', { word: 'ERASE' })}</Text>
        <Field
          placeholder="ERASE"
          value={eraseText}
          onChangeText={setEraseText}
          {...CONFIRM_INPUT_PROPS}
        />
      </Sheet>
    );
  };

  // A password wallet: the password asked again (confirmFresh) — every send, and relaxing a security setting — when
  // biometric confirmation is not set up or the user chose the password; with the screen-reading apps named, if any.
  const renderFreshPrompt = () => {
    if (!freshPrompt) return null;
    return (
      <Sheet
        t={t}
        level="alert"
        title={t('fresh_title')}
        actions={(
          <ActionPair
            start={{ label: t('cancel'), onPress: () => resolveFresh(false) }}
            end={{ label: t('common_confirm'), onPress: submitFresh }}
          />
        )}
      >
        <Text style={styles.modalWarning}>{freshPrompt.reason}</Text>
        {freshPrompt.recipient ? (
          <>
            <Text style={styles.modalLabel}>{t('send_review_to')}</Text>
            <Text style={styles.freshRecipient}>{freshPrompt.recipient}</Text>
          </>
        ) : null}
        {freshPrompt.note ? <Text style={styles.modalWarning}>{freshPrompt.note}</Text> : null}
        <Field
          label={t('password')}
          placeholder={t('password')}
          accessibilityLabel={t('fresh_title')}
          value={freshPassword}
          onChangeText={setFreshPassword}
          onSubmitEditing={submitFresh}
          returnKeyType="done"
          {...PASSWORD_INPUT_PROPS}
        />
      </Sheet>
    );
  };

  // A password wallet: Delete wallet asks for the password (counted by the lockout).
  const renderDeletePrompt = () => {
    if (!showDeletePrompt) return null;
    return (
      <Sheet
        t={t}
        level="alert"
        title={t('delete_wallet')}
        actions={(
          <ActionPair
            start={{ label: t('cancel'), onPress: () => { setShowDeletePrompt(false); setDeletePassword(''); } }}
            end={{ kind: 'destructive', align: 'center', label: t('delete_wallet'), onPress: confirmDeleteWithPassword }}
          />
        )}
      >
        <Text style={styles.modalWarning}>{t('delete_enter_password')}</Text>
        <Field
          label={t('password')}
          placeholder={t('password')}
          accessibilityLabel={t('delete_enter_password')}
          value={deletePassword}
          onChangeText={setDeletePassword}
          onSubmitEditing={confirmDeleteWithPassword}
          returnKeyType="done"
          {...PASSWORD_INPUT_PROPS}
        />
      </Sheet>
    );
  };

  // A QNet Link request, over the open wallet (or over the start screen when there is no wallet, which only
  // answers that). Never shown while the wallet is locked; the lock screen says a request is waiting.
  const renderLinkRequest = () => {
    if (!linkRequest) return null;
    const { key, release } = linkRequest;
    const owner = `link:${key}`;
    // The link inbox lets the link go once the user decided or closed its request: a screen made anew then shows
    // nothing of it again.
    const done = () => {
      dropFreshOf(owner);
      release();
      setLinkRequest((r) => (r && r.key === key ? null : r));
    };
    // The Node side of the request, for the open wallet (none while there is no wallet: the request answers only that).
    const node = wallet && !LEGACY_MOVE ? nodeLinkActions({
      walletManager, credential: password, serverNode: !!serverNodeOf(walletNode, wallet.qnetAddress),
      // A move running (the Node tab's or a sheet's), or one in transit to the wallet: another one waits for it.
      claimBusy: () => movingRef.current || transitTotal(transitRef.current) > 0,
      // An unlink this device confirmed: the Node tab reads the network again.
      onUnlinked: () => { loadLightNodeStatus(); },
      // The sheet's move is the Node tab's run, each part in transit as one from that tab.
      move: startMove,
      // Once it answered, the Node tab reads the node again.
      onMoved: () => {
        loadServerNodeStatus({ rewards: true });
        loadLightNodeStatus({ rewards: true });
      },
      // The sheet's balance read counts only nodes not behind the wallet's claim watermark (ClaimTransit.answerFloor).
      claimFloor: () => claimFloor(wallet.qnetAddress),
      // The height read as the Node tab reads it, also when the request comes before that tab was opened.
      height: () => fetchCachedBlockHeight().then(() => estimatedHeight(heightRead())),
    }) : null;
    return (
      <QNetLinkScreen
        key={key}
        link={linkRequest.link}
        wallet={wallet}
        node={node}
        onPrivacy={() => { Linking.openURL(LEGAL_LINKS[0][1]).catch(() => {}); }}
        onOpenNode={() => { done(); selectTab('node'); }}
        onPlayDialog={(kind) => { showPlayDialog(kind).catch(() => {}); }}
        t={t}
        afterOther={!!linkRequest.afterOther}
        settled={!!linkRequest.settled}
        settledOutcome={linkRequest.outcome || null}
        authenticate={(reason) => confirmFresh(reason, owner)}
        onSettled={() => {
          setLinkRequest((r) => (r && r.key === key ? { ...r, settled: true } : r));
          release();
        }}
        onOutcome={(outcome) => {
          setLinkRequest((r) => (r && r.key === key ? { ...r, settled: true, outcome } : r));
          release();
          // A node being linked, or a binding sent with no answer: its status is read now and then on the linking
          // schedule (linkingSince).
          if (wallet && linkRequest.link.intent === 'link' && outcome && (outcome.status === 'ok' || outcome.unknown)) {
            loadLightNodeStatus();
          }
        }}
        moveOf={(hash) => moveOutcome(transit.owner === (wallet && wallet.qnetAddress) ? transit : null, hash)}
        onGone={() => dropFreshOf(owner)}
        onClose={done}
      />
    );
  };

  // The first read of the stored wallet, and a wallet being deleted: the app's mark where the launch screen left it, and
  // what is happening. No welcome screen of a device without a wallet ever shows before the wallet on it was looked for.
  if (erasing || !walletKnown) {
    return (
      <SafeAreaView style={styles.container} edges={START_EDGES}>
        <StartScreen head={erasing ? <Text style={[styles.subtitle, styles.markLine]}>{t('deleting_wallet')}</Text> : null} />
        {renderCustomAlert()}
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={START_EDGES}>
        {renderBrowserPane('loading')}
        <StartScreen head={<Text style={[styles.subtitle, styles.markLine]}>{t('common_loading')}</Text>} />
        {renderTermsModal()}
        {renderCustomAlert()}
      </SafeAreaView>
    );
  }

  // The wallet data is here but cannot be opened. Nothing is deleted by the app: the user can try again or
  // erase it and restore from the recovery phrase.
  if (vaultProblem) {
    return (
      <SafeAreaView
        style={styles.container}
        edges={SCREEN_EDGES}
      >
        <View style={styles.centerContent}>
          <Text style={styles.title}>{t('qnet_wallet')}</Text>
          <Text style={styles.subtitle}>
            {t(vaultProblem === 'corrupt' ? 'vault_corrupt' : vaultProblem === 'unreadable' ? 'vault_unreadable' : 'vault_device_key')}
          </Text>
          {vaultProblem !== 'unreadable' && (
            <Text style={styles.formNote}>{t('vault_nothing_deleted')}</Text>
          )}
          <Action label={t('common_try_again')} onPress={() => { setVaultProblem(null); checkWalletExists(); }} style={styles.formAction} />
          {/* Storage that cannot be read right now may read again: nothing is offered to erase for that. */}
          {vaultProblem !== 'unreadable' && (
            <Action kind="destructive" label={t('erase_and_restore')} onPress={() => { setEraseText(''); setShowEraseConfirm(true); }} />
          )}
        </View>
        {renderEraseConfirm()}
        {renderCustomAlert()}
      </SafeAreaView>
    );
  }

  // Seed phrase confirmation screen
  if (showSeedConfirm && tempWallet && tempWallet.mnemonic) {
    const words = tempWallet.mnemonic.split(' ');
    const positions = Object.keys(seedConfirmWords).map(Number).sort((a, b) => a - b);
    
    return (
      <SafeAreaView style={styles.container} onTouchStart={handleUserActivity}>
        <ScrollView
          contentContainerStyle={styles.seedConfirmContent}
          showsVerticalScrollIndicator={true}
          bounces={true}
          scrollEnabled={true}
        >
          <Head
            title={t('seed_confirm_title')}
            titleStyle={styles.title}
            backLabel={t('common_back')}
            onBack={() => {
              // Back to the phrase, with no error left over.
              setVerificationError('');
              setShowSeedConfirm(false);
              setShowCreateOptions('show-seed');
            }}
          />
          <Text style={styles.subtitle}>
            {t('seed_confirm_subtitle')}
          </Text>

          {positions.map((pos) => {
            const choices = wordChoices[pos] || [];
            return (
              <View key={pos} style={styles.seedConfirmGroup}>
                <Text style={styles.label}>{t('seed_select_word_label', { n: pos + 1 })}</Text>
                <Tabs
                  role="radio"
                  items={choices.map((word, idx) => ({ key: String(idx), label: word }))}
                  value={String(choices.indexOf(seedConfirmWords[pos]))}
                  onChange={(key) => {
                    setVerificationError('');
                    setSeedConfirmWords({ ...seedConfirmWords, [pos]: choices[Number(key)] });
                  }}
                />
              </View>
            );
          })}

          {verificationError ? <Text style={styles.verificationErrorText}>{verificationError}</Text> : null}

          <Action
            label={t('seed_confirm_create')}
            busy={!!loading}
            busyLabel={t('verifying')}
            onPress={confirmSeedPhrase}
            disabled={!Object.values(seedConfirmWords).every(w => w && w.length > 0)}
          />
        </ScrollView>
        {renderCustomAlert()}
      </SafeAreaView>
    );
  }

  if (!hasWallet) {
    if (!showCreateOptions) {
      return (
        <SafeAreaView
          style={styles.container}
          edges={START_EDGES}
        >
          {/* The mark where the launch screen left it, the app's name and what it is for under it, and the two ways in
              at the foot. */}
          <StartScreen
            field
            head={(
              <>
                <Text style={styles.welcomeTitle} accessibilityRole="header">{t('qnet_wallet')}</Text>
                <Text style={[styles.subtitle, styles.markLine]}>{t('welcome_subtitle')}</Text>
              </>
            )}
          >
            <AnswerAway t={t} style={styles.awayNote} />
            <Action
              label={t('create_new_wallet')}
              style={styles.formAction}
              onPress={() => {
                // Clear all password fields when starting create
                setPassword('');
                setConfirmPassword('');
                setPasswordError('');
                setTermsAccepted(false); // Reset terms
                setShowCreateOptions('create');
              }}
            />

            <Action kind="secondary" label={t('import_wallet')} onPress={() => startImport()} />
          </StartScreen>
          {vaultChecked ? renderLinkRequest() : null}
          {renderCustomAlert()}
        </SafeAreaView>
      );
    }

    if (showCreateOptions === 'create') {
      return (
        <SafeAreaView 
          style={styles.container}
          edges={SCREEN_EDGES}
        >
          <KeyboardAvoidingView style={styles.keyboardAvoid} behavior="padding">
          <ScrollView
            contentContainerStyle={styles.formContent}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
            keyboardShouldPersistTaps="handled"
          >
            <Head
              title={t('create_wallet')}
              titleStyle={styles.title}
              backLabel={t('common_back')}
              onBack={() => {
                setShowCreateOptions(false);
                setPassword('');
                setConfirmPassword('');
                setPasswordError('');
                setTermsAccepted(false); // Reset terms
              }}
            />
            <Text style={styles.subtitle}>
              {deviceAuth ? t('create_protected') : t('create_password_hint', { min: MIN_PASSWORD })}
            </Text>

            {!deviceAuth && (<>
            <Field
              label={t('password')}
              invalid={!!passwordError && typedPassword.length > 0 && typedPassword.length < MIN_PASSWORD}
              placeholder={t('enter_password')}
              {...PASSWORD_INPUT_PROPS}
              value={typedPassword}
              onChangeText={(text) => {
                setPassword(text);
                setPasswordError('');
              }}
            />

            {renderPasswordLength(typedPassword)}

            <Field
              label={t('confirm_password')}
              invalid={!!passwordError && confirmPassword.length > 0 && typedPassword !== confirmPassword}
              placeholder={t('confirm_password')}
              {...PASSWORD_INPUT_PROPS}
              value={confirmPassword}
              onChangeText={(text) => {
                setConfirmPassword(text);
                setPasswordError('');
              }}
            />

            {renderPasswordMatch(typedPassword, confirmPassword)}
            </>)}

            {renderFormError(passwordError, !deviceAuth && matchShown(typedPassword, confirmPassword))}

            {renderTermsRow()}

            <Action
              label={loading ? t('creating') : t('create_wallet')}
              onPress={createWallet}
              disabled={loading || !termsAccepted}
            />
          </ScrollView>
          </KeyboardAvoidingView>
          {renderTermsModal()}
          {renderCustomAlert()}
        </SafeAreaView>
      );
    }

    // Show seed phrase screen (beautiful grid like extension)
    if (showCreateOptions === 'show-seed' && tempWallet) {
      const words = tempWallet.mnemonic.split(' ');
      
      return (
        <SafeAreaView style={styles.container} onTouchStart={handleUserActivity}>
          <ScrollView
            contentContainerStyle={[styles.formContent, styles.seedContent]}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            <Head title={t('seed_save_title')} titleStyle={styles.title} />
            {/* Written down, then checked word by word; only the Copy button under the words puts them on the clipboard. */}
            <Text style={styles.subtitle}>{t('seed_save_body')}</Text>

            {renderSeedWords(words)}
            <SecretCopy secret={words.join(' ')} label={t('secret_copy_phrase')} t={t} style={styles.seedCopy} testID="seed-copy" />

            <Text style={styles.seedWarningText}>{t('seed_never_share')}</Text>

            <Text style={styles.formNote}>{t('seed_copy_warning', { seconds: SECRET_CLIPBOARD_SECONDS })}</Text>

            <Action
              label={t('seed_wrote_it')}
              onPress={() => {
                setShowSeedConfirm(true);
                setShowCreateOptions(false);
              }}
            />
          </ScrollView>
          {renderCustomAlert()}
        </SafeAreaView>
      );
    }

    if (showCreateOptions === 'import') {
      // Step 1: Set password (not under the screen lock — it seals the vault, so import starts at the seed)
      if (importStep === 1 && !deviceAuth) {
        return (
          <SafeAreaView 
            style={styles.container}
            edges={SCREEN_EDGES}
          >
            <KeyboardAvoidingView style={styles.keyboardAvoid} behavior="padding">
            <ScrollView
              contentContainerStyle={styles.formContent}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
              keyboardShouldPersistTaps="handled"
            >
              <Head
                title={t('import_title')}
                titleStyle={styles.title}
                backLabel={t('common_back')}
                onBack={() => {
                  setShowCreateOptions(false);
                  setPassword('');
                  setConfirmPassword('');
                  forgetImportPhrase();
                  setPasswordError('');
                  setTermsAccepted(false); // Reset terms
                  setImportStep(1);
                }}
              />
              <Text style={styles.subtitle}>{t('import_step1', { min: MIN_PASSWORD })}</Text>

              <Field
                label={t('password')}
                invalid={!!passwordError && typedPassword.length > 0 && typedPassword.length < MIN_PASSWORD}
                placeholder={t('enter_password')}
                {...PASSWORD_INPUT_PROPS}
                value={typedPassword}
                onChangeText={(text) => {
                  setPassword(text);
                  setPasswordError('');
                }}
              />

              {renderPasswordLength(typedPassword)}

              <Field
                label={t('confirm_password')}
                invalid={!!passwordError && confirmPassword.length > 0 && typedPassword !== confirmPassword}
                placeholder={t('confirm_password')}
                {...PASSWORD_INPUT_PROPS}
                value={confirmPassword}
                onChangeText={(text) => {
                  setConfirmPassword(text);
                  setPasswordError('');
                }}
              />

              {renderPasswordMatch(typedPassword, confirmPassword)}

              {renderFormError(passwordError, matchShown(typedPassword, confirmPassword))}

              <Action
                label={t('common_next')}
                onPress={async () => {
                  if (!validatePassword()) {
                    return;
                  }
                  if (!(await confirmPhraseScreen())) return;
                  setImportStep(2);
                }}
              />
            </ScrollView>
            </KeyboardAvoidingView>
            {renderTermsModal()}
            {renderCustomAlert()}
          </SafeAreaView>
        );
      }

      // Step 2: Enter seed phrase
      if (importStep === 2 || deviceAuth) {
        return (
          <SafeAreaView
            style={styles.container}
            edges={SCREEN_EDGES}
            onTouchStart={handleUserActivity}
          >
            <KeyboardAvoidingView style={styles.keyboardAvoid} behavior="padding">
            <ScrollView
              contentContainerStyle={styles.formContent}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
              keyboardShouldPersistTaps="handled"
            >
              <Head
                title={t('import_title')}
                titleStyle={styles.title}
                backLabel={t('common_back')}
                onBack={() => {
                  if (deviceAuth) { setShowCreateOptions(false); setPassword(''); setConfirmPassword(''); } // no password step under the screen lock
                  setImportStep(1);
                  forgetImportPhrase();
                  setPasswordError('');
                  setTermsAccepted(false); // Reset terms
                }}
              />
              {/* Under the screen lock there is no password step: the phrase is the only one, with no number. */}
              <Text style={styles.subtitle}>{t(deviceAuth ? 'import_step_phrase' : 'import_step2')}</Text>

              <Field
                placeholder={t('import_placeholder')}
                multiline
                {...SEED_INPUT_PROPS}
                value={seedPhrase}
                onLayout={onSeedFieldShown}
                onChangeText={(text) => {
                  onSeedPhraseChange(text);
                  setPasswordError('');
                  handleUserActivity(); // typing counts as activity for the auto-lock
                }}
              />

              {seedPhrase.trim().length > 0 && (
                <Text style={
                  seedPhrase.trim().split(/\s+/).length === 12 || seedPhrase.trim().split(/\s+/).length === 24
                    ? styles.passwordSuccess
                    : styles.passwordHint
                }>
                  {t('import_word_count_live', { count: seedPhrase.trim().split(/\s+/).length })}
                  {(seedPhrase.trim().split(/\s+/).length === 12 || seedPhrase.trim().split(/\s+/).length === 24) && ' ✓'}
                </Text>
              )}

              {renderFormError(passwordError, seedPhrase.trim().length > 0)}

              {renderTermsRow()}

              <Action
                label={loading ? t('importing') : t('import_title')}
                onPress={importWallet}
                disabled={loading || !termsAccepted}
              />
            </ScrollView>
            </KeyboardAvoidingView>
            {renderTermsModal()}
            {renderCustomAlert()}
          </SafeAreaView>
        );
      }
    }
  }

  if (!wallet) {
    const lockoutSec = Math.ceil(lockoutMs / 1000);
    const lockoutMin = Math.floor(lockoutSec / 60);
    const lockoutDisplay = lockoutMin > 0
      ? t('time_min_sec', { m: lockoutMin, s: lockoutSec % 60 })
      : t('time_sec', { n: lockoutSec });

    return (
      <SafeAreaView
        style={styles.container}
        edges={START_EDGES}
      >
        {renderBrowserPane('locked')}
        {/* A plain lock screen: the app's mark where the launch screen left it, the unlock itself at the
            foot, and the way out for a forgotten unlock as a small link that opens its own confirmation. No erase choice
            stands next to Unlock. The column scrolls when a very large system font makes it taller than its room. */}
        <StartScreen field testID="lock-column">
          {/* A request that waits for the user's decision; a decided one's answer still on its way says so (AnswerAway). */}
          {linkUndecided || solanaLink ? <Text style={styles.lockNote}>{t('link_waiting_unlock')}</Text> : null}
          <AnswerAway t={t} style={styles.awayNote} />
          {/* The apps that can read the screen and act for you, under either lock: a password is typed here, and the
              screen lock's prompt is approved here. */}
          {lockReaders.length > 0 ? (
            <Text style={styles.lockNote}>
              {t(deviceAuth ? 'readers_confirm_note' : 'readers_lock_note', { apps: lockReaders.join(', ') })}
            </Text>
          ) : null}

          {lockoutMs > 0 ? (
            <Text style={styles.lockoutText}>
              {t('unlock_locked_for', { time: lockoutDisplay })}
            </Text>
          ) : deviceAuth ? (
            /* Under the screen lock the system prompt opens by itself (autoUnlockRef: at every start, every lock and
               every auto-lock), so nothing stands under it; once it ended without opening the wallet, Unlock asks again. */
            <>
              {unlockError ? (
                <Text style={styles.lockMessage} testID="unlock-message">{unlockError}</Text>
              ) : null}

              {unlockPrompting ? null : (
                <Action
                  label={loading ? t('unlocking') : t('unlock_wallet')}
                  onPress={handleBiometricUnlock}
                  disabled={loading}
                  testID="unlock-button"
                />
              )}
            </>
          ) : (
            <>
              <StartField
                label={t('password')}
                style={styles.lockField}
                placeholder={t('enter_password')}
                {...PASSWORD_INPUT_PROPS}
                value={typedPassword}
                onChangeText={setPassword}
                onSubmitEditing={unlockWallet}
                returnKeyType="done"
              />

              {unlockError ? (
                <Text style={styles.lockMessage} testID="unlock-message">{unlockError}</Text>
              ) : null}

              <Action
                label={loading ? t('unlocking') : t('unlock_wallet')}
                onPress={unlockWallet}
                disabled={loading}
                testID="unlock-button"
                style={styles.formAction}
              />

              {biometricEnabled && (
                <Action kind="secondary" label={t('biometric_unlock')} onPress={handleBiometricUnlock} />
              )}
            </>
          )}

          {/* A forgotten unlock: the wallet is erased here (typed ERASE, and under the screen lock a fresh device check)
              and restored from its recovery phrase. In the column under the unlock, never while the system prompt is up. */}
          {deviceAuth && unlockPrompting ? null : (
            <Action
              kind="quiet"
              align="center"
              label={t('unlock_forgot_reset')}
              onPress={() => { setEraseText(''); setShowEraseConfirm(true); }}
              testID="unlock-forgot"
              style={styles.lockForgot}
            />
          )}
        </StartScreen>
        {renderEraseConfirm()}
        {renderCustomAlert()}
      </SafeAreaView>
    );
  }

  // What History and a token's own screen list, one entry per transaction (utils/txHistory historyEntries): on QNet the
  // wallet's transactions of every asset (a token sent unasked left off until shown or added, as on Assets), the light
  // node's registration (lightRegistration), a move in transit (services/ClaimTransit); on Solana this device's sends.
  const historyRowVisible = (row) => !row.tokenContract || (row.status === 'pending' && row.tokenMetaTrusted)
    || isTokenShown(row.tokenContract);
  const historyOn = (network) => historyEntries(network === 'qnet'
    ? withNodeEvents(withMoveStates(txHistory, transit.owner === wallet?.qnetAddress ? transit : null).filter(historyRowVisible),
      lightRegistration ? [lightRegistration] : [])
    : solanaSends.sends.map((e) => solanaHistoryRow(e, wallet ? (wallet.solanaAddress || wallet.address) : null)));

  const renderTabContent = () => {
    switch(activeTab) {
      case 'assets':
        // The Solana Send screen (./SolanaSend): SOL or a Solana token the Assets list shows, from the Solana address.
        if (showSendScreen && sendingToken && sendingToken.network === 'solana') {
          return (
            <SolanaSendForm
              t={t}
              owner={wallet.solanaAddress || wallet.address}
              symbol={sendingToken.symbol}
              address={sendAddress}
              onAddress={setSendAddress}
              amount={sendAmount}
              onAmount={setSendAmount}
              request={solanaRequest}
              fromLink={sendFromLink}
              balances={{ SOL: fmtAmount(balance, 9), '1DEV': fmtAmount(tokenBalances['1dev'], 6) }}
              hideAmounts={balancesHidden}
              onBack={closeSendScreen}
              onScan={() => setShowScan(true)}
              known={[...new Set(solanaSends.sends.map((e) => e.to))]}
              reviewSend={(review) => reviewSend(review, sendingToken.form)}
              formOpen={() => sendFormOpen(sendingToken.form)}
              confirmFresh={confirmFresh}
              sign={(message) => walletManager.signSolanaMessage(message, password)}
              onResult={setTxResult}
              onSent={onSolanaSent}
              busy={solanaSending === sendingToken.form}
              onBusy={(on) => setSolanaSending((f) => (on ? sendingToken.form : (f === sendingToken.form ? false : f)))}
            />
          );
        }
        // Show Send Screen (inline, same size as assets)
        if (showSendScreen && sendingToken) {
          // The result of a submitted send renders on the shared full-screen surface (see the root
          // render), so the form below stays mounted underneath and a failure returns straight to it.

          // The fee the chain prepays for this send: a transfer's is fixed, a token call's follows its size.
          const feePreviewNano = !sendingToken?.contract ? TRANSFER_FEE_NANO : (() => {
            try {
              return walletManager.qrc20TransferFeeNano(sendingToken.contract, sendAddress || '',
                walletManager.toBaseUnits(sendAmount || '0', sendingToken.decimals || 0));
            } catch (_) { return null; }
          })();

          // Send Form Screen: the token was chosen before it (the token picker, or a token's own screen), so its title names it.
          return (
            <TabBox key="assets-send" deps={[showSendScreen, sendingToken, sendAddress, sendAmount, sendingTransaction, sendChecking, balancesHidden, language, qrcTokens, hiddenTokens, shownTokens, customTokens, tokenBalances]} render={() => (
            <KeyboardAvoidingView style={styles.keyboardAvoid} behavior="padding">
            <ScrollView
              style={[styles.content, styles.subScreen]}
              contentContainerStyle={[styles.scrollContentContainer, styles.sendScreenContainer]}
              keyboardShouldPersistTaps="handled"
            >
              <Head
                onBack={closeSendScreen}
                backLabel={t('common_back')}
                title={t('send_title', { symbol: sendingToken.symbol })}
                titleStyle={sendingToken.reserved ? styles.tokenWarn : null}
              />

              {/* The balance beside its label, as every figure (components/InfoRow); a token names its contract under it (and
                  one named after QNet is marked as not QNC), as on Assets. */}
              <View style={styles.sendBalanceInfo}>
                <InfoRow label={t('send_available')} value={`${shownBalance(fmtAmount(sendingToken.balance, 5))} ${sendingToken.symbol}`}
                  tone="accent" ltr fit divider={false} />
                {sendingToken.contract ? (
                  <View style={styles.sendBalanceNotes}>
                    <Text style={styles.tokenPrice}>{t('tok_contract_id', { id: contractShortId(sendingToken.contract) })}</Text>
                    {sendingToken.reserved || usesReservedName(sendingToken.symbol, '') ? (
                      <Text style={[styles.tokenPrice, styles.tokenWarn]}>{t('tok_reserved_warning')}</Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
              
              {/* The recipient; on QNet, Scan at the end of its label's line reads a QNet address from a QR code. */}
              <Field
                label={t('send_to_address')}
                placeholder={t(sendingToken.network === 'qnet' ? 'send_placeholder_eon' : 'send_placeholder_address')}
                value={sendAddress}
                onChangeText={onRecipientChange}
                autoCapitalize="none"
                autoCorrect={false}
                end={sendingToken.network === 'qnet' ? (
                  <Action
                    kind="act"
                    label={t('send_scan')}
                    accessibilityLabel={t('scan_title')}
                    onPress={() => { Keyboard.dismiss(); setShowScan(true); }}
                    testID="send-scan"
                  />
                ) : null}
              />

              <Field
                label={t('send_amount')}
                style={styles.amountField}
                placeholder="0.00"
                keyboardType="decimal-pad"
                value={sendAmount}
                onChangeText={validateAmountInput}
                maxLength={20}
              />
              {/* A token takes no more decimals than its own (L-9): said under the field, before Send refuses it. */}
              {sendingToken.contract && (String(sendAmount || '').split('.')[1] || '').length > (Number(sendingToken.decimals) || 0) ? (
                <Text style={[styles.tokenPrice, styles.tokenWarn]} testID="send-amount-decimals">
                  {t('err_AMOUNT_DECIMALS', { decimals: Number(sendingToken.decimals) || 0 })}
                </Text>
              ) : null}

              {/* A share of the balance, as acts in one start-aligned line. */}
              <View style={styles.percentageButtons}>
                {[[25, '25%'], [50, '50%'], [75, '75%'], [100, t('send_max')]].map(([share, label]) => (
                  <Action key={share} kind="act" label={label} onPress={() => setAmountPercentage(share)} />
                ))}
              </View>
              
              {/* The network fee, and the total the balance check charges (amount + fee for QNC; a QRC-20 send pays its fee
                  in QNC, on a line of its own), each beside its label (components/InfoRow). */}
              <View style={styles.sendFigures}>
                <InfoRow label={t('send_network_fee')} value={feePreviewNano == null ? '—' : shownAmount(fmtAmount(feePreviewNano / 1e9, 6), 'QNC')} ltr fit />
                {sendAmount && parseFloat(sendAmount) > 0 ? (
                  <InfoRow
                    label={t('send_total')}
                    value={sendingToken.contract
                      ? [shownAmount(sendAmount, sendingToken.symbol), `+ ${feePreviewNano == null ? '— QNC' : shownAmount(fmtAmount(feePreviewNano / 1e9, 6), 'QNC')}`]
                      : shownAmount(((Math.round(parseFloat(sendAmount) * 1e9) + TRANSFER_FEE_NANO) / 1e9).toFixed(6), sendingToken.symbol)}
                    ltr
                    fit
                    total
                  />
                ) : null}
              </View>
              
              {/* Send: busy, with a spinner, from the tap until the send is over (pressSend). */}
              <Action
                label={t('send_button')}
                busy={sendChecking === sendingToken.form || sendingTransaction}
                busyLabel={sendingTransaction ? t('sending') : t('send_button')}
                busyTestID="send-busy"
                onPress={pressSend}
                disabled={!sendAddress || !sendAmount}
                testID="send-button"
              />
            </ScrollView>
            </KeyboardAvoidingView>
            )} />
          );
        }

        // A token's own screen (TokenScreens), over Assets from its row until Back; a send from it comes back to it.
        if (tokenScreen) {
          const asset = heldAssets(tokenScreen.network).find((a) => a.key === tokenScreen.key);
          if (asset) {
            return (
              <TabBox key={`assets-token-${asset.network}-${asset.key}`} deps={[tokenScreen, tokenBalances, balance, balanceStatus, qrcTokens, hiddenTokens, shownTokens, customTokens, balancesHidden, namesHidden, language, txHistory, solanaSends.sends, transit, lightRegistration]} render={() => (
                <TokenDetail
                  t={t}
                  asset={asset}
                  entries={historyOn(asset.network)}
                  loadFacts={(a, onFacts) => tokenFacts(a, { walletManager, onFacts })}
                  hideAmounts={balancesHidden}
                  hideNames={namesHidden}
                  onBack={() => setTokenScreen(null)}
                  onReceive={() => { setSelectedNetwork(asset.network); setActiveTab('receive'); }}
                  onSend={() => openSendFor(asset)}
                  onOpenTx={(tx) => setTxDetail({ tx, tab: 'assets' })}
                  onMore={asset.network === 'qnet' ? loadOlderHistory : undefined}
                />
              )} />
            );
          }
        }

        // Normal Assets View
        return (
          <TabBox key="assets-normal" deps={[refreshing, wallet, selectedNetwork, tokenBalances, balance, balanceVerified, balanceStatus, qrcTokens, hiddenTokens, shownTokens, customTokens, balancesHidden, keptTxs, language, transit]} render={() => (
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.scrollContentContainer}
            onScroll={handleUserActivity}
            scrollEventThrottle={500}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
            refreshControl={
              <RefreshControl
                refreshing={refreshing.assets}
                onRefresh={() => pullRefresh('assets', () => new Promise((resolve) => {
                  figureWaitersRef.current.push(resolve);
                  Promise.resolve(loadBalance(wallet.publicKey)).catch(() => {}).finally(resolve);
                }))}
                colors={[color.signal]}
                tintColor={color.signal}
              />
            }
          >
            {/* The network shown; a switch reads its balances again. */}
            <Tabs
              items={[{ key: 'qnet', label: CHAIN_NAME }, { key: 'solana', label: 'Solana' }]}
              value={selectedNetwork}
              onChange={(key) => {
                setSelectedNetwork(key);
                if (wallet && wallet.publicKey) {
                  loadBalance(wallet.publicKey);
                }
              }}
            />

            {/* The whole address on one line, shrunk to fit and never cut (ADDRESS_LINE), in one rounded element a tap
                copies (the glyph turns to a tick and Copied stands in the address's place, as on every value:
                components/ui/Copyable). */}
            {(() => {
              const cardAddress = selectedNetwork === 'qnet'
                ? (wallet.qnetAddress || wallet.address)
                : (wallet.solanaAddress || wallet.address);
              return (
                <Copyable
                  key={selectedNetwork}
                  text={cardAddress}
                  style={styles.addressPill}
                  doneStyle={styles.addressPillDone}
                  accessibilityLabel={cardAddress}
                  t={t}
                  testID="address-card"
                >
                  <Text style={styles.addressPillText} {...ADDRESS_LINE}>{cardAddress}</Text>
                </Copyable>
              );
            })()}

            {/* Send and Receive live here (the bottom bar has no tab for them). Send opens the token picker of the network
                shown: no token is chosen for the user. */}
            <ActionPair
              style={styles.assetActions}
              start={{ label: t('assets_receive'), onPress: () => setActiveTab('receive') }}
              end={{ label: t('assets_send'), onPress: () => setSendPicker(selectedNetwork), testID: 'assets-send' }}
            />

            {/* One quiet line, steady while it holds: the network stopped certifying, or QNC reads failed for a sustained
                time (balanceLine); reads that start and end say nothing. */}
            {(() => {
              const line = balanceLine();
              return line ? <Text style={styles.balanceStatusLine} numberOfLines={3} testID="balance-status">{line}</Text> : null;
            })()}

            {/* This wallet's signed transactions that have not settled (MOBNET-R3-01): listed until they do, with
                whether the wallet still sends each by itself, and "Stop sending" where no node holds it. */}
            {selectedNetwork === 'qnet' && keptTxs.length > 0 && (
              <Section title={t('kept_title', { count: keptTxs.length })}>
                {keptTxs.map((p) => (
                  <View key={`kept-${p.nonce}`} style={[styles.tokenItem, sectionStyles.bleed]}>
                    <View style={styles.tokenDetails}>
                      <Text style={styles.keptLine}>{pendingLine(t, p)}</Text>
                      <Text style={styles.tokenPrice}>{keptStatus(p)}</Text>
                    </View>
                    {p.canStop && (
                      <Action kind="destructive" label={t('kept_stop')} onPress={() => { stopKept(p); }} align="end" />
                    )}
                  </View>
                ))}
              </Section>
            )}

            {/* The assets of the network shown (heldAssets: what the token picker offers), each a row (TokenScreens
                AssetRow) whose tap opens its own screen; QNC is off the list while hidden in the token manager; a long
                press hides a token. */}
            <View style={styles.tokenList}>
              {/* Said once for both rows: the Solana network this build uses. */}
              {selectedNetwork === 'solana' ? <Text style={styles.tokenPrice}>{t('solana_devnet')}</Text> : null}
              {heldAssets(selectedNetwork).filter((a) => a.network === 'solana' || a.contract || !hiddenTokens.has('native:qnc')).map((a) => (
                <AssetRow
                  key={a.key}
                  asset={a}
                  t={t}
                  onPress={() => openTokenScreen(a.network, a.key)}
                  onLongPress={a.contract ? () => {
                    Alert.alert(t('tok_hide_title'), a.symbol, [
                      { text: t('cancel'), style: 'cancel' },
                      { text: t('tok_hide'), style: 'destructive', onPress: () => hideToken(a.contract) },
                    ]);
                  } : undefined}
                  testID={`${a.network}-row-${pickId(a)}`}
                />
              ))}
              {selectedNetwork === 'qnet' ? (() => {
                // Tokens sent to this wallet unasked: off the list until the user shows them.
                const unasked = qrcTokens.filter((tk) => tk.contract && !hiddenTokens.has(tk.contract) && !isTokenShown(tk.contract)).length;
                return unasked > 0 ? (
                  <Text style={styles.inlineLink} onPress={() => { setTokenMgrQuery(''); setShowTokenManager(true); }} accessibilityRole="link">
                    {t('tok_unasked_hidden', { count: unasked })}
                  </Text>
                ) : null;
              })() : null}
            </View>

          </ScrollView>
          )} />
        );

      // NOTE: the legacy standalone 'send' tab was removed — sending is handled by the inline
      // Send screen (openSendModal → handleSendTransaction), which supports native QNC and QRC-20.

      case 'receive':
        const currentReceiveAddress = selectedNetwork === 'qnet' 
          ? (wallet.qnetAddress || wallet.address)
          : (wallet.solanaAddress || wallet.address);

        return (
          <TabBox key="receive" deps={[selectedNetwork, wallet, language]} render={() => (
          <ScrollView
            style={[styles.content, styles.subScreen]}
            contentContainerStyle={styles.scrollContentContainer}
            onScroll={handleUserActivity} 
            scrollEventThrottle={500}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            {/* Receive opens from Assets (the bottom bar keeps Assets lit); Back returns there. */}
            <Head onBack={() => setActiveTab('assets')} backLabel={t('common_back')} title={t('receive_title')} />

            {/* The code on white with its quiet zone (a camera needs it), at the column's start; then what the address
                takes, and the address whole in one rounded element a tap copies. */}
            <View style={styles.qrWrapper}>
              <QRCode
                value={currentReceiveAddress || '-'}
                size={176}
                quietZone={24}
                color={color.qrDark}
                backgroundColor={color.qrLight}
              />
            </View>
            <View style={styles.receiveHead}>
              <TokenIcon network={selectedNetwork === 'qnet' ? 'qnet' : 'solana'} symbol={selectedNetwork === 'qnet' ? 'QNC' : 'SOL'} size={24} />
              <Text style={styles.receiveLine}>
                {t(selectedNetwork === 'qnet' ? 'receive_your_qnet' : 'receive_your_solana')}
              </Text>
            </View>
            <Copyable
              key={selectedNetwork}
              text={currentReceiveAddress}
              style={styles.addressPill}
              doneStyle={styles.addressPillDone}
              accessibilityLabel={currentReceiveAddress}
              t={t}
              testID="receive-address"
            >
              <SubjectAddress address={currentReceiveAddress} />
            </Copyable>
          </ScrollView>
          )} />
        );

      // The browser is its own pane (renderBrowserPane), kept while other tabs are shown.
      case 'browser':
        return null;

      case 'history': {
        // Split by network exactly as Assets is, with the same selector, the entries of historyOn under a header for their
        // day (utils/txHistory historySections). No filter chips.
        const onQnet = selectedNetwork === 'qnet';
        const unaskedRows = onQnet ? txHistory.filter((row) => !historyRowVisible(row)).length : 0;
        const listed = historySections(historyOn(selectedNetwork));
        return (
          <TabBox key="history" deps={[txHistory, solanaSends.sends, selectedNetwork, refreshing, balancesHidden, namesHidden, historyLoadingOlder, hiddenTokens, shownTokens, customTokens, language, transit, lightRegistration]} render={() => (
          <FlatList
            key="history-tab"
            style={styles.content}
            contentContainerStyle={styles.scrollContentContainer}
            data={listed}
            extraData={`${balancesHidden}:${namesHidden}:${language}:${selectedNetwork}`}
            keyExtractor={(item, index) => (item.dayHeader ? item.key : (item.hash ? historyRowKey(item) : String(index)))}
            renderItem={({ item }) => (item.dayHeader ? <DayHeader item={item} t={t} />
              : <HistoryRow tx={item} onOpen={openTxDetail} hideAmounts={balancesHidden} hideNames={namesHidden} t={t} />)}
            ListHeaderComponent={
              <>
                <Head title={t('hist_title')} />
                {/* The same network selector as Assets, sharing its choice. */}
                <Tabs
                  items={[{ key: 'qnet', label: CHAIN_NAME }, { key: 'solana', label: 'Solana' }]}
                  value={selectedNetwork}
                  onChange={setSelectedNetwork}
                  testIDPrefix="history-network"
                />
                {unaskedRows > 0 ? (
                  <Text style={styles.inlineLink} onPress={() => { setTokenMgrQuery(''); setShowTokenManager(true); }} accessibilityRole="link">
                    {t('hist_unasked_hidden', { count: unaskedRows })}
                  </Text>
                ) : null}
                {/* Only this device's Solana sends are listed: said once, above the Solana list. */}
                {onQnet ? null : (
                  <Text style={styles.histScope} testID="history-solana-scope">{t('hist_solana_scope')}</Text>
                )}
              </>
            }
            ListEmptyComponent={
              <View style={styles.histEmptyBox}>
                <Text style={styles.histEmpty}>{t('hist_empty')}</Text>
              </View>
            }
            onEndReached={onQnet ? loadOlderHistory : undefined}
            onEndReachedThreshold={0.5}
            ListFooterComponent={onQnet && historyLoadingOlder
              ? <Text style={styles.histLoadingOlder}>{t('hist_loading_older')}</Text>
              : null}
            showsVerticalScrollIndicator={true}
            onScroll={handleUserActivity}
            scrollEventThrottle={500}
            initialNumToRender={14}
            maxToRenderPerBatch={14}
            windowSize={7}
            removeClippedSubviews={true}
            refreshControl={
              <RefreshControl
                refreshing={refreshing.history}
                onRefresh={() => pullRefresh('history', () => loadTxHistory(true))}
                colors={[color.signal]}
                tintColor={color.signal}
              />
            }
          />
          )} />
        );
      }

      case 'node': {
        // The node the genesis nodes name for this wallet: a super or genesis node comes first, with this wallet's own
        // light node under it when the chain lists both; otherwise the light node alone, as the network records it; and
        // a node aiqnet.io recorded for a wallet two genesis nodes say has none (components in NodeTab).
        const owner = wallet?.qnetAddress;
        const named = walletNode && walletNode.owner === owner ? walletNode : null;
        const serverNode = serverNodeOf(named, owner);
        const server = serverNode ? {
          nodeType: serverNode.nodeType, nodeId: serverNode.nodeId, status: serverNodeStatus,
          epochs: serverEpochs && serverEpochs.owner === owner && serverEpochs.nodeId === serverNode.nodeId ? serverEpochs : null,
        } : null;
        const tabNode = !named ? null : (named.none ? 'none' : { nodeId: named.nodeId, nodeType: named.nodeType });
        const light = lightNodeStatus
          ? { ...lightNodeStatus, background: bgState, balanceNano: lightBalance, device: deviceCheck } : null;
        const recorded = siteRecord && siteRecord.owner === owner ? pendingNodeType(siteRecord,
          lightNodeStatus && lightNodeStatus.status && lightNodeStatus.status.onChain === true ? ['light'] : []) : null;
        return (
          <TabBox key="node" deps={[refreshing, walletNode, lightNodeStatus, lightBalance, serverNodeStatus, serverEpochs, siteRecord, currentBlockHeight, processingValidation, nodeUseBusy, useRefusal, balancesHidden, namesHidden, bgState, deviceCheck, language, transit]} render={() => (
          <ScrollView
            key="node-tab"
            style={[styles.content, styles.nodeScroll]}
            contentContainerStyle={styles.scrollContentContainer}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
            onScroll={handleUserActivity}
            scrollEventThrottle={500}
            stickyHeaderIndices={[0]}
            refreshControl={
              <RefreshControl
                refreshing={refreshing.node}
                onRefresh={() => pullRefresh('node', () => Promise.all([
                  loadWalletNode(), refreshHeight(), loadServerNodeStatus({ rewards: true }),
                  loadLightNodeStatus({ rewards: true }), loadSiteRecord({ force: true }),
                ]))}
                colors={[color.signal]}
                tintColor={color.signal}
              />
            }
          >
            {/* The title pinned over the scroll (stickyHeaderIndices) from its top edge, so the tiles pass under it and
                none shows above it. */}
            <View style={styles.stickyHead}>
              <Head title={t('node_title')} />
            </View>
            {LEGACY_MOVE ? (
              <Text style={styles.nodeExplainer}>{t('legacy_move_node')}</Text>
            ) : (
            <NodeTab
              showHead={false}
              t={t}
              server={server}
              light={light}
              walletNode={tabNode}
              recorded={recorded}
              height={currentBlockHeight}
              balancesHidden={balancesHidden}
              namesHidden={namesHidden}
              busy={{ move: processingValidation, use: nodeUseBusy }}
              refusal={useRefusal}
              onMove={handleMoveLightBalance}
              onMoveServer={handleClaimServerNodeRewards}
              onUse={handleUseDevice}
              onPlayDialog={(kind) => { showPlayDialog(kind).catch(() => {}); }}
              onOpenBackground={() => { openBackgroundSettings().catch(() => {}); }}
              nodeTitle={(type) => nodeTitle(t, type)}
              transit={transit.owner === wallet?.qnetAddress ? transit : null}
            />
            )}
          </ScrollView>
          )} />
        );
      }

      case 'settings':
        return (
          <TabBox key="settings" deps={[autoLockTime, language, wallet, biometricSupported, biometricEnabled, deviceCompromised, connectedSites, hwSeal, walletDeviceAuth, deviceAuthAvail]} render={() => (
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.scrollContentContainer}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            <Head title={t('settings')} />

            {/* General Settings */}
            <SettingGroup title={t('general')}>
              {/* Each setting's title and its value on one line (components/InfoRow SettingRow). */}
              <SettingRow
                title={t('auto_lock_timer')}
                subtitle={t('auto_lock_subtitle')}
                value={t(`autolock_${autoLockTime}`)}
                onPress={() => setShowAutoLockPicker(true)}
              />
              <SettingRow
                title={t('language')}
                subtitle={t('language_subtitle')}
                value={languageName(language)}
                onPress={() => setShowLanguagePicker(true)}
              />
              {/* A language of the other direction turns the layout when the app's JS starts again. */}
              {layoutLags(language) ? (
                <View style={styles.layoutNote} testID="layout-restart-note">
                  <Text style={styles.settingSubtitle}>{t('layout_restart_note')}</Text>
                  <Action kind="act" label={t('layout_restart')} onPress={restartForLayout} testID="layout-restart" />
                </View>
              ) : null}
            </SettingGroup>

            {/* Security Settings - Lazy loaded */}
            {activeTab === 'settings' && (
              <SettingGroup title={t('security_options')}>

                {deviceCompromised && (
                  <Text style={[styles.settingSubtitle, styles.settingWarning]}>
                    {t('set_rooted_warning')}
                  </Text>
                )}

                {/* Android, when the Keystore could not seal the vault: a copy of the app's data is protected by
                    the password alone (MVA-R2-04). Every unlock tries the seal again. */}
                {!deviceAuth && hwSeal === 'unsealed' && (
                  <Text style={[styles.settingSubtitle, styles.settingWarning]}>
                    {t('hw_seal_missing')}
                  </Text>
                )}

                {/* A wallet under the screen lock has no password to change. */}
                {!deviceAuth && (
                  <LinkRow title={t('change_password')} onPress={() => setShowChangePassword(true)} />
                )}

                {/* A password wallet on a device with a screen lock that can hold its secret may move there. */}
                {!deviceAuth && deviceAuthAvail && (
                  <LinkRow
                    title={t('set_device_unlock')}
                    onPress={() => { setBiometricPassword(''); setShowBiometricPasswordPrompt('device'); }}
                  />
                )}

                {biometricSupported && !deviceAuth && (
                  <LinkRow
                    title={t('enable_biometric')}
                    onPress={handleToggleBiometric}
                    end={<Toggle value={!!biometricEnabled} onValueChange={() => handleToggleBiometric()} accessibilityLabel={t('enable_biometric')} />}
                  />
                )}

                <LinkRow
                  title={t('export_recovery_phrase')}
                  onPress={() => { setExportWhat('phrase'); setShowExportSeed(true); }}
                />

                {/* The private keys behind the same check as the phrase (WalletManager.revealPrivateKeys). */}
                <LinkRow
                  title={t('export_private_key')}
                  onPress={() => { setExportWhat('key'); setExportAccount('qnet'); setShowExportSeed(true); }}
                  testID="settings-export-key"
                />
              </SettingGroup>
            )}

            {/* Websites this wallet is connected to in the in-app browser; each can be disconnected here. */}
            <SettingGroup title={t('sites_title')}>
              {connectedSites === null ? (
                <Text style={styles.settingSubtitle}>{t('sites_loading')}</Text>
              ) : connectedSites.length === 0 ? (
                <Text style={styles.settingSubtitle}>{t('sites_none')}</Text>
              ) : connectedSites.map((site) => {
                const d = describeOrigin(site.origin);
                const name = d ? `${d.host}${d.port ? `:${d.port}` : ''}` : site.origin;
                return (
                  <LinkRow
                    key={site.origin}
                    title={name}
                    middle
                    note={d && d.idn ? `${site.origin} · ${t('sites_idn')}` : site.origin}
                    noteLines={2}
                    ltrNote
                    end={(
                      <Action
                        kind="act"
                        label={t('sites_revoke')}
                        onPress={() => revokeSite(site.origin)}
                        accessibilityLabel={`${t('sites_revoke')} ${name}`}
                        align="end"
                      />
                    )}
                  />
                );
              })}
            </SettingGroup>

            {/* The networks this build uses: fixed, never a setting (config/nodes SOLANA_CLUSTER). */}
            <SettingGroup title={t('network')}>
              <LinkRow title={t('current_network')} note={`${CHAIN_NAME} testnet · ${t('solana_devnet')}`} />
            </SettingGroup>

            {/* The published texts, one tap from the app (the stores require the privacy policy in-app too). */}
            <SettingGroup title={t('set_legal')}>
              {LEGAL_LINKS.map(([labelKey, url]) => (
                <LinkRow key={url} title={t(labelKey)} accessibilityRole="link" onPress={() => Linking.openURL(url).catch(() => {})} />
              ))}
            </SettingGroup>

            {/* Danger Zone */}
            <SettingGroup title={t('danger_zone')}>
              {/* Locks at once, the same lock as auto-lock: the wallet stays on the device and its node keeps running. */}
              <LinkRow title={t('lock_wallet')} onPress={() => lockSession()} />
              <LinkRow title={t('delete_wallet')} tone="warn" onPress={deleteWallet} />
            </SettingGroup>
          </ScrollView>
          )} />
        );

      default:
        return null;
    }
  };

  const shownResult = txResult ? txResultShown(txResult) : null;

  return (
    <SafeAreaView
      style={styles.container}
      edges={MAIN_EDGES}
      onTouchStart={handleUserActivity}
    >
      {renderBrowserPane('main')}
      <View style={[styles.header, { paddingTop: insets.top }]} onLayout={(e) => setHeaderBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
        <View style={styles.headerRow}>
          <Image source={APP_MARK} style={styles.headerMark} resizeMode="contain" accessibilityIgnoresInvertColors />
          <Text style={styles.wordmark} numberOfLines={1} accessibilityRole="header">{t('qnet_wallet')}</Text>
          {/* More: walletMenuItems. On the Browser tab the browser bar's More holds them, so a screen has one More. */}
          {activeTab === 'browser' ? null : (
            <Action kind="quiet" label={t('common_more')} accessibilityLabel={t('menu_open')} onPress={() => setShowHeaderMenu((v) => !v)} testID="header-more" />
          )}
        </View>
        <AnswerAway t={t} style={styles.headerAway} />
      </View>

      {/* Tab Content (on the Browser tab the browser pane below it shows through, and gets the touches) */}
      <View
        style={styles.tabContentContainer}
        onLayout={(e) => setContentFrame(e.nativeEvent.layout)}
        pointerEvents={activeTab === 'browser' ? 'none' : 'auto'}
      >
        {renderTabContent()}
        {/* A History entry's detail screen, over the tab it was opened from, with Back (screens/HistoryTab). */}
        {txDetail && activeTab === txDetail.tab && !txResult ? (
          <View style={styles.txResultOverlay}>
            <ScrollView style={styles.content} contentContainerStyle={styles.scrollContentContainer} onScroll={handleUserActivity} scrollEventThrottle={500}>
              <TxDetail
                tx={(() => {
                  const [row] = withMoveStates([txDetail.tx], transit.owner === wallet?.qnetAddress ? transit : null);
                  return row.nodeType ? { ...row, nodeTypeTitle: nodeTitle(t, row.nodeType) } : row;
                })()}
                t={t}
                hideAmounts={balancesHidden}
                hideNames={namesHidden}
                onBack={() => setTxDetail(null)}
                onExplorer={handleOpenTx}
              />
            </ScrollView>
          </View>
        ) : null}
        {/* One result surface for every transaction — send, token transfer, claim, activation — so an
            outcome always arrives the same way, over whichever tab started it. */}
        {txResult && activeTab !== 'browser' ? (
          <View style={styles.txResultOverlay}>
            <TxResultCard
              state={txResultState(txResult)}
              status={txResultStatus(txResult)}
              title={txResult.title}
              amount={shownResult.amount}
              symbol={txResult.symbol}
              counterparty={txResult.to}
              counterpartyLabel={txResult.counterpartyLabel}
              source={txResult.move ? t('tx_detail_from_node_balance') : null}
              parts={txResult.run ? txResult.run.parts.length : null}
              note={txResultNote(txResult)}
              hash={shownResult.hash}
              fee={txResult.fee}
              block={shownResult.block}
              onExplorer={shownResult.explorer ? handleOpenTx : null}
              error={txResult.error}
              onAction={dismissTxResult}
              hideAmounts={balancesHidden}
              t={t}
            />
          </View>
        ) : null}
      </View>

      <BottomBar
        active={activeTab}
        onSelect={selectTab}
        t={t}
        hidden={keyboardUp}
      />

      {/* The Send screen's QR scan: a QNet address read goes into the recipient field, where the send is reviewed and
          confirmed as always. */}
      {showScan && showSendScreen && sendingToken && sendingToken.network === 'qnet' && activeTab === 'assets' ? (
        <QrScanSheet
          t={t}
          onAddress={(address) => { setSendAddress(address); setShowScan(false); }}
          onClose={() => setShowScan(false)}
        />
      ) : null}

      {/* The Solana Send screen's QR scan: a Solana address, or a payment request for SOL or a token the wallet lists
          (utils/solanaRequest), fills in the form; the send is reviewed and confirmed as always. */}
      {showScan && showSendScreen && sendingToken && sendingToken.network === 'solana' && activeTab === 'assets' ? (
        <QrScanSheet
          t={t}
          title={t('scan_title_solana')}
          read={(text) => solanaScanToForm(text, SOLANA_TOKENS)}
          onAddress={(value) => { applySolanaScan(value); setShowScan(false); }}
          onClose={() => setShowScan(false)}
        />
      ) : null}

      {/* Change Password Modal */}
      {showChangePassword && (
        <Sheet
          t={t}
          title={t(showChangePassword === 'reprotect' ? 'reprotect_password' : 'change_password')}
          actions={(
            <ActionPair
              start={{
                label: t('cancel'),
                onPress: () => {
                  setShowChangePassword(false);
                  setCurrentPassword('');
                  setNewPassword('');
                  setConfirmNewPassword('');
                },
              }}
              end={{
                label: loading ? t('changing') : t(showChangePassword === 'reprotect' ? 'reprotect_save' : 'change'),
                onPress: showChangePassword === 'reprotect' ? handleReprotectPassword : handleChangePassword,
                disabled: loading,
              }}
            />
          )}
        >
          {/* A wallet whose screen-lock secret is gone has no current password: the open session is the proof. */}
          {showChangePassword === 'reprotect' ? (
            <Text style={styles.modalContent}>{t('reprotect_password_body')}</Text>
          ) : (
            <Field
              label={t('enter_current_password')}
              placeholder={t('password')}
              accessibilityLabel={t('enter_current_password')}
              {...PASSWORD_INPUT_PROPS}
              value={currentPassword}
              onChangeText={setCurrentPassword}
            />
          )}

          <Field
            label={t('enter_new_password', { min: MIN_PASSWORD })}
            placeholder={t('password')}
            accessibilityLabel={t('enter_new_password', { min: MIN_PASSWORD })}
            {...PASSWORD_INPUT_PROPS}
            value={newPassword}
            onChangeText={setNewPassword}
          />
          {renderPasswordLength(newPassword)}

          <Field
            label={t('confirm_new_password')}
            placeholder={t('password')}
            accessibilityLabel={t('confirm_new_password')}
            {...PASSWORD_INPUT_PROPS}
            value={confirmNewPassword}
            onChangeText={setConfirmNewPassword}
          />
          {renderPasswordMatch(newPassword, confirmNewPassword)}
        </Sheet>
      )}

      {/* The header's More menu */}
      {showHeaderMenu && activeTab !== 'browser' && (
        <Menu items={walletMenuItems} onClose={() => setShowHeaderMenu(false)} closeLabel={t('common_close')} top={headerBottom} />
      )}

      {/* Send's token picker (TokenScreens): the asset chosen opens its Send form. */}
      {sendPicker && (
        <TokenPicker t={t} assets={heldAssets(sendPicker)} onPick={openSendFor} onClose={() => setSendPicker(null)} />
      )}

      {/* Token manager: search + per-token visibility + add-by-address; local view only, never touches balances. */}
      {showTokenManager && (
        <Sheet
          t={t}
          title={t('tok_manage')}
          onClose={() => { setShowTokenManager(false); setAddTokenError(''); }}
          height="80%"
          scroll={false}
          bodyStyle={styles.mgrBody}
        >
          <Field
            placeholder={t('tok_search')}
            accessibilityLabel={t('tok_search')}
            value={tokenMgrQuery}
            onChangeText={(q) => { setTokenMgrQuery(q); if (addTokenError) setAddTokenError(''); }}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.mgrSearch}
          />
          {/* Toggle-add feedback (the add-token modal is not used from here). */}
          {addingToken && <Text style={styles.mgrHint}>{t('tok_adding')}</Text>}
          {!!addTokenError && <Text style={styles.mgrError}>{addTokenError}</Text>}
          <FlatList
            data={tokenMgrResults}
            keyExtractor={(tk) => tk.contract}
            keyboardShouldPersistTaps="handled"
            style={styles.mgrList}
            ListEmptyComponent={<Text style={styles.mgrEmpty}>{t('tok_empty')}</Text>}
            renderItem={({ item: tk }) => {
              const isQnc = tk.contract === 'native:qnc';
              const addable = !!tk._addable;
              const visible = !addable && (isQnc ? !hiddenTokens.has(tk.contract) : isTokenShown(tk.contract));
              const reserved = !isQnc && !addable && usesReservedName(tk.symbol, tk.name);
              const title = addable ? `${tk.contract.slice(0, 10)}…${tk.contract.slice(-6)}` : tokenTitle(tk);
              // Its icon (a letter for a token with a contract), the symbol, what it holds, and its contract.
              return (
                <View style={styles.mgrRow}>
                  <TokenIcon network="qnet" symbol={isQnc ? 'QNC' : tk.symbol} contract={isQnc ? null : tk.contract} size={32} style={styles.tokenIcon} />
                  <View style={styles.mgrRowInfo}>
                    <Text style={[styles.mgrRowSym, reserved && styles.tokenWarn]} numberOfLines={1}>{title}</Text>
                    <Text style={addable ? styles.mgrRowNote : styles.mgrRowBal}>{addable ? t('tok_not_tracked') : shownBalance(tokenFigure(tk))}</Text>
                    {!isQnc && !addable ? <Text style={styles.mgrRowId}>{t('tok_contract_id', { id: contractShortId(tk.contract) })}</Text> : null}
                    {reserved ? <Text style={[styles.mgrRowNote, styles.tokenWarn]}>{t('tok_reserved_warning')}</Text> : null}
                  </View>
                  <Toggle
                    accessibilityLabel={title}
                    value={addable ? false : visible}
                    onValueChange={(v) => addable ? (v && handleAddCustomToken(tk.contract)) : setTokenVisible(tk.contract, v)}
                  />
                </View>
              );
            }}
          />
        </Sheet>
      )}

      {/* Add Custom QRC-20 Token Modal */}
      {showAddTokenModal && (
        <Sheet
          t={t}
          title={t('tok_add_title')}
          actions={(
            <ActionPair
              start={{ label: t('cancel'), onPress: closeAddTokenModal, disabled: addingToken }}
              end={{ label: addingToken ? t('adding') : t('common_add'), onPress: handleAddCustomToken, disabled: addingToken }}
            />
          )}
        >
          <Text style={styles.modalContent}>{t('tok_add_body')}</Text>
          <Field
            placeholder={t('tok_contract_placeholder')}
            accessibilityLabel={t('tok_add_title')}
            error={addTokenError || null}
            value={addTokenAddress}
            onChangeText={(txt) => { setAddTokenAddress(txt.trim()); setAddTokenError(''); }}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Sheet>
      )}

      {/* Settings' password prompt: biometric unlock on, or the move to the screen lock */}
      {showBiometricPasswordPrompt && (
        <Sheet
          t={t}
          title={t(showBiometricPasswordPrompt === 'device' ? 'set_device_unlock' : 'enable_biometric')}
          actions={(
            <ActionPair
              start={{ label: t('cancel'), onPress: () => { setShowBiometricPasswordPrompt(false); setBiometricPassword(''); } }}
              end={{
                label: t(showBiometricPasswordPrompt === 'device' ? 'device_unlock_offer_yes' : 'enable_biometric'),
                onPress: handleConfirmBiometricEnable,
              }}
            />
          )}
        >
          {showBiometricPasswordPrompt === 'device' ? (
            <Text style={styles.modalContent}>{t('device_unlock_offer_body')}</Text>
          ) : null}
          <Field
            label={t('enter_current_password')}
            placeholder={t('password')}
            accessibilityLabel={t('enter_current_password')}
            {...PASSWORD_INPUT_PROPS}
            value={biometricPassword}
            onChangeText={setBiometricPassword}
            onSubmitEditing={handleConfirmBiometricEnable}
            returnKeyType="done"
          />
        </Sheet>
      )}

      {/* Export the recovery phrase or the private keys: the same check before either. */}
      {showExportSeed && (
        <Sheet
          t={t}
          title={t(exportWhat === 'key' ? 'export_private_key' : 'export_recovery_phrase')}
          actions={(
            <ActionPair
              start={{ label: t('cancel'), onPress: () => { setShowExportSeed(false); setExportPassword(''); } }}
              end={{
                label: loading || revealBusy ? t('verifying') : t('show'),
                onPress: () => (exportWhat === 'key' ? exportPrivateKey() : exportSeedPhrase()),
                disabled: loading || revealBusy,
              }}
            />
          )}
        >
          <Text style={styles.modalWarning}>
            {t(exportWhat === 'key' ? 'private_key_warning' : 'recovery_phrase_warning')}
          </Text>
          {exportWhat === 'key' && (
            <>
              <Text style={styles.modalLabel}>{t('private_key_account')}</Text>
              <Tabs
                role="radio"
                items={KEY_ACCOUNTS.map(([which, title]) => ({ key: which, label: t(title), testID: 'key-account-' + which }))}
                value={exportAccount}
                onChange={setExportAccount}
              />
              <Text style={styles.keyRevealFormat}>{t(exportAccount === 'solana' ? 'private_key_solana_format' : 'private_key_qnet_format')}</Text>
            </>
          )}

          {!deviceAuth && (
            <Field
              label={t('enter_password_to_reveal')}
              placeholder={t('password')}
              accessibilityLabel={t('enter_password_to_reveal')}
              {...PASSWORD_INPUT_PROPS}
              value={exportPassword}
              onChangeText={setExportPassword}
            />
          )}
        </Sheet>
      )}

      {/* The auto-lock picker: the chosen time carries the Signal bar. */}
      {showAutoLockPicker && (
        <Sheet t={t} title={t('auto_lock_timer')} onClose={() => setShowAutoLockPicker(false)}>
          <Text style={styles.modalSubtitle}>{t('select_inactivity_time')}</Text>
          {AUTO_LOCK_CHOICES.map((time) => (
            <LinkRow
              key={time}
              title={t(`autolock_${time}`)}
              selected={autoLockTime === time}
              accessibilityRole="radio"
              onPress={() => saveAutoLockTime(time)}
            />
          ))}
        </Sheet>
      )}

      {/* The language picker: each language named in its own script, the chosen one with the Signal bar. */}
      {showLanguagePicker && (
        <Sheet t={t} title={t('language')} onClose={() => setShowLanguagePicker(false)}>
          <Text style={styles.modalSubtitle}>{t('language_subtitle')}</Text>
          {LANGUAGES.map((lang) => (
            <LinkRow
              key={lang.code}
              title={lang.name}
              selected={language === lang.code}
              accessibilityRole="radio"
              onPress={() => {
                saveLanguage(lang.code);
                setShowLanguagePicker(false);
              }}
            />
          ))}
        </Sheet>
      )}

      {/* Under the password prompt and the alerts, over everything else. */}
      {renderSendReview()}
      {renderDappSheet()}
      {renderLinkRequest()}
      {renderDeletePrompt()}
      {renderFreshPrompt()}

      {/* Custom Alert Modal (styled like extension) */}
      {renderCustomAlert()}
      {renderSeedReveal()}
      {renderKeyReveal()}
    </SafeAreaView>
  );
};

export default WalletScreen;
