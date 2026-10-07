// The popup: lock screen and the wallet (QNet / Solana switch; tabs Assets, Send,
// Receive, History, Activate, Settings; no Node tab). It holds addresses and balances only; every secret
// stays in the worker, and a revealed phrase or code lives in the DOM only while shown. Balances, the token list
// and the history read themselves again while shown (keepFresh), and what this session read last shows at once while
// they do (seen); there is no Refresh button.
import * as core from '../lib/qnet-core.js';
import {
  AUTO_LOCK_CHOICES, AUTO_LOCK_NEVER, DEFAULT_LANGUAGE, LIMITS, QNET, RECORD_ORIGIN, RELEASE_CHANNEL, SOLANA, SUPPORTED_LANGUAGES,
  TIMINGS, WALLET_VERSION, languageForTag,
} from '../background/config.js';
import {
  DECIMALS, UiError, call, clear, clearPageStorage, copyText, currentLanguage, el, formatUnits, loadLocale, log, onWalletEvent,
  openSetup, refuseAutoFocus, refuseFramed, shortAddress, t, wipeInputs,
} from './common.js';
import { LANGUAGE_NAMES } from './i18n/index.js';
import {
  addressCopy, addressText, button, canonicalAmount, checkbox, codeText, countdown, earlierRemoval, errorCode, errorText, field, formatAmount,
  formatDay, formatTime, heading, kvList, looksLikeKnownAddress, messageLine, newPasswordFields, notice, noticeList, onEnter, openTab,
  parseSolanaRecipient, passwordInput, qnetTxUrl, segmented, solanaTxUrl, textArea, textInput, valueCopy, whileBusy,
} from './kit.js';
import { qrMatrix } from './qr.js';

refuseFramed();
refuseAutoFocus();

const TABS = Object.freeze(['assets', 'send', 'receive', 'history', 'activate', 'settings']);
const NETWORK_TABS = new Set(['assets', 'send', 'receive', 'history']);
const HISTORY_PAGE_SIZE = 20;
// Solana History reads each transaction once, so its pages are smaller (LIMITS.SOLANA_HISTORY_PAGE_MAX at most).
const SOLANA_HISTORY_PAGE_SIZE = 10;
const TOAST_MS = 4000;
const WIPE_WORD = 'DELETE';
// The worker's confirmation of a reset (vault.restore), sent once the user ticked the one checkbox; never typed.
const RESTORE_CONFIRM = 'ERASE';
const QR_QUIET_MODULES = 4;
const QR_TARGET_PX = 200;
// Burn failures that happen before anything is sent to Solana (a Solana that could not be read stops the
// burn before it is signed, or refused it before forwarding: once sent, an outage only delays the code).
const BURN_NOT_SENT = new Set(['INSUFFICIENT_SOL', 'INSUFFICIENT_TOKENS', 'SIMULATION_FAILED', 'SIGNING_DISABLED',
  'SOLANA_UNAVAILABLE']);
// Burn refusals that send the user back to the Activate overview with the reason (a history too long for
// one search goes on with the next try: R2-ESA-02; NETWORK: the QNet nodes could not vouch that this wallet has no
// node, which the burn asks before anything is signed; aiqnet.io's record of this wallet's burn, a reservation elsewhere,
// or no answer from it: decision 35, nothing is signed or sent).
const BURN_REFUSED = new Set([
  'PRICE_CHANGED', 'PRICE_UNAVAILABLE', 'PHASE_UNSUPPORTED', 'BURN_EXISTS', 'BURN_UNUSABLE', 'ALREADY_ACTIVATED', 'NODE_EXISTS',
  'BURN_IN_PROGRESS', 'HISTORY_TOO_LONG', 'NETWORK', 'ACTIVATION_RECORDED', 'ACTIVATION_RESERVED', 'RECORD_UNAVAILABLE',
]);

const root = document.getElementById('app');
const state = {
  screen: 'loading', // loading | error | welcome | lock | restore | wallet
  status: null,
  addresses: null,
  network: 'qnet',
  tab: 'assets',
  unlocking: false,
  // true while vault.restore runs: its own 'wiped' event must not reload this page
  restoring: false,
  // true while Activate shows its overview; an 'activation' event may then refresh it
  activateIdle: false,
};
let shell = null;
let viewSeq = 0;
const disposers = new Set();
// The Activate overview on screen with an activation: {shown, record, isCurrent} (refreshActivate)
let activateOverview = null;

// ---------------------------------------------------------------- view plumbing

function onDispose(fn) {
  disposers.add(fn);
  return fn;
}

function runDisposers() {
  for (const fn of [...disposers]) {
    disposers.delete(fn);
    try {
      fn();
    } catch (error) {
      log.warn('dispose failed', error?.name);
    }
  }
}

function showScreen(name, node) {
  wipeView();
  state.screen = name;
  root.append(node);
}

/** Replaces the tab body. The returned function tells async work whether its view is still shown. */
function showTab(node) {
  runDisposers();
  if (!shell) return () => false;
  wipeInputs(shell.body);
  clear(shell.body);
  shell.body.append(node);
  shell.body.scrollTop = 0;
  viewSeq += 1;
  const seq = viewSeq;
  return () => seq === viewSeq && shell !== null;
}

/**
 * Clears every input value and the rendered view (on lock, wipe and pagehide).
 * @returns {void}
 */
function wipeView() {
  runDisposers();
  if (shell) clearTimeout(shell.toastTimer);
  wipeInputs(root);
  clear(root);
  shell = null;
  viewSeq += 1;
}

// ---------------------------------------------------------------- live data

// The balances, the token list and the history on screen read themselves again (owner, 29.09: no Refresh button):
// when their view opens, every TIMINGS.POPUP_REFRESH_MS while the popup is visible (no read while it is hidden, one
// read when it shows again), when a send, token transfer, contract call, activation or claim a site asked for finishes
// (the worker's 'balance' event), and on a change of network or wallet (the view opens again). The view on screen gives
// its read (keepFresh); one read runs at a time: a tick while it runs is skipped, an event reads once more after it. A
// read that fails keeps what is shown.
let live = null;
let liveTicks = null;

function stopTicks() {
  clearInterval(liveTicks);
  liveTicks = null;
}

function startTicks() {
  stopTicks();
  if (live !== null && !document.hidden) liveTicks = setInterval(() => readFresh(), TIMINGS.POPUP_REFRESH_MS);
}

/**
 * Makes `read` the silent re-read of the view on screen, until that view goes (onDispose).
 * @param {() => Promise<void>} read
 * @returns {void}
 */
function keepFresh(read) {
  const entry = { read, running: false, again: false, current: null };
  live = entry;
  onDispose(() => {
    if (live !== entry) return;
    live = null;
    stopTicks();
  });
  startTicks();
}

/**
 * Runs the view's read unless the popup is hidden. While one runs, a tick is skipped and `queue` (an event, the popup
 * shown again) asks for one more read after it.
 * @param {{queue?: boolean}} [options]
 * @returns {Promise<void>}
 */
async function readFresh({ queue = false } = {}) {
  const entry = live;
  if (entry === null || document.hidden) return;
  if (entry.running) {
    if (queue) entry.again = true;
    return;
  }
  entry.running = true;
  // the read running now, for prefetch to go after it
  entry.current = (async () => {
    try {
      do {
        entry.again = false;
        try {
          await entry.read();
        } catch (error) {
          log.warn('refresh failed', error?.code ?? error?.name);
        }
      } while (entry.again && live === entry);
    } finally {
      entry.running = false;
    }
  })();
  await entry.current;
}

// The balances, the QNet token list and the first history pages of both networks as last read: the worker's view cache
// (wallet.cached: this session's reads, and the last verified balances kept across sessions) when the wallet opens, then
// every read. A view draws what is here at once and reads again behind it, and the other network is read in the
// background once the view on screen has read, so a switch shows its numbers at once (owner, 04.10). Dropped with the
// view on a lock.
const SEEN_KEYS = Object.freeze({
  qnet: Object.freeze({ balances: 'qnetBalance', history: 'qnetHistory', tokens: 'qnetTokens' }),
  solana: Object.freeze({ balances: 'solanaBalances', history: 'solanaHistory' }),
});
const SEEN_READS = Object.freeze({
  balances: (network) => call(network === 'qnet' ? 'qnet.balance' : 'solana.balances'),
  history: (network) => (network === 'qnet' ? call('qnet.history', { limit: HISTORY_PAGE_SIZE })
    : call('solana.history', { limit: SOLANA_HISTORY_PAGE_SIZE })),
  tokens: () => call('qnet.tokens'),
});
let seen = {};
const seenOf = (network, kind) => (Object.hasOwn(SEEN_KEYS[network], kind) ? seen[SEEN_KEYS[network][kind]] ?? null : null);

function remember(network, kind, value) {
  seen[SEEN_KEYS[network][kind]] = value;
  return value;
}

async function readSeen(network, kind) {
  return remember(network, kind, await SEEN_READS[kind](network));
}

// The QNet tokens the wallet holds as last read (qnet.tokens), [] before the first read.
const seenTokens = () => (Array.isArray(seenOf('qnet', 'tokens')?.tokens) ? seenOf('qnet', 'tokens').tokens : []);

// After an open or an unlock: every balance, token list and first history page the view on screen does not read itself,
// once that view's own first read is done (it goes first) or PREFETCH_WAIT_MS passed.
const PREFETCH_WAIT_MS = 3000;
async function prefetch() {
  const first = live?.current ?? null;
  if (first !== null) await Promise.race([first.catch(() => {}), new Promise((resolve) => setTimeout(resolve, PREFETCH_WAIT_MS))]);
  if (state.screen !== 'wallet') return;
  const own = { assets: ['balances', 'tokens'], history: ['history'], send: ['balances', 'tokens'] }[state.tab] ?? [];
  for (const network of Object.keys(SEEN_KEYS)) {
    for (const kind of Object.keys(SEEN_KEYS[network])) {
      if (network === state.network && own.includes(kind)) continue;
      readSeen(network, kind).catch((error) => log.warn('prefetch failed', network, kind, error?.code));
    }
  }
}

function onVisibility() {
  if (document.hidden) {
    stopTicks();
    return;
  }
  startTicks();
  readFresh({ queue: true });
}

function toast(text, kind = 'info') {
  if (!shell) return;
  const node = shell.toast;
  node.textContent = text;
  node.className = `toast toast-${kind} show`;
  clearTimeout(shell.toastTimer);
  shell.toastTimer = setTimeout(() => {
    node.className = 'toast';
    node.textContent = '';
  }, TOAST_MS);
}

const brandMark = (className) => el('img', { className, attrs: { src: '../icons/icon-128.png', alt: '' } });
const actionsRow = (...buttons) => el('div', { className: 'row actions' }, ...buttons);
const nodeLabel = (nodeType) => t(nodeType === 'super' ? 'nodeSuper' : 'nodeLight');

function loadingBlock() {
  return el('div', { className: 'loading' },
    el('div', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'muted', text: t('loading') }));
}

function failureBlock(error, retry) {
  return el('div', { className: 'stack' },
    notice('danger', errorText(error)),
    button(t('retry'), () => retry(), { action: 'retry' }));
}

function section(title, lead, content, className = '') {
  return el('section', { className: `section ${className}`.trim() },
    el('h3', { text: title }),
    lead ? el('p', { className: 'muted small', text: lead }) : null,
    ...content);
}

function validAddress(check, value) {
  try {
    return check(value) === true;
  } catch {
    return false;
  }
}

function copyAddress(address) {
  copyText(address)
    .then(() => toast(t('copied'), 'info'))
    .catch(() => toast(t('copyFailed'), 'error'));
}

// The recipient field of a send: the whole address fits the input, in the type of an address (popup.css .field-address).
function recipientField(input, hint = null) {
  input.classList.add('input-address');
  const node = field(t('sendTo'), input, hint);
  node.classList.add('field-address');
  return node;
}

// This wallet's own address of `network` on any screen: whole, on one line, and a click copies it (kit.addressCopy).
function ownAddress(address, network) {
  return addressCopy(address, t(network === 'qnet' ? 'qnetAddress' : 'solanaAddress'), {
    onCopied: () => toast(t('copied'), 'info'),
    onFailed: () => toast(t('copyFailed'), 'error'),
  });
}

// ---------------------------------------------------------------- entry and routing

/**
 * Entry. vault.status → no vault: the welcome screen (openSetup); locked: lock screen; unlocked: wallet.
 * Subscribes to onWalletEvent: 'locked' wipes the view and shows the lock screen, 'wiped' reloads.
 * @returns {Promise<void>}
 */
async function boot() {
  // what an earlier version kept in this page's storage (a copy of its password among it) goes at once (M-4)
  clearPageStorage();
  onWalletEvent(handleWalletEvent);
  window.addEventListener('pagehide', wipeView);
  document.addEventListener('visibilitychange', onVisibility);
  let language = languageForTag(globalThis.navigator?.language) ?? DEFAULT_LANGUAGE;
  try {
    const settings = await call('settings.get');
    if (typeof settings?.language === 'string') language = settings.language;
  } catch (error) {
    log.warn('settings unavailable', error?.code);
  }
  await loadLocale(language);
  document.title = t('appName');
  await route();
}

async function route() {
  showScreen('loading', el('div', { className: 'center-screen' }, loadingBlock()));
  let status;
  try {
    status = await call('vault.status');
  } catch (error) {
    showScreen('error', el('div', { className: 'center-screen' }, failureBlock(error, route)));
    return;
  }
  state.status = status;
  if (!status.exists) {
    renderWelcome();
    return;
  }
  if (!status.unlocked || !status.addresses) {
    seen = {};
    state.addresses = null;
    renderLock(status);
    return;
  }
  state.addresses = { qnet: status.addresses.qnet, solana: status.addresses.solana };
  try {
    seen = { ...(await call('wallet.cached')) };
  } catch (error) {
    log.warn('view cache unavailable', error?.code);
    seen = {};
  }
  renderWallet();
  prefetch().catch((error) => log.warn('prefetch failed', error?.name));
}

// The numbered words, one per line.
function phraseText(mnemonic) {
  return mnemonic.split(' ').map((word, index) => `${index + 1}. ${word}`).join('\n');
}

// The wallet of this browser is gone (a delete here or in another view): the view is dropped, the clipboard is
// emptied (best effort) so an activation code copied earlier does not outlive the wallet (R16), then the page starts
// over. The worker announces the wipe before it answers the delete, so this is the only place the popup that asked
// for it is sure to run before it reloads (R4-ESM-01). Once per page, whichever of the two gets here first.
let wiping = null;
function wipeAndReload() {
  wiping ??= (async () => {
    wipeView();
    await copyText('').catch(() => {});
    location.reload();
  })();
  return wiping;
}

function handleWalletEvent(event) {
  switch (event) {
    case 'locked':
      seen = {};
      if (state.screen === 'wallet') {
        wipeView();
        state.addresses = null;
        route();
      }
      break;
    case 'unlocked':
      if (state.screen === 'lock' && !state.unlocking) route();
      break;
    case 'wiped':
      clearPageStorage();
      if (state.restoring) break;
      wipeAndReload();
      break;
    case 'activation':
      if (state.screen === 'wallet' && state.tab === 'activate' && state.activateIdle) refreshActivate();
      break;
    case 'balance':
      if (state.screen === 'wallet') readFresh({ queue: true });
      break;
    default:
      break;
  }
}

// No vault of this version. While the wallet an earlier version kept is in this browser (M-4), the screen says so and its
// button leads to setup, which moves it.
function renderWelcome() {
  const earlier = state.status?.earlier === true;
  showScreen('welcome', el('div', { className: 'center-screen stack' },
    brandMark('logo-lg'),
    el('h1', { className: 'title-gradient', text: t('appName') }),
    el('p', { className: 'lead', text: t(earlier ? 'setupEarlierLead' : 'welcomeLead') }),
    button(t(earlier ? 'setupEarlierUnlock' : 'welcomeSetup'), () => {
      openSetup().catch((error) => log.warn('setup not opened', error?.name));
    }, { kind: 'primary', action: 'open-setup', block: true })));
}

// ---------------------------------------------------------------- lock screen

/**
 * Password field (hardened), unlock button, backoff countdown from BACKOFF.retryAfterMs.
 * @param {{backoffUntil: number|null}} status
 * @returns {void}
 */
function renderLock(status) {
  const password = passwordInput('password', t('lockPasswordPlaceholder'));
  const message = messageLine();
  const unlock = button(t('lockUnlock'), null, { kind: 'primary', action: 'unlock', block: true });
  showScreen('lock', el('div', { className: 'lock-screen' },
    el('div', { className: 'lock-top' }, el('h1', { className: 'title-gradient', text: t('appShortName') })),
    el('div', { className: 'lock-body' },
      brandMark('logo-lg'),
      el('p', { className: 'lead', text: t('lockLead') }),
      password,
      message.node,
      unlock,
      button(t('lockForgot'), () => renderRestore(), { kind: 'ghost', action: 'forgot-password' }))));

  let stopWait = () => {};
  const waitUntil = (until) => {
    stopWait();
    unlock.disabled = true;
    stopWait = onDispose(countdown(until, (seconds) => message.show(t('err_BACKOFF_wait', [seconds]), 'warn'), () => {
      unlock.disabled = false;
      message.clear();
    }));
  };
  const submit = async () => {
    if (unlock.disabled) return;
    const value = password.value;
    password.value = '';
    if (value === '') {
      message.show(t('lockEnterPassword'));
      return;
    }
    message.show(t('lockUnlocking'), 'info');
    state.unlocking = true;
    try {
      await whileBusy([unlock], () => call('vault.unlock', { password: value }));
    } catch (error) {
      state.unlocking = false;
      if (state.screen !== 'lock') return;
      if (errorCode(error) === 'BACKOFF' && Number.isSafeInteger(error.retryAfterMs)) waitUntil(Date.now() + error.retryAfterMs);
      else message.show(errorText(error));
      return;
    }
    state.unlocking = false;
    await route();
  };
  unlock.addEventListener('click', submit);
  onEnter(password, submit);
  if (Number.isSafeInteger(status?.backoffUntil) && status.backoffUntil > Date.now()) waitUntil(status.backoffUntil);
  // no field takes the cursor on its own, this one neither (owner, 06.10): the password field is focused only by a click
  // or Tab (common.refuseAutoFocus)
}

