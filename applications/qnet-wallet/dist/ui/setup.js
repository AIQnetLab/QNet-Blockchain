// Onboarding tab: create (phrase generated here, backed up by typing words back) or import. The phrase
// is handed to the worker once and then erased from the page (R11); the success screen stays until the user
// presses its button, which closes the tab (owner, 28.09: nothing closes by itself).
// The new phrase is copied only by its own Copy button, with the warning next to it; there is no download.
// While the wallet an earlier version of this extension kept is in this browser (M-4), the first screen offers to unlock
// it with its password and move it into this version (vault.migrate), or to use the recovery phrase instead (Import).
import * as core from '../lib/qnet-core.js';
import { DEFAULT_LANGUAGE, TIMINGS, languageForTag } from '../background/config.js';
import {
  call, clear, clearCopiedNow, clearPageStorage, copyText, el, loadLocale, log, onWalletEvent, refuseAutoFocus, refuseFramed, t,
  wipeInputs,
} from './common.js';
import {
  addressCopy, button, checkbox, countdown, earlierRemoval, errorCode, errorText, field, heading, kvList, messageLine,
  newPasswordFields, notice, noticeList, onEnter, passwordInput, textArea, textInput, whileBusy,
} from './kit.js';

refuseFramed();
// no field takes the cursor on its own (owner, 06.10)
refuseAutoFocus();
// The frozen page contract lets each page link popup.css only; the setup layout is added here.
document.head.append(el('link', { attrs: { rel: 'stylesheet', href: 'setup.css' } }));

const WORDS_TO_VERIFY = 3;
const NEW_WALLET_WORDS = 12;
// The word grid is never selected, copied, cut or dragged out of the page: the Copy button is the only copy (R11, R14).
const NO_COPY_EVENTS = ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'];

// A phrase left in this tab this long without a key press or a click is dropped (R2-ESM-07).
const IDLE_FORGET_MS = 10 * 60 * 1000;
// The revealed word grid hides itself after this long: time to write the words down, then "Show the words"
// again (the popup's reveal hides after TIMINGS.REVEAL_AUTO_HIDE_MS; writing 24 words takes longer).
const WORDS_VISIBLE_MS = Math.max(TIMINGS.REVEAL_AUTO_HIDE_MS, 2 * 60 * 1000);

const root = document.getElementById('app');
// The phrase being set up; it exists only between generation (or import) and the worker's answer. earlierPassword: the
// earlier version's password, checked, until the new password moves that wallet (vault.migrate).
const pending = { words: null, earlierPassword: null };
// The wallet an earlier version kept is in this browser (vault.status earlier), and the backoff it reported.
let earlierWallet = false;
let backoffUntil = null;
// How the screen shown now hides the phrase or password it holds (the word grid, a typed phrase), for the
// screen lock, a hidden tab and the grid's auto-hide (R2-ESM-07, as the popup's reveal).
let hideSecrets = null;
let revealTimer = null;
let idleTimer = null;

function show(node) {
  hideSecrets = null;
  clearTimeout(revealTimer);
  wipeInputs(root);
  clear(root);
  root.append(el('div', { className: 'setup-shell' },
    el('header', { className: 'setup-header' },
      el('img', { className: 'brand-mark', attrs: { src: '../icons/icon-128.png', alt: '' } }),
      el('span', { className: 'brand-name', text: t('appName') })),
    el('section', { className: 'setup-card' }, node)));
}

function forget() {
  pending.words = null;
  pending.earlierPassword = null;
  wipeInputs(root);
}

const actionsRow = (...buttons) => el('div', { className: 'row actions' }, ...buttons);

function busyView(text) {
  return el('div', { className: 'loading' },
    el('div', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'muted', text }));
}

