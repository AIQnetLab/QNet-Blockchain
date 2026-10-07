// Approval window, opened by the worker with ui/approve.html?id=<uuid>. It shows the request's origin
// as the browser reported it (Unicode form plus an IDN warning), never page-supplied names or icons.
// The confirm button arms after TIMINGS.CONFIRM_ARM_MS (CONFIRM_ARM_VALUE_MS for a transaction or a burn), any
// press or key before that starts the wait again, and it accepts only a trusted pointer click whose press
// began after it armed, in a focused window (R2-ERP-02, the mobile useArmedConfirm rule). A confirm names
// the revision of the view it confirms, so the worker never acts on one the page did not draw.
// No request asks for the password: while the wallet is unlocked that armed press is the confirmation; while it is
// locked the window asks to unlock first, then shows the request without asking again. An activation
// (qnet_activateNode) is confirmed the same way (a burn also needs its acknowledgement ticked); the worker burns (or
// reads the wallet's existing activation) and this window stays on the outcome until closed, showing a light node's
// record on the QNet network while it is made. So do a move of the node balance (qnet_claimNodeBalance) and the unlink
// of the light node's device (qnet_unlinkNodeDevice).
import { DEFAULT_LANGUAGE, QNET, TIMINGS, languageForTag } from '../background/config.js';
import {
  DECIMALS, call, clear, clearPageStorage, el, formatUnits, hardenSecretInput, loadLocale, log, onWalletEvent, refuseAutoFocus,
  refuseFramed, t, wipeInputs,
} from './common.js';
import { codeText, errorText, formatAmount, formatDay } from './kit.js';

refuseFramed();
// no field takes the cursor on its own (owner, 06.10)
refuseAutoFocus();

const APPROVAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVIEW_AGAIN = new Set(['FEE_CHANGED', 'NONCE_CHANGED', 'NONCE_UNAVAILABLE']);
// The approvals of qnet_sendTransaction: each signs and sends a transaction.
const TX_KINDS = new Set(['sendTransaction', 'tokenTransfer', 'contractCall']);
const PREVIEW_RETRY_MS = 3000;
const PREVIEW_RETRIES = 5;
// While an earlier transaction of the wallet holds the nonce before this one's, the view is read again this often.
const IN_FLIGHT_RETRY_MS = 4000;
const REFRESH_DEBOUNCE_MS = 150;
// While an activation runs (up to about two minutes) a cheap read keeps the worker awake.
const KEEPALIVE_MS = 20000;

const app = document.getElementById('app');
const approvalId = new URLSearchParams(window.location.search).get('id');

let view = null;
let screenKey = '';
let finished = false;
let busy = false;
let notice = null;
let queuedLine = null;
let armed = null;
let heartbeat = null;
let refreshTimer = null;
let retryTimer = null;
let previewRetries = 0;
let keepalive = null;
let ticker = null;
// approval.get runs one at a time: a second request while one is out runs once after it (R2-EXT-UI-03)
let refreshing = null;
let refreshAgain = false;

function stopActivityTimers() {
  clearInterval(keepalive);
  clearInterval(ticker);
  keepalive = null;
  ticker = null;
}

function closeWindow() {
  finished = true;
  clearInterval(heartbeat);
  clearTimeout(refreshTimer);
  clearTimeout(retryTimer);
  stopActivityTimers();
  armed?.abort();
  wipeInputs(app);
  window.close();
}

function loadStylesheet() {
  // approve.html links only the shared popup.css; this window's own layout is added here
  document.head.append(el('link', { attrs: { rel: 'stylesheet', href: 'approve.css' } }));
}

const qnc = (nano) => formatAmount(nano, DECIMALS.QNC, 'QNC');
const nodeLabel = (nodeType) => t(nodeType === 'super' ? 'nodeSuper' : 'nodeLight');

function row(label, value, valueClass = '') {
  return el('div', { className: 'ap-row' },
    el('span', { className: 'ap-row-label', text: label }),
    el('span', { className: `ap-row-value ${valueClass}`.trim(), text: value }));
}

// A label above a long value that must stay whole and left to right (addresses, mints, signatures).
function block(label, value, valueClass = 'ap-mono') {
  return [el('p', { className: 'ap-label', text: label }), el('p', { className: valueClass, text: value })];
}

function button(text, primary) {
  return el('button', { className: `ap-btn ${primary ? 'ap-btn-primary' : 'ap-btn-secondary'}`, text, attrs: { type: 'button' } });
}

function rejectButton() {
  const reject = button(t('apReject'), false);
  reject.addEventListener('click', (event) => {
    if (event.isTrusted && view !== null) resolve(view.id, false);
  });
  return reject;
}

function originCard(next) {
  return el('section', { className: 'ap-origin', attrs: { 'aria-label': t('apOriginLabel') } },
    el('p', { className: 'ap-label', text: t('apOriginLabel') }),
    el('p', { className: 'ap-origin-host', text: next.originDisplay }),
    next.idn
      ? el('div', { className: 'ap-warning', attrs: { role: 'alert' } },
        el('p', { text: t('apIdnWarning') }),
        el('p', { className: 'ap-mono', text: next.origin }))
      : null);
}

function titleOf(next) {
  if (next.kind !== 'activateNode') return t(`apTitle_${next.kind}`);
  const { mode, nodeType } = next.details;
  if (mode === 'exists') return t('apTitle_activateExists');
  if (mode === 'pending') return t('apTitle_activatePending');
  if (mode === 'unavailable') return t('apTitle_activateUnavailable');
  return t(nodeType === 'super' ? 'apTitle_activate_super' : 'apTitle_activate_light');
}

const queuedText = (next) => (next.queued > 0 ? t('apQueued', [next.queued]) : '');

// Heights of the gap above the actions (approve.css .ap-shift-<n>).
const SHIFT_STEPS = 7;
function randomShift() {
  const sample = new Uint8Array(1);
  const limit = 256 - (256 % SHIFT_STEPS);
  do {
    crypto.getRandomValues(sample);
  } while (sample[0] >= limit);
  return sample[0] % SHIFT_STEPS;
}

