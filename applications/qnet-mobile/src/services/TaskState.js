// Whether the user swiped QNet Wallet away since it was last opened, as the native QNetTaskState keeps it on both
// platforms (TaskState.kt, TaskState.swift; the rule is ./AnswerGate's). A module that cannot answer says false, so a
// build that cannot tell never stops a node.
import { NativeModules } from 'react-native';

export async function closedByUser() {
  const native = NativeModules.QNetTaskState;
  if (!native || typeof native.closedByUser !== 'function') return false;
  try {
    return (await native.closedByUser()) === true;
  } catch (_) {
    return false;
  }
}

// Why a process of the app ended, in the words Android's record maps to (TaskState.kt exitReasonName).
export const EXIT_REASONS = ['crash', 'anr', 'low_memory', 'system_killed', 'user_closed', 'swiped', 'other', 'unknown'];

/**
 * Why the newest process of QNet Wallet that ended after `sinceMs` ended, as Android 11+ records it: { reason, at, api }
 * (`at` ms, `api` the Android API level), or null where nothing is recorded: iOS keeps no such record, and neither does
 * Android before 11; a module that cannot answer, or answers anything else, is nothing too.
 */
export async function lastExit(sinceMs = 0) {
  const native = NativeModules.QNetTaskState;
  if (!native || typeof native.lastExit !== 'function') return null;
  try {
    const r = await native.lastExit(sinceMs);
    if (!r || !EXIT_REASONS.includes(r.reason) || !Number.isSafeInteger(r.at) || !Number.isSafeInteger(r.api)) return null;
    return { reason: r.reason, at: r.at, api: r.api };
  } catch (_) {
    return null;
  }
}

export default { closedByUser, lastExit };
