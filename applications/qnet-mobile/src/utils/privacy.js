/**
 * What the screen masks for the user, so a screenshot or a screen recording does not show it: the amounts (`balances`)
 * and the node names (`names`), each a switch of the header's More, kept on the device under its key, off until turned
 * on. A masked value is MASK (utils/amountFormat) in its place, in the same line and style, so nothing on screen moves.
 */
import { MASK } from './amountFormat';

export const PRIVACY_KEYS = Object.freeze({ balances: 'qnet_hide_balances', names: 'qnet_hide_node_names' });

export const NO_MASKS = Object.freeze({ balances: false, names: false });

/** `value` as the screen shows it: MASK while `hidden`. */
export function masked(value, hidden) {
  return hidden ? MASK : value;
}

/** The masks kept on the device (AsyncStorage-like `storage`): each on only when its key holds '1'. */
export async function readMasks(storage) {
  const out = { ...NO_MASKS };
  for (const [what, key] of Object.entries(PRIVACY_KEYS)) {
    try { out[what] = (await storage.getItem(key)) === '1'; } catch (_) { out[what] = false; }
  }
  return out;
}

/** Keeps one mask on the device; a failed write leaves the screen as it is. */
export function writeMask(storage, what, on) {
  return Promise.resolve().then(() => storage.setItem(PRIVACY_KEYS[what], on ? '1' : '0')).catch(() => {});
}