// Everything around the kind-specific body: title, origin, notice, actions, queue line. A random gap above the
// actions, drawn again with every view, keeps where Confirm sits unknown in advance, wherever the window opened
// (R4-ERP-01: a page that knows the window's place still cannot aim at the button).
function frame(next, body, actions, title = null) {
  armed?.abort();
  armed = null;
  queuedLine = el('p', { className: 'ap-queued', text: queuedText(next) });
  const parts = [
    el('header', { className: 'ap-header' },
      el('p', { className: 'ap-kicker', text: t(`apKicker_${next.kind}`) }),
      el('h1', { className: 'ap-title', text: title ?? titleOf(next) })),
    originCard(next),
    body,
    notice ? el('p', { className: 'ap-notice', attrs: { role: 'status' }, text: notice }) : null,
    actions ? el('div', { className: `ap-shift ap-shift-${randomShift()}`, attrs: { 'aria-hidden': 'true' } }) : null,
    actions,
    queuedLine,
  ];
  clear(app);
  // append() would print a null as the text "null"
  app.append(...parts.filter((part) => part !== null));
}

async function fetchView() {
  try {
    return await call('approval.get', { id: approvalId });
  } catch (error) {
    if (error.code === 'NOT_FOUND') closeWindow();
    return null;
  }
}

async function refreshOnce() {
  if (finished || busy) return;
  const next = await fetchView();
  if (next === null || finished || busy) return;
  render(next);
}

function refresh() {
  if (refreshing !== null) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      do {
        refreshAgain = false;
        await refreshOnce();
      } while (refreshAgain && !finished);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
}

// Re-renders only when what the user reviews changed, so a heartbeat never resets the unlock password being typed
// or the confirm delay.
function render(next) {
  view = next;
  const key = JSON.stringify([next.kind, next.locked, next.originDisplay, next.idn, next.details, notice]);
  if (key !== screenKey) {
    screenKey = key;
    if (next.locked) renderUnlock(next);
    else renderApproval(next);
  } else if (queuedLine !== null) {
    queuedLine.textContent = queuedText(next);
  }
  if (!finished) schedulePreviewRetry(next);
}

// The language of the wallet (settings.get), else the browser's; English if neither is available.
async function applyLanguage() {
  let language = languageForTag(globalThis.navigator?.language) ?? DEFAULT_LANGUAGE;
  try {
    const settings = await call('settings.get');
    if (typeof settings?.language === 'string') language = settings.language;
  } catch (error) {
    log.warn('settings unavailable', error?.code);
  }
  await loadLocale(language);
  document.title = t('apPageTitle');
}

/**
 * Entry: id from location.search; the wallet's language; approval.get; unlock first when locked; a
 * heartbeat re-sends approval.get every TIMINGS.APPROVAL_HEARTBEAT_MS (keeps the worker alive, refreshes
 * lock state) and closes the window on NOT_FOUND.
 * @returns {Promise<void>}
 */
async function boot() {
  // what an earlier version kept in this extension's web storage (a copy of its password among it) goes at once (M-4)
  clearPageStorage();
  loadStylesheet();
  if (typeof approvalId !== 'string' || !APPROVAL_ID_RE.test(approvalId)) {
    closeWindow();
    return;
  }
  await applyLanguage();
  onWalletEvent((event) => {
    if (event === 'wiped') {
      closeWindow();
      return;
    }
    if (event === 'locked') {
      wipeInputs(app);
      screenKey = '';
    }
    scheduleRefresh();
  });
  window.addEventListener('pagehide', () => wipeInputs(app));
  heartbeat = setInterval(refresh, TIMINGS.APPROVAL_HEARTBEAT_MS);
  await refresh();
}

function passwordField() {
  return hardenSecretInput(el('input', {
    className: 'ap-input',
    attrs: { type: 'password', id: 'ap-password', maxlength: 1024, 'aria-label': t('passwordLabel') },
  }));
}

/**
 * Password field; vault.unlock; then approval.get again (send previews gain nonce and balance), and the request
 * shows with its armed confirm, without asking for the password again. A 'connect' view with
 * details.alreadyGranted resolves approved right after the unlock: the grant exists and typing the password was
 * the consent.
 * @param {import('../background/provider.js').ApprovalView} next
 * @returns {void}
 */
function renderUnlock(next) {
  const input = passwordField();
  const status = el('p', { className: 'ap-status', attrs: { role: 'status' } });
  const unlock = button(t('lockUnlock'), true);
  const submit = async () => {
    if (busy || finished || input.value.length === 0) return;
    const password = input.value;
    input.value = '';
    busy = true;
    unlock.disabled = true;
    status.textContent = t('lockUnlocking');
    try {
      await call('vault.unlock', { password });
    } catch (error) {
      busy = false;
      unlock.disabled = false;
      status.textContent = errorText(error);
      return;
    }
    busy = false;
    screenKey = '';
    await refresh();
  };
  unlock.addEventListener('click', (event) => {
    if (event.isTrusted) submit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.isTrusted) submit();
  });
  frame(next,
    el('section', { className: 'ap-card' },
      el('p', { text: t('apUnlockFirst') }),
      el('label', { className: 'ap-label', text: t('passwordLabel'), attrs: { for: 'ap-password' } }),
      input,
      status),
    el('div', { className: 'ap-actions' }, rejectButton(), unlock));
  // no cursor on its own: the window opens at a site's request, focused, and keystrokes meant for that page would land in
  // the password field (owner, 04.10: only the popup's lock screen takes the cursor)
}

function connectBody() {
  const qnetValue = el('p', { className: 'ap-mono ap-address', text: t('loading') });
  const solanaValue = el('p', { className: 'ap-mono ap-address', text: t('loading') });
  call('wallet.addresses').then((addresses) => {
    qnetValue.textContent = addresses.qnet;
    solanaValue.textContent = addresses.solana;
  }, (error) => {
    if (error.code === 'LOCKED') {
      screenKey = '';
      scheduleRefresh();
    } else {
      qnetValue.textContent = errorText(error);
      solanaValue.textContent = '';
    }
  });
  return el('section', { className: 'ap-card' },
    el('p', { text: t('apConnectIntro') }),
    el('p', { className: 'ap-label', text: t('qnetAddress') }),
    qnetValue,
    el('p', { className: 'ap-label', text: t('solanaAddress') }),
    solanaValue);
}

// Whether the whole message has been in view: the box scrolled to its end, or nothing to scroll. The
// signed text may run far below what the box shows (blank lines, then the real text: R2-ERP-05).
function scrolledToEnd(box) {
  const { scrollHeight, scrollTop, clientHeight } = box;
  if (![scrollHeight, scrollTop, clientHeight].every(Number.isFinite)) return true;
  return scrollHeight - scrollTop - clientHeight <= 2;
}

