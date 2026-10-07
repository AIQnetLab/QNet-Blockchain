// Worker → extension-page notifications without a dependency on the router: sw.js installs the
// router's broadcaster, modules call notifyViews(). Payloads are always null; pages re-read state.
import { VIEW_EVENTS } from './config.js';

let broadcaster = null;

/**
 * sw.js wiring: the function that reaches every open extension page (router.broadcastToViews).
 * @param {(event: string, data: null) => void} fn
 * @returns {void}
 */
export function setViewBroadcaster(fn) {
  if (typeof fn !== 'function') throw new TypeError('broadcaster must be a function');
  broadcaster = fn;
}

/**
 * Tells every open extension page that `event` happened. Unknown events and a missing broadcaster are
 * ignored; never throws.
 * @param {'locked'|'unlocked'|'wiped'|'activation'|'approval'|'balance'} event
 * @returns {void}
 */
export function notifyViews(event) {
  if (broadcaster === null || !VIEW_EVENTS.includes(event)) return;
  try {
    broadcaster(event, null);
  } catch {
    // a page that is closing is not an error
  }
}
