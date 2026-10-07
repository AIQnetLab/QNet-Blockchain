import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
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
  Animated,
  Easing,
  Share,
  FlatList,
  KeyboardAvoidingView,
  BackHandler,
  Keyboard,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Clipboard from '@react-native-clipboard/clipboard'; // addresses and transaction hashes only
import WalletManager, { VaultCorruptError } from '../components/WalletManager';
import { isValidQnetAddress } from '../crypto/WalletIdentity';
import { usesReservedName, contractShortId, tokenVisible, tokenLabel } from '../utils/tokenSafety';
import { DeviceKeyError } from '../crypto/Vault';
import {
  useSecureScreen, useProtectedInteraction, deviceIntegrity, deviceAuthenticate, screenReaderApps, setNativeTexts, bootClock,
  guardSeedField, pasteboardChangeCount, clearPasteboardIfChanged, copySecret, SECRET_CLIPBOARD_SECONDS,
} from '../services/DeviceSecurity';
import { PASSWORD_INPUT_PROPS, SEED_INPUT_PROPS, CONFIRM_INPUT_PROPS, looksPasted } from '../utils/sensitiveInput';
import QRCode from 'react-native-qrcode-svg';
import {
  LAST_ANSWER_KEY,
  selfAttestIfNeeded,
  checkServerNodeStatus,
  getAllNodesByWallet,
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
  signStatusWithPingKey,
  resendPendingBinding,
  enrolAgainIfUnleased,
  nodeCheckState,
  endExpiredLink,
  settleUnansweredKey,
  refreshLeaseFromTab,
  readdressIfOwed,
} from '../services/PushService';
import { readNodeStatus, readLinkPending } from '../services/LightNode';
import { openBackgroundSettings, readBackground } from '../services/BackgroundPriority';
import {
  NODE_STATUS_MS, assetsPollMs, balanceDue, balanceRead, estimatedHeight, historyPollMs, socketRetryMs,
} from '../utils/requestPace';
import { readNodeRecordState, pendingNodeType } from '../services/NodeRecordRead';
import { checkDevice, isThisDevice, showPlayDialog } from '../services/NodeDeviceKey';
import { noteStatus as noteDeviceStatus } from '../services/DeviceEnrolment';
import { nodeLinkActions } from '../services/NodeLinkActions';
import { LEGACY_MOVE, NEW_APP_PLAY_URL, NEW_APP_SITE_URL } from '../config/legacy';
import NodeTab, { linkedHere } from './NodeTab';
import { getRandomGenesisNode, EXPLORER_API, explorerTxUrl, solanaExplorerTxUrl, ONE_DEV_MINT } from '../config/nodes';
import TxResultCard from '../components/TxResultCard';
import { tokenIconUri } from '../components/TokenIcons';
import { DayHeader, HistoryRow, TxDetail, dateTime } from './HistoryTab';
import {
  txDirection,
  HISTORY_PAGE, fmtTokenBaseUnits, historyRowKey, tokenRowFromEvent, splitExplorerItems,
  mergeHistory, appendHistory, cacheableHistory, nodeNativeRow, txLookupState, historyEntries, historySections,
  rowsDueToDrop,
} from '../utils/txHistory';
import { TRANSFER_FEE_NANO, TRANSFER_FEE_QNC } from '../config/fees';
import { amountShare } from '../utils/sendAmount';
import { refusalReason, sendErrorText } from '../utils/txRefusal';
import { GENESIS_WALLETS, genesisWalletMatches } from '../config/genesisWallets';
import { parseLink, takeInitialUrl } from '../services/QNetLink';
import QNetLinkScreen from './QNetLinkScreen';
import BottomBar from '../components/BottomBar';
import QrScanSheet, { ScanIcon } from '../components/QrScanSheet';
import BrowserScreen, { recipientContext } from '../browser/BrowserScreen';
import DappSheet, { formatNano, repeatedPaymentMinutes } from '../browser/DappSheet';
import SendReview, { recipientWarnings } from '../components/SendReview';
import SolanaSendForm, { cleanAmountInput, useSolanaSends } from './SolanaSend';
import { SOLANA_TOKENS, solanaHistoryRow, solanaToken } from '../services/SolanaSend';
import { solanaScanToForm } from '../utils/solanaRequest';
import { groupAddress } from '../utils/addressDisplay';
import { createGrantStore } from '../browser/grants';
import { describeOrigin, handedOverByBrowser } from '../browser/url';
import { mergeTokenBalances, optimisticTokenRow } from '../utils/balanceMerge';
import { autoSendable, refusalHeals } from '../services/PendingTx';
import { loadCachedHistory, saveCachedHistory } from '../services/HistoryCache';
import {
  LANGUAGES, makeT, isRTL, languageName, isSupported, deviceLanguage, setCurrentLanguage, errorText,
} from '../i18n';
import styles from './WalletScreen.styles';
import logger from '../utils/logger';

// Module-level block height cache — shared across all renders, max 1 fetch per 60s.
// Prevents hammering the node API: no matter how many components re-render,
// only one actual network request goes out per minute.
const _blockHeightCache = { height: 0, fetchedAt: 0, inFlight: false };

// The node record is tagged with the wallet that owns it. Records written before the burn path was
// aligned carry the Solana address and newer ones the QNet address, so ownership matches EITHER identity
// of the same wallet - never a loose "any wallet" check, which is what the tag exists to stop.
const walletAddresses = (wallet) => (wallet
  ? [wallet.qnetAddress, wallet.address, wallet.publicKey, wallet.solanaAddress].filter(Boolean) : []);

// A balance read that started less than this long ago serves a new call for the same wallet (WalletScreen loadBalance).
const BALANCE_SHARE_MS = 1000;
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

// A full screen keeps clear of the status bar, the notch and the side insets from the safe area on every device (a
// tablet's status bar, Slide Over and Split View differ from a phone's); the bottom bar keeps clear of the bottom itself.
const SCREEN_EDGES = ['top', 'left', 'right'];
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

// Compact pill toggle: track hugs the knob (28px pill, 22px knob) — same on both platforms.
// Smoothly-animated pill switch: the knob glides (translateX) and the track color eases between
// states instead of snapping. Track 46×28, 3px padding, 22px knob ⇒ travel = 46 − 2·3 − 22 = 18px.
// useNativeDriver:false because the track backgroundColor is interpolated (color isn't native-driven).
const PillToggle = React.memo(function PillToggle({ value, onValueChange }) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: value ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [value, anim]);
  const trackColor = anim.interpolate({ inputRange: [0, 1], outputRange: ['#33475b', '#00d4ff'] });
  const knobX = anim.interpolate({ inputRange: [0, 1], outputRange: [0, 18] });
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={() => onValueChange(!value)}>
      <Animated.View style={{ width: 46, height: 28, borderRadius: 14, padding: 3, justifyContent: 'center',
                              backgroundColor: trackColor }}>
        <Animated.View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#ffffff',
                                transform: [{ translateX: knobX }] }} />
      </Animated.View>
    </TouchableOpacity>
  );
});

// A logo is drawn as-is only when it is a short emoji; text (letters, digits, a URL) gets the one-letter
// avatar instead, which fits the fixed disc it sits in.
function isGlyphLogo(logo) {
  return logo.length > 0 && logo.length <= 8 && !/[A-Za-z0-9]/.test(logo);
}

// The last height read and when (ms), for the epoch clock that counts on from it (requestPace.estimatedHeight).
const heightRead = () => ({ height: _blockHeightCache.height, at: _blockHeightCache.fetchedAt });

