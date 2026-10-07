/**
 * Which QRC-20 rows the Assets list shows, and which it marks (MOBNET-R2-08). Anyone can deploy a token, name it
 * after QNC and send it to every wallet; its balance proves like any other, so a proof alone lends it the look of
 * the native coin. A token this wallet did not add is not shown until the user shows it (Manage tokens), a token
 * whose symbol or name is QNet's own is marked as not QNC, and every row carries its contract id.
 */
import { CANONICAL_BURN_ADDRESS } from '../crypto/TxBuilders';
import { hasHiddenCharacter } from '../crypto/OffchainMessage';

// The native coin's names, compared after the look-alike skeleton below, NFKD (which also parts an accent from its
// letter), the skeleton again, case folding and removal of everything that is not a letter or a digit (the accents
// too), so 'Q N C', 'ＱＮＣ', 'qnc.', 'QNet Coin', 'QNС' (Cyrillic Es), 'QΝC' (Greek Nu), 'QNϹ' (lunate sigma), 'QNᴄ'
// (small capital C), 'QNĊ' (C with a dot) and '🅠🅝🅒' all match.
const RESERVED = ['qnc', 'qnet'];

// Letters a reader takes for Latin ones (the Latin, Cyrillic and Greek part of Unicode TR39's confusables, and the
// small capitals, letterlike symbols and other scripts' letters that read as the letters of QNC and QNet): NFKD keeps
// them distinct, or makes them into letters this map would not know ('Ϲ' into 'Σ'), so a name spelled with them would
// pass as another word (MOBNET-R3-08). The skeleton runs before NFKD and after it.
const CONFUSABLE_LATIN = {
  // Cyrillic
  'а': 'a', 'А': 'a', 'в': 'b', 'В': 'b', 'е': 'e', 'Е': 'e', 'ё': 'e', 'Ё': 'e', 'к': 'k', 'К': 'k', 'м': 'm', 'М': 'm',
  'н': 'h', 'Н': 'h', 'о': 'o', 'О': 'o', 'р': 'p', 'Р': 'p', 'с': 'c', 'С': 'c', 'т': 't', 'Т': 't', 'у': 'y',
  'У': 'y', 'х': 'x', 'Х': 'x', 'і': 'i', 'І': 'i', 'ї': 'i', 'Ї': 'i', 'ј': 'j', 'Ј': 'j', 'ѕ': 's', 'Ѕ': 's',
  'ԛ': 'q', 'Ԛ': 'q', 'ԝ': 'w', 'Ԝ': 'w', 'һ': 'h', 'Һ': 'h', 'ӏ': 'l', 'Ӏ': 'l', 'ո': 'n', 'п': 'n', 'Ԁ': 'd',
  'ԁ': 'd', 'ɡ': 'g',
  // Greek
  'Α': 'a', 'α': 'a', 'Β': 'b', 'Ε': 'e', 'Ζ': 'z', 'Η': 'h', 'η': 'n', 'Ι': 'i', 'ι': 'i', 'Κ': 'k', 'κ': 'k',
  'Μ': 'm', 'Ν': 'n', 'ν': 'v', 'Ο': 'o', 'ο': 'o', 'Ρ': 'p', 'ρ': 'p', 'Τ': 't', 'τ': 't', 'Υ': 'y', 'υ': 'u',
  'Χ': 'x', 'χ': 'x', 'ϲ': 'c', 'Ϲ': 'c', 'ϙ': 'q', 'Ϙ': 'q', 'ϳ': 'j', 'ϒ': 'y', 'ε': 'e', 'ϵ': 'e',
  // Coptic Sima, the lunate sigma's shape
  'Ⲥ': 'c', 'ⲥ': 'c',
  // Small capitals Q, N, C, E, T ('ᶰ' becomes 'ɴ' under NFKD) and the open E ('ℇ' becomes 'Ɛ')
  'ꞯ': 'q', 'ɴ': 'n', 'ᴄ': 'c', 'ᴇ': 'e', 'ᴛ': 't', 'Ɛ': 'e', 'ɛ': 'e',
  // Letterlike symbols NFKD keeps: the estimated sign and the Euler constant
  '℮': 'e', 'ℇ': 'e',
  // Armenian Za, Lisu, Cherokee and the Ukrainian Ie
  'զ': 'q', 'ꓠ': 'n', 'ꓚ': 'c', 'ꓰ': 'e', 'ꓔ': 't', 'Ꮯ': 'c', 'ꮯ': 'c', 'Ꭼ': 'e', 'ꭼ': 'e', 'Ꭲ': 't', 'ꭲ': 't',
  'Є': 'e', 'є': 'e',
};

// Negative circled and negative squared capitals and the regional indicators: A to Z in a box or a circle, which NFKD
// keeps (the plain circled and squared ones it makes letters).
const ENCLOSED_A = [0x1f150, 0x1f170, 0x1f1e6];

function enclosedLetter(ch) {
  const cp = ch.codePointAt(0);
  const a = ENCLOSED_A.find((first) => cp >= first && cp < first + 26);
  return a === undefined ? null : String.fromCharCode(0x61 + cp - a);
}

const skeleton = (s) => Array.from(s, (ch) => CONFUSABLE_LATIN[ch] || enclosedLetter(ch) || ch).join('');

function folded(text) {
  let s = skeleton(typeof text === 'string' ? text : '');
  try { s = s.normalize('NFKD'); } catch (_) { /* compare as typed */ }
  s = skeleton(s);
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// What tokenLabel puts in place of a hidden character.
const REPLACEMENT = '�';
const hidesSomething = (text) => typeof text === 'string' && (hasHiddenCharacter(text) || text.includes(REPLACEMENT));

/**
 * Whether a token's symbol or name is the native coin's (QNC, QNet), in any spelling a reader takes for it. A symbol or
 * name with a hidden or format character (a direction override, a zero-width mark) is treated as one: such a character
 * can reorder or hide what is shown, so "‮CNQ" reads as QNC, and no honest token needs one. So is one with U+FFFD, the
 * mark tokenLabel leaves in its place, so a label already made safe keeps its warning.
 */
export function usesReservedName(symbol, name) {
  if (hidesSomething(symbol) || hidesSomething(name)) return true;
  const s = folded(symbol);
  const n = folded(name);
  return RESERVED.some((r) => s.includes(r) || n.includes(r));
}

/**
 * A token's symbol or name as shown: every hidden or format character replaced by U+FFFD, so none can reorder it. Every
 * screen that writes a token's symbol or name writes it through this.
 */
export function tokenLabel(text) {
  if (typeof text !== 'string') return '';
  return Array.from(text, (ch) => (hasHiddenCharacter(ch) ? REPLACEMENT : ch)).join('');
}

/** Whether tokens sent to `address` are destroyed: the chain's canonical burn address, which no key controls. */
export const destroysTokens = (address) => address === CANONICAL_BURN_ADDRESS;

/** "1a2b3c…9f0e": the contract id every token row shows. */
export function contractShortId(contract) {
  const c = typeof contract === 'string' ? contract : '';
  return c.length > 12 ? `${c.slice(0, 6)}…${c.slice(-4)}` : c;
}

/**
 * Whether a token row is on the Assets list: hidden by the user never; one the user added (custom tokens) or chose
 * to show (shown) yes; any other holding (sent to this wallet unasked) no, until the user shows it.
 */
export function tokenVisible(contract, { hidden, added, shown }) {
  if (!contract || (hidden && hidden.has(contract))) return false;
  return !!((added && added.has(contract)) || (shown && shown.has(contract)));
}
