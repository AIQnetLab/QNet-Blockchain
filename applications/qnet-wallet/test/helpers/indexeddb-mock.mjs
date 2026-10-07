// An in-memory IndexedDB for node:test with the parts of the W3C API the worker uses: versioned open with
// upgradeneeded / blocked / versionchange, object stores with out-of-line keys, get / put / add / delete /
// clear / count, transactions that are active only in the task that created them or inside a request
// callback, auto-commit, abort with rollback, deleteDatabase and databases(). Values are structured
// clones. Events go to on* handlers only. Faults can be injected per operation.
//
// Semantics kept on purpose because real browsers enforce them: a request made after an await on
// anything but IndexedDB throws TransactionInactiveError; a failed request aborts its transaction unless
// the handler calls preventDefault(); an aborted first upgrade leaves no database behind.

const task = (fn) => setImmediate(fn);
const domError = (name) => new DOMException(name, name);

function dispatch(target, type, extra = {}) {
  const event = {
    type,
    target,
    currentTarget: target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    ...extra,
  };
  const handler = target[`on${type}`];
  if (typeof handler === 'function') handler.call(target, event);
  return event;
}

function checkKey(key) {
  const ok = typeof key === 'string' || (typeof key === 'number' && !Number.isNaN(key));
  if (!ok) throw domError('DataError');
}

function cloneValue(value) {
  try {
    return structuredClone(value);
  } catch {
    throw domError('DataCloneError');
  }
}

class Request {
  constructor(transaction, source, op, run) {
    this.transaction = transaction;
    this.source = source;
    this.result = undefined;
    this.error = null;
    this.readyState = 'pending';
    this.onsuccess = null;
    this.onerror = null;
    this.op = op;
    this.run = run;
  }
}

class ObjectStore {
  constructor(transaction, name) {
    this.transaction = transaction;
    this.name = name;
  }

  request(op, run) {
    const tx = this.transaction;
    if (tx.finished || !tx.active) throw domError('TransactionInactiveError');
    const request = new Request(tx, this, op, run);
    tx.requests.push(request);
    tx.schedule();
    return request;
  }

  writable() {
    if (this.transaction.mode === 'readonly') throw domError('ReadOnlyError');
  }

  get(key) {
    checkKey(key);
    return this.request('get', (store) => (store.has(key) ? structuredClone(store.get(key)) : undefined));
  }

  count() {
    return this.request('count', (store) => store.size);
  }

  put(value, key) {
    this.writable();
    checkKey(key);
    const copy = cloneValue(value);
    return this.request('put', (store) => {
      store.set(key, copy);
      return key;
    });
  }

  add(value, key) {
    this.writable();
    checkKey(key);
    const copy = cloneValue(value);
    return this.request('add', (store) => {
      if (store.has(key)) throw domError('ConstraintError');
      store.set(key, copy);
      return key;
    });
  }

  delete(key) {
    this.writable();
    checkKey(key);
    return this.request('delete', (store) => {
      store.delete(key);
      return undefined;
    });
  }

  clear() {
    this.writable();
    return this.request('clear', (store) => {
      store.clear();
      return undefined;
    });
  }
}

class Transaction {
  constructor(connection, scope, mode) {
    this.db = connection;
    this.mode = mode;
    this.scope = scope;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.requests = [];
    this.active = true;
    this.finished = false;
    this.started = false;
    this.stepping = false;
    this.working = null;
    this.settled = new Promise((resolve) => {
      this.resolveSettled = resolve;
    });
    connection.transactions.add(this);
    if (mode !== 'versionchange') {
      connection.record.txQueue.push(this);
      task(() => {
        this.active = false;
        this.schedule();
      });
    }
  }

  get factory() {
    return this.db.factory;
  }

  objectStore(name) {
    if (this.finished) throw domError('InvalidStateError');
    if (!this.scope.includes(name)) throw domError('NotFoundError');
    return new ObjectStore(this, name);
  }

  abort() {
    if (this.finished) throw domError('InvalidStateError');
    this.fail(null);
  }

  storeFor(name) {
    if (this.mode === 'versionchange' || this.mode === 'readonly') return this.db.record.stores.get(name);
    return this.working.get(name);
  }

  canStart() {
    return this.mode === 'versionchange' || this.db.record.txQueue[0] === this;
  }

  schedule() {
    if (this.finished || this.stepping) return;
    if (!this.started) {
      if (!this.canStart()) return;
      this.started = true;
      if (this.mode === 'readwrite') {
        this.working = new Map(this.scope.map((name) => [name, new Map(this.db.record.stores.get(name))]));
      }
    }
    if (this.requests.length > 0) {
      this.stepping = true;
      task(() => {
        this.stepping = false;
        this.step();
      });
      return;
    }
    if (!this.active) this.commit();
  }

