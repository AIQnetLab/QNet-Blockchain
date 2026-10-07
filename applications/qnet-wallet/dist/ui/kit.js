// Building blocks of the popup and the setup page: controls, messages, amounts, addresses and links.
// Everything goes through common.el(), so no HTML is ever parsed. Every text field is hardened: even an
// address or an amount is nobody's business but the user's.
import { PAYMENT_REQUEST, QNET, SOLANA, isPaymentRequestMemo } from '../background/config.js';
import { UiError, call, copyText, currentLanguage, el, formatUnits, hardenSecretInput, parseUnits, t } from './common.js';

let idSeq = 0;
const nextId = (prefix) => {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
};

/**
 * A button of the kit's kinds ('primary', 'secondary', 'danger', 'ghost').
 * @param {string} label
 * @param {((event: Event) => void)|null} onClick
 * @param {{kind?: string, action?: string, disabled?: boolean, block?: boolean}} [options] action becomes
 *   data-action (how tests and styles address a control)
 * @returns {HTMLButtonElement}
 */
export function button(label, onClick, { kind = 'secondary', action = null, disabled = false, block = false } = {}) {
  const attrs = { type: 'button' };
  if (action) attrs['data-action'] = action;
  const node = el('button', { className: `btn btn-${kind}${block ? ' btn-block' : ''}`, text: label, attrs });
  if (disabled) node.disabled = true;
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

/**
 * A hardened single-line input (spellcheck, autofill and grammar tools off).
 * @param {{name: string, type?: string, placeholder?: string, inputMode?: string, maxLength?: number,
 *   ltr?: boolean}} options ltr: left to right in every language (addresses, amounts, words, codes)
 * @returns {HTMLInputElement}
 */
export function textInput({ name, type = 'text', placeholder = '', inputMode = null, maxLength = null, ltr = false }) {
  const attrs = { type, name };
  if (placeholder) attrs.placeholder = placeholder;
  if (inputMode) attrs.inputmode = inputMode;
  if (maxLength) attrs.maxlength = maxLength;
  if (ltr) attrs.dir = 'ltr';
  return hardenSecretInput(el('input', { className: 'input', attrs }));
}

/**
 * A hardened password input.
 * @param {string} name
 * @param {string} [placeholder]
 * @returns {HTMLInputElement}
 */
export function passwordInput(name, placeholder = '') {
  return textInput({ name, type: 'password', placeholder, maxLength: 1024 });
}

/**
 * A hardened textarea, left to right in every language (it takes recovery phrases).
 * @param {{name: string, rows?: number, placeholder?: string}} options
 * @returns {HTMLTextAreaElement}
 */
export function textArea({ name, rows = 4, placeholder = '' }) {
  const attrs = { name, rows, dir: 'ltr' };
  if (placeholder) attrs.placeholder = placeholder;
  return hardenSecretInput(el('textarea', { className: 'input textarea', attrs }));
}

/**
 * Label + control (+ hint) with the label bound to the control.
 * @param {string} label
 * @param {HTMLElement} control
 * @param {string|null} [hint]
 * @param {HTMLElement|null} [beside] a control on the same line after it (the send form's Max)
 * @returns {HTMLElement}
 */
export function field(label, control, hint = null, beside = null) {
  const id = nextId('field');
  control.setAttribute('id', id);
  return el('div', { className: 'field' },
    el('label', { className: 'field-label', text: label, attrs: { for: id } }),
    beside ? el('div', { className: 'field-row' }, control, beside) : control,
    hint ? el('div', { className: 'hint', text: hint }) : null);
}

/**
 * A checkbox with its label.
 * @param {string} name
 * @param {string} label
 * @param {(checked: boolean) => void} onChange
 * @returns {{node: HTMLElement, input: HTMLInputElement}}
 */
export function checkbox(name, label, onChange) {
  const input = el('input', { attrs: { type: 'checkbox', name } });
  input.addEventListener('change', () => onChange(input.checked));
  return { node: el('label', { className: 'check' }, input, el('span', { text: label })), input };
}

/**
 * A group of toggle buttons with one pressed (aria-pressed). onSelect gets the value and a function
 * that sets the pressed button, so a refused change can be put back.
 * @param {Array<[string, string]>} options [value, label] pairs
 * @param {string|null} current
 * @param {(value: string, select: (value: string|null) => void) => void} onSelect
 * @param {string} label accessible name of the group
 * @returns {HTMLElement}
 */
export function segmented(options, current, onSelect, label) {
  const group = el('div', { className: 'segmented', attrs: { role: 'group', 'aria-label': label } });
  const buttons = new Map();
  const select = (value) => {
    for (const [optionValue, node] of buttons) node.setAttribute('aria-pressed', String(optionValue === value));
  };
  for (const [value, text] of options) {
    const node = el('button', {
      className: 'seg', text, attrs: { type: 'button', 'data-value': value, 'aria-pressed': String(value === current) },
    });
    node.addEventListener('click', () => {
      select(value);
      onSelect(value, select);
    });
    buttons.set(value, node);
    group.append(node);
  }
  return group;
}

/**
 * A notice block: one paragraph per text.
 * @param {'info'|'warn'|'danger'|'success'} kind
 * @param {...string} texts
 * @returns {HTMLElement}
 */
export function notice(kind, ...texts) {
  return el('div', { className: `notice notice-${kind}`, attrs: { role: kind === 'danger' ? 'alert' : 'note' } },
    ...texts.map((text) => el('p', { text })));
}

/**
 * A notice with a bullet list.
 * @param {'info'|'warn'|'danger'|'success'} kind
 * @param {string|null} title
 * @param {string[]} items
 * @returns {HTMLElement}
 */
export function noticeList(kind, title, items) {
  return el('div', { className: `notice notice-${kind}`, attrs: { role: 'note' } },
    title ? el('p', { className: 'notice-title', text: title }) : null,
    el('ul', {}, ...items.map((text) => el('li', { text }))));
}

/**
 * A one-line status or error area that can be set and cleared.
 * @returns {{node: HTMLElement, show: (text: string, kind?: string) => void, clear: () => void}}
 */
export function messageLine() {
  const node = el('div', { className: 'message', attrs: { role: 'status', 'aria-live': 'polite' } });
  return {
    node,
    show(text, kind = 'error') {
      node.className = `message message-${kind}`;
      node.textContent = text;
    },
    clear() {
      node.className = 'message';
      node.textContent = '';
    },
  };
}

/**
 * Heading and optional lead paragraph of a screen.
 * @param {string} title
 * @param {string|null} [lead]
 * @returns {HTMLElement}
 */
export function heading(title, lead = null) {
  return el('div', { className: 'heading' },
    el('h2', { text: title }),
    lead ? el('p', { className: 'lead', text: lead }) : null);
}

// A whole address of addressText() or addressCopy(), or a value of valueCopy().
const isAddressNode = (value) => typeof value?.classList?.contains === 'function'
  && (value.classList.contains('addr') || value.classList.contains('account-address') || value.classList.contains('value-copy'));

/**
 * A definition list of label → value rows. A whole address (addressText, addressCopy) takes the full width of the list
 * below its label, where it fits on one line (popup.css: .kv-addr).
 * @param {Array<[string, Node|string]>} rows
 * @returns {HTMLElement}
 */
export function kvList(rows) {
  return el('dl', { className: 'kv' }, ...rows.flatMap(([label, value]) => {
    const wide = isAddressNode(value);
    return [
      el('dt', { className: wide ? 'kv-wide' : null, text: label }),
      el('dd', { className: wide ? 'kv-wide kv-addr' : null }, value),
    ];
  }));
}

const EDGE = 6;

/**
 * A full address with its first and last characters set apart: those are what a person compares, and
 * what an address-poisoning look-alike copies. In a list (kvList) or a copy control it stays on one line.
 * @param {string} address
 * @returns {HTMLElement}
 */
export function addressText(address) {
  const text = typeof address === 'string' ? address : '';
  if (text.length <= EDGE * 2) return el('span', { className: 'addr', text });
  return el('span', { className: 'addr' },
    el('span', { className: 'addr-edge', text: text.slice(0, EDGE) }),
    el('span', { className: 'addr-mid', text: text.slice(EDGE, -EDGE) }),
    el('span', { className: 'addr-edge', text: text.slice(-EDGE) }));
}

// How long a copied address says "Copied".
const COPIED_MS = 1500;

/**
 * The wallet's own address, whole on one line (its type is sized to the box: popup.css, .account-address; never cut),
 * as its own copy control (owner, 28.09): a native button (Enter and Space press it) with "Click to copy" on hover,
 * "Copied" on it for a moment once copied. No separate Copy button is needed next to it.
 * @param {string} address
 * @param {string} label what the address is ("QNet address"), for its accessible name
 * @param {{onCopied?: () => void, onFailed?: () => void}} [options] also told of the copy (the popup's toast)
 * @returns {HTMLButtonElement}
 */
export function addressCopy(address, label, { onCopied = null, onFailed = null } = {}) {
  const hint = t('clickToCopy');
  const node = el('button', {
    className: 'account-address',
    attrs: { type: 'button', 'data-action': 'copy-address', 'data-copied': t('copied'), title: hint, 'aria-label': `${label}, ${hint}` },
  }, addressText(address));
  return copyOnClick(node, address, hint, onCopied, onFailed);
}

/**
 * A value of any length that is not an address of this wallet's (a transaction hash, a signature) shown whole, wrapping,
 * as its own copy control, as addressCopy: a native button with "Click to copy" on hover and "Copied" once copied.
 * @param {string} value
 * @param {string} label what the value is, for its accessible name
 * @param {{onCopied?: () => void, onFailed?: () => void}} [options]
 * @returns {HTMLButtonElement}
 */
export function valueCopy(value, label, { onCopied = null, onFailed = null } = {}) {
  const hint = t('clickToCopy');
  const node = el('button', {
    className: 'value-copy mono',
    text: value,
    attrs: { type: 'button', 'data-action': 'copy-value', 'data-copied': t('copied'), title: hint, 'aria-label': `${label}, ${hint}` },
  });
  return copyOnClick(node, value, hint, onCopied, onFailed);
}

// A click on `node` copies `text` and says "Copied" on it for a moment.
function copyOnClick(node, text, hint, onCopied, onFailed) {
  let timer = null;
  node.addEventListener('click', () => {
    copyText(text).then(() => {
      node.classList.add('copied');
      node.setAttribute('title', t('copied'));
      clearTimeout(timer);
      timer = setTimeout(() => {
        node.classList.remove('copied');
        node.setAttribute('title', hint);
      }, COPIED_MS);
      onCopied?.();
    }, () => onFailed?.());
  });
  return node;
}

/**
 * Whether `candidate` shares the first and last four characters of a different known address: the
 * look-alike an address-poisoning attack plants in a history.
 * @param {string} candidate
 * @param {Iterable<string>} known
 * @returns {boolean}
 */
export function looksLikeKnownAddress(candidate, known) {
  if (typeof candidate !== 'string' || candidate.length < 12) return false;
  for (const address of known) {
    if (typeof address === 'string' && address !== candidate && address.length === candidate.length
      && address.slice(0, 4) === candidate.slice(0, 4) && address.slice(-4) === candidate.slice(-4)) return true;
  }
  return false;
}

// A payment request of the Solana send, read as the app reads one (utils/solanaRequest.js): its scheme, the longest text
// read, the parts that are read once each, and how much of a label or message is shown.
const PAYMENT_REQUEST_SCHEME = /^solana:/i;
const PAYMENT_REQUEST_MAX_CHARS = 2048;
const PAYMENT_REQUEST_ONCE = Object.freeze(['amount', 'spl-token', 'memo']);
const REQUEST_TEXT_MAX_CHARS = 200;
// a plain decimal in whole units: never an exponent, a sign or a leading dot; zero asks for no amount
const REQUEST_AMOUNT_RE = /^[0-9]{1,20}(\.[0-9]{1,30})?$/;
// C0 and C1 controls, zero-width and bidirectional formatting characters: a label or message is plain text only
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

function requestText(value) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (clean === '') return null;
  const chars = [...clean];
  return chars.length > REQUEST_TEXT_MAX_CHARS ? `${chars.slice(0, REQUEST_TEXT_MAX_CHARS).join('')}…` : clean;
}

