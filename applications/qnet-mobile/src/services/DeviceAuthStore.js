/**
 * Where a wallet that opens with the device's screen lock keeps its vault secret, one API on both platforms:
 * - iOS: a Keychain item behind Face ID / Touch ID or the device passcode (removed by iOS with the passcode).
 * - Android (11 and later): a blob in app storage, sealed for an RSA key pair in the Keystore whose private half needs
 *   a strong biometric or the device credential for every use (a CryptoObject-bound system prompt); sealing uses the
 *   public half and asks nothing. The key dies with the screen lock.
 * Writing never prompts; reading prompts once. `available()` says whether this device can hold such a secret now: a
 * device without a screen lock, or an older one, uses a wallet password instead. Removing the screen lock deletes the
 * secret for good on both platforms, even when a screen lock is set again later: `state()` tells so without a prompt,
 * and a read says `gone`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';

const N = NativeModules.QNetSecurity || null;
const BLOB_PREFIX = 'qnet_devauth_';
const blobKey = (service) => `${BLOB_PREFIX}${service}`;
const toB64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const fromB64 = (b64) => Buffer.from(String(b64), 'base64').toString('utf8');

// Android's answers that no prompt can change: the screen lock that guarded the secret was removed (its key is gone,
// invalidated or replaced by a newer one), or there is no screen lock now.
const GONE_CODES = new Set(['NOT_SET', 'KEY_INVALIDATED', 'KEY_MISSING', 'KEY_CORRUPTED', 'SEALED_DAMAGED']);
// iOS: errSecUserCanceled, and LocalAuthentication's user, app and system cancels.
const IOS_CANCEL_CODES = new Set(['-128', '-2', '-4', '-9']);
// iOS: errSecInteractionNotAllowed, the read of an app that is not in front (launched in the background for a silent
// push or a background fetch) or of a locked device. Nothing failed: the same read works once the app is in front.
const IOS_NOT_NOW_CODE = '-25308';

const iosItem = () => ({
  accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
});

/**
 * Whether the device can hold a vault secret behind its screen lock right now: 'yes', 'no' (no screen lock, an older
 * device, a key that cannot be made), or 'unknown' when the device did not answer (Android: a busy Keystore, which the
 * native side rejects rather than calling a no; MA-R2-04).
 */
export async function availability() {
  try {
    if (Platform.OS === 'ios') return (await Keychain.isPasscodeAuthAvailable()) ? 'yes' : 'no';
    if (!N || !N.devAuthAvailable) return 'no';
    return (await N.devAuthAvailable()) ? 'yes' : 'no';
  } catch (_) {
    return 'unknown';
  }
}

/** Whether the device can hold a vault secret behind its screen lock right now (an unanswered check is a no). */
export async function available() {
  return (await availability()) === 'yes';
}

/** Stores `secret` under `service`, replacing any earlier one. Asks nothing; throws when the device refuses. */
export async function write(service, secret) {
  if (Platform.OS === 'ios') {
    const ok = await Keychain.setGenericPassword('qnet_wallet', secret, { service, ...iosItem() });
    if (!ok) throw new Error('The Keychain refused the vault secret');
    return;
  }
  if (!N || !N.devAuthSeal) throw new Error('No device key');
  await AsyncStorage.setItem(blobKey(service), await N.devAuthSeal(toB64(secret)));
}

/** Removes the secret under `service` (nothing happens when there is none). */
export async function remove(service) {
  if (Platform.OS === 'ios') {
    await Keychain.resetGenericPassword({ service });
    return;
  }
  await AsyncStorage.removeItem(blobKey(service));
}

/**
 * The first of `services` that holds a secret, behind one fresh device authentication with the prompt `title`:
 * { ok: true, service, secret }, or { ok: false, reason }: 'cancelled' (the prompt was refused), 'gone' (no item holds a
 * secret any more: the screen lock that guarded it was removed, so no prompt can bring it back) or 'failed' (anything
 * else; the next try may work), with the platform's `code` so a caller can tell a failure for now from a device whose
 * prompt cannot give a secret back (WalletManager._readBackVerdict). A missing item is passed over without a prompt.
 */
export async function read(services, title) {
  for (const service of services) {
    if (Platform.OS === 'ios') {
      try {
        const creds = await Keychain.getGenericPassword({ service, authenticationPrompt: { title } });
        if (creds && creds.password) return { ok: true, service, secret: creds.password };
        continue;
      } catch (e) {
        const code = String((e && e.code) || '');
        if (IOS_CANCEL_CODES.has(code) || /cancel/i.test(String((e && e.message) || ''))) return { ok: false, reason: 'cancelled' };
        // A read refused because the app is not in front says nothing about the item (MA-R2-02).
        if (code === IOS_NOT_NOW_CODE) return { ok: false, reason: 'failed', code, notNow: true };
        // An item that vanished under the read is gone; one still there failed for now.
        let still = true;
        try { still = !!(await Keychain.hasGenericPassword({ service })); } catch (_) { still = true; }
        if (still) return { ok: false, reason: 'failed', code };
        continue;
      }
    }
    let blob = null;
    try { blob = await AsyncStorage.getItem(blobKey(service)); } catch (_) { return { ok: false, reason: 'failed', code: 'STORAGE' }; }
    if (!blob) continue;
    if (!N || !N.devAuthOpen) return { ok: false, reason: 'failed', code: 'NO_MODULE' };
    try {
      return { ok: true, service, secret: fromB64(await N.devAuthOpen(blob, String(title || ''), '', '', false)) };
    } catch (e) {
      const code = String((e && e.code) || '');
      if (code === 'BIO_CANCELLED') return { ok: false, reason: 'cancelled' };
      // This item can never open again; an older or newer item may still.
      if (GONE_CODES.has(code)) continue;
      return { ok: false, reason: 'failed', code };
    }
  }
  return { ok: false, reason: 'gone' };
}

/**
 * 'present' when one of `services` still holds a secret the screen lock can release, 'gone' when none does (the screen
 * lock that guarded it was removed, even if another one was set since). Asks nothing. A store that cannot tell right
 * now answers 'present': only a certain loss is reported.
 */
export async function state(services) {
  for (const service of services) {
    try {
      if (Platform.OS === 'ios') {
        if (await Keychain.hasGenericPassword({ service })) return 'present';
        continue;
      }
      const blob = await AsyncStorage.getItem(blobKey(service));
      if (!blob) continue;
      if (!N || !N.devAuthUsable) return 'present';
      if ((await N.devAuthUsable(blob)) !== 'gone') return 'present';
    } catch (_) {
      return 'present';
    }
  }
  return 'gone';
}