async function closeTab() {
  forget();
  clear(root);
  try {
    const tab = await chrome.tabs.getCurrent();
    if (Number.isSafeInteger(tab?.id)) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch (error) {
    log.warn('tab not closed', error?.name);
  }
  window.close();
}

/** Positions (0-based, ascending) of `count` distinct words, chosen with the CSPRNG. */
function pickPositions(total, count) {
  const chosen = new Set();
  const sample = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / total) * total;
  while (chosen.size < count) {
    crypto.getRandomValues(sample);
    if (sample[0] < limit) chosen.add(sample[0] % total);
  }
  return [...chosen].sort((a, b) => a - b);
}

const normalizeWord = (word) => word.normalize('NFKD').trim().toLowerCase();

/**
 * Entry. vault.status → exists: a notice that setup is closed while a wallet exists (the only way is
 * Settings → Delete wallet) and nothing else; otherwise the welcome screen.
 * @returns {Promise<void>}
 */
async function boot() {
  // what an earlier version kept in this page's storage (a copy of its password among it) goes at once (M-4)
  clearPageStorage();
  onWalletEvent((event) => {
    if (event === 'wiped') location.reload();
    // the OS screen locked (the worker broadcasts it whether or not a wallet is unlocked)
    else if (event === 'locked') hideSecrets?.();
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(idleTimer);
    clearTimeout(revealTimer);
    forget();
    clear(root);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hideSecrets?.();
  });
  // another window has the focus (a screen share or recording may still show this one): the word grid goes back
  // behind "Show the words" and a typed phrase is cleared, as the popup's reveal hides (R3-EXT-UI-01)
  window.addEventListener('blur', () => hideSecrets?.());
  for (const type of ['keydown', 'pointerdown']) window.addEventListener(type, restartIdle, { capture: true });
  restartIdle();
  let language = languageForTag(globalThis.navigator?.language) ?? DEFAULT_LANGUAGE;
  try {
    const settings = await call('settings.get');
    if (typeof settings?.language === 'string') language = settings.language;
  } catch (error) {
    log.warn('settings unavailable', error?.code);
  }
  await loadLocale(language);
  document.title = t('setupPageTitle');
  await start();
}

async function start() {
  show(busyView(t('loading')));
  let status;
  try {
    status = await call('vault.status');
  } catch (error) {
    show(el('div', { className: 'stack' }, notice('danger', errorText(error)), button(t('retry'), () => start(), { action: 'retry' })));
    return;
  }
  earlierWallet = status.earlier === true;
  backoffUntil = Number.isSafeInteger(status.backoffUntil) ? status.backoffUntil : null;
  if (status.exists) renderExists();
  else renderWelcome();
}

// A phrase nobody touched for IDLE_FORGET_MS is dropped: whatever the screen shows is hidden (the word grid, a
// phrase typed or pasted into Import, a password: R3-EXT-UI-01), and a phrase being set up is forgotten, so the
// next step starts from the welcome screen.
function restartIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    hideSecrets?.();
    if (pending.words === null && pending.earlierPassword === null) return;
    forget();
    renderWelcome();
  }, IDLE_FORGET_MS);
}

// Empties the current clipboard after a phrase was pasted from it (best effort, while this tab has the focus:
// R3-EXT-UI-02, as the mobile app's clearPastedPhrase). It cannot reach a clipboard history (Windows Win+V), a
// clipboard synced to other devices, a clipboard manager or the X11 primary selection, which may keep the words;
// the screen keeps to one short line (owner, 28.09).
function clearPastedPhrase() {
  copyText('').catch((error) => log.warn('clipboard not cleared', error?.name));
}

function renderExists() {
  forget();
  show(el('div', { className: 'stack' },
    heading(t('setupExistsTitle'), t('setupExistsLead')),
    notice('info', t('setupExistsHow')),
    button(t('close'), () => closeTab(), { kind: 'primary', action: 'close' })));
}

/**
 * Create or import; while an earlier version's wallet is in this browser, renderEarlier in its place.
 * @returns {void}
 */