  step() {
    if (this.finished) return;
    const request = this.requests.shift();
    const fault = this.factory.takeFault(request.op);
    try {
      if (fault) throw domError(fault);
      request.result = request.run(this.storeFor(request.source.name));
    } catch (error) {
      request.error = error;
    }
    request.readyState = 'done';
    this.active = true;
    try {
      if (request.error) {
        const event = dispatch(request, 'error');
        dispatch(this, 'error', { target: request });
        if (!event.defaultPrevented) {
          this.active = false;
          this.fail(request.error);
          return;
        }
      } else {
        dispatch(request, 'success');
      }
    } catch (thrown) {
      this.factory.uncaught.push(thrown);
      this.active = false;
      this.fail(domError('AbortError'));
      return;
    }
    this.active = false;
    this.schedule();
  }

  commit() {
    const fault = this.mode === 'readwrite' ? this.factory.takeFault('commit') : null;
    if (fault) {
      this.fail(domError(fault));
      return;
    }
    if (this.mode === 'readwrite') {
      for (const [name, store] of this.working) this.db.record.stores.set(name, store);
    }
    this.finished = true;
    task(() => {
      dispatch(this, 'complete');
      this.done('complete');
    });
  }

  fail(error) {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    this.working = null;
    const pending = this.requests.splice(0);
    task(() => {
      for (const request of pending) {
        request.error = domError('AbortError');
        request.readyState = 'done';
        dispatch(request, 'error');
      }
      dispatch(this, 'abort');
      this.done('abort');
    });
  }

  done(outcome) {
    this.db.transactions.delete(this);
    const queue = this.db.record.txQueue;
    const index = queue.indexOf(this);
    if (index >= 0) queue.splice(index, 1);
    this.resolveSettled(outcome);
    this.db.maybeClosed();
    queue[0]?.schedule();
  }
}

class Connection {
  constructor(factory, record) {
    this.factory = factory;
    this.record = record;
    this.name = record.name;
    this.version = record.version;
    this.transactions = new Set();
    this.upgrade = null;
    this.closePending = false;
    this.closed = false;
    this.onversionchange = null;
    this.onclose = null;
    this.onerror = null;
    this.onabort = null;
    record.connections.add(this);
  }

  get objectStoreNames() {
    const names = [...this.record.stores.keys()].sort();
    return {
      length: names.length,
      contains: (name) => names.includes(name),
      item: (index) => names[index] ?? null,
      [Symbol.iterator]: () => names[Symbol.iterator](),
    };
  }

  createObjectStore(name) {
    const tx = this.upgrade;
    if (!tx || tx.finished) throw domError('InvalidStateError');
    if (!tx.active) throw domError('TransactionInactiveError');
    if (this.record.stores.has(name)) throw domError('ConstraintError');
    this.record.stores.set(name, new Map());
    tx.scope.push(name);
    return new ObjectStore(tx, name);
  }

  transaction(names, mode = 'readonly', options = undefined) {
    if (this.closePending) throw domError('InvalidStateError');
    if (this.upgrade && !this.upgrade.finished) throw domError('InvalidStateError');
    const scope = typeof names === 'string' ? [names] : Array.from(names);
    if (scope.length === 0) throw domError('InvalidAccessError');
    for (const name of scope) if (!this.record.stores.has(name)) throw domError('NotFoundError');
    if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError(`invalid mode ${mode}`);
    const durability = options?.durability ?? 'default';
    if (!['default', 'strict', 'relaxed'].includes(durability)) throw new TypeError(`invalid durability ${durability}`);
    // test extra: every transaction's database, mode and durability, in order
    this.factory.transactions.push({ name: this.record.name, mode, durability });
    return new Transaction(this, scope, mode);
  }

  close() {
    this.closePending = true;
    this.maybeClosed();
  }

  maybeClosed() {
    if (!this.closePending || this.closed || this.transactions.size > 0) return;
    this.closed = true;
    this.record.connections.delete(this);
    this.factory.wake(this.record);
  }
}

class OpenRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.readyState = 'pending';
    this.transaction = null;
    this.source = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.onblocked = null;
  }
}

/**
 * A fresh in-memory IDBFactory. Test extras: inject(op, errorName, {skip}) makes the next matching
 * operation (after `skip` of them) fail ('open', 'deleteDatabase', 'get', 'put', 'add', 'delete',
 * 'clear', 'count', or 'commit' for a readwrite transaction's commit); dump(name) returns {version,
 * stores} or null; seed(name, version, stores) writes a database directly; uncaught lists errors thrown
 * by handlers.
 * @returns {object}
 */
