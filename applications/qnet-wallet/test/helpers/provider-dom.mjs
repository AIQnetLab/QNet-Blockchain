// Just enough DOM to run ui/approve.js in node: elements that ui/common.js el() builds, events with
// isTrusted and AbortSignal removal, focus, and a window that records close(); and the loader that runs a fresh
// ui/approve.js in such a page. No HTML is ever parsed.
import { createEvent } from './chrome-mock.mjs';

class EventTargetStub {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    if (options?.signal?.aborted) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    options?.signal?.addEventListener('abort', () => this.listeners.get(type)?.delete(listener));
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  /** Fires `type` with an event that is trusted unless init says otherwise. */
  fire(type, init = {}) {
    const event = { type, isTrusted: true, target: this, key: undefined, ...init };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
}

class TextStub {
  constructor(text) {
    this.textContent = String(text);
  }
}

export class ElementStub extends EventTargetStub {
  constructor(document, tag) {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.className = '';
    this.value = '';
    this.disabled = false;
    this.ownText = '';
  }

  get textContent() {
    return this.ownText + this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.ownText = String(value);
    this.childNodes = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  // As in a browser, anything that is not a node becomes text (a stray null shows as "null").
  append(...nodes) {
    for (const node of nodes) this.childNodes.push(node instanceof ElementStub ? node : new TextStub(node));
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.ownText = '';
    this.append(...nodes);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  /**
   * A user click with the mouse: the press (pointerdown), then the click; disabled buttons get no click,
   * as in a browser. Enter or Space on a focused button makes click({detail: 0, pointerType: ''}), with no
   * press. `press: false` sends the click alone (a press that began elsewhere or earlier).
   */
  click(init = {}) {
    const { press = init.detail === undefined || init.detail >= 1, ...event } = init;
    if (press) this.fire('pointerdown', { pointerType: 'mouse', button: 0 });
    if (!this.disabled) this.fire('click', { detail: 1, pointerType: 'mouse', ...event });
  }

  * descendants() {
    for (const child of this.childNodes) {
      if (child instanceof ElementStub) {
        yield child;
        yield* child.descendants();
      }
    }
  }

  querySelectorAll(selector) {
    const tags = selector.split(',').map((part) => part.trim().toUpperCase());
    return [...this.descendants()].filter((element) => tags.includes(element.tagName));
  }

  /** Test helper: descendants carrying a class. */
  byClass(name) {
    return [...this.descendants()].filter((element) => element.className.split(/\s+/).includes(name));
  }

  /** Test helper: the buttons by their text. */
  button(text) {
    return this.querySelectorAll('button').find((element) => element.textContent === text) ?? null;
  }
}

/**
 * A document with <main id="app"> and a window at ui/approve.html?id=<id>; chrome.runtime.sendMessage is
 * `send` (the router, as seen from the approve window).
 */
export function createPage({ query, runtime, send }) {
  const document = new EventTargetStub();
  document.activeElement = null;
  document.focused = true;
  document.hidden = false;
  document.createElement = (tag) => new ElementStub(document, tag);
  document.head = new ElementStub(document, 'head');
  document.body = new ElementStub(document, 'body');
  const app = new ElementStub(document, 'main');
  app.setAttribute('id', 'app');
  document.body.append(app);
  document.getElementById = (id) => (id === 'app' ? app : null);
  document.hasFocus = () => document.focused;

  const window = new EventTargetStub();
  window.top = window;
  window.location = { search: query };
  window.closed = false;
  window.close = () => {
    window.closed = true;
  };

  const chrome = {
    runtime: {
      id: runtime.id,
      getURL: runtime.getURL,
      sendMessage: async (message) => send(JSON.parse(JSON.stringify(message))),
      onMessage: createEvent(),
    },
  };
  return { document, window, chrome, app };
}

let pageSeq = 0;

/** Installs `page` as the global window, document and chrome, then runs a fresh copy of ui/approve.js in it. */
export async function loadApprovePage(page) {
  Object.assign(globalThis, { window: page.window, document: page.document, chrome: page.chrome });
  pageSeq += 1;
  await import(`../../dist/ui/approve.js?page=${pageSeq}`);
  return page;
}

/** The approve window of the approval `shown` (provider-harness world.shown()), talking to the world's router. */
export function openApprovePage(world, shown) {
  return loadApprovePage(createPage({
    query: `?id=${shown.id}`,
    runtime: world.chrome.runtime,
    send: (message) => world.router.handleUiMessage(message, shown.sender),
  }));
}

/** For afterEach: removes the globals loadApprovePage installed. */
export function resetPageGlobals() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.chrome;
}

/** The texts of the page's elements that carry `className`, in document order. */
export const texts = (page, className) => page.app.byClass(className).map((element) => element.textContent);