function renderWelcome() {
  forget();
  if (earlierWallet) {
    renderEarlier();
    return;
  }
  show(el('div', { className: 'stack' },
    heading(t('setupWelcomeTitle')),
    el('div', { className: 'choices' },
      el('div', { className: 'choice' },
        el('h3', { text: t('setupCreateChoice') }),
        el('p', { className: 'muted small', text: t('setupCreateChoiceLead') }),
        button(t('setupCreateChoice'), () => renderCreate(), { kind: 'primary', action: 'create', block: true })),
      el('div', { className: 'choice' },
        el('h3', { text: t('setupImportChoice') }),
        el('p', { className: 'muted small', text: t('setupImportChoiceLead') }),
        button(t('setupImportChoice'), () => renderImport(), { action: 'import', block: true }))),
    el('p', { className: 'muted small center', text: t('setupFooter') })));
}

/**
 * The first screen while the wallet an earlier version of this extension kept is in this browser (M-4): unlock it with its
 * password to move it into this version, use the recovery phrase instead (Import), or create a new wallet. Nothing of the
 * earlier wallet is removed from here.
 * @returns {void}
 */
function renderEarlier() {
  show(el('div', { className: 'stack' },
    heading(t('setupEarlierTitle'), t('setupEarlierLead')),
    button(t('setupEarlierUnlock'), () => renderEarlierPassword(), { kind: 'primary', action: 'earlier-unlock', block: true }),
    button(t('setupEarlierUsePhrase'), () => renderImport(), { action: 'import', block: true }),
    button(t('setupCreateChoice'), () => renderCreate(), { kind: 'ghost', action: 'create', block: true }),
    el('p', { className: 'muted small center', text: t('setupFooter') })));
}

/**
 * The earlier version's password (hardened; the backoff of unlock), checked by vault.migrate without a new password:
 * nothing is written and a wrong password removes nothing. Then the new password (renderPassword 'migrate').
 * @param {string|null} [failure] why the user is back here
 * @returns {void}
 */
function renderEarlierPassword(failure = null) {
  pending.earlierPassword = null;
  const password = passwordInput('earlier-password', t('passwordPlaceholder'));
  const message = messageLine();
  if (failure) message.show(failure);
  const back = button(t('back'), () => renderWelcome(), { action: 'back' });
  const next = button(t('continue'), null, { kind: 'primary', action: 'earlier-continue' });
  show(el('div', { className: 'stack' },
    heading(t('setupEarlierPasswordTitle'), t('setupEarlierPasswordLead')),
    field(t('passwordLabel'), password),
    message.node,
    actionsRow(back, next)));
  let stopWait = () => {};
  const waitUntil = (until) => {
    stopWait();
    next.disabled = true;
    stopWait = countdown(until, (seconds) => message.show(t('err_BACKOFF_wait', [seconds]), 'warn'), () => {
      next.disabled = false;
      message.clear();
    });
  };
  const submit = async () => {
    if (next.disabled) return;
    const value = password.value;
    password.value = '';
    if (value === '') {
      message.show(t('lockEnterPassword'));
      return;
    }
    message.show(t('setupEarlierChecking'), 'info');
    try {
      await whileBusy([next, back], () => call('vault.migrate', { password: value }));
    } catch (error) {
      if (!password.isConnected) return;
      const code = errorCode(error);
      if (code === 'BACKOFF' && Number.isSafeInteger(error.retryAfterMs)) waitUntil(Date.now() + error.retryAfterMs);
      else if (code === 'VAULT_CORRUPT') renderEarlierUnreadable();
      else if (code === 'VAULT_EXISTS') renderExists();
      else if (code === 'NO_VAULT') start();
      else message.show(errorText(error));
      return;
    }
    if (!password.isConnected) return;
    stopWait();
    pending.earlierPassword = value;
    renderPassword('migrate');
  };
  next.addEventListener('click', submit);
  onEnter(password, submit);
  if (backoffUntil !== null && backoffUntil > Date.now()) waitUntil(backoffUntil);
  hideSecrets = () => {
    password.value = '';
  };
}

