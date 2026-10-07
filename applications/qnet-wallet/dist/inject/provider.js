// MAIN-world provider on the manifest's dApp origins (spec: dApp provider protocol). The trust anchor is
// the qnet:announceProvider event (the provider announcement); window.qnet is only a convenience alias. The object
// holds no authority: every decision (grant, approval, signing) happens in the worker.
// Content scripts are classic scripts, so the constants below mirror background/config.js PROVIDER
// (test/skeleton.test.mjs keeps them equal).
(() => {
  'use strict';

  const TO_RELAY = 'qnet-relay';
  const TO_PAGE = 'qnet-provider';
  const ANNOUNCE_EVENT = 'qnet:announceProvider';
  const REQUEST_EVENT = 'qnet:requestProvider';
  const EVENTS = Object.freeze(['accountsChanged', 'disconnect']);
  const NAME = 'QNet Wallet';
  const RDNS = 'io.aiqnet.wallet';
  const CHANNEL = 'extension';
  // The announcement icon is a data URI: the page cannot load extension files (no web_accessible_resources).
  const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMwMGQ0ZmYiLz48L3N2Zz4=';
  const MAX_MESSAGE_CHARS = 16384;
  const ERROR_MESSAGES = Object.freeze({
    4001: 'User rejected the request',
    4100: 'Unauthorized',
    4200: 'Unsupported method',
    4900: 'Disconnected',
    [-32602]: 'Invalid params',
    [-32603]: 'Internal error',
  });
  // The one other text a 4001 may carry: the origin is in its approval cooldown (errors.js APPROVAL_COOLDOWN).
  const COOLDOWN_MESSAGE = 'Too many rejected requests from this site, try again later';
  // The one error with data and the one other text a -32602 carries: a contract call field the network does not
  // accept (errors.js UNSUPPORTED_PARAM_MESSAGE).
  const UNSUPPORTED_PARAM = 'UNSUPPORTED_PARAM';
  const UNSUPPORTED_PARAM_MESSAGE = 'Unsupported parameter';

  // Taken before any page script runs, so a page that later replaces these globals cannot redirect
  // the provider's own messages or events.
  const origin = window.location.origin;
  const postToWindow = window.postMessage.bind(window);
  const listenOnWindow = window.addEventListener.bind(window);
  const dispatchOnWindow = window.dispatchEvent.bind(window);
  const EventCtor = CustomEvent;
  const reportError = typeof window.reportError === 'function' ? window.reportError.bind(window) : () => {};
  const randomUuid = typeof crypto.randomUUID === 'function' ? crypto.randomUUID.bind(crypto) : null;
  const randomBytes = crypto.getRandomValues.bind(crypto);

  const listeners = Object.freeze({ accountsChanged: new Set(), disconnect: new Set() });
  const pending = new Map(); // request id → {resolve, reject}
  let provider = null;
  let detail = null;

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }

  function uuid() {
    if (randomUuid !== null) return randomUuid();
    const bytes = randomBytes(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function jsonLength(value) {
    try {
      const text = JSON.stringify(value);
      return typeof text === 'string' ? text.length : Infinity;
    } catch {
      return Infinity;
    }
  }

  /**
   * Error thrown to dApps: {code, message} with the provider error codes 4001, 4100, 4200, 4900, -32602, -32603.
   * The message is this script's own text for the code (COOLDOWN_MESSAGE for a 4001 that says so); an
   * unknown code becomes -32603. A -32602 for a contract call field the network does not accept has the text
   * UNSUPPORTED_PARAM_MESSAGE and a frozen data {reason: 'UNSUPPORTED_PARAM'}; no other error has data.
   * @param {unknown} code
   * @param {unknown} [message] the worker's text, used only when it is COOLDOWN_MESSAGE on a 4001
   * @param {unknown} [data] the worker's data, kept only in that one shape
   * @returns {Error & {code: number, data?: {reason: string}}}
   */
  function providerError(code, message, data) {
    const known = Number.isInteger(code) && Object.hasOwn(ERROR_MESSAGES, code) ? code : -32603;
    const unsupported = known === -32602 && isPlainObject(data) && data.reason === UNSUPPORTED_PARAM;
    let text = ERROR_MESSAGES[known];
    if (known === 4001 && message === COOLDOWN_MESSAGE) text = COOLDOWN_MESSAGE;
    else if (unsupported) text = UNSUPPORTED_PARAM_MESSAGE;
    const error = new Error(text);
    error.code = known;
    if (unsupported) error.data = Object.freeze({ reason: UNSUPPORTED_PARAM });
    return error;
  }

  /**
   * Provider request. Validates {method: string, params?} locally (-32602 otherwise), posts
   * {target: TO_RELAY, id, method, params} to window.location.origin and resolves with the worker's
   * result or rejects with providerError. No timeout: approvals wait for the user; a closed port
   * answers 4900.
   * @param {{method: string, params?: unknown}} args
   * @returns {Promise<unknown>}
   */
  function request(args) {
    return new Promise((resolve, reject) => {
      let message;
      try {
        if (!isPlainObject(args) || typeof args.method !== 'string' || args.method.length === 0) throw new TypeError();
        message = { target: TO_RELAY, id: uuid(), method: args.method };
        if (args.params !== undefined) message.params = args.params;
      } catch {
        reject(providerError(-32602));
        return;
      }
      // The relay drops what it cannot read; refusing here keeps the promise from waiting forever.
      if (jsonLength(message) > MAX_MESSAGE_CHARS) {
        reject(providerError(-32602));
        return;
      }
      pending.set(message.id, { resolve, reject });
      try {
        postToWindow(message, origin);
      } catch {
        pending.delete(message.id);
        reject(providerError(-32602));
      }
    });
  }

  function checkSubscription(event, listener) {
    if (!EVENTS.includes(event)) throw new TypeError('Unsupported event');
    if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
  }

  /**
   * Subscribes to 'accountsChanged' ({qnet, solana} or {}) or 'disconnect' ({code: 4900, message}).
   * Other names throw TypeError.
   * @param {'accountsChanged'|'disconnect'} event
   * @param {(data: unknown) => void} listener
   * @returns {object} the provider, for chaining
   */
  function on(event, listener) {
    checkSubscription(event, listener);
    listeners[event].add(listener);
    return provider;
  }

  /**
   * @param {'accountsChanged'|'disconnect'} event
   * @param {(data: unknown) => void} listener
   * @returns {object} the provider
   */
  function removeListener(event, listener) {
    checkSubscription(event, listener);
    listeners[event].delete(listener);
    return provider;
  }

  function emit(event, data) {
    const payload = isPlainObject(data) ? Object.freeze({ ...data }) : data;
    for (const listener of [...listeners[event]]) {
      try {
        listener(payload);
      } catch (error) {
        reportError(error);
      }
    }
  }

  /**
   * window 'message' listener for {target: TO_PAGE} answers and events from the relay (same window,
   * same origin); settles pending requests and calls listeners (a throwing listener does not stop others).
   * @param {MessageEvent} event
   * @returns {void}
   */
  function onRelayMessage(event) {
    if (event.source !== window || event.origin !== origin) return;
    const { data } = event;
    if (!isPlainObject(data) || data.target !== TO_PAGE) return;
    if (Object.hasOwn(data, 'event')) {
      if (EVENTS.includes(data.event)) emit(data.event, data.data ?? null);
      return;
    }
    const entry = typeof data.id === 'string' ? pending.get(data.id) : undefined;
    if (entry === undefined) return;
    pending.delete(data.id);
    if (data.ok === true) entry.resolve(data.result);
    else if (isPlainObject(data.error)) entry.reject(providerError(data.error.code, data.error.message, data.error.data));
    else entry.reject(providerError(undefined));
  }

  /**
   * Dispatches ANNOUNCE_EVENT with a frozen detail {info: {uuid, name: NAME, icon: ICON, rdns: RDNS,
   * channel: CHANNEL}, provider}; uuid is crypto.randomUUID(), fixed for the page load.
   * @returns {void}
   */
  function announce() {
    dispatchOnWindow(new EventCtor(ANNOUNCE_EVENT, { detail }));
  }

  /**
   * Builds the frozen provider {isQNet: true, request, on, removeListener} and the frozen info, defines
   * window.qnet (non-writable, non-configurable) inside try/catch, listens for REQUEST_EVENT and relay
   * messages, and announces once.
   * @returns {void}
   */
  function start() {
    for (const fn of [request, on, removeListener]) Object.freeze(fn);
    provider = Object.freeze({ isQNet: true, request, on, removeListener });
    detail = Object.freeze({
      info: Object.freeze({ uuid: uuid(), name: NAME, icon: ICON, rdns: RDNS, channel: CHANNEL }),
      provider,
    });
    try {
      Object.defineProperty(window, 'qnet', { value: provider, writable: false, configurable: false, enumerable: true });
    } catch {
      // window.qnet is taken; dApps find this provider through the announcement
    }
    listenOnWindow('message', onRelayMessage);
    listenOnWindow(REQUEST_EVENT, announce);
    announce();
  }

  start();
})();
