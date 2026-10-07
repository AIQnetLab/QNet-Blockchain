// Constants of this build. The release channel fixes every endpoint and the Solana cluster; none of
// them is a user setting. dist/manifest.json lists exactly these origins (test/skeleton.test.mjs).
// CONTRACTS.md is the agreement on everything below.
// Imported by the worker and by the extension pages; it holds no secret and touches no browser API.

/** true only in dist-dev/, where scripts/build-dev.mjs rewrites this line; gates the logger. */
export const DEV_BUILD = false;

export const WALLET_VERSION = '3.1.0';
export const RELEASE_CHANNEL = 'testnet';

export const QNET = Object.freeze({
  CHAIN_ID: 'q1337',
  NETWORK: 'testnet',
  NODES: Object.freeze([
    'https://node1.aiqnet.io',
    'https://node2.aiqnet.io',
    'https://node3.aiqnet.io',
    'https://node4.aiqnet.io',
    'https://node5.aiqnet.io',
  ]),
  EXPLORER_API: 'https://aiqnet.io',
  // Page links (opened with chrome.tabs.create, never fetched): EXPLORER_API + path + encodeURIComponent(hash).
  EXPLORER_TX_PATH: '/explorer/tx/',
});

const ONE_DEV_MINTS = Object.freeze({
  devnet: '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ',
  mainnet: '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump',
});
const SOLANA_CLUSTER = 'devnet';

export const SOLANA = Object.freeze({
  CLUSTER: SOLANA_CLUSTER,
  RPC_URLS: Object.freeze(['https://api.devnet.solana.com']),
  ONE_DEV_MINT: ONE_DEV_MINTS[SOLANA_CLUSTER],
  // Program ids come from qnet-core SOLANA_PROGRAMS; only the v1 memo program the matcher also accepts is here.
  MEMO_V1_PROGRAM: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  NODE_TYPE_MEMO: Object.freeze({ light: 'QNET_NODE_TYPE:LIGHT', super: 'QNET_NODE_TYPE:SUPER' }),
  // Floor of SOL kept for fees before a burn or send is built (one signature is 5000 lamports).
  FEE_BUFFER_LAMPORTS: 10000,
  // Page link: EXPLORER_TX_URL + signature + EXPLORER_CLUSTER_QUERY.
  EXPLORER_TX_URL: 'https://explorer.solana.com/tx/',
  EXPLORER_CLUSTER_QUERY: SOLANA_CLUSTER === 'mainnet' ? '' : `?cluster=${SOLANA_CLUSTER}`,
  // The largest serialized transaction a Solana node accepts.
  TRANSACTION_MAX_BYTES: 1232,
});

// What a payment request may have a Solana send carry (the app's grammar, utils/solanaRequest.js): at most
// REFERENCES_MAX reference keys, read-only accounts of the transfer the payee finds its payment by, and a memo of at most
// MEMO_MAX_BYTES of UTF-8 (isPaymentRequestMemo).
export const PAYMENT_REQUEST = Object.freeze({ REFERENCES_MAX: 4, MEMO_MAX_BYTES: 200 });
// Control characters and the marks that reorder text on screen: a memo holding one could show other text than it is.
const UNSAFE_MEMO_RE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;
const UTF8 = new TextEncoder();