async function lockNow() {
  // Local first: the view is gone before the worker answers, whatever it answers (EXT-SEC-M1).
  wipeView();
  seen = {};
  state.addresses = null;
  showScreen('loading', el('div', { className: 'center-screen' }, loadingBlock()));
  try {
    await call('vault.lock');
  } catch (error) {
    log.warn('lock request failed', error?.code);
  }
  let status = null;
  try {
    status = await call('vault.status');
  } catch (error) {
    log.warn('status unavailable', error?.code);
  }
  renderLock(status);
}

// ---------------------------------------------------------------- forgot password: reset wallet

/**
 * "Forgot password?" → Reset wallet: a short lead, one warning, the recovery phrase (checked here in its canonical
 * form, again by the worker) and a new password. Continue empties the fields, asks vault.restoreBegin for the one-time
 * token the worker requires, then vault.restore without `confirm`: that call only checks the phrase and names both
 * wallets (renderRestoreConfirm). Nothing is erased before that confirmation. No word is typed to confirm.
 * @returns {void}
 */
function renderRestore() {
  const phrase = textArea({ name: 'phrase', rows: 4, placeholder: t('setupImportPlaceholder') });
  // a pasted phrase leaves the clipboard as soon as it is in the field (R3-EXT-UI-02, as the setup import)
  phrase.addEventListener('paste', () => {
    setTimeout(() => copyText('').catch(() => {}), 0);
  });
  const fresh = newPasswordFields(core);
  const message = messageLine();
  const back = button(t('back'), () => route(), { action: 'back' });
  const next = button(t('continue'), null, { kind: 'primary', action: 'restore' });
  const view = el('div', { className: 'screen-pad stack' },
    heading(t('restoreTitle'), t('restoreLead')),
    notice('danger', t('restoreWarn')),
    field(t('setupImportLabel'), phrase, t('setupImportLead')),
    ...fresh.nodes,
    message.node,
    actionsRow(back, next));
  showScreen('restore', view);
  next.addEventListener('click', async () => {
    message.clear();
    if (!isValidPhrase(phrase.value)) {
      message.show(t('setupImportInvalid'));
      return;
    }
    const password = fresh.read(message);
    if (password === null) return;
    const mnemonic = core.canonicalizeMnemonic(phrase.value);
    wipeInputs(view);
    fresh.refresh();
    message.show(t('restoreChecking'), 'info');
    let grant;
    try {
      grant = await whileBusy([next, back], () => call('vault.restoreBegin'));
    } catch (error) {
      if (state.screen === 'restore') message.show(errorText(error));
      return;
    }
    if (state.screen !== 'restore') return;
    keepWorkerAlive();
    await runRestore({ token: grant.token, mnemonic, password }, [next, back]);
  });
}

function isValidPhrase(text) {
  try {
    return core.validateMnemonic(text) === true;
  } catch {
    return false;
  }
}

// While the restore token exists the worker must stay up: the token lives in worker memory, and an idle MV3 worker
// stops after about 30 s (R2-ESM-06). A cheap status read every 20 s keeps it.
function keepWorkerAlive() {
  const timer = setInterval(() => {
    call('vault.status').catch(() => {});
  }, TIMINGS.RESTORE_KEEPALIVE_MS);
  onDispose(() => clearInterval(timer));
}

// One vault.restore call; a 'confirm' answer shows both wallets for the one confirmation.
async function runRestore(request, busyButtons) {
  state.restoring = true;
  let result = null;
  let failure = null;
  try {
    result = await whileBusy(busyButtons, () => call('vault.restore', request));
  } catch (error) {
    failure = error;
  } finally {
    state.restoring = false;
  }
  if (state.screen !== 'restore') return;
  if (failure === null && result?.status === 'confirm') {
    renderRestoreConfirm(request, result);
    return;
  }
  // Best effort, as after a wipe: a code copied from the old wallet must not outlive it (R16).
  await copyText('').catch(() => {});
  if (state.screen !== 'restore') return;
  if (failure === null) renderRestoreDone(result);
  else renderRestoreFailed(failure);
}

// A wallet's two addresses under what happens to it.
function walletPair(label, pair) {
  return el('div', { className: 'wallet-pair' },
    el('div', { className: 'card-label', text: label }),
    kvList([[t('qnetAddress'), addressText(pair.qnet)], [t('solanaAddress'), addressText(pair.solana)]]));
}

/**
 * The one confirmation before the vault is replaced: the wallet in this browser named by its addresses (none when its
 * record cannot be read), and for a phrase of another wallet (EXT-VAULT-R2-04) a danger notice with both wallets. One
 * checkbox arms Reset wallet, which repeats the call with `confirm` (and `replaceOther` for another wallet) and the same
 * token. The phrase and password wait in this page until then, and are dropped when the screen goes.
 * @param {{token: string, mnemonic: string, password: string}} request
 * @param {{erased: {qnet: string, solana: string}|null, restored: {qnet: string, solana: string}, otherWallet: boolean}}
 *   answer
 */
function renderRestoreConfirm(request, answer) {
  let pending = { token: request.token, mnemonic: request.mnemonic, password: request.password };
  const other = answer.otherWallet === true;
  const message = messageLine();
  const back = button(t('back'), () => route(), { action: 'back' });
  const go = button(t('restoreConfirmButton'), null, { kind: 'danger', action: 'restore-confirm', disabled: true });
  const understood = checkbox('understand', t('restoreUnderstand'), (checked) => {
    go.disabled = !checked;
  });
  let intro = notice('info', t('restoreSameWallet'));
  if (answer.erased === null) intro = notice('warn', t('restoreUnreadable'));
  else if (other) intro = notice('danger', t('restoreOtherWallet'));
  showScreen('restore', el('div', { className: 'screen-pad stack' },
    heading(t('restoreConfirmTitle')),
    intro,
    answer.erased === null ? null : walletPair(t(other ? 'restoreErased' : 'restoreCurrent'), answer.erased),
    answer.erased === null || other ? walletPair(t('restoreRestored'), answer.restored) : null,
    understood.node,
    message.node,
    actionsRow(back, go)));
  onDispose(() => {
    pending = null;
  });
  keepWorkerAlive();
  go.addEventListener('click', async () => {
    if (!understood.input.checked || pending === null) return;
    const confirmed = { ...pending, confirm: RESTORE_CONFIRM, ...(other ? { replaceOther: true } : {}) };
    pending = null;
    message.show(t('restoreWorking'), 'info');
    await runRestore(confirmed, [go, back]);
  });
}

// The token is spent: whatever failed, the flow starts again from the status (the old vault may be gone).
function renderRestoreFailed(error) {
  showScreen('restore', el('div', { className: 'screen-pad stack' },
    heading(t('restoreTitle')),
    notice('danger', errorText(error)),
    button(t('restoreStartAgain'), () => route(), { kind: 'primary', action: 'restore-again', block: true })));
}

function renderRestoreDone(result) {
  showScreen('restore', el('div', { className: 'screen-pad stack' },
    heading(t('restoreDoneTitle')),
    kvList([
      [t('qnetAddress'), ownAddress(result.qnet, 'qnet')],
      [t('solanaAddress'), ownAddress(result.solana, 'solana')],
    ]),
    notice('info', t('restoreDoneRecover')),
    button(t('continue'), () => route(), { kind: 'primary', action: 'continue', block: true })));
}

// ---------------------------------------------------------------- wallet frame

/**
 * Header (network switch, lock button) and the tab bar; shows the current tab.
 * @returns {void}
 */
function renderWallet() {
  const networkSwitch = segmented(
    [['qnet', t('networkQnet')], ['solana', t('networkSolana')]],
    state.network,
    (network) => selectNetwork(network),
    t('networkSwitchLabel'));
  networkSwitch.classList.add('network-switch');
  const header = el('header', { className: 'topbar' },
    el('div', { className: 'brand' }, brandMark('brand-mark'), el('span', { className: 'brand-name', text: t('appShortName') })),
    networkSwitch,
    lockButton());
  const tabButtons = new Map();
  const nav = el('nav', { className: 'tabs', attrs: { role: 'tablist', 'aria-label': t('tabsLabel') } });
  for (const tab of TABS) {
    const tabButton = el('button', {
      className: 'tab',
      text: t(`tab_${tab}`),
      attrs: { type: 'button', role: 'tab', 'data-tab': tab, 'aria-selected': String(state.tab === tab) },
    });
    tabButton.addEventListener('click', () => selectTab(tab));
    tabButtons.set(tab, tabButton);
    nav.append(tabButton);
  }
  const body = el('div', { className: 'tab-body', attrs: { role: 'tabpanel' } });
  const toastNode = el('div', { className: 'toast', attrs: { role: 'status', 'aria-live': 'polite' } });
  const banner = state.status?.signingEnabled === false ? notice('danger', t('signingDisabled')) : null;
  const frame = el('div', { className: `wallet net-${state.network}` }, header, banner, nav, body, toastNode);
  showScreen('wallet', frame);
  shell = { frame, body, toast: toastNode, tabButtons, toastTimer: null };
  fitTabs(nav);
  renderTab();
}

// Lock (owner, 06.10): a lock glyph in the header's text colour (popup.css .lock-icon, a vector drawn through a mask, as
// History's badges), with its name as the tooltip and for screen readers.
function lockButton() {
  const label = t('lockButton');
  const node = el('button', {
    className: 'btn btn-ghost icon-button',
    attrs: { type: 'button', 'data-action': 'lock', title: label, 'aria-label': label },
  }, el('span', { className: 'lock-icon', attrs: { 'aria-hidden': 'true' } }));
  node.addEventListener('click', () => {
    lockNow();
  });
  return node;
}

// The tab labels of a language wider than the bar are set smaller as one, to TAB_FIT_MIN of their size at most, so all
// six fit inside the bar's gutter; only past that does the bar scroll sideways (popup.css .tabs). Its labels never wrap.
const TAB_FIT_MIN = 0.8;
const TAB_FONT_REM = 0.72;
function fitTabs(nav) {
  const tabs = [...nav.querySelectorAll('.tab')];
  if (tabs.some((tab) => !tab.style)) return;
  for (const tab of tabs) tab.style.fontSize = '';
  let scale = 1;
  for (let pass = 0; pass < 3 && nav.clientWidth > 0 && nav.scrollWidth > nav.clientWidth && scale > TAB_FIT_MIN; pass += 1) {
    scale = Math.max(TAB_FIT_MIN, Math.floor(scale * (nav.clientWidth / nav.scrollWidth) * 100) / 100 - (pass > 0 ? 0.02 : 0));
    for (const tab of tabs) tab.style.fontSize = `${TAB_FONT_REM * scale}rem`;
  }
}

function selectNetwork(network) {
  if (!shell || state.network === network) return;
  state.network = network;
  shell.frame.className = `wallet net-${network}`;
  if (NETWORK_TABS.has(state.tab)) renderTab();
}

function selectTab(tab) {
  if (!shell) return;
  state.tab = tab;
  for (const [name, tabButton] of shell.tabButtons) tabButton.setAttribute('aria-selected', String(name === tab));
  // a tab bar wider than the popup (a long language) scrolls: the chosen tab is brought into view
  shell.tabButtons.get(tab)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  renderTab();
}

function renderTab() {
  state.activateIdle = false;
  const render = {
    assets: renderAssets,
    send: renderSend,
    receive: renderReceive,
    history: renderHistory,
    activate: renderActivate,
    settings: renderSettings,
  }[state.tab];
  Promise.resolve(render()).catch((error) => log.error('render failed', state.tab, error?.name));
}

// ---------------------------------------------------------------- assets

// The icon of an asset: its own image (QNC, SOL, 1DEV), or for a built-in QNet token the first character of its symbol.
function assetIcon(icon, className = 'token-icon') {
  if (icon.image) return el('img', { className, attrs: { src: `../icons/${icon.image}`, alt: '' } });
  return el('span', { className: `${className} token-letter`, text: [...icon.letter][0] ?? '?', attrs: { 'aria-hidden': 'true' } });
}
const imageIcon = (image) => ({ image, letter: null });

// An asset row: icon, name with a line under it (sub), the short contract id of a built-in token (contract), amount.
function tokenRow(icon, name, amountText, sub, { contract = null, reserved = false } = {}) {
  return el('div', { className: 'token-row' },
    assetIcon(typeof icon === 'string' ? imageIcon(icon) : icon),
    el('div', { className: 'token-info' },
      el('div', { className: `token-name${reserved ? ' token-reserved' : ''}`, text: name }),
      sub ? el('div', { className: 'muted small', text: sub }) : null,
      contract ? el('div', { className: 'token-contract mono small muted', text: contract, attrs: { dir: 'ltr' } }) : null),
    el('div', { className: 'token-amount', text: amountText }));
}

// A token named after QNet's own coin (M-5): flagged by the worker from its symbol and name as deployed, or by the
// symbol and name shown, so a list kept from an earlier read is marked too (a U+FFFD stands for a hidden or format
// character, which marks a token as the app does).
const reservedToken = (token) => token?.reserved === true || core.usesReservedName(token?.symbol ?? '', token?.name ?? '')
  || /\uFFFD/.test(`${token?.symbol ?? ''}${token?.name ?? ''}`);
const RESERVED_MARK = '⚠';
// A built-in QNet token's symbol, else its name, else the start and end of its contract.
const bareSymbol = (token) => token.symbol || token.name || shortAddress(token.contract, 4);
// A built-in QNet token as the wallet names it: bareSymbol, with the warning mark before a token named after QNet's own
// coin, as the app's rows (it is never drawn as if it were QNC).
const tokenSymbol = (token) => (reservedToken(token) ? `${RESERVED_MARK} ${bareSymbol(token)}` : bareSymbol(token));
const tokenIcon = (token) => ({ image: null, letter: (token.symbol || token.name || t('tokenUnnamed')).toUpperCase() });
// The short contract id every token row shows, as the app's (core.contractShortId): two tokens alike in name differ there.
const tokenContractId = (token) => core.contractShortId(token.contract);
// A token amount in its decimals with its symbol; a dash for a balance no two nodes agreed on.
const tokenAmount = (units, token) => (units === null || units === undefined ? `— ${tokenSymbol(token)}`
  : formatAmount(units, token.decimals, tokenSymbol(token)));

// The QNet tokens of the Assets card after QNC: each built-in token the wallet holds, its name under its symbol and its
// short contract id under that.
const qnetTokenRows = (tokens) => tokens.map((token) => tokenRow(tokenIcon(token), tokenSymbol(token),
  tokenAmount(token.balanceBase, token), token.name && token.name !== bareSymbol(token) ? token.name : null,
  { contract: tokenContractId(token), reserved: reservedToken(token) }));
// Whether the last token list read left out tokens the wallet holds (L-13): "Some tokens are not shown".
const tokensOmitted = () => seenOf('qnet', 'tokens')?.complete === false;

// The whole address, on one line at the card's width, is itself the copy control: a native button (Enter and Space
// press it), "Click to copy" on hover, "Copied" once copied. No separate Copy button.
function accountCard(network) {
  return el('div', { className: 'card account' },
    el('div', { className: 'card-label', text: t(network === 'qnet' ? 'qnetAddress' : 'solanaAddress') }),
    ownAddress(state.addresses[network], network));
}

function assetActions() {
  return actionsRow(
    button(t('tab_send'), () => selectTab('send'), { action: 'go-send' }),
    button(t('tab_receive'), () => selectTab('receive'), { action: 'go-receive' }));
}

// The token list of `network`: QNC; SOL and 1DEV.
function tokenRows(network, balances) {
  if (network === 'qnet') return [tokenRow('qnc-token.png', t('assetQnc'), formatAmount(balances.balanceNano, DECIMALS.QNC, 'QNC'), null)];
  return [
    tokenRow('sol-token.png', t('assetSol'), formatAmount(balances.lamports, DECIMALS.SOL, 'SOL'), null),
    tokenRow('1dev-token.png', t('asset1dev'), formatAmount(balances.oneDev.raw, DECIMALS.ONE_DEV, '1DEV'),
      balances.oneDev.exists ? null : t('assets1devNoAccount')),
  ];
}

const readBalances = (network) => readSeen(network, 'balances');

// The rows of the Assets card: the balances of `network`, and on QNet the built-in tokens after QNC.
const assetRows = (network, balances) => [...tokenRows(network, balances), ...(network === 'qnet' ? qnetTokenRows(seenTokens()) : [])];

/**
 * QNet: qnet.balance and qnet.tokens. Solana: solana.balances (SOL, 1DEV). The balances last read (this session's, or
 * the last verified ones kept across sessions) are drawn at once with a quiet "Updating…" and read again behind them;
 * while the tab is shown they read themselves again (keepFresh); after a failed first read, the first read that
 * succeeds draws the tab.
 * @returns {Promise<void>}
 */
async function renderAssets() {
  const { network } = state;
  const cached = seenOf(network, 'balances');
  if (cached !== null) {
    drawAssets(network, cached, true);
    readFresh({ queue: true });
    return;
  }
  const isCurrent = showTab(loadingBlock());
  let balances;
  try {
    balances = await readBalances(network);
  } catch (error) {
    if (!isCurrent()) return;
    const failed = showTab(failureBlock(error, renderAssets));
    keepFresh(async () => {
      const next = await readBalances(network);
      if (failed()) drawAssets(network, next, false);
    });
    return;
  }
  if (isCurrent()) drawAssets(network, balances, false);
}

// The quiet line under the balances: "Updating…" while the first read behind balances drawn from the cache runs, a
// warning when that read failed (the balances shown are the last ones read) or when no committee certificate verified the
// QNet balance yet (verification 'none': never drawn as if verified), else nothing.
function assetStatus(node, text, kind = 'muted') {
  node.className = `small asset-status ${kind === 'warn' ? 'hint-warn' : 'muted'}`;
  node.textContent = text;
}

/**
 * The Assets tab of `network`; each read of its balances (and on QNet of its tokens) redraws the card only when what it
 * shows changed.
 * @param {'qnet'|'solana'} network
 * @param {object} balances
 * @param {boolean} fromCache the balances were drawn from the cache: "Updating…" until the first read behind them ends
 */
