/**
 * The app's own native security module (QNetSecurity; Kotlin on Android, Objective-C on iOS):
 * screen protection for secret screens, the recovery-phrase field's clipboard guard, the recovery phrase's Copy
 * with its timed clearing, the Android Keystore keys that seal the vault, the boot clock for the password lockout, a
 * local device-integrity check, and the wipe of the in-app browser's data. Nothing here talks to the network. Every call degrades to a harmless default when
 * the module is missing (unit tests, an older native build).
 */
import { useEffect } from 'react';
import { NativeModules, Platform } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';

const N = NativeModules.QNetSecurity || null;

export const nativeSecurityAvailable = () => !!N;

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));

// ── Screen protection ──────────────────────────────────────────────────────────────────────────────
// Android: FLAG_SECURE (no screenshots, recordings or recents thumbnail), overlay windows hidden (API 31+),
// accessibility services that are not assistive tools see nothing (API 34+), obscured touches dropped and
// keyboard learning off in the fields. iOS: the window is covered while the screen is captured, and a
// screenshot raises a warning. Counted, so overlapping secret screens keep it on until the last one closes.
let secureDepth = 0;

function applySecure(on) {
  if (!N || !N.setSecureScreen) return;
  try { N.setSecureScreen(on); } catch (_) { /* never let protection break the screen it protects */ }
}

export function acquireSecureScreen() {
  secureDepth += 1;
  if (secureDepth === 1) applySecure(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    secureDepth = Math.max(0, secureDepth - 1);
    if (secureDepth === 0) applySecure(false);
  };
}

/** Keeps the screen protected while `active` is true. */
export function useSecureScreen(active) {
  useEffect(() => (active ? acquireSecureScreen() : undefined), [active]);
}

// ── Protected interaction (Android) ────────────────────────────────────────────────────────────────
// A screen whose taps move value or approve a request (the send form, a site's or aiqnet.io's confirmation):
// the guard of a secret screen without FLAG_SECURE, so it can still be captured, but overlays are hidden,
// touches through an obscuring window are dropped and, from API 34, an accessibility service that is not an
// assistive tool neither sees the views nor acts on them (MPLAT-R2-01). Counted like the secure screen.
// None of this stops an accessibility service below API 34, or one that declares itself an assistive tool: what does
// is that the fresh check it would have to pass is a system biometric prompt it cannot see or pass, or a password whose
// text the app never gives to accessibility (every password field, on every screen and API level, MPLAT-R4-01), with
// such services named at unlock and on every confirmation. What a send approves is on that check too (MPLAT-R5-01):
// a review of the full recipient before it, and the recipient on the system prompt and on the password prompt, so a
// recipient swapped in the form is seen where the user approves. A touch through another app's window, even one that
// covers only part of the screen, is dropped natively (MPLAT-R5-02).
let protectDepth = 0;

function applyProtect(on) {
  if (!N || !N.setProtectInteraction) return;
  try { N.setProtectInteraction(on); } catch (_) { /* never let protection break the screen it protects */ }
}

export function acquireProtectedInteraction() {
  protectDepth += 1;
  if (protectDepth === 1) applyProtect(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    protectDepth = Math.max(0, protectDepth - 1);
    if (protectDepth === 0) applyProtect(false);
  };
}

/** Keeps the interaction guard on while `active` is true. */
export function useProtectedInteraction(active) {
  useEffect(() => (active ? acquireProtectedInteraction() : undefined), [active]);
}

// ── The recovery-phrase field (MPLAT-R3-01) ────────────────────────────────────────────────────────
/**
 * Android: while `on`, the field whose nativeID is SEED_FIELD_ID offers Paste and selection only in its menus, a
 * menu Paste takes the phrase off the clipboard right after it lands, and any copy of the field's text that reaches
 * the clipboard by another path (a keyboard's copy key, Ctrl+C, an accessibility action) is cleared at once. iOS does
 * the same in the react-native text view patch, keyed by testID. Called when the field is laid out and when it goes.
 */
export function guardSeedField(on) {
  if (Platform.OS !== 'android' || !N || !N.setSeedFieldGuard) return;
  try { N.setSeedFieldGuard(!!on); } catch (_) { /* the JS paste checks still run */ }
}