/**
 * Whether `text` is a memo a payment request may have a send carry: not empty, well-formed, at most
 * PAYMENT_REQUEST.MEMO_MAX_BYTES of UTF-8 and without a character of UNSAFE_MEMO_RE (the app's rule). The page reads a
 * request with it (kit.parseSolanaRecipient), and the router and the worker check a memo with it again.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isPaymentRequestMemo(text) {
  return typeof text === 'string' && text.length > 0 && text.length <= PAYMENT_REQUEST.MEMO_MAX_BYTES
    && text.isWellFormed() && !UNSAFE_MEMO_RE.test(text) && UTF8.encode(text).length <= PAYMENT_REQUEST.MEMO_MAX_BYTES;
}

export const DECIMALS = Object.freeze({ QNC: 9, SOL: 9, ONE_DEV: 6 });

export const UI_PAGES = Object.freeze({
  popup: 'ui/popup.html',
  setup: 'ui/setup.html',
  approve: 'ui/approve.html',
});

export const PROVIDER = Object.freeze({
  PORT_NAME: 'qnet-provider',
  RELAY_SCRIPT: 'content/relay.js',
  // window.postMessage envelope tags between inject/provider.js and content/relay.js.
  TO_RELAY: 'qnet-relay',
  TO_PAGE: 'qnet-provider',
  ANNOUNCE_EVENT: 'qnet:announceProvider',
  REQUEST_EVENT: 'qnet:requestProvider',
  RDNS: 'io.aiqnet.wallet',
  NAME: 'QNet Wallet',
  // info.channel of the announcement: the mobile in-app browser announces 'mobile' (QNet Link v1, section 11).
  CHANNEL: 'extension',
  EVENTS: Object.freeze(['accountsChanged', 'disconnect']),
  // qnet_activateNode is served to this origin only; the dev build adds plain HTTP loopback origins.
  ACTIVATION_ORIGIN: 'https://aiqnet.io',
  // chrome.tabs.sendMessage envelope tag: an event for a page whose relay has no open port (router.emitProviderEvent).
  TAB_EVENT: 'qnet-provider-event',
});

// aiqnet.io's verified record of every wallet's burn (CONTRACTS.md decision 35): the worker asks QNET.EXPLORER_API only
// under RECORD_PATH (qnet.siteRequest), and a record's proof names RECORD_ORIGIN, the same in every build.
export const RECORD_PATH = '/api/cabinet/activation/';
export const RECORD_ORIGIN = 'https://aiqnet.io';

/** Worker → extension pages broadcast tag (router.broadcastToViews, common.onWalletEvent). */
export const VIEW_EVENT_CHANNEL = 'qnet-event';
// 'balance': a send, token transfer, contract call, activation or claim a site asked for has finished; pages read the
// balances and the history again.
export const VIEW_EVENTS = Object.freeze(['locked', 'unlocked', 'wiped', 'activation', 'approval', 'balance']);

export const STORAGE_KEYS = Object.freeze({
  // chrome.storage.local: content scripts may be able to write it, so nothing here decides security
  // alone (R22). Grants carry a MAC keyed by the vault record's sitesKey; settings hold the language only.
  SITES: 'qnet_sites_v3',
  SETTINGS: 'qnet_settings_v3',
  // chrome.storage.session (TRUSTED_CONTEXTS)
  SESSION: 'qnet_session_v3',
  BACKOFF: 'qnet_backoff_v3',
  SELF_TEST: 'qnet_selftest_v3',
  APPROVAL_COOLDOWN: 'qnet_approval_cooldown_v3',
  // the popup's last balances and first history pages of this session (decision 39), gone with every lock
  VIEW_CACHE: 'qnet_view_cache_v3',
});

export const VAULT_DB = Object.freeze({ NAME: 'qnet-vault-v3', VERSION: 1, STORE: 'vault', KEY: 'main' });

// Auto-lock after this many minutes without activity, or never: no inactivity timer; the wallet still locks on Lock,
// on the OS screen lock and when the browser closes (the session lives in chrome.storage.session).
export const AUTO_LOCK_NEVER = 'never';
export const AUTO_LOCK_CHOICES = Object.freeze([5, 15, 30, 60, AUTO_LOCK_NEVER]);
export const DEFAULT_AUTO_LOCK_MINUTES = 15;
// UI languages (dist/ui/i18n/<code>.js): the mobile app's set, in its order; English is the source.
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'zh-CN', 'ru', 'es', 'ko', 'ja', 'pt', 'fr', 'de', 'ar', 'it']);
export const DEFAULT_LANGUAGE = 'en';
export const RTL_LANGUAGES = Object.freeze(['ar']);