function drawAssets(network, balances, fromCache) {
  const tokens = el('div', { className: 'card' }, ...assetRows(network, balances));
  let shown = balances;
  const status = el('p', { className: 'small asset-status muted' });
  // under the card while the token list leaves tokens out (L-13)
  const omitted = el('p', { className: 'small muted tokens-omitted' });
  const showOmitted = () => {
    const text = network === 'qnet' && tokensOmitted() ? t('tokensNotAllShown') : '';
    if (omitted.textContent !== text) omitted.textContent = text;
    omitted.classList.toggle('hidden', text === '');
  };
  showOmitted();
  const unverified = (read) => network === 'qnet' && read?.verification === 'none';
  if (fromCache) assetStatus(status, t('assetsUpdating'));
  else if (unverified(balances)) assetStatus(status, t('assetsUnverified'), 'warn');
  let first = fromCache;
  const isCurrent = showTab(el('div', { className: 'stack' },
    accountCard(network),
    tokens,
    omitted,
    status,
    network === 'solana' ? el('p', { className: 'muted small', text: t('solanaCluster', [SOLANA.CLUSTER]) }) : null,
    assetActions()));
  const redraw = () => {
    const next = el('div', { className: 'card' }, ...assetRows(network, shown));
    if (next.textContent !== tokens.textContent) tokens.replaceChildren(...next.childNodes);
    showOmitted();
  };
  // the balance is drawn as soon as it is read, and the token list when it is: a slow token read (a silent node) never
  // holds the balance back
  keepFresh(async () => {
    const balanceDone = readBalances(network).then((read) => {
      if (!isCurrent()) return;
      shown = read;
      redraw();
      if (unverified(shown)) assetStatus(status, t('assetsUnverified'), 'warn');
      else assetStatus(status, '');
      first = false;
    }, (error) => {
      if (isCurrent() && first) assetStatus(status, t('assetsStale'), 'warn');
      first = false;
      throw error;
    });
    const tokensDone = network !== 'qnet' ? null : readSeen('qnet', 'tokens').then(() => {
      if (isCurrent()) redraw();
    }, (error) => log.warn('tokens not read', error?.code));
    const [balanceRead] = await Promise.allSettled([balanceDone, tokensDone]);
    if (balanceRead.status === 'rejected') throw balanceRead.reason;
  });
  // balances read just now (no cache): the token list is read at once too, not at the next refresh
  if (!fromCache && network === 'qnet') {
    readSeen('qnet', 'tokens').then(() => {
      if (isCurrent()) redraw();
    }, (error) => log.warn('tokens not read', error?.code));
  }
}

// ---------------------------------------------------------------- send

/**
 * QNet: to + amount → qnet.preview → review (full address, amount, fee, total, nonce) →
 * qnet.send with expectedFeeNano and expectedNonce; it takes QNet addresses only. Solana: token + to (an address or a
 * payment request) + amount (Max: solana.max) → solana.quote → review with the address-poisoning warnings and any
 * shortfall → solana.send with expectedFeeLamports and expectedRentLamports → pending until solana.status settles it.
 * @returns {Promise<void>}
 */
async function renderSend() {
  if (state.network === 'qnet') renderQnetForm();
  else renderSolanaForm();
}

// The worker's recipient check (qnet.recipientCheck / solana.recipientCheck, from the addresses this wallet
// signed transfers to, never from incoming senders: ES-01, R3-EXT-UI-03); without one, the wallet's own
// address only.
function recipientNotices(to, own, check) {
  const isOwn = to === own;
  const lookalike = !isOwn && (check ? check.lookalike === true : looksLikeKnownAddress(to, [own]));
  const incomingOnly = !isOwn && check?.incomingOnly === true;
  const firstTime = !isOwn && !lookalike && check?.known === false;
  return [
    isOwn ? notice('warn', t('reviewOwnAddress')) : null,
    lookalike ? notice('danger', t('reviewLookalike')) : null,
    incomingOnly ? notice('danger', t('reviewIncomingOnly')) : null,
    firstTime ? notice('warn', t('reviewFirstTime')) : null,
  ];
}

// The asset value of QNC in the QNet send's token picker; a built-in token's is its contract address.
const QNC_ASSET = 'QNC';

/**
 * The QNet send form (owner, 06.10: any token of the QNet network): the asset (QNC, or a built-in token the wallet holds,
 * qnet.tokens), the recipient, the amount in the asset's decimals, and what is available of it (QNC: what this wallet's
 * unconfirmed sends leave; a token: its balance two nodes agree on), read again while the form is shown. Review: QNC
 * qnet.preview, a token qnet.tokenPreview (a dApp's token transfer's path and checks).
 * @param {{asset?: string, to?: string, amount?: string, token?: object}} [prefill] token: the token `asset` names, for a
 *   form drawn again before the list is read
 * @returns {void}
 */
function renderQnetForm(prefill = {}) {
  let asset = prefill.asset ?? QNC_ASSET;
  // the tokens the picker lists: the last list read, and the one the form was filled with when that list lacks it
  let tokens = seenTokens();
  const to = textInput({ name: 'to', placeholder: t('sendQnetToPlaceholder'), maxLength: 64, ltr: true });
  const amount = textInput({ name: 'amount', placeholder: '0.0', inputMode: 'decimal', maxLength: 40, ltr: true });
  to.value = prefill.to ?? '';
  amount.value = prefill.amount ?? '';
  const picker = el('select', { className: 'input select', attrs: { name: 'asset' } });
  const amountField = field(t('sendAmount', ['QNC']), amount);
  const amountLabel = amountField.querySelector('label');
  const available = el('div', { className: 'hint' });
  // under the picker while the token list leaves tokens out (L-13)
  const omitted = el('p', { className: 'small muted tokens-omitted hidden' });
  const message = messageLine();
  const next = button(t('sendReview'), null, { kind: 'primary', action: 'review', block: true });
  let qncSpendable = null;
  const tokenOf = (value) => tokens.find((token) => token.contract === value) ?? (prefill.token?.contract === value ? prefill.token : null);
  const listed = () => {
    const list = [...tokens];
    if (prefill.token && !list.some((token) => token.contract === prefill.token.contract)) list.push(prefill.token);
    return list;
  };
  const showAsset = () => {
    const token = asset === QNC_ASSET ? null : tokenOf(asset);
    amountLabel.textContent = t('sendAmount', [token === null ? 'QNC' : tokenSymbol(token)]);
    if (token !== null) available.textContent = t('sendAvailable', [tokenAmount(token.balanceBase, token)]);
    else available.textContent = qncSpendable === null ? '' : t('sendAvailable', [formatAmount(qncSpendable, DECIMALS.QNC, 'QNC')]);
  };
  // the options are drawn again only when the list changed, so an open picker is not closed by a refresh
  let options = null;
  const drawPicker = () => {
    const list = listed();
    if (asset !== QNC_ASSET && !list.some((token) => token.contract === asset)) asset = QNC_ASSET;
    // a token's option names its short contract id too (M-5): no token reads as plain "QNC" beside QNC itself
    const key = JSON.stringify(list.map((token) => [token.contract, tokenSymbol(token)]));
    if (key !== options) {
      options = key;
      picker.replaceChildren(el('option', { text: 'QNC', attrs: { value: QNC_ASSET } }),
        ...list.map((token) => el('option', {
          text: `${tokenSymbol(token)} · ${tokenContractId(token)}`, attrs: { value: token.contract, dir: 'auto' },
        })));
      picker.value = asset;
    }
    const text = tokensOmitted() ? t('tokensNotAllShown') : '';
    if (omitted.textContent !== text) omitted.textContent = text;
    omitted.classList.toggle('hidden', text === '');
    showAsset();
  };
  picker.addEventListener('change', () => {
    asset = picker.value === QNC_ASSET || tokenOf(picker.value) !== null ? picker.value : QNC_ASSET;
    message.clear();
    showAsset();
  });
  const isCurrent = showTab(el('div', { className: 'stack' },
    heading(t('sendQnetTitle')),
    field(t('sendAsset'), picker),
    omitted,
    recipientField(to),
    amountField,
    available,
    message.node,
    next));
  drawPicker();
  const review = async () => {
    message.clear();
    const recipient = to.value.trim();
    const token = asset === QNC_ASSET ? null : tokenOf(asset);
    const decimals = token === null ? DECIMALS.QNC : token.decimals;
    const value = canonicalAmount(amount.value, decimals);
    if (!validAddress(core.isValidQnetAddress, recipient)) {
      message.show(t('sendInvalidQnetAddress'));
      return;
    }
    if (value === null) {
      message.show(t('sendInvalidAmount', [decimals]));
      return;
    }
    if (token !== null) {
      let preview;
      try {
        preview = await whileBusy([next, picker], () => call('qnet.tokenPreview', { token: token.contract, to: recipient, amount: value }));
      } catch (error) {
        if (isCurrent()) message.show(errorText(error));
        return;
      }
      if (isCurrent()) renderTokenReview({ token, to: recipient, amount: value }, preview);
      return;
    }
    let preview;
    try {
      preview = await whileBusy([next, picker], () => call('qnet.preview', { to: recipient, amount: value }));
    } catch (error) {
      if (isCurrent()) message.show(errorText(error));
      return;
    }
    if (isCurrent()) renderQnetReview({ to: recipient, amount: value }, preview);
  };
  next.addEventListener('click', review);
  onEnter(amount, review);
  // QNC: what this wallet's unconfirmed sends leave, not the whole balance (R2-EXTQ-03); the tokens and their balances;
  // both read again while the form is shown
  // each drawn as soon as it is read: a slow token read never holds back what is available of QNC
  keepFresh(async () => {
    const [balance] = await Promise.allSettled([
      call('qnet.balance').then((read) => {
        if (!isCurrent()) return;
        qncSpendable = read.spendableNano ?? read.balanceNano;
        drawPicker();
      }),
      readSeen('qnet', 'tokens').then(() => {
        if (!isCurrent()) return;
        tokens = seenTokens();
        drawPicker();
      }, (error) => log.warn('tokens not read', error?.code)),
    ]);
    if (balance.status === 'rejected') throw balance.reason;
  });
  readFresh();
}

// An outstanding transaction as the replace buttons and the review name it, so the user sees which one is cancelled
// (R3-EXTQ-03): a transfer by nonce, amount and recipient; a contract call (a dApp's) by nonce and contract.
const transferNamed = (p) => (p.kind === 'call' ? { call: true, subs: [p.nonce, shortAddress(p.to, 6)] }
  : { call: false, subs: [p.nonce, formatAmount(p.amountNano, DECIMALS.QNC, 'QNC'), shortAddress(p.to, 6)] });
const CALL_NAMED = Object.freeze({
  reviewReplace: 'reviewReplaceCall',
  reviewReplaces: 'reviewReplacesCall',
  reviewReplacesRefused: 'reviewReplacesRefusedCall',
  reviewReplaceDecided: 'reviewReplaceDecidedCall',
});
// The text of `key` naming an outstanding transaction (transferNamed), in its call form for a call; with only the
// nonce known, the transfer form with the nonce alone.
const namedText = (key, named) => t(named.call ? CALL_NAMED[key] : key, named.subs);

// The earlier sends not seen applied: this one goes in addition to them, unless it replaces one (signed at
// its nonce, so only one of the two can apply). A same-amount send to the same address, unconfirmed or signed
// by this wallet in the last 30 minutes (the vault's own records, R3-EXTQ-01) or in the archive, is named
// first.
function outstandingNotices(input, preview) {
  const outstanding = Array.isArray(preview.outstanding) ? preview.outstanding : [];
  if (preview.replacesNonce !== null && preview.replacesNonce !== undefined) {
    const replaced = outstanding.find((p) => p.nonce === preview.replacesNonce);
    // a transfer a node refused is replaced by default: it may still apply, and at most one of the two can (R5-EXTQ-02)
    if (replaced?.refused === true) return [notice('warn', namedText('reviewReplacesRefused', transferNamed(replaced)))];
    return [notice('warn', namedText('reviewReplaces', replaced ? transferNamed(replaced) : { call: false, subs: [preview.replacesNonce] }))];
  }
  const same = outstanding.filter((p) => p.kind !== 'call' && p.to === preview.to && p.amountNano === preview.amountNano);
  const duplicate = preview.duplicate === true || same.length > 0 || preview.recipient?.recentSame === true;
  const replaceable = same.length > 0 ? same : outstanding;
  return [
    duplicate ? notice('danger', t('reviewDuplicate')) : null,
    outstanding.length > 0 ? notice('warn', t('reviewOutstanding', [outstanding.length])) : null,
    ...replaceable.map((p) => button(namedText('reviewReplace', transferNamed(p)),
      () => refreshQnetReview({ ...input, replaceNonce: p.nonce, replacing: transferNamed(p) }, null), { action: 'replace-pending' })),
  ];
}

// A replace whose target the chain decided before it could be signed (NONCE_CHANGED): nothing was signed, and
// the same recipient and amount now would be an additional payment, so no review is drawn for it; the user
// starts a new send on purpose (R3-EXTQ-03, as mobile MOBNET-R1-01).
function renderReplaceDecided(input) {
  showTab(el('div', { className: 'stack' },
    heading(t('reviewTitle')),
    notice('danger', namedText('reviewReplaceDecided', input.replacing ?? { call: false, subs: [input.replaceNonce] })),
    actionsRow(
      button(t('historyTitle'), () => selectTab('history'), { action: 'history' }),
      button(t('back'), () => renderQnetForm(), { kind: 'primary', action: 'back' }))));
}

function renderQnetReview(input, preview, note = null) {
  const message = messageLine();
  const back = button(t('back'), () => renderQnetForm({ to: input.to, amount: input.amount }), { action: 'back' });
  const send = button(t('sendConfirm'), null, { kind: 'primary', action: 'confirm-send' });
  let short = false;
  try {
    short = BigInt(preview.balanceNano) < BigInt(preview.totalNano);
  } catch {
    short = false;
  }
  const isCurrent = showTab(el('div', { className: 'stack' },
    heading(t('reviewTitle')),
    note ? notice('warn', note) : null,
    kvList([
      [t('reviewFrom'), ownAddress(preview.from, 'qnet')],
      [t('reviewTo'), addressText(preview.to)],
      [t('reviewAmount'), formatAmount(preview.amountNano, DECIMALS.QNC, 'QNC')],
      [t('reviewFee'), formatAmount(preview.feeNano, DECIMALS.QNC, 'QNC')],
      [t('reviewTotal'), formatAmount(preview.totalNano, DECIMALS.QNC, 'QNC')],
      [t('reviewNonce'), String(preview.nonce)],
      [t('reviewNetwork'), t('qnetNetwork', [QNET.NETWORK, QNET.CHAIN_ID])],
    ]),
    short ? notice('danger', t('err_INSUFFICIENT_FUNDS')) : null,
    ...outstandingNotices(input, preview),
    ...recipientNotices(preview.to, state.addresses.qnet, preview.recipient ?? null),
    message.node,
    actionsRow(back, send)));
  send.addEventListener('click', async () => {
    message.clear();
    let result;
    try {
      result = await whileBusy([send, back], () => call('qnet.send', {
        to: input.to, amount: input.amount, expectedFeeNano: preview.feeNano, expectedNonce: preview.nonce,
        ...(input.replaceNonce ? { replaceNonce: input.replaceNonce } : {}),
      }));
    } catch (error) {
      if (!isCurrent()) return;
      const code = errorCode(error);
      if (code === 'NONCE_CHANGED' && input.replaceNonce) {
        // the transfer it was to replace went through or was replaced meanwhile: never an additional send
        renderReplaceDecided(input);
      } else if (code === 'FEE_CHANGED' || code === 'NONCE_CHANGED') {
        refreshQnetReview(input, errorText(error));
      } else {
        message.show(errorText(error));
      }
      return;
    }
    if (isCurrent()) renderQnetSent(result);
  });
}

async function refreshQnetReview(input, note) {
  const isCurrent = showTab(loadingBlock());
  try {
    const preview = await call('qnet.preview', {
      to: input.to, amount: input.amount, ...(input.replaceNonce ? { replaceNonce: input.replaceNonce } : {}),
    });
    if (isCurrent()) renderQnetReview(input, preview, note);
  } catch (error) {
    if (!isCurrent()) return;
    if (errorCode(error) === 'NONCE_CHANGED' && input.replaceNonce) renderReplaceDecided(input);
    else showTab(failureBlock(error, () => renderQnetForm({ to: input.to, amount: input.amount })));
  }
}

const qncText = (nano) => formatAmount(nano, DECIMALS.QNC, 'QNC');
// A token as its review names it: name and symbol, whichever can be shown.
function tokenTitle(token) {
  if (token.name && token.symbol) return t('apTokenNamed', [token.name, token.symbol]);
  return token.name || token.symbol || '—';
}

/**
 * The review of a built-in token transfer (owner, 06.10), what the approval window shows for a dApp's: from, to, the
 * token as two nodes name it and its contract, the amount in its units, the network fee in QNC (the most the gas limit can
 * cost), the refundable storage deposit for a new holder, the QNC total, the token balance, the nonce; a token named
 * after QNC, a burn address, a same transfer not confirmed yet, the transaction it takes the place of, and the recipient
 * warnings. Send stays off while a balance does not cover it or the token balance could not be had (the review says
 * why: no node answered, or it is not confirmed yet); it arms after TIMINGS.CONFIRM_ARM_VALUE_MS. A changed fee or nonce
 * reviews again.
 * @param {{token: object, to: string, amount: string}} input
 * @param {object} preview qnet.tokenPreview
 * @param {string|null} [note]
 * @returns {void}
 */
