/**
 * Where the light node's ping secret keys live in the Keychain: this device's current one, per node, and the one of a
 * binding sent with no answer that waits for the network's word (PushService keepUnconfirmed). Both stay on this device
 * only and open after the first unlock, so a wake answers with the screen locked.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

export const PING_KEY_PREFIX = 'qnet_ping_sk_';
export const pingKeyService = (nodeId) => `${PING_KEY_PREFIX}${nodeId}`;
export const UNCONFIRMED_PING_SERVICE = 'qnet_ping_next';
// What adopting that waiting binding takes (PushService readUnconfirmedBinding); one at a time.
export const UNCONFIRMED_BIND_KEY = 'qnet_node_bind_unconfirmed';

export function storePingKey(service, secretKey) {
  return Keychain.setGenericPassword('ping', secretKey, {
    service, accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

/** The waiting binding goes with its ping key: the network settled it, the user ended it, or its wallet left. */
export async function forgetUnconfirmedBinding() {
  try { await Keychain.resetGenericPassword({ service: UNCONFIRMED_PING_SERVICE }); } catch (_) { /* never stored */ }
  await AsyncStorage.removeItem(UNCONFIRMED_BIND_KEY).catch(() => {});
}