/**
 * The UI language for a browser language tag ('pt-BR' → 'pt'), or null when none fits. Chinese maps to
 * 'zh-CN' unless the tag names a Traditional script or region, which the UI does not have.
 * @param {unknown} tag BCP 47 ('-') or Chrome ('_') form
 * @returns {string|null}
 */
export function languageForTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0 || tag.length > 64) return null;
  const lower = tag.toLowerCase().replace(/_/g, '-');
  const exact = SUPPORTED_LANGUAGES.find((code) => code.toLowerCase() === lower);
  if (exact) return exact;
  const [base, ...rest] = lower.split('-');
  if (base === 'zh') return rest.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? null : 'zh-CN';
  return SUPPORTED_LANGUAGES.includes(base) ? base : null;
}

export const LIMITS = Object.freeze({
  UI_MESSAGE_MAX_CHARS: 16384,
  PORT_MESSAGE_MAX_CHARS: 16384,
  PORT_MAX_PENDING: 16,
  APPROVAL_QUEUE_PER_ORIGIN: 3,
  // This many rejected or closed approvals of one origin within TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS
  // bring the cooldown (a single rejection brings none: owner, 28.09).
  APPROVAL_COOLDOWN_REJECTIONS: 5,
  APPROVAL_COOLDOWN_ORIGINS_MAX: 64,
  // Approval windows of one origin that ended without an approved action, however they ended (closed,
  // rejected, its page gone, unavailable, timed out): at most this many within TIMINGS.APPROVAL_BUDGET_SHORT_MS,
  // and APPROVAL_BUDGET_LONG within TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS; then the cooldown 4001 (R2-ERP-01).
  APPROVAL_BUDGET_SHORT: 5,
  APPROVAL_BUDGET_LONG: 20,
  PENDING_TRANSFERS_MAX: 16,
  // the spend records the vault keeps of this wallet's recent transactions (vault.spends): what a send counts above a
  // certified state
  SPENDS_MAX: 64,
  HISTORY_PAGE_MAX: 50,
  // solana.history: transactions one page may hold (each is read once with getTransaction)
  SOLANA_HISTORY_PAGE_MAX: 25,
  PASSWORD_MAX_CHARS: 1024,
  MNEMONIC_MAX_CHARS: 1024,
  // Unlock-style password checks: free attempts, then 1 s doubling up to 5 min.
  BACKOFF_FREE_ATTEMPTS: 3,
  BACKOFF_BASE_MS: 1000,
  BACKOFF_MAX_MS: 300000,
  // One call of the burn search (solana.findWalletBurns): pages of the 1DEV account's history it may list
  // and its time budget; what it listed and checked is kept (vault.writeBurnScan) and the next call goes on
  // from there. The listing pauses, never skips, while BURN_SCAN_MAX_UNCHECKED candidates wait.
  BURN_SCAN_PAGE_SIZE: 1000,
  BURN_SCAN_MAX_PAGES: 400,
  BURN_SCAN_MAX_UNCHECKED: 4000,
  BURN_SCAN_DEADLINE_MS: 90000,
  // Automatic submits of the light node's registration while the chain still lists it absent; then only the user's
  // Record on the network tries again (the app's cap).
  REGISTRATION_MAX_ATTEMPTS: 12,
  // qnet_getActivation reads one origin may make a minute (more: 4001).
  ACTIVATION_READS_PER_MINUTE: 30,
});

/** The smallest node balance a move to the wallet takes (1 QNC, in nano; QNet Link v1 section 14.2). */
export const CLAIM_MIN_NANO = '1000000000';