function renderTokenReview(input, preview, note = null) {
  const named = { contract: preview.token, name: preview.name, symbol: preview.symbol, decimals: preview.decimals };
  const message = messageLine();
  const back = button(t('back'), () => renderQnetForm({ asset: input.token.contract, to: input.to, amount: input.amount, token: input.token }),
    { action: 'back' });
  const send = button(t('sendConfirm'), null, { kind: 'primary', action: 'confirm-send' });
  let qncShort = false;
  let tokenShort = false;
  const tokenRead = typeof preview.tokenBalance === 'string';
  try {
    qncShort = BigInt(preview.balanceNano) < BigInt(preview.totalNano);
    tokenShort = tokenRead && BigInt(preview.tokenBalance) < BigInt(preview.amountBase);
  } catch {
    qncShort = true;
  }
  const outstanding = Array.isArray(preview.outstanding) ? preview.outstanding : [];
  const replaced = preview.replacesNonce ? outstanding.find((p) => p.nonce === preview.replacesNonce) ?? null : null;
  const rows = [
    [t('reviewFrom'), ownAddress(state.addresses.qnet, 'qnet')],
    [t('reviewTo'), addressText(preview.to)],
    [t('apToken'), tokenTitle(named)],
    [t('apTokenContract'), addressText(preview.token)],
    [t('reviewAmount'), tokenAmount(preview.amountBase, named)],
    [t('reviewFee'), qncText(preview.feeNano)],
  ];
  if (preview.depositNano !== '0') rows.push([t('apDeposit'), qncText(preview.depositNano)]);
  rows.push([t('apQncTotal'), qncText(preview.totalNano)], [t('apTokenBalance'), tokenRead ? tokenAmount(preview.tokenBalance, named) : '—'],
    [t('reviewNonce'), String(preview.nonce)], [t('reviewNetwork'), t('qnetNetwork', [QNET.NETWORK, QNET.CHAIN_ID])]);
  const isCurrent = showTab(el('div', { className: 'stack' },
    heading(t('reviewTitle')),
    note ? notice('warn', note) : null,
    kvList(rows),
    preview.reserved ? notice('danger', t('apTokenReserved')) : null,
    preview.burn ? notice('danger', t('apTokenBurn')) : null,
    preview.duplicate === true ? notice('danger', t('reviewDuplicate')) : null,
    preview.replacesNonce ? notice('warn', namedText(replaced?.refused === true ? 'reviewReplacesRefused' : 'reviewReplaces',
      replaced ? transferNamed(replaced) : { call: false, subs: [preview.replacesNonce] })) : null,
    !preview.replacesNonce && outstanding.length > 0 ? notice('warn', t('reviewOutstanding', [outstanding.length])) : null,
    // why the token balance a send is decided by could not be had: no node answered, or it is not confirmed yet
    tokenRead ? null : notice('warn', ['NETWORK', 'BALANCE_UNCONFIRMED'].includes(preview.tokenProblem)
      ? codeText(preview.tokenProblem) : t('apTokenBalanceUnread')),
    tokenShort ? notice('danger', t('apTokenShort')) : null,
    qncShort ? notice('danger', t('err_INSUFFICIENT_FUNDS')) : null,
    ...recipientNotices(preview.to, state.addresses.qnet, preview.recipient ?? null),
    message.node,
    actionsRow(back, send)));
  if (qncShort || tokenShort || !tokenRead) send.disabled = true;
  else armConfirm(send);
  send.addEventListener('click', async () => {
    if (send.disabled) return;
    message.clear();
    let result;
    try {
      result = await whileBusy([send, back], () => call('qnet.tokenSend', {
        token: preview.token, to: preview.to, amount: input.amount, expectedFeeNano: preview.feeNano,
        expectedDepositNano: preview.depositNano, expectedNonce: preview.nonce,
      }));
    } catch (error) {
      if (!isCurrent()) return;
      const code = errorCode(error);
      if (code === 'FEE_CHANGED' || code === 'NONCE_CHANGED') refreshTokenReview(input, errorText(error));
      else message.show(errorText(error));
      return;
    }
    if (isCurrent()) renderQnetSent(result);
  });
}

async function refreshTokenReview(input, note) {
  const isCurrent = showTab(loadingBlock());
  try {
    const preview = await call('qnet.tokenPreview', { token: input.token.contract, to: input.to, amount: input.amount });
    if (isCurrent()) renderTokenReview(input, preview, note);
  } catch (error) {
    if (isCurrent()) {
      showTab(failureBlock(error, () => renderQnetForm({ asset: input.token.contract, to: input.to, amount: input.amount, token: input.token })));
    }
  }
}

// The hash a node returned is not shown or linked: every node that took the signed body stamps its own
// copy, and the one that lands may have another hash (R2-EXTQ-06). The transfer is known by its nonce, and
// History shows the applied one with its real hash.
function renderQnetSent(result) {
  const submitted = result.status === 'submitted';
  showTab(el('div', { className: 'stack' },
    heading(t(submitted ? 'sentTitle' : 'sentUnknownTitle')),
    kvList([[t('reviewNonce'), String(result.nonce)]]),
    actionsRow(button(t('done'), () => selectTab('history'), { kind: 'primary', action: 'done' }))));
}

// The tokens of the Solana send: SOL and the SPL tokens this wallet lists (a payment request names a token by its mint).
const SOLANA_ASSETS = Object.freeze([
  Object.freeze({ asset: 'sol', symbol: 'SOL', decimals: DECIMALS.SOL, mint: null }),
  Object.freeze({ asset: '1dev', symbol: '1DEV', decimals: DECIMALS.ONE_DEV, mint: SOLANA.ONE_DEV_MINT }),
]);
const solanaAsset = (asset) => SOLANA_ASSETS.find((entry) => entry.asset === asset) ?? SOLANA_ASSETS[0];
// A recipient text the Solana send refuses, by kit.parseSolanaRecipient's reason.
const REQUEST_REFUSED = Object.freeze({ invalid: 'sendRequestInvalid', token: 'sendRequestInvalid', amount: 'sendRequestAmount' });
const PAYMENT_REQUEST_RE = /^\s*solana:/i;
const SOLANA_RECIPIENT_MAX_CHARS = 2048;
// A submitted Solana send's status is read this often while its screen is shown, at most this many times (its
// blockhash expires within about two minutes, which ends the wait as 'expired').
const SOLANA_STATUS_POLL_MS = 2000;
const SOLANA_STATUS_POLLS_MAX = 150;

// A payment request's parts a Solana send carries, as solana.quote and solana.send take them: none, no key at all.
function requestParams(request) {
  const params = {};
  if (request !== null && request.references.length > 0) params.references = [...request.references];
  if (request !== null && request.memo !== null) params.memo = request.memo;
  return params;
}

// solana.quote, taken only when it carries exactly the references and memo asked for: the review shows the quote's,
// and solana.send plans again from the same input.
async function solanaQuote(input) {
  const quote = await call('solana.quote', input);
  const asked = input.references ?? [];
  const carried = Array.isArray(quote?.references) ? quote.references : null;
  if (carried === null || carried.length !== asked.length || carried.some((reference, i) => reference !== asked[i])
    || quote.memo !== (input.memo ?? null)) throw new UiError('INTERNAL');
  return quote;
}

// A payment request's rows: its label and message, then the memo the transfer carries (all plain text, never a link) and
// how many reference keys it carries, those two from `carried` (the request on the form; on the review the quote, what
// is signed).
function requestRows(request, carried) {
  const rows = [];
  if (request?.label) rows.push([t('sendRequestLabel'), el('span', { text: request.label })]);
  if (request?.message) rows.push([t('sendRequestMessage'), el('span', { text: request.message })]);
  if (carried.memo) rows.push([t('sendRequestMemo'), el('span', { text: carried.memo })]);
  if (carried.references.length > 0) rows.push([t('sendRequestReferences'), String(carried.references.length)]);
  return rows;
}

// A confirm that moves value arms TIMINGS.CONFIRM_ARM_VALUE_MS after its screen is drawn, as the approval window's
// does: a double click on the button before it (Review) never lands on it.
function armConfirm(control) {
  control.disabled = true;
  const timer = setTimeout(() => {
    control.disabled = false;
  }, TIMINGS.CONFIRM_ARM_VALUE_MS);
  onDispose(() => clearTimeout(timer));
}

/**
 * The Solana send form: the token (SOL or a listed SPL token), the recipient (a Solana address, or a payment request
 * pasted or typed in: it fills the recipient, switches to its token when the wallet lists that mint and fills the
 * amount; its label, message and memo are shown as plain text and the number of its references is named, and the
 * transfer carries its references and memo while the recipient is its address; anything else is refused), the amount
 * with Max (solana.max) and what is available (solana.balances, read again while shown). Review quotes it
 * (solana.quote).
 * @param {{asset?: string, to?: string, amount?: string, request?: {address: string, label: string|null,
 *   message: string|null, references: string[], memo: string|null}|null}} [prefill]
 * @returns {void}
 */
function renderSolanaForm(prefill = {}) {
  let asset = solanaAsset(prefill.asset).asset;
  // the payment request that filled the form, while the recipient is still its address
  let request = prefill.request ?? null;
  let balances = null;
  const to = textInput({ name: 'to', placeholder: t('sendSolanaToPlaceholder'), maxLength: SOLANA_RECIPIENT_MAX_CHARS, ltr: true });
  const amount = textInput({ name: 'amount', placeholder: '0.0', inputMode: 'decimal', maxLength: 40, ltr: true });
  to.value = prefill.to ?? '';
  amount.value = prefill.amount ?? '';
  const max = button(t('sendMax'), null, { kind: 'ghost', action: 'max' });
  const amountField = field(t('sendAmount', [solanaAsset(asset).symbol]), amount, null, max);
  const amountLabel = amountField.querySelector('label');
  const available = el('div', { className: 'hint' });
  const requestBox = el('div');
  const message = messageLine();
  const next = button(t('sendReview'), null, { kind: 'primary', action: 'review', block: true });
  const showAvailable = () => {
    if (balances === null) return;
    const { decimals, symbol } = solanaAsset(asset);
    available.textContent = t('sendAvailable', [formatAmount(asset === 'sol' ? balances.lamports : balances.oneDev.raw, decimals, symbol)]);
  };
  const assetSwitch = segmented(SOLANA_ASSETS.map((entry) => [entry.asset, entry.symbol]), asset, (value) => {
    asset = value;
    amountLabel.textContent = t('sendAmount', [solanaAsset(asset).symbol]);
    showAvailable();
  }, t('sendAsset'));
  const drawRequest = () => {
    clear(requestBox);
    const rows = request === null ? [] : requestRows(request, request);
    if (rows.length === 0) return;
    requestBox.append(el('div', { className: 'card' }, el('div', { className: 'card-label', text: t('sendRequestTitle') }), kvList(rows)));
  };
  const isCurrent = showTab(el('div', { className: 'stack' },
    heading(t('sendSolanaTitle'), t('solanaCluster', [SOLANA.CLUSTER])),
    field(t('sendAsset'), assetSwitch),
    recipientField(to, t('sendSolanaToHint')),
    requestBox,
    amountField,
    available,
    message.node,
    next));
  drawRequest();

  // A payment request fills the form, and the user still reviews and confirms; a refused text fills nothing.
  const applyRecipient = (text) => {
    const parsed = parseSolanaRecipient(text, core.isValidSolanaAddress);
    const refuse = (key) => {
      to.value = '';
      request = null;
      drawRequest();
      message.show(t(key));
    };
    if (!parsed.ok) {
      refuse(REQUEST_REFUSED[parsed.reason] ?? 'sendRequestInvalid');
      return;
    }
    const token = parsed.mint === null ? SOLANA_ASSETS[0] : SOLANA_ASSETS.find((entry) => entry.mint === parsed.mint);
    if (!token) {
      refuse('sendRequestUnlisted');
      return;
    }
    // trailing zeros are no decimal places the token lacks ("1.50" of a 1-decimal token is 1.5), as in the app
    const value = parsed.amount === null ? null
      : canonicalAmount(parsed.amount.replace(/(\.[0-9]*?)0+$/, '$1').replace(/\.$/, ''), token.decimals);
    if (parsed.amount !== null && value === null) {
      refuse('sendRequestAmount');
      return;
    }
    to.value = parsed.address;
    if (token.asset !== asset) assetSwitch.querySelector(`[data-value="${token.asset}"]`)?.click();
    if (value !== null) amount.value = value;
    request = parsed.request ? {
      address: parsed.address, label: parsed.label, message: parsed.message, references: parsed.references, memo: parsed.memo,
    } : null;
    drawRequest();
    if (parsed.request) message.show(t('sendRequestFilled'), 'info');
    else message.clear();
  };
  to.addEventListener('paste', (event) => {
    const pasted = event.clipboardData?.getData('text');
    if (typeof pasted !== 'string' || !PAYMENT_REQUEST_RE.test(pasted)) return;
    event.preventDefault();
    applyRecipient(pasted);
  });
  to.addEventListener('input', () => {
    if (request !== null && to.value.trim() !== request.address) {
      request = null;
      drawRequest();
    }
  });

  max.addEventListener('click', async () => {
    message.clear();
    const typed = to.value.trim();
    const params = validAddress(core.isValidSolanaAddress, typed) ? { asset, to: typed } : { asset };
    try {
      const result = await whileBusy([max, next], () => call('solana.max', params));
      if (isCurrent() && params.asset === asset) amount.value = result.amount;
    } catch (error) {
      if (isCurrent()) message.show(errorText(error));
    }
  });

  const review = async () => {
    message.clear();
    const recipient = to.value.trim();
    // a payment request typed or dropped in rather than pasted fills the form first
    if (PAYMENT_REQUEST_RE.test(recipient)) {
      applyRecipient(recipient);
      return;
    }
    const { decimals } = solanaAsset(asset);
    const value = canonicalAmount(amount.value, decimals);
    if (!validAddress(core.isValidSolanaAddress, recipient)) {
      message.show(t('sendInvalidSolanaAddress'));
      return;
    }
    if (value === null) {
      message.show(t('sendInvalidAmount', [decimals]));
      return;
    }
    const shownRequest = request !== null && request.address === recipient ? request : null;
    const input = { asset, to: recipient, amount: value, ...requestParams(shownRequest) };
    let quote;
    try {
      quote = await whileBusy([next, max], () => solanaQuote(input));
    } catch (error) {
      if (isCurrent()) message.show(errorText(error));
      return;
    }
    if (isCurrent()) renderSolanaReview(input, quote, { request: shownRequest });
  };
  next.addEventListener('click', review);
  onEnter(amount, review);
  keepFresh(async () => {
    const read = await call('solana.balances');
    if (!isCurrent()) return;
    balances = read;
    showAvailable();
  });
  readFresh();
}

// Why a quoted Solana send cannot go, in words with its numbers (SolanaQuote.shortfall), or null.
function solanaShortfall(quote, token, decimals) {
  const sol = (raw) => formatAmount(raw, DECIMALS.SOL, 'SOL');
  switch (quote.shortfall) {
    case 'INSUFFICIENT_SOL':
      return t('sendShortSol', [sol(quote.totalLamports), sol(quote.balanceLamports)]);
    case 'INSUFFICIENT_TOKENS':
      return t('sendShortTokens', [formatAmount(quote.tokenRaw ?? '0', decimals, token.symbol)]);
    case 'AMOUNT_BELOW_RENT':
      return t('sendBelowRent', [sol(quote.rentFloorLamports)]);
    case 'SOL_BELOW_RENT':
      return t(token.mint === null ? 'sendKeepRentSol' : 'sendKeepRentToken', [sol(quote.rentFloorLamports)]);
    default:
      return null;
  }
}

/**
 * The Solana review: from, to, the token and its mint, the amount, the network fee, the rent of the recipient's token
 * account when the send creates it (the wallet pays it), the SOL spent in all, the cluster, a payment request's label
 * and message and the memo the transaction carries as plain text, how many reference keys it carries, the recipient
 * warnings, and why it cannot go when the quote says so (Send stays off).
 * Send arms after TIMINGS.CONFIRM_ARM_VALUE_MS; no password: the unlocked session confirms. A changed fee or an expired
 * blockhash quotes again.
 * @param {{asset: string, to: string, amount: string, references?: string[], memo?: string}} input
 * @param {object} quote SolanaQuote
 * @param {{note?: string|null, request?: object|null}} [options]
 * @returns {void}
 */
function renderSolanaReview(input, quote, { note = null, request = null } = {}) {
  const token = solanaAsset(input.asset);
  const decimals = Number.isSafeInteger(quote.decimals) ? quote.decimals : token.decimals;
  const sol = (raw) => formatAmount(raw, DECIMALS.SOL, 'SOL');
  const message = messageLine();
  const back = button(t('back'), () => renderSolanaForm({ ...input, request }), { action: 'back' });
  const send = button(t('sendConfirm'), null, { kind: 'primary', action: 'confirm-send' });
  const rows = [
    [t('reviewFrom'), ownAddress(state.addresses.solana, 'solana')],
    [t('reviewTo'), addressText(quote.to)],
    [t('reviewToken'), token.symbol],
  ];
  if (token.mint !== null) rows.push([t('reviewMint'), addressText(token.mint)]);
  rows.push([t('reviewAmount'), formatAmount(quote.amountRaw, decimals, token.symbol)], [t('reviewFee'), sol(quote.feeLamports)]);
  if (quote.createsRecipientAccount) rows.push([t('reviewRent', [token.symbol]), sol(quote.rentLamports)]);
  rows.push([t('reviewTotalSol'), sol(quote.totalLamports)], [t('reviewNetwork'), t('solanaCluster', [SOLANA.CLUSTER])]);
  rows.push(...requestRows(request, quote));
  const shortfall = solanaShortfall(quote, token, decimals);
  const isCurrent = showTab(el('div', { className: 'stack' },
    heading(t('reviewTitle')),
    note ? notice('warn', note) : null,
    kvList(rows),
    shortfall ? notice('danger', shortfall) : null,
    // the vault's record of the Solana addresses this wallet paid: first-time and look-alike (R3-EXT-UI-03)
    ...recipientNotices(quote.to, state.addresses.solana, quote.recipient ?? null),
    message.node,
    actionsRow(back, send)));
  if (shortfall) send.disabled = true;
  else armConfirm(send);
  send.addEventListener('click', async () => {
    if (send.disabled) return;
    message.clear();
    let result;
    try {
      result = await whileBusy([send, back], () => call('solana.send', {
        ...input, expectedFeeLamports: quote.feeLamports, expectedRentLamports: quote.rentLamports,
      }));
    } catch (error) {
      if (!isCurrent()) return;
      const code = errorCode(error);
      if (code === 'FEE_CHANGED' || code === 'BLOCKHASH_EXPIRED') refreshSolanaReview(input, errorText(error), request);
      else message.show(errorText(error));
      return;
    }
    if (isCurrent()) renderSolanaSent(input, result, request);
  });
}

