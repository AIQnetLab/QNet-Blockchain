/**
 * The in-app browser's message bridge (spec: mobile-browser "Origin integrity", audit R22).
 *
 * A request's origin is the one the WebView reported for its sender (the patched react-native-webview adds
 * `frameOrigin` and `isMainFrame` to every message event; patches/react-native-webview+14.0.1.patch). The
 * message body can say anything; nothing in it names an origin. A message without those native fields — an
 * unpatched library, a subframe — is dropped.
 *
 * Each request is bound to (origin, document, navigation). An answer goes back only while the page is the one
 * that asked: the app checks its own navigation count, and the injected script checks location.origin before
 * the page sees anything, and the page's provider checks its document id.
 */
import { canonicalOrigin } from './url';
import { BRIDGE_TARGET, PAGE_TARGET, MAX_REQUEST_CHARS, PROVIDER_EVENTS } from './providerScript';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const METHOD_RE = /^[A-Za-z0-9_]{1,64}$/;
const ENVELOPE_KEYS = ['target', 'doc', 'id', 'method', 'params'];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * Reads one WebView message event. { ok: true, origin, doc, id, method, params } for a request from the top
 * frame of an origin the wallet talks to, else { ok: false, reason, reply? } where `reply` ({origin, doc, id})
 * is set when the page can still be told the request was invalid (-32602).
 */
export function readBridgeMessage(nativeEvent, { dev = false } = {}) {
  if (!nativeEvent || typeof nativeEvent !== 'object') return { ok: false, reason: 'event' };
  if (nativeEvent.isMainFrame !== true) return { ok: false, reason: 'subframe' };
  const origin = canonicalOrigin(nativeEvent.frameOrigin, { dev });
  if (!origin) return { ok: false, reason: 'origin' };
  const raw = nativeEvent.data;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_REQUEST_CHARS) return { ok: false, reason: 'size' };
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    return { ok: false, reason: 'json' };
  }
  if (!isPlainObject(msg) || msg.target !== BRIDGE_TARGET) return { ok: false, reason: 'target' };
  if (typeof msg.doc !== 'string' || !DOC_RE.test(msg.doc)) return { ok: false, reason: 'doc' };
  if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) return { ok: false, reason: 'id' };
  const reply = { origin, doc: msg.doc, id: msg.id };
  if (Object.keys(msg).some((k) => !ENVELOPE_KEYS.includes(k))) return { ok: false, reason: 'keys', reply };
  if (typeof msg.method !== 'string' || !METHOD_RE.test(msg.method)) return { ok: false, reason: 'method', reply };
  return { ok: true, origin, doc: msg.doc, id: msg.id, method: msg.method, params: msg.params };
}

// Text safe to place in a script: JSON, with the line separators and "<" escaped.
function scriptLiteral(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003c');
}

function deliveryScript(origin, data) {
  const o = scriptLiteral(origin);
  return `(function(){try{if(window.top!==window||window.location.origin!==${o})return;`
    + `window.dispatchEvent(new MessageEvent('message',{data:${scriptLiteral(data)},origin:${o},source:window}));`
    + '}catch(e){}})();true;';
}

/** The script that hands an answer to the page that asked (and to no other). */
export function responseScript(binding, answer) {
  const data = { target: PAGE_TARGET, doc: binding.doc, id: binding.id, ...answer };
  return deliveryScript(binding.origin, data);
}

/** The script that delivers an event (accountsChanged, disconnect) to pages of `origin`. */
export function eventScript(origin, event, payload) {
  if (!PROVIDER_EVENTS.includes(event)) throw new Error('Unknown provider event');
  return deliveryScript(origin, { target: PAGE_TARGET, event, data: payload === undefined ? null : payload });
}

/**
 * The script that pauses the audio and video of a page whose tab went behind (or under the start page, or with the whole
 * browser hidden): every audio and video element of its document, of its open shadow roots and of the frames of its own
 * origin. It carries nothing of the wallet. It is a pause, not a lock: a page may start its media again, and sound made
 * another way (Web Audio) or in a frame of another site goes on; the page is not told it is hidden.
 */
export const PAUSE_MEDIA_SCRIPT = '(function(){'
  + 'function pause(root){try{var m=root.querySelectorAll(\'audio,video\');for(var i=0;i<m.length;i++){try{m[i].pause();}catch(e){}}'
  + 'var all=root.querySelectorAll(\'*\');for(var j=0;j<all.length;j++){if(all[j].shadowRoot)pause(all[j].shadowRoot);}}catch(e){}}'
  + 'try{pause(document);for(var k=0;k<window.frames.length;k++){try{pause(window.frames[k].document);}catch(e){}}}catch(e){}'
  + '})();true;';

/**
 * Which page a browser tab shows: its origin, its document (the provider's id, learned from its requests) and a
 * navigation count. Anything that may have replaced the page — a navigation event to another origin, a request
 * from another document, a user navigation — bumps the count; answers bound to an older count are dropped. A binding
 * names the tab too (`tab`), so it is never current in another tab's session.
 */
export class PageSession {
  constructor(tab = null) {
    this.tab = tab;
    this.origin = null;
    this.doc = null;
    this.nav = 0;
  }

  /** A top-level navigation to `origin` (null: not a page the wallet talks to). True when the page changed. */
  navigated(origin) {
    if (origin === this.origin) return false;
    this.origin = origin;
    this.doc = null;
    this.nav += 1;
    return true;
  }

  /** The user navigated (address bar, back, forward, reload, home) or the view was reset. */
  reset() {
    this.origin = null;
    this.doc = null;
    this.nav += 1;
  }

  /**
   * A new document committed in the top frame (iOS didCommitNavigation), same origin or not: the page that asked before
   * is gone. The origin follows from the navigation-state event; the document from the new page's first message.
   */
  newDocument() {
    this.doc = null;
    this.nav += 1;
  }

  /** A request from (origin, doc) arrived. True when that means another page than before. */
  sawRequest(origin, doc) {
    if (origin === this.origin && doc === this.doc) return false;
    const changed = this.origin !== null && (origin !== this.origin || this.doc !== null);
    this.origin = origin;
    this.doc = doc;
    if (changed) this.nav += 1;
    return changed;
  }

  bind(request) {
    return Object.freeze({ origin: request.origin, doc: request.doc, id: request.id, nav: this.nav, tab: this.tab });
  }

  isCurrent(binding) {
    return !!binding && binding.tab === this.tab && binding.nav === this.nav && binding.origin === this.origin
      && binding.doc === this.doc;
  }
}
