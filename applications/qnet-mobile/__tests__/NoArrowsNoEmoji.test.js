// Owner, 19.10: no arrow on any link, button, row or action, and no emoji or decorative glyph on any screen. What a
// control does is said in words (Back, More, Close, Scan); a warning is a line in Ember, never a sign before it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const list = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = `${dir}/${e.name}`;
  if (e.isDirectory()) return list(rel);
  return e.name.endsWith('.js') ? [rel] : [];
});
const FILES = ['src/screens', 'src/components', 'src/browser', 'src/i18n/locales'].flatMap(list);

// The code of a file without its comments (a URL's // and a string's // stay); CRLF checkouts split the same way.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
  .split(/\r?\n/).map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'));

const ARROWS = /[→←↗↓›‹⋮✕⚠❌]/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
// The live password lines keep their tick and cross (U+2713, U+00D7): a state said with the words beside it.
const KEPT = /[✓]/g;

describe('no arrows and no emoji in what the app shows', () => {
  it('reads the screens, the components, the browser and every language', () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES).toEqual(expect.arrayContaining(['src/screens/WalletScreen.js', 'src/i18n/locales/ar.js', 'src/browser/BrowserScreen.js']));
  });

  it('no arrow glyph, no dots menu, no cross or warning sign, and no emoji outside comments', () => {
    const found = [];
    for (const file of FILES) {
      code(fs.readFileSync(path.join(ROOT, file), 'utf8')).forEach((line, i) => {
        const bare = line.replace(KEPT, '');
        if (ARROWS.test(bare) || EMOJI.test(bare)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('Back is a word: no arrow is built for it anywhere', () => {
    for (const file of list('src')) expect([file, /backArrow/.test(fs.readFileSync(path.join(ROOT, file), 'utf8'))]).toEqual([file, false]);
  });
});