async function refreshSolanaReview(input, note, request) {
  const isCurrent = showTab(loadingBlock());
  try {
    const quote = await solanaQuote(input);
    if (isCurrent()) renderSolanaReview(input, quote, { note, request });
  } catch (error) {
    if (isCurrent()) showTab(failureBlock(error, () => renderSolanaForm({ ...input, request })));
  }
}

// A sent Solana transaction as its screen names it: [title, notice kind, lead].
const SOLANA_SENT = Object.freeze({
  pending: ['sentUnknownTitle', null, 'sentPendingLead'],
  confirmed: ['sentConfirmedTitle', null, null],
  failed: ['sentFailedTitle', 'danger', 'sentFailedLead'],
  expired: ['sentExpiredTitle', 'warn', 'sentExpiredLead'],
});

/**
 * After solana.send: the signature and where the transaction stands. A submitted one is pending, and its status is
 * read every SOLANA_STATUS_POLL_MS while the screen is shown (solana.status) until it is confirmed (finalized reads as
 * confirmed), failed or expired (it never landed: nothing was spent; Send again). The balance of the token sent is read
 * again while the screen is shown and at once when the transaction settles.
 * @param {{asset: string, to: string, amount: string}} input
 * @param {{signature: string, status: string, lastValidBlockHeight?: number|null}} result
 * @param {object|null} [request]
 * @returns {void}
 */
function renderSolanaSent(input, result, request = null) {
  const token = solanaAsset(input.asset);
  const head = el('div', { className: 'heading' });
  const statusBox = el('div');
  const balance = el('div', { className: 'hint' });
  const again = button(t('sendAgain'), () => renderSolanaForm({ ...input, request }), { action: 'send-again', block: true });
  const isCurrent = showTab(el('div', { className: 'stack' },
    head,
    statusBox,
    kvList([[t('sentSignature'), el('span', { className: 'mono wrap', text: result.signature })]]),
    balance,
    actionsRow(
      button(t('openSolanaExplorer'), () => openTab(solanaTxUrl(result.signature)), { action: 'explorer' }),
      button(t('done'), () => selectTab('assets'), { kind: 'primary', action: 'done' })),
    again));
  const draw = (status) => {
    const [titleKey, kind, leadKey] = SOLANA_SENT[status];
    head.replaceChildren(el('h2', { text: t(titleKey) }));
    clear(statusBox);
    if (status === 'pending') {
      statusBox.append(el('div', { className: 'row pending-line' },
        el('div', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'muted small', text: t(leadKey) })));
    } else if (leadKey) {
      statusBox.append(notice(kind, t(leadKey)));
    }
    again.classList.toggle('hidden', status !== 'failed' && status !== 'expired');
  };
  draw(result.status === 'submitted' ? 'pending' : 'confirmed');
  keepFresh(async () => {
    const read = await call('solana.balances');
    if (!isCurrent()) return;
    balance.textContent = t('sendAvailable', [formatAmount(input.asset === 'sol' ? read.lamports : read.oneDev.raw, token.decimals, token.symbol)]);
  });
  readFresh();
  if (result.status !== 'submitted') return;
  let polls = 0;
  let timer = null;
  onDispose(() => clearTimeout(timer));
  const poll = async () => {
    timer = null;
    polls += 1;
    let answer = null;
    try {
      answer = await call('solana.status', { signature: result.signature, lastValidBlockHeight: result.lastValidBlockHeight ?? null });
    } catch (error) {
      log.warn('send status unreadable', error?.code);
    }
    if (!isCurrent()) return;
    const status = answer?.status === 'finalized' ? 'confirmed' : answer?.status ?? 'pending';
    if (Object.hasOwn(SOLANA_SENT, status) && status !== 'pending') {
      draw(status);
      readFresh({ queue: true });
      return;
    }
    if (polls < SOLANA_STATUS_POLLS_MAX) timer = setTimeout(poll, SOLANA_STATUS_POLL_MS);
  };
  timer = setTimeout(poll, SOLANA_STATUS_POLL_MS);
}

// ---------------------------------------------------------------- receive

function drawQr(canvas, text) {
  const { size, modules } = qrMatrix(text);
  const span = size + QR_QUIET_MODULES * 2;
  const scale = Math.max(2, Math.floor(QR_TARGET_PX / span));
  const side = span * scale;
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, side, side);
  context.fillStyle = '#000000';
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y * size + x]) context.fillRect((x + QR_QUIET_MODULES) * scale, (y + QR_QUIET_MODULES) * scale, scale, scale);
    }
  }
}

/**
 * The active network's address: one line on what it receives, a QR drawn locally (no remote QR service: EXT-08),
 * the address with its first and last characters set apart, and Copy. No warning boxes (owner, 28.09).
 * @returns {void}
 */
function renderReceive() {
  const { network } = state;
  const address = state.addresses[network];
  const canvas = el('canvas', { className: 'qr', attrs: { role: 'img', 'aria-label': t('receiveQrLabel') } });
  let qr;
  try {
    drawQr(canvas, address);
    qr = el('div', { className: 'qr-frame' }, canvas);
  } catch (error) {
    log.warn('qr not drawn', error?.name);
    qr = notice('warn', t('receiveQrFailed'));
  }
  showTab(el('div', { className: 'stack receive' },
    heading(t('receiveTitle'), t(network === 'qnet' ? 'receiveQnetLead' : 'receiveSolanaLead')),
    qr,
    el('div', { className: 'addr-box' }, ownAddress(address, network)),
    button(t('receiveCopy'), () => copyAddress(address), { kind: 'primary', action: 'copy-address', block: true })));
}

// ---------------------------------------------------------------- history

// What a row did (owner, 06.10: the history of a good wallet): its title, and the badge on the asset's icon. A transfer
// is sent, received or to yourself, and a built-in token's transfer reads the same with the token's icon; then a contract
// call or deploy, the node's registration or activation, the node balance moved into the wallet, a swap, and on Solana a
// 1DEV burn. One transaction is one row: a node registration is "Node registered", never a transfer of 0 QNC.
const DIRECTION_ACTIONS = Object.freeze({
  out: Object.freeze({ badge: 'sent', label: 'historyOut' }),
  in: Object.freeze({ badge: 'received', label: 'historyIn' }),
  self: Object.freeze({ badge: 'self', label: 'historySelf' }),
});
const KIND_ACTIONS = Object.freeze({
  call: Object.freeze({ badge: 'call', label: 'historyCall' }),
  deploy: Object.freeze({ badge: 'call', label: 'historyDeploy' }),
  node_registration: Object.freeze({ badge: 'node', label: 'historyNodeRegistered' }),
  node_activation: Object.freeze({ badge: 'node', label: 'historyNodeActivated' }),
  reward: Object.freeze({ badge: 'node', label: 'historyFromNode' }),
  swap: Object.freeze({ badge: 'swap', label: 'historySwap' }),
});
const BURN_ACTION = Object.freeze({ badge: 'burn', label: 'historyBurn' });
// The kinds of a QNet row that move no QNC of their own: shown with no amount when the archive gives 0.
const SILENT_KINDS = new Set(['deploy', 'node_registration', 'node_activation']);
// The states in which nothing moved: the row's badge is the failed mark and its amount is muted.
const FAILED_STATES = new Set(['replaced', 'failed', 'dropped']);

const directionAction = (direction) => (Object.hasOwn(DIRECTION_ACTIONS, direction) ? DIRECTION_ACTIONS[direction] : DIRECTION_ACTIONS.out);

// What a QNet row did: its kind (a token transfer this wallet sent and the chain has not decided yet is a send of that
// token; the node balance moved in is a reward the wallet received), else its direction; a send to the address that
// destroys what it receives is a burn, as the app's row reads it.
function qnetAction(item) {
  if (item.kind === 'call' && typeof item.recipient === 'string') return core.destroysTokens(item.recipient) ? BURN_ACTION : DIRECTION_ACTIONS.out;
  if (item.kind === 'reward' && item.direction !== 'in') return directionAction(item.direction);
  if (Object.hasOwn(KIND_ACTIONS, item.kind)) return KIND_ACTIONS[item.kind];
  return item.direction === 'out' && core.destroysTokens(item.to) ? BURN_ACTION : directionAction(item.direction);
}

// Who a row was with, as its second line says it: "From:" or "To:" and the start and end of the address (six characters
// each, the edges a person compares), the node of a registration this wallet submitted, "From: node balance" for the node
// balance moved in, the contract of a contract call or deploy (as the app's row names it); nothing for a transfer to
// yourself or a row that names no other side.
function partyLine(direction, other) {
  if (direction === 'self' || typeof other !== 'string' || other === '') return null;
  return t(direction === 'in' ? 'historyFrom' : 'historyTo', [shortAddress(other, 6)]);
}

function qnetParty(item, sentToken) {
  if (item.kind === 'node_registration') return typeof item.nodeId === 'string' && item.nodeId !== '' ? t('historyNodeId', [item.nodeId]) : null;
  if (item.kind === 'reward' && item.direction === 'in') return t('historyFromNodeBalance');
  if (item.kind === 'node_activation') return null;
  if ((item.kind === 'call' && !sentToken) || item.kind === 'deploy') {
    return typeof item.to === 'string' && item.to !== '' ? t('historyContractId', [shortAddress(item.to, 6)]) : null;
  }
  return partyLine(item.direction, item.direction === 'in' ? item.from : (sentToken ? item.recipient : item.to));
}

// The worker's row states as plain badges (owner, 28.09; 06.10: a row resolves). Confirmed: two pinned nodes list it
// (included), or Solana confirmed it. Failed: another transaction took its nonce (replaced), or it failed on Solana. Not
// found: no node can hold it any more and its nonce is still free (dropped): it did not go through. Unverified: the
// explorer lists it and no two pinned nodes do (older than what they keep, or not on the chain they serve). Every other
// state may still apply: pending, stale (no longer resent), unknown (no two nodes agree on its nonce yet), refused (one
// node refused it).
const HISTORY_BADGES = Object.freeze({
  included: ['badge-ok', 'historyConfirmed'],
  confirmed: ['badge-ok', 'historyConfirmed'],
  replaced: ['badge-danger', 'historyFailed'],
  failed: ['badge-danger', 'historyFailed'],
  dropped: ['badge-danger', 'historyNotFound'],
  unverified: ['badge-muted', 'historyUnverified'],
});
const PENDING_BADGE = Object.freeze(['badge-warn', 'historyPending']);
// The line the detail of a row adds under its badge, by state.
const HISTORY_LEADS = Object.freeze({
  dropped: 'historyDroppedLead', unverified: 'historyUnverifiedLead', replaced: 'historyReplacedLead',
});

function historyBadge(status) {
  const [className, key] = HISTORY_BADGES[status] ?? PENDING_BADGE;
  return el('span', { className: `badge ${className}`, text: t(key) });
}

// A row's status on its second line, only while it is not confirmed (owner, 06.10): Pending for every state that may
// still apply, Failed, Not found and Unverified as the badges say them (HISTORY_BADGES, which the detail keeps).
const ROW_STATUS_TONES = Object.freeze({ replaced: 'danger', failed: 'danger', dropped: 'danger', unverified: 'muted' });

function rowStatus(status) {
  if (status === 'included' || status === 'confirmed') return null;
  const [, key] = HISTORY_BADGES[status] ?? PENDING_BADGE;
  return { tone: Object.hasOwn(ROW_STATUS_TONES, status) ? ROW_STATUS_TONES[status] : 'warn', text: t(key) };
}

const HISTORY_SIGNS = Object.freeze({ in: '+', out: '−' });
// The longest symbol a row writes whole; a longer one ends in "…" there, and its detail gives it whole.
const HISTORY_SYMBOL_MAX = 10;
const COMPACT_UNITS = Object.freeze([[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]);
const trimZeros = (text) => text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/**
 * An amount as a row writes it, by the app's rule so both histories read the same (owner, 06.10): below 100,000
 * grouped, with at most 8 decimals below 1 (dust reads "<0.00000001"), 4 from 1 and 2 from 1,000 (98,765.43); from
 * 100,000 with a suffix and at most 2 decimals (123.46K, 18.45B, 4200T); from 10^18 (a token of 128-bit supply) in
 * powers of ten (3.4e32). Never longer than 11 characters; the detail gives the exact figure.
 * @param {string} decimal an unsigned decimal string (formatUnits)
 * @returns {string}
 */
function compactAmount(decimal) {
  const n = Math.abs(Number(decimal));
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n < 1e-8) return '<0.00000001';
  if (n >= 1e18) {
    const [mantissa, exponent] = n.toExponential(2).split('e');
    return `${trimZeros(mantissa)}e${Number(exponent)}`;
  }
  if (n >= 1e5) {
    const [unit, suffix] = COMPACT_UNITS.find(([size]) => n >= size);
    const scaled = n / unit;
    return `${trimZeros(scaled.toFixed(scaled >= 1000 ? 0 : 2))}${suffix}`;
  }
  const [whole, fraction] = trimZeros(n.toFixed(n >= 1000 ? 2 : (n >= 1 ? 4 : 8))).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * A row's amount: its sign (none at 0), its number (compactAmount; a dash for units that are not a u64/u128 decimal
 * string) and its symbol as the row writes it (HISTORY_SYMBOL_MAX), with the whole symbol for its accessible name.
 * @returns {{number: string, symbol: string, fullSymbol: string}}
 */
function rowAmount(sign, units, decimals, symbol) {
  let number = '—';
  try {
    if (units !== null && units !== undefined) number = compactAmount(formatUnits(units, decimals));
  } catch {
    number = '—';
  }
  const chars = [...symbol];
  return {
    number: number === '0' || number === '—' ? number : `${sign}${number}`,
    symbol: chars.length > HISTORY_SYMBOL_MAX ? `${chars.slice(0, HISTORY_SYMBOL_MAX - 1).join('')}…` : symbol,
    fullSymbol: symbol,
  };
}

// The asset's icon with the round badge of what the row did at its lower corner (the failed mark when nothing moved).
function historyAvatar(view, className = 'history-avatar') {
  return el('span', { className },
    assetIcon(view.icon, 'token-icon history-icon'),
    el('span', { className: `history-action history-action-${view.failed ? 'failed' : view.badge}`, attrs: { 'aria-hidden': 'true' } }));
}

const amountClass = (view) => `history-${view.direction}${view.failed ? ' history-failed' : ''}`;

/**
 * One row of either history (owner, 06.10: the history of a good wallet, laid out as the app's): the asset's icon with
 * the badge of what happened; what happened over who it was with and, while it is not confirmed, its status; and at the
 * end the amount with its sign (incoming green, outgoing plain, to yourself blue, muted when nothing moved; none for a
 * row that moves no amount of its own), written compactly (rowAmount) and at most half the row wide, its symbol under
 * its number when both do not fit on one line. Its accessible name says what happened, the amount, who with, the status
 * and when. Every row opens its detail, where the exact amount and the explorer link are.
 * @param {{icon: object, badge: string, failed: boolean, label: string, row: {number: string, symbol: string,
 *   fullSymbol: string}|null, direction: string, status: string, timestamp: number|null, party: string|null}} view
 * @param {(view: object) => void} open
 * @returns {Element}
 */
function historyEntry(view, open) {
  const { label, party } = view;
  const amount = view.row;
  const status = rowStatus(view.status);
  const when = Number.isSafeInteger(view.timestamp) && view.timestamp > 0 ? formatTime(view.timestamp) : null;
  const spoken = amount === null ? null : `${amount.number} ${amount.fullSymbol}`;
  const row = el('button', {
    className: 'history-row',
    attrs: { type: 'button', 'data-action': 'open-detail', 'aria-label': [label, spoken, party, status?.text, when].filter(Boolean).join(', ') },
  },
  historyAvatar(view),
  el('span', { className: 'history-main' },
    el('span', { className: 'row-title', text: label }),
    party === null && status === null ? null : el('span', { className: 'history-sub' },
      party === null ? null : el('span', { className: 'history-party', text: party }),
      status === null ? null : el('span', { className: `history-status history-status-${status.tone}`, text: status.text }))),
  amount === null ? null : el('span', { className: 'amount' },
    el('span', { className: 'amount-number', text: amount.number }), ' ', el('span', { className: 'amount-symbol', text: amount.symbol })));
  row.addEventListener('click', () => open(view));
  return el('li', { className: amountClass(view) }, row);
}

/**
 * A QNet history item as its row and detail draw it. A built-in token's row (the archive's) carries its token and an
 * amount in its units; a token transfer this wallet sent and the chain has not decided names its token by the contract
 * (`to`), and its amount shows when the wallet's token list knows that token's decimals. A contract call shows no amount
 * (it moves no QNC but its fee), nor does a registration, activation or deploy the archive gives 0 for.
 * @param {object} item HistoryItem
 * @returns {object}
 */
function qnetHistoryView(item) {
  const sign = HISTORY_SIGNS[item.direction] ?? '';
  const sentToken = item.kind === 'call' && typeof item.recipient === 'string';
  const listed = sentToken ? seenTokens().find((known) => known.contract === item.to) ?? null : null;
  const token = item.kind === 'token' ? { name: '', ...item.token } : listed;
  const action = qnetAction(item);
  // the exact amount (the detail) and the row's (rowAmount)
  let amount = null;
  let row = null;
  if (item.kind === 'token') {
    amount = `${sign}${tokenAmount(item.amountBase, token)}`;
    row = rowAmount(sign, item.amountBase, token.decimals, tokenSymbol(token));
  } else if (sentToken && token !== null && typeof item.amountBase === 'string') {
    amount = `${HISTORY_SIGNS.out}${tokenAmount(item.amountBase, token)}`;
    row = rowAmount(HISTORY_SIGNS.out, item.amountBase, token.decimals, tokenSymbol(token));
  } else if (item.kind !== 'call' && !(SILENT_KINDS.has(item.kind) && item.amountNano === '0')) {
    amount = `${sign}${qncText(item.amountNano)}`;
    row = rowAmount(sign, item.amountNano, DECIMALS.QNC, 'QNC');
  }
  // a token the wallet's list does not know yet is named by its contract, and drawn as a letter, never as QNC
  const rowToken = item.kind === 'token' || sentToken ? (token ?? { contract: item.to, name: '', symbol: '', decimals: 0 }) : null;
  return {
    network: 'qnet',
    icon: rowToken === null ? imageIcon('qnc-token.png') : tokenIcon(rowToken),
    badge: action.badge,
    failed: FAILED_STATES.has(item.status),
    label: t(action.label),
    amount,
    row,
    direction: item.direction,
    status: item.status,
    timestamp: item.timestamp,
    party: qnetParty(item, sentToken),
    token: rowToken,
    item,
  };
}

