// The clipboard clear after a page copied a secret (background/clipboard.js, ui/offscreen.js; CONTRACTS.md section 8):
// the worker keeps the due time, empties the clipboard on its own alarm through the offscreen document whether or not
// the page is still open, a later copy drops the clear, and a worker that restarted still clears. The offscreen page
// answers only the worker and writes an empty text with the copy command.
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLIPBOARD_ALARM, OFFSCREEN, STORAGE_KEYS, TIMINGS } from '../dist/background/config.js';
import { EXTENSION_ID, createChrome, createEvent } from './helpers/chrome-mock.mjs';

let chrome;
let alarms;
let offscreen;
let loads = 0;

// The worker's chrome with the alarms and the offscreen document recorded; `answer` is what the document replies.
function workerChrome({ answer = { cleared: true }, exists = false } = {}) {
  const api = createChrome();
  alarms = new Map();
  api.alarms.create = async (name, info) => {
    alarms.set(name, info.when);
  };
  api.alarms.clear = async (name) => alarms.delete(name);
  offscreen = { created: [], closed: 0, open: exists, asked: [] };
  api.offscreen = {
    createDocument: async (options) => {
      if (offscreen.open) throw new Error('Only a single offscreen document may be created.');
      offscreen.open = true;
      offscreen.created.push(options);
    },
    closeDocument: async () => {
      offscreen.open = false;
      offscreen.closed += 1;
    },
  };
  api.runtime.sendMessage = async (message) => {
    offscreen.asked.push(message);
    return offscreen.open ? (typeof answer === 'function' ? answer(message) : answer) : undefined;
  };
  return api;
}

// A fresh copy of the module: a worker that (re)started.
async function freshWorker() {
  loads += 1;
  return import(`../dist/background/clipboard.js?worker=${loads}`);
}

const due = () => chrome.storage.session.dump()[STORAGE_KEYS.CLIPBOARD] ?? null;

beforeEach(() => {
  chrome = workerChrome();
  globalThis.chrome = chrome;
});