function messageBody(details) {
  const box = el('pre', { className: 'ap-message', text: details.message, attrs: { dir: 'auto', tabindex: '0' } });
  const lines = details.message.split('\n').length;
  const hint = el('p', { className: 'ap-warn', attrs: { role: 'note' }, text: t('apSignScroll') });
  const body = el('section', { className: 'ap-card' },
    el('p', { text: t('apSignIntro') }),
    box,
    el('p', { className: 'ap-muted', text: `${t('apSignSize', [details.byteLength])} · ${t('apSignLines', [lines])}` }),
    hint);
  // the hint stays until the whole text has been in view
  const seen = () => {
    const end = scrolledToEnd(box);
    hint.className = end ? 'ap-warn ap-hidden' : 'ap-warn';
    return end;
  };
  return { body, box, seen };
}

// The worker's recipient check (qnet.recipientCheck): look-alike of an address this wallet paid, an
// address that only ever sent to it (the poisoning pattern), or a first send (null: not known yet).
function recipientWarning(details) {
  const check = details.recipient;
  if (check === null || typeof check !== 'object') return null;
  const alerts = [
    check.lookalike === true ? el('p', { className: 'ap-error ap-strong', text: t('apLookalike') }) : null,
    check.incomingOnly === true ? el('p', { className: 'ap-error', text: t('apIncomingOnly') }) : null,
  ].filter((node) => node !== null);
  if (alerts.length > 0) return el('div', { className: 'ap-warning', attrs: { role: 'alert' } }, ...alerts);
  if (check.known === true) return null;
  return el('div', { className: 'ap-warning', attrs: { role: 'note' } }, el('p', { text: t('apFirstTime') }));
}

// Earlier sends of this wallet the chain has not taken yet, and a second payment of the same amount to the
// same address (unconfirmed, or sent in the last 30 minutes): this one goes in addition (R2-EXTQ-03).
// The wallet's own records name a second payment even when the archive cannot (R3-EXTQ-01).
function outstandingNotice(details) {
  const duplicate = details.duplicate === true || details.recipient?.recentSame === true;
  const count = Number.isSafeInteger(details.outstanding) ? details.outstanding : 0;
  if (!duplicate && count === 0) return null;
  return el('div', { className: 'ap-warning', attrs: { role: duplicate ? 'alert' : 'note' } },
    duplicate ? el('p', { className: 'ap-error ap-strong', text: t('apDuplicate') }) : null,
    count > 0 ? el('p', { text: t('apOutstanding', [count]) }) : null);
}

// A transaction a node refused that this one takes the place of at its nonce (R5-EXTQ-02): at most one of the two
// applies, so the refused one, should it go through after all, and this one are never both paid.
function replacesNotice(details) {
  const replaced = details.replaces;
  if (!replaced || typeof replaced !== 'object') return null;
  const text = replaced.kind === 'call' ? t('apReplacesRefusedCall', [replaced.to, replaced.nonce])
    : t('apReplacesRefused', [qnc(replaced.amountNano), replaced.to, replaced.nonce]);
  return el('div', { className: 'ap-warning', attrs: { role: 'note' } }, el('p', { text }));
}

// The node admits one transaction per account at a time (the committed nonce + 1): behind an earlier one not in a block
// yet, confirm waits, and the window reads the account again until it is. One short line says it waits.
function inFlightNotice(details) {
  if (details.inFlight !== true) return null;
  return el('div', { className: 'ap-warning', attrs: { role: 'status' } }, el('p', { text: t('apInFlight') }));
}

// Why no balance a send is decided by could be read (the worker's send rule), said as it is: no node answered, the
// balance is not confirmed yet, or a transaction from another device is not confirmed yet.
const BALANCE_PROBLEMS = new Set(['NETWORK', 'BALANCE_UNCONFIRMED', 'BALANCE_FOREIGN_PENDING']);
const problemText = (code) => (BALANCE_PROBLEMS.has(code) ? codeText(code) : null);

// The parts after the amounts that every transaction body shows: nonce, QNC balance, and why confirm may not be
// offered yet.
function accountRows(details, ready, covered) {
  const problem = ready ? null : problemText(details.balanceProblem);
  return [
    row(t('reviewNonce'), ready ? details.nonce : '—'),
    row(t('apBalance'), ready ? qnc(details.balanceNano) : '—'),
    inFlightNotice(details),
    problem !== null ? el('p', { className: 'ap-warn', attrs: { role: 'status' }, text: problem }) : null,
    !ready && problem === null ? el('p', { className: 'ap-muted', text: t('apPreviewPending') }) : null,
    ready && !covered ? el('p', { className: 'ap-error', attrs: { role: 'alert' }, text: t('err_INSUFFICIENT_FUNDS') }) : null,
  ];
}

function transferBody(details) {
  const ready = details.nonce !== null && details.balanceNano !== null;
  const covered = ready && BigInt(details.balanceNano) >= BigInt(details.totalNano);
  const body = el('section', { className: 'ap-card' },
    row(t('reviewNetwork'), t('qnetNetwork', [QNET.NETWORK, QNET.CHAIN_ID])),
    ...block(t('reviewTo'), details.to, 'ap-mono ap-address'),
    recipientWarning(details),
    replacesNotice(details),
    outstandingNotice(details),
    row(t('reviewAmount'), qnc(details.amountNano)),
    row(t('reviewFee'), qnc(details.feeNano)),
    row(t('reviewTotal'), qnc(details.totalNano), 'ap-strong'),
    ...accountRows(details, ready, covered));
  return { body, confirmable: ready && covered && details.inFlight !== true };
}

// A token amount in the token's decimals with its symbol, or the bare number when the token has no symbol to show.
function tokenAmount(units, details) {
  if (details.symbol !== '') return formatAmount(units, details.decimals, details.symbol);
  try {
    return formatUnits(units, details.decimals);
  } catch {
    return '—';
  }
}

// The token as the nodes name it: name and symbol, whichever the window can show.
function tokenName(details) {
  if (details.name !== '' && details.symbol !== '') return t('apTokenNamed', [details.name, details.symbol]);
  return details.name || details.symbol || '—';
}

