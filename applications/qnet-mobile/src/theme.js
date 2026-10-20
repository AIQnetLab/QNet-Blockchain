/**
 * The app's one theme (the site's "live ledger" language): every colour, space, size, radius, duration and type role.
 * Component styles read these tokens only. Signal marks what can be acted on or is live; Ember a change or what needs
 * the user. Words are set in Archivo, numbers, addresses and labels in Martian Mono, both bundled (assets/native/fonts).
 */
import { StyleSheet } from 'react-native';

export const color = Object.freeze({
  ink: '#05080A',
  surface: '#0A1013',
  rule: '#1A2529',
  ruleStrong: '#2B3A3F',
  edge: '#56686D',
  fog: '#8D9CA1',
  paper: '#E8F0F0',
  text: 'rgba(232, 240, 240, 0.8)',
  paper70: 'rgba(232, 240, 240, 0.7)',
  signal: '#3CF0DC',
  signalLine: 'rgba(60, 240, 220, 0.55)',
  signalPale: '#B9FFF6',
  ember: '#FFB547',
  mint: '#9BE7A6',
  fillField: 'rgba(232, 240, 240, 0.035)',
  fillFieldFocus: 'rgba(232, 240, 240, 0.055)',
  fillPress: 'rgba(60, 240, 220, 0.06)',
  fillDisabled: 'rgba(232, 240, 240, 0.07)',
  scrim: 'rgba(0, 0, 0, 0.6)',
  qrLight: '#FFFFFF',
  qrDark: '#05080A',
  web: '#FFFFFF',
  camera: '#000000',
  // SOL's own mark (components/TokenIcons), its two ends.
  solFrom: '#9945FF',
  solTo: '#14F195',
  clear: 'transparent',
});

// A palette hex colour at an alpha: a run of text inside a Text takes a colour but no opacity on Android.
export function tint(hex, alpha) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const space = Object.freeze({ gut: 16, gutWide: 24, s4: 4, s8: 8, s12: 12, s16: 16, s24: 24, s32: 32, s48: 48 });
export const size = Object.freeze({
  header: 52, tab: 52, row: 52, rowMin: 44, button: 48, field: 48, column: 640, sheet: 560, bar: 600, request: 520,
  dot: 7,
});
// box: fields and buttons; tile: a token, an address or a node panel, each a rounded element of its own.
export const radius = Object.freeze({ box: 2, dot: 3.5, tile: 14 });
export const motion = Object.freeze({ toggle: 150, sheet: 240, pulse: 2000, curve: [0.2, 0.7, 0.2, 1] });
// The overlays at the wallet screen's root, drawn (Android elevation) in the order they are touched (zIndex): a scan
// under a site's or a link's request, under the prompts and alerts, under the header menu.
export const layer = Object.freeze({
  scan: { zIndex: 8500, elevation: 18 },
  request: { zIndex: 9000, elevation: 20 },
  alert: { zIndex: 9999, elevation: 40 },
  menuScrim: { zIndex: 10000, elevation: 45 },
  menu: { zIndex: 10001, elevation: 50 },
});
// A sheet and a menu are the only things that cast a shadow (iOS; Android orders them by their elevation).
export const shadow = Object.freeze({
  shadowColor: '#000000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
});
// The Signal glow of the head glyph in the live field (components/ui/HexField).
export const glow = Object.freeze({ textShadowColor: color.signal, textShadowRadius: 8, textShadowOffset: { width: 0, height: 0 } });

// The look every sheet shares (components/ui/Sheet, and the wallet screen's dialogs drawn from its stylesheet): the
// overlay that holds the panel at the bottom edge, and the panel.
export const sheet = Object.freeze({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', alignItems: 'center' },
  panel: {
    width: '100%', maxWidth: size.sheet, maxHeight: '86%', backgroundColor: color.surface, borderTopWidth: 1,
    borderTopColor: color.ruleStrong, ...shadow,
  },
});