export const TIMINGS = Object.freeze({
  REVEAL_AUTO_HIDE_MS: 45000,
  CLIPBOARD_CLEAR_MS: 45000,
  // A recovery phrase copied by its Copy button leaves the clipboard after this, if nothing was copied since.
  PHRASE_CLIPBOARD_CLEAR_MS: 60000,
  CONFIRM_ARM_MS: 1000,
  // A confirm that moves value (a QNC send, a 1DEV burn) arms after this instead (the mobile rule, MBL-05).
  CONFIRM_ARM_VALUE_MS: 1500,
  APPROVAL_HEARTBEAT_MS: 20000,
  // While the popup is visible, the balances, the token list and the history on screen are read again this often.
  POPUP_REFRESH_MS: 15000,
  // The popup's keepalive while the forgot-password reset waits for its confirmation: the one-time token lives
  // in worker memory, and an idle MV3 worker stops after about 30 s (R2-ESM-06).
  RESTORE_KEEPALIVE_MS: 20000,
  // An approval left open this long is rejected with 4001 and its window closed.
  APPROVAL_TIMEOUT_MS: 600000,
  // After the user rejects or closes an approval, its origin opens no other one for this long (none: a person
  // who declined once may try again at once, owner 28.09)...
  APPROVAL_COOLDOWN_MS: 0,
  // ...or this long after LIMITS.APPROVAL_COOLDOWN_REJECTIONS of them within APPROVAL_COOLDOWN_WINDOW_MS.
  APPROVAL_COOLDOWN_LONG_MS: 60000,
  APPROVAL_COOLDOWN_WINDOW_MS: 600000,
  APPROVAL_BUDGET_SHORT_MS: 60000,
  // The one-time token of the forgot-password restore (vault.restoreBegin → vault.restore).
  RESTORE_TOKEN_TTL_MS: 600000,
  NODE_TIMEOUT_MS: 8000,
  SOLANA_TIMEOUT_MS: 15000,
  BURN_FINALIZE_TIMEOUT_MS: 90000,
  // The light node's registration (nodes.js): the node collects the committee's burn attestations inside the submit;
  // an admitted registration is left this long to reach a block before it is sent again, and the chain is read at most
  // every REGISTRATION_ADMIT_CHECK_MS meanwhile; retries wait 15 s, 30 s, 60 s, then doubling minutes up to 6 h, and a
  // retry further away than REGISTRATION_SOON_MS shows Record on the network; an activation of an earlier build is
  // looked up on chain at most this often.
  REGISTRATION_SUBMIT_TIMEOUT_MS: 30000,
  REGISTRATION_ADMIT_HOLD_MS: 600000,
  REGISTRATION_ADMIT_CHECK_MS: 30000,
  REGISTRATION_SOON_MS: 180000,
  REGISTRATION_FIRST_RETRY_MS: 15000,
  REGISTRATION_BACKOFF_MAX_MS: 21600000,
  REGISTRATION_CHECK_MS: 600000,
  // How long the qnet_activateNode window stays on the registration after its answer, and how often a page reads it.
  REGISTRATION_WINDOW_MS: 180000,
  REGISTRATION_POLL_MS: 5000,
  // aiqnet.io's record of this wallet's burn (decision 35): one request's time; a reservation's life there, and the
  // least of it that must be left when a burn is signed under it.
  RECORD_TIMEOUT_MS: 8000,
  RESERVATION_TTL_MS: 600000,
  SIGN_MARGIN_MS: 120000,
  // The kept search of the wallet's own address that the site's read, the approval window and the Activate tab share:
  // started at most this often, and its "no burn" good for this long.
  WALLET_SEARCH_SPACING_MS: 20000,
  WALLET_SEARCH_FRESH_MS: 60000,
  // While the Activate tab shows a burn on its way, a check or an activation starting elsewhere, it reads again this often.
  ACTIVATE_RECHECK_MS: 5000,
});

export const AUTO_LOCK_ALARM = 'qnet-auto-lock';
/** The alarm that resumes the light node's registration while one waits (nodes.js). */
export const REGISTRATION_ALARM = 'qnet-register';