const alertBox = (text, strong = false) => el('div', { className: 'ap-warning', attrs: { role: 'alert' } },
  el('p', { className: strong ? 'ap-error ap-strong' : 'ap-error', text }));

/**
 * A built-in token transfer: the token as two nodes name it, a token named after QNC, the recipient
 * with its warnings and a burn-address alert, the amount in the token's units, the QNC fee, a refundable deposit for a
 * new holder, the QNC total, and the token balance; confirm needs both balances to cover the transfer.
 * @param {object} details ApprovalView.details of a tokenTransfer
 * @returns {{body: HTMLElement, confirmable: boolean}}
 */
function tokenTransferBody(details) {
  const ready = details.nonce !== null && details.balanceNano !== null;
  const covered = ready && BigInt(details.balanceNano) >= BigInt(details.totalNano);
  const tokenRead = ready && details.tokenBalance !== null;
  const tokenCovered = tokenRead && BigInt(details.tokenBalance) >= BigInt(details.amountBase);
  const body = el('section', { className: 'ap-card' },
    row(t('reviewNetwork'), t('qnetNetwork', [QNET.NETWORK, QNET.CHAIN_ID])),
    // a name of any length: above the rows, whole, never squeezing a label
    ...block(t('apToken'), tokenName(details), 'ap-text ap-strong'),
    ...block(t('apTokenContract'), details.token, 'ap-mono ap-address'),
    details.reserved ? alertBox(t('apTokenReserved'), true) : null,
    ...block(t('reviewTo'), details.to, 'ap-mono ap-address'),
    details.burn ? alertBox(t('apTokenBurn'), true) : null,
    recipientWarning(details),
    replacesNotice(details),
    details.duplicate === true ? alertBox(t('apDuplicate'), true) : null,
    row(t('reviewAmount'), tokenAmount(details.amountBase, details), 'ap-strong'),
    row(t('reviewFee'), ready ? qnc(details.feeNano) : '—'),
    ready && details.depositNano !== '0' ? row(t('apDeposit'), qnc(details.depositNano)) : null,
    row(t('apQncTotal'), ready ? qnc(details.totalNano) : '—', 'ap-strong'),
    row(t('apTokenBalance'), tokenRead ? tokenAmount(details.tokenBalance, details) : '—'),
    ...accountRows(details, ready, covered),
    ready && !tokenRead ? el('p', {
      className: 'ap-warn', attrs: { role: 'status' }, text: problemText(details.tokenProblem) ?? t('apTokenBalanceUnread'),
    }) : null,
    tokenRead && !tokenCovered ? el('p', { className: 'ap-error', attrs: { role: 'alert' }, text: t('apTokenShort') }) : null);
  return { body, confirmable: ready && covered && tokenCovered && details.inFlight !== true };
}

/**
 * A call of a WASM contract: the contract with the unknown-contract warning, the method, the input as hex with its
 * size (and as text when it reads as such), the gas limit and the most it can cost; a call moves no QNC.
 * @param {object} details ApprovalView.details of a contractCall
 * @returns {{body: HTMLElement, confirmable: boolean}}
 */
function contractCallBody(details) {
  const ready = details.nonce !== null && details.balanceNano !== null;
  const covered = ready && BigInt(details.balanceNano) >= BigInt(details.totalNano);
  const input = details.args === '' ? [el('p', { className: 'ap-muted', text: t('apArgsNone') })] : [
    el('pre', { className: 'ap-args', text: details.args, attrs: { dir: 'ltr', tabindex: '0' } }),
    el('p', { className: 'ap-muted', text: t('apSignSize', [details.argsBytes]) }),
    ...(details.argsText === null ? [] : [
      el('p', { className: 'ap-label', text: t('apArgsText') }),
      el('pre', { className: 'ap-args', text: details.argsText, attrs: { dir: 'auto', tabindex: '0' } }),
    ]),
  ];
  const body = el('section', { className: 'ap-card' },
    row(t('reviewNetwork'), t('qnetNetwork', [QNET.NETWORK, QNET.CHAIN_ID])),
    ...block(t('apContract'), details.contract, 'ap-mono ap-address'),
    alertBox(t('apContractUnknown'), true),
    ...block(t('apMethod'), details.method),
    el('p', { className: 'ap-label', text: t('apArgs') }),
    ...input,
    replacesNotice(details),
    row(t('apGasLimit'), ready ? details.gasLimit : '—'),
    row(t('apMaxFee'), ready ? qnc(details.feeNano) : '—', 'ap-strong'),
    ...accountRows(details, ready, covered));
  return { body, confirmable: ready && covered && details.inFlight !== true };
}

// While unlocked a transaction preview or an activation view may still be missing (network); ask again. A transaction
// behind an earlier one not in a block yet is read again until it is, and so is an activation while the wallet is being
// checked, without a limit (the approval's own timeout ends it).
function schedulePreviewRetry(next) {
  clearTimeout(retryTimer);
  if (!next.locked && next.kind === 'activateNode' && next.details.mode === 'checking') {
    previewRetries = 0;
    retryTimer = setTimeout(refresh, PREVIEW_RETRY_MS);
    return;
  }
  if (!next.locked && TX_KINDS.has(next.kind) && next.details.nonce !== null && next.details.inFlight === true) {
    previewRetries = 0;
    retryTimer = setTimeout(refresh, IN_FLIGHT_RETRY_MS);
    return;
  }
  const waiting = !next.locked && ((TX_KINDS.has(next.kind) && next.details.nonce === null)
    || (['activateNode', 'claimNodeBalance', 'unlinkNodeDevice'].includes(next.kind) && next.details.mode === null));
  if (!waiting) {
    previewRetries = 0;
    return;
  }
  if (previewRetries >= PREVIEW_RETRIES) return;
  previewRetries += 1;
  retryTimer = setTimeout(refresh, PREVIEW_RETRY_MS);
}

/**
 * connect: origin and the two addresses it will see. signMessage: the exact text (textContent, with
 * visible line breaks). sendTransaction: to (full) with a first-time or look-alike warning, amount, fee,
 * total, nonce. tokenTransfer / contractCall: tokenTransferBody / contractCallBody. activateNode: renderActivation.
 * @param {import('../background/provider.js').ApprovalView} next
 * @returns {void}
 */
