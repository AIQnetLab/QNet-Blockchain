/**
 * The theme (src/theme.js) is the one source of every colour, face, weight, radius and shadow: component styles read
 * its tokens, never literals; one stylesheet per script group is served through `themed`, switched by the language the
 * wallet screen draws in; no module reads a themed style at load time (it would keep the first language's faces).
 */
import fs from 'fs';
import path from 'path';
import { StyleSheet } from 'react-native';
import { color, layer, radius, setThemeLanguage, shadow, sheet, themed, type } from '../src/theme';

const SRC = path.join(__dirname, '..', 'src');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return files(full);
  return /\.(js|tsx?)$/.test(e.name) ? [full] : [];
});
const rel = (f) => path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/');
// The code of a file without its comments, line by line (a comment may name a colour or a face).
const codeLines = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'));
const UI = files(SRC).filter((f) => !/[\\/]i18n[\\/]locales[\\/]/.test(f) && !f.endsWith(`${path.sep}theme.js`));

describe('the tokens', () => {
  it('every colour of the palette exists, each a hex or rgba value', () => {
    const names = ['ink', 'surface', 'rule', 'ruleStrong', 'edge', 'fog', 'paper', 'text', 'paper70', 'signal', 'signalLine',
      'signalPale', 'ember', 'mint', 'fillField', 'fillFieldFocus', 'fillPress', 'fillDisabled', 'scrim', 'qrLight', 'qrDark', 'web', 'camera'];
    for (const n of names) expect([n, /^(#[0-9A-F]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/.test(color[n])]).toEqual([n, true]);
    expect([color.ink, color.signal, color.ember, color.paper]).toEqual(['#05080A', '#3CF0DC', '#FFB547', '#E8F0F0']);
    expect(radius).toEqual({ box: 2, dot: 3.5, tile: 14 });
  });

  it('the overlays rank the same way in drawing (elevation) and in touch (zIndex)', () => {
    const order = ['scan', 'request', 'alert', 'menuScrim', 'menu'].map((k) => layer[k]);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i].zIndex).toBeGreaterThan(order[i - 1].zIndex);
      expect(order[i].elevation).toBeGreaterThan(order[i - 1].elevation);
    }
    expect(sheet.overlay.justifyContent).toBe('flex-end');
    expect(sheet.panel).toMatchObject({ backgroundColor: color.surface, borderTopColor: color.ruleStrong, maxWidth: 560 });
  });
});

describe('no literal outside the theme', () => {
  it('no colour, face, weight, radius above 2 or shadow is written in any other source file', () => {
    const found = [];
    for (const f of UI) {
      codeLines(fs.readFileSync(f, 'utf8')).forEach((line, i) => {
        const at = `${rel(f)}:${i + 1}`;
        if (/['"`]#[0-9a-fA-F]{3,8}['"`]/.test(line)) found.push(`${at} hex colour`);
        if (/\b(rgba?|hsla?)\(/.test(line)) found.push(`${at} colour function`);
        if (/[:=]\s*['"](white|black|transparent|red|green|blue|gray|grey)['"]/.test(line)) found.push(`${at} named colour`);
        if (/\b(fontFamily|fontWeight)\s*:/.test(line)) found.push(`${at} face or weight`);
        const r = /\bborderRadius\s*:\s*(\d+(?:\.\d+)?)/.exec(line);
        if (r && Number(r[1]) > radius.box) found.push(`${at} radius ${r[1]}`);
        if (/\bshadow(Color|Opacity|Radius|Offset)\s*:/.test(line)) found.push(`${at} shadow`);
      });
    }
    expect(found).toEqual([]);
  });

  it('only a sheet and the menus cast a shadow', () => {
    const casting = UI.filter((f) => /\.\.\.shadow\b/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    // Both More menus (the header's and the browser's) are the one Menu component, its card the one shadow.
    expect(casting).toEqual(['src/components/ui/Menu.js']);
    const menu = fs.readFileSync(path.join(SRC, 'components', 'ui', 'Menu.js'), 'utf8');
    expect(menu.match(/\.\.\.shadow\b/g)).toHaveLength(1);
    expect(menu.slice(menu.indexOf('  card: {'), menu.indexOf('  cardRoot:'))).toMatch(/\.\.\.shadow/);
    expect(shadow).toMatchObject({ shadowOpacity: 0.5, shadowRadius: 24 });
  });

  it('no module reads a themed style while it loads', () => {
    // A read at module level outside a function (a function's body runs while rendering, after the language is set).
    const topLevelReads = (text) => codeLines(text).map((line, i) => {
      if (/^\s/.test(line) || /^(import|export \{|export default styles;|export const \w+ = (s|styles);)/.test(line)) return null;
      const head = line.includes('=>') ? line.slice(0, line.indexOf('=>')) : line;
      return /\b(styles|s)\.[A-Za-z_]/.test(head) ? i + 1 : null;
    }).filter(Boolean);
    expect(topLevelReads(['const s = themed(build);', 'const TITLE = s.title;', 'const f = (x) => s.title;'].join('\n'))).toEqual([2]);
    const found = [];
    for (const f of UI) {
      const text = fs.readFileSync(f, 'utf8');
      const themedHere = /=\s*themed\(/.test(text) || /import styles from '[./]*(screens\/)?WalletScreen\.styles'/.test(text);
      if (themedHere) for (const line of topLevelReads(text)) found.push(`${rel(f)}:${line}`);
    }
    expect(found).toEqual([]);
  });
});

describe('one stylesheet per script group', () => {
  afterEach(() => setThemeLanguage('en'));

  it('a themed entry follows the language being drawn, each group drawn once', () => {
    const build = jest.fn((t) => ({ title: { ...t('title'), color: color.paper } }));
    const st = themed(build);
    setThemeLanguage('en');
    const en = st.title;
    expect(en).toMatchObject({ fontFamily: 'Archivo-Title', fontSize: 30, color: color.paper });
    setThemeLanguage('ru');
    expect(st.title.fontFamily).toBeUndefined();
    expect(st.title.fontWeight).toBe('700');
    setThemeLanguage('de');
    expect(st.title).toBe(en);
    setThemeLanguage('ko');
    expect(st.title).toMatchObject({ fontWeight: '700', letterSpacing: 0 });
    expect(build).toHaveBeenCalledTimes(3);
    expect(StyleSheet.flatten([st.title])).toEqual(st.title);
    expect(Object.keys(st)).toEqual(['title']);
  });

  it('the wallet screen sets the language being drawn while it renders, before its effects run', () => {
    const src = fs.readFileSync(path.join(SRC, 'screens', 'WalletScreen.js'), 'utf8');
    expect(src).toMatch(/const t = useMemo\(\(\) => \{ setThemeLanguage\(language\); return makeT\(language\); \}, \[language\]\);/);
    expect(type('row', 'en').fontFamily).toBe('Archivo-SemiBold');
  });
});
