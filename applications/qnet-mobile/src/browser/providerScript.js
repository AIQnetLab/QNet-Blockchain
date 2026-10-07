/**
 * The page-side provider the in-app browser injects into the top frame of https pages: the same page API as
 * the QNet browser extension (applications/qnet-wallet/dist/inject/provider.js, CONTRACTS.md section 4.1),
 * announced with channel 'mobile' so a site knows it runs inside the app. It holds no authority: every
 * decision (grant, confirmation, signing) happens in the app, which takes the requesting origin from the
 * WebView, never from this script or the page.
 *
 * Page → app: window.ReactNativeWebView.postMessage(JSON {target: 'qnet-bridge', doc, id, method, params}).
 * App → page: a 'message' event on window {target: 'qnet-provider', doc, id, ok, result|error} or
 * {target: 'qnet-provider', event, data}, dispatched by a script the app injects only after checking
 * location.origin. `doc` is this document's random id: an answer for an earlier document is ignored.
 *
 * Kept as source text (Hermes does not keep function source), ES2015 only, for old WebView builds.
 */
import { UNSUPPORTED_PARAM } from './dappRequests';

export const BRIDGE_TARGET = 'qnet-bridge';
export const PAGE_TARGET = 'qnet-provider';
export const PROVIDER_CHANNEL = 'mobile';
export const PROVIDER_EVENTS = Object.freeze(['accountsChanged', 'disconnect']);
export const COOLDOWN_MESSAGE = 'Too many rejected requests from this site, try again later';
// The message a new document's provider sends the app once, at its start (never a provider method: the page gets no
// answer): a page that loads another document of the same origin (a reload, a link, a form) is a new page to the app
// at once, and a sheet the old document left counts as left (browser/bridge PageSession).
export const PAGE_OPENED_METHOD = 'qnet__pageOpened';
// The one other text a -32602 may carry: the request named a parameter the network does not accept today.
export const UNSUPPORTED_PARAM_MESSAGE = 'Unsupported parameter';
export const MAX_REQUEST_CHARS = 16384;

// The extension's announcement icon (the announcement carries it as a data URI).
const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMwMGQ0ZmYiLz48L3N2Zz4=';