function renderApproval(next) {
  if (next.kind === 'connect' && next.details.alreadyGranted) {
    resolve(next.id, true);
    return;
  }
  if (next.kind === 'activateNode') {
    renderActivation(next);
    return;
  }
  if (next.kind === 'claimNodeBalance') {
    renderClaim(next);
    return;
  }
  if (next.kind === 'unlinkNodeDevice') {
    renderUnlink(next);
    return;
  }
  const confirm = button(t(`apConfirm_${next.kind}`), true);
  let body;
  let confirmable = true;
  let ready = () => true;
  let message = null;
  if (next.kind === 'connect') body = connectBody();
  else if (next.kind === 'signMessage') {
    message = messageBody(next.details);
    ({ body } = message);
    ready = message.seen;
  } else if (next.kind === 'tokenTransfer') ({ body, confirmable } = tokenTransferBody(next.details));
  else if (next.kind === 'contractCall') ({ body, confirmable } = contractCallBody(next.details));
  else ({ body, confirmable } = transferBody(next.details));
  frame(next, body, el('div', { className: 'ap-actions' }, rejectButton(), confirm));
  if (!confirmable) {
    confirm.disabled = true;
    return;
  }
  const delay = TX_KINDS.has(next.kind) ? TIMINGS.CONFIRM_ARM_VALUE_MS : TIMINGS.CONFIRM_ARM_MS;
  const update = armConfirm(confirm, () => resolve(next.id, true, next.revision), ready, delay);
  message?.box.addEventListener('scroll', update);
  message?.seen();
}

// A click made with a pointer. Enter or Space on a focused button makes a trusted click too (detail 0,
// no pointer type), and this window takes focus when it opens, so keystrokes meant for a page could
// confirm what the user never read (ES-02): a confirm needs the mouse, a pen or a touch.
const POINTER_TYPES = new Set(['mouse', 'pen', 'touch']);
function isPointerClick(event) {
  return event.isTrusted === true && Number.isInteger(event.detail) && event.detail >= 1
    && (event.pointerType === undefined || POINTER_TYPES.has(event.pointerType));
}

/**
 * Enables `target` `delayMs` after the window was last left alone, while ready() holds: every press,
 * release or key anywhere in the window before it armed starts the wait again, so a burst of clicks meant
 * for a page never reaches it (R2-ERP-02, R2-EXT-UI-01, as mobile useArmedConfirm). Its handler acts only
 * on a trusted pointer click (never one a key made) whose press began on it after it armed, while
 * document.hasFocus(). Losing focus disarms it; regaining focus starts the delay again. Returns update():
 * re-checks ready() (call it when an input it reads changes).
 * @param {HTMLButtonElement} target
 * @param {() => void} onConfirm
 * @param {() => boolean} [ready]
 * @param {number} [delayMs] TIMINGS.CONFIRM_ARM_MS, or CONFIRM_ARM_VALUE_MS for a send or a burn
 * @returns {() => void}
 */
function armConfirm(target, onConfirm, ready = () => true, delayMs = TIMINGS.CONFIRM_ARM_MS) {
  armed?.abort();
  const controller = new AbortController();
  armed = controller;
  const { signal } = controller;
  let timer = null;
  let live = false;
  // the press of the click being made began on the button after it armed
  let pressed = false;
  const update = () => {
    target.disabled = !(live && ready());
  };
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    live = false;
    pressed = false;
    target.disabled = true;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      live = document.hasFocus() && !document.hidden;
      update();
    }, delayMs);
  };
  // activity before the button armed: the wait starts over
  const restart = () => {
    if (!live) arm();
  };
  for (const type of ['pointerdown', 'pointerup', 'keydown']) window.addEventListener(type, restart, { signal, capture: true });
  target.addEventListener('pointerdown', (event) => {
    pressed = live && event.isTrusted === true;
  }, { signal });
  target.addEventListener('click', (event) => {
    const began = pressed;
    pressed = false;
    if (!isPointerClick(event) || !began || target.disabled || !document.hasFocus() || !ready()) return;
    disarm();
    onConfirm();
  }, { signal });
  window.addEventListener('blur', disarm, { signal });
  window.addEventListener('focus', arm, { signal });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) disarm();
    else arm();
  }, { signal });
  signal.addEventListener('abort', () => clearTimeout(timer));
  arm();
  return update;
}

// ---------------------------------------------------------------- activation (qnet_activateNode)

function balanceRows(balances) {
  if (balances === null) return [];
  return [
    row(t('apBalance'), formatAmount(balances.oneDevRaw, DECIMALS.ONE_DEV, '1DEV')),
    row(t('apBalance'), formatAmount(balances.lamports, DECIMALS.SOL, 'SOL')),
  ];
}

// The mode-specific part of an activation confirm: what happens, and what the site receives.
function activationSummary(details, mode) {
  if (mode === 'burn') {
    const { cost } = details;
    return [
      el('p', { text: t('apActivateIntro_burn') }),
      row(t('activateNodeType'), nodeLabel(details.nodeType)),
      // where the node runs: a Light node in QNet Wallet on a phone or tablet, a Super node on the user's own server
      el('p', { className: 'ap-muted', text: t(`activateAbout_${details.nodeType}`) }),
      row(t('activateBurnAmount'), t('amount1dev', [cost]), 'ap-strong'),
      row(t('activateToken'), t('activateTokenValue', [details.cluster])),
      ...block(t('activateMint'), details.mint, 'ap-mono ap-address'),
      // words around the program id: the text's own direction, the id isolated by t()
      ...block(t('activateProgram'), t('activateProgramValue', [details.tokenProgram]), 'ap-text'),
      ...block(t('activateFrom'), details.solanaAddress, 'ap-mono ap-address'),
      ...balanceRows(details.balances),
      row(t('reviewFee'), t('activateFeeValue')),
      // the burn is irreversible: its one confirmation line is the acknowledgement (renderActivation)
      el('p', { className: 'ap-muted', text: t('apActivateShares_code') }),
    ];
  }
  const burn = mode === 'exists' ? details.activation : details.pending;
  return [
    el('p', { text: t(mode === 'exists' ? 'apActivateIntro_exists' : 'apActivateIntro_pending') }),
    row(t('activateNodeType'), nodeLabel(burn.nodeType)),
    row(t('activateBurnAmount'), t('amount1dev', [burn.burnAmount])),
    ...block(t('activateBurnTx'), burn.burnTx),
    mode === 'exists' ? row(t('codeLabel'), burn.codeMasked, 'ap-mono') : null,
    el('p', { className: 'ap-muted', text: t(mode === 'exists' ? 'apActivateShares_code' : 'apActivateShares_pending') }),
    // a light activation the QNet network lists with another burn's registration: the site's code is then not the
    // network's (EXT-R2A-03)
    mode === 'exists' && burn.nodeType === 'light' && details.otherBurn === true
      ? el('p', { className: 'ap-warn', attrs: { role: 'note' }, text: t('recordOtherBurn') }) : null,
  ];
}