// A Solana row's asset: its icon, decimals, symbol and mint.
const SOLANA_ROW_ASSETS = Object.freeze({
  sol: ['sol-token.png', DECIMALS.SOL, 'SOL', null],
  '1dev': ['1dev-token.png', DECIMALS.ONE_DEV, '1DEV', SOLANA.ONE_DEV_MINT],
});

function solanaHistoryView(item) {
  const [icon, decimals, symbol] = SOLANA_ROW_ASSETS[item.asset] ?? SOLANA_ROW_ASSETS.sol;
  const action = item.burn ? BURN_ACTION : directionAction(item.direction);
  return {
    network: 'solana',
    icon: imageIcon(icon),
    badge: action.badge,
    failed: FAILED_STATES.has(item.status),
    label: t(action.label),
    amount: `${HISTORY_SIGNS[item.direction] ?? ''}${formatAmount(item.amountRaw, decimals, symbol)}`,
    row: rowAmount(HISTORY_SIGNS[item.direction] ?? '', item.amountRaw, decimals, symbol),
    direction: item.direction,
    status: item.status,
    timestamp: item.timestamp,
    party: item.burn ? null : partyLine(item.direction, item.counterparty),
    item,
  };
}

// An address in a detail: the wallet's own as its own copy control, another valid one as a copy control too, anything
// else (a system sender) as plain text.
function detailAddress(address, network, label) {
  if (address === state.addresses?.[network]) return ownAddress(address, network);
  const valid = validAddress(network === 'qnet' ? core.isValidQnetAddress : core.isValidSolanaAddress, address);
  if (!valid) return el('span', { className: 'mono small wrap', text: typeof address === 'string' && address !== '' ? address : '—' });
  return addressCopy(address, label, { onCopied: () => toast(t('copied'), 'info'), onFailed: () => toast(t('copyFailed'), 'error') });
}

const copiedToast = { onCopied: () => toast(t('copied'), 'info'), onFailed: () => toast(t('copyFailed'), 'error') };

// The rows of a QNet detail: type, status, amount, token (a node registration: its node, when this wallet submitted it),
// from, to (none for a registration or a deploy the archive names no address for), block, time, fee, nonce, transaction.
function qnetDetailRows(view, badge) {
  const { item, token } = view;
  const rows = [[t('historyType'), view.label], [t('historyStatus'), badge]];
  if (view.amount !== null) rows.push([t('reviewAmount'), view.amount]);
  if (item.kind === 'node_registration') {
    if (typeof item.nodeId === 'string' && item.nodeId !== '') rows.push([t('historyNode'), el('span', { className: 'mono small wrap', text: item.nodeId })]);
  } else if (token === null) {
    rows.push([t('reviewToken'), 'QNC']);
  } else {
    rows.push([t('reviewToken'), token.symbol || token.name ? tokenTitle(token) : '—'], [t('apTokenContract'), addressText(token.contract)]);
  }
  const sentToken = item.kind === 'call' && typeof item.recipient === 'string';
  rows.push([t('reviewFrom'), detailAddress(item.from, 'qnet', t('reviewFrom'))]);
  if (item.kind === 'call' && !sentToken) rows.push([t('apContract'), detailAddress(item.to, 'qnet', t('apContract'))]);
  else if (sentToken || item.to !== '') rows.push([t('reviewTo'), detailAddress(sentToken ? item.recipient : item.to, 'qnet', t('reviewTo'))]);
  return rows;
}

// The head of a detail: the row's icon and badge, larger, what happened and the amount.
function detailHead(view) {
  return el('div', { className: 'detail-head' },
    historyAvatar(view, 'history-avatar history-avatar-large'),
    el('h2', { text: view.label }),
    view.amount === null ? null : el('div', { className: `detail-amount ${amountClass(view)}`, text: view.amount }));
}

/**
 * The detail of a history row (owner, 06.10: a row opens a screen with everything and the explorer link): the row's icon
 * and badge, what happened, the amount, its badge with a line for a dropped, unverified or replaced transaction, the
 * token, both sides (each a copy control), the block, the time, the fee, the nonce of one not decided yet, and the
 * transaction hash or signature (a copy control), with Open in explorer and Back. An unverified QNet row is looked up on two pinned nodes (qnet.txLookup): in a
 * block there, it reads as confirmed with its block.
 * @param {object} view qnetHistoryView / solanaHistoryView
 * @param {() => void} back
 * @param {() => boolean} isCurrent
 * @returns {Element[]}
 */
