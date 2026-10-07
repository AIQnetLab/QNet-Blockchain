// A small in-memory chrome.* for node:test: events, runtime, storage areas, ports and the sender shapes
// Chrome reports. Messages cross it as JSON, as they do in Chrome, so bytes or undefined in a message
// show up in tests the way they would in the browser.

// Extension ids are 32 letters a-p.
export const EXTENSION_ID = 'lmnopabcdefghijklmnopabcdefghijk';
export const OTHER_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

const jsonClone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** chrome.events.Event with a test-side dispatch(). */
export function createEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => {
      listeners.add(fn);
    },
    removeListener: (fn) => {
      listeners.delete(fn);
    },
    hasListener: (fn) => listeners.has(fn),
    hasListeners: () => listeners.size > 0,
    listenerCount: () => listeners.size,
    dispatch: (...args) => [...listeners].map((fn) => fn(...args)),
  };
}

/** chrome.storage.StorageArea over a Map; dump() returns a copy of everything stored. */
export function createStorageArea() {
  const data = new Map();
  let accessLevel = null;
  const pick = (keys) => {
    if (keys === null || keys === undefined) return Object.fromEntries([...data].map(([k, v]) => [k, jsonClone(v)]));
    const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const name of names) {
      if (data.has(name)) out[name] = jsonClone(data.get(name));
      else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[name] = keys[name];
    }
    return out;
  };
  return {
    get: async (keys) => pick(keys),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, jsonClone(v));
    },
    remove: async (keys) => {
      for (const k of typeof keys === 'string' ? [keys] : keys) data.delete(k);
    },
    clear: async () => {
      data.clear();
    },
    setAccessLevel: async (options) => {
      accessLevel = options?.accessLevel ?? null;
    },
    accessLevel: () => accessLevel,
    dump: () => pick(null),
  };
}

/**
 * chrome.runtime of this extension. sendMessage records what the worker broadcasts (runtime.sent).
 * @param {{id?: string, manifest?: object}} [options]
 */
export function createRuntime({ id = EXTENSION_ID, manifest = {} } = {}) {
  const base = `chrome-extension://${id}`;
  const sent = [];
  return {
    id,
    sent,
    getURL: (path = '') => `${base}/${String(path).replace(/^\/+/, '')}`,
    getManifest: () => jsonClone(manifest),
    sendMessage: async (message) => {
      sent.push(jsonClone(message));
    },
    onMessage: createEvent(),
    onConnect: createEvent(),
    onStartup: createEvent(),
    onInstalled: createEvent(),
  };
}

/** The chrome global the worker modules use. */
export function createChrome({ id = EXTENSION_ID, manifest = {} } = {}) {
  return {
    runtime: createRuntime({ id, manifest }),
    storage: { local: createStorageArea(), session: createStorageArea() },
    alarms: {
      onAlarm: createEvent(),
      create: async () => {},
      clear: async () => true,
      get: async () => undefined,
    },
    idle: { onStateChanged: createEvent(), setDetectionInterval: () => {} },
    windows: {
      onRemoved: createEvent(),
      create: async () => ({ id: 101 }),
      update: async () => ({ id: 101 }),
      remove: async () => {},
    },
    tabs: { create: async () => ({ id: 201 }) },
  };
}

/**
 * A runtime.Port as the worker sees it. Test side: send() delivers a message to the worker's listeners,
 * close() fires onDisconnect, posted holds what the worker posted.
 * @param {{name?: string, sender: object}} options
 */
export function createPort({ name = 'qnet-provider', sender }) {
  const port = {
    name,
    sender,
    posted: [],
    disconnected: false,
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    postMessage(message) {
      if (port.disconnected) throw new Error('Attempting to use a disconnected port object');
      port.posted.push(jsonClone(message));
    },
    disconnect() {
      port.disconnected = true;
    },
    send(message) {
      port.onMessage.dispatch(jsonClone(message), port);
    },
    close() {
      port.disconnected = true;
      port.onDisconnect.dispatch(port);
    },
  };
  return port;
}

/**
 * Sender of an extension page. popup: no tab (action popup). setup and approve: a tab showing the page.
 * @param {ReturnType<typeof createRuntime>} runtime
 * @param {'popup'|'setup'|'approve'|string} page a page name or any path under the extension
 * @param {{query?: string, tab?: boolean, frameId?: number}} [options]
 */
export function pageSender(runtime, page, { query = '', tab, frameId } = {}) {
  const path = ['popup', 'setup', 'approve'].includes(page) ? `ui/${page}.html` : page;
  const url = `${runtime.getURL(path)}${query}`;
  const origin = `chrome-extension://${runtime.id}`;
  const inTab = tab ?? page !== 'popup';
  const sender = { id: runtime.id, url, origin };
  if (inTab) {
    sender.tab = { id: 7, windowId: 3, url };
    sender.frameId = frameId ?? 0;
  }
  return sender;
}

/**
 * Sender of this extension's content script in a web page (what the relay's port and a compromised
 * renderer's runtime.sendMessage both carry).
 * @param {string} url the page URL
 * @param {{id?: string, frameId?: number, tabId?: number, origin?: string}} [options]
 */
export function contentScriptSender(url, { id = EXTENSION_ID, frameId = 0, tabId = 11, origin } = {}) {
  return {
    id,
    url,
    origin: origin ?? new URL(url).origin,
    frameId,
    tab: { id: tabId, windowId: 5, url },
    documentId: 'D0C',
    documentLifecycle: 'active',
  };
}

/** Resolves once `predicate()` is true (checked after every macrotask); rejects after timeoutMs. */
export async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