const SOURCE = `(function () {
  'use strict';
  var DEV = __QNET_DEV__;
  if (window.top !== window) return;
  var loc = window.location;
  var secure = loc.protocol === 'https:'
    || (DEV && loc.protocol === 'http:' && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1'));
  if (!secure) return;
  try {
    if (Object.prototype.hasOwnProperty.call(window, '__qnetMobileProvider')) return;
    Object.defineProperty(window, '__qnetMobileProvider', { value: true, writable: false, configurable: false });
  } catch (e) {
    return;
  }

  var TO_BRIDGE = '${BRIDGE_TARGET}';
  var TO_PAGE = '${PAGE_TARGET}';
  var ANNOUNCE_EVENT = 'qnet:announceProvider';
  var REQUEST_EVENT = 'qnet:requestProvider';
  var EVENTS = ['accountsChanged', 'disconnect'];
  var NAME = 'QNet Wallet';
  var RDNS = 'io.aiqnet.wallet';
  var CHANNEL = '${PROVIDER_CHANNEL}';
  var ICON = '${ICON}';
  var MAX_MESSAGE_CHARS = ${MAX_REQUEST_CHARS};
  var ERROR_MESSAGES = {
    '4001': 'User rejected the request',
    '4100': 'Unauthorized',
    '4200': 'Unsupported method',
    '4900': 'Disconnected',
    '-32602': 'Invalid params',
    '-32603': 'Internal error'
  };
  var COOLDOWN_MESSAGE = '${COOLDOWN_MESSAGE}';
  var UNSUPPORTED_PARAM = '${UNSUPPORTED_PARAM}';
  var UNSUPPORTED_PARAM_MESSAGE = '${UNSUPPORTED_PARAM_MESSAGE}';

  // Taken before later page scripts run (on iOS this runs at document start).
  var origin = loc.origin;
  var listenOnWindow = window.addEventListener.bind(window);
  var dispatchOnWindow = window.dispatchEvent.bind(window);
  var EventCtor = CustomEvent;
  var stringify = JSON.stringify;
  var reportError = typeof window.reportError === 'function' ? window.reportError.bind(window) : function () {};
  var randomBytes = crypto.getRandomValues.bind(crypto);
  var bridge = window.ReactNativeWebView;

  var listeners = { accountsChanged: [], disconnect: [] };
  var pending = {};
  var provider = null;
  var detail = null;

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }

  function uuid() {
    var b = randomBytes(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = '';
    for (var i = 0; i < 16; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  var docId = uuid();

  // The page sees this script's own texts; the only data it passes on is the UNSUPPORTED_PARAM reason of a -32602.
  function providerError(code, message, data) {
    var known = typeof code === 'number' && hasOwn(ERROR_MESSAGES, String(code)) ? code : -32603;
    var unsupported = known === -32602 && isPlainObject(data) && data.reason === UNSUPPORTED_PARAM;
    var text = known === 4001 && message === COOLDOWN_MESSAGE ? COOLDOWN_MESSAGE
      : unsupported ? UNSUPPORTED_PARAM_MESSAGE : ERROR_MESSAGES[String(known)];
    var error = new Error(text);
    error.code = known;
    if (unsupported) error.data = Object.freeze({ reason: UNSUPPORTED_PARAM });
    return error;
  }

  function postNative(text) {
    var b = bridge || window.ReactNativeWebView;
    if (!b || typeof b.postMessage !== 'function') return false;
    bridge = b;
    b.postMessage(text);
    return true;
  }

  function request(args) {
    return new Promise(function (resolve, reject) {
      var message;
      var text;
      try {
        if (!isPlainObject(args) || typeof args.method !== 'string' || args.method.length === 0) throw new TypeError();
        message = { target: TO_BRIDGE, doc: docId, id: uuid(), method: args.method };
        if (args.params !== undefined) message.params = args.params;
        text = stringify(message);
      } catch (e) {
        reject(providerError(-32602));
        return;
      }
      if (typeof text !== 'string' || text.length > MAX_MESSAGE_CHARS) {
        reject(providerError(-32602));
        return;
      }
      pending[message.id] = { resolve: resolve, reject: reject };
      var sent = false;
      try { sent = postNative(text); } catch (e) { sent = false; }
      if (!sent) {
        delete pending[message.id];
        reject(providerError(4900));
      }
    });
  }

  function checkSubscription(event, listener) {
    if (EVENTS.indexOf(event) < 0) throw new TypeError('Unsupported event');
    if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
  }

  function on(event, listener) {
    checkSubscription(event, listener);
    if (listeners[event].indexOf(listener) < 0) listeners[event].push(listener);
    return provider;
  }

  function removeListener(event, listener) {
    checkSubscription(event, listener);
    var i = listeners[event].indexOf(listener);
    if (i >= 0) listeners[event].splice(i, 1);
    return provider;
  }

  function emit(event, data) {
    var payload = isPlainObject(data) ? Object.freeze(Object.assign({}, data)) : data;
    var list = listeners[event].slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (error) { reportError(error); }
    }
  }

  function onAppMessage(event) {
    if (event.source !== window || event.origin !== origin) return;
    var data = event.data;
    if (!isPlainObject(data) || data.target !== TO_PAGE) return;
    if (hasOwn(data, 'event')) {
      if (EVENTS.indexOf(data.event) >= 0) emit(data.event, data.data === undefined ? null : data.data);
      return;
    }
    if (data.doc !== docId || typeof data.id !== 'string' || !hasOwn(pending, data.id)) return;
    var entry = pending[data.id];
    delete pending[data.id];
    if (data.ok === true) entry.resolve(data.result);
    else if (isPlainObject(data.error)) entry.reject(providerError(data.error.code, data.error.message, data.error.data));
    else entry.reject(providerError(undefined));
  }

  function announce() {
    dispatchOnWindow(new EventCtor(ANNOUNCE_EVENT, { detail: detail }));
  }

  Object.freeze(request);
  Object.freeze(on);
  Object.freeze(removeListener);
  provider = Object.freeze({ isQNet: true, request: request, on: on, removeListener: removeListener });
  detail = Object.freeze({
    info: Object.freeze({ uuid: uuid(), name: NAME, icon: ICON, rdns: RDNS, channel: CHANNEL }),
    provider: provider
  });
  try {
    Object.defineProperty(window, 'qnet', { value: provider, writable: false, configurable: false, enumerable: true });
  } catch (e) {
    // window.qnet is taken; sites find this provider through the announcement
  }
  listenOnWindow('message', onAppMessage);
  listenOnWindow(REQUEST_EVENT, announce);
  announce();
  // This document is a new page to the app from now on, whatever it asks later (or never).
  try { postNative(stringify({ target: TO_BRIDGE, doc: docId, id: uuid(), method: '${PAGE_OPENED_METHOD}' })); } catch (e) {}
})();
true;`;

/** The provider script; `dev` lets it run on plain-http loopback pages (development builds only). */
export function providerScript({ dev = false } = {}) {
  return SOURCE.replace('__QNET_DEV__', dev ? 'true' : 'false');
}
