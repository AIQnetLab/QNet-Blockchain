// Shared by the extension pages. The DOM is written only with createElement and textContent: no HTML is
// ever parsed from data (R23, EXT-02). Pages reach the worker only through call(), and hold no keys.
import { formatUnits, parseUnits } from '../background/amount.js';
import {
  DECIMALS, DEFAULT_LANGUAGE, RTL_LANGUAGES, SUPPORTED_LANGUAGES, TIMINGS, UI_PAGES, VIEW_EVENT_CHANNEL, VIEW_EVENTS,
} from '../background/config.js';
import { log } from '../background/log.js';
import EN from './i18n/en.js';
import { loadMessages } from './i18n/index.js';

export { DECIMALS, formatUnits, log, parseUnits };

const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
const SECRET_INPUT_ATTRIBUTES = Object.freeze({
  spellcheck: 'false',
  autocomplete: 'off',
  autocapitalize: 'off',
  autocorrect: 'off',
  'data-gramm': 'false',
  'data-gramm_editor': 'false',
  'data-enable-grammarly': 'false',
  'data-lt-active': 'false',
});

/** A worker error as the page sees it: the envelope's code and fixed message. */
export class UiError extends Error {
  /**
   * @param {string} code an ERROR_MESSAGES key
   * @param {{message?: string, retryAfterMs?: number, field?: string, walkSteps?: number}} [details]
   */
  constructor(code, details = {}) {
    super(typeof details.message === 'string' ? details.message : code);
    this.name = 'UiError';
    this.code = code;
    if (Number.isSafeInteger(details.retryAfterMs)) this.retryAfterMs = details.retryAfterMs;
    if (typeof details.field === 'string') this.field = details.field;
    if (Number.isSafeInteger(details.walkSteps) && details.walkSteps > 0) this.walkSteps = details.walkSteps;
  }
}

/**
 * First statement of every page script: extension pages never run inside a frame (R10).
 * @throws {Error} when framed
 */
export function refuseFramed() {
  if (window.top !== window) throw new Error('framed');
}

/**
 * Empties the page's web storage. The pages keep nothing there; an earlier version of this extension (2.x) kept a copy
 * of its password and addresses in it, which goes the first time a page of this version opens (M-4).
 * @returns {void}
 */
export function clearPageStorage() {
  for (const area of ['localStorage', 'sessionStorage']) {
    try {
      globalThis[area].clear();
    } catch {
      // unavailable
    }
  }
}

const TEXT_FIELDS = new Set(['INPUT', 'TEXTAREA']);

/**
 * No field takes the cursor on its own (owner, 06.10), on any page: the pages never call focus(), and until the user's
 * first press of a pointer or a key on the page, a text field that gets the focus anyway (the browser's own first focus
 * of a popup or window) gives it back at once. A click or Tab into a field works as always.
 * @returns {() => void} stop
 */
export function refuseAutoFocus() {
  const doc = globalThis.document;
  if (typeof doc?.addEventListener !== 'function') return () => {};
  let acted = false;
  const act = () => {
    acted = true;
  };
  const onFocus = (event) => {
    const target = event?.target;
    if (acted || !TEXT_FIELDS.has(target?.tagName) || typeof target.blur !== 'function') return;
    target.blur();
  };
  const bindings = [['pointerdown', act], ['mousedown', act], ['keydown', act], ['focusin', onFocus]];
  for (const [type, listener] of bindings) doc.addEventListener(type, listener, true);
  return () => {
    for (const [type, listener] of bindings) doc.removeEventListener(type, listener, true);
  };
}

/**
 * createElement with text and safe attributes. Children that are strings become text nodes.
 * @param {string} tag
 * @param {{className?: string, text?: string|number, attrs?: Record<string, string|number|boolean>,
 *   on?: Record<string, EventListener>}} [props]
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {HTMLElement}
 * @throws {Error} for event-handler, style or srcdoc attributes, and javascript:/data: URLs
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined && props.text !== null) node.textContent = String(props.text);
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    const lower = name.toLowerCase();
    if (lower.startsWith('on') || lower === 'style' || lower === 'srcdoc') throw new Error(`unsafe attribute ${name}`);
    if (URL_ATTRIBUTES.has(lower) && /^\s*(javascript|data|vbscript):/i.test(String(value))) {
      throw new Error(`unsafe URL in ${name}`);
    }
    node.setAttribute(name, String(value));
  }
  for (const [type, listener] of Object.entries(props.on ?? {})) node.addEventListener(type, listener);
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

/**
 * Removes every child of `node`.
 * @param {Element} node
 * @returns {void}
 */
export function clear(node) {
  node.replaceChildren();
}

/**
 * Marks a seed, word, password or activation-code field so no spellchecker, autofill or grammar
 * extension receives its value (R13).
 * @param {HTMLInputElement|HTMLTextAreaElement} input
 * @returns {HTMLInputElement|HTMLTextAreaElement} the same element
 */
