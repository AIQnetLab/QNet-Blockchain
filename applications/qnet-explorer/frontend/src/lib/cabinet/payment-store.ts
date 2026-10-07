// The node cabinet's payment addresses, kept in this browser only (IndexedDB database `qnet-cabinet`, store
// `paymentKeys`, one record per address; src/lib/cabinet/flow.ts has the record). The key in a record is a
// non-extractable WebCrypto key: the browser uses it for this origin and never hands it out, and nothing here
// reads it. Only src/lib/cabinet/payment-key.ts signs with it; My node's Node details read the receipts. A record moves
// only through `update`, one transaction that reads and writes it, so two tabs never both take the same step.

import { READ_PASS_RE } from './burn-tx.ts';
import { isBurnAmount, isReservationId } from './burn-record.ts';
import { DROPPED_KEPT, STAGES, type PaymentRecord } from './flow.ts';
import { MLDSA65_PUBLIC_KEY_BYTES, MLDSA65_SIGNATURE_BYTES, decodeB64url, isSolanaSignature } from '../qnet-link.ts';
import { isEonAddress } from '../qnet-provider.ts';
import { decodeKey } from '../solana-message.ts';

const DB_NAME = 'qnet-cabinet';
const STORE = 'paymentKeys';
// Receipts of finished activations kept for Node details; the oldest go first.
export const RECEIPTS_KEPT = 10;

// The storage underneath: IndexedDB in the page, a map in the tests.
export interface PaymentArea {
  all(): Promise<unknown[]>;
  // Reads the record of `pub` and writes what `change` returns (undefined: nothing; null: delete), in one step.
  update(pub: string, change: (current: unknown) => PaymentRecord | null | undefined): Promise<void>;
}

// Whether this browser offers the storage at all (a private window may not).
export const storageAvailable = (): boolean => typeof indexedDB !== 'undefined';