export function createIndexedDB() {
  const databases = new Map();
  const faults = new Map();
  const queues = new Map();

  const factory = {
    uncaught: [],
    transactions: [],

    takeFault(op) {
      const list = faults.get(op);
      if (!list || list.length === 0) return null;
      if (list[0].skip > 0) {
        list[0].skip -= 1;
        return null;
      }
      return list.shift().name;
    },

    wake(record) {
      if (record.connections.size > 0) return;
      for (const resolve of record.waiters.splice(0)) resolve();
    },

    inject(op, errorName, { skip = 0 } = {}) {
      if (!faults.has(op)) faults.set(op, []);
      faults.get(op).push({ name: errorName, skip });
    },

    dump(name) {
      const record = databases.get(name);
      if (!record) return null;
      const stores = {};
      for (const [storeName, store] of record.stores) {
        stores[storeName] = Object.fromEntries([...store].map(([k, v]) => [k, structuredClone(v)]));
      }
      return { version: record.version, stores };
    },

    /** Test setup: a database written directly, as another build or program would have left it. */
    seed(name, version, stores) {
      const record = newRecord(name);
      record.version = version;
      for (const [storeName, entries] of Object.entries(stores)) {
        record.stores.set(storeName, new Map(Object.entries(entries).map(([k, v]) => [k, structuredClone(v)])));
      }
      databases.set(name, record);
    },

    openConnections(name) {
      const record = databases.get(name);
      return record ? [...record.connections].filter((c) => !c.closed).length : 0;
    },

    open(name, version) {
      if (typeof name !== 'string') throw new TypeError('name');
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new TypeError('version');
      const request = new OpenRequest();
      enqueue(name, () => runOpen(request, name, version));
      return request;
    },

    deleteDatabase(name) {
      if (typeof name !== 'string') throw new TypeError('name');
      const request = new OpenRequest();
      enqueue(name, () => runDelete(request, name));
      return request;
    },

    databases() {
      return Promise.resolve([...databases.values()].map(({ name, version }) => ({ name, version })));
    },
  };

  function newRecord(name) {
    return { name, version: 0, stores: new Map(), connections: new Set(), waiters: [], txQueue: [] };
  }

  // Open and delete requests for one name run one after another, as in browsers.
  function enqueue(name, run) {
    const previous = queues.get(name) ?? Promise.resolve();
    const next = previous.then(() => new Promise((resolve) => {
      task(() => {
        run().then(resolve, (error) => {
          factory.uncaught.push(error);
          resolve();
        });
      });
    }));
    queues.set(name, next);
  }

  function waitClosed(record) {
    if (record.connections.size === 0) return Promise.resolve();
    return new Promise((resolve) => record.waiters.push(resolve));
  }

  function fail(request, error) {
    request.readyState = 'done';
    request.result = undefined;
    request.error = error;
    try {
      dispatch(request, 'error');
    } catch (thrown) {
      factory.uncaught.push(thrown);
    }
  }

  function succeed(request, result) {
    request.readyState = 'done';
    request.result = result;
    try {
      dispatch(request, 'success');
    } catch (thrown) {
      factory.uncaught.push(thrown);
    }
  }

  async function askOthersToClose(record, request, newVersion) {
    for (const connection of [...record.connections]) {
      if (!connection.closePending) {
        try {
          dispatch(connection, 'versionchange', { oldVersion: record.version, newVersion });
        } catch (thrown) {
          factory.uncaught.push(thrown);
        }
      }
    }
    await new Promise((resolve) => task(resolve));
    if (record.connections.size > 0) {
      dispatch(request, 'blocked', { oldVersion: record.version, newVersion });
      await waitClosed(record);
    }
  }

  async function runOpen(request, name, version) {
    const fault = factory.takeFault('open');
    if (fault) {
      fail(request, domError(fault));
      return;
    }
    let record = databases.get(name);
    const existed = record !== undefined;
    if (!existed) {
      record = newRecord(name);
      databases.set(name, record);
    }
    const requested = version ?? Math.max(record.version, 1);
    if (requested < record.version) {
      fail(request, domError('VersionError'));
      return;
    }
    if (requested === record.version) {
      succeed(request, new Connection(factory, record));
      return;
    }
    await askOthersToClose(record, request, requested);
    const oldVersion = record.version;
    const snapshot = new Map([...record.stores].map(([storeName, store]) => [storeName, new Map(store)]));
    record.version = requested;
    const connection = new Connection(factory, record);
    const tx = new Transaction(connection, [...record.stores.keys()], 'versionchange');
    connection.upgrade = tx;
    request.result = connection;
    request.transaction = tx;
    request.readyState = 'done';
    try {
      dispatch(request, 'upgradeneeded', { oldVersion, newVersion: requested });
    } catch (thrown) {
      factory.uncaught.push(thrown);
      if (!tx.finished) tx.fail(domError('AbortError'));
    }
    tx.active = false;
    tx.schedule();
    const outcome = await tx.settled;
    request.transaction = null;
    if (outcome === 'abort') {
      record.stores = snapshot;
      record.version = oldVersion;
      connection.closePending = true;
      connection.maybeClosed();
      if (!existed || oldVersion === 0) databases.delete(name);
      fail(request, domError('AbortError'));
      return;
    }
    if (connection.closePending) {
      fail(request, domError('AbortError'));
      return;
    }
    succeed(request, connection);
  }

  async function runDelete(request, name) {
    const fault = factory.takeFault('deleteDatabase');
    if (fault) {
      fail(request, domError(fault));
      return;
    }
    const record = databases.get(name);
    if (!record) {
      request.readyState = 'done';
      dispatch(request, 'success', { oldVersion: 0, newVersion: null });
      return;
    }
    await askOthersToClose(record, request, null);
    databases.delete(name);
    request.readyState = 'done';
    dispatch(request, 'success', { oldVersion: record.version, newVersion: null });
  }

  return factory;
}
