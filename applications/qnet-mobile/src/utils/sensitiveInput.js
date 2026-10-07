import { Platform } from 'react-native';

// TextInput props for anything secret typed into the wallet: no autocorrect, no spell check (which can
// leave the device), no autofill, no suggestions a keyboard could learn and offer elsewhere. The native
// side also sets IME_FLAG_NO_PERSONALIZED_LEARNING on fields focused while a secret screen is shown.
const base = {
  autoCorrect: false,
  spellCheck: false,
  autoComplete: 'off',
  importantForAutofill: 'no',
  textContentType: 'none',
  autoCapitalize: 'none',
  contextMenuHidden: false,
};

/**
 * The recovery-phrase field's native id (MPLAT-R3-01). Natively the field keeps Paste and selection only: nothing
 * that exports its text (Copy, Cut, Share, Look Up, Translate, PROCESS_TEXT actions) is offered, and a paste into it
 * takes the phrase off the clipboard at once. Android: SecurityModule (setSeedFieldGuard) finds the field by its
 * nativeID. iOS: the react-native patch reads it from testID, which becomes the text view's accessibilityIdentifier.
 */
export const SEED_FIELD_ID = 'qnet-seed-input';

/** Passwords (masked). */
export const PASSWORD_INPUT_PROPS = { ...base, secureTextEntry: true };

/** The recovery phrase: visible-password on Android turns off suggestions and learning in most keyboards. */
export const SEED_INPUT_PROPS = {
  ...base,
  keyboardType: Platform.OS === 'android' ? 'visible-password' : 'default',
  nativeID: SEED_FIELD_ID,
  testID: SEED_FIELD_ID,
};

/** Typed confirmations such as ERASE. */
export const CONFIRM_INPUT_PROPS = { ...base, autoCapitalize: 'characters' };

/** The text one change inserted: the part of `next` between the prefix and the suffix it shares with `prev`. */
export function insertedText(prev, next) {
  const a = String(prev || '');
  const b = String(next || '');
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return b.slice(p, b.length - s);
}

/**
 * Whether one change looks like text that arrived at once — a paste, a keyboard's clipboard chip — rather than typing
 * (MPLAT-R3-01). Typing puts one character per change into these fields (no autocorrect, no suggestions), so anything
 * that inserted two or more words, or four or more characters in one go, is taken for a paste: a Select All and Paste
 * over a phrase already in the field counts too, since the words that differ arrive together. A word typed by swiping
 * counts as well, which only costs clearing a clipboard that held nothing of the phrase.
 */
export function looksPasted(prev, next) {
  const inserted = insertedText(prev, next).trim();
  return inserted.length >= 4 || /\S\s+\S/.test(inserted);
}