// Asks the browser to keep this site's storage when it is short of room (SITE-R1-06): after a burn the payment key in
// it is the only authority that can register that burn. Some browsers ask the user first, so callers never wait for
// the answer; nothing depends on it, and a browser may still delete the data of a site not visited for a week.
export async function requestPersistence(storage: { persist?: () => Promise<boolean> } | undefined = globalThis.navigator?.storage): Promise<boolean> {
  try {
    return typeof storage?.persist === 'function' ? (await storage.persist()) === true : false;
  } catch {
    return false;
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Only a write creates the database, so a visitor who never started an activation leaves nothing in the browser.
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

export const browserArea: PaymentArea = {
  all: async () => {
    const db = await openDb(false);
    if (!db) return [];
    try {
      return await request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    } finally {
      db.close();
    }
  },
  update: async (pub, change) => {
    const db = await openDb(true);
    if (!db) throw new Error('storage');
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const get = store.get(pub);
        get.onsuccess = () => {
          const next = change(get.result);
          if (next === null) store.delete(pub);
          else if (next !== undefined) store.put(next, pub);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
// A read pass is absent or of its form (burn-tx.ts READ_PASS_RE).
const isPass = (v: unknown): boolean => v === undefined || (typeof v === 'string' && READ_PASS_RE.test(v));
const isBurnFacts = (b: unknown): boolean => isObject(b) && isSolanaSignature(b.tx) && isTime(b.lastValidBlockHeight) && isTime(b.amount) && isPass(b.pass);

function isPaymentKey(value: unknown): boolean {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey
    && value.type === 'private' && value.extractable === false && value.algorithm.name === 'Ed25519';
}

// A stored record, or null for anything malformed. The fields are checked as the page relies on them; the key must
// be a non-extractable Ed25519 private key or absent (a receipt).
export function checkRecord(value: unknown): PaymentRecord | null {
  if (!isObject(value) || value.v !== 1 || typeof value.pub !== 'string' || !decodeKey(value.pub)) return null;
  if (value.key !== null && !isPaymentKey(value.key)) return null;
  if (value.network !== 'testnet' && value.network !== 'mainnet') return null;
  if (!isTime(value.createdAt) || !isTime(value.updatedAt) || !(STAGES as readonly unknown[]).includes(value.stage)) return null;
  const burn = value.burn;
  if (burn !== null && !isBurnFacts(burn)) return null;
  const answer = value.answer;
  if (answer !== null && (!isObject(answer) || !isEonAddress(answer.qnet) || typeof answer.nodeId !== 'string' || !isObject(answer.consent))) return null;
  const submit = value.submit;
  if (submit !== null && (!isObject(submit) || !isEonAddress(submit.qnet) || typeof submit.nodeId !== 'string')) return null;
  if (value.link !== null && !isObject(value.link)) return null;
  if (value.refund !== null && (!isObject(value.refund) || !isPass(value.refund.pass))) return null;
  const dropped = value.dropped;
  if (dropped !== undefined && (!Array.isArray(dropped) || dropped.length > DROPPED_KEPT
    || !dropped.every((b) => isBurnFacts(b) && (b.droppedAt === undefined || isTime(b.droppedAt))))) return null;
  const receipt = value.receipt;
  if (receipt !== undefined && (value.stage !== 'done' || !isObject(receipt) || !isEonAddress(receipt.qnet) || typeof receipt.nodeId !== 'string')) return null;
  const reservation = value.reservation;
  if (reservation !== undefined && (!isObject(reservation) || !isReservationId(reservation.id) || !isEonAddress(reservation.wallet)
    || !isTime(reservation.until) || !isBurnAmount(reservation.amount))) return null;
  // The wallet the activation is for, and its signed reservation for exactly that wallet.
  if (value.wallet !== undefined && !isEonAddress(value.wallet)) return null;
  const hold = value.hold;
  if (hold !== undefined && (!isObject(hold) || hold.wallet !== value.wallet || !decodeB64url(hold.pk, MLDSA65_PUBLIC_KEY_BYTES)
    || !decodeB64url(hold.sig, MLDSA65_SIGNATURE_BYTES) || !isTime(hold.time))) return null;
  // A record waiting for QNet Wallet's confirmation names its wallet and holds nothing else.
  if (value.stage === 'walletConfirm' && (value.wallet === undefined || hold !== undefined || burn !== null)) return null;
  // A record past the burn names it (one that ends before a burn has none); a receipt keeps no key.
  if (!['walletConfirm', 'funding', 'funded', 'burnFailed', 'closing'].includes(value.stage as string) && burn === null) return null;
  if (value.key === null && value.stage !== 'done') return null;
  return value as unknown as PaymentRecord;
}

// Every valid record, newest first; nothing when storage is blocked.
export async function listRecords(area: PaymentArea = browserArea): Promise<PaymentRecord[]> {
  try {
    const all = (await area.all()).map(checkRecord).filter((r): r is PaymentRecord => r !== null);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function saveNew(record: PaymentRecord, area: PaymentArea = browserArea): Promise<boolean> {
  let saved = false;
  try {
    await area.update(record.pub, (current) => {
      if (current !== undefined) return undefined;
      saved = true;
      return record;
    });
  } catch {
    return false;
  }
  return saved;
}

// Moves a record: `change` gets the current, valid record and returns the next one, or null to leave it as it is.
// The record written, or null when it was not (gone, malformed, refused by `change`, storage blocked).
export async function updateRecord(
  pub: string,
  change: (current: PaymentRecord) => PaymentRecord | null,
  area: PaymentArea = browserArea,
): Promise<PaymentRecord | null> {
  let written: PaymentRecord | null = null;
  try {
    await area.update(pub, (current) => {
      const record = checkRecord(current);
      const next = record ? change(record) : null;
      if (!next || next.pub !== pub) return undefined;
      written = next;
      return next;
    });
  } catch {
    return null;
  }
  return written;
}

export async function removeRecord(pub: string, area: PaymentArea = browserArea): Promise<void> {
  try {
    await area.update(pub, () => null);
  } catch {
    // storage blocked: nothing is kept
  }
}

// Keeps at most RECEIPTS_KEPT finished activations; the oldest go.
export async function pruneReceipts(area: PaymentArea = browserArea): Promise<void> {
  const done = (await listRecords(area)).filter((r) => r.stage === 'done');
  for (const old of done.slice(RECEIPTS_KEPT)) await removeRecord(old.pub, area);
}