/** iOS: the pasteboard's change count, read without touching its contents (no paste prompt); null elsewhere. */
export async function pasteboardChangeCount() {
  if (Platform.OS !== 'ios' || !N || !N.pasteboardChangeCount) return null;
  try {
    const n = await N.pasteboardChangeCount();
    return Number.isFinite(Number(n)) ? Number(n) : null;
  } catch (_) {
    return null;
  }
}

/**
 * iOS: clears the pasteboard when it changed since the change count `since` (always, when that is unknown) and holds
 * text. Nothing is read from it, so no paste prompt appears. Resolves true when it cleared.
 */
export async function clearPasteboardIfChanged(since) {
  if (Platform.OS !== 'ios' || !N || !N.clearPasteboardIfChanged) return false;
  try {
    return !!(await N.clearPasteboardIfChanged(Number.isFinite(since) ? since : -1));
  } catch (_) {
    return false;
  }
}

// ── The recovery phrase on the clipboard ───────────────────────────────────────────────────────────
/** How long a recovery phrase copied by its Copy button may stay on the clipboard. */
export const SECRET_CLIPBOARD_SECONDS = 60;

let fallbackCopy = null; // { text, timer } without the native method (unit tests, the web test page)

/**
 * Copies a recovery phrase (an explicit tap on Copy only) and has it taken off the clipboard after
 * SECRET_CLIPBOARD_SECONDS if it is still there. iOS: on this device only (never Universal Clipboard), the pasteboard
 * item carrying that expiry, so it goes while the app is suspended too. Android: marked sensitive (the system's
 * clipboard preview hides it) and cleared by a native timer, which also runs while the app is in the background, where
 * Android lets an app write the clipboard but not read it: a clipboard it cannot read then is cleared all the same.
 * Without the native method: the plain clipboard and a JS timer. Resolves true when copied.
 */
export async function copySecret(text) {
  const value = String(text || '');
  if (!value) return false;
  if (N && N.copySecret) {
    try {
      return !!(await N.copySecret(value, SECRET_CLIPBOARD_SECONDS));
    } catch (_) {
      return false;
    }
  }
  if (fallbackCopy) clearTimeout(fallbackCopy.timer);
  Clipboard.setString(value);
  const entry = { text: value, timer: null };
  entry.timer = setTimeout(() => { if (fallbackCopy === entry) clearSecretCopy(); }, SECRET_CLIPBOARD_SECONDS * 1000);
  fallbackCopy = entry;
  return true;
}

/** Takes a phrase copySecret put there off the clipboard now if it is still there (Delete wallet). */
export async function clearSecretCopy() {
  if (N && N.clearSecretCopy) {
    try { await N.clearSecretCopy(); } catch (_) { /* the native timer still runs */ }
  }
  const entry = fallbackCopy;
  fallbackCopy = null;
  if (!entry) return;
  clearTimeout(entry.timer);
  try {
    if ((await Clipboard.getString()) === entry.text) Clipboard.setString('');
  } catch (_) { /* nothing readable to compare */ }
}

// ── The in-app browser's data ──────────────────────────────────────────────────────────────────────
/**
 * Wipes what the in-app browser left on the device when the wallet is deleted or replaced (L-6): every cookie, every
 * site's storage and the web caches, the same on Android and iOS (native clearWebData). Best effort: resolves false
 * without the native method or when the system refused, and never rejects, so nothing waits on it.
 */
export async function clearBrowserData() {
  if (!N || !N.clearWebData) return false;
  try {
    return !!(await N.clearWebData());
  } catch (_) {
    return false;
  }
}

// ── Native texts ───────────────────────────────────────────────────────────────────────────────────
/**
 * The words the native side shows by itself, in the app's language: the iOS cover shown while the screen is
 * recorded, the screenshot warning and the default authentication reason. A build without the method keeps English.
 */
export function setNativeTexts(texts) {
  if (!N || !N.setTexts || !texts) return;
  try { N.setTexts(texts); } catch (_) { /* the native defaults stay */ }
}

// ── Fresh device authentication ────────────────────────────────────────────────────────────────────
/**
 * The device's screen lock now, with no reuse: Face ID / Touch ID / passcode on iOS, a strong biometric or the device
 * credential on Android 11 and later. { ok, code: 'ok'|'cancelled'|'failed'|'not_set'|'unavailable' }.
 * `reason` is the prompt's one-line title. On Android `subtitle` (the apps that can read the screen) and `description`
 * (what is approved: a send's recipient) go into the system prompt's own lines, which it draws in full; iOS takes one
 * reason text, so they follow the title there.
 */
