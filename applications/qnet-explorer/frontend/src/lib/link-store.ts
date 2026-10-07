// One unfinished QNet Link session per slot of a cabinet page (the activation page has one per activation, so one
// activation's request never takes another's place, SITE-R3-02), kept in this browser until the session ends
// (docs/protocols/qnet-link-v1.md section 14.6): a phone browser may discard the tab while QNet Wallet is in
// front, and the page must still read the answer when the user returns. Only a session whose private key is a
// non-extractable WebCrypto key is kept: the browser uses that key for this origin and never hands it out. The
// record holds nothing else that is secret (the id, the request, the public key and the expiry), and an
// expired record is deleted when it is read.

import { checkRequest, decodeB64url, isSessionId, INTENTS, type LinkIntent, type LinkRequest } from './qnet-link.ts';
import { sessionWithKey, type SiteSession } from './qnet-link-crypto.ts';

const DB_NAME = 'qnet-link';
const STORE = 'sessions';

export interface StoredSession {
  id: string;
  intent: LinkIntent;
  request: LinkRequest | null;
  sitePub: string;
  privateKey: CryptoKey;
  expiresAt: number;
}

// The storage underneath: IndexedDB in the page, a map in the tests.
export interface SessionArea {
  get(slot: string): Promise<unknown>;
  put(slot: string, value: StoredSession): Promise<void>;
  delete(slot: string): Promise<void>;
  slots(): Promise<string[]>;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// The database; only a write creates it, so a page that never kept a session leaves nothing in the browser.
function openDb(create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (create) req.result.createObjectStore(STORE);
      else req.transaction?.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => (create ? reject(req.error) : resolve(null));
  });
}

async function withStore<T>(create: boolean, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>, empty: T): Promise<T> {
  const db = await openDb(create);
  if (!db) return empty;
  try {
    return await request(run(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

export const browserArea: SessionArea = {
  get: (slot) => withStore<unknown>(false, 'readonly', (s) => s.get(slot), undefined),
  put: async (slot, value) => {
    await withStore<IDBValidKey>(true, 'readwrite', (s) => s.put(value, slot), slot);
  },
  delete: async (slot) => {
    await withStore<undefined>(false, 'readwrite', (s) => s.delete(slot), undefined);
  },
  slots: async () => (await withStore<IDBValidKey[]>(false, 'readonly', (s) => s.getAllKeys(), [])).filter((k): k is string => typeof k === 'string'),
};
function isWebCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey
    && value.type === 'private' && value.extractable === false && value.algorithm.name === 'X25519';
}

// A stored record back as a session, or null for anything malformed or expired.
function restore(value: unknown, now: number): SiteSession | null {
  if (value === null || typeof value !== 'object') return null;
  const r = value as Partial<StoredSession>;
  if (!isSessionId(r.id) || !(INTENTS as readonly unknown[]).includes(r.intent) || !decodeB64url(r.sitePub, 32)) return null;
  if (typeof r.expiresAt !== 'number' || r.expiresAt <= now || !isWebCryptoKey(r.privateKey)) return null;
  const intent = r.intent as LinkIntent;
  const requestOk = intent === 'connect' ? r.request === null : checkRequest(intent, r.request) !== null;
  if (!requestOk) return null;
  try {
    return sessionWithKey(r.id, intent, r.request ?? null, r.sitePub as string, { kind: 'webcrypto', privateKey: r.privateKey });
  } catch {
    return null;
  }
}

// Keeps a session under `slot` until `expiresAt`; false when it cannot (a key in memory only, or no storage).
export async function saveSession(slot: string, s: SiteSession, expiresAt: number, area: SessionArea = browserArea): Promise<boolean> {
  if (s.key.kind !== 'webcrypto' || s.closed) return false;
  try {
    await area.put(slot, { id: s.id, intent: s.intent, request: s.request, sitePub: s.sitePub, privateKey: s.key.privateKey, expiresAt });
    return true;
  } catch {
    return false;
  }
}

export async function loadSession(slot: string, now: number, area: SessionArea = browserArea): Promise<{ session: SiteSession; expiresAt: number } | null> {
  try {
    const value = await area.get(slot);
    if (value === undefined) return null;
    const session = restore(value, now);
    if (!session) {
      await area.delete(slot);
      return null;
    }
    return { session, expiresAt: (value as StoredSession).expiresAt };
  } catch {
    return null;
  }
}

// Deletes every kept session that expired or cannot be read back, whichever page kept it.
export async function purgeSessions(now: number, area: SessionArea = browserArea): Promise<void> {
  try {
    for (const slot of await area.slots()) {
      if (!restore(await area.get(slot), now)) await area.delete(slot);
    }
  } catch {
    // storage blocked: nothing was kept
  }
}

export async function clearSession(slot: string, area: SessionArea = browserArea): Promise<void> {
  try {
    await area.delete(slot);
  } catch {
    // storage blocked: nothing was kept
  }
}