// The earlier wallet opens but holds no recovery phrase this version takes: its phrase goes through Import instead.
function renderEarlierUnreadable() {
  forget();
  show(el('div', { className: 'stack' },
    heading(t('setupEarlierTitle')),
    notice('warn', t('setupEarlierUnreadable')),
    actionsRow(button(t('back'), () => renderWelcome(), { action: 'back' }),
      button(t('setupEarlierUsePhrase'), () => renderImport(), { kind: 'primary', action: 'import' }))));
}

/**
 * Generates entropy with qnet-core generateEntropy(12) in this page, shows the words for writing down (with a
 * Copy button and its warning while they are shown; no download), then renderVerifyBackup.
 * @param {string|null} [failure] why the user is back here (a failed verification)
 * @returns {void}
 */
function renderCreate(failure = null) {
  if (pending.words === null) {
    const entropy = core.generateEntropy(NEW_WALLET_WORDS);
    try {
      pending.words = core.entropyToMnemonic(entropy).split(' ');
    } finally {
      entropy.fill(0);
    }
  }
  const words = pending.words;
  const wordsBox = el('div', { className: 'words-cover' });
  const next = button(t('continue'), () => renderVerifyBackup(words), { kind: 'primary', action: 'continue', disabled: true });
  const written = checkbox('written', t('setupWrittenAck'), (checked) => {
    next.disabled = !checked;
  });
  written.input.disabled = true;
  const reveal = button(t('setupRevealWords'), () => {
    clear(wordsBox);
    wordsBox.className = 'words-shown';
    const grid = el('ol', { className: 'word-grid' },
      ...words.map((word) => el('li', {}, el('span', { className: 'word mono', text: word }))));
    for (const type of NO_COPY_EVENTS) grid.addEventListener(type, (event) => event.preventDefault());
    wordsBox.append(grid, phraseCopy(words));
    written.input.disabled = false;
    // hidden again on a screen lock or a hidden tab, and after the reveal time: "Show the words" again
    hideSecrets = () => renderCreate(failure);
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => hideSecrets?.(), WORDS_VISIBLE_MS);
  }, { kind: 'primary', action: 'reveal-words' });
  wordsBox.append(reveal);
  show(el('div', { className: 'stack' },
    heading(t('setupCreateTitle'), t('setupCreateLead', [words.length])),
    failure ? notice('danger', failure) : null,
    notice('warn', t('setupWordsWarn')),
    wordsBox,
    written.node,
    actionsRow(button(t('back'), () => renderWelcome(), { action: 'back' }), next)));
}

/**
 * The Copy button of the shown words (an explicit click only) with the warning next to it: the phrase leaves the
 * clipboard after TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS if nothing was copied since (or when this tab gets the focus back
 * after that), and at the end of setup.
 * @param {string[]} words
 * @returns {HTMLElement}
 */
function phraseCopy(words) {
  const message = messageLine();
  const copy = button(t('copy'), async () => {
    try {
      await copyText(words.join(' '), { clearAfterMs: TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS, untilFocused: true });
    } catch {
      message.show(t('copyFailed'));
      return;
    }
    message.show(t('phraseCopied'), 'info');
  }, { action: 'copy-phrase' });
  return el('div', { className: 'stack' },
    notice('warn', t('phraseCopyWarn', [Math.round(TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS / 1000)])),
    copy,
    message.node);
}

/**
 * Asks for several words by position in hardened inputs; any mismatch returns to the words.
 * @param {string[]} words
 * @returns {void}
 */
