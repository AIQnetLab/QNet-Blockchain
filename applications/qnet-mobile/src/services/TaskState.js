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

export default { closedByUser };