// A query part as form encoding writes it: '+' is a space (a '+' itself comes as %2B); null when it does not decode.
function requestPart(part) {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/**
 * A recipient pasted into the Solana send form: a plain address, or a payment request `solana:<address>?<parts>`, read
 * with the app's grammar, limits and decoding (utils/solanaRequest.js), so both wallets read one request alike. Parts
 * (names and values form-encoded: '+' is a space, %2B a plus): `amount` (a plain decimal of the token's whole units;
 * zero asks for no amount), `spl-token` (the mint; without it the request is for SOL) and `memo`
 * (config.isPaymentRequestMemo), each at most once; `reference`, up to PAYMENT_REQUEST.REFERENCES_MAX distinct
 * addresses the transfer carries as read-only accounts; `label` and `message`, shown as plain text (the first of each;
 * without control or bidirectional formatting characters and cut to 200 characters, never a link); any other part is
 * ignored.
 * A malformed part, one of the once-only parts given twice, or a reference given twice, too many, or not an address,
 * refuses the whole text, and so does a text that is neither an address nor such a request (another scheme, a link as
 * the recipient). Whether the wallet lists the mint, and the token's decimals, are the page's check.
 * @param {string} text
 * @param {(address: string) => boolean} isAddress core.isValidSolanaAddress, passed in by the page (the kit, which the
 *   approve page loads too, never loads the bundle)
 * @returns {{ok: true, request: boolean, address: string, amount: string|null, mint: string|null, references: string[],
 *   memo: string|null, label: string|null, message: string|null} | {ok: false, reason: 'invalid'|'amount'|'token'}}
 *   request: it was a payment request, not a bare address
 */
export function parseSolanaRecipient(text, isAddress) {
  const valid = (value) => {
    try {
      return isAddress(value) === true;
    } catch {
      return false;
    }
  };
  const refused = (reason) => ({ ok: false, reason });
  if (typeof text !== 'string' || text.length > PAYMENT_REQUEST_MAX_CHARS) return refused('invalid');
  const input = text.trim();
  const none = { amount: null, mint: null, references: [], memo: null, label: null, message: null };
  if (valid(input)) return { ok: true, request: false, address: input, ...none };
  if (!PAYMENT_REQUEST_SCHEME.test(input)) return refused('invalid');
  const rest = input.slice('solana:'.length);
  const query = rest.indexOf('?');
  const address = query < 0 ? rest : rest.slice(0, query);
  if (!valid(address)) return refused('invalid');
  const out = { ok: true, request: true, address, ...none };
  const seen = new Set();
  let label = null;
  let message = null;
  for (const segment of (query < 0 ? '' : rest.slice(query + 1)).split('&')) {
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    const name = requestPart(eq < 0 ? segment : segment.slice(0, eq));
    const value = requestPart(eq < 0 ? '' : segment.slice(eq + 1));
    if (name === null || value === null) return refused('invalid');
    if (name === 'reference') {
      if (!valid(value) || out.references.includes(value) || out.references.length >= PAYMENT_REQUEST.REFERENCES_MAX) {
        return refused('invalid');
      }
      out.references.push(value);
    } else if (name === 'label') {
      label ??= value;
    } else if (name === 'message') {
      message ??= value;
    } else if (PAYMENT_REQUEST_ONCE.includes(name)) {
      if (seen.has(name)) return refused('invalid');
      seen.add(name);
      if (name === 'amount') {
        if (!REQUEST_AMOUNT_RE.test(value)) return refused('amount');
        out.amount = /[1-9]/.test(value) ? value : null;
      } else if (name === 'spl-token') {
        if (!valid(value)) return refused('token');
        out.mint = value;
      } else {
        if (!isPaymentRequestMemo(value)) return refused('invalid');
        out.memo = value;
      }
    }
  }
  return { ...out, label: requestText(label), message: requestText(message) };
}

/**
 * The canonical decimal string of a typed amount ("01.50" → "1.5"), or null when it is not a positive
 * number with at most `decimals` fraction digits. No grouping, sign or exponent is accepted.
 * @param {string} text
 * @param {number} decimals
 * @returns {string|null}
 */
export function canonicalAmount(text, decimals) {
  const trimmed = String(text ?? '').trim();
  if (!/^[0-9]*(\.[0-9]*)?$/.test(trimmed) || !/[0-9]/.test(trimmed)) return null;
  const [wholeRaw, fraction = ''] = trimmed.split('.');
  const whole = wholeRaw.replace(/^0+(?=[0-9])/, '') || '0';
  try {
    const units = parseUnits(fraction ? `${whole}.${fraction}` : whole, decimals);
    return units > 0n ? formatUnits(units, decimals) : null;
  } catch {
    return null;
  }
}

/**
 * Base units as "<amount> <symbol>"; a dash when the value is not a u64 decimal string.
 * @param {string|bigint} units
 * @param {number} decimals
 * @param {string} symbol
 * @returns {string}
 */
export function formatAmount(units, decimals, symbol) {
  try {
    return `${formatUnits(units, decimals)} ${symbol}`;
  } catch {
    return `— ${symbol}`;
  }
}

/**
 * A date and time in the UI language, or a dash.
 * @param {number} ms
 * @returns {string}
 */
export function formatTime(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleString(currentLanguage());
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/**
 * A UTC day given in Unix seconds (the day a device was linked) as a date in the UI language, or a dash.
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatDay(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '—';
  const day = new Date(seconds * 1000);
  try {
    return day.toLocaleDateString(currentLanguage(), { timeZone: 'UTC' });
  } catch {
    return day.toLocaleDateString(undefined, { timeZone: 'UTC' });
  }
}

/**
 * The two fields of every screen that sets a new password (create, import, restore, change) and their live check:
 * the rule of both wallets, at least core.PASSWORD_MIN_LENGTH characters (core.passwordTooShort, the copy the app
 * uses too) typed twice, nothing else. The length line turns from × to ✓ as the password reaches the minimum; once
 * the second field has text, a line says whether the two match. The worker checks the length again.
 * @param {{PASSWORD_MIN_LENGTH: number, passwordTooShort: (password: string) => boolean}} rule qnet-core, passed in
 *   by the page: the kit, which the approve page loads too, never loads the bundle
 * @returns {{first: HTMLInputElement, second: HTMLInputElement, nodes: HTMLElement[],
 *   read: (message: {show: (text: string) => void}) => string|null, refresh: () => void}} read: the password, or
 *   null after showing why it cannot be used; refresh: redraws the lines after the fields were emptied
 */
export function newPasswordFields(rule) {
  const first = passwordInput('new-password');
  const second = passwordInput('confirm-password');
  const length = el('div', { className: 'hint', attrs: { 'data-check': 'length' } });
  const match = el('div', { className: 'hint', attrs: { 'data-check': 'match' } });
  const refresh = () => {
    const long = !rule.passwordTooShort(first.value);
    length.classList.toggle('hint-ok', long);
    length.textContent = `${long ? '✓' : '×'} ${t('passwordMinChars', [rule.PASSWORD_MIN_LENGTH])}`;
    if (second.value !== '' && first.value !== second.value) {
      match.className = 'hint hint-bad';
      match.textContent = t('passwordMismatch');
    } else if (second.value !== '' && long) {
      match.className = 'hint hint-ok';
      match.textContent = `✓ ${t('passwordsMatch')}`;
    } else {
      match.className = 'hint hidden';
      match.textContent = '';
    }
  };
  first.addEventListener('input', refresh);
  second.addEventListener('input', refresh);
  refresh();
  return {
    first,
    second,
    nodes: [field(t('passwordNew'), first), length, field(t('passwordConfirm'), second), match],
    read(message) {
      const value = first.value;
      if (rule.passwordTooShort(value)) {
        message.show(t('passwordTooShort', [rule.PASSWORD_MIN_LENGTH]));
        return null;
      }
      if (value !== second.value) {
        second.value = '';
        refresh();
        message.show(t('passwordMismatch'));
        return null;
      }
      return value;
    },
    refresh,
  };
}

/**
 * Calls fn when Enter is pressed in `input` (outside an IME composition).
 * @param {HTMLElement} input
 * @param {() => void} fn
 * @returns {void}
 */
export function onEnter(input, fn) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      fn();
    }
  });
}

