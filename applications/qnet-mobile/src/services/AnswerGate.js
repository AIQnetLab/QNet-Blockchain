/**
 * Whether this device's light node may answer the network now. The rule is the same on every phone and tablet (owner,
 * 04.10 and 05.10): the node answers only while QNet Wallet runs, in front, in the background or behind the app's or the
 * phone's lock, after the user opened it at least once since the device last started, and not swiped away since.
 *
 * - In front: it answers, and this boot is noted as opened.
 * - Swiped away since it was last opened: no answer (./TaskState, Android; iOS starts a force-quit app for no push and
 *   no fetch until it is opened or the device restarts). Android cannot see every swipe (L-7): on Android 8 to 10 a
 *   swipe more than about a minute after the app left the front, without the battery exemption, and on any version a
 *   swipe after the system had already ended the app's process, leave no mark. The node answers then, by the owner's
 *   rule that it answers when the app cannot tell; only a foreground service could see them, and the app runs none.
 *   An empty list of the app's recent tasks is no sign: the system trims it without a swipe.
 * - Started again since it was last opened: no answer. Both systems may start the app in the background after a
 *   restart, for a data push or a scheduled fetch, without the user opening it. Both name the boot exactly (Android its
 *   start count, iOS its boot session id), so setting the clock never stops the node on either.
 * - A build whose boot clock does not answer cannot tell one boot from the next: the node answers then.
 *
 * Every path that answers asks here first (services/PushService: a push, a background fetch, the launch, a ping answer
 * and a self-attestation round).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { bootMark } from './DeviceSecurity';
import { closedByUser } from './TaskState';

// The boot the app was last opened in: { boot, mono, boots, bootId } as DeviceSecurity.bootMark gives it.
export const OPENED_BOOT_KEY = 'qnet_opened_boot';

// How far two readings of one boot's start may lie apart where neither a boot count nor a boot id names it: wall minus
// mono moves only when the wall clock is set. A restart with the app opened in between takes longer than this.
export const BOOT_TOLERANCE_MS = 30_000;

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : -1);
const bootIdOf = (v) => (typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : null);

/**
 * Whether `now` is the boot `mark` was taken in. A boot clock below the mark's is a new boot; two boot counts (Android)
 * or two boot ids (iOS, L-8) decide exactly, whatever the wall clock did; otherwise the two boot starts within
 * BOOT_TOLERANCE_MS (a mark noted by a build before the boot id). Anything unreadable is not the same boot.
 */
export function sameBoot(mark, now) {
  if (!mark || !now || typeof mark !== 'object') return false;
  if (![mark.boot, mark.mono, now.boot, now.mono].every(Number.isFinite)) return false;
  if (now.mono < mark.mono) return false;
  const a = count(mark.boots);
  const b = count(now.boots);
  if (a >= 0 && b >= 0) return a === b;
  const idA = bootIdOf(mark.bootId);
  const idB = bootIdOf(now.bootId);
  if (idA && idB) return idA === idB;
  return Math.abs(now.boot - mark.boot) <= BOOT_TOLERANCE_MS;
}

async function readBoot() {
  try {
    return await bootMark();
  } catch (_) {
    return null;
  }
}

/** The app is open: notes this boot. Nothing is noted while the boot clock does not answer. */
export async function noteOpen() {
  const now = await readBoot();
  if (!now) return;
  try {
    await AsyncStorage.setItem(OPENED_BOOT_KEY, JSON.stringify(now));
  } catch (_) { /* the next open notes it again */ }
}

/** Whether the app was opened since the device last started (true when the boot clock cannot tell). */
export async function openedThisBoot() {
  const now = await readBoot();
  if (!now) return true;
  let mark = null;
  try {
    mark = JSON.parse((await AsyncStorage.getItem(OPENED_BOOT_KEY)) || 'null');
  } catch (_) {
    mark = null;
  }
  return sameBoot(mark, now);
}

/** Whether the node may answer now (the rule above). */
export async function mayAnswer() {
  if (AppState.currentState === 'active') {
    await noteOpen();
    return true;
  }
  if (await closedByUser()) return false;
  return openedThisBoot();
}

/**
 * Why the node may not answer now, by the rule above: 'swiped', 'not_opened_since_boot', or null when it may. Read only
 * to record what came of a push (./PushReceipts); mayAnswer alone decides.
 */
export async function heldBecause() {
  if (AppState.currentState === 'active') return null;
  if (await closedByUser()) return 'swiped';
  return (await openedThisBoot()) ? null : 'not_opened_since_boot';
}

export default { mayAnswer, noteOpen, openedThisBoot, sameBoot, heldBecause };