/**
 * The activation screens by details.mode: 'burn' (price, amount, mint, program and the acknowledgement),
 * 'exists' and 'pending' (what the site receives), 'unavailable' (the reason and one button that tells the site),
 * null (still reading). No password: the unlocked session and the armed press confirm (TIMINGS.CONFIRM_ARM_VALUE_MS;
 * a burn also waits for its acknowledgement).
 * @param {import('../background/provider.js').ApprovalView} next
 * @returns {void}
 */
function renderActivation(next) {
  const { details } = next;
  const { mode } = details;
  if (mode === 'unavailable') {
    const close = button(t('close'), true);
    close.addEventListener('click', (event) => {
      if (event.isTrusted) resolve(next.id, false);
    });
    // a node aiqnet.io paid for (the site learns NODE_EXISTS): its code is in Settings already, and the Activate tab offers
    // no Recover for it (EXT-R2-02)
    const paidOnSite = details.reason === 'NODE_EXISTS' && details.activation?.paidOnSite === true;
    const reason = paidOnSite
      ? el('p', { className: 'ap-warn', attrs: { role: 'note' }, text: t('apActivatePaidOnSite') })
      : el('p', { className: 'ap-error ap-strong', attrs: { role: 'alert' }, text: codeText(details.reason) });
    frame(next,
      el('section', { className: 'ap-card' },
        reason,
        details.cost !== null ? row(t('activateBurnAmount'), t('amount1dev', [details.cost])) : null,
        ...balanceRows(details.balances)),
      el('div', { className: 'ap-actions' }, close));
    return;
  }
  if (mode !== 'burn' && mode !== 'exists' && mode !== 'pending') {
    // 'checking': no burn is offered until the QNet network, Solana and aiqnet.io all answered (decision 35)
    frame(next, el('section', { className: 'ap-card' },
      el('p', { className: 'ap-muted', attrs: { role: 'status' }, text: t(mode === 'checking' ? 'activateChecking' : 'apActivateReading') })),
    el('div', { className: 'ap-actions' }, rejectButton()));
    return;
  }
  // a redraw (what the view shows changed) arms the confirm again from the start, and a burn's acknowledgement is
  // given again (EXT-FA1-02)
  const confirm = button(mode === 'burn' ? t('activateBurnButton', [details.cost]) : t(`apConfirm_${mode}`), true);
  let ack = null;
  if (mode === 'burn') {
    ack = el('input', { attrs: { type: 'checkbox', id: 'ap-ack' } });
  }
  frame(next,
    el('section', { className: 'ap-card' },
      ...activationSummary(details, mode),
      ack ? el('label', { className: 'ap-check', attrs: { for: 'ap-ack' } }, ack,
        el('span', { text: t('activateAck', [details.cost]) })) : null),
    el('div', { className: 'ap-actions' }, rejectButton(), confirm));
  const update = armConfirm(confirm, () => runActivation(next, mode), () => ack === null || ack.checked,
    TIMINGS.CONFIRM_ARM_VALUE_MS);
  ack?.addEventListener('change', update);
}

function progressBody(next, mode) {
  if (mode !== 'burn') {
    return el('section', { className: 'ap-card' },
      el('div', { className: 'progress', attrs: { role: 'progressbar', 'aria-label': t('apActivateChecking') } },
        el('div', { className: 'progress-bar' })),
      el('p', { text: t('apActivateChecking') }));
  }
  const elapsed = el('p', { className: 'ap-muted' });
  const started = Date.now();
  ticker = setInterval(() => {
    elapsed.textContent = t('activateElapsed', [Math.floor((Date.now() - started) / 1000)]);
  }, 1000);
  const title = t('activateProgressTitle', [next.details.cost]);
  return el('section', { className: 'ap-card' },
    el('p', { className: 'ap-strong', text: title }),
    el('div', { className: 'progress', attrs: { role: 'progressbar', 'aria-label': title } }, el('div', { className: 'progress-bar' })),
    elapsed,
    el('p', { className: 'ap-muted', text: t('activateKeepOpen') }));
}

async function runActivation(next, mode) {
  if (busy || finished) return;
  busy = true;
  notice = null;
  frame(next, progressBody(next, mode), null);
  keepalive = setInterval(() => {
    call('vault.status').catch(() => {});
  }, KEEPALIVE_MS);
  let result;
  try {
    result = await call('approval.resolve', { id: next.id, approved: true, revision: next.revision });
  } catch (error) {
    stopActivityTimers();
    busy = false;
    if (error.code === 'NOT_FOUND') {
      closeWindow();
    } else if (error.code === 'LOCKED' || error.code === 'PRICE_CHANGED') {
      notice = error.code === 'PRICE_CHANGED' ? t('apPriceReviewAgain') : null;
      screenKey = '';
      await refresh();
    } else {
      renderOutcome(error);
    }
    return;
  }
  stopActivityTimers();
  busy = false;
  renderActivationOutcome(next, result);
}

