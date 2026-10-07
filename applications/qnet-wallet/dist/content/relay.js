// Isolated-world content script on the manifest's dApp origins only. It carries provider requests from
// the page (inject/provider.js, MAIN world) to the worker over one 'qnet-provider' port and carries
// answers and events back. It holds no state beyond pending ids, reads no storage, and adds nothing to
// a request: the worker takes the origin from the port's sender, never from the message. An event for a page whose
// port is closed (an idle worker stopped and closed it) comes from the worker through the tab (chrome.tabs.sendMessage)
// and is forwarded the same way.
// Content scripts are classic scripts, so the constants below mirror background/config.js PROVIDER
// (test/skeleton.test.mjs keeps them equal).
(() => {
  'use strict';

  const PORT_NAME = 'qnet-provider';
  const TO_RELAY = 'qnet-relay';
  const TO_PAGE = 'qnet-provider';
  const MAX_MESSAGE_CHARS = 16384;
  const EVENTS = Object.freeze(['accountsChanged', 'disconnect']);
  const TAB_EVENT = 'qnet-provider-event';
  const DISCONNECTED = Object.freeze({ code: 4900, message: 'Disconnected' });
  const INTERNAL = Object.freeze({ code: -32603, message: 'Internal error' });
  const REQUEST_KEYS = Object.freeze(['target', 'id', 'method', 'params']);
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  const origin = window.location.origin;
  const pending = new Map(); // id key → {id, port} of every request not answered yet
  let current = null;

  // Structured clones and port messages are plain objects of whichever realm made them.
  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }

  const isRequestId = (id) => (typeof id === 'string' && ID_RE.test(id)) || (Number.isSafeInteger(id) && id >= 0);
  const idKey = (id) => `${typeof id}:${id}`;

  function jsonLength(value) {
    try {
      const text = JSON.stringify(value);
      return typeof text === 'string' ? text.length : Infinity;
    } catch {
      return Infinity;
    }
  }

  function toPage(message) {
    try {
      window.postMessage({ target: TO_PAGE, ...message }, origin);
    } catch {
      // the page is going away
    }
  }

  // The one error that carries data: -32602 for a contract call field the network does not accept (errors.js
  // toProviderError); any other data is dropped.
  const errorData = (error) => (error.code === -32602 && isPlainObject(error.data) && Object.keys(error.data).length === 1
    && error.data.reason === 'UNSUPPORTED_PARAM' ? { data: { reason: error.data.reason } } : {});
  const answerError = (id, error) => toPage({ id, ok: false, error: { code: error.code, message: error.message, ...errorData(error) } });

  /**
   * Whether a window 'message' event is a request from this page to the relay: same window as source,
   * same origin, a plain object {target: TO_RELAY, id, method, params} whose id is a string of
   * [A-Za-z0-9_-]{1,64} or a non-negative safe integer, method a string, and JSON size within
   * MAX_MESSAGE_CHARS. Anything else is ignored without an answer.
   * @param {MessageEvent} event
   * @returns {{id: string|number, method: string, params?: unknown}|null} the request without `target`
   */
  function readPageRequest(event) {
    if (event.source !== window || event.origin !== origin) return null;
    const { data } = event;
    if (!isPlainObject(data) || data.target !== TO_RELAY) return null;
    if (Object.keys(data).some((key) => !REQUEST_KEYS.includes(key))) return null;
    if (!isRequestId(data.id) || typeof data.method !== 'string') return null;
    if (jsonLength(data) > MAX_MESSAGE_CHARS) return null;
    const request = { id: data.id, method: data.method };
    if (data.params !== undefined) request.params = data.params;
    return request;
  }

  /**
   * Port closed: every request sent on it is answered {ok: false, error: DISCONNECTED}.
   * @param {chrome.runtime.Port} closed
   * @returns {void}
   */
  function failPending(closed) {
    for (const [key, entry] of pending) {
      if (entry.port !== closed) continue;
      pending.delete(key);
      answerError(entry.id, DISCONNECTED);
    }
  }

  /**
   * Worker → page: a response {id, ok, result|error} for a pending id (which stops being pending), or an
   * event {event, data} with event in EVENTS, posted as {target: TO_PAGE, ...} to window.location.origin
   * (never '*'). Unknown shapes and ids are dropped.
   * @param {unknown} message
   * @param {chrome.runtime.Port} from
   * @returns {void}
   */
  function deliver(message, from) {
    if (!isPlainObject(message)) return;
    if (Object.hasOwn(message, 'event')) {
      if (EVENTS.includes(message.event)) toPage({ event: message.event, data: message.data ?? null });
      return;
    }
    if (!isRequestId(message.id)) return;
    const key = idKey(message.id);
    const entry = pending.get(key);
    if (entry === undefined || entry.port !== from) return;
    pending.delete(key);
    if (message.ok === true) {
      toPage({ id: entry.id, ok: true, result: message.result ?? null });
    } else if (message.ok === false && isPlainObject(message.error) && Number.isInteger(message.error.code)
      && typeof message.error.message === 'string') {
      answerError(entry.id, message.error);
    } else {
      answerError(entry.id, INTERNAL);
    }
  }

  /**
   * The open port, connecting lazily on the first request and again after a disconnect (a worker
   * restart closes every port). Registers onMessage (deliver) and onDisconnect (failPending).
   * @returns {chrome.runtime.Port}
   */
  function port() {
    if (current !== null) return current;
    const opened = chrome.runtime.connect({ name: PORT_NAME });
    opened.onMessage.addListener(deliver);
    opened.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read, so a closed worker is not reported as unchecked
      if (current === opened) current = null;
      failPending(opened);
    });
    current = opened;
    return opened;
  }

  /**
   * Sends one request to the worker as {id, method, params} and remembers its id as pending. A request
   * whose id is already pending is dropped without an answer, so no page script can take over another
   * caller's reply.
   * @param {{id: string|number, method: string, params?: unknown}} request
   * @returns {void}
   */
  function forward(request) {
    const key = idKey(request.id);
    if (pending.has(key)) return;
    let target = null;
    try {
      target = port();
      pending.set(key, { id: request.id, port: target });
      target.postMessage(request);
    } catch {
      // extension reloaded or the port died between checks: this request cannot reach the worker
      pending.delete(key);
      if (target !== null && current === target) current = null;
      answerError(request.id, DISCONNECTED);
    }
  }

  /**
   * Worker → page through the tab: {target: TAB_EVENT, origin, event, data} from this extension's worker only (sender.id
   * is this extension, the sender is its service worker, never a tab), for this page's own origin (a tab that navigated
   * to another origin after the worker looked it up gets nothing), event in EVENTS; posted to the page as a port event
   * is. Anything else is dropped.
   * @param {unknown} message
   * @param {chrome.runtime.MessageSender} sender
   * @returns {void}
   */
  function deliverTabEvent(message, sender) {
    if (!sender || sender.id !== chrome.runtime.id || sender.tab !== undefined) return;
    if (typeof sender.url === 'string' && sender.url !== chrome.runtime.getURL('background/sw.js')) return;
    if (!isPlainObject(message) || message.target !== TAB_EVENT || message.origin !== origin || !EVENTS.includes(message.event)) return;
    toPage({ event: message.event, data: message.data ?? null });
  }

  /**
   * Installs the window 'message' listener and the tab-message listener.
   * @returns {void}
   */
  function start() {
    window.addEventListener('message', (event) => {
      const request = readPageRequest(event);
      if (request !== null) forward(request);
    });
    chrome.runtime.onMessage.addListener(deliverTabEvent);
  }

  start();
})();