// The bundled faces, each set by its PostScript name alone (= its file name), never together with a weight.
export const FACES = Object.freeze({
  regular: 'Archivo-Regular',
  semibold: 'Archivo-SemiBold',
  title: 'Archivo-Title',
  data: 'MartianMono-Data',
  label: 'MartianMono-Label',
  figure: 'MartianMono-Figure',
});
// Each mono face's advance in em (every glyph the same), for the estimates that decide whether a figure fits a line.
export const MONO_ADVANCE = Object.freeze({ data: 0.62, label: 0.65, figure: 0.6 });
// The system face's weight standing in for a sans face in a script Archivo does not cover.
const SYSTEM_WEIGHT = Object.freeze({ regular: '400', semibold: '600', title: '700', label: '400' });

// role: [face, size, line height, tracking, uppercase]
const ROLES = Object.freeze({
  label: ['label', 11, 15, 1.3, true],
  act: ['label', 11.5, 16, 1.15, true],
  data: ['data', 13, 18, 0],
  amount: ['data', 15, 20, 0],
  address: ['data', 15, 22, 0],
  figure: ['figure', 40, 44, -1.6],
  note: ['regular', 13, 19, 0],
  body: ['regular', 15, 22, 0],
  field: ['regular', 16, 22, 0],
  row: ['semibold', 16, 22, 0],
  button: ['semibold', 16, 20, 0],
  tab: ['semibold', 12.5, 16, 0],
  wordmark: ['semibold', 17, 20, -0.2],
  h3: ['semibold', 20, 24, -0.2],
  title: ['title', 30, 32, -1],
  display: ['title', 40, 40, -1.6],
});
export const ROLE_NAMES = Object.freeze(Object.keys(ROLES));
const MONO = new Set(['data', 'figure']);

const LATIN = new Set(['en', 'es', 'fr', 'de', 'it', 'pt']);
const CYRILLIC = new Set(['ru']);

/** The script group a language is written in: 'latin' (Archivo covers it), 'cyrillic' (Martian Mono only), 'other'. */
export function scriptOf(lang) {
  if (LATIN.has(lang)) return 'latin';
  if (CYRILLIC.has(lang)) return 'cyrillic';
  return 'other';
}
const GROUP_LANG = Object.freeze({ latin: 'en', cyrillic: 'ru', other: 'ja' });

// The language the screens are drawn in, set while the wallet screen renders (before its effects run), so the first
// frame in a new language already has its faces.
let drawn = 'en';
export function setThemeLanguage(lang) {
  drawn = typeof lang === 'string' ? lang : 'en';
}
export const themeLanguage = () => drawn;

/**
 * The text style of a type role in a language: face, size, line height, tracking. `px` sets another size, the line
 * height following in proportion. Numbers and addresses keep Martian Mono in every script (their content is digits
 * and Latin); a sans role in a script Archivo lacks takes the system face with a weight; labels in such a script are
 * set without capitals or tracking (joining and ideographs need it).
 */
export function type(role, lang = drawn, px) {
  const spec = ROLES[role];
  if (!spec) throw new Error(`unknown type role ${role}`);
  const [face, base, line, track, upper] = spec;
  const fontSize = px || base;
  const style = { fontSize, lineHeight: Math.round((line * fontSize) / base), includeFontPadding: false };
  const group = scriptOf(lang);
  const system = MONO.has(face) ? false : (face === 'label' ? group === 'other' : group !== 'latin');
  if (system) {
    style.fontWeight = SYSTEM_WEIGHT[face];
    style.letterSpacing = group === 'other' || face === 'title' || face === 'label' ? 0 : track;
  } else {
    style.fontFamily = FACES[face];
    style.letterSpacing = track;
    if (upper) style.textTransform = 'uppercase';
  }
  return style;
}

/**
 * A stylesheet drawn once per script group, read through one object: `styles.x` is the entry of the language being
 * drawn. `build(type)` gets `type(role, px)` bound to that group. Read entries while rendering, never at module load.
 */
export function themed(build) {
  const sheets = {};
  const sheet = () => {
    const group = scriptOf(drawn);
    if (!sheets[group]) sheets[group] = StyleSheet.create(build((role, px) => type(role, GROUP_LANG[group], px)));
    return sheets[group];
  };
  return new Proxy({}, {
    get: (_, key) => sheet()[key],
    has: (_, key) => key in sheet(),
    ownKeys: () => Reflect.ownKeys(sheet()),
    getOwnPropertyDescriptor: (_, key) => {
      const d = Object.getOwnPropertyDescriptor(sheet(), key);
      return d && { ...d, configurable: true };
    },
  });
}