function historyDetail(view, back, isCurrent) {
  const { item } = view;
  const badgeBox = el('span', {}, historyBadge(view.status));
  const lead = el('div');
  const showLead = (status) => {
    clear(lead);
    if (HISTORY_LEADS[status]) lead.append(notice(status === 'unverified' ? 'info' : 'warn', t(HISTORY_LEADS[status])));
  };
  showLead(view.status);
  let rows;
  let explorer = null;
  const blockValue = el('span', { text: '—' });
  if (view.network === 'qnet') {
    rows = qnetDetailRows(view, badgeBox);
    const block = Number.isSafeInteger(item.block) ? item.block : null;
    if (block !== null) blockValue.textContent = String(block);
    if (block !== null || (item.hash && view.status === 'unverified')) rows.push([t('historyBlock'), blockValue]);
    if (Number.isSafeInteger(item.timestamp) && item.timestamp > 0) rows.push([t('historyTime'), formatTime(item.timestamp)]);
    if (typeof item.feeNano === 'string' && item.feeNano !== '0') rows.push([t('reviewFee'), qncText(item.feeNano)]);
    if (item.nonce) rows.push([t('reviewNonce'), String(item.nonce)]);
    if (item.hash) {
      rows.push([t('historyHash'), valueCopy(item.hash, t('historyHash'), copiedToast)]);
      explorer = button(t('historyExplorer'), () => openTab(qnetTxUrl(item.hash)), { kind: 'primary', action: 'explorer' });
    }
  } else {
    const [, , symbol, mint] = SOLANA_ROW_ASSETS[item.asset] ?? SOLANA_ROW_ASSETS.sol;
    const own = state.addresses.solana;
    rows = [[t('historyType'), view.label], [t('historyStatus'), badgeBox], [t('reviewAmount'), view.amount], [t('reviewToken'), symbol]];
    if (mint !== null) rows.push([t('reviewMint'), addressText(mint)]);
    const other = typeof item.counterparty === 'string' ? item.counterparty : null;
    const [from, to] = item.direction === 'in' ? [other, own] : [own, item.direction === 'self' ? own : other];
    if (from !== null) rows.push([t('reviewFrom'), detailAddress(from, 'solana', t('reviewFrom'))]);
    if (to !== null && !item.burn) rows.push([t('reviewTo'), detailAddress(to, 'solana', t('reviewTo'))]);
    if (Number.isSafeInteger(item.timestamp) && item.timestamp > 0) rows.push([t('historyTime'), formatTime(item.timestamp)]);
    if (typeof item.feeLamports === 'string') rows.push([t('reviewFee'), formatAmount(item.feeLamports, DECIMALS.SOL, 'SOL')]);
    rows.push([t('sentSignature'), valueCopy(item.signature, t('sentSignature'), copiedToast)]);
    explorer = button(t('openSolanaExplorer'), () => openTab(solanaTxUrl(item.signature)), { kind: 'primary', action: 'explorer' });
  }
  if (view.network === 'qnet' && item.hash && view.status === 'unverified') {
    call('qnet.txLookup', { hash: item.hash }).then((found) => {
      if (!isCurrent() || !badgeBox.isConnected || found?.status !== 'in_block') return;
      badgeBox.replaceChildren(historyBadge('included'));
      blockValue.textContent = String(found.blockHeight);
      showLead('included');
    }, (error) => log.warn('transaction lookup failed', error?.code));
  }
  return [
    detailHead(view),
    lead,
    // a token named after QNet's own coin is said not to be QNC (M-5), as the review and the approval window say it
    view.network === 'qnet' && view.token && reservedToken(view.token) ? notice('danger', t('apTokenReserved')) : null,
    kvList(rows),
    actionsRow(button(t('back'), back, { action: 'back' }), explorer),
  ].filter(Boolean);
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const timeOf = (row) => (Number.isSafeInteger(row?.timestamp) && row.timestamp > 0 ? row.timestamp : 0);

// The day a row is listed under (owner, 06.10): Today, Yesterday, then the date in the UI language (with its year when
// it is not this year); a row with no time is listed under Earlier.
function historyDay(ms, now) {
  if (ms <= 0) return { key: '', label: t('historyEarlier') };
  const day = new Date(ms);
  const today = new Date(now);
  const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
  if (sameDay(day, today)) return { key, label: t('historyToday') };
  if (sameDay(day, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return { key, label: t('historyYesterday') };
  const options = { day: 'numeric', month: 'long', ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) };
  try {
    return { key, label: day.toLocaleDateString(currentLanguage(), options) };
  } catch {
    return { key, label: day.toLocaleDateString(undefined, options) };
  }
}

// The rows newest first (the rows with no time last, as listed), each day a list of its own under its header.
function historyDays(rows, rowOf, now) {
  const ordered = rows.map((row, index) => ({ row, index })).sort((a, b) => timeOf(b.row) - timeOf(a.row) || a.index - b.index);
  const days = [];
  for (const { row } of ordered) {
    const day = historyDay(timeOf(row), now);
    if (days.at(-1)?.key !== day.key) days.push({ ...day, list: el('ul', { className: 'list history' }) });
    days.at(-1).list.append(rowOf(row));
  }
  return days.map(({ label, list }) => el('section', { className: 'history-day' }, el('h3', { className: 'history-date', text: label }), list));
}

// The list of either history: redrawn only when its rows (or the day) changed, the empty line, and More while a cursor
// is left.
function historyDrawer(list, message, more, rowOf) {
  let shown = null;
  return (rows, cursor) => {
    more.classList.toggle('hidden', cursor === null);
    if (rows.length === 0) message.show(t('historyEmpty'), 'info');
    else message.clear();
    const now = Date.now();
    const key = `${new Date(now).toDateString()} ${JSON.stringify(rows)}`;
    if (key === shown) return;
    shown = key;
    clear(list);
    list.append(...historyDays(rows, rowOf, now));
  };
}

// Reads one at a time: run(read) waits for the one running; busy() says whether one runs (a refresh then skips).
function oneAtATime() {
  let reading = null;
  return {
    busy: () => reading !== null,
    async run(read) {
      while (reading !== null) await reading.catch(() => {});
      const pending = read();
      reading = pending;
      try {
        return await pending;
      } finally {
        if (reading === pending) reading = null;
      }
    },
  };
}

const cursorOf = (page) => (typeof page?.cursor === 'string' && page.cursor !== '' ? page.cursor : null);

/**
 * QNet and Solana each list their own transactions, as the balances are apart (owner, 04.10), newest first under the
 * header of their day (owner, 06.10). QNet: qnet.history pages (cursor) and the pending rows. Solana: solana.history
 * pages. What this session read last is drawn at
 * once and read again behind it; while shown, the list reads itself again (keepFresh) and is redrawn only when it
 * changed. QNet reads the rows listed so far in one request, up to LIMITS.HISTORY_PAGE_MAX; Solana reads its newest page
 * and keeps the older pages More listed below it. A row opens its detail in place of the list (historyDetail); Back shows
 * the list again where it was, which went on reading meanwhile.
 * @returns {Promise<void>}
 */
async function renderHistory() {
  const network = state.network;
  const list = el('div', { className: 'history-days' });
  const message = messageLine();
  const more = button(t('historyMore'), null, { action: 'more', block: true });
  more.classList.add('hidden');
  const listView = el('div', { className: 'stack' }, heading(t('historyTitle')), list, message.node, more);
  const detailView = el('div', { className: 'stack history-detail hidden' });
  const isCurrent = showTab(el('div', {}, listView, detailView));
  let listScroll = 0;
  const closeDetail = () => {
    if (!isCurrent()) return;
    clear(detailView);
    detailView.classList.add('hidden');
    listView.classList.remove('hidden');
    shell.body.scrollTop = listScroll;
  };
  const openDetail = (view) => {
    if (!isCurrent()) return;
    listScroll = shell.body.scrollTop;
    clear(detailView);
    detailView.append(...historyDetail(view, closeDetail, isCurrent));
    listView.classList.add('hidden');
    detailView.classList.remove('hidden');
    shell.body.scrollTop = 0;
  };
  const lane = oneAtATime();
  const cached = seenOf(network, 'history');
  const pages = network === 'qnet'
    ? qnetHistoryPages(list, message, more, isCurrent, (item) => historyEntry(qnetHistoryView(item), openDetail))
    : solanaHistoryPages(list, message, more, isCurrent, (item) => historyEntry(solanaHistoryView(item), openDetail));
  more.addEventListener('click', async () => {
    message.show(t('loading'), 'info');
    try {
      await whileBusy([more], () => lane.run(pages.older));
    } catch (error) {
      if (isCurrent()) message.show(errorText(error));
    }
  });
  keepFresh(async () => {
    if (!lane.busy() && isCurrent()) await lane.run(pages.refresh);
  });
  if (cached !== null) {
    pages.show(cached);
    readFresh({ queue: true });
    return;
  }
  message.show(t('loading'), 'info');
  try {
    await lane.run(pages.first);
  } catch (error) {
    if (isCurrent()) message.show(errorText(error));
  }
}

// The QNet history's pages: the first one, More (older), the refresh of every row listed so far, and a cached page shown.
function qnetHistoryPages(list, message, more, isCurrent, rowOf) {
  const draw = historyDrawer(list, message, more, rowOf);
  let items = [];
  let cursor = null;
  // archive rows asked for so far (the first page and each More), and those listed
  let asked = 0;
  let listed = 0;
  const shown = (rows, nextCursor) => {
    items = rows;
    cursor = nextCursor;
    draw(rows, nextCursor);
  };
  const head = (page, limit) => {
    asked = limit;
    listed = (page.items ?? []).length;
    shown([...(page.pending ?? []), ...(page.items ?? [])], cursorOf(page));
  };
  return {
    show: (page) => head(page, Math.max(HISTORY_PAGE_SIZE, (page.items ?? []).length)),
    async first() {
      const page = await readSeen('qnet', 'history');
      if (isCurrent()) head(page, HISTORY_PAGE_SIZE);
    },
    async older() {
      if (cursor === null) return;
      const page = await call('qnet.history', { cursor, limit: HISTORY_PAGE_SIZE });
      if (!isCurrent()) return;
      asked += HISTORY_PAGE_SIZE;
      listed += (page.items ?? []).length;
      shown([...items, ...(page.items ?? [])], cursorOf(page));
    },
    // the rows listed so far in one request: the pages asked for, or, once the list reached its end, every row it holds
    // (a last More asks for a whole page and gets fewer); a list paged past LIMITS.HISTORY_PAGE_MAX stays as it is
    async refresh() {
      const limit = Math.max(cursor === null ? Math.min(asked, LIMITS.HISTORY_PAGE_MAX) : asked, HISTORY_PAGE_SIZE);
      if (limit > LIMITS.HISTORY_PAGE_MAX || listed > LIMITS.HISTORY_PAGE_MAX) return;
      const page = remember('qnet', 'history', await call('qnet.history', { limit }));
      if (isCurrent()) head(page, limit);
    },
  };
}

// The Solana history's pages: the newest page (first, and every refresh, with the older pages More listed kept below
// it), More (older), and a cached page shown.
function solanaHistoryPages(list, message, more, isCurrent, rowOf) {
  const draw = historyDrawer(list, message, more, rowOf);
  let items = [];
  let cursor = null;
  let paged = false;
  const shown = (rows, nextCursor) => {
    items = rows;
    cursor = nextCursor;
    draw(rows, nextCursor);
  };
  const newest = async () => {
    const page = await readSeen('solana', 'history');
    if (!isCurrent()) return;
    const top = page.items ?? [];
    const below = paged ? items.filter((item) => !top.some((row) => row.signature === item.signature)) : [];
    shown([...top, ...below], paged ? cursor : cursorOf(page));
  };
  return {
    show: (page) => shown(page.items ?? [], cursorOf(page)),
    first: newest,
    refresh: newest,
    async older() {
      if (cursor === null) return;
      const page = await call('solana.history', { cursor, limit: SOLANA_HISTORY_PAGE_SIZE });
      if (!isCurrent()) return;
      paged = true;
      const known = new Set(items.map((item) => item.signature));
      shown([...items, ...(page.items ?? []).filter((item) => !known.has(item.signature))], cursorOf(page));
    },
  };
}

// ---------------------------------------------------------------- activate

function burnShortfall(balances, cost) {
  try {
    if (BigInt(balances.oneDev.raw) < BigInt(cost) * 10n ** BigInt(DECIMALS.ONE_DEV)) return t('activateNeed1dev', [cost]);
    if (BigInt(balances.lamports) < BigInt(SOLANA.FEE_BUFFER_LAMPORTS)) {
      return t('activateNeedSol', [formatAmount(String(SOLANA.FEE_BUFFER_LAMPORTS), DECIMALS.SOL, 'SOL')]);
    }
  } catch {
    return null;
  }
  return null;
}

function balancesCard(result) {
  if (result.status === 'rejected') return notice('warn', t('activateBalancesUnavailable', [errorText(result.reason)]));
  const balances = result.value;
  return el('div', { className: 'card' },
    el('div', { className: 'card-label', text: t('activateSolanaAccount') }),
    ownAddress(balances.address, 'solana'),
    tokenRow('sol-token.png', t('assetSol'), formatAmount(balances.lamports, DECIMALS.SOL, 'SOL'), null),
    tokenRow('1dev-token.png', t('asset1dev'), formatAmount(balances.oneDev.raw, DECIMALS.ONE_DEV, '1DEV'), null));
}

function priceCards(priceResult, balancesResult, blocked) {
  if (priceResult.status === 'rejected') {
    return notice('danger', t('activatePriceUnavailable', [errorText(priceResult.reason)]));
  }
  const price = priceResult.value;
  if (price.phase !== 1) return notice('warn', t('err_PHASE_UNSUPPORTED'));
  const balances = balancesResult.status === 'fulfilled' ? balancesResult.value : null;
  const cards = ['light', 'super'].map((nodeType) => {
    const cost = price[nodeType]?.cost;
    const valid = Number.isSafeInteger(cost) && cost > 0;
    const shortfall = valid && balances ? burnShortfall(balances, cost) : null;
    return el('div', { className: `card node-card node-${nodeType}` },
      el('div', { className: 'row between' },
        el('h3', { text: nodeLabel(nodeType) }),
        el('span', { className: 'price', text: valid ? t('amount1dev', [cost]) : '—' })),
      el('p', { className: 'muted small', text: t(`activateAbout_${nodeType}`) }),
      shortfall ? el('p', { className: 'hint hint-warn', text: shortfall }) : null,
      button(t(`activateChoose_${nodeType}`), () => renderBurnConfirm(nodeType, cost), {
        kind: 'primary', action: `choose-${nodeType}`, block: true, disabled: !valid || blocked || shortfall !== null,
      }));
  });
  return el('div', { className: 'stack' }, ...cards);
}

// Where the node is managed once the burn is made (owner, 06.10): one line, the node's status, device and balance live
// on aiqnet.io/node.
function manageLine() {
  return el('p', { className: 'small' },
    el('a', { className: 'inline-link', text: t('activateManage'), attrs: { href: `${RECORD_ORIGIN}/node`, target: '_blank', rel: 'noopener noreferrer' } }));
}

// A burn on its way: the tab reads it again on its own (EXT-F2), so there is no button to check it.
function pendingCard(pending) {
  return el('div', { className: 'card' },
    el('div', { className: 'card-label', text: t('activatePendingTitle') }),
    el('p', { text: t('activatePendingLead', [nodeLabel(pending.nodeType), pending.burnAmount]) }),
    el('div', { className: 'mono small wrap', text: pending.burnTx }),
    el('p', { className: 'muted small', text: t('activatePendingNote') }),
    actionsRow(button(t('openSolanaExplorer'), () => openTab(solanaTxUrl(pending.burnTx)), { action: 'pending-explorer' })));
}

// While the wallet is being checked: no price card and no burn (decision 35).
function checkingBlock() {
  return el('div', { className: 'loading', attrs: { role: 'status' } },
    el('div', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'muted', text: t('activateChecking') }));
}

// The line a registration of the light node shows (activation.registration's view). wallet_has_node: a refusal of the
// network's one-node rule (this wallet has a node already, decision 36).
const RECORD_TEXT = Object.freeze({
  onchain: ['success', 'recordOnchain'], recording: ['info', 'recordRecording'], none: ['warn', 'recordNone'],
  refused: ['warn', 'recordRefused'], clock: ['warn', 'recordClock'], other_burn: ['danger', 'recordOtherBurn'],
  wallet_has_node: ['danger', 'recordRefusedWalletHasNode'],
});
// The states whose node the chain lists: Record on the network cannot change them (other_burn: another burn's
// registration holds the node, EXT-R2A-03).
const LISTED_RECORDS = new Set(['onchain', 'other_burn']);
// The states Record on the network is never offered for: the listed ones, and the one-node rule's refusal, which another
// attempt would only meet again.
const FINAL_RECORDS = new Set([...LISTED_RECORDS, 'wallet_has_node']);

// 'recording' only while the next automatic attempt is near: a retry minutes or hours away (deferred) shows Not recorded
// and Record on the network, and the wallet keeps trying on its own meanwhile.
function recordState(registration) {
  if (!registration) return 'none';
  if (registration.state === 'refused' && registration.lastError === 'wallet_has_node') return 'wallet_has_node';
  if (LISTED_RECORDS.has(registration.state) || registration.state === 'refused' || registration.state === 'clock') return registration.state;
  return registration.automatic && registration.deferred !== true ? 'recording' : 'none';
}

/**
 * The light node's record on the QNet network: its id, one line (read again while it is being recorded) and, when it
 * waits for the user, Record on the network (activation.register; no password: the unlocked session, decision 33).
 * @param {object|null} initial the registration view activation.status or activation.registration gave
 * @param {{read?: boolean}} [options] read: ask the worker at once (right after a burn; an activation not recorded
 *   yet is looked up on chain)
 * @returns {{node: Element, show: (registration: object|null) => void, start: () => void}} show: the registration as it
 *   is now (an 'activation' event); start: called once the card is shown (its reads stop with the view)
 */
function registrationCard(initial, { read = false } = {}) {
  const line = el('div');
  const actions = el('div', { className: 'stack' });
  const message = messageLine();
  let timer = null;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  const card = el('div', { className: 'card' },
    el('div', { className: 'card-label', text: t('recordTitle') }),
    state.addresses ? kvList([[t('nodeLight'), el('span', { className: 'mono small wrap', text: core.lightNodeId(state.addresses.qnet) })]]) : null,
    line, actions, message.node);

  const refresh = async () => {
    timer = null;
    try {
      const { registration } = await call('activation.registration');
      if (card.isConnected) show(registration);
    } catch (error) {
      log.warn('registration unreadable', error?.code);
    }
  };
  // Record on the network offered: its line and button
  let offered = false;

  const record = async (control) => {
    message.clear();
    try {
      const result = await whileBusy([control], () => call('activation.register'));
      if (card.isConnected) show(result.registration, { reset: true });
    } catch (error) {
      if (card.isConnected) message.show(errorText(error));
    }
  };
  const offerRecord = () => {
    const go = button(t('recordButton'), null, { kind: 'primary', action: 'record' });
    go.addEventListener('click', () => record(go));
    actions.append(el('p', { className: 'muted small', text: t('recordLead') }), go);
  };

  // The line again; the actions only when Record on the network comes or goes (or `reset`, after an attempt), so the
  // registration moving on while it stays offered keeps the button as it is, pressed or not (EXT-R4-01).
  function show(registration, { reset = false } = {}) {
    stop();
    clear(line);
    const shown = recordState(registration);
    const [kind, key] = RECORD_TEXT[shown];
    line.append(notice(kind, t(key)));
    // a node the chain lists needs nothing here: the card goes (aiqnet.io/node shows the node)
    card.classList.toggle('hidden', shown === 'onchain');
    const offer = shown !== 'recording' && !FINAL_RECORDS.has(shown);
    if (reset || !offer || !offered) {
      wipeInputs(actions);
      clear(actions);
      if (offer) offerRecord();
    }
    offered = offer;
    if (shown === 'recording') timer = setTimeout(refresh, TIMINGS.REGISTRATION_POLL_MS);
  }

  return {
    node: card,
    show,
    start() {
      onDispose(stop);
      show(initial);
      // a read at once takes the place of the poll show() set for a record being made: two timers would read twice
      // per poll, and the one no longer held would read after the view is gone
      if (read || initial === null) {
        stop();
        timer = setTimeout(refresh, 0);
      }
    },
  };
}

function recoverCard(disabled, isCurrent) {
  const message = messageLine();
  const recover = button(t('recoverButton'), null, { action: 'recover', disabled });
  recover.addEventListener('click', async () => {
    message.show(t('recoverScanning'), 'info');
    let result;
    try {
      result = await whileBusy([recover], () => call('activation.recover'));
    } catch (error) {
      if (isCurrent()) message.show(errorText(error));
      return;
    }
    if (!isCurrent()) return;
    if (result.activation) renderActivate(notice('success', t('recoverFound')));
    else message.show(t(result.complete ? 'recoverNone' : 'recoverIncomplete'), result.complete ? 'info' : 'warn');
  });
  return el('div', { className: 'card' },
    el('div', { className: 'card-label', text: t('recoverTitle') }),
    recover,
    message.node);
}

// The views of activation.lookup the tab reads again on its own, every TIMINGS.ACTIVATE_RECHECK_MS while the popup is
// visible (EXT-F2): a burn on its way, an activation running here, the check of the wallet, one starting elsewhere.
const RECHECKED_VIEWS = new Set(['pending', 'busy', 'checking', 'elsewhere']);

// What of a lookup the overview draws: another value is a redraw.
const lookupKey = (lookup) => JSON.stringify([lookup.view, lookup.reason, lookup.pending?.burnTx ?? null, lookup.record?.state ?? null,
  lookup.record?.burnTx ?? null, lookup.record?.codeMasked ?? null, lookup.keptBurn?.burnTx ?? null, lookup.superseded?.burnTx ?? null,
  ...ACTIVATION_SHOWN.map((key) => lookup.activation?.[key] ?? null)]);

// The masked code of this wallet a lookup names: the vault's activation, or aiqnet.io's record of a burn it shows as the
// wallet's (a payment burn, or another burn the record keeps instead of the vault's); null for any other view.
function lookupCodeMasked(lookup) {
  const masked = lookup?.view === 'activation' ? lookup.activation?.codeMasked : lookup?.view === 'record' ? lookup.record?.codeMasked : null;
  return typeof masked === 'string' && masked !== '' ? masked : null;
}

// The vault's own burn that aiqnet.io's record of another burn of this wallet beat: it gives no second code.
function keptBurnNotice(kept) {
  if (!kept || typeof kept.burnTx !== 'string') return null;
  return el('div', { className: 'stack' },
    notice('warn', t('activateRecordOther', [String(kept.burnAmount)])),
    button(t('openSolanaExplorer'), () => openTab(solanaTxUrl(kept.burnTx)), { action: 'kept-burn' }));
}

/**
 * activation.lookup (the vault, aiqnet.io's record of this wallet's burn, the QNet network and the search of its own
 * address, decision 35), then the view it names: the wallet's activation, the burn on its way, the check, an activation
 * starting elsewhere, a node with Recover, a source that could not answer with Retry, or, only when every source said
 * "none", the Get code cards (type → confirm screen with its acknowledgement → activation.burn) with Recover.
 * Once the wallet has its code (owner, 06.10): the light node's record only while the chain does not list it (Record on
 * the network while it waits for the user), the one line to aiqnet.io/node, and a warning only when another burn is
 * involved; nothing else, for either node type. The code itself is in Settings (codeSection).
 * @param {Node|null} [note] shown above the overview (the outcome of the previous step)
 * @param {object|null} [known] an activation.lookup answer just read (a re-read that saw the view change), not asked again
 * @returns {Promise<void>}
 */
async function renderActivate(note = null, known = null) {
  activateOverview = null;
  const loading = showTab(el('div', { className: 'stack' }, heading(t('activateTitle')), checkingBlock()));
  state.activateIdle = true;
  const [read, price, balances] = await Promise.allSettled([
    known ?? call('activation.lookup'), call('activation.price'), call('solana.balances'),
  ]);
  if (!loading()) return;
  if (read.status === 'rejected') {
    showTab(failureBlock(read.reason, () => renderActivate()));
    state.activateIdle = true;
    return;
  }
  const lookup = read.value;
  const { view, activation, pending, superseded, registration, record } = lookup;
  let isCurrent = () => false;
  const current = () => isCurrent();
  // the lead invites a burn: only with the Get code cards, when every source said "none" (EXT-F6, decision 35); never
  // beside a code, a burn on its way, a node, an activation elsewhere, the check or a source that could not answer
  const parts = [heading(t('activateTitle'), view === 'none' ? t('activateLead') : null), note];
  let recordCard = null;
  // After the burn the tab keeps only where the node is managed (owner, 06.10): the light node's record only while it
  // still waits to be recorded, and a warning only when another burn is involved; the code is in Settings.
  if (view === 'activation') {
    recordCard = activation.nodeType === 'light' ? registrationCard(registration ?? null) : null;
    parts.push(recordCard?.node ?? null, manageLine(), supersededNotice(superseded));
  } else if (view === 'record') {
    parts.push(manageLine(), keptBurnNotice(lookup.keptBurn));
  } else if (view === 'pending') {
    parts.push(pendingCard(pending));
  } else if (view === 'busy') {
    parts.push(notice('warn', t('err_BURN_IN_PROGRESS')));
  } else if (view === 'checking') {
    parts.push(checkingBlock());
  } else if (view === 'elsewhere') {
    parts.push(notice('warn', t('activateElsewhere')));
  } else if (view === 'node') {
    parts.push(notice('warn', t('activateHasNode')), recoverCard(false, current));
  } else if (view === 'unusable') {
    parts.push(notice('danger', t('err_BURN_UNUSABLE')));
  } else if (view === 'unavailable') {
    parts.push(el('div', { className: 'stack' },
      notice('danger', codeText(lookup.reason ?? 'INTERNAL')),
      button(t('retry'), () => renderActivate(), { action: 'retry' })), recoverCard(false, current));
  } else {
    // 'none': every source answered that this wallet has no burn and no node
    parts.push(balancesCard(balances), priceCards(price, balances, false), recoverCard(false, current));
  }
  isCurrent = showTab(el('div', { className: 'stack' }, ...parts));
  state.activateIdle = true;
  activateOverview = { key: lookupKey(lookup), record: recordCard, isCurrent };
  recordCard?.start();
  if (RECHECKED_VIEWS.has(view)) recheckActivate(activateOverview);
}

// The tab's own re-read while RECHECKED_VIEWS shows (no Check again button: EXT-F2), paused while the popup is hidden.
function recheckActivate(shown) {
  let timer = null;
  const tick = async () => {
    timer = null;
    if (!shown.isCurrent()) return;
    if (!document.hidden) {
      let next = null;
      try {
        next = await call('activation.lookup');
      } catch (error) {
        log.warn('activation lookup failed', error?.code);
      }
      if (!shown.isCurrent()) return;
      if (next !== null && lookupKey(next) !== shown.key) {
        renderActivate(null, next);
        return;
      }
    }
    timer = setTimeout(tick, TIMINGS.ACTIVATE_RECHECK_MS);
  };
  timer = setTimeout(tick, TIMINGS.ACTIVATE_RECHECK_MS);
  onDispose(() => clearTimeout(timer));
}

// The fields of an activation whose change draws the overview again (lookupKey); the tab itself draws only its code.
const ACTIVATION_SHOWN = Object.freeze(['nodeType', 'burnTx', 'burnAmount', 'solanaAddress', 'cluster', 'createdAt', 'codeMasked',
  'paidOnSite']);

// An 'activation' event on the overview. A wallet's activation is never replaced, so while the same view is shown only
// its light node's registration moves on (each step of it, from the worker's retry alarm): the record line alone is
// drawn again, and a code shown and armed, or a Record on the network press, stays (EXT-R4-01). Anything else changed
// (a burn settling, Recover, aiqnet.io's record): the overview again.
let overviewRead = 0;
async function refreshActivate() {
  const shown = activateOverview;
  if (!shown?.isCurrent()) {
    renderActivate();
    return;
  }
  overviewRead += 1;
  const read = overviewRead;
  let lookup;
  try {
    lookup = await call('activation.lookup');
  } catch (error) {
    log.warn('activation lookup failed', error?.code);
    return;
  }
  if (read !== overviewRead || !shown.isCurrent()) return;
  if (lookupKey(lookup) === shown.key) shown.record?.show(lookup.registration ?? null);
  else renderActivate(null, lookup);
}

// The burn's confirmation: what is burned, from where, and the one acknowledgement Burn waits for. No password: the
// unlocked session and the acknowledged press confirm it (decision 33).
function renderBurnConfirm(nodeType, cost) {
  state.activateIdle = false;
  const back = button(t('back'), () => renderActivate(), { action: 'back' });
  const burn = button(t('activateBurnButton', [cost]), null, { kind: 'danger', action: 'burn', disabled: true });
  const ack = checkbox('acknowledge', t('activateAck', [cost]), (checked) => {
    burn.disabled = !checked;
  });
  showTab(el('div', { className: 'stack' },
    heading(t(`activateConfirmTitle_${nodeType}`)),
    kvList([
      [t('activateNodeType'), nodeLabel(nodeType)],
      [t('activateBurnAmount'), el('strong', { text: t('amount1dev', [cost]) })],
      [t('activateToken'), t('activateTokenValue', [SOLANA.CLUSTER])],
      [t('activateMint'), addressText(SOLANA.ONE_DEV_MINT)],
      [t('activateProgram'), el('span', {
        className: 'small', text: t('activateProgramValue', [core.SOLANA_PROGRAMS.TOKEN]),
      })],
      [t('activateFrom'), ownAddress(state.addresses.solana, 'solana')],
      [t('reviewFee'), t('activateFeeValue')],
    ]),
    // the burn is irreversible: its one confirmation line is the acknowledgement the button waits for
    ack.node,
    actionsRow(back, burn)));
  burn.addEventListener('click', () => {
    if (burn.disabled || !ack.input.checked) return;
    // One burn per confirmation: a second click must not reach the worker.
    burn.disabled = true;
    runBurn(nodeType, cost);
  });
}

async function runBurn(nodeType, cost) {
  state.activateIdle = false;
  const elapsed = el('p', { className: 'muted small' });
  const isCurrent = showTab(el('div', { className: 'stack' },
    heading(t('activateProgressTitle', [cost])),
    el('div', { className: 'progress', attrs: { role: 'progressbar', 'aria-label': t('activateProgressTitle', [cost]) } },
      el('div', { className: 'progress-bar' })),
    elapsed,
    notice('info', t('activateKeepOpen'))));
  const started = Date.now();
  const ticker = setInterval(() => {
    elapsed.textContent = t('activateElapsed', [Math.floor((Date.now() - started) / 1000)]);
  }, 1000);
  const clock = onDispose(() => clearInterval(ticker));
  let result;
  try {
    result = await call('activation.burn', { nodeType, expectedPrice: cost });
  } catch (error) {
    clock();
    if (isCurrent()) burnFailed(error);
    return;
  }
  clock();
  if (!isCurrent()) return;
  if (result.status === 'finalized') renderCodeResult(result);
  else renderActivate();
}

function burnFailed(error) {
  const code = errorCode(error);
  if (code === 'LOCKED') return; // the 'locked' event shows the lock screen
  if (BURN_REFUSED.has(code)) {
    renderActivate(notice('warn', errorText(error)));
    return;
  }
  let outcome = 'activateMaybeSent';
  if (BURN_NOT_SENT.has(code)) outcome = 'activateNothingBurned';
  else if (code === 'TX_FAILED') outcome = 'activateTxFailed';
  showTab(el('div', { className: 'stack' },
    heading(t('activateFailedTitle')),
    notice('danger', errorText(error)),
    notice('info', t(outcome)),
    button(t('back'), () => renderActivate(), { kind: 'primary', action: 'back', block: true })));
}

// This device's own burn that an older burn of the phrase, from another device, beat: the activation is that older
// burn, and this one gave no code of its own (XP-R5-03).
function supersededNotice(superseded) {
  if (!superseded || typeof superseded.burnTx !== 'string') return null;
  return el('div', { className: 'stack' },
    notice('warn', t('activateSuperseded', [String(superseded.burnAmount)])),
    button(t('openSolanaExplorer'), () => openTab(solanaTxUrl(superseded.burnTx)), { action: 'superseded-burn' }));
}

// Right after a burn: the tab as it reads from now on (a light node's record while it is made, the line to aiqnet.io/node);
// the code is in Settings, so this screen never holds it. No Done button (EXT-F5).
function renderCodeResult(result) {
  state.activateIdle = false;
  const { activation } = result;
  // a light burn is being recorded on the QNet network now
  const record = activation.nodeType === 'light' ? registrationCard({ state: 'queued', automatic: true }, { read: true }) : null;
  showTab(el('div', { className: 'stack' },
    heading(t('activateTitle')),
    supersededNotice(result.superseded ?? null),
    record?.node ?? null,
    manageLine()));
  record?.start();
}

// ---------------------------------------------------------------- settings

// Never: no inactivity timer (the wallet still locks on Lock, the screen lock and when the browser closes).
const autoLockLabel = (minutes) => (minutes === AUTO_LOCK_NEVER ? t('autoLockNever') : t('minutes', [minutes]));

function autoLockSection(result) {
  const message = messageLine();
  const current = result.status === 'fulfilled' ? result.value.autoLockMinutes : null;
  let saved = current === null ? null : String(current);
  const group = segmented(
    AUTO_LOCK_CHOICES.map((minutes) => [String(minutes), autoLockLabel(minutes)]),
    saved,
    async (value, select) => {
      message.clear();
      try {
        const autoLockMinutes = value === AUTO_LOCK_NEVER ? AUTO_LOCK_NEVER : Number(value);
        const settings = await call('settings.set', { autoLockMinutes });
        saved = String(settings.autoLockMinutes);
        select(saved);
        toast(settings.autoLockMinutes === AUTO_LOCK_NEVER ? t('autoLockOff')
          : t('autoLockSaved', [autoLockLabel(settings.autoLockMinutes)]));
      } catch (error) {
        select(saved);
        message.show(errorText(error));
      }
    },
    t('settingsAutoLockTitle'));
  return section(t('settingsAutoLockTitle'), t('settingsAutoLockLead'), [group, message.node]);
}

function siteRow(site) {
  const revoke = button(t('sitesRevoke'), null, { kind: 'danger', action: 'revoke' });
  revoke.addEventListener('click', async () => {
    try {
      await whileBusy([revoke], () => call('sites.revoke', { origin: site.origin }));
    } catch (error) {
      toast(errorText(error), 'error');
      return;
    }
    toast(t('sitesRevoked', [site.originDisplay]));
    if (state.tab === 'settings' && revoke.isConnected) renderSettings();
  });
  return el('li', { className: 'list-row' },
    el('div', { className: 'grow' },
      el('div', { className: 'row-title', text: site.originDisplay }),
      site.idn ? el('div', { className: 'hint hint-warn', text: t('sitesIdn', [site.origin]) }) : null,
      el('div', { className: 'muted small', text: t('sitesGranted', [formatTime(site.grantedAt)]) })),
    revoke);
}

function sitesSection(result) {
  let content;
  if (result.status === 'rejected') content = notice('warn', errorText(result.reason));
  else if (result.value.sites.length === 0) content = el('p', { className: 'muted small', text: t('sitesNone') });
  else content = el('ul', { className: 'list' }, ...result.value.sites.map(siteRow));
  return section(t('settingsSitesTitle'), t('settingsSitesLead'), [content]);
}

// Each language is listed by its own name; the choice is a UI preference in storage.local.
function languageSection() {
  const current = currentLanguage();
  const message = messageLine();
  const picker = el('select', { className: 'input select', attrs: { name: 'language', 'aria-label': t('settingsLanguageTitle') } },
    ...SUPPORTED_LANGUAGES.map((code) => el('option', {
      text: LANGUAGE_NAMES[code], attrs: { value: code, lang: code, dir: 'auto' },
    })));
  picker.value = current;
  picker.addEventListener('change', async () => {
    const language = picker.value;
    if (!SUPPORTED_LANGUAGES.includes(language) || language === current) return;
    message.clear();
    try {
      await whileBusy([picker], () => call('settings.set', { language }));
    } catch (error) {
      picker.value = current;
      message.show(errorText(error));
      return;
    }
    await loadLocale(language);
    document.title = t('appName');
    renderWallet();
  });
  return section(t('settingsLanguageTitle'), t('settingsLanguageLead'), [picker, message.node]);
}

function aboutSection() {
  return section(t('settingsAboutTitle'), null, [
    kvList([
      [t('aboutVersion'), WALLET_VERSION],
      [t('aboutChannel'), RELEASE_CHANNEL],
      [t('aboutQnet'), t('qnetNetwork', [QNET.NETWORK, QNET.CHAIN_ID])],
      [t('aboutSolana'), t('solanaCluster', [SOLANA.CLUSTER])],
      [t('aboutSigning'), t(state.status?.signingEnabled === false ? 'aboutSigningOff' : 'aboutSigningOn')],
    ]),
    button(t('aboutWebsite'), () => openTab(QNET.EXPLORER_API), { kind: 'ghost', action: 'website' }),
  ]);
}

/**
 * The activation code (owner, 06.10: moved from the Activate tab, beside the recovery phrase and the private key): one
 * plain row, the code masked with Show and Copy, no warning and no timer. activation.copy gives it (no password: the
 * unlocked session, decision 33); the page holds it only while Settings is shown. A copy leaves the clipboard after
 * TIMINGS.CLIPBOARD_CLEAR_MS if nothing was copied since and the popup is still open, silently.
 * @param {string} masked
 * @returns {{node: Element, start: () => void}} start: called once the section is on screen
 */
function codeSection(masked) {
  const box = el('div', { className: 'code-box mono', text: masked, attrs: { dir: 'ltr' } });
  const message = messageLine();
  const show = button(t('codeShow'), null, { action: 'show-code' });
  const copy = button(t('codeCopy'), null, { action: 'copy-code' });
  let code = null;
  const read = async () => {
    if (code === null) code = (await whileBusy([show, copy], () => call('activation.copy'))).code;
    return code;
  };
  show.addEventListener('click', async () => {
    message.clear();
    try {
      box.textContent = await read();
    } catch (error) {
      if (box.isConnected) message.show(errorText(error));
      return;
    }
    box.classList.add('revealed');
    show.classList.add('hidden');
  });
  copy.addEventListener('click', async () => {
    message.clear();
    let value;
    try {
      value = await read();
    } catch (error) {
      if (box.isConnected) message.show(errorText(error));
      return;
    }
    try {
      await copyText(value, { clearAfterMs: TIMINGS.CLIPBOARD_CLEAR_MS });
    } catch {
      message.show(t('copyFailed'));
      return;
    }
    toast(t('copied'), 'info');
  });
  return {
    node: section(t('codeLabel'), null, [el('div', { className: 'code-row' }, box, actionsRow(show, copy)), message.node]),
    start() {
      onDispose(() => {
        code = null;
        box.textContent = masked;
        box.classList.remove('revealed');
      });
    },
  };
}

// What an earlier version of the extension left in this browser (M-4), offered for removal while it is there (kit
// earlierRemoval: once a vault of this version exists, only the user's confirmation removes it).
function earlierSection() {
  return section(t('earlierTitle'), t('earlierLead'), [earlierRemoval({
    onRemoved: () => {
      if (state.status) state.status = { ...state.status, earlier: false };
      toast(t('earlierRemoved'), 'success');
      if (state.screen === 'wallet' && state.tab === 'settings') renderSettings();
    },
  })]);
}

/**
 * Auto-lock (5/15/30/60 min or Never), connected sites (sites.list / sites.revoke), reveal phrase, private key, the
 * activation code (once activation.lookup names one), change password, language, about (version), what an earlier
 * version left (while it is there), delete wallet (typed DELETE + password).
 * @returns {Promise<void>}
 */
async function renderSettings() {
  const isCurrent = showTab(loadingBlock());
  const [settings, sites] = await Promise.allSettled([call('settings.get'), call('sites.list')]);
  if (!isCurrent()) return;
  // the code's row takes this place when the lookup names a code; Settings never waits for it
  const codeSlot = el('div', { className: 'hidden' });
  const shown = showTab(el('div', { className: 'stack settings' },
    autoLockSection(settings),
    sitesSection(sites),
    section(t('settingsPhraseTitle'), t('settingsPhraseLead'), [
      button(t('settingsPhraseButton'), () => renderReveal(), { action: 'reveal-phrase' })]),
    section(t('settingsKeyTitle'), t('settingsKeyLead'), [
      button(t('settingsKeyButton'), () => renderExportKey(), { action: 'export-key' })]),
    codeSlot,
    section(t('settingsPasswordTitle'), t('settingsPasswordLead'), [
      button(t('settingsPasswordButton'), () => renderChangePassword(), { action: 'change-password' })]),
    languageSection(),
    aboutSection(),
    state.status?.earlier === true ? earlierSection() : null,
    section(t('settingsDeleteTitle'), t('settingsDeleteLead'), [
      button(t('settingsDeleteButton'), () => renderDelete(), { kind: 'danger', action: 'delete-wallet' })], 'danger-zone')));
  call('activation.lookup').then((lookup) => {
    const masked = lookupCodeMasked(lookup);
    if (!shown() || masked === null) return;
    const code = codeSection(masked);
    codeSlot.replaceWith(code.node);
    code.start();
  }, (error) => log.warn('activation lookup failed', error?.code));
}

/**
 * The warning and the password → vault.reveal → the phrase at once (showPhrase).
 * @returns {void}
 */
function renderReveal() {
  const password = passwordInput('password', t('passwordPlaceholder'));
  const message = messageLine();
  const back = button(t('back'), () => renderSettings(), { action: 'back' });
  const next = button(t('revealContinue'), null, { kind: 'primary', action: 'reveal' });
  const isCurrent = showTab(el('div', { className: 'stack' },
    heading(t('revealTitle')),
    notice('danger', t('revealWarn')),
    field(t('passwordLabel'), password),
    message.node,
    actionsRow(back, next)));
  const submit = async () => {
    const value = password.value;
    password.value = '';
    if (value === '') {
      message.show(t('lockEnterPassword'));
      return;
    }
    message.clear();
    let result;
    try {
      result = await whileBusy([next, back], () => call('vault.reveal', { password: value }));
    } catch (error) {
      if (isCurrent()) message.show(errorText(error));
      return;
    }
    if (isCurrent()) showPhrase(result.mnemonic);
  };
  next.addEventListener('click', submit);
  onEnter(password, submit);
}

// The phrase, shown at once after the password (owner, 06.10), then Copy and Done: no press-and-hold, no timer and no
// clipboard text. A copy leaves the clipboard after TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS if nothing was copied since and this
// popup is still open (silently), and when the wallet is deleted; the phrase leaves the page with the screen.
function showPhrase(mnemonic) {
  showSecret({ text: phraseText(mnemonic), copyText: mnemonic, title: t('revealTitle'), className: 'phrase mono revealed',
    copyAction: 'copy-phrase', copiedText: t('phraseCopied') });
}

// One exported secret on screen with its Copy button and Done (showPhrase, showPrivateKey).
function showSecret({ text, copyText: value, title, className, copyAction, copiedText }) {
  let secret = value;
  const copied = messageLine();
  const copy = button(t('copy'), async () => {
    if (secret === null) return;
    try {
      await copyText(secret, { clearAfterMs: TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS, untilFocused: true });
    } catch {
      copied.show(t('copyFailed'));
      return;
    }
    copied.show(copiedText, 'info');
  }, { action: copyAction });
  showTab(el('div', { className: 'stack' },
    heading(title),
    el('div', { className, text, attrs: { 'aria-live': 'off', dir: 'ltr' } }),
    copied.node,
    actionsRow(copy, button(t('done'), () => renderSettings(), { kind: 'primary', action: 'done' }))));
  onDispose(() => {
    secret = null;
  });
}

/**
 * Export the private key (owner, 06.10: as the recovery phrase is exported): the account (QNet or Solana), the warning
 * and the password → vault.exportKey → the key at once (showPrivateKey). The same protection as the phrase; the key is
 * never logged, kept or sent anywhere, and leaves the page when the screen goes.
 * @param {'qnet'|'solana'} [network]
 * @returns {void}
 */
function renderExportKey(network = state.network) {
  let account = network === 'solana' ? 'solana' : 'qnet';
  const password = passwordInput('password', t('passwordPlaceholder'));
  const message = messageLine();
  const note = el('p', { className: 'muted small' });
  const showNote = () => {
    note.textContent = t(account === 'qnet' ? 'exportQnetNote' : 'exportSolanaNote');
  };
  const choice = segmented([['qnet', t('networkQnet')], ['solana', t('networkSolana')]], account, (value) => {
    account = value;
    showNote();
  }, t('exportAccount'));
  showNote();
  const back = button(t('back'), () => renderSettings(), { action: 'back' });
  const next = button(t('revealContinue'), null, { kind: 'primary', action: 'export' });
  const isCurrent = showTab(el('div', { className: 'stack' },
    heading(t('exportTitle')),
    notice('danger', t('exportWarn')),
    field(t('exportAccount'), choice),
    note,
    field(t('passwordLabel'), password),
    message.node,
    actionsRow(back, next)));
  const submit = async () => {
    const value = password.value;
    password.value = '';
    if (value === '') {
      message.show(t('lockEnterPassword'));
      return;
    }
    message.clear();
    let result;
    try {
      result = await whileBusy([next, back], () => call('vault.exportKey', { password: value, network: account }));
    } catch (error) {
      if (isCurrent()) message.show(errorText(error));
      return;
    }
    if (isCurrent() && result?.network === account) showPrivateKey(result);
  };
  next.addEventListener('click', submit);
  onEnter(password, submit);
}

// The exported key, shown at once after the password, then Copy and Done, as the phrase (showSecret).
function showPrivateKey({ privateKey }) {
  showSecret({ text: privateKey, copyText: privateKey, title: t('exportTitle'), className: 'code-box key-box mono revealed',
    copyAction: 'copy-key', copiedText: t('exportCopied') });
}

function renderChangePassword() {
  const current = passwordInput('password');
  const fresh = newPasswordFields(core);
  const message = messageLine();
  const back = button(t('back'), () => renderSettings(), { action: 'back' });
  const save = button(t('passwordSave'), null, { kind: 'primary', action: 'save-password' });
  const view = el('div', { className: 'stack' },
    heading(t('settingsPasswordTitle')),
    field(t('passwordCurrent'), current),
    ...fresh.nodes,
    message.node,
    actionsRow(back, save));
  const isCurrent = showTab(view);
  save.addEventListener('click', async () => {
    message.clear();
    const password = current.value;
    if (password === '') {
      message.show(t('lockEnterPassword'));
      return;
    }
    const newPassword = fresh.read(message);
    if (newPassword === null) return;
    wipeInputs(view);
    fresh.refresh();
    try {
      await whileBusy([save, back], () => call('vault.changePassword', { password, newPassword }));
    } catch (error) {
      if (isCurrent()) message.show(errorText(error));
      return;
    }
    if (!isCurrent()) return;
    renderSettings();
    toast(t('passwordChanged'), 'success');
  });
}

/**
 * Delete wallet: typed DELETE and the password.
 * @returns {void}
 */
function renderDelete() {
  const confirmation = textInput({ name: 'confirm', placeholder: WIPE_WORD, maxLength: 16, ltr: true });
  const password = passwordInput('password', t('passwordPlaceholder'));
  const message = messageLine();
  const back = button(t('back'), () => renderSettings(), { action: 'back' });
  const wipe = button(t('deleteButton'), null, { kind: 'danger', action: 'confirm-delete', disabled: true });
  const update = () => {
    wipe.disabled = !(confirmation.value === WIPE_WORD && password.value !== '');
  };
  confirmation.addEventListener('input', update);
  password.addEventListener('input', update);
  const view = el('div', { className: 'stack' },
    heading(t('deleteTitle')),
    notice('danger', t('deleteWarn')),
    field(t('deleteTypeLabel', [WIPE_WORD]), confirmation),
    field(t('passwordLabel'), password),
    message.node,
    actionsRow(back, wipe));
  const isCurrent = showTab(view);
  wipe.addEventListener('click', async () => {
    if (confirmation.value !== WIPE_WORD || password.value === '') return;
    const value = password.value;
    wipeInputs(view);
    try {
      await whileBusy([wipe, back], () => call('vault.wipe', { password: value, confirm: WIPE_WORD }));
    } catch (error) {
      update();
      if (isCurrent()) message.show(errorText(error));
      return;
    }
    // the 'wiped' event usually got here first; either way the clipboard is emptied before the reload (R16)
    clearPageStorage();
    await wipeAndReload();
  });
}

boot();