function renderVerifyBackup(words) {
  // The words screen's reveal timer must not reach this screen, and a blur or a hidden tab (looking at the written
  // copy in another window) must not wipe what is being typed: only the idle timeout forgets it (owner, 28.09).
  clearTimeout(revealTimer);
  hideSecrets = null;
  const positions = pickPositions(words.length, WORDS_TO_VERIFY);
  const inputs = positions.map((position) => textInput({ name: `word-${position + 1}`, maxLength: 32, ltr: true }));
  const check = button(t('setupVerifyButton'), null, { kind: 'primary', action: 'verify' });
  show(el('div', { className: 'stack' },
    heading(t('setupVerifyTitle'), t('setupVerifyLead')),
    ...positions.map((position, index) => field(t('setupWordN', [position + 1]), inputs[index])),
    actionsRow(button(t('setupShowWordsAgain'), () => renderCreate(), { action: 'back' }), check)));
  const verify = () => {
    const matches = positions.every((position, index) => normalizeWord(inputs[index].value) === words[position]);
    for (const input of inputs) input.value = '';
    if (!matches) {
      renderCreate(t('setupVerifyMismatch'));
      return;
    }
    renderPassword('create');
  };
  check.addEventListener('click', verify);
  onEnter(inputs[inputs.length - 1], verify);
}

/**
 * One hardened textarea (or per-word inputs); validity checked with qnet-core validateMnemonic on the
 * canonical form before the password step.
 * @param {string|null} [failure]
 * @returns {void}
 */
function renderImport(failure = null) {
  forget();
  const input = textArea({ name: 'phrase', rows: 4, placeholder: t('setupImportPlaceholder') });
  const message = messageLine();
  if (failure) message.show(failure);
  let pasted = false;
  // a pasted phrase leaves the clipboard as soon as it is in the field, and again on every way out of this step
  input.addEventListener('paste', () => {
    pasted = true;
    setTimeout(clearPastedPhrase, 0);
  });
  const leave = () => {
    if (pasted) clearPastedPhrase();
  };
  const next = button(t('continue'), null, { kind: 'primary', action: 'continue' });
  show(el('div', { className: 'stack' },
    heading(t('setupImportTitle'), t('setupImportLead')),
    field(t('setupImportLabel'), input, t('setupImportHint')),
    message.node,
    actionsRow(button(t('back'), () => {
      leave();
      renderWelcome();
    }, { action: 'back' }), next)));
  next.addEventListener('click', () => {
    const typed = input.value;
    leave();
    let valid = false;
    try {
      valid = core.validateMnemonic(typed);
    } catch {
      valid = false;
    }
    if (!valid) {
      message.show(t('setupImportInvalid'));
      return;
    }
    const canonical = core.canonicalizeMnemonic(typed);
    input.value = '';
    pending.words = canonical.split(' ');
    renderPassword('import');
  });
  // a pasted phrase does not wait in a hidden, unfocused, idle or screen-locked tab
  hideSecrets = () => {
    input.value = '';
    leave();
  };
}

// The step each kind of the password screen goes back to, and its button.
const PASSWORD_STEPS = Object.freeze({
  create: { back: () => renderCreate(), save: 'setupCreateButton' },
  import: { back: () => renderImport(), save: 'setupImportButton' },
  migrate: { back: () => renderEarlierPassword(), save: 'setupEarlierMoveButton' },
});

/**
 * Password + confirmation (hardened) under the rule of both wallets: at least core.PASSWORD_MIN_LENGTH characters,
 * typed twice (kit.newPasswordFields and its live check). 'migrate': the new password of the wallet an earlier version
 * kept, whose password renderEarlierPassword checked.
 * @param {'create'|'import'|'migrate'} kind
 * @param {string|null} [failure] the previous attempt's error
 * @returns {void}
 */
