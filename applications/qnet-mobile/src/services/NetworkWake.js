/**
 * The one wake of the app's retries that wait on a back-off for aiqnet.io (utils/pause retryPause: a QNet Link answer
 * being delivered, the request's reads, a registration being sent): each tries again at once, its back-off starting
 * again from its first wait, when the device has a network again (the `qnetNetworkBack` event of the QNetNetwork
 * module: Android's default-network watch, AppNetwork.kt; iOS's path watch, AppNetwork.swift) and when the app comes to
 * the front. Otherwise their back-off stands. The time of the last network change is kept too: on the Solana site
 * route a direct call is tried again after it (services/SolanaSend).
 */
import { AppState, NativeEventEmitter, NativeModules } from 'react-native';
import { wakeRetries } from '../utils/pause';

export const NETWORK_BACK_EVENT = 'qnetNetworkBack';

let networkBackAt = 0;

/** When the device last got a network again, ms since the epoch; 0 before the first. A return to the front is none. */
export const lastNetworkBack = () => networkBackAt;

/** Starts the wake, once per JS start (index.js); returns the function that stops it. */
export function watchWakes() {
  const subs = [AppState.addEventListener('change', (state) => { if (state === 'active') wakeRetries(); })];
  const native = NativeModules.QNetNetwork;
  if (native) {
    subs.push(new NativeEventEmitter(native).addListener(NETWORK_BACK_EVENT, () => {
      networkBackAt = Date.now();
      wakeRetries();
    }));
  }
  return () => { subs.forEach((s) => s.remove()); };
}
