// The browser's chrome.* API as the worker modules that keep state in it call it (session.js, clipboard.js): read at call
// time, so a test or a restarted worker sees the current one, and every call as a promise.

// chrome.alarms may fire a little before `when`; closer than this to the due time counts as reached.
export const ALARM_EARLY_MS = 1000;

/**
 * The chrome.* global as it is now.
 * @returns {object}
 */
export function chromeApi() {
  return globalThis.chrome;
}

/**
 * A chrome.* call that may throw synchronously or reject; always a promise.
 * @template T
 * @param {() => T|Promise<T>} fn
 * @returns {Promise<T>}
 */
export function attempt(fn) {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Arms the one-shot alarm `name` for `when`, or clears it for null.
 * @param {string} name
 * @param {number|null} when ms epoch
 * @returns {Promise<unknown>} rejects when the browser refused
 */
export function armAlarm(name, when) {
  return attempt(() => (when === null ? chromeApi().alarms.clear(name) : chromeApi().alarms.create(name, { when })));
}