function renderPassword(kind, failure = null) {
  const fresh = newPasswordFields(core);
  const message = messageLine();
  if (failure) message.show(failure);
  const step = PASSWORD_STEPS[kind];
  const back = button(t('back'), () => step.back(), { action: 'back' });
  const save = button(t(step.save), null, { kind: 'primary', action: 'submit' });
  show(el('div', { className: 'stack' },
    heading(t('setupPasswordTitle'), t('setupPasswordLead')),
    ...fresh.nodes,
    noticeList('info', null, [t('setupPasswordTip1'), t('setupPasswordTip2')]),
    message.node,
    actionsRow(back, save)));
  const proceed = () => {
    message.clear();
    const password = fresh.read(message);
    if (password === null) return;
    fresh.first.value = '';
    fresh.second.value = '';
    if (kind === 'migrate') {
      if (pending.earlierPassword === null) renderWelcome();
      else submitMigrate(password);
      return;
    }
    if (pending.words === null) {
      renderWelcome();
      return;
    }
    submit(kind, pending.words.join(' '), password);
  };
  save.addEventListener('click', proceed);
  onEnter(fresh.second, proceed);
  hideSecrets = () => {
    fresh.first.value = '';
    fresh.second.value = '';
    fresh.refresh();
  };
}

/**
 * vault.create or vault.import; on failure stays on the step with the phrase still available
 * (EXT-SEC-M2); on success finish().
 * @param {'create'|'import'} kind
 * @param {string} mnemonic
 * @param {string} password
 * @returns {Promise<void>}
 */
async function submit(kind, mnemonic, password) {
  show(busyView(t('setupEncrypting')));
  let result;
  try {
    result = await call(kind === 'create' ? 'vault.create' : 'vault.import', { mnemonic, password });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'VAULT_EXISTS') renderExists();
    else if (code === 'INVALID_MNEMONIC' && kind === 'import') renderImport(errorText(error));
    else renderPassword(kind, errorText(error));
    return;
  }
  finish(result);
}

/**
 * vault.migrate with the checked earlier password and the new one: the earlier wallet becomes this version's vault, and
 * the worker removes its copy once that vault was read back; on success finish().
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
async function submitMigrate(newPassword) {
  show(busyView(t('setupEncrypting')));
  let result;
  try {
    result = await call('vault.migrate', { password: pending.earlierPassword, newPassword });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'VAULT_EXISTS') renderExists();
    else if (code === 'VAULT_CORRUPT') renderEarlierUnreadable();
    else if (code === 'BAD_PASSWORD' || code === 'BACKOFF' || code === 'NO_VAULT') renderEarlierPassword(errorText(error));
    else renderPassword('migrate', errorText(error));
    return;
  }
  earlierWallet = false;
  finish(result);
}

/**
 * Drops every reference to the phrase and password, wipes inputs and the DOM, empties the clipboard of a phrase
 * its Copy button put there and nothing replaced, and shows the two addresses (a click copies one). The screen stays
 * until the user presses Done, which closes the tab: no timer closes it (owner, 28.09). While what an earlier version
 * kept is still in this browser (a wallet imported or created beside it), it offers to remove it, behind one
 * confirmation (kit.earlierRemoval).
 * @param {{qnet: string, solana: string}} addresses
 * @returns {void}
 */
function finish(addresses) {
  forget();
  clearCopiedNow();
  const earlier = earlierWallet ? el('div', { className: 'card stack' },
    el('h3', { text: t('earlierTitle') }),
    el('p', { className: 'muted small', text: t('earlierLead') })) : null;
  earlier?.append(earlierRemoval({
    onRemoved: () => {
      earlierWallet = false;
      earlier.replaceChildren(notice('success', t('earlierRemoved')));
    },
  }));
  show(el('div', { className: 'stack' },
    heading(t('setupDoneTitle')),
    kvList([
      [t('qnetAddress'), addressCopy(addresses.qnet, t('qnetAddress'))],
      [t('solanaAddress'), addressCopy(addresses.solana, t('solanaAddress'))],
    ]),
    notice('info', t('setupDoneOpen')),
    earlier,
    button(t('done'), () => closeTab(), { kind: 'primary', action: 'close' })));
}

boot();