describe('clipboard: the worker clears a copied secret', () => {
  it('keeps the due time and its alarm, and empties the clipboard through the offscreen document when it fires', async () => {
    const clipboard = await freshWorker();
    const before = Date.now();
    assert.deepEqual(await clipboard.schedule({ afterMs: TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS }), { scheduled: true });
    const { until } = due();
    assert.ok(until >= before + TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS && until <= Date.now() + TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS);
    assert.equal(alarms.get(CLIPBOARD_ALARM), until);
    assert.deepEqual(offscreen.created, [], 'nothing is written before the time is up');

    // an alarm the browser fires early is armed again for the due time
    await clipboard.onAlarm({ name: CLIPBOARD_ALARM });
    assert.deepEqual(offscreen.created, []);
    assert.equal(alarms.get(CLIPBOARD_ALARM), until);
    // another alarm is none of its business
    await clipboard.onAlarm({ name: 'qnet-auto-lock' });
    assert.deepEqual(offscreen.created, []);

    const realNow = Date.now;
    Date.now = () => until;
    try {
      await clipboard.onAlarm({ name: CLIPBOARD_ALARM });
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(offscreen.created, [{ url: OFFSCREEN.PAGE, reasons: ['CLIPBOARD'], justification: offscreen.created[0].justification }]);
    assert.match(offscreen.created[0].justification, /clipboard/);
    assert.deepEqual(offscreen.asked, [{ target: OFFSCREEN.TARGET, type: 'clear' }]);
    assert.equal(offscreen.closed, 1, 'the document is closed again');
    assert.equal(due(), null);
    assert.equal(alarms.has(CLIPBOARD_ALARM), false);
    // done once: the next alarm finds nothing pending
    await clipboard.onAlarm({ name: CLIPBOARD_ALARM });
    assert.equal(offscreen.created.length, 1);
  });

  it('a later copy that needs no clear drops the pending one; a new secret replaces it', async () => {
    const clipboard = await freshWorker();
    await clipboard.schedule({ afterMs: TIMINGS.CLIPBOARD_CLEAR_MS });
    assert.deepEqual(await clipboard.schedule({ afterMs: 0 }), { scheduled: false });
    assert.equal(due(), null);
    assert.equal(alarms.has(CLIPBOARD_ALARM), false);
    assert.deepEqual(await clipboard.clearNow(), { cleared: false }, 'nothing pending: the clipboard is left alone');
    assert.deepEqual(offscreen.created, []);
    await clipboard.schedule({ afterMs: TIMINGS.CLIPBOARD_CLEAR_MS });
    const first = due().until;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await clipboard.schedule({ afterMs: TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS });
    assert.ok(due().until > first);
    assert.equal(alarms.get(CLIPBOARD_ALARM), due().until);
    await assert.rejects(clipboard.schedule({ afterMs: -1 }));
  });

  it('clearNow empties a pending clear at once, in a worker that restarted too', async () => {
    await (await freshWorker()).schedule({ afterMs: TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS });
    // the worker stopped: its memory is gone, chrome.storage.session holds the due time
    const restarted = await freshWorker();
    assert.deepEqual(await restarted.clearNow(), { cleared: true });
    assert.equal(offscreen.created.length, 1);
    assert.equal(due(), null);

    // and its alarm still clears
    await (await freshWorker()).schedule({ afterMs: TIMINGS.CLIPBOARD_CLEAR_MS });
    const later = await freshWorker();
    const realNow = Date.now;
    Date.now = () => due().until;
    try {
      await later.onAlarm({ name: CLIPBOARD_ALARM });
    } finally {
      Date.now = realNow;
    }
    assert.equal(offscreen.created.length, 2);
    assert.equal(due(), null);
  });

  it('a document left open takes the request; a document that does not answer is reported, never thrown', async () => {
    chrome = workerChrome({ exists: true });
    globalThis.chrome = chrome;
    let clipboard = await freshWorker();
    await clipboard.schedule({ afterMs: TIMINGS.CLIPBOARD_CLEAR_MS });
    assert.deepEqual(await clipboard.clearNow(), { cleared: true });
    assert.deepEqual(offscreen.created, [], 'the open one was asked');
    assert.equal(offscreen.closed, 1);

    chrome = workerChrome({ answer: () => new Promise(() => {}) });
    globalThis.chrome = chrome;
    clipboard = await freshWorker();
    await clipboard.schedule({ afterMs: TIMINGS.CLIPBOARD_CLEAR_MS });
    const started = Date.now();
    assert.deepEqual(await clipboard.clearNow(), { cleared: false });
    assert.ok(Date.now() - started < 10000);
    assert.equal(offscreen.closed, 1, 'closed whatever it answered');
    assert.equal(due(), null, 'a failed write is not retried for ever');

    chrome = workerChrome();
    delete chrome.offscreen;
    globalThis.chrome = chrome;
    clipboard = await freshWorker();
    await clipboard.schedule({ afterMs: TIMINGS.CLIPBOARD_CLEAR_MS });
    assert.deepEqual(await clipboard.clearNow(), { cleared: false });
  });
});

// ui/offscreen.js on a minimal document: the copy command fires the copy event, as the browser does.
function offscreenPage({ execResult = true, eventNeedsSelection = false } = {}) {
  const listeners = new Map();
  const ranges = [];
  const page = { written: [], commands: 0 };
  const doc = {
    body: { append: () => {} },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    createElement: () => ({ textContent: '', remove: () => {} }),
    createRange: () => ({ selectNodeContents: () => {} }),
    getSelection: () => ({ removeAllRanges: () => ranges.splice(0), addRange: (range) => ranges.push(range) }),
    execCommand: (command) => {
      page.commands += 1;
      if (command !== 'copy') return false;
      if (eventNeedsSelection && ranges.length === 0) return false;
      const event = {
        clipboardData: { setData: (kind, text) => page.written.push([kind, text]) },
        preventDefault: () => {},
      };
      listeners.get('copy')?.(event);
      return execResult;
    },
  };
  const onMessage = createEvent();
  const base = `chrome-extension://${EXTENSION_ID}`;
  page.chrome = { runtime: { id: EXTENSION_ID, getURL: (path) => `${base}/${path}`, onMessage } };
  page.document = doc;
  page.worker = { id: EXTENSION_ID, url: `${base}/background/sw.js` };
  page.ask = (message, sender = page.worker) => {
    let answer;
    onMessage.dispatch(message, sender, (reply) => {
      answer = reply;
    });
    return answer;
  };
  return page;
}

async function loadOffscreen(page) {
  const saved = { chrome: globalThis.chrome, document: globalThis.document };
  globalThis.chrome = page.chrome;
  globalThis.document = page.document;
  loads += 1;
  await import(`../dist/ui/offscreen.js?page=${loads}`);
  return () => {
    globalThis.chrome = saved.chrome;
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
  };
}

describe('clipboard: the offscreen page', () => {
  it('writes an empty text with the copy command for the worker, and answers nobody else', async () => {
    const page = offscreenPage();
    const restore = await loadOffscreen(page);
    try {
      const clear = { target: OFFSCREEN.TARGET, type: 'clear' };
      assert.equal(page.ask(clear, { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/ui/popup.html` }), undefined);
      assert.equal(page.ask(clear, { ...page.worker, id: 'another extension' }), undefined);
      assert.equal(page.ask(clear, { ...page.worker, tab: { id: 3 } }), undefined);
      assert.equal(page.ask({ target: 'qnet-event', type: 'clear' }), undefined);
      assert.equal(page.ask({ target: OFFSCREEN.TARGET, type: 'read' }), undefined);
      assert.equal(page.commands, 0);
      assert.deepEqual(page.ask(clear), { cleared: true });
      assert.deepEqual(page.written, [['text/plain', '']]);
    } finally {
      restore();
    }
  });

  it('selects a node of its own when the command needs a selection, and says when it could not write', async () => {
    const picky = offscreenPage({ eventNeedsSelection: true });
    let restore = await loadOffscreen(picky);
    try {
      assert.deepEqual(picky.ask({ target: OFFSCREEN.TARGET, type: 'clear' }), { cleared: true });
      assert.equal(picky.commands, 2);
      assert.deepEqual(picky.written, [['text/plain', '']]);
    } finally {
      restore();
    }
    const refused = offscreenPage({ execResult: false });
    restore = await loadOffscreen(refused);
    try {
      assert.deepEqual(refused.ask({ target: OFFSCREEN.TARGET, type: 'clear' }), { cleared: false });
    } finally {
      restore();
    }
  });
});