export function hardenSecretInput(input) {
  for (const [name, value] of Object.entries(SECRET_INPUT_ATTRIBUTES)) input.setAttribute(name, value);
  return input;
}

/**
 * Empties the value of every input and textarea under `root` (the .value, not textContent: EXT-SEC-12).
 * @param {ParentNode} root
 * @returns {void}
 */
export function wipeInputs(root) {
  for (const field of root.querySelectorAll('input, textarea')) field.value = '';
}

/**
 * First and last characters of an address around an ellipsis, for lists (full address on review screens).
 * @param {string} address
 * @param {number} [keep] characters kept at each end
 * @returns {string}
 */
export function shortAddress(address, keep = 6) {
  if (typeof address !== 'string') return '';
  return address.length <= keep * 2 + 1 ? address : `${address.slice(0, keep)}…${address.slice(-keep)}`;
}

let requestSeq = 0;

/**
 * One request to the worker. Resolves with the envelope's result; rejects with UiError otherwise.
 * @param {string} type a UI message type (CONTRACTS.md)
 * @param {object} [params]
 * @returns {Promise<unknown>}
 * @throws {UiError}
 */
export async function call(type, params = {}) {
  requestSeq += 1;
  const id = `r${requestSeq.toString(36)}`;
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type, id, params });
  } catch {
    throw new UiError('INTERNAL');
  }
  if (!reply || typeof reply !== 'object' || reply.id !== id) throw new UiError('INTERNAL');
  if (reply.ok === true) return reply.result;
  const error = reply.error && typeof reply.error === 'object' ? reply.error : {};
  throw new UiError(typeof error.code === 'string' ? error.code : 'INTERNAL', error);
}

/**
 * Subscribes to worker broadcasts ('locked', 'unlocked', 'wiped', 'activation', 'approval'). Only
 * messages from this extension's worker are accepted; content scripts can message pages too.
 * @param {(event: string, data: unknown) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onWalletEvent(handler) {
  const workerUrl = chrome.runtime.getURL('background/sw.js');
  const listener = (message, sender) => {
    if (sender?.id !== chrome.runtime.id || sender.tab || sender.url !== workerUrl) return;
    if (!message || message.channel !== VIEW_EVENT_CHANNEL || !VIEW_EVENTS.includes(message.event)) return;
    handler(message.event, message.data ?? null);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

let table = EN;
let language = DEFAULT_LANGUAGE;

/**
 * Makes `language` (a SUPPORTED_LANGUAGES code; anything else means DEFAULT_LANGUAGE) the language of t()
 * and of the document: <html lang> and dir (rtl for RTL_LANGUAGES). Its table comes from ui/i18n/; if it
 * cannot be loaded the page stays in English.
 * @param {string} requested
 * @returns {Promise<void>}
 */
export async function loadLocale(requested) {
  let code = SUPPORTED_LANGUAGES.includes(requested) ? requested : DEFAULT_LANGUAGE;
  let next = EN;
  if (code !== DEFAULT_LANGUAGE) {
    try {
      next = await loadMessages(code);
    } catch (error) {
      log.warn('locale not loaded', error?.name);
      code = DEFAULT_LANGUAGE;
    }
  }
  table = next;
  language = code;
  const root = globalThis.document?.documentElement;
  if (root) {
    root.setAttribute('lang', code);
    root.setAttribute('dir', RTL_LANGUAGES.includes(code) ? 'rtl' : 'ltr');
  }
}

/**
 * The language t() speaks now (a SUPPORTED_LANGUAGES code), for dates and number formats.
 * @returns {string}
 */
export function currentLanguage() {
  return language;
}

// First-strong isolate and pop: a substituted address, origin or amount keeps its own direction inside
// right-to-left text.
const ISOLATE_START = '⁨';
const ISOLATE_END = '⁩';

/**
 * Localized text of a key with $1..$9 substitutions; English when the table lacks it (the i18n tests
 * keep every table complete); the key itself when English has no such key either. In a right-to-left
 * language each substitution is bidi-isolated.
 * @param {string} key
 * @param {Array<string|number>} [substitutions]
 * @returns {string}
 */
export function t(key, substitutions = []) {
  let template = null;
  if (Object.hasOwn(table, key)) template = table[key];
  else if (Object.hasOwn(EN, key)) template = EN[key];
  if (template === null) return key;
  const isolate = RTL_LANGUAGES.includes(language);
  return template.replace(/\$(\$|[1-9])/g, (match, slot) => {
    if (slot === '$') return '$';
    const value = substitutions[Number(slot) - 1];
    if (value === undefined || value === null || value === '') return '';
    return isolate ? `${ISOLATE_START}${value}${ISOLATE_END}` : String(value);
  });
}

// This page made a copy with clearAfterMs that no later copy from it replaced yet (clearCopiedNow).
let copyPending = false;

