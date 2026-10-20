// The clipboard after a page copied a secret (the recovery phrase, a private key, the activation code: CONTRACTS.md
// section 8). The page tells the worker (clipboard.schedule) and the worker empties the clipboard when the copy's time is
// up, on CLIPBOARD_ALARM, whether or not that page is still open: the popup closes as soon as the user clicks elsewhere,
// and a page's own timer dies with it. A worker has no clipboard, so the write goes through the offscreen document
// (OFFSCREEN.PAGE, reason CLIPBOARD), which writes an empty text and is closed again. Nothing here reads the clipboard.
// Only the due time is kept (memory and chrome.storage.session), never the text.
import { CLIPBOARD_ALARM, OFFSCREEN, STORAGE_KEYS } from './config.js';
import { log } from './log.js';
import { ALARM_EARLY_MS, armAlarm, attempt, chromeApi } from './platform.js';

// The offscreen document answers at once; one that does not within this long has not emptied the clipboard.
const OFFSCREEN_REPLY_MS = 5000;
const JUSTIFICATION = 'Empties the clipboard of a recovery phrase, private key or activation code the wallet copied.';

// {until} of the clear still to run, null for none, undefined until read back after a worker start
let pending;
// one write through the offscreen document at a time: only one may exist
let writing = Promise.resolve();

async function readPending() {
  if (pending !== undefined) return pending;
  let stored = null;
  try {
    stored = (await chromeApi().storage.session.get(STORAGE_KEYS.CLIPBOARD))?.[STORAGE_KEYS.CLIPBOARD] ?? null;
  } catch {
    stored = null;
  }
  pending ??= Number.isSafeInteger(stored?.until) ? { until: stored.until } : null;
  return pending;
}

async function setPending(next) {
  pending = next;
  const api = chromeApi();
  await Promise.allSettled([
    next === null ? attempt(() => api.storage.session.remove(STORAGE_KEYS.CLIPBOARD))
      : attempt(() => api.storage.session.set({ [STORAGE_KEYS.CLIPBOARD]: { until: next.until } })),
    armAlarm(CLIPBOARD_ALARM, next?.until ?? null),
  ]);
}

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([promise, new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  })]).finally(() => clearTimeout(timer));
}

// Opens the offscreen document, asks it to write an empty clipboard and closes it; whether it did.
async function writeEmpty() {
  const api = chromeApi();
  if (typeof api?.offscreen?.createDocument !== 'function') {
    log.warn('clipboard not cleared', 'no offscreen document');
    return false;
  }
  try {
    await api.offscreen.createDocument({ url: OFFSCREEN.PAGE, reasons: ['CLIPBOARD'], justification: JUSTIFICATION });
  } catch (error) {
    // one is open already (a worker that stopped while it was), which takes the request as well
    log.debug('offscreen document not created', error?.name);
  }
  let cleared = false;
  try {
    const asked = attempt(() => api.runtime.sendMessage({ target: OFFSCREEN.TARGET, type: 'clear' }));
    const reply = await withTimeout(asked, OFFSCREEN_REPLY_MS);
    cleared = reply?.cleared === true;
  } catch (error) {
    log.debug('offscreen document unreachable', error?.name);
  } finally {
    await attempt(() => api.offscreen.closeDocument()).catch(() => {});
  }
  if (!cleared) log.warn('clipboard not cleared');
  return cleared;
}

function serialWrite() {
  const run = writing.then(writeEmpty, writeEmpty);
  writing = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Handler of `clipboard.schedule` (popup and setup, after a copy): `afterMs` > 0, a secret was copied, and the clipboard is
 * emptied that long from now (CLIPBOARD_ALARM; the browser fires an alarm no sooner than 30 seconds after it was set, a
 * minute before Chrome 120) unless a later copy from a page replaced it; 0, a copy that needs no clear replaced the
 * secret, and the clear still pending is dropped. One clear is pending at most: a new copy's replaces the earlier one.
 * @param {{afterMs: number}} params
 * @returns {Promise<{scheduled: boolean}>}
 */
export async function schedule(params) {
  const afterMs = params?.afterMs;
  if (!Number.isSafeInteger(afterMs) || afterMs < 0) throw new TypeError('afterMs must be a non-negative integer');
  await readPending();
  await setPending(afterMs === 0 ? null : { until: Date.now() + afterMs });
  return { scheduled: afterMs > 0 };
}

/**
 * Handler of `clipboard.clearNow` (setup at its end), and the erase's own step (vault.eraseAll): empties the clipboard
 * now when a clear is pending, and drops it; anything else on the clipboard (a copy no page asked to clear) stays. Never
 * throws.
 * @returns {Promise<{cleared: boolean}>} cleared: a pending clear ran and the offscreen document reported it done
 */
export async function clearNow() {
  try {
    if ((await readPending()) === null) return { cleared: false };
    await setPending(null);
    return { cleared: await serialWrite() };
  } catch (error) {
    log.warn('clipboard clear failed', error?.name);
    return { cleared: false };
  }
}

/**
 * chrome.alarms.onAlarm listener: CLIPBOARD_ALARM at or past the due time empties the clipboard (clearNow); an early
 * one is armed again for the due time.
 * @param {{name: string}} alarm
 * @returns {Promise<void>}
 */
export async function onAlarm(alarm) {
  if (alarm?.name !== CLIPBOARD_ALARM) return;
  const due = await readPending();
  if (due === null) return;
  if (due.until > Date.now() + ALARM_EARLY_MS) {
    await armAlarm(CLIPBOARD_ALARM, due.until).catch(() => log.warn('clipboard alarm not armed'));
    return;
  }
  await clearNow();
}