async function fetchCachedBlockHeight() {
  const now = Date.now();
  if (_blockHeightCache.height > 0 && now - _blockHeightCache.fetchedAt < 15_000) {
    return _blockHeightCache.height; // Cache hit — no network call
  }
  if (_blockHeightCache.inFlight) {
    // Another fetch is in progress — return stale value rather than duplicate request
    return _blockHeightCache.height;
  }
  _blockHeightCache.inFlight = true;
  try {
    const apiUrl = getRandomGenesisNode();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${apiUrl}/api/v1/height`, { method: 'GET', signal: controller.signal }).finally(() => clearTimeout(t));
    if (resp.ok) {
      const data = await resp.json();
      const h = data.height || data.network_height || data.current_height || data.local_height || 0;
      if (h > 0) {
        _blockHeightCache.height = h;
        _blockHeightCache.fetchedAt = Date.now();
      }
    }
  } catch (_) { /* silent — return cached/zero */ }
  finally { _blockHeightCache.inFlight = false; }
  return _blockHeightCache.height;
}

// Display-format a token amount: fixed precision, then strip meaningless trailing zeros —
// "0.00000" → "0", "1.50000" → "1.5", "1.23456" → "1.23456". DISPLAY-ONLY: never feed this
// into math or input fields (those keep full toFixed precision).
const fmtAmount = (value, decimals) =>
  (Number(value) || 0).toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

// Published by Orrery Group LLC on aiqnet.io; the app shows the same pages, it does not keep its own copy.
// Opened in the system browser with the site's app marker (?from=app): there the site shows its app view, whose
// header leads only to the explorer and the policies, so no link of a store build is a few taps from the activation
// page, the extension or the APK downloads (CROSS-R2-08). The explorer's transaction pages, which every history row
// and result card open, carry the same marker (config/nodes explorerTxUrl, R3-XPD-01).
const LEGAL_LINKS = [
  ['legal_privacy', 'https://aiqnet.io/privacy?from=app'],
  ['legal_terms', 'https://aiqnet.io/terms?from=app'],
  ['legal_support', 'https://aiqnet.io/support?from=app'],
];

// A node type as the app names it ('light' → Light node); a type it does not know is shown as the network names it.
const nodeTitle = (t, type) => (['light', 'super', 'full'].includes(type)
  ? t(`node_title_${type}`) : (type ? String(type) : t('node_title_other')));
// The type of a server (super, genesis) node the wallet has, which takes the Node tab; null for its light node.
const serverNodeTypeOf = (type) => (type && type !== 'light' ? type : null);

const WalletScreen = () => {
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
  const [refreshing, setRefreshing] = useState(false);
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
  
  // Send Screen state (triggered from Assets) - NOT modal, inline screen
  const [showSendScreen, setShowSendScreen] = useState(false);
  const [sendingToken, setSendingToken] = useState(null); // { symbol: 'QNC', balance: 100.0, network: 'qnet' }
  const [showScan, setShowScan] = useState(false); // the QR scan of the Send screen (components/QrScanSheet)
  // A payment request scanned on the Solana Send screen: { address, references, memo } of the recipient it was for.
  const [solanaRequest, setSolanaRequest] = useState(null);
  const [sendingTransaction, setSendingTransaction] = useState(false);
  // A tap on Send is taken at once (pressSend): the button turns busy while the send is checked, reviewed and sent, and
  // the ref keeps a second tap from starting a second set of reads.
  const [sendChecking, setSendChecking] = useState(false);
  const sendGuardRef = useRef(false);
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
  // Where the figures on Assets stand for `owner`: 'updating' while this session's first read runs (nothing is shown
  // for it: the last figures stay on screen), 'fresh' once a QNC read of this session landed, 'stale' when that first
  // read failed. `known` names the figures that are real (read now, or the last verified ones kept from an earlier
  // session): the others show a dash, never a 0 nobody read. `at`: when the QNC figure shown was read.
  const [balanceStatus, setBalanceStatus] = useState({ owner: null, state: 'idle', at: 0, known: {} });
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
  // format character can reorder it, M-5); and the letter of its avatar.
  const tokenTitle = (tk) => tokenLabel(tk.symbol) || tokenLabel(tk.name) || t('tok_default_name');
  const tokenInitial = (tk) => (tokenLabel(tk.symbol) || tokenLabel(tk.name) || 'T').slice(0, 1).toUpperCase();
  const [hiddenTokens, setHiddenTokens] = useState(new Set()); // user-hidden token contracts (spam control)
  const [balancesHidden, setBalancesHidden] = useState(false); // privacy: mask all amounts (persisted)
  const [showHeaderMenu, setShowHeaderMenu] = useState(false); // header ⋮ dropdown
  const [headerBottom, setHeaderBottom] = useState(0); // header's measured bottom edge; the ⋮ menu card opens 12 dp above it
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
  const wsOpenRef = useRef(false);            // the address socket is open now: Assets and History ask less often
  const wsNextAtRef = useRef(0);              // the earliest next try (ms), kept across a stay in the background
  const txHistoryDebounceRef = useRef(null);  // coalesce bursty history refreshes
  const wsBalanceDebounceRef = useRef(null);  // coalesce balance reloads a feed event asks for
  const historyCursorRef = useRef(undefined); // next older explorer page: undefined = not asked yet, null = none left
  const historyLoadingOlderRef = useRef(false);
  const [historyLoadingOlder, setHistoryLoadingOlder] = useState(false);
  // The History row whose detail screen is open (screens/HistoryTab TxDetail), or null.
  const [txDetail, setTxDetail] = useState(null);
  // v3.27: Track Merkle proof verification status for trustless display
  const [balanceVerified, setBalanceVerified] = useState(false);
  const [keptTxs, setKeptTxs] = useState([]); // this wallet's kept transactions (MOBNET-R3-01)
  const [language, setLanguage] = useState('en');
  // Every string on screen comes from the translator (i18n); a new one per language, so memoized rows and tabs
  // follow a change. Arabic lays the screen out right to left.
  const t = useMemo(() => makeT(language), [language]);
  const rtl = isRTL(language);
  const dirStyle = rtl ? styles.dirRtl : styles.dirLtr;
  const backArrow = rtl ? '→' : '←';
  const termsParts = t('terms_accept_template').split('{terms}');
  const [autoLockTime, setAutoLockTime] = useState(DEFAULT_AUTO_LOCK);
  // The revealed recovery phrase lives only here, in its own overlay, never in the generic alert state;
  // locking, leaving the app and closing the overlay all drop it.
  const [seedReveal, setSeedReveal] = useState(null); // string[] | null
  const [seedCopied, setSeedCopied] = useState(false); // the phrase on screen was copied by its Copy button
  const [vaultProblem, setVaultProblem] = useState(null); // null | 'corrupt' | 'device_key' | 'unreadable'
  // Android: whether the device key seals the vault ('sealed' | 'unsealed'); null elsewhere or not known yet.
  const [hwSeal, setHwSeal] = useState(null);
  const [showDeletePrompt, setShowDeletePrompt] = useState(false); // Android: the password before Delete
  const [deletePassword, setDeletePassword] = useState('');
  const [showEraseConfirm, setShowEraseConfirm] = useState(false); // type ERASE, then a fresh authentication
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
  // The revealed private keys ({ qnet, solana }, each { address, key }), in their own overlay like the phrase: a key is
  // on screen only while its box is held, and all of it goes on Done, on lock and on leaving the app.
  const [keyReveal, setKeyReveal] = useState(null);
  const [keyCopied, setKeyCopied] = useState(null); // the key its Copy button copied last
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
        return { ...prev, unknown: false, success: true, title: t('tx_sent_title'), confirmed: true, confirming: false, note: undefined };
      }
      return {
        ...prev, unknown: false, success: false, confirmed: false, confirming: false, title: t('tx_failed_title'),
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
  const [copiedAddress, setCopiedAddress] = useState(''); // Track which address was copied
  const [verificationError, setVerificationError] = useState(''); // Error message for seed verification
  const [currentBlockHeight, setCurrentBlockHeight] = useState(0); // Cached network block height
  const [activatedNodeType, setActivatedNodeType] = useState(null); // The node type this wallet runs or monitors
  const [processingValidation, setProcessingValidation] = useState(false); // Track validation processing
  const movingRef = useRef(false); // a move of a node balance is running (a QNet Link claim waits for it)
  movingRef.current = processingValidation;
  const [nodePseudonym, setNodePseudonym] = useState(''); // Pseudonym/alias for the node
  // Always-current mirror of nodePseudonym for LONG-LIVED closures. The status interval captures
  // loadLightNodeStatus from the render its effect ran in, where nodePseudonym may still be empty. The effect deps
  // deliberately EXCLUDE nodePseudonym (it is set inside the effect's own chain → adding it self-retriggers); a ref
  // gives stale closures the current value without touching deps.
  const nodePseudonymRef = useRef(nodePseudonym);
  useEffect(() => { nodePseudonymRef.current = nodePseudonym; }, [nodePseudonym]);
  // Same reason as above: the foreground handler is installed with [wallet, password] deps, so it must
  // read the CURRENT tab and node type through refs or it would refresh whatever was open at mount.
  const activeTabRef = useRef('assets');
  const activatedNodeTypeRef = useRef(null);
  // This wallet's light node: { nodeId, status (LightNode.readNodeStatus), local (this device's binding), pending,
  // answeredAt }; null until the first read.
  const [lightNodeStatus, setLightNodeStatus] = useState(null);
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
  const currentOwnerRef = useRef(null); // QNet address of the wallet on screen; late reads for another are dropped
  useEffect(() => { if (wallet?.qnetAddress) currentOwnerRef.current = wallet.qnetAddress; }, [wallet]);
  const [serverNodeStatus, setServerNodeStatus] = useState(null); // Super node network status
  // The server node's counted and missed epochs (PushService.getNodeEpochs): { owner, nodeId, counted, missed, at }.
  const [serverEpochs, setServerEpochs] = useState(null);
  // What aiqnet.io records of the wallet's node (services/NodeRecordRead): { owner, state, nodeType }; null until read,
  // and after a read that failed.
  const [siteRecord, setSiteRecord] = useState(null);
  // The height the chain registered each node of the wallet on screen at (node-events): { owner, heights: { id: h } }.
  const nodeRegRef = useRef({ owner: null, heights: {} });
  // Current values for the long-lived loaders (the status interval keeps the closures of the render it started in).
  const serverEpochsRef = useRef(null);
  serverEpochsRef.current = serverEpochs;
  const serverNodeRegisteredRef = useRef(false);
  serverNodeRegisteredRef.current = !!serverNodeTypeOf(activatedNodeType) && !!serverNodeStatus
    && serverNodeStatus.success === true && serverNodeStatus.registered !== false;
  const lightOnChainRef = useRef(false);
  lightOnChainRef.current = !!lightNodeStatus && !!lightNodeStatus.status && lightNodeStatus.status.onChain === true;
  // The light node has a card under a server node: on the chain, or a link of it pending here.
  const lightShownRef = useRef(false);
  lightShownRef.current = lightOnChainRef.current || !!(lightNodeStatus && lightNodeStatus.pending);
  const [loadingAllNodes, setLoadingAllNodes] = useState(false); // Loading state for all nodes
  const [unlockError, setUnlockError] = useState(''); // Error message for unlock screen
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricSupported, setBiometricSupported] = useState(false);
  const [showBiometricPasswordPrompt, setShowBiometricPasswordPrompt] = useState(false);
  const [biometricPassword, setBiometricPassword] = useState('');
  const [lockoutMs, setLockoutMs] = useState(0); // ms remaining in lockout
  const lockoutTimerRef = React.useRef(null);
  // A QNet Link request (screens/QNetLinkScreen): { link, key, settled, seen, afterOther } for a URL the OS delivered
  // that parsed as a link. `settled` once the user decided; only then does locking drop it. `seen` once its screen was
  // up: from then on a different link waits in linkQueueRef until this one is closed (R4-MOBLINK-01).
  const [linkRequest, setLinkRequest] = useState(null);
  const linkQueueRef = useRef(null);
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

  // The explorer's page of a transaction (the detail screen's button): the QNet explorer, or for a Solana send the
  // cluster's public explorer; a page that cannot open leaves the hash copied.
  const handleOpenTx = React.useCallback((hash, chain = 'qnet') => {
    if (!hash) return;
    Linking.openURL(chain === 'solana' ? solanaExplorerTxUrl(hash) : explorerTxUrl(hash)).catch(() => {
      Clipboard.setString(hash);
      setCustomAlert({ title: tRef.current('common_copied'), message: tRef.current('tx_hash_copied'), buttons: [{ text: tRef.current('common_ok'), onPress: () => {} }] });
    });
  }, []);

  // A History row opens its detail screen (stable, so the list's rows never re-bind).
  const openTxDetail = React.useCallback((tx) => { setTxDetail(tx); }, []);


  // Helper function to copy address with visual feedback (no alert)
  const copyToClipboard = (text, addressType = '') => {
    try {
      Clipboard.setString(text);
      setCopiedAddress(addressType || text);
      // Clear the copied indication after 2 seconds
      setTimeout(() => {
        setCopiedAddress('');
      }, 2000);
    } catch (error) {
      // console.error('Failed to copy:', error);
    }
  };

  // The icon of a known asset (components/TokenIcons): the same images the History rows draw.
  const getTokenIconUrl = tokenIconUri;

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

  // QNet Link: URLs come only from the OS (App Links / Universal Links for https://link.aiqnet.io/l; on Android
  // also a site's intent: URL naming this package, which arrives through the same filter as the link itself).
  // One that is not exactly a link opens nothing and fetches nothing. A new link replaces a request not being
  // carried out.
  useEffect(() => {
    const receive = (url) => {
      if (!url) return;
      const tr = tRef.current || ((k) => k);
      // A link that arrives while the in-app browser is on screen and the app has been in front all along did not
      // come from another app: a page of the in-app browser handed it over (iOS tries a tapped universal link on
      // the app itself). Such a request is never opened (MBL-03; the browser also refuses link.aiqnet.io).
      if (handedOverByBrowser(activeTabRef.current, activeSinceRef.current, Date.now(), LINK_FROM_OUTSIDE_MS)) {
        showAlert(tr('link_refused_title'), tr('browser_link_refused'));
        return;
      }
      const link = parseLink(url);
      if (!link) {
        showAlert(tr('link_refused_title'), tr('link_invalid'));
        return;
      }
      // The same link twice (iOS can deliver a cold-start link both ways) is one request. A different link never takes
      // the place of a request the user has seen, whatever its phase (R4-MOBLINK-01): it waits, and is shown once that
      // one is closed, saying that another request arrived. Only a request the user has not seen yet (it waited
      // behind the lock screen, or its screen never came up) is replaced by a newer link.
      setLinkRequest((r) => {
        if (!r) return { link, key: Date.now(), settled: false };
        if (r.link.id === link.id) return r;
        if (!r.seen) return { link, key: Date.now(), settled: false };
        linkQueueRef.current = link;
        return r;
      });
    };
    takeInitialUrl(Linking).then(receive);
    const sub = Linking.addEventListener('url', (e) => receive(e && e.url));
    return () => sub.remove();
  }, []);

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

  // Load node data when on node tab
  // ARCHITECTURE:
  // - Light nodes: App is the node, needs local rewards tracking + network ping status
  // - Super/Genesis: Server is the node, app just monitors via single API call
  // - Load ALL nodes owned by this wallet for unified display
  useEffect(() => {
    if (activeTab === 'node' && wallet && !LEGACY_MOVE) {
      // The "Epoch ends in" row: one height read now and with each status refresh below, counted on here at one block a
      // second in between (CLOCK_TICK_MS, no request).
      refreshHeight();
      const clockTick = setInterval(() => {
        const h = estimatedHeight(heightRead());
        if (h > 0) setCurrentBlockHeight(h);
      }, CLOCK_TICK_MS);

      // Load ALL nodes + specific node data in parallel (not waterfall). A super or genesis node of this wallet comes
      // first; the wallet's own light node, as the network records it, shows too (alone, or under a server node when
      // the chain lists both), and so does what aiqnet.io records of a node the network does not list yet.
      loadAllUserNodes();
      if (serverNodeTypeOf(activatedNodeType)) loadServerNodeStatus();
      loadLightNodeStatus();
      loadSiteRecord({ force: true });
      if (!deviceCheckAskedRef.current) {
        deviceCheckAskedRef.current = true;
        checkDevice().catch(() => ({ capable: false, reason: 'device_unsupported' })).then(setDeviceCheck);
      }

      // Status self-refresh while the tab stays open, every NODE_STATUS_MS (requestPace; opening the tab, pulling it,
      // returning to the app and Use this device read it at once): a node that comes online flips the UI without leaving
      // the tab. Under a server node the light node is read again only while it has a card there (on the chain, or being
      // linked). Nothing is read while the app is not in front.
      const statusInterval = setInterval(() => {
        if (AppState.currentState !== 'active') return;
        refreshHeight();
        const server = !!serverNodeTypeOf(activatedNodeTypeRef.current);
        if (server) loadServerNodeStatus();
        loadSiteRecord();
        if (!server || lightShownRef.current) loadLightNodeStatus({ fresh: false });
      }, NODE_STATUS_MS);

      return () => { clearInterval(clockTick); clearInterval(statusInterval); };
    }
  }, [activeTab, activatedNodeType, wallet]); // load on tab open; NOT nodePseudonym (set here → self-retrigger)

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
      const last = signedStatusAtRef.current;
      // The last signed answer stands only for the binding it was read for: a new binding (Use this device, a link)
      // must never be judged by what the node said about the one before.
      const same = !!local && last.nodeId === nodeId && last.seq === local.seq;
      const sign = !!local && (fresh || !same || Date.now() - last.at >= SIGNED_STATUS_MS);
      const readAt = Date.now();
      // The status is signed with this device's ping key; with none here, or one two owners refuse (a binding that was
      // replaced or withdrawn holds no ping key of this device), the open wallet's key asks instead, so the binding the
      // network holds (B) is known all the same. A background wake never signs with the wallet key (contract 4).
      const walletOpen = () => {
        try { return walletManager.sessionOpen(credentialRef.current) === true; } catch (_) { return false; }
      };
      const walletSign = (id, ts) => (walletOpen() ? walletManager.signNodeStatus(credentialRef.current, id, ts) : null);
      const pingOrWallet = async (id, ts) => (await signStatusWithPingKey(id, ts)) || walletSign(id, ts);
      let status = await readNodeStatus(nodeId, { signStatus: sign ? pingOrWallet : null });
      if (sign && status.keyOurs === false && walletOpen()) {
        status = await readNodeStatus(nodeId, { signStatus: walletSign });
      }
      if (currentOwnerRef.current !== owner) return; // another wallet is on screen now
      if (sign) {
        const verdict = Number.isSafeInteger(status.bindingSeqAgreed)
          ? { bindingSeqAgreed: status.bindingSeqAgreed, deviceBoundAgreed: status.deviceBoundAgreed }
          : (same ? last.verdict : null);
        signedStatusAtRef.current = {
          nodeId, seq: local.seq, at: Date.now(), signed: status.signed, keyOurs: status.keyOurs, signer: status.signer,
          nonce: status.nonce, deviceTags: status.deviceTags, noStatusKey: status.noStatusKey, verdict: verdict || null,
        };
      } else if (same && status.onChain === true) {
        status = {
          ...status, signed: last.signed, keyOurs: last.keyOurs, signer: last.signer || null,
          nonce: last.nonce, deviceTags: last.deviceTags, noStatusKey: last.noStatusKey,
        };
      }
      // No binding sequence in this read (no signed answer, a refused key, no network): the last verdict read for this
      // device's binding stands, both of its halves; with none, the binding stands (NodeTab bindingVerdict).
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
      const pending = await readLinkPending(nodeId);
      // An expired link is shown once as not recorded, then the chain's truth; a binding the network never took goes
      // with it (its ping key, push token and wakes).
      if (pending && pending.expired && await endExpiredLink(nodeId, status, pending)) local = null;
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
      let answeredAt = null;
      try { answeredAt = JSON.parse((await AsyncStorage.getItem(LAST_ANSWER_KEY)) || 'null'); } catch (_) { answeredAt = null; }
      // Whether a device check that waits still runs, ended with no verdict or was refused (NodeTab checkState).
      let check = null;
      if (local && status.signed && status.signed.deviceState === 'check_pending') {
        try { check = await nodeCheckState(nodeId, local.seq); } catch (_) { check = null; }
      }
      const next = { nodeId, status, local, pending, check, answeredAt };
      // "Could not ask" is not "no node": the last verdict stays on screen while the network is unreachable.
      setLightNodeStatus((prev) => (status.onChain === null && !pending && prev && prev.nodeId === nodeId
        && prev.status && prev.status.onChain !== null ? { ...prev, stale: true } : next));
      // The Background row: read again with every status, so a change made in the system settings shows on return.
      readBackground().then((bg) => setBgState((prev) => (JSON.stringify(prev) === JSON.stringify(bg) ? prev : bg)))
        .catch(() => {});
      if (status.onChain === true) loadLightBalance(nodeId, owner, { force: rewards });
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

  // The light node's balance: the largest of three genesis answers (a claim is re-verified on chain against the
  // certified reward root, so an honest node can only under-report). No answer keeps the last figure. Once per epoch and
  // node (requestPace.balanceDue: it changes only when an epoch settles), now when `force` (pull-to-refresh, a move).
  const loadLightBalance = async (nodeId, owner, { force = false } = {}) => {
    const height = estimatedHeight(heightRead());
    if (!force && !balanceDue(lightBalanceReadRef.current, nodeId, height)) return;
    lightBalanceReadRef.current = balanceRead(nodeId, height);
    const answers = (await Promise.all(
      Array.from({ length: 3 }, () => getPendingRewards(nodeId).catch(() => ({ success: false })))
    )).filter(r => r && r.success && r.pendingRewards != null);
    if (answers.length === 0) lightBalanceReadRef.current = null; // the next status read asks again
    if (answers.length > 0 && currentOwnerRef.current === owner) {
      setLightBalance(answers.reduce((m, r) => Math.max(m, r.pendingRewards), 0));
    }
  };
  
  // What aiqnet.io records of this wallet's node, read while the Node tab is open and while the network lists no node of
  // the wallet (then it adds nothing): the state and the node type only. A read that fails keeps the last answer for
  // this wallet, and with none the tab shows what the network says.
  // The status interval backs off while the site says "none" or cannot be read: from SITE_RECORD_FIRST_WAIT_MS, doubling to
  // SITE_RECORD_MAX_WAIT_MS (M14: every open Node tab polled the one site host). A record on its way is read at the
  // interval's pace; opening the tab and pull-to-refresh (`force`) always read.
  const siteRecordPollRef = useRef({ owner: null, wait: 0, nextAt: 0 });
  const loadSiteRecord = async ({ force = false } = {}) => {
    const owner = currentOwnerRef.current;
    if (!owner) return;
    if (serverNodeRegisteredRef.current || lightOnChainRef.current) return;
    const poll = siteRecordPollRef.current;
    if (!force && poll.owner === owner && Date.now() < poll.nextAt) return;
    const record = await readNodeRecordState(owner);
    if (currentOwnerRef.current !== owner) return;
    const idle = !record || record.state === 'none';
    const wait = idle ? Math.min(poll.owner === owner && poll.wait ? poll.wait * 2 : SITE_RECORD_FIRST_WAIT_MS, SITE_RECORD_MAX_WAIT_MS) : 0;
    siteRecordPollRef.current = { owner, wait, nextAt: Date.now() + wait };
    setSiteRecord((prev) => (record ? { owner, ...record } : (prev && prev.owner === owner ? prev : null)));
  };

  // A server node's counted and missed epochs, read only once the chain's registration height of the node is known
  // (node-events), so no epoch before it can read as missed; at most every SERVER_EPOCHS_MS unless `fresh`.
  const loadServerEpochs = async (nodeId, { fresh = false } = {}) => {
    const owner = currentOwnerRef.current;
    const reg = nodeRegRef.current;
    if (!owner || !nodeId || reg.owner !== owner || !Number.isSafeInteger(reg.heights[nodeId])) return;
    const last = serverEpochsRef.current;
    if (!fresh && last && last.owner === owner && last.nodeId === nodeId && Date.now() - last.at < SERVER_EPOCHS_MS) return;
    const epochs = await getNodeEpochs(nodeId, { walletAddress: owner, registeredHeight: reg.heights[nodeId] }).catch(() => null);
    if (currentOwnerRef.current !== owner || !epochs) return;
    setServerEpochs({ owner, nodeId, counted: epochs.counted, missed: epochs.missed, at: Date.now() });
  };

  // Load Server node (Super/Genesis) network status
  // This single API call returns ALL info: status, heartbeats, rewards. The balance is read once per epoch and node
  // (`rewards`: now, as pull-to-refresh and a move ask).
  const loadServerNodeStatus = async ({ rewards = false } = {}) => {
    if (!wallet) return;

    try {
      // QNet address only: a node's reward wallet is an EON address; never fall back to a Solana addr
      // for node resolution (it would query a wallet that backs no node).
      const walletAddress = wallet?.qnetAddress || null;
      // Resolve super/full nodes by WALLET (on-chain canonical) rather than a possibly-stale cached
      // pseudonym: a single lagging node can hold an old pre-registration id and report the wrong name +
      // "offline" while the rest of the network sees the node online under its real id. Light nodes keep
      // their pseudonym.
      const preferWallet = !!walletAddress && activatedNodeType !== 'light';
      const nodeId = preferWallet ? null : (nodePseudonym || null);

      // Quorum: ask several nodes in parallel and keep the AUTHORITATIVE view (online beats offline,
      // then more heartbeats), so one node with a stale wallet→node_id record cannot pin the displayed
      // identity or liveness. Wallet-scoped queries converge because each node maps the wallet to ITS
      // own id and we keep the online one.
      const quorumN = 3;
      const responses = (await Promise.all(
        Array.from({ length: quorumN }, () =>
          checkServerNodeStatus(nodeId, walletAddress, 1).catch(() => null))
      )).filter(r => r && r.success);
      let status;
      if (responses.length > 0) {
        responses.sort((a, b) => {
          if (!!b.isOnline !== !!a.isOnline) return b.isOnline ? 1 : -1;
          return (b.heartbeatCount || 0) - (a.heartbeatCount || 0);
        });
        status = responses[0];
      } else {
        // Nobody answered in the quorum — one plain attempt (its own retries) as a last resort.
        status = await checkServerNodeStatus(nodeId, walletAddress);
      }

      // Which node this tab monitors, shows rewards for and claims for changes only when two genesis nodes confirm
      // the new one, the rule that links a server node (MOBACT-R3-03): one node's by-wallet answer naming another id
      // decides nothing (MOBACT-R5-02). Until then the linked node's own status is shown, asked by its id.
      const linked = nodePseudonym || null;
      let adopt = null;
      if (preferWallet && status && status.success && status.nodeId && status.nodeId !== linked) {
        const confirmed = await walletManager.confirmServerNode(walletAddress, {
          nodeType: activatedNodeType, nodeId: status.nodeId,
        }).catch(() => null);
        if (confirmed === true) {
          adopt = status.nodeId;
        } else {
          const own = linked ? responses.find((r) => r.nodeId === linked) : null;
          status = own || (linked ? await checkServerNodeStatus(linked).catch(() => null) : null)
            || { success: false, error: 'network' };
        }
      }

      // Claimable comes from the dedicated STATUS-INDEPENDENT endpoint (merkle reward-root) by the
      // resolved node_id, so earned rewards show + can be claimed even when the node is offline/banned.
      const resolvedId = status?.nodeId || nodeId;
      const kept = serverRewardsRef.current && serverRewardsRef.current.nodeId === resolvedId ? serverRewardsRef.current : null;
      const height = estimatedHeight(heightRead());
      if (resolvedId && status && !rewards && kept && !balanceDue(kept, resolvedId, height)) {
        status.pendingRewards = kept.value; // read in this epoch already
      } else if (resolvedId && status) {
        // Quorum the claimable (max of a few nodes): a claim proof is re-verified on-chain against the
        // 2f+1 reward_root so no node can inflate it; an honest node only under-reports (local shard lag),
        // so max = the certified amount — routes around a lagging node and removes the pending flicker.
        const prs = (await Promise.all(
          Array.from({ length: 3 }, () => getPendingRewards(resolvedId).catch(() => ({ success: false })))
        )).filter(r => r && r.success && r.pendingRewards != null);
        if (prs.length > 0) {
          status.pendingRewards = prs.reduce((m, r) => Math.max(m, r.pendingRewards), 0);
          serverRewardsRef.current = { ...balanceRead(resolvedId, height), value: status.pendingRewards };
        } else if (kept) {
          status.pendingRewards = kept.value; // hiccup: keep last-known, don't shrink
        } else if (serverNodeStatus?.pendingRewards != null) {
          status.pendingRewards = serverNodeStatus.pendingRewards;
        }
      }

      setServerNodeStatus(status);
      if (status.success && status.nodeId) loadServerEpochs(adopt || status.nodeId);

      if (status.success) {
        AsyncStorage.setItem('qnet_cached_server_status', JSON.stringify({
          ...status,
          cachedAt: Date.now()
        })).catch(() => {});
        // The id two genesis nodes confirmed replaces a stale linked one (an old activation_* id one lagging node
        // still returned), so the displayed name self-heals to the real one; nothing else is ever persisted here.
        if (adopt) {
          setNodePseudonym(adopt);
          walletManager.loadNodeRecord(walletAddresses(wallet))
            .then((rec) => rec && walletManager.saveNodeRecord({ ...rec, pseudonym: adopt }))
            .catch(() => {});
        }
      }
    } catch (error) {
      setServerNodeStatus({ success: false, error: 'network' });
    }
  };
  
  // Load ALL nodes owned by this wallet (unified view for Light + Full + Super + Genesis)
  // Battery optimization: runs once on tab open, no polling
  // Two lists: a genesis node's by-wallet answer, and the chain's registrations of the ids this wallet derives
  // (node-events: its super, light and, for a genesis wallet, genesis id, with the height each was registered at). A
  // server node is linked only once two genesis nodes confirm it (MOBACT-R3-03), whatever the lists say; a light node
  // this wallet had does not stand in its way (the light card stays, under the server card).
  const loadAllUserNodes = async () => {
    if (!wallet || loadingAllNodes) return;

    // CRITICAL: Use QNet address for node lookup (not Solana address)
    const walletAddress = wallet.qnetAddress || wallet.address;
    if (!walletAddress) return; // Silent fail - no address

    setLoadingAllNodes(true);
    try {
      const genesisOwn = Object.keys(GENESIS_WALLETS).find(id => genesisWalletMatches(id, walletAddress)) || null;
      const ids = {
        light: walletManager.generateLightNodePseudonym(walletAddress),
        super: walletManager.generateSuperNodePseudonym(walletAddress),
        genesis: genesisOwn ? `genesis_node_${genesisOwn}` : null,
      };
      const [result, events] = await Promise.all([
        getAllNodesByWallet(walletAddress),
        getWalletNodeEvents(walletAddress, ids).catch(() => ({ success: false })),
      ]);
      if (currentOwnerRef.current && currentOwnerRef.current !== walletAddress) return; // another wallet is on screen now
      if (events.success) {
        nodeRegRef.current = {
          owner: walletAddress, heights: Object.fromEntries(events.nodes.map((n) => [n.nodeId, n.height])),
        };
      }
      // The chain's registered server node of this wallet, by the id the wallet derives (never another's).
      const chainServer = events.success ? events.nodes.find((n) => n.nodeType === 'super') || null : null;

      if (result.success || chainServer) {
        // CRITICAL: Filter out pending_activation nodes — they are NOT real activated nodes
        // Also filter HASH: codes — these are hash references, not activation codes
        const realNodes = ((result.success && result.nodes) || []).filter(n =>
          n.status !== 'pending_activation' &&
          !(n.activation_code && typeof n.activation_code === 'string' && n.activation_code.startsWith('HASH:'))
        );

        // AUTO-LINK: link server nodes found on-chain. Also fires when the type is
        // already set but the pseudonym is unresolved (server-activated super whose
        // name was never cached locally) so the node name resolves from the chain.
        // by-wallet answers "online"/"offline" - liveness, not registration. Testing for "active"
        // matched nothing, so a server node activated elsewhere never linked itself to the wallet.
        // The list already excludes pending_activation, so presence here IS registration.
        const serverNodes = realNodes.filter(n => n.node_type !== 'light');
        if (chainServer && !serverNodes.some((n) => n.node_id === chainServer.nodeId)) {
          serverNodes.unshift({ node_id: chainServer.nodeId, node_type: 'super' });
        }

        // A server node linked earlier (and kept on this device) that two genesis nodes now say this wallet does
        // not have is unlinked (MOBACT-R3-03).
        if (serverNodeTypeOf(activatedNodeType) && !String(nodePseudonym || '').startsWith('genesis_node_')) {
          const still = await walletManager.confirmServerNode(walletAddress, {
            nodeType: activatedNodeType, nodeId: nodePseudonym || null,
          }).catch(() => null);
          if (still === false) {
            setActivatedNodeType(null);
            setNodePseudonym('');
            setServerNodeStatus(null);
            setServerEpochs(null);
            await walletManager.forgetServerNodeRecord();
            AsyncStorage.removeItem('qnet_cached_server_status').catch(() => {});
            return;
          }
        }

        // A light node record kept on this device (an older build linked the light node that way) is no server node:
        // it never keeps a server node of the wallet from being linked.
        if (serverNodes.length > 0 && (!serverNodeTypeOf(activatedNodeType) || !nodePseudonym)) {
          // Priority 1: a genesis node — linked only to its own wallet, as the node credits it. A node's
          // by-wallet answer alone never links one (any node could name any genesis id).
          const genesisNode = serverNodes.find(n => typeof n.node_id === 'string'
            && /^genesis_node_00[1-5]$/.test(n.node_id) && genesisWalletMatches(n.node_id.slice(-3), walletAddress));
          if (genesisNode) {
            const bootstrapId = genesisNode.node_id.slice(-3);
            linkGenesisNode(bootstrapId, walletAddress);
            try {
              const status = await checkServerNodeStatus(genesisNode.node_id);
              setServerNodeStatus(status);
              if (status.success) {
                AsyncStorage.setItem('qnet_cached_server_status', JSON.stringify({
                  ...status, cachedAt: Date.now()
                })).catch(() => {});
              }
            } catch (e) {
              // Will show "Connecting to node..." in UI
            }
            loadServerEpochs(genesisNode.node_id, { fresh: true });
            return; // Don't process other nodes if Genesis found
          }

          // Priority 2: a server (super) node registered on chain for this wallet, monitored by its id — linked only
          // once two genesis nodes each confirm it (MOBACT-R3-03): one node's listing alone could hide this wallet's
          // own light node behind a server node it does not have. The id the wallet derives comes first.
          const serverNode = serverNodes.find(n => n.node_id === ids.super)
            || serverNodes.find(n => !String(n.node_id || '').startsWith('genesis_node_'));
          const serverConfirmed = serverNode
            ? await walletManager.confirmServerNode(walletAddress, {
              nodeType: serverNode.node_type, nodeId: serverNode.node_id || null,
            }).catch(() => null)
            : null;
          if (serverNode && serverConfirmed === true) {
            const nodeId = serverNode.node_id || serverNode.pseudonym || '';
            setActivatedNodeType(serverNode.node_type);
            setNodePseudonym(nodeId);
            walletManager.saveNodeRecord({ nodeType: serverNode.node_type, pseudonym: nodeId, walletAddress })
              .catch(() => {});
            if (nodeId) {
              try {
                const status = await checkServerNodeStatus(nodeId);
                setServerNodeStatus(status);
                if (status.success) {
                  AsyncStorage.setItem('qnet_cached_server_status', JSON.stringify({
                    ...status, cachedAt: Date.now()
                  })).catch(() => {});
                }
              } catch (e) {
                // Will show "Connecting to node..." in UI
              }
              loadServerEpochs(nodeId, { fresh: true });
            }
          }
        } else if (serverNodeTypeOf(activatedNodeType) && nodePseudonym) {
          loadServerEpochs(nodePseudonym);
        }

        // A genesis wallet links its node even when the by-wallet answer did not list it (a light node record kept
        // on this device does not stand in the way).
        if (!serverNodeTypeOf(activatedNodeType) && wallet && genesisOwn) {
          try {
            const status = await checkServerNodeStatus(`genesis_node_${genesisOwn}`);
            if (status.success && status.isOnline) {
              linkGenesisNode(genesisOwn, walletAddress);
              setServerNodeStatus(status);
              AsyncStorage.setItem('qnet_cached_server_status', JSON.stringify({
                ...status,
                cachedAt: Date.now()
              })).catch(() => {});
              loadServerEpochs(`genesis_node_${genesisOwn}`, { fresh: true });
            }
          } catch (error) {
            // Not reachable now; the next tab open asks again.
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load all user nodes:', error);
    } finally {
      setLoadingAllNodes(false);
    }
  };

  // A genesis node on this wallet: only the node record is kept.
  const linkGenesisNode = (bootstrapId, owner) => {
    const id = `genesis_node_${bootstrapId}`;
    setActivatedNodeType('super');
    setNodePseudonym(id);
    walletManager.saveNodeRecord({ nodeType: 'super', pseudonym: id, walletAddress: owner, isGenesis: true, bootstrapId })
      .catch(() => {});
  };

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
            // The chain's epoch the tab shows decides whether the key rotation fell due (a new key then, MN-R4-01).
            const r = await bindThisDevice({
              signer: walletManager, credential: password, nodeId, device: deviceCheck, interactive: true,
              epoch: currentBlockHeight > 0 ? Math.floor(currentBlockHeight / 14400) : null,
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

  // A move that did not go: the text of its code, never the words a node or the client put in the error (those are
  // English and may speak the network's own terms). Anything else is "Nothing was submitted."
  const CLAIM_TEXT = {
    NO_REWARDS: 'err_NO_REWARDS', MIN_CLAIM: 'err_MIN_CLAIM', CLAIM_BUSY: 'err_CLAIM_BUSY', NODE_ID_UNKNOWN: 'err_NODE_ID_UNKNOWN',
  };
  const claimErrorText = (error) => t((error && CLAIM_TEXT[error.code]) || 'claim_failed');
  
  // Open Send Screen from Assets (click on token) - inline, not modal
  // Open the Send screen. For QRC-20 tokens, pass the extra `token` descriptor
  // { contract, decimals } so handleSendTransaction can route through qrc20Transfer and
  // scale the amount by the token's OWN decimals. Native QNC omits it (contract stays null). On Solana ('solana') the
  // symbol names one of the Solana tokens the Assets list shows, and the Solana Send screen takes over (./SolanaSend).
  const openSendModal = (tokenSymbol, tokenBalance, network, token = null) => {
    setSendingToken({
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
    setTxResult(null);
    setShowScan(false);
    setShowSendScreen(true);
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

  // The tokens the QNet Send screen offers: QNC, then the QNet tokens the Assets list shows, each with the figure it shows.
  const qnetSendChoices = () => [
    { key: 'QNC', symbol: 'QNC', balance: tokenBalances.qnc, contract: null, decimals: null },
    ...qrcTokens.filter((tk) => tk.contract && isTokenShown(tk.contract)).map((tk) => ({
      key: tk.contract,
      symbol: tokenTitle(tk),
      balance: parseFloat(tk.balance) || 0,
      balanceText: typeof tk.balance === 'string' ? tk.balance : null,
      contract: tk.contract,
      decimals: tk.decimals,
      reserved: usesReservedName(tk.symbol, tk.name),
    })),
  ];

  // The QNet Send screen's other token: the amount keeps no more decimal places than the new token has (at most the six
  // the field takes); the recipient stays. Every check of the send runs for the token chosen (handleSendTransaction).
  const switchQnetToken = (choice) => {
    if (!choice) return;
    setSendingToken((prev) => (prev ? {
      ...prev, symbol: choice.symbol, balance: choice.balance, contract: choice.contract, decimals: choice.decimals,
      balanceText: choice.balanceText || null, reserved: !!choice.reserved,
    } : prev));
    setSendAmount((prev) => cleanAmountInput(prev, choice.contract ? Math.min(6, Number(choice.decimals) || 0) : 6));
  };

  // The Solana Send screen's other token: the amount keeps no more decimal places than the new token has.
  const switchSolanaToken = (symbol) => {
    const tk = solanaToken(symbol);
    if (!tk) return;
    setSendingToken((prev) => (prev ? { ...prev, symbol } : prev));
    setSendAmount((prev) => cleanAmountInput(prev, tk.decimals));
  };
  
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

  // The QNC balance a send is checked against (MOBNET-R3-04, MB-R2-02): one the committee certified, less what this
  // wallet's own transactions since that checkpoint took (WalletManager.certifiedQncForSend: a proof read a moment ago,
  // else one verified read within its deadline), as the in-app browser's sheet takes it; never one node's word, never
  // the figure on screen, which may predate a spend. { error } when none can be had: the send is then refused, saying
  // why (sendCheckError).
  const freshQncNano = async () => {
    const addr = wallet && (wallet.qnetAddress || wallet.address);
    const r = addr ? await walletManager.certifiedQncForSend(addr).catch(() => null) : null;
    return r && r.ok && r.verified && /^\d+$/.test(String(r.balanceNano)) ? r : { error: (r && r.error) || 'unanswered' };
  };

  // Why a send check found no balance to decide by, said as it is: a transaction from another device not confirmed yet,
  // a balance not confirmed yet (try again in a minute), or no answer from the network.
  const sendCheckError = (error) => t(error === 'foreign' ? 'balance_foreign_pending'
    : error === 'unconfirmed' ? 'balance_unconfirmed' : 'send_balance_unreadable');

  // What the send may still spend (BigInt): the checked balance less what this wallet's unsettled transactions may
  // still take, the one a replacement signs over excepted (at most one of the two can apply).
  const afterPending = (balance, pending, replaceNonce) => {
    let left = BigInt(balance);
    for (const p of Array.isArray(pending) ? pending : []) if (p.nonce !== replaceNonce) left -= BigInt(p.amount);
    return left > 0n ? left : 0n;
  };

  // Close Send Screen and go back to assets
  const closeSendScreen = () => {
    setShowScan(false);
    setShowSendScreen(false);
    setSendingToken(null);
    setTxResult(null);
    setSendAddress('');
    setSendAmount('');
    setSolanaRequest(null);
  };

  /**
   * Which of the three outcomes a result carries. `unknown` is a submit nobody answered: the chain has
   * not decided, so it is neither a success nor a refusal, and the resolver below settles it.
   */
  const txResultState = (r) => (r.unknown ? 'pending' : (r.success ? 'success' : 'failed'));

  /** What the result says under the amount: the caller's own note, else the state of its confirmation. */
  const txResultNote = (r) => {
    if (r.note) return r.note;
    if (r.unknown) return t('tx_note_unknown');
    if (!r.success) return null;
    if (r.confirmed) return t('tx_note_confirmed');
    if (r.stillPending) return t('tx_note_still_pending');
    if (r.confirming) return t('tx_note_confirming');
    return null;
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

  // One unconfirmed transaction of this wallet, as a line: what it is and how long ago it was signed.
  const pendingLine = (p) => {
    const age = t('time_min', { n: Math.max(1, Math.round((Number(p.ageMs) || 0) / 60_000)) });
    const what = p.kind === 'transfer' && p.amountNano !== null
      ? t('pending_line_transfer', { amount: `${formatNano(String(p.amountNano))} QNC`, to: p.to || '—' })
      : p.kind === 'call' ? t('pending_line_call', { method: p.method || '—', to: p.to || '—' })
        : p.kind === 'deploy' ? t('pending_line_deploy') : t('pending_line_other');
    return `${what} · ${age}`;
  };

  // An alert whose buttons resolve with their `value` (a dismissal resolves nothing, like cancelling).
  const askAlert = (title, message, buttons) => new Promise((resolve) => {
    showAlert(title, message, buttons.map((b) => ({ text: b.text, style: b.style, onPress: () => resolve(b.value) })));
  });

  /**
   * Before a send (MOBNET-R1-01): while this wallet has unconfirmed transactions, the user sees them and chooses
   * whether the new one replaces the newest of them (the same nonce: only one of the two can go through) or comes
   * in addition (the next nonce: both can); and a payment of the same amount to the same address in the last half
   * hour is named. { proceed, choice, live }, `live` the unconfirmed transactions the choice was made about.
   * `kept`: this wallet's kept transactions, when the caller already read them.
   */
  const decidePendingChoice = async (from, to, amountNano, kept = null) => {
    let preview = null;
    const local = kept || await walletManager.pendingTransactions(from).catch(() => []);
    if (local.length > 0) {
      try { preview = await walletManager.previewSend(from); } catch (_) { preview = null; }
      // No confirmed nonce to be had: the send itself will say so (nothing is signed without one).
      if (!preview) return { proceed: true, choice: null };
    }
    const live = preview ? preview.live : [];
    const decided = (d) => ({ ...d, live });
    const recent = preview ? preview.recent : await walletManager.recentSettledTransactions(from).catch(() => []);
    let canonicalTo = null;
    try { canonicalTo = WalletManager.canonicalAddress(to); } catch (_) { canonicalTo = null; }
    const repeatMin = amountNano !== null && canonicalTo ? repeatedPaymentMinutes(canonicalTo, amountNano, live, recent) : null;
    const repeatLine = repeatMin !== null ? t('send_repeat_body', { minutes: repeatMin }) : null;
    if (live.length === 0) {
      if (repeatLine === null) return decided({ proceed: true, choice: null });
      const go = await askAlert(t('send_repeat_title'), repeatLine, [
        { text: t('cancel'), style: 'cancel', value: false },
        { text: t('send_repeat_send_anyway'), value: true },
      ]);
      return decided({ proceed: go === true, choice: null });
    }
    const body = [repeatLine, t('pending_title', { count: live.length }), live.map(pendingLine).join('\n'), t('pending_ask'),
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

  // Dismissing a result returns the flow that raised it to where it belongs — the send screen closes,
  // a claim reloads the node, a failed send goes back to its filled-in form.
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
      if (showHeaderMenu) { setShowHeaderMenu(false); return true; }
      if (txResult) { dismissTxResult(); return true; }
      if (txDetail) { setTxDetail(null); return true; }
      if (showScan) { setShowScan(false); return true; }
      if (showSendScreen) { closeSendScreen(); return true; }
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
    freshPrompt, linkRequest, wallet, dappSheet, sendReview, deviceAuth,
  ]);


  // v2.101: Validate amount input - international standard (dot separator, max 6 decimals)
  const validateAmountInput = (text) => {
    // Replace comma with dot (for locales that use comma)
    let normalized = text.replace(',', '.');
    
    // Remove any non-numeric characters except dot
    normalized = normalized.replace(/[^\d.]/g, '');
    
    // Ensure only one decimal point
    const parts = normalized.split('.');
    if (parts.length > 2) {
      normalized = parts[0] + '.' + parts.slice(1).join('');
    }
    
    // Limit decimal places (6 for display, blockchain uses 9 internally)
    if (parts.length === 2 && parts[1].length > 6) {
      normalized = parts[0] + '.' + parts[1].substring(0, 6);
    }
    
    // Prevent leading zeros (except for "0." pattern)
    if (normalized.length > 1 && normalized[0] === '0' && normalized[1] !== '.') {
      normalized = normalized.substring(1);
    }
    
    setSendAmount(normalized);
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
  // ARCHITECTURE: Polling only updates UI status (confirming → confirmed)
  // It does NOT clear pendingTxRef — that's loadBalance's job!
  // WHY: Polling may confirm TX on Node 1, but loadBalance queries Node 3
  // which hasn't received the block yet → stale balance without protection.
  // loadBalance clears pendingTxRef ONLY when the queried node's balance
  // actually reflects the TX (qncBalance <= expectedQnc).
  // A history row of a send from here that no source has reported yet: pending, or past its time and not found.
  const unsettledRow = (r) => r.status === 'pending' || r.status === 'dropped';

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
      if (res.landed) {
        const landedHash = res.txHash || txHash;
        setTxResult(prev => (mine(prev) ? { ...prev, confirming: false, stillPending: false, confirmed: true, txHash: landedHash } : prev));
        // The copy that landed is the history's row; the pending (or not found) row under the handed hash goes.
        if (landedHash !== txHash) setTxHistory(prev => prev.filter(r => !(unsettledRow(r) && r.hash === txHash)));
        else updateTxStatus(txHash, 'reported');
      } else if (res.replaced || res.unbound) {
        const title = t(res.replaced ? 'tx_not_applied_title' : 'tx_unbound_title');
        const error = t(res.replaced ? 'tx_note_not_applied' : 'tx_note_unbound');
        setTxResult(prev => (mine(prev)
          ? { ...prev, success: false, confirming: false, stillPending: false, title, error, note: undefined,
              ...(res.unbound && res.txHash ? { txHash: res.txHash } : {}) }
          : prev));
        // Nothing of this send is on its way under the handed hash any more.
        setTxHistory(prev => prev.filter(r => !(unsettledRow(r) && r.hash === txHash)));
        if (pendingTxRef.current && pendingTxRef.current.txHash === txHash) pendingTxRef.current = null;
      } else {
        return false;
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
      // Deadline reached without confirmation: don't hang the UI on an infinite
      // spinner. Drop the optimistic hold and surface an explicit pending state.
      pendingTxRef.current = null;
      txPollingRef.current = null;
      setTxResult(prev => prev?.txHash === txHash ? { ...prev, confirming: false, stillPending: true } : prev);
      updateTxStatus(txHash, 'pending');
      if (wallet?.publicKey) {
        loadBalance(wallet.publicKey);
      }
    };

    const poll = async () => {
      attempts++;

      // Rotate through nodes on each attempt for better reliability
      const nodeIndex = (attempts - 1) % allNodes.length;
      const apiUrl = allNodes[nodeIndex];

      try {
        // Check TX status via API
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${apiUrl}/api/v1/transaction/${txHash}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const txData = await response.json();

          // In a block, not merely in a mempool: a node answers "found" with status 'pending' for a transaction
          // only its mempool holds, and one of those can still be dropped or lose its nonce (MOBNET-R2-01).
          if (txLookupState(txData, txHash) === 'included') {
            // v3.34: DON'T clear pendingTxRef here!
            // loadBalance will clear it when the queried node's balance catches up.
            // This prevents the bounce: polling confirms on Node 1, but loadBalance
            // queries Node 3 which still has old balance → stale data without protection.

            // Stop polling (TX is confirmed, no need to keep checking)
            txPollingRef.current = null;
            if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }

            // Update txResult to show confirmed
            setTxResult(prev => prev?.txHash === txHash
              ? { ...prev, confirming: false, confirmed: true }
              : prev
            );

            // A node found it: 'reported' until the archive's row replaces it in the history.
            updateTxStatus(txHash, 'reported');

            // Trigger balance refresh (loadBalance will handle pendingTxRef clearing)
            if (wallet?.publicKey) {
              loadBalance(wallet.publicKey);
            }

            // v3.35: Refresh full TX history from blockchain
            // This ensures the confirmed TX appears with correct block data
            loadTxHistory();
            return;
          }
        }
      } catch (error) {
        // Network error - will try next node on next reschedule
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
      if (res.replaced) {
        txPollingRef.current = null;
        setTxResult(prev => prev && prev.unknown
          ? { ...prev, unknown: false, success: false, title: t('tx_not_applied_title'), error: t('tx_note_not_applied'), note: undefined }
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
    
    const amount = parseFloat(sendAmount);
    if (isNaN(amount) || amount <= 0) {
      setTxResult({ success: false, title: t('send_cannot_title'), error: t('send_invalid_amount') });
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
        setTxResult({ success: false, title: t('send_cannot_title'), error: t('send_token_unrecorded') });
        return;
      }
      try {
        tokenAmountBase = walletManager.toBaseUnits(sendAmount, sendingToken.decimals || 0);
      } catch (e) {
        // More decimals than the token has is said as such (L-9); anything else is not an amount.
        const error = e && e.code === 'AMOUNT_DECIMALS' ? t('err_AMOUNT_DECIMALS', e.params) : t('send_invalid_amount');
        setTxResult({ success: false, title: t('send_cannot_title'), error });
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
        setTxResult({
          success: false,
          title: t('send_cannot_title'),
          error: t('send_invalid_address')
        });
        return;
      }
    }

    // What the checks below need, read at once: the QNC balance, a token send's token balance, what the recipient is,
    // and this wallet's kept transactions and past recipients (on the device). The QNC is read now, not taken from the
    // figure on screen (MOBNET-R3-04), which can predate a spend made in the browser or on another device: a payment
    // the chain would refuse must not become a kept transaction that goes out after a later top-up. A balance the
    // committee did not certify in time refuses the send, as the in-app browser's sheet and the extension refuse it
    // (MB-R2-02). The token balance likewise, never the holdings row on screen.
    const isQnetSend = sendingToken.network === 'qnet';
    const senderQnet = wallet.qnetAddress || wallet.address;
    const [qncCheck, held, recipientProblem, keptNow, sentTo] = await Promise.all([
      isQnetSend ? freshQncNano() : null,
      isTokenSend ? walletManager.checkedTokenBalance(sendingToken.contract, myQnetAddress, sendingToken.decimals).catch(() => null) : null,
      isQnetSend ? walletManager.payableRecipientProblem(sendAddress, myQnetAddress).catch(() => 'unchecked') : null,
      isQnetSend ? walletManager.pendingTransactions(senderQnet).then((l) => (Array.isArray(l) ? l : []), () => []) : [],
      isQnetSend ? walletManager.sentRecipients().catch(() => []) : [],
    ]);
    if (isQnetSend && qncCheck.error) {
      setTxResult({ success: false, title: t('send_cannot_title'), error: sendCheckError(qncCheck.error) });
      return;
    }
    const qncNano = isQnetSend ? String(qncCheck.balanceNano) : null;
    const qncNow = qncNano !== null ? Number(qncNano) / 1e9 : null;
    if (isTokenSend) {
      if (!held || !held.ok || !/^\d+$/.test(String(held.balanceBase))) {
        setTxResult({ success: false, title: t('send_cannot_title'), error: sendCheckError(held && held.error) });
        return;
      }
      if (BigInt(tokenAmountBase) > BigInt(held.balanceBase)) {
        setTxResult({
          success: false,
          title: t('send_cannot_title'),
          error: t('send_insufficient_token', {
            need: `${amount} ${sendingToken.symbol}`, balance: `${held.balance} ${sendingToken.symbol}`,
          }),
        });
        return;
      }
    } else {
      // amount + fee in whole nanoQNC, as the chain debits it
      const needNano = Math.round(amount * 1e9) + TRANSFER_FEE_NANO;
      const haveQnc = sendingToken.symbol === 'QNC' && qncNow !== null ? qncNow : sendingToken.balance;
      if (needNano > Math.round(haveQnc * 1e9)) {
        setTxResult({
          success: false,
          title: t('send_cannot_title'),
          error: t('send_insufficient_qnc', {
            need: `${(needNano / 1e9).toFixed(6)} ${sendingToken.symbol}`, fee: `${TRANSFER_FEE_QNC} QNC`,
            balance: `${haveQnc.toFixed(6)} ${sendingToken.symbol}`,
          }),
        });
        return;
      }
    }

    // A recipient that is a contract as two genesis nodes agree (a built-in token, the token being sent included, a WASM
    // contract) keeps what it is paid for good: no contract sends QNC or a token on. Refused before the review (read
    // above, with the balance) and read again just before signing, as the extension's confirm does; a recipient no two
    // nodes agree on is not paid either (MOB-BR-R3-01).
    const recipientRefused = async (known) => {
      if (sendingToken.network !== 'qnet') return false;
      const problem = known !== undefined ? known : await walletManager.payableRecipientProblem(sendAddress, myQnetAddress);
      if (!problem) return false;
      setTxResult({
        success: false,
        title: t('send_cannot_title'),
        error: t(problem === 'contract' ? 'send_recipient_contract' : 'send_recipient_unchecked'),
      });
      return true;
    };
    if (await recipientRefused(recipientProblem)) return;

    // This wallet's unconfirmed transactions, and the same payment made a moment ago: the user decides first.
    let pendingChoice = null;
    let spendable = null; // nanoQNC (BigInt) a QNet send may still spend
    if (sendingToken.network === 'qnet') {
      const decision = await decidePendingChoice(senderQnet, sendAddress, isTokenSend ? null : Math.round(amount * 1e9), keptNow);
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
          setTxResult({
            success: false,
            title: t('send_cannot_title'),
            error: t('send_insufficient_token', { need: `${amount} ${sendingToken.symbol}`, balance: `${left} ${sendingToken.symbol}` }),
          });
          return;
        }
      }
      const needNow = isTokenSend ? null : BigInt(Math.round(amount * 1e9) + TRANSFER_FEE_NANO);
      if (needNow !== null && spendable < needNow) {
        setTxResult({
          success: false,
          title: t('send_cannot_title'),
          error: t('send_insufficient_qnc', {
            need: `${(Number(needNow) / 1e9).toFixed(6)} QNC`, fee: `${TRANSFER_FEE_QNC} QNC`,
            balance: `${(Number(spendable) / 1e9).toFixed(6)} QNC`,
          }),
        });
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
    const feeText = feeNano === null ? '—' : `${fmtAmount(feeNano / 1e9, 6)} QNC`;
    const reviewed = await reviewSend({
      to: sendAddress,
      network: isQnetSend ? 'QNet' : 'Solana',
      amount: `${sendAmount} ${sendingToken.symbol}`,
      fee: feeText,
      total: isTokenSend ? `${sendAmount} ${sendingToken.symbol} + ${feeText}`
        : `${((Math.round(amount * 1e9) + TRANSFER_FEE_NANO) / 1e9).toFixed(6)} ${sendingToken.symbol}`,
      warnings,
    });
    if (!reviewed) return;

    // Every send asks again who holds the phone, as a site's send in the browser does (MPLAT-R2-01): QNC, QRC-20,
    // SOL and 1DEV alike. On Android that is the system fingerprint or face prompt bound to the vault's key where
    // biometric unlock is set up, else the typed password, whose text the app keeps from accessibility services
    // (SecurityModule, MPLAT-R4-01), with any app that can read the screen named on the prompt; on iOS Face ID /
    // Touch ID / the passcode. The recipient is on that prompt too (MPLAT-R5-01).
    if (!(await confirmFresh(t('send_confirm_reason', { amount: `${amount} ${sendingToken.symbol}` }), null, sendAddress))) return;

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
          setTxResult({
            success: false,
            title: t('send_cannot_title'),
            error: t(need.depositNano ? 'send_fee_short_deposit' : 'send_fee_short', {
              need: `${(need.needNano / 1e9).toFixed(6)} QNC`, deposit: '0.01 QNC',
              balance: `${fmtAmount(feeQnc, 6)} QNC`,
            }),
          });
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
          confirming: true,
          onDismiss: closeSendScreen,
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

        // Show success with "confirming" status
        setTxResult({
          success: true,
          title: t('tx_sent_title'),
          txHash: result.txHash,
          amount: amount,
          to: sendAddress,
          counterpartyLabel: t(toSelf ? 'tx_to_self' : 'tx_to'),
          symbol: sendingToken.symbol,
          confirming: true, // the note tracks this until the poller confirms or gives up
          note: result.replaced ? t('tx_note_replaced') : undefined,
          onDismiss: closeSendScreen,
        });

        // v3.29: Set pending TX state
        if (sendingToken.symbol === 'QNC') {
          pendingTxRef.current = {
            txHash: result.txHash,
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
          note: unknownNote(result),
          onDismiss: closeSendScreen,
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
          note: unknownNote(error.unknown),
          onDismiss: closeSendScreen,
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
  // time, so a second tap reads nothing again.
  const pressSend = async () => {
    if (sendGuardRef.current) return;
    sendGuardRef.current = true;
    setSendChecking(true);
    try {
      await handleSendTransaction();
    } finally {
      sendGuardRef.current = false;
      setSendChecking(false);
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
        ? { unknown: true, title: t('tx_awaiting_title'), note: t('tx_note_unknown') }
        : { success: true, title: t('tx_sent_title'), confirming: true }),
      amount: entry.amount,
      symbol: entry.symbol,
      to: entry.to,
      counterpartyLabel: t(entry.to === owner ? 'tx_to_self' : 'tx_to'),
      txHash: entry.signature,
      chain: 'solana',
      solanaSignature: entry.signature,
      onDismiss: closeSendScreen,
    });
    if (wallet && wallet.publicKey) loadBalance(wallet.publicKey);
  };

  // Move to wallet: the node balance (nanoQNC) becomes spendable QNC through a claim the wallet key signs. The same for
  // a server node and for this wallet's light node, wherever that node runs.
  const moveNodeBalance = async ({ nodeType, nodeId, balanceNano, reload }) => {
    if (!(balanceNano > 0) || processingValidation) return;

    setProcessingValidation(true);
    try {
      const walletAddress = await getWalletAddressForClaim();
      const result = await walletManager.claimRewards(nodeType, walletAddress, password, balanceNano, nodeId);

      if (result.success) {
        // The batch actually submitted (result.amount is QNC), not the displayed pending figure.
        const claimedAmount = Number(result.amount || 0).toFixed(4);
        
        const stopped = result.stoppedAtEpoch != null
          ? t('claim_stopped_at', { epoch: result.stoppedAtEpoch })
          : t('claim_credited_on_block');
        setTxResult({
          success: true,
          title: t('claim_submitted_title'),
          amount: claimedAmount,
          symbol: 'QNC',
          note: stopped,
          txHash: result.txHash,
          onDismiss: () => {
            reload();
            if (wallet && wallet.publicKey) loadBalance(wallet.publicKey);
          },
        });
      } else {
        // Nothing was submitted here — the node refused the claim, so it is not a failed transaction.
        setTxResult({ success: false, title: t('claim_cannot_title'), error: claimErrorText(result) });
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
          onDismiss: () => {
            reload();
            if (wallet && wallet.publicKey) loadBalance(wallet.publicKey);
          },
        });
      } else {
        setTxResult({ success: false, title: t('claim_failed_title'), error: claimErrorText(error) });
      }
    } finally {
      setProcessingValidation(false);
    }
  };
  // A server node: the linked one, which changes only on two genesis confirmations (MOBACT-R5-02).
  const handleClaimServerNodeRewards = () => moveNodeBalance({
    nodeType: activatedNodeType,
    nodeId: nodePseudonym || serverNodeStatus?.nodeId || null,
    balanceNano: serverNodeStatus?.pendingRewards || 0,
    reload: () => loadServerNodeStatus({ rewards: true }),
  });
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
    setNativeTexts({
      captureCover: t('native_capture_cover'), screenshotTitle: t('native_screenshot_title'),
      screenshotBody: t('native_screenshot_body'), ok: t('common_ok'), authReason: t('auth_default_reason'),
      obscuredTouch: t('native_obscured_touch'),
    });
  }, [language]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSettings = async () => {
    try {
      const [savedAutoLockTime, savedLanguage] = await Promise.all([
        AsyncStorage.getItem('qnet_autolock_time'),
        AsyncStorage.getItem('qnet_language'),
      ]);

      // A value outside the choices (the old 60) falls back to the default.
      setAutoLockTime(AUTO_LOCK_CHOICES.includes(savedAutoLockTime) ? savedAutoLockTime : DEFAULT_AUTO_LOCK);
      setLanguage(isSupported(savedLanguage) ? savedLanguage : deviceLanguage());
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
  const reviewSend = (review) => {
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
    setShowScan(false); // the camera never comes back by itself after an unlock
    setActiveTab('assets');
    // The browser stays under the lock screen; its open request ends (4100) and so does its sheet.
    setDappSheet(null);
    setConnectedSites(null);
    // A link request stays until the user closes it: an undecided one waits for the next unlock, and one the user
    // decided comes back with its outcome (or with the work still under way, until the outcome arrives), so what its
    // screen had to say is never lost with a lock (MOBLINK-R5-02). One that arrived behind it keeps waiting until then.
  };

  // What takes the place of the request `r` once it is closed: the link that arrived while it was on screen, if any
  // and not the same request, shown with the note that another request arrived (R4-MOBLINK-01); else nothing.
  const nextQueuedLink = (r) => {
    const next = linkQueueRef.current;
    linkQueueRef.current = null;
    if (!next || (r && r.link.id === next.id)) return null;
    return { link: next, key: Date.now(), settled: false, afterOther: true };
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
        forgetImportPhrase();
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

  const saveLanguage = async (lang) => {
    try {
      await AsyncStorage.setItem('qnet_language', lang);
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

  // The Assets tab reads the balances on opening, then every ASSETS_SOCKET_MS while the address socket is open (its
  // events ask for a read as soon as this wallet's balance changes) and every ASSETS_POLL_MS while it is not
  // (requestPace); nothing while the app is not in front.
  useEffect(() => {
    if (wallet && wallet.publicKey && activeTab === 'assets') {
      loadBalance(wallet.publicKey);
      let balanceTimer = null;
      const next = () => {
        balanceTimer = setTimeout(() => {
          if (AppState.currentState === 'active') loadBalance(wallet.publicKey);
          next();
        }, assetsPollMs(wsOpenRef.current));
      };
      next();

      return () => {
        clearTimeout(balanceTimer);
        // v3.29: Also cleanup TX polling on tab change/unmount
        if (txPollingRef.current) {
          clearInterval(txPollingRef.current);
          txPollingRef.current = null;
        }
      };
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
        if (!live || !kept.some((e) => autoSendable(e))) return;
        await walletManager.sendDuePending(address);
        if (live) refreshKept(address);
      } catch (_) { /* the next sweep tries again */ }
    };
    const timer = setInterval(sweep, KEPT_SWEEP_MS);
    return () => { live = false; clearInterval(timer); };
  }, [wallet, appActive, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { activatedNodeTypeRef.current = activatedNodeType; }, [activatedNodeType]);

  // The History tab: everything on opening (the explorer too), then one genesis node's newest rows every
  // HISTORY_SOCKET_MS while the address socket is open (its events ask for a read when this wallet's balance changes)
  // and every HISTORY_POLL_MS while it is not (requestPace); nothing while the app is not in front.
  useEffect(() => {
    if (wallet?.qnetAddress && activeTab === 'history') {
      loadTxHistory(true);
      let historyTimer = null;
      const next = () => {
        historyTimer = setTimeout(() => {
          if (AppState.currentState === 'active') loadTxHistory();
          next();
        }, historyPollMs(wsOpenRef.current));
      };
      next();
      return () => clearTimeout(historyTimer);
    }
  }, [wallet, activeTab]);

  // The node this wallet runs or monitors, restored from this device when the wallet opens: the node record (type,
  // node id). Local only: no network, no seed phrase.
  const restoreNodeState = async (w) => {
    if (!w) return;
    try {
      await walletManager.cleanupActivationStorage();
      const record = await walletManager.loadNodeRecord(walletAddresses(w));
      const nodeType = record && record.nodeType;
      if (!nodeType) return;
      setActivatedNodeType(nodeType);
      const pseudonym = (record && record.pseudonym)
        || (nodeType === 'light' && w.qnetAddress ? walletManager.generateLightNodePseudonym(w.qnetAddress) : '');
      if (pseudonym) setNodePseudonym(pseudonym);
      // A server node's last status shows at once; the Node tab refreshes it.
      if (nodeType !== 'light') {
        const cached = JSON.parse((await AsyncStorage.getItem('qnet_cached_server_status')) || 'null');
        if (cached && cached.success && cached.cachedAt && (Date.now() - cached.cachedAt < 600000)) {
          setServerNodeStatus(cached);
        }
      }
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
        const nodeType = activatedNodeTypeRef.current;
        const jobs = [];
        if (tab === 'history' && wallet?.qnetAddress) jobs.push(loadTxHistory(true));
        if (tab === 'assets' && wallet?.publicKey) jobs.push(loadBalance(wallet.publicKey));
        if (tab === 'node') {
          jobs.push(refreshHeight());
          jobs.push(loadAllUserNodes());
          if (serverNodeTypeOf(nodeType)) jobs.push(loadServerNodeStatus());
          jobs.push(loadLightNodeStatus());
          jobs.push(loadSiteRecord());
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
        loadCachedHistory(wallet.qnetAddress).then(cached => {
          if (cached.length) setTxHistory(prev => (prev.length ? prev : cached));
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
        if (wsBalanceDebounceRef.current) { clearTimeout(wsBalanceDebounceRef.current); wsBalanceDebounceRef.current = null; }
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

  const renderPasswordMatch = (pw, confirm) => {
    if (confirm.length === 0) return null;
    if (pw !== confirm) return <Text style={styles.errorText}>{t('pw_mismatch')}</Text>;
    return pw.length >= MIN_PASSWORD ? <Text style={styles.passwordSuccess}>✓ {t('pw_match')}</Text> : null;
  };

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
          // A prompt that failed this time: the screen stays, and Import asks again with the screen lock (MA2-02).
          if (e.code === 'DEVICE_LOCK_RETRY') {
            showAlert(t('error'), t('device_unlock_unavailable'));
            return;
          }
          refreshDeviceAuthAvail();
          showAlert(t('device_lock_title'), t('device_lock_body'));
          return;
        }
        setBiometricEnabled(true);
      } else {
        session = await walletManager.storeWallet(imported, password);
      }
      setWalletDeviceAuth(!typed);
      await teardownLightNodeIfForeign([
        imported.qnetAddress, imported.publicKey, walletManager.generateQNetAddressFromSolana(imported.publicKey),
      ]);
      await clearPastedPhrase(seedToImport);

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
      if (!done) clearPastedPhrase(seedPhraseRef.current);
    }
  };

  // A recovery phrase must not stay on the clipboard once the import is over, whichever way it ends (MPLAT-R2-03,
  // MPLAT-R3-01). The field itself offers no Copy, Cut or Share, and a menu Paste into it clears the clipboard
  // natively as soon as the words land. Here: text that arrived in one change of two or more words (seedPastedRef:
  // a paste or a keyboard's clipboard chip) means the clipboard holds it, cleared on both platforms before the mark
  // is forgotten (in the background Android no longer lets the app read the clip to compare). Otherwise iOS clears
  // anything copied since the phrase field appeared (the pasteboard's change count, so it is never read and no paste
  // prompt appears), and Android compares the clip with the phrase while it still can.
  const clearPastedPhrase = async (phrase) => {
    const pasted = seedPastedRef.current;
    seedPastedRef.current = false;
    try {
      if (pasted) {
        Clipboard.setString('');
        return;
      }
      if (Platform.OS === 'ios') {
        await clearPasteboardIfChanged(seedBoardAtRef.current);
        return;
      }
      if (!phrase) return;
      const norm = (s) => String(s || '').trim().split(/\s+/).join(' ');
      if (norm(await Clipboard.getString()) === norm(phrase)) Clipboard.setString('');
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
      clearPastedPhrase(text);
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

  // The phrase typed or pasted for import leaves the screen: the app goes to the background, the wallet locks,
  // Back is pressed. The field empties and a pasted phrase takes the clipboard with it.
  const forgetImportPhrase = () => {
    const phrase = seedPhraseRef.current;
    setSeedPhrase('');
    clearPastedPhrase(phrase);
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
      setVerificationError(`⚠️ ${t('seed_select_word', { n: emptyWords[0] + 1 })}`);
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
      setVerificationError(`❌ ${incorrectWords.length === 1
        ? t('seed_word_wrong', { n: incorrectWords[0] })
        : t('seed_words_wrong', { list: `#${incorrectWords.join(', #')}` })}`);
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
      // A prompt that failed this time: the same button asks again with the screen lock (MA2-02).
      if (underLock && error && error.code === 'DEVICE_LOCK_RETRY') {
        showAlert(t('error'), t('device_unlock_unavailable'));
        return;
      }
      if (underLock && error && error.code === 'DEVICE_LOCK') {
        refreshDeviceAuthAvail();
        showAlert(t('device_lock_title'), t('device_lock_body'));
      } else showAlert(t('error'), errorText(t, error, 'err_save_wallet'));
      return;
    }
    wipeKeyArrays(tempWallet);
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
      setTimeout(() => setError(''), 3000);
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
      setTimeout(() => {
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
      setTimeout(() => setUnlockError(''), 3000);
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
      setTimeout(() => {
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
        const bal = await walletManager.getTokenBalanceOf(contract, qnetAddress, dec);
        byContract.set(contract, {
          contract,
          name: c.name || c.symbol || '',
          symbol: c.symbol || '',
          decimals: dec,
          balance: bal.balance != null ? bal.balance : '0',
          logo: c.logo || '',
          decimalsTrusted: true,
        });
      }));

      const list = Array.from(byContract.values());
      if (!stillCurrent()) return;
      setQrcTokens((prev) => (sameRows(prev, list) ? prev : list));

      // Trustless upgrade: verify each held token's balance via its two-level proof against the
      // committee-QC-anchored state_root (same trust model as the native balance). Non-blocking — the
      // list shows node-trusted balances immediately, each row flips to `verified` + its proof-exact
      // balance as the proof lands. Skip hidden tokens (never shown) and cap concurrency so a
      // dust-heavy wallet can't open hundreds of simultaneous proof requests.
      // Only added tokens: the proof covers base units, and a ✓ must never sit next to a magnitude a node chose
      // (MOBNET-R3-05). A token shown without being added keeps an unproven figure and no mark.
      const added = new Set(persisted.map((c) => c.contract_address || c.contract).filter(Boolean));
      const toProve = list.filter((tk) => tokenVisible(tk.contract, { hidden: hiddenTokens, added, shown: shownTokensRef.current })
        && tk.decimalsTrusted);
      let proofIdx = 0;
      const proveWorker = async () => {
        while (proofIdx < toProve.length) {
          const tk = toProve[proofIdx++];
          try {
            const r = await walletManager.getTokenBalanceWithProof(tk.contract, qnetAddress, tk.decimals);
            if (r && r.ok && r.verified && stillCurrent()) {
              setQrcTokens((prev) => {
                const next = prev.map((row) => (row.contract === tk.contract ? { ...row, balance: r.balance, verified: true } : row));
                return sameRows(prev, next) ? prev : next;
              });
            }
          } catch (_) { /* keep the node-trusted balance */ }
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

  // Privacy: mask every displayed amount when balances are hidden (persisted 'qnet_hide_balances').
  const maskAmt = (s) => (balancesHidden ? '••••' : s);
  // A figure of the wallet on screen ('qnc', 'sol', 'oneDev'), or a dash while none was read or kept for it.
  const figureKnown = (field) => !!(wallet && balanceStatus.owner === wallet.qnetAddress && balanceStatus.known[field]);
  const figure = (field, text) => maskAmt(figureKnown(field) ? text : '—');
  // The line under Send and Receive, only when this session's first read found nothing: when the figures shown were
  // read (or that none could be). While a read runs nothing is said; the last figures stay on screen.
  const balanceLine = () => {
    if (!wallet || balanceStatus.owner !== wallet.qnetAddress) return null;
    if (balanceStatus.state !== 'stale') return null;
    return balanceStatus.known.qnc && balanceStatus.at
      ? t('balance_stale', { time: dateTime(balanceStatus.at) }) : t('balance_unavailable');
  };
  const toggleBalancesHidden = () => {
    setBalancesHidden((prev) => {
      const next = !prev;
      AsyncStorage.setItem('qnet_hide_balances', next ? '1' : '0').catch(() => {});
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
    const matches = all.filter((tk) =>
      (tk.symbol || '').toLowerCase().includes(q)
      || (tk.name || '').toLowerCase().includes(q)
      || (tk.contract || '').toLowerCase().includes(q));
    // Paste a contract address (EON) to track a token not in the list yet — its row toggle adds it.
    if (!matches.length && isValidQnetAddress(q) && !all.some((tk) => tk.contract === q)) {
      return [{ contract: q, symbol: '', name: '', decimals: 5, logo: '', balance: '0', _addable: true }];
    }
    return matches;
  }, [qrcTokens, tokenMgrQuery, tokenBalances]);

  // Load the persisted hidden-token set and the hide-balances preference on mount.
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
      try {
        const hb = await AsyncStorage.getItem('qnet_hide_balances');
        if (hb === '1') setBalancesHidden(true);
      } catch (_) {}
    })();
  }, []);

  // A figure ('qnc', 'sol', 'oneDev') a read of this session put on screen for `owner`: a cached one never replaces it.
  // `done`: the QNC read is over (its proof decided), and the figures are no longer being updated. `readAt`: when the QNC
  // answer was read (its figure and its proof are one read). When nothing changed the status object stays the same, so
  // the screen does not render again for it.
  const noteFreshFigure = (owner, field, done = true, readAt = Date.now()) => {
    if (freshFiguresRef.current.owner !== owner) freshFiguresRef.current = { owner };
    freshFiguresRef.current[field] = true;
    setBalanceStatus((prev) => {
      const same = prev.owner === owner;
      const state = field === 'qnc' && done ? 'fresh' : (same ? prev.state : 'updating');
      const at = field === 'qnc' ? readAt : (same ? prev.at : 0);
      if (same && prev.known[field] && prev.state === state && prev.at === at) return prev;
      return { owner, state, at, known: { ...(same ? prev.known : {}), [field]: true } };
    });
  };

  // The last verified balances of this wallet, kept from an earlier session (WalletManager.loadBalanceSnapshot), on
  // screen the moment it opens, marked as being updated; a figure this session already read stays. Figures already on
  // screen for this wallet (an unlock after a lock) are only marked as being updated.
  const showKeptBalances = async (owner) => {
    if (!owner) return;
    setBalanceStatus((prev) => (prev.owner === owner
      ? { ...prev, state: prev.state === 'fresh' || prev.state === 'stale' ? 'updating' : prev.state }
      : { owner, state: 'updating', at: 0, known: {} }));
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
      if (owner) {
        setBalanceStatus((prev) => (prev.owner !== owner ? { owner, state: 'updating', at: 0, known: {} }
          : prev.state === 'stale' || prev.state === 'idle' ? { ...prev, state: 'updating' } : prev));
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

      // The optimistic hold after a send: the expected (lower) balance stands until the queried node has caught up to
      // our TX, or two minutes passed. `settle` also ends the hold (the verified read does; the early figure does not).
      const held = (q, settle) => {
        if (!pendingTxRef.current) return { q, optimistic: false };
        const { expectedQnc, timestamp } = pendingTxRef.current;
        if (q <= expectedQnc || Date.now() - timestamp >= 120000) {
          if (settle) {
            pendingTxRef.current = null;
            if (txPollingRef.current) { clearInterval(txPollingRef.current); txPollingRef.current = null; }
          }
          return { q, optimistic: false };
        }
        return { q: expectedQnc, optimistic: true }; // block not yet on this node — hold optimistic
      };

      // v3.27: TRUSTLESS - Get balance WITH Merkle proof verification
      let figureAt = 0; // when the QNC answer was read: its figure lands first, its proof decides later
      const qncResult = await walletManager.getQNCBalanceWithProof(qnetAddr, true, {
        onFigure: (f) => {
          if (gone() || !owner || !Number.isFinite(f.balance)) return;
          const { q, optimistic } = held(f.balance, false);
          figureAt = Date.now();
          setTokenBalances((prev) => mergeTokenBalances(prev, { owner, qnc: q, verified: false, optimistic }));
          noteFreshFigure(owner, 'qnc', false, figureAt);
        },
      });

      if (gone()) return;

      // This wallet's unconfirmed transactions stay alive while the app is open: the one at the account's next
      // nonce is sent again when no node holds it (a send "in addition" gets in once the one before applies), for
      // as long as the wallet still sends it (MOBNET-R3-01). The Assets list follows.
      if (qnetAddr) {
        walletManager.sendDuePending(qnetAddr).catch(() => {}).finally(() => { refreshKept(qnetAddr); });
      }

      const qncOk = !!qncResult?.ok;
      const isBalanceVerified = qncResult?.verified || false;

      // Resolve the QNC value to apply OUTSIDE the state updater (it mutates refs). The optimistic-send
      // guard holds the expected (lower) balance until the queried node has caught up to our TX.
      let qncToApply = null; // null ⇒ QNC fetch failed: keep last-known, never flash 0
      let optimistic = false;
      if (qncOk) ({ q: qncToApply, optimistic } = held(qncResult.balance, true));
      // One unproven answer lower than the figure shown may be a lagging node, so it does not lower it by itself;
      // two genesis nodes agreeing on the lower figure do (MOBNET-R3-04): a spend made from the browser, the extension
      // or by anyone holding the phrase then shows here instead of the old, higher balance.
      let agreed = false;
      const shown = shownBalancesRef.current;
      if (qncOk && !isBalanceVerified && !optimistic && qnetAddr && shown && shown.owner === qnetAddr
          && qncToApply < (shown.qnc || 0)) {
        const agreedQnc = await walletManager.agreedGenesisBalance(qnetAddr).catch(() => null);
        if (gone()) return;
        if (agreedQnc !== null && Number.isFinite(agreedQnc)) { qncToApply = agreedQnc; agreed = true; }
      }
      // "Verified by proof" only for the figure a proof covered: never while the optimistic hold after a send
      // shows the expected balance instead (MOBNET-R2-07).
      setBalanceVerified && setBalanceVerified(qncOk && isBalanceVerified && !optimistic);

      // Merge: overwrite a figure ONLY when its fetch succeeded (null/failed ⇒ keep last-known) — and
      // "last-known" is only ever this same address's; another wallet's balances start from zero.
      setTokenBalances(prev => mergeTokenBalances(prev, {
        owner, qnc: qncToApply, verified: isBalanceVerified, optimistic, agreed,
      }));
      if (owner && qncOk) noteFreshFigure(owner, 'qnc', true, figureAt || Date.now());
      if (owner && !qncOk) {
        // The first read of this session found no figure: the screen says the figures shown are not updated.
        setBalanceStatus((prev) => (prev.owner === owner && prev.state === 'updating' ? { ...prev, state: 'stale' } : prev));
      }

      await Promise.all([solRead, oneDevRead]);
      if (owner && qncOk && isBalanceVerified && !optimistic && !gone()) {
        keepBalances(owner, { balance: qncToApply, balanceNano: qncResult.balanceNano, blockHeight: qncResult.blockHeight }, got);
      }
    } catch (error) {
      // Retry once after a delay if network error
      if (error.message && (error.message.includes('fetch') || error.message.includes('network'))) {
        setTimeout(() => {
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

  // The socket closes with nothing scheduled (the app went to the background, the wallet changed or locked).
  const closeWebSocket = () => {
    if (wsReconnectTimerRef.current) { clearTimeout(wsReconnectTimerRef.current); wsReconnectTimerRef.current = null; }
    wsOpenRef.current = false;
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
        wsOpenRef.current = true;
        wsFailuresRef.current = 0; // a good connection starts the count again
        logger.log('[WS] connected');
      };

      // Every feed event is a hint and nothing more: it says something may have changed, and the wallet
      // then reads again the way it always does — the balance through its committee-certified proof,
      // history from the explorer and a genesis node. No event sets a balance, adds a row or marks a
      // transaction confirmed on its own say-so.
      const reloadHistorySoon = (ms) => {
        if (txHistoryDebounceRef.current) clearTimeout(txHistoryDebounceRef.current);
        txHistoryDebounceRef.current = setTimeout(() => { txHistoryDebounceRef.current = null; loadTxHistory(); }, ms);
      };
      const reloadBalanceSoon = () => {
        if (wsBalanceDebounceRef.current) clearTimeout(wsBalanceDebounceRef.current);
        wsBalanceDebounceRef.current = setTimeout(() => {
          wsBalanceDebounceRef.current = null;
          if (wallet?.publicKey) loadBalance(wallet.publicKey);
        }, 1200);
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const myAddr = myAddress.toLowerCase();

          // BalanceUpdate on account:${addr}, or a legacy block/microblock event naming this wallet.
          const legacyTxs = (data.type === 'block' || data.type === 'microblock')
            ? (data.transactions || data.block?.transactions || []) : [];
          const touchesMe = (data.type === 'BalanceUpdate' && data.data
              && (data.data.address || '').toLowerCase() === myAddr)
            || legacyTxs.some((tx) => [tx.from, tx.sender, tx.to, tx.recipient]
              .some((a) => (a || '').toLowerCase() === myAddr));
          if (touchesMe) {
            reloadBalanceSoon();
            reloadHistorySoon(1200);
          }
        } catch (e) {
          // Parse error - ignore
        }
      };
      
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        wsOpenRef.current = false;
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

  // `fresh`: the user asked (tab opened, pull-to-refresh, wallet loaded, return to the app): the explorer is asked then
  // only. Background refreshes (the timer, a socket event) ask one genesis node, which covers the newest rows.
  const loadTxHistory = async (fresh = false) => {
    if (!wallet?.qnetAddress) return;
    const address = wallet.qnetAddress;

    try {
      const myAddress = address.toLowerCase();
      const apiUrl = walletManager.trustedNodeUrl(); // history is not proven: a genesis node, not a third party
      const nodeJson = (path) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5000);
        return fetch(`${apiUrl}${path}`, { method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal })
          .then(r => (r.ok ? r.json() : null)).catch(() => null).finally(() => clearTimeout(timer));
      };
      const [explorerPage, nodeNative, nodeTokenEvents, nodeEventsData] = await Promise.all([
        fresh ? fetchExplorerHistory(address, null) : null,
        nodeJson(`/api/v1/account/${address}/transactions?limit=${HISTORY_PAGE}`),
        walletManager.getAccountTokenTransfers(address, HISTORY_PAGE),
        // Node lifecycle comes from the registry: the registration TX leaves the tx index a day later.
        nodeJson(`/api/v1/account/${address}/node-events`),
      ]);
      if (lastHistoryAddrRef.current !== address) return;   // the wallet changed while this was in flight

      const archived = explorerPage ? splitExplorerItems(explorerPage.items, address) : { native: [], tokenEvents: [] };

      // Token events from both feeds, one per (hash, log index). The node's row is the one its inclusion
      // proof can bind; the explorer's says the transfer is already on chain.
      const events = new Map();
      for (const ev of archived.tokenEvents) events.set(`${ev.tx_hash}:${ev.log_index}`, ev);
      for (const ev of (nodeTokenEvents || [])) {
        // A source may return rows unrelated to this wallet: only transfers it is a party to.
        if (String(ev.from || '').toLowerCase() !== myAddress && String(ev.to || '').toLowerCase() !== myAddress) continue;
        const k = `${ev.tx_hash}:${ev.log_index}`;
        events.set(k, { ...ev, archived: !!events.get(k)?.archived });
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

      const nodeEventTxs = ((nodeEventsData && nodeEventsData.events) || []).map(ev => ({
        hash: `node:${ev.node_id}`,
        nodeEvent: true,
        nodeId: ev.node_id,
        nodeType: ev.node_type,
        height: ev.height,
        from: myAddress,
        to: null,
        amount: 0,
        fee: 0,
        status: 'confirmed',
        timestamp: (ev.timestamp || 0) * 1000,
        type: 'receive',
      }));

      // Nothing answered: what is on screen is the best record there is.
      if (!explorerPage && !nodeNative && !nodeEventsData && tokenTxs.length === 0) return;

      // The span the explorer page vouches for: all of history on its last page, down to its oldest row
      // otherwise. Without the explorer nothing already shown is dropped.
      const archivedTimes = [...archived.native, ...tokenTxs.filter(row => row.status === 'confirmed')].map(row => row.timestamp || 0);
      const coveredFromMs = !explorerPage ? Infinity
        : (explorerPage.next_cursor && archivedTimes.length ? Math.min(...archivedTimes) : 0);
      if (explorerPage && historyCursorRef.current === undefined) historyCursorRef.current = explorerPage.next_cursor || null;

      // A send about to be marked not found is asked about by its nonce first (L-10): it may have landed under fifty
      // newer rows, or as a hedged copy under another hash. No answer keeps it pending for a later refresh.
      const freshRows = [...nativeTxs, ...tokenTxs, ...nodeEventTxs];
      const settled = new Map();
      await Promise.all(rowsDueToDrop(txHistoryRef.current, freshRows, { myAddress, nowMs: Date.now() })
        .filter((r) => r.settle && Number.isSafeInteger(r.settle.nonce) && r.settle.from)
        .map(async (r) => {
          const s = r.settle;
          const res = await walletManager.resolveSubmitByNonce(s.from, s.nonce, {
            toAddress: s.to || null, amountNano: s.amountNano == null ? null : s.amountNano, kind: s.kind || 'transfer',
            method: s.method || null, recipient: s.recipient || null, amountBase: s.amountBase || null,
          }).catch(() => null);
          const key = String(r.hash).toLowerCase();
          if (!res || !res.known) settled.set(key, { unread: true });
          else if (res.landed) settled.set(key, { landed: true, txHash: res.txHash || r.hash });
          else if (res.replaced || res.unbound) settled.set(key, { gone: true });
        }));
      if (lastHistoryAddrRef.current !== address) return;

      setTxHistory(prev => {
        const merged = mergeHistory(prev, freshRows, {
          myAddress, coveredFromMs, nowMs: Date.now(), nodeEventsOk: !!nodeEventsData, settled,
        });
        saveCachedHistory(myAddress, cacheableHistory(merged)).catch(() => {});
        return merged;
      });

      // P4: verify each token transfer's inclusion against a committee-QC-anchored logs_root. 'verified'
      // → confirmed + trust badge; 'consistent' → confirmed but unverified (real on-chain row below the
      // trust floor); 'rejected'/'pending' → unchanged. Only rows a node can still prove are asked about:
      // an archived transfer older than the node's window has no proof left to fetch.
      const provable = tokenTxs.filter(row => (row.timestamp || 0) > Date.now() - 24 * 3600 * 1000);
      if (provable.length) {
        // After the balance read in flight, and HISTORY_PROOF_CONCURRENCY at a time: each check may walk to an old
        // macroblock, and a balance read on the same parity chain would otherwise wait behind those walks.
        const balanceRead = balanceRunRef.current;
        if (balanceRead && balanceRead.promise) await balanceRead.promise.catch(() => {});
        if (lastHistoryAddrRef.current !== address) return;
        const statuses = new Map();
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
            if (s === 'verified' || s === 'consistent') statuses.set(tx.hash + ':' + tx.tokenLogIndex, s);
          }
        };
        await Promise.all(Array.from({ length: Math.min(HISTORY_PROOF_CONCURRENCY, provable.length) }, proveRows));
        if (statuses.size) {
          setTxHistory(prev => prev.map(tx => {
            const s = tx.tokenContract ? statuses.get(tx.hash + ':' + tx.tokenLogIndex) : undefined;
            return s ? { ...tx, status: 'confirmed', verified: s === 'verified' } : tx;
          }));
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
      setTxHistory(prev => {
        const merged = appendHistory(prev, rows);
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
  // `settle`: the send's (from, nonce) and what it moved, as the confirmation poll takes it, so a row about to be marked
  // not found is asked about by its nonce first (loadTxHistory, L-10).
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

  const revealSecret = async (kind, readersAcknowledged = false) => {
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
      if (!r || !r.ok) { refusePassword(r); return; }
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
        setKeyCopied(null);
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
    const ok = await walletManager.enableBiometricUnlock(biometricPassword);
    setBiometricPassword('');
    setShowBiometricPasswordPrompt(false);
    if (ok) {
      setBiometricEnabled(true);
      showAlert('', t('biometric_enabled_msg'));
    } else {
      showAlert(t('error'), t('biometric_unavailable'));
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
    setBalanceStatus({ owner: nextQnetAddress, state: 'idle', at: 0, known: {} });
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
    setActivatedNodeType(null);
    setNodePseudonym('');
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
   * Erases the wallet from this device: the light node stops, every app key except language and network
   * goes, every Keychain item and Keystore key goes. Only after a fresh authentication (see callers).
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
      setHasWallet(false);
      loadSettings();
      await Promise.resolve(sent).catch(() => false);
    } finally {
      setErasing(false);
    }
  };

  // Settings → Delete wallet: confirm, then a fresh authentication (the password, or the screen lock).
  const deleteWallet = async () => {
    showAlert(
      `⚠️ ${t('delete_wallet')}`,
      t('delete_wallet_confirm'),
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
              showAlert('', t('wallet_deleted'));
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
      showAlert('', t('wallet_deleted'));
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
      if (!auth.ok && auth.code !== 'not_set') return;
    }
    setShowEraseConfirm(false);
    setEraseText('');
    try {
      await eraseWallet();
      showAlert(t('erased_title'), t('erased_body'));
    } catch (error) {
      showAlert(t('error'), errorText(t, error, 'err_erase_wallet'));
    }
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
        <SafeAreaView style={[styles.termsModal, dirStyle]}>
          <View style={styles.termsModalContent}>
            <View style={styles.termsModalHeader}>
              <Text style={styles.termsModalTitle}>{t('terms_title')}</Text>
              <TouchableOpacity
                style={styles.termsModalClose}
                accessibilityRole="button"
                accessibilityLabel={t('common_close')}
                onPress={() => setShowTermsModal(false)}
              >
                <Text style={styles.termsModalCloseText}>×</Text>
              </TouchableOpacity>
            </View>
            
            <ScrollView 
              style={styles.termsModalBody}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
            >
              <Text style={styles.termsModalText}>{t('terms_text')}</Text>
              {LEGAL_LINKS.slice(0, 2).map(([labelKey, url]) => (
                <TouchableOpacity key={url} onPress={() => Linking.openURL(url).catch(() => {})}>
                  <Text style={[styles.termsModalText, { color: '#00d4ff', marginTop: 12 }]}>{t(labelKey)}: {url}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            
            <View style={styles.termsModalButtons}>
              <TouchableOpacity 
                style={[styles.termsModalButton, styles.termsModalDecline]}
                onPress={() => {
                  setShowTermsModal(false);
                  setTermsAccepted(false);
                }}
              >
                <Text style={[styles.termsModalButtonText, styles.termsModalDeclineText]}>
                  {t('decline')}
                </Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.termsModalButton, styles.termsModalAccept]}
                onPress={() => {
                  setShowTermsModal(false);
                  setTermsAccepted(true);
                }}
              >
                <Text style={[styles.termsModalButtonText, styles.termsModalAcceptText]}>
                  {t('accept')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </Modal>
    );
  };

  // Custom alert (styled like extension). Every screen renders it, so an alert raised before the wallet opens is shown too.
  const renderCustomAlert = () => {
    if (!customAlert) return null;

    return (
      <KeyboardAvoidingView style={[styles.modalOverlay, styles.modalOverlayKeyboard]} behavior="padding">
        <View style={[styles.modalBox, { maxWidth: 350 }]}>
          {/* Modal Header with icon */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              {customAlert.title}
            </Text>
          </View>

          {/* Modal Content: scrolls inside the box, so a long body never pushes the actions out */}
          <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalContent}>
              {customAlert.message}
            </Text>
          </ScrollView>

          {/* Modal Actions */}
          <View style={styles.modalActions}>
            {customAlert.buttons.map((button, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.modalButton,
                  button.style === 'destructive' ?
                    styles.modalButtonDanger :
                    button.style === 'cancel' ?
                      styles.modalButtonSecondary :
                      styles.modalButtonPrimary,
                ]}
                onPress={() => {
                  setCustomAlert(null);
                  if (button.onPress) button.onPress();
                }}
              >
                <Text style={[
                  styles.modalButtonText,
                  button.style === 'destructive' && styles.modalButtonTextDanger,
                  button.style === 'cancel' && styles.modalButtonTextSecondary
                ]}>
                  {button.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </KeyboardAvoidingView>
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

  const selectTab = (tab) => {
    setShowHeaderMenu(false);
    if (tab === 'browser') setBrowserStarted(true);
    // A switch reads through the tab's own effect (once, not twice); a tap on the tab already open reads it again.
    if (tab === activeTab && tab === 'assets' && wallet && wallet.publicKey) loadBalance(wallet.publicKey);
    if (tab === activeTab && tab === 'history') loadTxHistory(true);
    setActiveTab(tab);
  };

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
          rtl={rtl}
          onSheet={setDappSheet}
          confirmAction={confirmBrowserAction}
          onSent={onDappSent}
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

  // Screens that show or take a secret: the recovery phrase (shown, checked, typed), any password field. While one
  // is up the screen cannot be captured (FLAG_SECURE; iOS covers the window while it is recorded) and overlays and
  // non-assistive accessibility services are kept out. Declared before the early returns below, as every hook must be.
  const secretScreen = !!seedReveal || !!keyReveal
    || (!hasWallet && !!showCreateOptions)
    || showSeedConfirm
    || (hasWallet && !wallet)
    || showExportSeed || showChangePassword || showBiometricPasswordPrompt
    || showDeletePrompt || showEraseConfirm || !!freshPrompt;
  useSecureScreen(secretScreen);
  // Screens whose taps move value or approve a request: the send form (with its pending-choice and fresh-check
  // dialogs on top), a browser site's sheet, aiqnet.io's QNet Link request (MPLAT-R2-01).
  useProtectedInteraction(showSendScreen || !!dappSheet || !!linkRequest);
  // "Copied" belongs to the phrase on screen: a phrase shown again, or another screen, starts with Copy.
  useEffect(() => { setSeedCopied(false); }, [seedReveal, showCreateOptions]);

  // The recovery phrase's Copy, on an explicit tap only: the clipboard is cleared after SECRET_CLIPBOARD_SECONDS if it
  // still holds the phrase, and at once when the wallet is deleted (DeviceSecurity copySecret, WalletManager eraseAllData).
  const copyRecoveryPhrase = async (words) => {
    if (await copySecret(words.join(' '))) setSeedCopied(true);
  };

  // The revealed recovery phrase (owner, 06.10): shown at once after the check, with Copy and Done, as the extension
  // shows it; the one warning is said before the password. No clipboard text (the copy still leaves the clipboard
  // after SECRET_CLIPBOARD_SECONDS). Gone on Done, on lock and on leaving the app.
  const renderSeedReveal = () => {
    if (!seedReveal) return null;
    return (
      <View style={styles.modalOverlay}>
        <View style={[styles.modalBox, { maxWidth: 380 }]}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalBody}>
            <Text style={styles.modalTitle}>{t('export_recovery_phrase')}</Text>
            <View style={[styles.seedGrid, { marginVertical: 10 }]}>
              {seedReveal.map((word, index) => (
                <View key={index} style={[styles.seedWordContainer, { padding: 8, marginBottom: 6 }]}>
                  <Text style={[styles.seedWordNumber, { fontSize: 11 }]}>{index + 1}</Text>
                  <Text style={[styles.seedWordText, { fontSize: 13 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>{word}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalButtonSecondary]}
              onPress={() => copyRecoveryPhrase(seedReveal)}
            >
              <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t(seedCopied ? 'common_copied' : 'seed_copy')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalButtonPrimary]}
              onPress={() => setSeedReveal(null)}
            >
              <Text style={styles.modalButtonText}>{t('common_done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  const closeKeyReveal = () => { setKeyReveal(null); setKeyCopied(null); };

  // A private key's Copy, on an explicit tap only, under the phrase's rule: off the clipboard after
  // SECRET_CLIPBOARD_SECONDS if it is still there, and at once when the wallet is deleted.
  const copyPrivateKey = async (which) => {
    const entry = keyReveal && keyReveal[which];
    if (entry && entry.key && await copySecret(entry.key)) setKeyCopied(which);
  };

  // The revealed private key (owner, 06.10): shown at once after the check, the key of the account chosen before the
  // password (the QNet wallet key or the Solana key) under its name with the form it is written in, its Copy, then
  // Done, as the extension shows it; the one warning is said before the password. No hold to show, no address, no
  // clipboard text (a copy still leaves the clipboard after SECRET_CLIPBOARD_SECONDS). Gone on Done, on lock and on
  // leaving the app. Importing a wallet by a private key is not offered: a wallet is restored from its phrase.
  const renderKeyReveal = () => {
    if (!keyReveal) return null;
    const blocks = KEY_ACCOUNTS.filter(([which]) => keyReveal[which]);
    return (
      <View style={styles.modalOverlay}>
        <View style={[styles.modalBox, { maxWidth: 380 }]}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalBody}>
            <Text style={styles.modalTitle}>{t('export_private_key')}</Text>
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
                      <TouchableOpacity
                        style={[styles.modalButton, styles.modalButtonSecondary, styles.keyRevealCopy]}
                        onPress={() => copyPrivateKey(which)}
                        accessibilityRole="button"
                        testID={'key-copy-' + which}
                      >
                        <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t(keyCopied === which ? 'common_copied' : 'seed_copy')}</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <Text style={styles.modalWarning}>{t('private_key_unavailable')}</Text>
                  )}
                </View>
              );
            })}
          </ScrollView>
          <View style={styles.modalActions}>
            <TouchableOpacity style={[styles.modalButton, styles.modalButtonPrimary]} onPress={closeKeyReveal} testID="key-reveal-done">
              <Text style={styles.modalButtonText}>{t('common_done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  // Type ERASE, then (under the screen lock) a fresh device authentication: erase this wallet and restore it from its
  // phrase.
  const renderEraseConfirm = () => {
    if (!showEraseConfirm) return null;
    return (
      <KeyboardAvoidingView style={[styles.modalOverlay, styles.modalOverlayKeyboard]} behavior="padding">
        <View style={styles.modalBox}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t('erase_title')}</Text>
            <Text style={styles.modalWarning}>{t('erase_warning')}</Text>
            <Text style={styles.modalContent}>{t('erase_type_confirm', { word: 'ERASE' })}</Text>
            <TextInput
              style={styles.input}
              placeholder="ERASE"
              placeholderTextColor="#888"
              value={eraseText}
              onChangeText={setEraseText}
              {...CONFIRM_INPUT_PROPS}
            />
          </ScrollView>
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalButtonSecondary]}
              onPress={() => { setShowEraseConfirm(false); setEraseText(''); }}
            >
              <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalButtonDanger]}
              onPress={confirmErase}
            >
              <Text style={[styles.modalButtonText, styles.modalButtonTextDanger]}>{t('erase_button')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  };

  // A password wallet: the password asked again (confirmFresh) — every send, and relaxing a security setting — when
  // biometric confirmation is not set up or the user chose the password; with the screen-reading apps named, if any.
  const renderFreshPrompt = () => {
    if (!freshPrompt) return null;
    return (
      <KeyboardAvoidingView style={[styles.modalOverlay, styles.modalOverlayKeyboard]} behavior="padding">
        <View style={styles.modalBox}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t('fresh_title')}</Text>
            <Text style={styles.modalWarning}>{freshPrompt.reason}</Text>
            {freshPrompt.recipient ? (
              <>
                <Text style={styles.modalContent}>{t('send_review_to')}</Text>
                <Text style={styles.freshRecipient}>{freshPrompt.recipient}</Text>
              </>
            ) : null}
            {freshPrompt.note ? <Text style={styles.modalWarning}>{freshPrompt.note}</Text> : null}
            <TextInput
              style={styles.input}
              placeholder={t('password')}
              accessibilityLabel={t('fresh_title')}
              placeholderTextColor="#888"
              value={freshPassword}
              onChangeText={setFreshPassword}
              onSubmitEditing={submitFresh}
              returnKeyType="done"
              {...PASSWORD_INPUT_PROPS}
            />
          </ScrollView>
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalButtonSecondary]}
              onPress={() => resolveFresh(false)}
            >
              <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalButtonPrimary]}
              onPress={submitFresh}
            >
              <Text style={styles.modalButtonText}>{t('common_confirm')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  };

  // A password wallet: Delete wallet asks for the password (counted by the lockout).
  const renderDeletePrompt = () => {
    if (!showDeletePrompt) return null;
    return (
      <KeyboardAvoidingView style={[styles.modalOverlay, styles.modalOverlayKeyboard]} behavior="padding">
        <View style={styles.modalBox}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t('delete_wallet')}</Text>
            <Text style={styles.modalWarning}>{t('delete_enter_password')}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('password')}
              accessibilityLabel={t('delete_enter_password')}
              placeholderTextColor="#888"
              value={deletePassword}
              onChangeText={setDeletePassword}
              onSubmitEditing={confirmDeleteWithPassword}
              returnKeyType="done"
              {...PASSWORD_INPUT_PROPS}
            />
          </ScrollView>
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalButtonSecondary]}
              onPress={() => { setShowDeletePrompt(false); setDeletePassword(''); }}
            >
              <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalButtonDanger]}
              onPress={confirmDeleteWithPassword}
            >
              <Text style={[styles.modalButtonText, styles.modalButtonTextDanger]}>{t('delete_wallet')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  };

  // A QNet Link request, over the open wallet (or over the start screen when there is no wallet, which only
  // answers that). Never shown while the wallet is locked; the lock screen says a request is waiting.
  const renderLinkRequest = () => {
    if (!linkRequest) return null;
    const { key } = linkRequest;
    const owner = `link:${key}`;
    const done = () => {
      dropFreshOf(owner);
      setLinkRequest((r) => (r && r.key === key ? nextQueuedLink(r) : r));
    };
    // The Node side of the request, for the open wallet (none while there is no wallet: the request answers only that).
    const node = wallet && !LEGACY_MOVE ? nodeLinkActions({
      walletManager, credential: password, serverNode: !!serverNodeTypeOf(activatedNodeType),
      claimBusy: () => movingRef.current,
      // An unlink this device confirmed: the Node tab reads the network again.
      onUnlinked: () => { loadLightNodeStatus(); },
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
        onSettled={() => setLinkRequest((r) => (r && r.key === key ? { ...r, settled: true } : r))}
        onOutcome={(outcome) => setLinkRequest((r) => (r && r.key === key ? { ...r, settled: true, outcome } : r))}
        onShown={() => setLinkRequest((r) => (r && r.key === key && !r.seen ? { ...r, seen: true } : r))}
        onGone={() => dropFreshOf(owner)}
        onClose={done}
      />
    );
  };

  // The first read of the stored wallet, and a wallet being deleted: the app's mark and name, and what is happening. No
  // welcome screen of a device without a wallet ever shows before the wallet on it was looked for.
  if (erasing || !walletKnown) {
    return (
      <SafeAreaView style={[styles.container, dirStyle]} edges={SCREEN_EDGES}>
        <View style={styles.centerContent}>
          <Image source={require('../../assets/qnet_logo.png')} style={styles.lockLogo} resizeMode="contain" />
          <Text style={styles.title}>{t('qnet_wallet')}</Text>
          {erasing ? <Text style={styles.subtitle}>{t('deleting_wallet')}</Text> : null}
        </View>
        {renderCustomAlert()}
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, dirStyle]}>
        {renderBrowserPane('loading')}
        <View style={styles.centerContent}>
          <Text style={styles.title}>{t('qnet_wallet')}</Text>
          <Text style={styles.subtitle}>{t('common_loading')}</Text>
        </View>
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
        style={[styles.container, dirStyle]}
        edges={SCREEN_EDGES}
      >
        <View style={styles.centerContent}>
          <Text style={styles.title}>{t('qnet_wallet')}</Text>
          <Text style={styles.subtitle}>
            {t(vaultProblem === 'corrupt' ? 'vault_corrupt' : vaultProblem === 'unreadable' ? 'vault_unreadable' : 'vault_device_key')}
          </Text>
          {vaultProblem !== 'unreadable' && (
            <Text style={[styles.modalContent, { marginBottom: 16 }]}>
              {t('vault_nothing_deleted')}
            </Text>
          )}
          <TouchableOpacity style={styles.button} onPress={() => { setVaultProblem(null); checkWalletExists(); }}>
            <Text style={styles.buttonText}>{t('common_try_again')}</Text>
          </TouchableOpacity>
          {/* Storage that cannot be read right now may read again: nothing is offered to erase for that. */}
          {vaultProblem !== 'unreadable' && (
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={() => { setEraseText(''); setShowEraseConfirm(true); }}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('erase_and_restore')}</Text>
            </TouchableOpacity>
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
      <SafeAreaView style={[styles.container, dirStyle]} onTouchStart={handleUserActivity}>
        <ScrollView
          contentContainerStyle={styles.seedConfirmContent}
          showsVerticalScrollIndicator={true}
          bounces={true}
          scrollEnabled={true}
        >
          <Text style={styles.title}>{t('seed_confirm_title')}</Text>
          <Text style={styles.subtitle}>
            {t('seed_confirm_subtitle')}
          </Text>
          
          {positions.map(pos => (
            <View key={pos} style={styles.seedConfirmGroup}>
              <Text style={styles.label}>{t('seed_select_word_label', { n: pos + 1 })}</Text>
              <View style={styles.wordChoicesContainer}>
                {wordChoices[pos]?.map((word, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={[
                      styles.wordChoiceButton,
                      seedConfirmWords[pos] === word && styles.wordChoiceSelected
                    ]}
                    onPress={() => {
                      // Clear error when user makes a selection
                      setVerificationError('');
                      setSeedConfirmWords({
                        ...seedConfirmWords,
                        [pos]: word
                      });
                    }}
                  >
                    <Text style={[
                      styles.wordChoiceText,
                      seedConfirmWords[pos] === word && styles.wordChoiceTextSelected
                    ]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                      {word}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}
          
          {/* Verification Error Message (like in browser extension) */}
          {verificationError ? (
            <View style={styles.verificationErrorBox}>
              <Text style={styles.verificationErrorText}>{verificationError}</Text>
            </View>
          ) : null}
          
          <TouchableOpacity 
            style={styles.button}
            onPress={confirmSeedPhrase}
            disabled={Boolean(loading || !Object.values(seedConfirmWords).every(w => w && w.length > 0))}
          >
            <Text style={styles.buttonText}>
              {loading ? t('verifying') : t('seed_confirm_create')}
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={[styles.button, styles.secondaryButton]}
            onPress={() => {
              // Clear error when going back
              setVerificationError('');
              // Direct action without modal for better UX
              setShowSeedConfirm(false);
              setShowCreateOptions('show-seed'); // Go back to seed display
            }}
          >
            <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('common_back')}</Text>
          </TouchableOpacity>
        </ScrollView>
        {renderCustomAlert()}
      </SafeAreaView>
    );
  }

  if (!hasWallet) {
    if (!showCreateOptions) {
      return (
        <SafeAreaView 
          style={[styles.container, dirStyle]}
          edges={SCREEN_EDGES}
        >
          <View style={styles.centerContent}>
            <Text style={styles.title}>{t('qnet_wallet')}</Text>
            <Text style={styles.subtitle}>{t('welcome_subtitle')}</Text>
            
            <TouchableOpacity 
              style={styles.button}
              onPress={() => {
                // Clear all password fields when starting create
                setPassword('');
                setConfirmPassword('');
                setPasswordError('');
                setTermsAccepted(false); // Reset terms
                setShowCreateOptions('create');
              }}
            >
              <Text style={styles.buttonText}>{t('create_new_wallet')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={async () => {
                // Under the screen lock there is no password step: the phrase field is the first screen of the import,
                // so the checks that otherwise follow the password step run here.
                if (deviceAuth && !(await confirmPhraseScreen())) return;
                // Clear all password fields when starting import
                setPassword('');
                setConfirmPassword('');
                setSeedPhrase('');
                setPasswordError('');
                setTermsAccepted(false); // Reset terms
                setImportStep(1);
                setShowCreateOptions('import');
              }}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('import_wallet')}</Text>
            </TouchableOpacity>
          </View>
          {vaultChecked ? renderLinkRequest() : null}
          {renderCustomAlert()}
        </SafeAreaView>
      );
    }

    if (showCreateOptions === 'create') {
      return (
        <SafeAreaView 
          style={[styles.container, dirStyle]}
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
            <Text style={styles.title}>{t('create_wallet')}</Text>
            <Text style={styles.subtitle}>
              {deviceAuth ? t('create_protected') : t('create_password_hint', { min: MIN_PASSWORD })}
            </Text>

            {!deviceAuth && (<>
            <TextInput
              style={[styles.input, passwordError && typedPassword.length > 0 && typedPassword.length < MIN_PASSWORD ? styles.inputError : null]}
              placeholder={t('enter_password')}
              placeholderTextColor="#888"
              {...PASSWORD_INPUT_PROPS}
              value={typedPassword}
              onChangeText={(text) => {
                setPassword(text);
                setPasswordError('');
              }}
            />

            {renderPasswordLength(typedPassword)}

            <TextInput
              style={[styles.input, passwordError && confirmPassword.length > 0 && typedPassword !== confirmPassword ? styles.inputError : null]}
              placeholder={t('confirm_password')}
              placeholderTextColor="#888"
              {...PASSWORD_INPUT_PROPS}
              value={confirmPassword}
              onChangeText={(text) => {
                setConfirmPassword(text);
                setPasswordError('');
              }}
            />

            {renderPasswordMatch(typedPassword, confirmPassword)}
            </>)}

            {passwordError ? (
              <Text style={styles.errorText}>{passwordError}</Text>
            ) : null}
            
            {/* Terms of Service Checkbox */}
            <View style={styles.termsContainer}>
            <TouchableOpacity 
                style={styles.checkbox}
                onPress={() => setTermsAccepted(!termsAccepted)}
              >
                <View style={[styles.checkboxInner, termsAccepted && styles.checkboxChecked]}>
                  {termsAccepted && <Text style={styles.checkmark}>✓</Text>}
                </View>
              </TouchableOpacity>
              <View style={styles.termsTextContainer}>
                <Text style={styles.termsText}>
                  {termsParts[0]}
                  <Text style={styles.termsLink} onPress={() => setShowTermsModal(true)} accessibilityRole="link">{t('terms_of_service')}</Text>
                  {termsParts[1]}
                </Text>
              </View>
            </View>
            
            <TouchableOpacity 
              style={[styles.button, !termsAccepted && styles.buttonDisabled]}
              onPress={createWallet}
              disabled={loading || !termsAccepted}
            >
              <Text style={styles.buttonText}>
                {loading ? t('creating') : t('create_wallet')}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton]}
              onPress={() => {
                setShowCreateOptions(false);
                setPassword('');
                setConfirmPassword('');
                setPasswordError('');
                setTermsAccepted(false); // Reset terms
              }}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('common_back')}</Text>
            </TouchableOpacity>
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
        <SafeAreaView style={[styles.container, dirStyle]} onTouchStart={handleUserActivity}>
          <ScrollView
            contentContainerStyle={[styles.formContent, {paddingTop: 40, paddingBottom: 100}]}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            <Text style={[styles.title, {fontSize: 18}]}>{t('seed_save_title')}</Text>
            {/* Written down, then checked word by word; Copy puts it on the clipboard on an explicit tap only. */}
            <Text style={[styles.subtitle, {fontSize: 13, marginBottom: 15}]}>
              {t('seed_save_body')}
            </Text>

            <View style={[styles.seedGrid, {marginVertical: 10}]}>
              {words.map((word, index) => (
                <View key={index} style={[styles.seedWordContainer, {padding: 8, marginBottom: 6}]}>
                  <Text style={[styles.seedWordNumber, {fontSize: 11}]}>{index + 1}</Text>
                  <Text style={[styles.seedWordText, {fontSize: 13}]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>{word}</Text>
                </View>
              ))}
            </View>

            <Text style={[styles.seedWarningText, {marginTop: 10, marginBottom: 15, fontSize: 13}]}>
              ⚠️ {t('seed_never_share')}
            </Text>

            <Text style={[styles.subtitle, {fontSize: 13, marginBottom: 10}]}>
              {t('seed_copy_warning', { seconds: SECRET_CLIPBOARD_SECONDS })}
            </Text>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={() => copyRecoveryPhrase(words)}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t(seedCopied ? 'common_copied' : 'seed_copy')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, {marginBottom: 20}]}
              onPress={() => {
                setShowSeedConfirm(true);
                setShowCreateOptions(false);
              }}
            >
              <Text style={styles.buttonText}>{t('seed_wrote_it')}</Text>
            </TouchableOpacity>
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
            style={[styles.container, dirStyle]}
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
              <Text style={styles.title}>{t('import_title')}</Text>
              <Text style={styles.subtitle}>{t('import_step1', { min: MIN_PASSWORD })}</Text>
              
              <TextInput
                style={[styles.input, passwordError && typedPassword.length > 0 && typedPassword.length < MIN_PASSWORD ? styles.inputError : null]}
                placeholder={t('enter_password')}
                placeholderTextColor="#888"
                {...PASSWORD_INPUT_PROPS}
                value={typedPassword}
                onChangeText={(text) => {
                  setPassword(text);
                  setPasswordError('');
                }}
              />

              {renderPasswordLength(typedPassword)}

              <TextInput
                style={[styles.input, passwordError && confirmPassword.length > 0 && typedPassword !== confirmPassword ? styles.inputError : null]}
                placeholder={t('confirm_password')}
                placeholderTextColor="#888"
                {...PASSWORD_INPUT_PROPS}
                value={confirmPassword}
                onChangeText={(text) => {
                  setConfirmPassword(text);
                  setPasswordError('');
                }}
              />

              {renderPasswordMatch(typedPassword, confirmPassword)}

              {passwordError ? (
                <Text style={styles.errorText}>{passwordError}</Text>
              ) : null}
              
              <TouchableOpacity
                style={styles.button}
                onPress={async () => {
                  if (!validatePassword()) {
                    return;
                  }
                  if (!(await confirmPhraseScreen())) return;
                  setImportStep(2);
                }}
              >
                <Text style={styles.buttonText}>
                  {t('common_next')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.button, styles.secondaryButton]}
                onPress={() => {
                  setShowCreateOptions(false);
                  setPassword('');
                  setConfirmPassword('');
                  forgetImportPhrase();
                  setPasswordError('');
                  setTermsAccepted(false); // Reset terms
                  setImportStep(1);
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('common_back')}</Text>
              </TouchableOpacity>
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
            style={[styles.container, dirStyle]}
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
              <Text style={styles.title}>{t('import_title')}</Text>
              {/* Under the screen lock there is no password step: the phrase is the only one, with no number. */}
              <Text style={styles.subtitle}>{t(deviceAuth ? 'import_step_phrase' : 'import_step2')}</Text>

              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder={t('import_placeholder')}
                placeholderTextColor="#888"
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

              {passwordError ? (
                <Text style={styles.errorText}>{passwordError}</Text>
              ) : null}
              
              {/* Terms of Service Checkbox */}
              <View style={styles.termsContainer}>
              <TouchableOpacity 
                  style={styles.checkbox}
                  onPress={() => setTermsAccepted(!termsAccepted)}
                >
                  <View style={[styles.checkboxInner, termsAccepted && styles.checkboxChecked]}>
                    {termsAccepted && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                </TouchableOpacity>
                <View style={styles.termsTextContainer}>
                  <Text style={styles.termsText}>
                    {termsParts[0]}
                    <Text style={styles.termsLink} onPress={() => setShowTermsModal(true)} accessibilityRole="link">{t('terms_of_service')}</Text>
                    {termsParts[1]}
                  </Text>
                </View>
              </View>
              
              <TouchableOpacity 
                style={[styles.button, !termsAccepted && styles.buttonDisabled]}
                onPress={importWallet}
                disabled={loading || !termsAccepted}
              >
                <Text style={styles.buttonText}>
                  {loading ? t('importing') : t('import_title')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.button, styles.secondaryButton]}
                onPress={() => {
                  if (deviceAuth) { setShowCreateOptions(false); setPassword(''); setConfirmPassword(''); } // no password step under the screen lock
                  setImportStep(1);
                  forgetImportPhrase();
                  setPasswordError('');
                  setTermsAccepted(false); // Reset terms
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('common_back')}</Text>
              </TouchableOpacity>
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
        style={[styles.container, dirStyle]}
        edges={SCREEN_EDGES}
      >
        {renderBrowserPane('locked')}
        {/* A plain lock screen (owner, 04.10): the app's mark and name, the unlock itself, and the way out for a
            forgotten unlock as a small link that opens its own confirmation. No erase choice stands next to Unlock. */}
        <View style={styles.centerContent}>
          <Image source={require('../../assets/qnet_logo.png')} style={styles.lockLogo} resizeMode="contain" />
          <Text style={styles.title}>{t('qnet_wallet')}</Text>
          {linkRequest ? <Text style={styles.modalWarning}>{t('link_waiting_unlock')}</Text> : null}
          {/* The apps that can read the screen and act for you, under either lock: a password is typed here, and the
              screen lock's prompt is approved here. */}
          {lockReaders.length > 0 ? (
            <Text style={styles.modalWarning}>
              {t(deviceAuth ? 'readers_confirm_note' : 'readers_lock_note', { apps: lockReaders.join(', ') })}
            </Text>
          ) : null}

          {lockoutMs > 0 ? (
            <View style={styles.lockoutBanner}>
              <Text style={styles.lockoutText}>
                {t('unlock_locked_for', { time: lockoutDisplay })}
              </Text>
            </View>
          ) : deviceAuth ? (
            /* Under the screen lock the system prompt opens by itself (autoUnlockRef: at every start, every lock and
               every auto-lock), so nothing stands under it; once it ended without opening the wallet, Unlock asks again. */
            <>
              {unlockError ? (
                <Text style={styles.errorText}>{unlockError}</Text>
              ) : null}

              {unlockPrompting ? null : (
                <TouchableOpacity
                  style={styles.button}
                  onPress={handleBiometricUnlock}
                  disabled={loading}
                  testID="unlock-button"
                >
                  <Text style={styles.buttonText}>
                    {loading ? t('unlocking') : t('unlock_wallet')}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <>
              <TextInput
                style={styles.input}
                placeholder={t('enter_password')}
                placeholderTextColor="#888"
                {...PASSWORD_INPUT_PROPS}
                value={typedPassword}
                onChangeText={setPassword}
                onSubmitEditing={unlockWallet}
                returnKeyType="done"
              />

              {unlockError ? (
                <Text style={styles.errorText}>{unlockError}</Text>
              ) : null}

              <TouchableOpacity
                style={styles.button}
                onPress={unlockWallet}
                disabled={loading}
                testID="unlock-button"
              >
                <Text style={styles.buttonText}>
                  {loading ? t('unlocking') : t('unlock_wallet')}
                </Text>
              </TouchableOpacity>

              {biometricEnabled && (
                <TouchableOpacity
                  style={[styles.button, styles.secondaryButton]}
                  onPress={handleBiometricUnlock}
                >
                  <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('biometric_unlock')}</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
        {/* A forgotten unlock: the wallet is erased here (typed ERASE, and under the screen lock a fresh device check) and
            restored from its recovery phrase. Out of the way, and never while the system prompt is up. */}
        {deviceAuth && unlockPrompting ? null : (
          <TouchableOpacity
            style={styles.lockForgot}
            onPress={() => { setEraseText(''); setShowEraseConfirm(true); }}
            accessibilityRole="button"
            testID="unlock-forgot"
          >
            <Text style={styles.lockForgotText} numberOfLines={2}>{t('unlock_forgot_reset')}</Text>
          </TouchableOpacity>
        )}
        {renderEraseConfirm()}
        {renderCustomAlert()}
      </SafeAreaView>
    );
  }

  const renderTabContent = () => {
    switch(activeTab) {
      case 'assets':
        // The Solana Send screen (./SolanaSend): SOL or a Solana token the Assets list shows, from the Solana address.
        if (showSendScreen && sendingToken && sendingToken.network === 'solana') {
          return (
            <SolanaSendForm
              t={t}
              rtl={rtl}
              owner={wallet.solanaAddress || wallet.address}
              symbol={sendingToken.symbol}
              onSymbol={switchSolanaToken}
              address={sendAddress}
              onAddress={setSendAddress}
              amount={sendAmount}
              onAmount={setSendAmount}
              request={solanaRequest}
              balances={{ SOL: fmtAmount(balance, 9), '1DEV': fmtAmount(tokenBalances['1dev'], 6) }}
              mask={maskAmt}
              backArrow={backArrow}
              onBack={closeSendScreen}
              onScan={() => setShowScan(true)}
              known={[...new Set(solanaSends.sends.map((e) => e.to))]}
              reviewSend={reviewSend}
              confirmFresh={confirmFresh}
              sign={(message) => walletManager.signSolanaMessage(message, password)}
              onResult={setTxResult}
              onSent={onSolanaSent}
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

          // The tokens the form switches between (QNC and the QNet tokens on Assets); with a choice the switch names the
          // token, so the title says only "Send" and a long token symbol never crowds Back.
          const sendChoices = qnetSendChoices();

          // Send Form Screen
          return (
            <TabBox key="assets-send" deps={[showSendScreen, sendingToken, sendAddress, sendAmount, sendingTransaction, sendChecking, balancesHidden, language, qrcTokens, hiddenTokens, shownTokens, customTokens, tokenBalances]} render={() => (
            <KeyboardAvoidingView style={styles.keyboardAvoid} behavior="padding">
            <ScrollView
              style={[styles.content, styles.subScreen]}
              contentContainerStyle={[styles.scrollContentContainer, styles.sendScreenContainer]}
              keyboardShouldPersistTaps="handled"
            >
              {/* One compact row: Back, the title centred, and a spacer as wide as Back. */}
              <View style={styles.sendScreenHeader}>
                <TouchableOpacity onPress={closeSendScreen} style={styles.backButton} accessibilityRole="button">
                  <Text style={styles.backButtonText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{`${backArrow} ${t('common_back')}`}</Text>
                </TouchableOpacity>
                <Text style={styles.sendScreenTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                  {sendChoices.length > 1 ? t('assets_send') : t('send_title', { symbol: sendingToken.symbol })}
                </Text>
                <View style={styles.headerSpacer} />
              </View>
              
              {/* The token sent: QNC or a QNet token the Assets list shows, side by side and scrolled sideways when they are
                  many, as the Solana form switches SOL and 1DEV. */}
              {(() => {
                const choices = sendChoices;
                if (choices.length < 2) return null;
                const active = sendingToken.contract || 'QNC';
                return (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sendTokenScroll}
                    contentContainerStyle={styles.sendTokenRow} accessibilityRole="tablist" keyboardShouldPersistTaps="handled">
                    {choices.map((c) => (
                      <TouchableOpacity
                        key={c.key}
                        style={[styles.historyChip, c.key === active && styles.historyChipActive]}
                        onPress={() => switchQnetToken(c)}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: c.key === active }}
                        testID={'qnet-token-' + (c.contract ? c.contract.slice(0, 12) : 'QNC')}
                      >
                        <Text style={[styles.historyChipText, c.key === active && styles.historyChipTextActive]} numberOfLines={1}>
                          {c.reserved ? '⚠ ' + c.symbol : c.symbol}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                );
              })()}

              {/* Balance Info; a token names its contract (and one named after QNet is marked as not QNC), as on Assets. */}
              <View style={styles.sendBalanceInfo}>
                <Text style={styles.sendBalanceLabel}>{t('send_available')}</Text>
                <Text style={styles.sendBalanceAmount}>{maskAmt(fmtAmount(sendingToken.balance, 5))} {sendingToken.symbol}</Text>
                {sendingToken.contract ? (
                  <Text style={styles.tokenPrice}>{t('tok_contract_id', { id: contractShortId(sendingToken.contract) })}</Text>
                ) : null}
                {sendingToken.contract && (sendingToken.reserved || usesReservedName(sendingToken.symbol, '')) ? (
                  <Text style={[styles.tokenPrice, { color: '#ff5555' }]}>{t('tok_reserved_warning')}</Text>
                ) : null}
              </View>
              
              {/* Recipient Address; on QNet a scan icon at the field's end reads a QNet address from a QR code. */}
              <View style={styles.formGroup}>
                <Text style={styles.label}>{t('send_to_address')}</Text>
                <View style={styles.recipientField}>
                  <TextInput
                    style={[styles.input, styles.recipientInput, sendingToken.network === 'qnet' && styles.recipientInputScan]}
                    placeholder={t(sendingToken.network === 'qnet' ? 'send_placeholder_eon' : 'send_placeholder_address')}
                    placeholderTextColor="#888"
                    value={sendAddress}
                    onChangeText={setSendAddress}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {sendingToken.network === 'qnet' ? (
                    <TouchableOpacity
                      style={styles.scanButton}
                      onPress={() => { Keyboard.dismiss(); setShowScan(true); }}
                      accessibilityRole="button"
                      accessibilityLabel={t('scan_title')}
                      // Only outwards, past the field's edge: inwards the text ends where the icon's target starts.
                      hitSlop={{ top: 8, bottom: 8, [rtl ? 'left' : 'right']: 8 }}
                      testID="send-scan"
                    >
                      <ScanIcon color="#00d4ff" />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
              
              {/* Amount Input */}
              <View style={styles.formGroup}>
                <Text style={styles.label}>{t('send_amount')}</Text>
                <TextInput
                  style={styles.input}
                  placeholder="0.00"
                  placeholderTextColor="#888"
                  keyboardType="decimal-pad"
                  value={sendAmount}
                  onChangeText={validateAmountInput}
                  maxLength={20}
                />
                {/* A token takes no more decimals than its own (L-9): said under the field, before Send refuses it. */}
                {sendingToken.contract && (String(sendAmount || '').split('.')[1] || '').length > (Number(sendingToken.decimals) || 0) ? (
                  <Text style={[styles.tokenPrice, { color: '#ff5555' }]} testID="send-amount-decimals">
                    {t('err_AMOUNT_DECIMALS', { decimals: Number(sendingToken.decimals) || 0 })}
                  </Text>
                ) : null}

                {/* Percentage Buttons */}
                <View style={styles.percentageButtons}>
                  <TouchableOpacity 
                    style={styles.percentButton}
                    onPress={() => setAmountPercentage(25)}
                  >
                    <Text style={styles.percentButtonText}>25%</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.percentButton}
                    onPress={() => setAmountPercentage(50)}
                  >
                    <Text style={styles.percentButtonText}>50%</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.percentButton}
                    onPress={() => setAmountPercentage(75)}
                  >
                    <Text style={styles.percentButtonText}>75%</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.percentButton}
                    onPress={() => setAmountPercentage(100)}
                  >
                    <Text style={styles.percentButtonText}>{t('send_max')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
              
              {/* Network Fee */}
              <View style={styles.sendFeeContainer}>
                <Text style={styles.sendFeeLabel}>{t('send_network_fee')}</Text>
                <Text style={styles.sendFeeValue}>
                  {feePreviewNano == null ? '—' : `${fmtAmount(feePreviewNano / 1e9, 6)} QNC`}
                </Text>
              </View>
              
              {/* Total Cost: the sum the balance check charges (amount + fee for QNC; a QRC-20 send pays its fee in QNC). */}
              {sendAmount && parseFloat(sendAmount) > 0 && (
                <View style={styles.sendTotalContainer}>
                  <Text style={styles.sendTotalLabel}>{t('send_total')}</Text>
                  <Text style={styles.sendTotalValue}>
                    {sendingToken.contract
                      ? `${sendAmount} ${sendingToken.symbol} + ${feePreviewNano == null ? '—' : fmtAmount(feePreviewNano / 1e9, 6)} QNC`
                      : `${((Math.round(parseFloat(sendAmount) * 1e9) + TRANSFER_FEE_NANO) / 1e9).toFixed(6)} ${sendingToken.symbol}`}
                  </Text>
                </View>
              )}
              
              {/* Send Button: busy, with a spinner, from the tap until the send is over (pressSend). */}
              <TouchableOpacity
                style={[styles.button, (!sendAddress || !sendAmount || sendingTransaction || sendChecking) && styles.buttonDisabled]}
                onPress={pressSend}
                disabled={!sendAddress || !sendAmount || sendingTransaction || sendChecking}
                accessibilityRole="button"
                accessibilityState={{ busy: sendChecking || sendingTransaction }}
                testID="send-button"
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                  {(sendChecking || sendingTransaction) && (
                    <ActivityIndicator size="small" color="#1a1a2e" style={{ marginEnd: 8 }} testID="send-busy" />
                  )}
                  <Text style={styles.buttonText}>
                    {sendingTransaction ? t('sending') : t('send_button')}
                  </Text>
                </View>
              </TouchableOpacity>
            </ScrollView>
            </KeyboardAvoidingView>
            )} />
          );
        }

        // Normal Assets View
        return (
          <TabBox key="assets-normal" deps={[refreshing, wallet, selectedNetwork, tokenBalances, balance, balanceVerified, balanceStatus, copiedAddress, qrcTokens, hiddenTokens, shownTokens, customTokens, balancesHidden, keptTxs, language]} render={() => (
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
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true);
                  try {
                    await loadBalance(wallet.publicKey);
                  } catch (error) {
                    // console.error('Error refreshing:', error);
                  } finally {
                    setRefreshing(false);
                  }
                }}
                colors={['#00d4ff']}
                tintColor="#00d4ff"
                titleColor="#00d4ff"
                title={t('pull_to_refresh')}
              />
            }
          >
            {/* Network Selector */}
            <View style={styles.networkSelector}>
              <TouchableOpacity 
                style={[styles.networkTab, selectedNetwork === 'qnet' && styles.networkTabActive]}
                onPress={() => {
                  setSelectedNetwork('qnet');
                  // Refresh balance for QNet network
                  if (wallet && wallet.publicKey) {
                    loadBalance(wallet.publicKey);
                  }
                }}
              >
                <Text style={[styles.networkTabText, selectedNetwork === 'qnet' && styles.networkTabTextActive]}>QNet</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.networkTab, selectedNetwork === 'solana' && styles.networkTabActive]}
                onPress={() => {
                  setSelectedNetwork('solana');
                  // Refresh balance for Solana network
                  if (wallet && wallet.publicKey) {
                    loadBalance(wallet.publicKey);
                  }
                }}
              >
                <Text style={[styles.networkTabText, selectedNetwork === 'solana' && styles.networkTabTextActive]}>Solana</Text>
              </TouchableOpacity>
            </View>

            {/* The address in full on one line, fitted to the card (the font shrinks before anything wraps or is cut; a
                larger system text size counts up to 1.2 times, so the smallest fit holds it on a 320 dp screen); the
                address itself copies it. */}
            {(() => {
              const cardAddress = selectedNetwork === 'qnet'
                ? (wallet.qnetAddress || wallet.address)
                : (wallet.solanaAddress || wallet.address);
              const cardType = selectedNetwork === 'qnet' ? 'qnet' : 'solana';
              const copied = copiedAddress === cardType;
              return (
                <TouchableOpacity
                  style={styles.addressContainer}
                  onPress={() => copyToClipboard(cardAddress, cardType)}
                  accessibilityRole="button"
                  accessibilityLabel={cardAddress}
                  accessibilityHint={t('common_tap_to_copy')}
                  testID="address-card"
                >
                  <View style={styles.addressRow}>
                    <Text
                      style={[styles.addressText, copied && styles.addressTextCopied]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.5}
                      maxFontSizeMultiplier={1.2}
                    >
                      {cardAddress}
                    </Text>
                  </View>
                  <Text style={[styles.copyHint, copied && { color: '#00ff00' }]}>
                    {copied ? `✓ ${t('copied_check')}` : t('common_tap_to_copy')}
                  </Text>
                </TouchableOpacity>
              );
            })()}

            {/* Send and Receive live here (the bottom bar has no tab for them). Send opens QNC on QNet and SOL on Solana,
                whose Send screen switches to the other Solana token. */}
            <View style={styles.assetActions}>
              <TouchableOpacity
                style={styles.assetAction}
                onPress={() => (selectedNetwork === 'qnet'
                  ? openSendModal('QNC', tokenBalances.qnc, 'qnet') : openSendModal('SOL', balance, 'solana'))}
                accessibilityRole="button"
                testID="assets-send"
              >
                <Text style={styles.assetActionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{t('assets_send')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.assetAction} onPress={() => setActiveTab('receive')} accessibilityRole="button">
                <Text style={styles.assetActionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{t('assets_receive')}</Text>
              </TouchableOpacity>
            </View>

            {/* One quiet line only when this session's first read found nothing; while a read runs the last figures
                stay without a word. */}
            {(() => {
              const line = balanceLine();
              return line ? <Text style={styles.balanceStatusLine} numberOfLines={2} testID="balance-status">{line}</Text> : null;
            })()}

            {/* This wallet's signed transactions that have not settled (MOBNET-R3-01): listed until they do, with
                whether the wallet still sends each by itself, and "Stop sending" where no node holds it. */}
            {selectedNetwork === 'qnet' && keptTxs.length > 0 && (
              <View style={styles.tokenList}>
                <Text style={styles.tokenName}>{t('kept_title', { count: keptTxs.length })}</Text>
                {keptTxs.map((p) => (
                  <View key={`kept-${p.nonce}`} style={styles.tokenItem}>
                    <View style={styles.tokenDetails}>
                      <Text style={styles.tokenPrice}>{pendingLine(p)}</Text>
                      <Text style={styles.tokenPrice}>{keptStatus(p)}</Text>
                    </View>
                    {p.canStop && (
                      <TouchableOpacity onPress={() => { stopKept(p); }} accessibilityRole="button">
                        <Text style={[styles.tokenPrice, { color: '#ff5555' }]}>{t('kept_stop')}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </View>
            )}

            {/* Token List based on selected network */}
            {selectedNetwork === 'qnet' ? (
              <View style={styles.tokenList}>
                {/* QNC Token - Clickable to open Send screen. Hidden if toggled off in the token manager. */}
                {!hiddenTokens.has('native:qnc') && (
                <TouchableOpacity
                  style={styles.tokenItemClickable}
                  onPress={() => openSendModal('QNC', tokenBalances.qnc, 'qnet')}
                  activeOpacity={0.6}
                >
                  <View style={styles.tokenInfo}>
                    <View style={styles.tokenIcon}>
                        <Image
                        source={require('../../assets/qnet_logo.png')}
                          style={styles.tokenIconImage}
                          resizeMode="contain"
                        />
                    </View>
                    <View style={styles.tokenDetails}>
                      <Text style={styles.tokenName}>QNC</Text>
                    </View>
                  </View>
                  <View style={styles.tokenBalance}>
                    <Text style={styles.tokenAmount}>{figure('qnc', fmtAmount(tokenBalances.qnc, 5))}</Text>
                  </View>
                </TouchableOpacity>
                )}

                {/* QRC-20 holdings + custom tokens (deduped, hidden filtered via ⋮ manager); tap=Send, long-press=hide. */}
                {qrcTokens.filter((tk) => isTokenShown(tk.contract)).map((tk) => {
                  const reserved = usesReservedName(tk.symbol, tk.name);
                  return (
                  <TouchableOpacity
                    key={tk.contract}
                    style={styles.tokenItemClickable}
                    onPress={() => openSendModal(
                      tokenTitle(tk),
                      parseFloat(tk.balance) || 0,
                      'qnet',
                      { contract: tk.contract, decimals: tk.decimals, balanceText: tk.balance, reserved }
                    )}
                    onLongPress={() => {
                      const label = tokenTitle(tk);
                      Alert.alert(t('tok_hide_title'), label, [
                        { text: t('cancel'), style: 'cancel' },
                        { text: t('tok_hide'), style: 'destructive', onPress: () => hideToken(tk.contract) },
                      ]);
                    }}
                    activeOpacity={0.6}
                  >
                    <View style={styles.tokenInfo}>
                      {(() => {
                        // Token icon: an inert emoji logo, else a deterministic coloured-circle letter
                        // avatar (colour from the contract address). Privacy: a node-supplied https logo
                        // is never loaded as <Image> here — it would leak the device IP/timing to an
                        // attacker-controlled host — so a URL logo falls through to the letter avatar.
                        const logo = typeof tk.logo === 'string' ? tk.logo.trim() : '';
                        const isEmoji = isGlyphLogo(logo);
                        let h = 0;
                        const seed = String(tk.contract || tk.symbol || '?');
                        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
                        const bg = isEmoji ? '#0b1a22' : `hsl(${h % 360}, 60%, 42%)`;
                        return (
                          <View style={[styles.tokenIcon, { backgroundColor: bg, borderRadius: 20 }]}>
                            <Text style={[styles.tokenIconText, { color: '#ffffff' }]}>
                              {isEmoji ? logo : tokenInitial(tk)}
                            </Text>
                          </View>
                        );
                      })()}
                      <View style={styles.tokenDetails}>
                        <Text style={styles.tokenName}>{tokenTitle(tk)}</Text>
                        {!!tk.name && tk.name !== tk.symbol && (
                          <Text style={styles.tokenPrice}>{tokenLabel(tk.name)}</Text>
                        )}
                        {/* Every token row names its contract; one named after QNet is marked as not QNC. */}
                        <Text style={styles.tokenPrice}>{t('tok_contract_id', { id: contractShortId(tk.contract) })}</Text>
                        {reserved && <Text style={[styles.tokenPrice, { color: '#ff5555' }]}>{t('tok_reserved_warning')}</Text>}
                      </View>
                    </View>
                    <View style={styles.tokenBalance}>
                      <Text style={styles.tokenAmount}>
                        {maskAmt(`${tk.balance}`)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  );
                })}
                {(() => {
                  // Tokens sent to this wallet unasked: off the list until the user shows them (MOBNET-R2-08).
                  const unasked = qrcTokens.filter((tk) => tk.contract && !hiddenTokens.has(tk.contract) && !isTokenShown(tk.contract)).length;
                  return unasked > 0 ? (
                    <TouchableOpacity onPress={() => { setTokenMgrQuery(''); setShowTokenManager(true); }} accessibilityRole="button">
                      <Text style={[styles.tokenPrice, { textAlign: 'center', marginTop: 8 }]}>{t('tok_unasked_hidden', { count: unasked })}</Text>
                    </TouchableOpacity>
                  ) : null;
                })()}
              </View>
            ) : (
              <View style={styles.tokenList}>
                {/* SOL Token - opens its Send screen */}
                <TouchableOpacity
                  style={styles.tokenItemClickable}
                  onPress={() => openSendModal('SOL', balance, 'solana')}
                  activeOpacity={0.6}
                  testID="solana-row-SOL"
                >
                  <View style={styles.tokenInfo}>
                    <View style={styles.tokenIcon}>
                      {getTokenIconUrl('SOL') ? (
                        <Image 
                          source={{uri: getTokenIconUrl('SOL')}} 
                          style={styles.tokenIconImage}
                          resizeMode="contain"
                        />
                      ) : (
                      <Text style={styles.tokenIconText}>S</Text>
                      )}
                    </View>
                    <View style={styles.tokenDetails}>
                      <Text style={styles.tokenName}>SOL</Text>
                      <Text style={styles.tokenPrice}>{t('solana_devnet')}</Text>
                    </View>
                  </View>
                  <View style={styles.tokenBalance}>
                    <Text style={styles.tokenAmount}>{figure('sol', fmtAmount(balance, 4))}</Text>
                  </View>
                </TouchableOpacity>
                {/* 1DEV Token - opens its Send screen */}
                <TouchableOpacity
                  style={styles.tokenItemClickable}
                  onPress={() => openSendModal('1DEV', tokenBalances['1dev'], 'solana')}
                  activeOpacity={0.6}
                  testID="solana-row-1DEV"
                >
                  <View style={styles.tokenInfo}>
                    <View style={styles.tokenIcon}>
                      {getTokenIconUrl('1DEV') ? (
                        <Image 
                          source={{uri: getTokenIconUrl('1DEV')}} 
                          style={styles.tokenIconImage}
                          resizeMode="contain"
                        />
                      ) : (
                      <Text style={styles.tokenIconText}>D</Text>
                      )}
                    </View>
                    <View style={styles.tokenDetails}>
                      <Text style={styles.tokenName}>1DEV</Text>
                      <Text style={styles.tokenPrice}>{t('solana_devnet')}</Text>
                    </View>
                  </View>
                  <View style={styles.tokenBalance}>
                    <Text style={styles.tokenAmount}>{figure('oneDev', fmtAmount(tokenBalances['1dev'], 4))}</Text>
                  </View>
                </TouchableOpacity>
              </View>
            )}

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
          <TabBox key="receive" deps={[selectedNetwork, wallet, copiedAddress, language]} render={() => (
          <ScrollView
            style={[styles.content, styles.subScreen]}
            contentContainerStyle={styles.scrollContentContainer}
            onScroll={handleUserActivity} 
            scrollEventThrottle={500}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            {/* Receive opens from Assets (the bottom bar keeps Assets lit); Back returns there. The same compact row as
                Send: Back, the title, a spacer. */}
            <View style={styles.sendScreenHeader}>
              <TouchableOpacity onPress={() => setActiveTab('assets')} style={styles.backButton} accessibilityRole="button">
                <Text style={styles.backButtonText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{`${backArrow} ${t('common_back')}`}</Text>
              </TouchableOpacity>
              <Text style={styles.sendScreenTitle} numberOfLines={1}>{t('receive_title')}</Text>
              <View style={styles.headerSpacer} />
            </View>

            <View style={styles.receiveContent}>
              {/* REAL QR Code */}
              <View style={styles.qrContainer}>
                <View style={styles.qrWrapper}>
                  <QRCode
                    value={currentReceiveAddress || '-'}
                    size={200}
                    color='black'
                    backgroundColor='white'
                  />
                </View>
              </View>

              {/* One line on what the address takes, then the address in full on one line (fitted as on the Assets card);
                  tapping it copies it. */}
              <View style={styles.addressDisplay}>
                <Text style={[styles.label, { textAlign: 'center' }]}>
                  {t(selectedNetwork === 'qnet' ? 'receive_your_qnet' : 'receive_your_solana')}
                </Text>

                <TouchableOpacity
                  onPress={() => {
                    const addressType = selectedNetwork === 'qnet' ? 'qnet-receive' : 'solana-receive';
                    copyToClipboard(currentReceiveAddress, addressType);
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={currentReceiveAddress}
                  accessibilityHint={t('common_tap_to_copy')}
                  testID="receive-address"
                >
                  <Text style={styles.addressText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} maxFontSizeMultiplier={1.2}>
                    {currentReceiveAddress}
                  </Text>
                  <Text style={styles.tapToCopy}>
                    {copiedAddress.includes('receive') ? `✓ ${t('copied_check')}` : t('common_tap_to_copy')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
          )} />
        );

      // The browser is its own pane (renderBrowserPane), kept while other tabs are shown.
      case 'browser':
        return null;

      case 'history': {
        // Split by network exactly as Assets is, with the same selector (owner, 04.10): QNet lists this wallet's QNet
        // transactions of every asset, Solana the sends this device made. No filter chips. Rows of a token sent to this
        // wallet unasked stay off, as on the Assets list, until the user shows or adds it (MOBNET-R3-08). One row per
        // transaction, under a header for its day (06.10: utils/txHistory historyEntries, historySections).
        const addedTokens = new Set((customTokens || []).map((c) => c.contract_address || c.contract).filter(Boolean));
        const rowVisible = (row) => !row.tokenContract || (row.status === 'pending' && row.tokenMetaTrusted)
          || tokenVisible(row.tokenContract, { hidden: hiddenTokens, added: addedTokens, shown: shownTokens });
        const onQnet = selectedNetwork === 'qnet';
        const unaskedRows = onQnet ? txHistory.filter((row) => !rowVisible(row)).length : 0;
        const solanaOwner = wallet ? (wallet.solanaAddress || wallet.address) : null;
        const listed = historySections(historyEntries(onQnet
          ? txHistory.filter(rowVisible)
          : solanaSends.sends.map((e) => solanaHistoryRow(e, solanaOwner))));
        return (
          <TabBox key="history" deps={[txHistory, solanaSends.sends, selectedNetwork, refreshing, balancesHidden, historyLoadingOlder, hiddenTokens, shownTokens, customTokens, language]} render={() => (
          <FlatList
            key="history-tab"
            style={styles.content}
            contentContainerStyle={styles.scrollContentContainer}
            data={listed}
            extraData={`${balancesHidden}:${language}:${selectedNetwork}`}
            keyExtractor={(item, index) => (item.dayHeader ? item.key : (item.hash ? historyRowKey(item) : String(index)))}
            renderItem={({ item }) => (item.dayHeader ? <DayHeader item={item} t={t} />
              : <HistoryRow tx={item} onOpen={openTxDetail} hideAmounts={balancesHidden} t={t} />)}
            ListHeaderComponent={
              <>
                <Text style={[styles.sectionTitle, { marginBottom: 16 }]}>{t('hist_title')}</Text>
                {/* The same network selector as Assets, sharing its choice. */}
                <View style={styles.networkSelector}>
                  {[['qnet', 'QNet'], ['solana', 'Solana']].map(([key, name]) => (
                    <TouchableOpacity
                      key={key}
                      style={[styles.networkTab, selectedNetwork === key && styles.networkTabActive]}
                      onPress={() => setSelectedNetwork(key)}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: selectedNetwork === key }}
                      testID={`history-network-${key}`}
                    >
                      <Text style={[styles.networkTabText, selectedNetwork === key && styles.networkTabTextActive]}>{name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {unaskedRows > 0 ? (
                  <TouchableOpacity onPress={() => { setTokenMgrQuery(''); setShowTokenManager(true); }} accessibilityRole="button">
                    <Text style={[styles.tokenPrice, { textAlign: 'center', marginBottom: 12 }]}>{t('hist_unasked_hidden', { count: unaskedRows })}</Text>
                  </TouchableOpacity>
                ) : null}
                {/* Only this device's Solana sends are listed: said once, above the Solana list. */}
                {onQnet ? null : (
                  <Text style={[styles.tokenPrice, { textAlign: 'center', marginBottom: 12 }]} testID="history-solana-scope">{t('hist_solana_scope')}</Text>
                )}
              </>
            }
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Text style={{ color: '#666', fontSize: 16, textAlign: 'center' }}>{t('hist_empty')}</Text>
              </View>
            }
            onEndReached={onQnet ? loadOlderHistory : undefined}
            onEndReachedThreshold={0.5}
            ListFooterComponent={onQnet && historyLoadingOlder
              ? <Text style={{ color: '#666', fontSize: 12, textAlign: 'center', paddingVertical: 16 }}>{t('hist_loading_older')}</Text>
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
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true);
                  await loadTxHistory(true);
                  setRefreshing(false);
                }}
                colors={['#00d4ff']}
                tintColor="#00d4ff"
              />
            }
          />
          )} />
        );
      }

      case 'node': {
        // A super or genesis node of this wallet comes first, with this wallet's own light node under it when the chain
        // lists both; otherwise the light node alone, as the network records it; and a node aiqnet.io recorded for the
        // wallet that the network does not list yet (components in NodeTab).
        const server = serverNodeTypeOf(activatedNodeType) ? {
          nodeType: activatedNodeType, nodeId: nodePseudonym, status: serverNodeStatus,
          epochs: serverEpochs && serverEpochs.owner === wallet?.qnetAddress && serverEpochs.nodeId === (nodePseudonym || serverNodeStatus?.nodeId)
            ? serverEpochs : null,
        } : null;
        const light = lightNodeStatus
          ? { ...lightNodeStatus, background: bgState, balanceNano: lightBalance, device: deviceCheck } : null;
        const recorded = siteRecord && siteRecord.owner === wallet?.qnetAddress ? pendingNodeType(siteRecord, [
          ...(server && serverNodeStatus && serverNodeStatus.success && serverNodeStatus.registered !== false ? ['super'] : []),
          ...(lightNodeStatus && lightNodeStatus.status && lightNodeStatus.status.onChain === true ? ['light'] : []),
        ]) : null;
        return (
          <TabBox key="node" deps={[refreshing, activatedNodeType, nodePseudonym, lightNodeStatus, lightBalance, serverNodeStatus, serverEpochs, siteRecord, currentBlockHeight, processingValidation, nodeUseBusy, useRefusal, balancesHidden, bgState, deviceCheck, copiedAddress, language]} render={() => (
          <ScrollView
            key="node-tab"
            style={styles.content}
            contentContainerStyle={styles.scrollContentContainer}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
            onScroll={handleUserActivity}
            scrollEventThrottle={500}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true);
                  try {
                    await loadAllUserNodes();
                    await Promise.all([
                      refreshHeight(),
                      serverNodeTypeOf(activatedNodeType) ? loadServerNodeStatus({ rewards: true }) : null,
                      loadLightNodeStatus({ rewards: true }), loadSiteRecord({ force: true }),
                    ]);
                  } catch (error) {
                    logger.error('Error refreshing node data:', error);
                  } finally {
                    setRefreshing(false);
                  }
                }}
                colors={['#00d4ff']}
                tintColor="#00d4ff"
                titleColor="#00d4ff"
                title={t('pull_to_refresh')}
              />
            }
          >
            {LEGACY_MOVE ? (
              <View>
                <Text style={styles.tabTitle}>{t('node_title')}</Text>
                <Text style={styles.nodeExplainer}>{t('legacy_move_node')}</Text>
              </View>
            ) : (
            <NodeTab
              t={t}
              server={server}
              light={light}
              recorded={recorded}
              height={currentBlockHeight}
              balancesHidden={balancesHidden}
              busy={{ move: processingValidation, use: nodeUseBusy }}
              refusal={useRefusal}
              copied={copiedAddress}
              onMove={handleMoveLightBalance}
              onMoveServer={handleClaimServerNodeRewards}
              onUse={handleUseDevice}
              onPlayDialog={(kind) => { showPlayDialog(kind).catch(() => {}); }}
              onOpenBackground={() => { openBackgroundSettings().catch(() => {}); }}
              onCopy={(id) => copyToClipboard(id)}
              nodeTitle={(type) => nodeTitle(t, type)}
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
            <Text style={styles.tabTitle}>{t('settings')}</Text>
            
            {/* General Settings */}
            <View style={styles.settingGroup}>
              <Text style={styles.settingGroupTitle}>{t('general')}</Text>
              
              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingTitle}>{t('auto_lock_timer')}</Text>
                  <Text style={styles.settingSubtitle}>{t('auto_lock_subtitle')}</Text>
                </View>
                <TouchableOpacity 
                  style={styles.settingDropdown}
                  onPress={() => setShowAutoLockPicker(true)}
                >
                  <Text style={styles.settingValue}>
                    {t(`autolock_${autoLockTime}`)}
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingTitle}>{t('language')}</Text>
                  <Text style={styles.settingSubtitle}>{t('language_subtitle')}</Text>
                </View>
                <TouchableOpacity 
                  style={styles.settingDropdown}
                  onPress={() => setShowLanguagePicker(true)}
                >
                  <Text style={styles.settingValue}>
                    {languageName(language)}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Security Settings - Lazy loaded */}
            {activeTab === 'settings' && (
              <View style={styles.settingGroup}>
                <Text style={styles.settingGroupTitle}>{t('security_options')}</Text>

                {deviceCompromised && (
                  <Text style={[styles.settingSubtitle, { color: '#ff9800', marginBottom: 10 }]}>
                    {t('set_rooted_warning')}
                  </Text>
                )}

                {/* Android, when the Keystore could not seal the vault: a copy of the app's data is protected by
                    the password alone (MVA-R2-04). Every unlock tries the seal again. */}
                {!deviceAuth && hwSeal === 'unsealed' && (
                  <Text style={[styles.settingSubtitle, { color: '#ffb74d', marginBottom: 8 }]}>
                    {t('hw_seal_missing')}
                  </Text>
                )}

                {/* A wallet under the screen lock has no password to change. */}
                {!deviceAuth && (
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => setShowChangePassword(true)}
                >
                  <Text style={styles.actionButtonText}>{t('change_password')}</Text>
                </TouchableOpacity>
                )}

                {/* A password wallet on a device with a screen lock that can hold its secret may move there. */}
                {!deviceAuth && deviceAuthAvail && (
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => { setBiometricPassword(''); setShowBiometricPasswordPrompt('device'); }}
                  >
                    <Text style={styles.actionButtonText}>{t('set_device_unlock')}</Text>
                  </TouchableOpacity>
                )}

                {biometricSupported && !deviceAuth && (
                  <TouchableOpacity
                    style={[styles.actionButton, biometricEnabled && { borderColor: '#4caf50', borderWidth: 1 }]}
                    onPress={handleToggleBiometric}
                  >
                    <Text style={styles.actionButtonText}>
                      {biometricEnabled ? '✓ ' : ''}{t('enable_biometric')}
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => { setExportWhat('phrase'); setShowExportSeed(true); }}
                >
                  <Text style={styles.actionButtonText}>{t('export_recovery_phrase')}</Text>
                </TouchableOpacity>

                {/* The private keys behind the same check as the phrase (WalletManager.revealPrivateKeys). */}
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => { setExportWhat('key'); setExportAccount('qnet'); setShowExportSeed(true); }}
                  testID="settings-export-key"
                >
                  <Text style={styles.actionButtonText}>{t('export_private_key')}</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Websites this wallet is connected to in the in-app browser; each can be disconnected here. */}
            <View style={styles.settingGroup}>
              <Text style={styles.settingGroupTitle}>{t('sites_title')}</Text>
              {connectedSites === null ? (
                <Text style={styles.settingSubtitle}>{t('sites_loading')}</Text>
              ) : connectedSites.length === 0 ? (
                <Text style={styles.settingSubtitle}>{t('sites_none')}</Text>
              ) : connectedSites.map((site) => {
                const d = describeOrigin(site.origin);
                const name = d ? `${d.host}${d.port ? `:${d.port}` : ''}` : site.origin;
                return (
                  <View key={site.origin} style={styles.settingItem}>
                    <View style={styles.settingInfo}>
                      <Text style={styles.settingTitle} numberOfLines={1}>{name}</Text>
                      <Text style={[styles.settingSubtitle, { writingDirection: 'ltr' }]} numberOfLines={2}>
                        {d && d.idn ? `${site.origin} · ${t('sites_idn')}` : site.origin}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.settingDropdown}
                      onPress={() => revokeSite(site.origin)}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('sites_revoke')} ${name}`}
                    >
                      <Text style={styles.settingValue}>{t('sites_revoke')}</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>


            {/* The networks this build uses: fixed, never a setting (config/nodes SOLANA_CLUSTER). */}
            <View style={styles.settingGroup}>
              <Text style={styles.settingGroupTitle}>{t('network')}</Text>

              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingTitle}>{t('current_network')}</Text>
                  <Text style={styles.settingSubtitle}>QNet Testnet · {t('solana_devnet')}</Text>
                </View>
              </View>
            </View>

            {/* The published texts, one tap from the app (the stores require the privacy policy in-app too). */}
            <View style={styles.settingGroup}>
              <Text style={styles.settingGroupTitle}>{t('set_legal')}</Text>
              {LEGAL_LINKS.map(([labelKey, url]) => (
                <TouchableOpacity key={url} style={styles.actionButton} onPress={() => Linking.openURL(url).catch(() => {})}>
                  <Text style={styles.actionButtonText}>{t(labelKey)}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Danger Zone */}
            <View style={styles.settingGroup}>
              <Text style={[styles.settingGroupTitle, {color: '#ff4444'}]}>{t('danger_zone')}</Text>
              
              {/* Locks at once, the same lock as auto-lock: the wallet stays on the device and its node keeps running. */}
              <TouchableOpacity
                style={[styles.actionButton, {backgroundColor: '#16213e', borderColor: '#ff4444'}]}
                onPress={() => lockSession()}
              >
                <Text style={[styles.actionButtonText, {color: '#ff4444'}]}>{t('lock_wallet')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.actionButton, {backgroundColor: '#16213e', borderColor: '#ff4444'}]}
                onPress={deleteWallet}
              >
                <Text style={[styles.actionButtonText, {color: '#ff4444'}]}>{t('delete_wallet')}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
          )} />
        );

      default:
        return null;
    }
  };

  return (
    <SafeAreaView
      style={[styles.container, dirStyle]}
      edges={SCREEN_EDGES}
      onTouchStart={handleUserActivity}
    >
      {renderBrowserPane('main')}
      <View style={styles.header} onLayout={(e) => setHeaderBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
        <Text style={styles.title}>{t('qnet_wallet')}</Text>
        {/* Overflow menu: token manager / hide balances (Settings is a tab of the bottom bar) */}
        <TouchableOpacity
          style={styles.headerMenuBtn}
          accessibilityRole="button"
          accessibilityLabel={t('menu_open')}
          onPress={() => setShowHeaderMenu((v) => !v)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.6}
        >
          <Text style={styles.headerMenuIcon}>⋮</Text>
        </TouchableOpacity>
      </View>

      {/* Tab Content (on the Browser tab the browser pane below it shows through, and gets the touches) */}
      <View
        style={styles.tabContentContainer}
        onLayout={(e) => setContentFrame(e.nativeEvent.layout)}
        pointerEvents={activeTab === 'browser' ? 'none' : 'auto'}
      >
        {renderTabContent()}
        {/* A History row's detail screen, over the History tab, with Back (screens/HistoryTab). */}
        {txDetail && activeTab === 'history' && !txResult ? (
          <View style={styles.txResultOverlay}>
            <ScrollView style={styles.content} contentContainerStyle={styles.scrollContentContainer} onScroll={handleUserActivity} scrollEventThrottle={500}>
              <TxDetail
                tx={txDetail.nodeType ? { ...txDetail, nodeTypeTitle: nodeTitle(t, txDetail.nodeType) } : txDetail}
                t={t}
                hideAmounts={balancesHidden}
                copied={copiedAddress}
                backArrow={backArrow}
                onBack={() => setTxDetail(null)}
                onCopy={(text, key) => copyToClipboard(text, key)}
                onExplorer={handleOpenTx}
              />
            </ScrollView>
          </View>
        ) : null}
        {/* One result surface for every transaction — send, token transfer, claim, activation — so an
            outcome always arrives the same way, over whichever tab started it. */}
        {txResult && activeTab !== 'browser' ? (
          <View style={styles.txResultOverlay}>
            <ScrollView
              style={styles.content}
              contentContainerStyle={[styles.scrollContentContainer, styles.sendScreenContainer]}
            >
              <TxResultCard
                state={txResultState(txResult)}
                title={txResult.title}
                amount={txResult.amount}
                symbol={txResult.symbol}
                counterparty={txResult.to}
                counterpartyLabel={txResult.counterpartyLabel}
                note={txResultNote(txResult)}
                hash={txResult.txHash}
                explorer={txResult.chain !== 'solana'}
                error={txResult.error}
                onAction={dismissTxResult}
                onCopied={() => showAlert(t('common_copied'), t('tx_hash_copied'))}
                t={t}
              />
            </ScrollView>
          </View>
        ) : null}
      </View>

      <BottomBar active={activeTab} onSelect={selectTab} t={t} hidden={keyboardUp} />

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
        <KeyboardAvoidingView style={[styles.modalOverlay, styles.modalOverlayKeyboard]} behavior="padding">
          <View style={styles.modalBox}>
            <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>{t(showChangePassword === 'reprotect' ? 'reprotect_password' : 'change_password')}</Text>

              {/* A wallet whose screen-lock secret is gone has no current password: the open session is the proof. */}
              {showChangePassword === 'reprotect' ? (
                <Text style={styles.modalContent}>{t('reprotect_password_body')}</Text>
              ) : (
                <>
                  <Text style={styles.modalLabel}>{t('enter_current_password')}</Text>
                  <TextInput
                    style={styles.input}
                    placeholder={t('password')}
                    accessibilityLabel={t('enter_current_password')}
                    placeholderTextColor="#888"
                    {...PASSWORD_INPUT_PROPS}
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                  />
                </>
              )}

              <Text style={styles.modalLabel}>{t('enter_new_password', { min: MIN_PASSWORD })}</Text>
              <TextInput
                style={styles.input}
                placeholder={t('password')}
                accessibilityLabel={t('enter_new_password', { min: MIN_PASSWORD })}
                placeholderTextColor="#888"
                {...PASSWORD_INPUT_PROPS}
                value={newPassword}
                onChangeText={setNewPassword}
              />
              {renderPasswordLength(newPassword)}

              <Text style={styles.modalLabel}>{t('confirm_new_password')}</Text>
              <TextInput
                style={styles.input}
                placeholder={t('password')}
                accessibilityLabel={t('confirm_new_password')}
                placeholderTextColor="#888"
                {...PASSWORD_INPUT_PROPS}
                value={confirmNewPassword}
                onChangeText={setConfirmNewPassword}
              />
              {renderPasswordMatch(newPassword, confirmNewPassword)}
            </ScrollView>

            <View style={styles.modalActions}>
              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonSecondary]}
                onPress={() => {
                  setShowChangePassword(false);
                  setCurrentPassword('');
                  setNewPassword('');
                  setConfirmNewPassword('');
                }}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonPrimary]}
                onPress={showChangePassword === 'reprotect' ? handleReprotectPassword : handleChangePassword}
                disabled={loading}
              >
                <Text style={styles.modalButtonText}>{loading ? t('changing') : t(showChangePassword === 'reprotect' ? 'reprotect_save' : 'change')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Header ⋮ overflow menu */}
      {showHeaderMenu && (
        <>
          <TouchableOpacity style={styles.menuBackdrop} activeOpacity={1} onPress={() => setShowHeaderMenu(false)} />
          <View style={[styles.menuCard, { top: headerBottom - 12 }]}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => { setShowHeaderMenu(false); setTokenMgrQuery(''); setShowTokenManager(true); }}
              activeOpacity={0.6}
            >
              <Text style={styles.menuItemText}>{t('tok_manage')}</Text>
              <Text style={styles.menuItemHint}>{rtl ? '‹' : '›'}</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <View style={styles.menuItem}>
              <Text style={styles.menuItemText}>{t('tok_hide_balances')}</Text>
              <PillToggle value={balancesHidden} onValueChange={toggleBalancesHidden} />
            </View>
          </View>
        </>
      )}

      {/* Token manager: search + per-token visibility + add-by-address; local view only, never touches balances. */}
      {showTokenManager && (
        <KeyboardAvoidingView style={[styles.modalOverlay, styles.modalOverlayKeyboard]} behavior="padding">
          <View style={[styles.modalBox, styles.mgrBox]}>
            <View style={styles.mgrHeader}>
              <Text style={[styles.modalTitle, styles.mgrTitle]}>{t('tok_manage')}</Text>
              <TouchableOpacity onPress={() => { setShowTokenManager(false); setAddTokenError(''); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel={t('common_close')}>
                <Text style={styles.mgrClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.mgrSearch}
              placeholder={t('tok_search')}
              placeholderTextColor="#888"
              value={tokenMgrQuery}
              onChangeText={(q) => { setTokenMgrQuery(q); if (addTokenError) setAddTokenError(''); }}
              autoCapitalize="none"
              autoCorrect={false}
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
                // Inert letter/emoji avatar (never load a node-supplied URL logo); QNC = app icon.
                const logo = typeof tk.logo === 'string' ? tk.logo.trim() : '';
                const isEmoji = isGlyphLogo(logo);
                let h = 0; const seed = String(tk.contract || tk.symbol || '?');
                for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
                const bg = isEmoji ? '#0b1a22' : `hsl(${h % 360}, 60%, 42%)`;
                const title = addable ? `${tk.contract.slice(0, 10)}…${tk.contract.slice(-6)}` : tokenTitle(tk);
                return (
                  <View style={styles.mgrRow}>
                    <View style={[styles.tokenIcon, { backgroundColor: isQnc ? 'transparent' : bg, borderRadius: 18, width: 36, height: 36, marginEnd: 10 }]}>
                      {isQnc ? (
                        <Image source={require('../../assets/qnet_logo.png')} style={{ width: 36, height: 36 }} resizeMode="contain" />
                      ) : (
                        <Text style={[styles.tokenIconText, { color: '#ffffff', fontSize: 15 }]}>
                          {isEmoji ? logo : tokenInitial(tk)}
                        </Text>
                      )}
                    </View>
                    <View style={styles.mgrRowInfo}>
                      <Text style={styles.mgrRowSym} numberOfLines={1}>{title}</Text>
                      <Text style={styles.mgrRowBal}>{addable ? t('tok_not_tracked') : maskAmt(tk.balance)}</Text>
                      {!isQnc && !addable ? <Text style={styles.mgrRowBal}>{t('tok_contract_id', { id: contractShortId(tk.contract) })}</Text> : null}
                      {reserved ? <Text style={[styles.mgrRowBal, { color: '#ff5555' }]}>{t('tok_reserved_warning')}</Text> : null}
                    </View>
                    <PillToggle
                      value={addable ? false : visible}
                      onValueChange={(v) => addable ? (v && handleAddCustomToken(tk.contract)) : setTokenVisible(tk.contract, v)}
                    />
                  </View>
                );
              }}
            />
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Add Custom QRC-20 Token Modal */}
      {showAddTokenModal && (
        <KeyboardAvoidingView style={[styles.modalOverlay, styles.modalOverlayKeyboard]} behavior="padding">
          <View style={styles.modalBox}>
            <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>{t('tok_add_title')}</Text>
              <Text style={styles.modalContent}>
                {t('tok_add_body')}
              </Text>
              <TextInput
                style={styles.input}
                placeholder={t('tok_contract_placeholder')}
                placeholderTextColor="#888"
                value={addTokenAddress}
                onChangeText={(txt) => { setAddTokenAddress(txt.trim()); setAddTokenError(''); }}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {!!addTokenError && (
                <Text style={[styles.modalContent, { color: '#ff5555' }]}>{addTokenError}</Text>
              )}
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonSecondary]}
                onPress={closeAddTokenModal}
                disabled={addingToken}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary]}
                onPress={handleAddCustomToken}
                disabled={addingToken}
              >
                <Text style={styles.modalButtonText}>{addingToken ? t('adding') : t('common_add')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Settings' password prompt: biometric unlock on, or the move to the screen lock */}
      {showBiometricPasswordPrompt && (
        <KeyboardAvoidingView style={[styles.modalOverlay, styles.modalOverlayKeyboard]} behavior="padding">
          <View style={styles.modalBox}>
            <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>{t(showBiometricPasswordPrompt === 'device' ? 'set_device_unlock' : 'enable_biometric')}</Text>
              {showBiometricPasswordPrompt === 'device' ? (
                <Text style={styles.modalContent}>{t('device_unlock_offer_body')}</Text>
              ) : null}
              <TextInput
                style={styles.input}
                placeholder={t('password')}
                accessibilityLabel={t('enter_current_password')}
                placeholderTextColor="#888"
                {...PASSWORD_INPUT_PROPS}
                value={biometricPassword}
                onChangeText={setBiometricPassword}
                onSubmitEditing={handleConfirmBiometricEnable}
                returnKeyType="done"
              />
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonSecondary]}
                onPress={() => { setShowBiometricPasswordPrompt(false); setBiometricPassword(''); }}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary]}
                onPress={handleConfirmBiometricEnable}
              >
                <Text style={styles.modalButtonText}>{t(showBiometricPasswordPrompt === 'device' ? 'device_unlock_offer_yes' : 'enable_biometric')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Export the recovery phrase or the private keys: the same check before either. */}
      {showExportSeed && (
        <KeyboardAvoidingView style={[styles.modalOverlay, styles.modalOverlayKeyboard]} behavior="padding">
          <View style={styles.modalBox}>
            <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>{t(exportWhat === 'key' ? 'export_private_key' : 'export_recovery_phrase')}</Text>
              <Text style={styles.modalWarning}>
                {t(exportWhat === 'key' ? 'private_key_warning' : 'recovery_phrase_warning')}
              </Text>
              {exportWhat === 'key' && (
              <>
              <Text style={styles.modalLabel}>{t('private_key_account')}</Text>
              <View style={styles.keyAccountRow} accessibilityRole="radiogroup">
                {KEY_ACCOUNTS.map(([which, title]) => (
                  <TouchableOpacity
                    key={which}
                    style={[styles.keyAccountOption, exportAccount === which && styles.keyAccountOptionOn]}
                    onPress={() => setExportAccount(which)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: exportAccount === which }}
                    testID={'key-account-' + which}
                  >
                    <Text style={[styles.keyAccountText, exportAccount === which && styles.keyAccountTextOn]}>{t(title)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.keyRevealFormat}>{t(exportAccount === 'solana' ? 'private_key_solana_format' : 'private_key_qnet_format')}</Text>
              </>
              )}

              {!deviceAuth && (
              <>
              <Text style={styles.modalLabel}>{t('enter_password_to_reveal')}</Text>
              <TextInput
                style={styles.input}
                placeholder={t('password')}
                accessibilityLabel={t('enter_password_to_reveal')}
                placeholderTextColor="#888"
                {...PASSWORD_INPUT_PROPS}
                value={exportPassword}
                onChangeText={setExportPassword}
              />
              </>
              )}
            </ScrollView>

            <View style={styles.modalActions}>
              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonSecondary]}
                onPress={() => {
                  setShowExportSeed(false);
                  setExportPassword('');
                }}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonPrimary]}
                onPress={() => (exportWhat === 'key' ? exportPrivateKey() : exportSeedPhrase())}
                disabled={loading}
              >
                <Text style={styles.modalButtonText}>{loading ? t('verifying') : t('show')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Auto-Lock Time Picker Modal */}
      {showAutoLockPicker && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, styles.modalBody]}>
            <Text style={styles.modalTitle}>{t('auto_lock_timer')}</Text>
            <Text style={styles.modalSubtitle}>{t('select_inactivity_time')}</Text>
            
            <ScrollView style={styles.modalScroll}>
              {AUTO_LOCK_CHOICES.map((time) => (
                <TouchableOpacity
                  key={time}
                  style={[
                    styles.timeOption,
                    autoLockTime === time && styles.timeOptionActive
                  ]}
                  onPress={() => saveAutoLockTime(time)}
                >
                  <Text style={[
                    styles.timeOptionText,
                    autoLockTime === time && styles.timeOptionTextActive
                  ]}>
                    {t(`autolock_${time}`)}
                  </Text>
                  {autoLockTime === time && <Text style={styles.checkmark}>✓</Text>}
                </TouchableOpacity>
              ))}
            </ScrollView>

            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton, {marginTop: 10}]}
              onPress={() => setShowAutoLockPicker(false)}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Language Picker Modal */}
      {showLanguagePicker && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, styles.modalBody]}>
            <Text style={styles.modalTitle}>{t('language')}</Text>
            <Text style={styles.modalSubtitle}>{t('language_subtitle')}</Text>
            
            <ScrollView 
              style={styles.modalScroll}
              onScroll={handleUserActivity} 
              scrollEventThrottle={1000}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
            >
              {LANGUAGES.map((lang) => (
                <TouchableOpacity
                  key={lang.code}
                  style={[
                    styles.timeOption,
                    language === lang.code && styles.timeOptionActive
                  ]}
                  onPress={() => {
                    saveLanguage(lang.code);
                    setShowLanguagePicker(false);
                  }}
                >
                  <Text style={[
                    styles.timeOptionText,
                    language === lang.code && styles.timeOptionTextActive
                  ]}>
                    {lang.name}
                  </Text>
                  {language === lang.code && <Text style={styles.checkmark}>✓</Text>}
                </TouchableOpacity>
              ))}
            </ScrollView>

            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton, {marginTop: 10}]}
              onPress={() => setShowLanguagePicker(false)}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
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