// Tells the worker, which empties the clipboard when the time is up whether or not this page is still open
// (clipboard.schedule); a failure is logged, the copy itself stands.
async function scheduleClear(afterMs) {
  try {
    await call('clipboard.schedule', { afterMs });
  } catch (error) {
    log.warn('clipboard clear not scheduled', error?.code);
  }
}

/**
 * Writes text to the clipboard after an explicit click. With clearAfterMs (a secret: R14), the worker empties the
 * clipboard after that delay unless a later copy from a wallet page replaced it (clipboard.schedule), also once this page
 * is closed. Every copy without one tells the worker too, from whichever page or popup made it, and drops a clear still
 * pending: the secret is no longer on the clipboard. Nothing reads the clipboard back (that needs the clipboardRead
 * permission). copyText('') empties the clipboard now (a phrase pasted into Import).
 * @param {string} text
 * @param {{clearAfterMs?: number}} [options]
 * @returns {Promise<void>}
 */
export async function copyText(text, options = {}) {
  if (typeof text !== 'string') throw new UiError('INTERNAL');
  await navigator.clipboard.writeText(text);
  const delay = options.clearAfterMs;
  const timed = text !== '' && Number.isSafeInteger(delay) && delay > 0;
  copyPending = timed;
  // sent at once in either case; only a secret's copy waits for the worker's answer, an address shows "Copied" at once
  const told = scheduleClear(timed ? delay : 0);
  if (timed) await told;
}

/**
 * Empties the clipboard now when it still holds a copy this page made with clearAfterMs (the worker writes it:
 * clipboard.clearNow, which needs no focus). Anything else on the clipboard is left alone. Resolves once the worker
 * answered; never rejects.
 * @returns {Promise<void>}
 */
export async function clearCopiedNow() {
  if (!copyPending) return;
  copyPending = false;
  try {
    await call('clipboard.clearNow');
  } catch (error) {
    log.warn('clipboard not cleared', error?.code);
  }
}

const REVEAL_KEYS = new Set([' ', 'Enter']);

/**
 * Hold-to-reveal for a secret already fetched: shows it only while the control is pressed, hides it
 * on release, blur, visibilitychange, lock and after autoHideMs; then drops the text (R12).
 * @param {HTMLElement} control the press-and-hold button
 * @param {HTMLElement} target where the text is shown (textContent)
 * @param {string} secret
 * @param {{autoHideMs?: number, onExpire?: () => void, placeholder?: string}} [options] placeholder:
 *   what the target shows while hidden (default empty)
 * @returns {() => void} dispose: hides and forgets the secret
 */
export function holdToReveal(control, target, secret, options = {}) {
  const autoHideMs = Number.isSafeInteger(options.autoHideMs) && options.autoHideMs > 0
    ? options.autoHideMs : TIMINGS.REVEAL_AUTO_HIDE_MS;
  const placeholder = typeof options.placeholder === 'string' ? options.placeholder : '';
  let text = typeof secret === 'string' ? secret : '';
  let disposed = false;

  const hide = () => {
    target.textContent = placeholder;
    target.classList.remove('revealed');
    control.setAttribute('aria-pressed', 'false');
  };
  const show = (event) => {
    if (disposed || text === '') return;
    if (event.type === 'keydown' && !REVEAL_KEYS.has(event.key)) return;
    if (event.type === 'pointerdown' && event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    target.textContent = text;
    target.classList.add('revealed');
    control.setAttribute('aria-pressed', 'true');
  };
  const hideUnlessVisible = () => {
    if (document.visibilityState !== 'visible') hide();
  };
  const preventMenu = (event) => event.preventDefault();

  const bindings = [
    [control, 'pointerdown', show], [control, 'keydown', show],
    [control, 'pointerup', hide], [control, 'pointerleave', hide], [control, 'pointercancel', hide],
    [control, 'keyup', hide], [control, 'blur', hide], [control, 'contextmenu', preventMenu],
    [window, 'blur', hide], [document, 'visibilitychange', hideUnlessVisible],
  ];
  for (const [node, type, listener] of bindings) node.addEventListener(type, listener);
  hide();

  let timer = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    for (const [node, type, listener] of bindings) node.removeEventListener(type, listener);
    text = '';
    hide();
    control.disabled = true;
  };
  timer = setTimeout(() => {
    dispose();
    if (typeof options.onExpire === 'function') options.onExpire();
  }, autoHideMs);
  return dispose;
}

// The steps setup opens at when the popup names one (setup.html?flow=).
const SETUP_FLOWS = Object.freeze(['create', 'import']);

/**
 * Opens ui/setup.html in a tab (chrome.tabs.create needs no permission) and closes the popup. With `flow` 'create' or
 * 'import' setup opens straight at that step; without one, at its first screen.
 * @param {'create'|'import'|null} [flow]
 * @returns {Promise<void>}
 */
export async function openSetup(flow = null) {
  const query = SETUP_FLOWS.includes(flow) ? `?flow=${flow}` : '';
  await chrome.tabs.create({ url: `${chrome.runtime.getURL(UI_PAGES.setup)}${query}` });
  window.close();
}