// The worker answered the site; this window says what happened and stays until closed.
function renderActivationOutcome(next, result) {
  finished = true;
  clearInterval(heartbeat);
  clearTimeout(retryTimer);
  const close = button(t('close'), true);
  close.addEventListener('click', closeWindow);
  const status = result?.status;
  let body;
  // titled by what happened (EXT-F5): the code, a burn waiting for Solana, or no code
  let title = t(status === 'pending' ? 'activatePendingTitle' : 'activateCodeTitle');
  if (status === 'ok' || status === 'exists' || status === 'pending') {
    // the burn this window sent, when another device's older burn of the phrase is the activation (XP-R5-03)
    const own = result?.superseded;
    // a Super code goes to its server: the site shows the code, the burn and the server's settings (decision 36)
    const server = status !== 'pending' && result?.nodeType === 'super';
    body = el('section', { className: 'ap-card' },
      el('p', { className: status === 'pending' ? 'ap-warn' : 'ap-ok', text: t(`apOutcome_${status}`) }),
      server ? el('p', { className: 'ap-muted', text: t('apOutcome_super') }) : null,
      own && typeof own.burnTx === 'string'
        ? el('p', { className: 'ap-warn', attrs: { role: 'note' }, text: t('apOutcomeSuperseded', [String(own.burnAmount), own.burnTx]) })
        : null,
      result?.registration ? registrationLine(result.registration) : null);
  } else {
    const code = typeof result?.error === 'string' ? result.error : 'INTERNAL';
    let note = 'activateNothingBurned';
    if (code === 'TX_FAILED') note = 'activateTxFailed';
    else if (code === 'INTERNAL') note = 'activateMaybeSent';
    title = t('activateFailedTitle');
    body = el('section', { className: 'ap-card' },
      el('p', { className: 'ap-error', attrs: { role: 'alert' }, text: codeText(code) }),
      el('p', { className: 'ap-muted', text: t(note) }));
  }
  frame(next, body, el('div', { className: 'ap-actions' }, close), title);
}

// The line of a light node's record on the QNet network after the answer, read again while it is being made (the
// worker keeps the window up to TIMINGS.REGISTRATION_WINDOW_MS). wallet_has_node: the network's one-node rule refused it.
const RECORD_TEXT = Object.freeze({
  onchain: ['ap-ok', 'recordOnchain'], recording: ['ap-muted', 'recordRecording'], refused: ['ap-warn', 'recordRefused'],
  clock: ['ap-warn', 'recordClock'], none: ['ap-warn', 'recordNone'], other_burn: ['ap-warn', 'recordOtherBurn'],
  wallet_has_node: ['ap-warn', 'recordRefusedWalletHasNode'],
});

function registrationLine(initial) {
  const line = el('p', { attrs: { role: 'status' } });
  const show = (registration) => {
    let shown = 'none';
    if (registration?.state === 'refused' && registration.lastError === 'wallet_has_node') shown = 'wallet_has_node';
    else if (['onchain', 'other_burn', 'refused', 'clock'].includes(registration?.state)) shown = registration.state;
    else if (registration?.automatic === true && registration.deferred !== true) shown = 'recording';
    const [className, key] = RECORD_TEXT[shown];
    line.className = className;
    line.textContent = t(key);
    if (shown !== 'recording') {
      clearInterval(ticker);
      ticker = null;
    }
  };
  show(initial);
  if (initial?.automatic === true && initial.deferred !== true) {
    clearInterval(ticker);
    ticker = setInterval(() => {
      call('activation.registration').then((reply) => show(reply?.registration ?? null)).catch(() => {});
    }, TIMINGS.REGISTRATION_POLL_MS);
  } else if (initial?.state === 'refused') {
    // the answer's registration names no lastError: a refusal is read once more, so the one-node rule's is said as
    // itself (wallet_has_node), never as one to try again later
    call('activation.registration').then((reply) => {
      if (reply?.registration) show(reply.registration);
    }).catch(() => {});
  }
  return line;
}

// ---------------------------------------------------------------- node balance (qnet_claimNodeBalance)

/**
 * The move of the node balance by details.mode: 'claim' (the node and its balance two nodes agree on; an armed
 * confirm), 'empty' (below 1 QNC) and 'unavailable' (the reason), each with one button
 * that tells the site, null (still reading).
 * @param {import('../background/provider.js').ApprovalView} next
 * @returns {void}
 */
function renderClaim(next) {
  const { details } = next;
  const { mode } = details;
  if (mode !== 'claim' && mode !== 'empty' && mode !== 'unavailable') {
    frame(next, el('section', { className: 'ap-card' }, el('p', { className: 'ap-muted', text: t('apClaimReading') })),
      el('div', { className: 'ap-actions' }, rejectButton()));
    return;
  }
  const rows = mode === 'unavailable' ? [] : [
    row(t('nodeLight'), details.nodeId, 'ap-mono'),
    row(t('apNodeBalance'), qnc(details.amountNano), 'ap-strong'),
  ];
  if (mode !== 'claim') {
    const close = button(t('close'), true);
    close.addEventListener('click', (event) => {
      if (event.isTrusted) resolve(next.id, false);
    });
    frame(next,
      el('section', { className: 'ap-card' },
        mode === 'empty'
          ? el('p', { className: 'ap-warn', attrs: { role: 'note' }, text: t('apClaimEmpty') })
          : el('p', { className: 'ap-error ap-strong', attrs: { role: 'alert' }, text: codeText(details.reason) }),
        ...rows),
      el('div', { className: 'ap-actions' }, close));
    return;
  }
  const confirm = button(t('apConfirm_claimNodeBalance'), true);
  frame(next,
    el('section', { className: 'ap-card' },
      el('p', { text: t('apClaimIntro') }),
      ...rows),
    el('div', { className: 'ap-actions' }, rejectButton(), confirm));
  armConfirm(confirm, () => runClaim(next), () => true, TIMINGS.CONFIRM_ARM_VALUE_MS);
}

async function runClaim(next) {
  if (busy || finished) return;
  busy = true;
  notice = null;
  frame(next, el('section', { className: 'ap-card' },
    el('div', { className: 'progress', attrs: { role: 'progressbar', 'aria-label': t('apClaimProgress') } }, el('div', { className: 'progress-bar' })),
    el('p', { text: t('apClaimProgress') })), null);
  keepalive = setInterval(() => {
    call('vault.status').catch(() => {});
  }, KEEPALIVE_MS);
  let result;
  try {
    result = await call('approval.resolve', { id: next.id, approved: true, revision: next.revision });
  } catch (error) {
    stopActivityTimers();
    busy = false;
    if (error.code === 'NOT_FOUND') {
      closeWindow();
    } else if (error.code === 'LOCKED' || REVIEW_AGAIN.has(error.code)) {
      notice = REVIEW_AGAIN.has(error.code) ? t('apReviewAgain') : null;
      screenKey = '';
      await refresh();
    } else {
      renderOutcome(error);
    }
    return;
  }
  stopActivityTimers();
  busy = false;
  renderClaimOutcome(next, result);
}

