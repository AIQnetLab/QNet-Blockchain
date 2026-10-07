/**
 * Whether the user closed QNet Wallet from the app switcher since it was last opened (owner rule, 04.10: a light node
 * is counted only while the wallet runs on its device). iOS: a wallet closed from the app switcher gets no background
 * push and no background fetch until the user opens it again or the device restarts (the system's own rule for a
 * force-quit app; the app has no VoIP push and no other wake, Info.plist UIBackgroundModes `remote-notification` and
 * `fetch` only), so nothing here has to refuse anything: always false. A restart is ./AnswerGate's: no answer until the
 * app is opened in the new boot. Android has its own file (./TaskState.android.js).
 */
export async function closedByUser() {
  return false;
}

export default { closedByUser };
