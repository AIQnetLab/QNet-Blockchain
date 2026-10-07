/**
 * Android: whether the user swiped QNet Wallet away from the recent apps since it was last opened (owner rule, 04.10: a
 * light node is counted only while the wallet runs on its device). Android ends a swiped app's process, but a data push
 * or a scheduled wake may start a new one in the background: that one must answer nothing until the app is opened again
 * (./AnswerGate, which every answer path asks; a restart since the last open is its own check). The native side
 * (TaskState.kt) keeps the mark: set when the task is removed while the process lives, or found in the system's record of
 * how the last process ended (Android 11+), cleared when the app comes to the front. A module that cannot answer says
 * false: a node is never stopped for a build that cannot tell.
 */
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

export default { closedByUser };
