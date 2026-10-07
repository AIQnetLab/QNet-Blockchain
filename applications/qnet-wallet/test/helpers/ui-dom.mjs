// A small DOM for the page tests, so no test needs a browser: elements and text nodes (append, replaceChildren,
// replaceWith, remove), attributes, classList, value/checked/disabled, events (no bubbling), simple selectors (tag, #id,
// .class, [attr], [attr="v"], descendant combinator, comma lists), a recording 2D canvas, and the window, document,
// navigator.clipboard, location and storage globals the pages touch. installDom() puts them on
// globalThis and returns a handle whose uninstall() puts the previous values back.

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.isTrusted = init.isTrusted ?? true;
    this.key = init.key;
    this.button = init.button;
    this.isComposing = false;
    this.defaultPrevented = false;
    this.target = null;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {}
}

class Target {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    if (event.target === null) event.target = this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener.call(this, event);
    return !event.defaultPrevented;
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeNode extends Target {
  constructor(document) {
    super();
    this.ownerDocument = document;
    this.parentNode = null;
    this.childNodes = [];
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument;
  }

  appendChild(node) {
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node);
  }

  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) child.remove();
    this.append(...nodes);
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const fresh = nodes.map((node) => (typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node));
    for (const node of fresh) if (node.parentNode) node.remove();
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1, ...fresh);
    for (const node of fresh) node.parentNode = parent;
    this.parentNode = null;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    for (const child of [...this.childNodes]) child.remove();
    const text = value === null || value === undefined ? '' : String(value);
    if (text !== '') this.appendChild(this.ownerDocument.createTextNode(text));
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  querySelectorAll(selector) {
    const groups = parseSelector(selector);
    return [...this.descendants()].filter((node) => groups.some((chain) => matchesChain(node, chain)));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeText extends FakeNode {
  constructor(document, data) {
    super(document);
    this.nodeType = 3;
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class ClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return this.element.className.split(/\s+/).filter(Boolean);
  }

  contains(name) {
    return this.values().includes(name);
  }

  add(...names) {
    const set = new Set(this.values());
    for (const name of names) set.add(name);
    this.element.className = [...set].join(' ');
  }

  remove(...names) {
    this.element.className = this.values().filter((name) => !names.includes(name)).join(' ');
  }

  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

class FakeContext2D {
  constructor() {
    this.fillStyle = '#000000';
    this.rects = [];
  }

  fillRect(x, y, w, h) {
    this.rects.push({ x, y, w, h, style: this.fillStyle });
  }
}

export class FakeElement extends FakeNode {
  constructor(document, tag) {
    super(document);
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.classList = new ClassList(this);
    this.scrollTop = 0;
    this.valueState = '';
    this.checkedState = false;
    this.width = 300;
    this.height = 150;
    this.context = null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(value) {
    if (value) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  get value() {
    return this.valueState;
  }

  set value(value) {
    this.valueState = value === null || value === undefined ? '' : String(value);
  }

  get checked() {
    return this.checkedState;
  }

  set checked(value) {
    this.checkedState = Boolean(value);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    this.dispatchEvent(new FakeEvent('blur'));
  }

  click() {
    if (this.disabled) return;
    if (this.localName === 'input' && this.getAttribute('type') === 'checkbox') {
      this.checked = !this.checked;
      this.dispatchEvent(new FakeEvent('click'));
      this.dispatchEvent(new FakeEvent('change'));
      return;
    }
    this.dispatchEvent(new FakeEvent('click'));
  }

  getContext(type) {
    if (this.localName !== 'canvas' || type !== '2d') return null;
    this.context ??= new FakeContext2D();
    return this.context;
  }
}

export class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.visibilityState = 'visible';
    this.focused = true;
    this.activeElement = null;
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.append(this.head, this.body);
    this.appendChild(this.documentElement);
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  createTextNode(text) {
    return new FakeText(this, text);
  }

  getElementById(id) {
    return [...this.descendants()].find((node) => node.id === id) ?? null;
  }

  hasFocus() {
    return this.focused;
  }
}

// ---------------------------------------------------------------- selectors

const COMPOUND_RE = /([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]"']*)))?\]/y;

function parseCompound(text) {
  const compound = { tag: null, id: null, classes: [], attrs: [] };
  COMPOUND_RE.lastIndex = 0;
  while (COMPOUND_RE.lastIndex < text.length) {
    const start = COMPOUND_RE.lastIndex;
    const match = COMPOUND_RE.exec(text);
    if (!match || COMPOUND_RE.lastIndex === start) throw new Error(`unsupported selector: ${text}`);
    const [, tag, id, cls, attr, v1, v2, v3] = match;
    if (tag) compound.tag = tag.toLowerCase();
    else if (id) compound.id = id;
    else if (cls) compound.classes.push(cls);
    else compound.attrs.push({ name: attr.toLowerCase(), value: v1 ?? v2 ?? v3 ?? null });
  }
  return compound;
}

function parseSelector(selector) {
  return selector.split(',').map((group) => group.trim().split(/\s+/).map(parseCompound));
}

function matchesCompound(node, compound) {
  if (compound.tag && node.localName !== compound.tag) return false;
  if (compound.id && node.id !== compound.id) return false;
  if (!compound.classes.every((name) => node.classList.contains(name))) return false;
  return compound.attrs.every(({ name, value }) => node.hasAttribute(name) && (value === null || node.getAttribute(name) === value));
}

function matchesChain(node, chain) {
  if (!matchesCompound(node, chain[chain.length - 1])) return false;
  let index = chain.length - 2;
  let ancestor = node.parentNode;
  while (index >= 0 && ancestor && ancestor.nodeType === 1) {
    if (matchesCompound(ancestor, chain[index])) index -= 1;
    ancestor = ancestor.parentNode;
  }
  return index < 0;
}

// ---------------------------------------------------------------- globals

export class FakeStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get length() {
    return this.map.size;
  }

  keys() {
    return [...this.map.keys()];
  }
}

export function createClipboard() {
  return {
    text: '',
    writes: [],
    async writeText(text) {
      this.text = String(text);
      this.writes.push(this.text);
    },
    async readText() {
      throw new Error('clipboardRead is not granted');
    },
  };
}

const GLOBALS = ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage'];

/**
 * Puts a fresh fake window/document on globalThis.
 * @param {{localStorage?: Record<string, string>}} [options]
 */
export function installDom({ localStorage = {} } = {}) {
  const saved = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const document = new FakeDocument();
  const app = document.createElement('main');
  app.setAttribute('id', 'app');
  document.body.append(app);
  const window = new Target();
  window.top = window;
  window.closed = false;
  window.close = () => {
    window.closed = true;
  };
  const location = {
    reloads: 0,
    search: '',
    reload() {
      this.reloads += 1;
    },
  };
  const clipboard = createClipboard();
  const values = {
    window,
    document,
    navigator: { clipboard, language: 'en-US' },
    location,
    localStorage: new FakeStorage(localStorage),
    sessionStorage: new FakeStorage(),
  };
  for (const name of GLOBALS) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true, enumerable: true });
  }
  return {
    ...values,
    clipboard,
    app,
    uninstall() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

// ---------------------------------------------------------------- interaction helpers

/** Sets an input's value and fires 'input', as typing does. */
export function type(input, text) {
  input.value = text;
  input.dispatchEvent(new FakeEvent('input'));
}

/** Dispatches an event of `type` on `node`. */
export function fire(node, eventType, init = {}) {
  return node.dispatchEvent(new FakeEvent(eventType, init));
}

/** Text of every element matching `selector` under `root`. */
export function texts(root, selector) {
  return root.querySelectorAll(selector).map((node) => node.textContent);
}
