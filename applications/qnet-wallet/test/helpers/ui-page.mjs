// Loads an extension page (ui/popup.js, ui/setup.js) on the fake DOM with a scripted worker. Every
// request the page sends is checked against the real router table (UI_MESSAGES: known type, page
// allowed to send it, exact params) before a test handler answers it; a mismatch is recorded in
// `violations`, so a page that drifts from CONTRACTS.md fails its tests.
import { readFile } from 'node:fs/promises';
import { ERROR_MESSAGES } from '../../dist/background/errors.js';
import { UI_MESSAGES, validateParams } from '../../dist/background/router.js';
import { VIEW_EVENT_CHANNEL } from '../../dist/background/config.js';
import { EXTENSION_ID, createEvent } from './chrome-mock.mjs';
import { FakeEvent, installDom } from './ui-dom.mjs';

/** Thrown by a test handler: the worker answers {ok: false, error: {code, message, ...extra}}. */
export class WorkerFail extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

/** Handler helper: `() => fail('BAD_PASSWORD')`. */
export function fail(code, extra = {}) {
  throw new WorkerFail(code, extra);
}

const DIST = new URL('../../dist/', import.meta.url);
const BASE = `chrome-extension://${EXTENSION_ID}`;
let loadSeq = 0;

/**
 * @param {'popup'|'setup'} page
 * @param {{handlers?: Record<string, (params: object) => unknown>, localStorage?: Record<string, string>}} [options]
 */
export async function openPage(page, { handlers = {}, localStorage = {} } = {}) {
  const dom = installDom({ localStorage });
  const calls = [];
  const violations = [];
  const tabsCreated = [];
  const tabsRemoved = [];
  const fetches = [];
  let inflight = 0;

  const error = (id, code, extra = {}) => ({ id, ok: false, error: { code, message: ERROR_MESSAGES[code] ?? code, ...extra } });

  async function answer(message) {
    await Promise.resolve();
    const { type, id, params } = message;
    const keys = Object.keys(message).sort().join(',');
    if (keys !== 'id,params,type') violations.push(`envelope keys ${keys}`);
    const entry = Object.hasOwn(UI_MESSAGES, type) ? UI_MESSAGES[type] : null;
    if (!entry) {
      violations.push(`unknown type ${type}`);
      return error(id, 'UNKNOWN_TYPE');
    }
    if (!entry.pages.includes(page)) violations.push(`${type} is not allowed from ${page}`);
    try {
      validateParams(entry.params, params, { check: entry.check });
    } catch (failure) {
      violations.push(`${type}: invalid params ${failure.field ?? ''} ${JSON.stringify(params)}`);
      return error(id, 'INVALID_PARAMS');
    }
    if (!Object.hasOwn(handlers, type)) {
      violations.push(`no test handler for ${type}`);
      return error(id, 'INTERNAL');
    }
    try {
      const result = await handlers[type](params);
      return { id, ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
    } catch (failure) {
      if (failure instanceof WorkerFail) return error(id, failure.code, failure.extra);
      throw failure;
    }
  }

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path = '') => `${BASE}/${String(path).replace(/^\/+/, '')}`,
      onMessage: createEvent(),
      sendMessage(message) {
        // Chrome serializes the message when sendMessage is called.
        const copy = JSON.parse(JSON.stringify(message));
        calls.push({ type: copy.type, params: copy.params });
        inflight += 1;
        return answer(copy).finally(() => {
          inflight -= 1;
        });
      },
    },
    tabs: {
      create: async (props) => {
        tabsCreated.push(props);
        return { id: 301 };
      },
      getCurrent: async () => ({ id: 77 }),
      remove: async (tabId) => {
        tabsRemoved.push(tabId);
      },
    },
  };

  const savedChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const savedFetch = globalThis.fetch;
  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    const text = String(url);
    fetches.push(text);
    if (!text.startsWith(`${BASE}/`)) throw new Error(`network access from a page test: ${text}`);
    inflight += 1;
    try {
      const body = await readFile(new URL(text.slice(BASE.length + 1), DIST), 'utf8');
      return { ok: true, json: async () => JSON.parse(body) };
    } catch {
      return { ok: false, json: async () => null };
    } finally {
      inflight -= 1;
    }
  };

  const handle = {
    ...dom,
    chrome,
    calls,
    violations,
    tabsCreated,
    tabsRemoved,
    fetches,
    /** Waits until no request is in flight for a few event-loop turns. */
    async settle() {
      let quiet = 0;
      for (let turn = 0; turn < 500 && quiet < 4; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        quiet = inflight === 0 ? quiet + 1 : 0;
      }
    },
    callsOf(type) {
      return calls.filter((entry) => entry.type === type);
    },
    $(selector) {
      return dom.document.querySelector(selector);
    },
    $$(selector) {
      return dom.document.querySelectorAll(selector);
    },
    text() {
      return dom.app.textContent;
    },
    /** Clicks the first element matching selector (throws when absent) and settles. */
    async click(selector) {
      const node = dom.document.querySelector(selector);
      if (!node) throw new Error(`no element for ${selector}`);
      node.click();
      await handle.settle();
      return node;
    },
    /** A worker broadcast, or with `sender` a message from anyone else. */
    emit(event, sender = { id: EXTENSION_ID, url: `${BASE}/background/sw.js` }) {
      chrome.runtime.onMessage.dispatch({ channel: VIEW_EVENT_CHANNEL, event, data: null }, sender, () => {});
    },
    close() {
      dom.window.dispatchEvent(new FakeEvent('pagehide'));
      dom.uninstall();
      if (savedChrome) Object.defineProperty(globalThis, 'chrome', savedChrome);
      else delete globalThis.chrome;
      globalThis.fetch = savedFetch;
    },
  };

  loadSeq += 1;
  await import(new URL(`ui/${page}.js?load=${loadSeq}`, DIST).href);
  await handle.settle();
  return handle;
}
