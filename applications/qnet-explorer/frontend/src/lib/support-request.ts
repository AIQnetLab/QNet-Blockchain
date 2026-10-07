// The Support page's device-check request (unified plan DEV-7; docs/protocols/light-node-messages.md section 5.9,
// `ref`): a message to support, written into the visitor's own email app. The page sends nothing itself. The
// message carries only the reference the app shows, which of its messages the app showed and the visitor's note;
// no name, receipt or document is asked for. Pure; shared by the page and the tests.

export const SUPPORT_ADDRESS = 'support@aiqnet.io';
export const NOTE_MAX_CHARS = 500;
const REF_RE = /^[0-9a-f]{8}$/;
// Twelve words in a row of 3 to 8 Latin letters: the shape of a recovery phrase, however it was written down.
const PHRASE_RUN = 12;
const PHRASE_WORD_RE = /^[a-z]{3,8}$/;
const NUMBER_RE = /^[0-9]+$/;
// A list number written against its word ("1abandon").
const NUMBERED_RE = /^[0-9]+([a-z]+)$/;

export const DEVICE_CASES = ['paused', 'cant_run', 'other'] as const;
export type DeviceCase = (typeof DEVICE_CASES)[number];

export const CASE_LABEL: Record<DeviceCase, string> = {
  paused: 'The node is paused on this device',
  cant_run: 'This device can\'t run a node',
  other: 'Something else about the device check',
};

// The reference as the app shows it: 8 hex digits, case and spaces folded; null for anything else.
export function normalizeRef(value: string): string | null {
  const folded = value.replace(/\s+/g, '').toLowerCase();
  return REF_RE.test(folded) ? folded : null;
}

// The note without control characters (line breaks kept), at most NOTE_MAX_CHARS.
export function cleanNote(value: string): string {
  return value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, NOTE_MAX_CHARS);
}

// Whether the text holds what looks like a recovery phrase, which must never be sent to anyone. The words are read
// case-folded and apart from any punctuation or numbering between them (SITE-R1-07): "Abandon, ability, ..." and
// "1. abandon 2. ability ..." count as the plain phrase does. A number between words neither counts nor breaks the
// run; any other word (too short or long, or in another script) breaks it.
export function looksLikePhrase(value: string): boolean {
  let run = 0;
  for (const token of value.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token === '' || NUMBER_RE.test(token)) continue;
    const word = NUMBERED_RE.exec(token)?.[1] ?? token;
    run = PHRASE_WORD_RE.test(word) ? run + 1 : 0;
    if (run >= PHRASE_RUN) return true;
  }
  return false;
}

export type MailResult = { ok: true; href: string } | { ok: false; reason: 'ref' | 'phrase' };

// The mailto: link of the request, or why there is none.
export function deviceCheckMail(input: { ref: string; kind: DeviceCase; note: string }): MailResult {
  const ref = normalizeRef(input.ref);
  if (!ref || !(DEVICE_CASES as readonly string[]).includes(input.kind)) return { ok: false, reason: 'ref' };
  const note = cleanNote(input.note);
  if (looksLikePhrase(note)) return { ok: false, reason: 'phrase' };
  const body = [`Reference: ${ref}`, `${CASE_LABEL[input.kind]}.`, ...(note ? ['', note] : []), '', 'Please review the device check of my node.'].join('\n');
  const subject = `Device check review ${ref}`;
  return { ok: true, href: `mailto:${SUPPORT_ADDRESS}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` };
}