export async function deviceAuthenticate(reason, { subtitle = '', description = '' } = {}) {
  if (!N || !N.authenticate) return { ok: false, code: 'unavailable' };
  try {
    const title = String(reason || '');
    const r = Platform.OS === 'android' && N.authenticateWith
      ? await N.authenticateWith(title, String(subtitle || ''), String(description || ''))
      : await N.authenticate([title, subtitle, description].filter(Boolean).join('\n'));
    return { ok: !!(r && r.ok), code: (r && r.code) || 'failed' };
  } catch (_) {
    return { ok: false, code: 'failed' };
  }
}

// ── Boot clock ─────────────────────────────────────────────────────────────────────────────────────
/** { mono: ms since boot (not settable by the user), wall: Date.now() }. */
export async function bootClock() {
  if (N && N.bootClock) {
    try {
      const r = await N.bootClock();
      if (r && Number.isFinite(r.mono)) return { mono: Number(r.mono), wall: Number(r.wall) || Date.now() };
    } catch (_) {}
  }
  const wall = Date.now();
  return { mono: wall, wall };
}

/**
 * The boot this device runs now, from the same clock: `boot` when it started (wall ms, wall minus mono), `mono` ms since
 * then, `boots` the system's count of device starts (Android; -1 where none is kept), `bootId` the boot's own id (iOS:
 * a hash of the system's boot session id, 32 hex characters; null where none is given). Either of the last two names the
 * boot exactly. Null when no native clock answers: a build that cannot tell one boot from the next.
 */
export async function bootMark() {
  if (!N || !N.bootClock) return null;
  try {
    const r = await N.bootClock();
    const mono = Number(r && r.mono);
    const wall = Number(r && r.wall);
    if (!Number.isFinite(mono) || !Number.isFinite(wall) || mono < 0) return null;
    const boots = Number(r.boots);
    const bootId = typeof r.bootId === 'string' && /^[0-9a-f]{32}$/.test(r.bootId) ? r.bootId : null;
    return { boot: wall - mono, mono, boots: Number.isSafeInteger(boots) && boots >= 0 ? boots : -1, bootId };
  } catch (_) {
    return null;
  }
}

// ── Device integrity ───────────────────────────────────────────────────────────────────────────────
/** Local checks only (su binaries, test-keys, hooking frameworks, jailbreak files). Warns; never uploads. */
export async function deviceIntegrity() {
  if (!N || !N.deviceIntegrity) return { compromised: false, reasons: [] };
  try {
    const r = await N.deviceIntegrity();
    return { compromised: !!(r && r.compromised), reasons: (r && Array.isArray(r.reasons)) ? r.reasons : [] };
  } catch (_) {
    return { compromised: false, reasons: [] };
  }
}

/**
 * Android: the enabled accessibility services that did not come with the system, each as its self-chosen label with its
 * package ("Cleaner (com.example.cleaner)"). Such a service can read the screen, so the recovery phrase is shown only
 * after a warning naming them, and every confirmation names them. [] elsewhere.
 */
export async function screenReaderApps() {
  if (Platform.OS !== 'android' || !N || !N.screenReaders) return [];
  try {
    const r = await N.screenReaders();
    return Array.isArray(r) ? r.map(String) : [];
  } catch (_) {
    return [];
  }
}

// ── Device sealers for the vault ───────────────────────────────────────────────────────────────────
// Android: Keystore keys. iOS: a Secure Enclave key. Android's biometric key and its legacy seal exist only there.
const hasAndroidKeys = () => Platform.OS === 'android' && !!N && !!N.hwSeal;
const hasDeviceKeys = () => (Platform.OS === 'android' || Platform.OS === 'ios') && !!N && !!N.hwSeal;

/**
 * The name a vault records for the device key that seals its password wrap. The current key (v2) has no
 * unlocked-device requirement, so removing the screen lock cannot delete it (MVA-R4-01). LEGACY_DEVICE_SEALER names the
 * first key, which keystore2 on Android 12-14 deletes with the screen lock: a vault it sealed moves to the current key at
 * its next open (WalletManager._upgradeDeviceSeal), and the legacy key is deleted once no vault names it.
 */
export const DEVICE_SEALER = 'android-keystore-v2';
export const LEGACY_DEVICE_SEALER = 'android-keystore';
/**
 * iOS: a P-256 key in the Secure Enclave (QNetSecurityModule.m), this device only, usable while it is unlocked, no user
 * authentication, so a device without a passcode has one too. The wrap is sealed to it with ECIES (AES-GCM): a copy of
 * the app's files cannot be guessed at off the device, as on Android.
 */