/**
 * Runs `task` with `controls` disabled, re-enabling them afterwards.
 * @template T
 * @param {HTMLElement[]} controls
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function whileBusy(controls, task) {
  for (const control of controls) {
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');
  }
  try {
    return await task();
  } finally {
    for (const control of controls) {
      control.disabled = false;
      control.removeAttribute('aria-busy');
    }
  }
}

// The confirmation vault.removeEarlier requires: sent once the user pressed the confirming button, never typed.
const EARLIER_REMOVE_CONFIRM = 'REMOVE';

/**
 * What an earlier version of this extension left in this browser (M-4, its encrypted wallet among it), with Remove behind
 * one confirmation that says the wallet then opens only with its recovery phrase: vault.removeEarlier, which removes it
 * only while a vault of this version exists and is unlocked. Shown by the setup's last screen and by Settings.
 * @param {{onRemoved: () => void}} options
 * @returns {HTMLElement}
 */
export function earlierRemoval({ onRemoved }) {
  const message = messageLine();
  const actions = el('div', { className: 'stack' });
  const offer = () => {
    message.clear();
    actions.replaceChildren(button(t('earlierRemoveButton'), () => confirmStep(), { action: 'remove-earlier' }));
  };
  const confirmStep = () => {
    const remove = button(t('earlierRemoveConfirm'), null, { kind: 'danger', action: 'confirm-remove-earlier' });
    remove.addEventListener('click', async () => {
      message.clear();
      try {
        await whileBusy([remove], () => call('vault.removeEarlier', { confirm: EARLIER_REMOVE_CONFIRM }));
      } catch (error) {
        if (remove.isConnected) message.show(errorText(error));
        return;
      }
      onRemoved();
    });
    actions.replaceChildren(notice('warn', t('earlierRemoveWarn')),
      el('div', { className: 'row actions' }, button(t('cancel'), offer, { action: 'cancel-remove-earlier' }), remove));
  };
  offer();
  return el('div', { className: 'stack' }, actions, message.node);
}