// The worker answered the site; this window says what happened and stays until closed.
function renderClaimOutcome(next, result) {
  finished = true;
  clearInterval(heartbeat);
  clearTimeout(retryTimer);
  const close = button(t('close'), true);
  close.addEventListener('click', closeWindow);
  let body;
  let title = t('done');
  if (result?.status === 'ok') {
    body = el('section', { className: 'ap-card' },
      el('p', { className: 'ap-ok', text: t('apOutcome_claimOk', [qnc(result.amountNano)]) }),
      result.partial === true ? el('p', { className: 'ap-muted', text: t('apOutcome_claimPartial') }) : null);
  } else if (result?.status === 'empty') {
    body = el('section', { className: 'ap-card' }, el('p', { className: 'ap-warn', text: t('apOutcome_claimEmpty') }));
  } else {
    title = t('apFailed');
    body = el('section', { className: 'ap-card' },
      el('p', { className: 'ap-error', attrs: { role: 'alert' }, text: codeText(typeof result?.error === 'string' ? result.error : 'INTERNAL') }));
  }
  frame(next, body, el('div', { className: 'ap-actions' }, close), title);
}

// ---------------------------------------------------------------- the light node's device (qnet_unlinkNodeDevice)

// Why the unlink cannot be offered: a wallet code's text, or the network that does not take it yet (UNSUPPORTED).
const unlinkReason = (reason) => (reason === 'UNSUPPORTED' ? t('unlinkUnsupported') : codeText(reason));

/**
 * The unlink of the light node's device by details.mode: 'confirm' (the node, the device the network names and the day
 * it was linked; an armed confirm), 'unavailable' (the reason, with one button that tells the site), null (still
 * reading).
 * @param {import('../background/provider.js').ApprovalView} next
 * @returns {void}
 */
function renderUnlink(next) {
  const { details } = next;
  const { mode } = details;
  if (mode !== 'confirm' && mode !== 'unavailable') {
    frame(next, el('section', { className: 'ap-card' }, el('p', { className: 'ap-muted', text: t('apUnlinkReading') })),
      el('div', { className: 'ap-actions' }, rejectButton()));
    return;
  }
  if (mode === 'unavailable') {
    const close = button(t('close'), true);
    close.addEventListener('click', (event) => {
      if (event.isTrusted) resolve(next.id, false);
    });
    frame(next,
      el('section', { className: 'ap-card' },
        el('p', { className: 'ap-error ap-strong', attrs: { role: 'alert' }, text: unlinkReason(details.reason) })),
      el('div', { className: 'ap-actions' }, close));
    return;
  }
  const confirm = button(t('apConfirm_unlinkNodeDevice'), true);
  frame(next,
    el('section', { className: 'ap-card' },
      el('p', { text: t('apUnlinkIntro') }),
      row(t('nodeLight'), details.nodeId, 'ap-mono'),
      row(t('deviceRunsOn'), t(`devicePlatform_${details.platform}`)),
      details.linkedSince === null ? null : row(t('deviceLinkedSince'), formatDay(details.linkedSince))),
    el('div', { className: 'ap-actions' }, rejectButton(), confirm));
  armConfirm(confirm, () => runUnlink(next));
}

async function runUnlink(next) {
  if (busy || finished) return;
  busy = true;
  notice = null;
  frame(next, el('section', { className: 'ap-card' },
    el('div', { className: 'progress', attrs: { role: 'progressbar', 'aria-label': t('unlinkWorking') } }, el('div', { className: 'progress-bar' })),
    el('p', { text: t('unlinkWorking') })), null);
  let result;
  try {
    result = await call('approval.resolve', { id: next.id, approved: true, revision: next.revision });
  } catch (error) {
    busy = false;
    if (error.code === 'NOT_FOUND') {
      closeWindow();
    } else if (error.code === 'LOCKED' || REVIEW_AGAIN.has(error.code)) {
      notice = REVIEW_AGAIN.has(error.code) ? t('apReviewAgain') : null;
      screenKey = '';
      await refresh();
    } else {
      renderOutcome(error);
    }
    return;
  }
  busy = false;
  finished = true;
  clearInterval(heartbeat);
  clearTimeout(retryTimer);
  const close = button(t('close'), true);
  close.addEventListener('click', closeWindow);
  const ok = result?.status === 'ok';
  frame(next,
    el('section', { className: 'ap-card' }, ok
      ? el('p', { className: 'ap-ok', text: t('unlinkDone') })
      : el('p', { className: 'ap-error', attrs: { role: 'alert' }, text: unlinkReason(typeof result?.error === 'string' ? result.error : 'INTERNAL') })),
    el('div', { className: 'ap-actions' }, close), ok ? t('apOutcome_unlinkOk') : t('apFailed'));
}

function renderOutcome(error) {
  finished = true;
  clearInterval(heartbeat);
  clearTimeout(retryTimer);
  const close = button(t('close'), false);
  close.addEventListener('click', closeWindow);
  frame(view,
    el('section', { className: 'ap-card' },
      el('p', { className: 'ap-strong', text: t('apFailed') }),
      el('p', { className: 'ap-error', attrs: { role: 'alert' }, text: errorText(error) })),
    el('div', { className: 'ap-actions' }, close));
}

function setActionsDisabled(disabled) {
  for (const control of app.querySelectorAll('button')) control.disabled = disabled;
}

/**
 * approval.resolve (connect, sign, send; an activation's or a claim's reject or its unavailable answer), then
 * window.close(). A LOCKED or changed-preview answer re-reads the approval (it is still
 * open); any other error is shown until the user closes the window.
 * @param {string} id
 * @param {boolean} approved
 * @param {number|null} [revision] the revision of the view confirmed (ApprovalView.revision)
 * @returns {Promise<void>}
 */
async function resolve(id, approved, revision = null) {
  if (busy || finished) return;
  busy = true;
  setActionsDisabled(true);
  try {
    await call('approval.resolve', Number.isSafeInteger(revision) ? { id, approved, revision } : { id, approved });
  } catch (error) {
    busy = false;
    if (error.code === 'NOT_FOUND') {
      closeWindow();
    } else if (error.code === 'LOCKED' || REVIEW_AGAIN.has(error.code)) {
      notice = REVIEW_AGAIN.has(error.code) ? t('apReviewAgain') : null;
      screenKey = '';
      await refresh();
    } else {
      renderOutcome(error);
    }
    return;
  }
  closeWindow();
}

boot();