export const IOS_DEVICE_SEALER = 'ios-secure-enclave-v1';

/** Whether `name` is the current device key of one of the platforms (a vault on it never moves to another key). */
export const isCurrentDeviceSealer = (name) => name === DEVICE_SEALER || name === IOS_DEVICE_SEALER;

// The current device key's name on this platform.
const ownSealerName = () => (Platform.OS === 'ios' ? IOS_DEVICE_SEALER : DEVICE_SEALER);

function sealerNamed(name) {
  if (name === IOS_DEVICE_SEALER && Platform.OS === 'ios') {
    return {
      name,
      seal: async (bytes) => unb64(await N.hwSeal(b64(bytes))),
      open: async (bytes) => unb64(await N.hwOpen(b64(bytes))),
    };
  }
  if (Platform.OS !== 'android') return null;
  if (name === DEVICE_SEALER) {
    return {
      name,
      seal: async (bytes) => unb64(await N.hwSeal(b64(bytes))),
      open: async (bytes) => unb64(await N.hwOpen(b64(bytes))),
    };
  }
  if (name === LEGACY_DEVICE_SEALER && N.hwOpenLegacy) {
    return {
      name,
      seal: async (bytes) => unb64(await N.hwSealLegacy(b64(bytes))),
      open: async (bytes) => unb64(await N.hwOpenLegacy(b64(bytes))),
    };
  }
  return null;
}

/**
 * The device key that seals a new password wrap: an AES-256-GCM Android Keystore key, StrongBox when present, or the
 * iOS Secure Enclave key; never exportable, no user authentication and no unlocked-device requirement. null where there
 * is none (a simulator, a device whose key could not be made).
 */
export async function deviceSealer() {
  if (!hasDeviceKeys()) return null;
  try {
    if (!(await N.hwAvailable())) return null;
  } catch (_) {
    return null;
  }
  return sealerNamed(ownSealerName());
}

/** The sealer an existing vault names, whether or not a new key could be made today. */
export function deviceSealerFor(name) {
  if (!hasDeviceKeys()) return null;
  return sealerNamed(name);
}

/** Deletes the legacy device key once no stored vault names it (MVA-R4-01). */
export async function deleteLegacyDeviceKey() {
  if (!hasAndroidKeys() || !N.hwDeleteLegacy) return;
  try { await N.hwDeleteLegacy(); } catch (_) {}
}

/**
 * The biometric key (Android): per-use authentication with a CryptoObject-bound BiometricPrompt, strong
 * biometrics only, invalidated when a fingerprint or face is enrolled. Each seal/open shows the prompt; its title,
 * subtitle, description (what an approval approves, such as a send's recipient) and the label of the button that
 * falls back to the password come from the caller, translated. `confirm`: an approval's prompt (a send, a site's
 * request, a burn) needs a deliberate press on the system dialog after a passive face match; unlock and enrolment
 * do not (MVA-R5-02).
 */
export function biometricSealer(prompt = {}) {
  if (!hasAndroidKeys() || !N.bioSeal) return null;
  const title = prompt.title || 'QNet Wallet';
  const subtitle = prompt.subtitle || '';
  const description = prompt.description || '';
  const cancel = prompt.cancel || '';
  const confirm = prompt.confirm === true;
  return {
    name: 'android-biometric',
    seal: async (bytes) => unb64(await N.bioSeal(b64(bytes), title, subtitle, cancel)),
    open: async (bytes) => unb64(await N.bioOpen(b64(bytes), title, subtitle, description, cancel, confirm)),
  };
}

export async function biometricKeyAvailable() {
  if (!hasAndroidKeys() || !N.bioAvailable) return false;
  try { return !!(await N.bioAvailable()); } catch (_) { return false; }
}

/** Deletes the biometric key only (biometric unlock turned off). */
export async function deleteBiometricKey() {
  if (!hasAndroidKeys() || !N.bioDelete) return;
  try { await N.bioDelete(); } catch (_) {}
}

/** Deletes the app's device keys (every vault seal and the biometric key): part of deleting the wallet. */
export async function deleteDeviceKeys() {
  if (!hasDeviceKeys() || !N.deleteKeys) return;
  try { await N.deleteKeys(); } catch (_) {}
}