/**
 * Calls onTick(secondsLeft) every second until `until` (ms epoch), then onDone(). Returns stop.
 * @param {number} until
 * @param {(seconds: number) => void} onTick
 * @param {() => void} onDone
 * @returns {() => void}
 */
export function countdown(until, onTick, onDone) {
  let timer = null;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(timer);
      timer = null;
      onDone();
      return;
    }
    onTick(left);
  };
  timer = setInterval(tick, 1000);
  tick();
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
}

/**
 * The text of a worker error for the user, in the UI language: err_<CODE> of the i18n tables (every
 * worker code has one), err_INTERNAL for anything else. Never the router's English message, never the
 * raw text of a local exception.
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  const code = error instanceof UiError ? error.code : 'INTERNAL';
  if (code === 'BACKOFF' && Number.isSafeInteger(error.retryAfterMs)) {
    return t('err_BACKOFF_wait', [Math.max(1, Math.ceil(error.retryAfterMs / 1000))]);
  }
  return codeText(code);
}

/**
 * The text of an error code (err_<CODE>), err_INTERNAL when the code has none.
 * @param {string} code
 * @returns {string}
 */
export function codeText(code) {
  const key = `err_${code}`;
  const text = typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? t(key) : key;
  return text === key ? t('err_INTERNAL') : text;
}

/**
 * The error code of a failure, 'INTERNAL' for anything that is not a worker error.
 * @param {unknown} error
 * @returns {string}
 */
export function errorCode(error) {
  return error instanceof UiError ? error.code : 'INTERNAL';
}

/**
 * Opens an https page in a new tab (chrome.tabs.create needs no permission). Anything else is ignored.
 * @param {string} url
 * @returns {void}
 */
export function openTab(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:') return;
  chrome.tabs.create({ url: parsed.href }).catch(() => {});
}

/**
 * Explorer page of a QNet transaction.
 * @param {string} hash
 * @returns {string}
 */
export function qnetTxUrl(hash) {
  return `${QNET.EXPLORER_API}${QNET.EXPLORER_TX_PATH}${encodeURIComponent(hash)}`;
}

/**
 * Solana explorer page of a transaction on this build's cluster.
 * @param {string} signature
 * @returns {string}
 */
export function solanaTxUrl(signature) {
  return `${SOLANA.EXPLORER_TX_URL}${encodeURIComponent(signature)}${SOLANA.EXPLORER_CLUSTER_QUERY}`;
}
