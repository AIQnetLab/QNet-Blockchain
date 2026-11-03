// The site's foundation: one set of tokens, squared controls, no blur over the moving field, layouts
// that nothing moves (device decided at first paint, fixed table geometry, labels that keep their width), and the
// header's one account control with My node's rows. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { accountRows, nodeOnline, BALANCE_HREF } from '../account-menu.ts';
import { AMOUNT_W, FROM_TO_MIN, amountChars, amountLength, amountWidth, readoutLength, steadyWidth, textLength, wordsWidth } from '../geometry.ts';
import { ageForms, txCountText } from '../explorer-view.ts';
import { LOCALES } from '../languages.ts';
import { span } from '../format.ts';
import { translator } from '../texts.ts';
import { CATALOGS } from '../../i18n/catalogs.ts';
import { TAB_HREF } from '../cabinet/tabs.ts';
import { EN, TEXTS, english } from './texts-helper.mjs';
import { SRC, code, cssRules, read, sourceFiles } from './source.mjs';

const STYLES = readdirSync(new URL('styles/', SRC)).filter((n) => n.endsWith('.css'));
const token = (name) => read('styles/tokens.css').match(new RegExp(`^\\s*${name}: ([^;]+);`, 'm'))?.[1];

// A value set smaller by its length (.ro-v, .cab-figure) as the sheets draw it in a language: Martian Mono at 75 % width
// and weight 300 advances .6 em a character (measured in the browser) plus the rule's letter spacing, which i18n.css
// resets in some scripts; the size rule counts --ro-ch em a character (tokens.css, raised by i18n.css where the spacing is
// reset); an amount's icon is 1.25 times the text inside a value, never under 20 px elsewhere.
const langsIn = (selector) => [...selector.matchAll(/:lang\(([\w-]+)\)/g)].map((m) => m[1]);
function valueFace(locale, rule) {
  const i18n = read('styles/i18n.css');
  const reset = i18n.match(/\n:root:is\(([^{]*)\) \* \{ letter-spacing: normal !important; \}/);
  const raised = i18n.match(/\n:root:is\(([^{]*)\) \{ --ro-ch: ([\d.]+); \}/);
  const spacing = reset && langsIn(reset[1]).includes(locale) ? 0 : Number(/letter-spacing: (-?[\d.]+)em/.exec(rule)?.[1] ?? 0);
  const ch = raised && langsIn(raised[1]).includes(locale) ? Number(raised[2]) : Number(token('--ro-ch'));
  const scaled = /\n:is\(\.ro-v, \.cab-figure\) \.tok-text \{ width: 1\.25em; height: 1\.25em; \}/.test(read('styles/base.css'));
  return { advance: 0.6 + spacing, ch, icon: (size) => (scaled ? 1.25 * size : Math.max(20, 1.25 * size)) };
}

test('every token of the spec is defined once, in tokens.css, imported first', () => {
  const tokens = read('styles/tokens.css');
  const spec = {
    '--ink': '#05080A', '--surface': '#0A1013', '--rule': '#1A2529', '--rule-strong': '#2B3A3F', '--edge': '#56686D', '--edge-hover': '#6A7C81',
    '--fog': '#8D9CA1', '--paper': '#E8F0F0', '--text': 'rgb(232 240 240 / .8)', '--signal': '#3CF0DC', '--signal-line': 'rgb(60 240 220 / .55)',
    '--ember': '#FFB547', '--mint': '#9BE7A6', '--lilac': '#C7B8FF', '--fill-field': 'rgb(232 240 240 / .035)', '--fill-row': 'rgb(232 240 240 / .03)',
    '--fill-signal': 'rgb(60 240 220 / .06)', '--fill-disabled': 'rgb(232 240 240 / .07)', '--ember-tint': 'color-mix(in srgb, var(--ember) 11%, var(--ink))',
    '--scrim': 'rgb(0 0 0 / .6)', '--shadow-menu': '0 24px 48px rgb(0 0 0 / .5)', '--maxw': '1360px', '--gut': 'clamp(16px, 4vw, 56px)',
    '--hdr': '64px', '--bar': '64px', '--row': '44px', '--row-2': '60px', '--radius': '2px', '--focus': '2px solid var(--signal)',
    '--ease-out': 'cubic-bezier(.2, .7, .2, 1)',
  };
  for (const [name, value] of Object.entries(spec)) assert.equal(token(name), value, name);
  assert.match(tokens, /color-scheme: dark;/);
  const layout = code('app/layout.tsx');
  assert.ok(layout.indexOf("import '@/styles/tokens.css';") < layout.indexOf("import '@/styles/base.css';"));
  assert.ok(layout.indexOf("import '@/styles/base.css';") < layout.indexOf("import '@/styles/shell.css';"));
  // Every sheet the site has is one of src/styles, imported by the root layout: none from before the rebuild is left.
  const imported = [...layout.matchAll(/^import '@\/styles\/([\w-]+\.css)';$/gm)].map((m) => m[1]);
  assert.deepEqual([...imported].sort(), STYLES.filter((n) => n !== 'fonts.css').sort());
  assert.doesNotMatch(layout, /import '\.\/[\w-]+\.css';/);
  assert.deepEqual(readdirSync(new URL('app/', SRC)).filter((n) => n.endsWith('.css')), []);
});

// Every class a sheet of the site defines is one the site's code sets: a class that matches nothing is dead weight that
// the next reader takes for a rule in force. The code's classes are the words of its string and template literals, read
// with the compiler (an apostrophe in a comment never shifts them); a literal that ends a template's head with "-" (own-
// ${store}) names every class it begins.
test('every class the site\'s stylesheets define is set by the site\'s code', () => {
  const ts = createRequire(import.meta.url)('typescript');
  const words = new Set();
  const heads = [];
  // The catalogs' texts are words for people, never class names.
  for (const file of sourceFiles().filter((f) => !f.startsWith('i18n/locales/'))) {
    const text = read(file);
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const parts = node.text.split(/[\s,()[\]{}=<>]+/).filter(Boolean);
        for (const word of parts) words.add(word);
        const last = parts[parts.length - 1];
        if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) && last?.endsWith('-') && !/\s$/.test(node.text)) heads.push(last);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const named = (cls) => words.has(cls) || heads.some((head) => cls.startsWith(head));
  let classes = 0;
  // Every stylesheet under src, wherever it sits.
  const sheets = readdirSync(SRC, { recursive: true }).map((n) => n.replace(/\\/g, '/')).filter((n) => n.endsWith('.css'));
  for (const name of sheets) {
    const css = read(name).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [selector] of cssRules(css)) {
      if (selector.startsWith('@') || /^(?:from|to|\d+%)/.test(selector)) continue;
      for (const [, cls] of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        classes++;
        assert.ok(named(cls), `${name}: .${cls} is set by no code`);
      }
    }
  }
  assert.ok(classes > 1000, `${classes} classes read`);
});

// A module nothing imports is dead: every module under components/, hooks/, lib/, server/ and i18n/ is imported by the
// site's code or its scripts (a test is no importer).
test('every module of the site is imported by its code or its scripts', () => {
  const scripts = readdirSync(new URL('../scripts/', SRC)).filter((n) => n.endsWith('.mjs')).map((n) => `../scripts/${n}`);
  const imported = new Set();
  for (const file of [...sourceFiles(), ...scripts]) {
    for (const [, spec] of read(file).matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const path = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), spec)) : null;
      if (path) imported.add(path.replace(/^\.\.\/src\//, '').replace(/\.(ts|tsx|mjs)$/, ''));
    }
  }
  const modules = sourceFiles().filter((f) => /^(components|hooks|lib|server|i18n)\//.test(f));
  assert.ok(modules.length > 200, `${modules.length} modules`);
  assert.deepEqual(modules.filter((f) => !imported.has(f.replace(/\.(ts|tsx)$/, ''))), []);
});

test('the rebuilt sheets: tokens only, the one 2 px radius, no blur, no glow', () => {
  for (const name of STYLES.filter((n) => n !== 'tokens.css')) {
    const css = read(`styles/${name}`).replace(/\/\*[\s\S]*?\*\//g, '');
    // Colours come from the tokens (a mask's colour only sets its opacity, and uses a token too).
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, name);
    // 0: a corner squared against its neighbour (Search inside the search group, whose own corners are the 2 px ones).
    for (const m of css.matchAll(/border-radius: ([^;]+);/g)) assert.ok(['var(--radius)', '50%', '0'].includes(m[1].trim()), `${name}: ${m[1]}`);
    assert.doesNotMatch(css, /backdrop-filter/, name);
    assert.doesNotMatch(css, /box-shadow: 0 0 \d+px var\(--signal/, name);
  }
});

// Every box the site's sheets fix to the screen or stick while the page scrolls, by what may pass under it: a bar over
// the page is opaque, so no text shows through it (My node's bar on a phone did). A new one fails until it is listed.
test('nothing shows through a pinned box: every bar fixed or stuck over the page is an opaque surface, a flash included', () => {
  // Opaque: a six-digit colour, or a mix of two opaque ones, through as many tokens as it takes.
  const opaque = (value) => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (ref) return opaque(token(ref[1]) ?? '');
    const mix = /^color-mix\(in srgb, (var\(--[\w-]+\)) \d+%, (var\(--[\w-]+\))\)$/.exec(value);
    if (mix) return opaque(mix[1]) && opaque(mix[2]);
    return /^#[0-9A-Fa-f]{6}$/.test(value);
  };
  const rules = STYLES.map((n) => `styles/${n}`).flatMap((file) =>
    cssRules(read(file)).map(([sel, body]) => ({ file, sel, parts: sel.split(',').map((p) => p.trim()), body })));
  const backgrounds = (rule) => [...rule.body.matchAll(/background(?:-color)?: ([^;]+);/g)].map((m) => m[1].trim());
  // The rules naming a box itself, or the box in a state of its own (only [attribute] selectors added).
  const named = (sel, states) => rules.filter((r) => r.parts.some((p) => sel.split(', ').some((q) =>
    (states ? p.startsWith(`${q}[`) && /^(\[[^\]]*\])+$/.test(p.slice(q.length)) : p === q))));
  const kinds = {
    // Over the title band drawn for it at the top of a page; Ink once the page scrolls or the menu opens.
    '.hdr': 'band',
    // The dim behind the phone's account sheet: the page is meant to show under it.
    '.acct-scrim': 'scrim',
    '.nav': 'surface',
    '.acct-menu, .acct:not([data-open]) .acct-menu': 'surface',
    '.cab-nav': 'surface',
    '.tbl th': 'surface',
    ".tbl-frame[data-scroll='true'] .tbl th:first-child, .tbl-frame[data-scroll='true'] .tbl td:first-child": 'surface',
    // In a column of their own, or the only cell of their row: nothing passes under them.
    '.cab-side': 'own',
    '.mf-head': 'own',
    '.doc-aside': 'own',
    ".tbl-frame[data-scroll='true'] .tbl-detail-in": 'own',
    '.cab-epochs .tbl-detail-in': 'own',
  };
  const pinned = rules.filter((r) => /position:\s*(fixed|sticky)/.test(r.body));
  assert.deepEqual(pinned.map((r) => r.sel).sort(), Object.keys(kinds).sort());
  for (const pin of pinned) {
    if (kinds[pin.sel] === 'surface') {
      const bgs = [...named(pin.sel, false), ...named(pin.sel, true)].flatMap(backgrounds);
      assert.ok(bgs.length > 0 && bgs.every(opaque), `${pin.file} ${pin.sel}: ${bgs.join(' | ')}`);
    } else if (kinds[pin.sel] === 'band') {
      assert.deepEqual(backgrounds(pin), ['transparent']);
      const states = named(pin.sel, true).flatMap(backgrounds);
      assert.ok(states.length === 2 && states.every(opaque), states.join(' | '));
    }
  }
  // A flash paints the cells it lands on, a pinned first cell among them: only opaque colours, easing to each cell's own.
  const flash = rules.filter((r) => /^(from|to|\d+%)(, *(from|to|\d+%))*$/.test(r.sel)).flatMap(backgrounds);
  assert.ok(flash.length > 0 && flash.every(opaque), flash.join(' | '));
});

test('nothing jumps: the device at first paint, fixed table geometry, labels that keep their width, menus that shift nothing', () => {
  const layout = code('app/layout.tsx');
  assert.match(layout, /const device = installTarget\(request\.get\('user-agent'\)\);/);
  assert.match(layout, /<html lang=\{locale\} dir=\{dir\} data-device=\{device\}/);
  // The theme sets data-theme, not the class list that carries the font variables.
  assert.match(layout, /attribute="data-theme"/);
  const base = read('styles/base.css');
  assert.match(base, /\.tbl \{\n {2}width: 100%; table-layout: fixed;/);
  assert.match(base, /\.tbl td \{ height: var\(--row\);[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
  assert.match(base, /\.tbl tr\[data-h='2'\] td \{ height: var\(--row-2\); \}/);
  assert.match(base, /\.swap \{ display: inline-grid; \}\n\.swap > \* \{ grid-area: 1 \/ 1; \}/);
  const table = code('components/ui/DataTable.tsx');
  assert.match(table, /<colgroup>\s*\{columns\.map\(\(c\) => <col key=\{c\.key\} style=\{c\.width \? \{ width: c\.width \} : undefined\} \/>\)\}/);
  // A live table holds new rows while the pointer or focus is inside it; loading rows have the final height.
  assert.match(table, /const shown = live \? hold\.shown : rows;/);
  assert.match(table, /\{\.\.\.\(live \? hold\.handlers : \{\}\)\}/);
  assert.match(table, /<tr key=\{`pad-\$\{i\}`\} className="tbl-pad" data-h=\{tall \? 2 : undefined\} aria-hidden="true">/);
  // A new value shows unless the list is held (src/lib/hold.ts; the touch hold has its own test below).
  const hold = code('components/ui/useHold.ts');
  assert.match(hold, /useEffect\(\(\) => \{ release\(\); \}, \[latest, release\]\);/);
  assert.match(hold, /const release = useCallback\(\(\) => \{\n\s*if \(held\(state\.current, Date\.now\(\)\)\) return;/);
  // The pages shown only after wallet detection are laid out from the start, painted once known.
  assert.match(code('components/InAppGuard.tsx'), /const PENDING = \{ display: 'contents', visibility: 'hidden' \} as const;/);
  // The header's right slot is pushed right, so the links never move when Connect wallet becomes the account.
  assert.match(read('styles/shell.css'), /\.hdr-acct \{ margin-inline-start: auto; flex: none; \}/);
  assert.match(read('styles/shell.css'), /\.nav\[data-pending\] \{ visibility: hidden; \}/);
  // The footer's row keeps its height in the app's view; the home readouts keep two lines under each value.
  assert.match(read('styles/home.css'), /\.hero-ro \{[^}]*--ro-sub-lines: 2;/);
  assert.match(base, /\.ro-s \{ margin: 0; min-height: calc\(1\.4em \* var\(--ro-sub-lines, 1\)\);/);
  // The live column is a window of fixed height that rows fill from the top.
  assert.match(read('styles/home.css'), /\.stream-view \{\n {2}height: 460px; overflow: hidden;/);
});

// Nothing jumps and everything stays clickable: with a block a second, a list that moved between aiming at a row and
// tapping it would open the next block, so a touch holds a live list from the press until 3 s after the last touch or scroll there, and the list says how many rows wait.
test('a touch holds a live list from the press until 3 s after the last touch or scroll, and the list says how many rows wait', async () => {
  const { IDLE, TOUCH_HOLD_MS, held, touched, heldBack, heldText } = await import('../hold.ts');
  assert.equal(TOUCH_HOLD_MS, 3000);
  assert.equal(held(IDLE, 0), false);
  // The press holds while the finger is down; letting go holds 3 s more; a scroll in that time moves the end on.
  const pressed = touched({ ...IDLE, pressed: true }, 1000);
  assert.equal(held(pressed, 60_000), true);
  const up = touched({ ...pressed, pressed: false }, 1500);
  assert.equal(held(up, 4499), true);
  assert.equal(held(up, 4500), false);
  const scrolled = touched(up, 4000);
  assert.equal(scrolled.touchUntil, 7000);
  assert.equal(touched(scrolled, 2000).touchUntil, 7000, 'an earlier touch never shortens the hold');
  // A mouse or pen over the list and focus inside it hold while they last.
  assert.equal(held({ ...IDLE, pointer: true }, 1e12), true);
  assert.equal(held({ ...IDLE, focus: true }, 1e12), true);
  // What waits: the latest rows the list does not show; a floor once none of the shown rows is left.
  const key = (b) => String(b.height);
  const rows = (top, n) => Array.from({ length: n }, (_, i) => ({ height: top - i }));
  assert.deepEqual(heldBack(rows(100, 6), rows(103, 6), key), { count: 3, more: false });
  assert.deepEqual(heldBack(rows(100, 6), rows(120, 6), key), { count: 6, more: true });
  const same = rows(100, 6);
  assert.deepEqual(heldBack(same, same, key), { count: 0, more: false });
  assert.deepEqual(heldBack(rows(100, 6), rows(100, 6), key), { count: 0, more: false });
  assert.deepEqual(heldBack(null, rows(100, 6), key), { count: 0, more: false });
  assert.equal(heldText({ count: 3, more: false }, true, EN), '3 new');
  assert.equal(heldText({ count: 1200, more: true }, false, EN), '1,200+ new');
  assert.equal(heldText({ count: 0, more: false }, true, EN), 'Paused');
  assert.equal(heldText({ count: 0, more: false }, false, EN), 'Paused while you point at it');
  // The hook: a touch press, release and cancel hold; a finger is no hover; after a touch, a scroll of the page or of the
  // list's frame while the list is on screen holds it; a list that is not live listens to nothing.
  const hook = code('components/ui/useHold.ts');
  for (const name of ['onPointerDown', 'onPointerUp', 'onPointerCancel']) {
    const pressed = name === 'onPointerDown' ? 'true' : 'false';
    assert.match(hook, new RegExp(String.raw`${name}: \(e\) => \{\n\s*if \(e\.pointerType !== 'touch'\) return;\n\s*state\.current = \{ \.\.\.state\.current, pressed: ${pressed} \};\n\s*touchHold\(\);`), name);
  }
  assert.match(hook, /onPointerEnter: \(e\) => \{\s*if \(e\.pointerType === 'touch'\) return;/);
  assert.match(hook, /window\.addEventListener\('pointerdown', \(e\) => \{ touchPage = e\.pointerType === 'touch'; \}, \{ capture: true, passive: true \}\);/);
  assert.match(hook, /const onScroll = \(\) => \{ if \(touchPage && visible\) touchHold\(\); \};\n\s*window\.addEventListener\('scroll', onScroll, \{ passive: true \}\);\n\s*el\.addEventListener\('scroll', onScroll, \{ passive: true \}\);/);
  assert.match(hook, /if \(!el \|\| !on\) return;/);
  assert.match(hook, /const back = holding \? heldBack\(shown, latest, key\) : \{ count: 0, more: false \};/);
  // Every live list holds with its own element, and one label says what waits; its words share one cell (rule 3.7), and
  // a phone, which has no pointer to hover, keeps only the width of the words a touch can show.
  const table = code('components/ui/DataTable.tsx');
  assert.match(table, /const hold = useHold\(rows, frame, rowKey, live\);/);
  assert.match(table, /<span className="label tbl-live"><HoldLabel hold=\{hold\} \/><\/span>/);
  const label = code('components/ui/Status.tsx');
  assert.match(label, /<span data-on=\{!said\}>\{idle \?\? t\('live'\)\}<\/span>\s*<span data-on=\{said === POINTING\} data-k="point">\{POINTING\}<\/span>\s*<span data-on=\{!!said && said !== POINTING\}>\{said && said !== POINTING \? said : ' '\}<\/span>/);
  assert.match(read('styles/base.css'), /@media \(max-width: 720px\) \{\n\s*\.swap > \[data-k='point'\] \{ display: none; \}/);
  // The block lists (the home page's column and the explorer's strip) hold through the one hook, with their own frame.
  assert.match(code('components/explorer/useRecentBlocks.ts'), /const hold = useHold\(blocks, box, blockKey\);/);
  assert.match(code('app/HomeClient.tsx'), /<HoldLabel hold=\{hold\} idle=\{t\('home_live_blocks'\)\} \/>/);
  assert.equal(TEXTS.home_live_blocks, 'Live blocks');
  const strip = code('components/explorer/LatestBlocks.tsx');
  assert.match(strip, /const \{ shown, hold, near, landed \} = useLiveBlocks\(seed, RECENT_BLOCKS, view, list\);/);
  assert.match(strip, /<span className="label tbl-live"><HoldLabel hold=\{hold\} \/><\/span>/);
  // The strip's own handlers start with the hook's, so a finger's press still holds it while a mouse drags it.
  assert.match(strip, /const onPointerDown = \(e: PointerEvent<HTMLDivElement>\) => \{\n\s*hold\.handlers\.onPointerDown\(e\);/);
  assert.match(strip, /const onPointerUp = \(e: PointerEvent<HTMLDivElement>\) => \{\n\s*hold\.handlers\.onPointerUp\(e\);/);
  assert.match(strip, /\{\.\.\.hold\.handlers\}\n\s*onPointerDown=\{onPointerDown\}\n\s*onPointerMove=\{onPointerMove\}\n\s*onPointerUp=\{onPointerUp\}/);
});

// next/font's stand-in matches Archivo and Martian Mono at their normal width only, while the sheets set most text from
// 75 % to 125 % wide, so text would take another line or move when a late face arrived: each width and weight the
// sheets use has a stand-in of the same length (styles/fonts.css).
test('nothing jumps when a face arrives: a stand-in of the same length for every width and weight the sheets use', () => {
  const fonts = code('app/fonts.ts');
  assert.match(fonts, /import '@\/styles\/fonts\.css';/);
  // The stand-ins follow each face in its stack (styles/tokens.css), after the faces of the page's script (styles/i18n.css).
  assert.match(fonts, /export const archivo = Archivo\(\{[^}]*adjustFontFallback: false,\s*variable: '--font-archivo',/);
  assert.match(fonts, /export const martian = Martian_Mono\(\{[^}]*adjustFontFallback: false,\s*variable: '--font-martian',/);
  assert.doesNotMatch(fonts, /fallback: \[/);
  const tokens = read('styles/tokens.css');
  assert.match(tokens, /--f-sans: var\(--font-archivo\), var\(--f-script\) 'Archivo Stand-in', 'Archivo Stand-in R', 'Helvetica Neue', Arial, system-ui, sans-serif;/);
  assert.match(tokens, /--font-mono: var\(--font-martian\), var\(--f-script\) 'Martian Stand-in', ui-monospace, Menlo, Consolas, monospace;/);
  // Russian text takes Roboto's Cyrillic after Archivo, which has none; its file loads only where Cyrillic is shown.
  assert.match(fonts, /export const cyrillic = Roboto\(\{\s*subsets: \['cyrillic'\],\s*axes: \['wdth'\],\s*style: \['normal'\],\s*display: 'swap',\s*preload: false,/);
  assert.match(read('styles/i18n.css'), /:root:lang\(ru\) \{ --f-script: var\(--font-cyrillic\),; \}/);
  const sheet = read('styles/fonts.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const faces = [...sheet.matchAll(/@font-face \{ font-family: '([^']+)'; src: ([^;]+); font-stretch: ([\d.]+)%; font-weight: (\d+) (\d+); size-adjust: ([\d.]+)%; ascent-override: ([\d.]+)%; descent-override: ([\d.]+)%; line-gap-override: 0%; \}/g)]
    .map((m) => ({ family: m[1], src: m[2], stretch: Number(m[3]), lo: Number(m[4]), hi: Number(m[5]), size: Number(m[6]), ascent: Number(m[7]), descent: Number(m[8]) }));
  assert.equal(faces.length, sheet.match(/@font-face/g).length, 'every face in the one form');
  for (const f of faces) {
    // Platform faces only, never a file of their own; the real faces' ascent and descent at this size.
    assert.doesNotMatch(f.src, /url\(/);
    const [asc, desc] = f.family === 'Martian Stand-in' ? [100, 20] : [87.8, 21];
    assert.ok(Math.abs((f.ascent * f.size) / 100 - asc) < 0.02 && Math.abs((f.descent * f.size) / 100 - desc) < 0.02, `${f.family} ${f.stretch}% ${f.lo}`);
  }
  const sans = faces.filter((f) => f.family === 'Archivo Stand-in');
  const roboto = faces.filter((f) => f.family === 'Archivo Stand-in R');
  const mono = faces.filter((f) => f.family === 'Martian Stand-in');
  // Every rule of the sheets that sets a width or a weight finds its stand-in (a weight alone is at the normal width).
  let checked = 0;
  for (const name of ['base', 'shell', 'home', 'explorer', 'cabinet', 'pages']) {
    for (const [selector, body] of cssRules(read(`styles/${name}.css`))) {
      const stretch = body.match(/font-stretch: ([\d.]+)%/);
      const weight = body.match(/font-weight: (\d+)/);
      if (!stretch && !weight) continue;
      checked++;
      const s = stretch ? Number(stretch[1]) : 100;
      const w = weight ? Number(weight[1]) : 400;
      if (/font-family: var\(--font-mono\)/.test(body)) assert.ok(mono.some((f) => f.stretch === s), `${name}: ${selector} mono ${s}%`);
      else assert.ok(sans.some((f) => f.stretch === s && f.lo <= w && w <= f.hi), `${name}: ${selector} ${s}% ${w}`);
    }
  }
  assert.ok(checked >= 80, String(checked));
  // Bold text where the sans face is Roboto: the same faces, sized by Arial Bold's average width over Roboto Bold's.
  const bold = sans.filter((f) => f.lo > 580);
  assert.equal(roboto.length, bold.length);
  for (const f of bold) {
    const r = roboto.find((x) => x.stretch === f.stretch && x.lo === f.lo && x.hi === f.hi);
    assert.ok(r && Math.abs(r.size - (f.size * 983) / 926) < 0.02, `${f.stretch}% ${f.lo}`);
  }
  // Martian Mono is 600, 620, 650 and 700 units of 1000 wide at 75, 80, 87.5 and 100 %; every common monospace face 0.6 em.
  for (const [s, advance] of [[75, 600], [80, 620], [87.5, 650], [100, 700]]) {
    const f = mono.find((x) => x.stretch === s);
    assert.ok(f && Math.abs(f.size - advance / 10 / (1229 / 2048)) < 0.02, `mono ${s}%`);
  }
});

const ok = (value) => ({ phase: 'ok', value });
const LOADING = { phase: 'loading' };
const NANO = (qnc) => String(BigInt(Math.round(qnc * 1e6)) * 1000n);
const light = (over = {}) => ({
  registered: true, pending: false, deviceBound: true, answeredThisEpoch: true, needsReactivation: false,
  counted: { sinceRegistration: 10, counted: 9, lastCountedEpoch: 280 }, features: [], balanceNano: NANO(10478.743462),
  device: { platform: 'android', model: 'Pixel 8', linkedSince: 1_789_948_800, lastAnswerEpoch: 281, state: 'online', lastMiss: null }, ...over,
});
const superNode = (over = {}) => ({
  registered: true, online: true, lastSeenAt: 1, heartbeats: null, banned: false, balanceNano: NANO(3), admission: 'admitted', admitted: true,
  onPace: true, networkHeight: 10, serverHeight: 10, connected: false, ...over,
});
const NONE_SUPER = { registered: false, online: false, lastSeenAt: null, heartbeats: null, banned: false, balanceNano: null, admission: null, admitted: null, onPace: null, networkHeight: null, serverHeight: null, connected: true };
const history = (result) => ok({ registeredEpoch: 1, archived: true, rows: [{ epoch: 281, result, amountQnc: null, startedAt: null, endedAt: null, claimTx: null, miss: null }], more: false, earned: null });

test('the account menu\'s rows: My node, Node balance, Device and History with a node; My node and Activate without', () => {
  const none = accountRows({ network: ok({ state: 'none' }), light: ok({ ...light(), registered: false, device: null }), superNode: ok(NONE_SUPER), history: LOADING }, EN);
  assert.deepEqual(none.map((r) => [r.key, r.href, r.datum, r.tone, r.mark]), [
    ['node', TAB_HREF.overview, 'No node yet', null, 'ring'],
    ['activate', TAB_HREF.activate, 'Step 2 of 4', 'ember', null],
  ]);
  const rows = accountRows({ network: ok({ state: 'registered', nodeId: 'light_mobile_1', nodeType: 'light' }), light: ok(light()), superNode: ok(NONE_SUPER), history: history('counted') }, EN);
  assert.deepEqual(rows.map((r) => [r.key, r.label, r.href, r.datum, r.tone]), [
    ['node', 'My node', TAB_HREF.overview, 'Light node · Online', null],
    ['balance', 'Node balance', BALANCE_HREF, '10,478.743462 QNC', 'signal'],
    ['device', 'Device', TAB_HREF.device, 'Pixel 8 · Android', null],
    ['history', 'History', TAB_HREF.history, 'Epoch 281', null],
  ]);
  assert.equal(rows[0].mark, 'live');
  assert.equal(BALANCE_HREF, '/node?tab=overview#balance');
  assert.equal(TEXTS.nav_device, 'Device', 'one node, one device');
  assert.equal(nodeOnline({ network: ok({ state: 'none' }), light: ok(light()), superNode: ok(NONE_SUPER), history: LOADING }), true);
  // Under 1 QNC the balance is not Signal; an epoch not counted is Ember; an offline node has the ring.
  const low = accountRows({ network: LOADING, light: ok(light({ balanceNano: NANO(0.5), device: { ...light().device, state: 'offline' } })), superNode: ok(NONE_SUPER), history: history('missed') }, EN);
  assert.equal(low[0].datum, 'Light node · Offline');
  assert.equal(low[0].mark, 'ring');
  assert.equal(low[1].tone, null);
  assert.equal(low[3].tone, 'ember');
  // A super node: the server's state stands where a device would.
  const sup = accountRows({ network: ok({ state: 'registered', nodeId: 'super_node_1', nodeType: 'super' }), light: ok({ ...light(), registered: false, device: null }), superNode: ok(superNode()), history: LOADING }, EN);
  assert.equal(sup[0].datum, 'Super node · Online');
  assert.equal(sup[2].datum, 'Server online');
  assert.equal(sup[3].datum, null, 'not read yet: a dash at the same width');
  const both = accountRows({ network: ok({ state: 'registered', nodeId: 'light_mobile_1', nodeType: 'light' }), light: ok(light()), superNode: ok(superNode()), history: LOADING }, EN);
  assert.equal(both[0].datum, 'Light and super node');
  // Not read yet: every datum is a dash, the rows already in place.
  const loading = accountRows({ network: LOADING, light: LOADING, superNode: LOADING, history: LOADING }, EN);
  assert.deepEqual(loading.map((r) => r.datum), [null, null, null, null]);
});

test('one account control on every page and width: a panel on a computer, a sheet from the bottom on a phone', () => {
  const header = code('components/Header.tsx');
  assert.equal(header.match(/<ConnectWalletButton \/>/g)?.length, 1);
  const button = code('components/wallet/connect-wallet-button.tsx');
  assert.match(button, /role="dialog"/);
  assert.match(button, /if \(e\.key === 'Escape'\) close\(true\);/);
  assert.match(button, /if \(phone\) html\.style\.overflow = 'hidden';/);
  assert.match(button, /window\.dispatchEvent\(new CustomEvent\(OVERLAY_EVENT, \{ detail: 'account' \}\)\);/);
  // The node's rows are read when the menu is about to open (pointer or focus on its button), through the reads My
  // node shares; a page load asks nothing.
  assert.match(button, /\{children\(\(\) => close\(true\), open \|\| primed\)\}/);
  assert.match(button, /const reads = useAccountReads\(active \? wallet : null\);/);
  assert.match(button, /onPointerEnter=\{\(\) => setPrimed\(true\)\}\s*onFocus=\{\(\) => setPrimed\(true\)\}/);
  // One hook for those reads, the account menu's and My node's sections' alike (hooks/useAccountReads.ts).
  assert.match(button, /import \{ useAccountReads \} from '@\/hooks\/useAccountReads';/);
  assert.match(code('hooks/useAccountReads.ts'), /const network = useWalletNode\(wallet\);/);
  assert.match(code('components/cabinet/CabinetNav.tsx'), /const reads = useAccountReads\(choice\?\.qnet \?\? null, viewOnly\);/);
  const shell = read('styles/shell.css');
  const phone = shell.slice(shell.indexOf('@media (max-width: 860px) {'), shell.indexOf('/* ---------- Footer ---------- */'));
  assert.match(phone, /\.acct-menu, \.acct:not\(\[data-open\]\) \.acct-menu \{\n {4}position: fixed; top: auto; left: 0; right: 0; bottom: 0;/);
  assert.match(phone, /transform: translateY\(100%\); visibility: hidden;/);
  assert.match(phone, /\.acct\[data-open\] \.acct-menu \{ transform: none; visibility: visible;/);
  assert.match(phone, /padding: 18px var\(--gut\) calc\(8px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(shell, /\.acct-menu \{\n {2}position: absolute; top: calc\(100% \+ 6px\); inset-inline-end: 0; z-index: 55; width: 368px;/);
  // Copy answers on the control itself and keeps its width.
  const copy = english('components/ui/Copy.tsx');
  assert.match(copy, /<span data-on=\{state === 'done'\}>Copied<\/span>/);
  assert.match(copy, /<span data-on=\{state === 'blocked'\}>Select to copy<\/span>/);
  // Its widest label is short (a 24-character answer would make every Copy about 207 px wide), and the stand-in
  // under a detail page's title is the same control, hidden, so the two widths match by construction.
  for (const m of copy.matchAll(/<span data-on=\{state === '\w+'\}>([^<{]+)<\/span>/g)) assert.ok(m[1].length <= 14, m[1]);
  const whole = code('components/explorer/Detail.tsx');
  assert.match(whole, /<span className="ex-whole" aria-hidden="true" style=\{\{ visibility: 'hidden' \}\}>\s*<span className="ent-full">\{'0'\.repeat\(length\)\}<\/span>\s*<Copy value="" \/>/);
  assert.doesNotMatch(whole, /<span className="act">Copy<\/span>/);
});

// Every arrow character: the Arrows block, the long and supplemental arrows, and the arrows of Miscellaneous Symbols
// and Arrows.
const ARROW = /[←-⇿⟰-⟿⤀-⥿⬀-⯿]/;
const siteFiles = (dir) => readdirSync(new URL(`${dir}/`, SRC), { recursive: true })
  .map((n) => `${dir}/${n.replace(/\\/g, '/')}`)
  .filter((f) => /\.(tsx?|css)$/.test(f) && !/__tests__|__release__/.test(f));

test('no arrows: no arrow glyph on any page, link, button, row or text, and nothing drawn in their place', () => {
  assert.ok(ARROW.test('→') && ARROW.test('↗') && ARROW.test('↓') && ARROW.test('←') && !ARROW.test('—') && !ARROW.test('…'));
  const files = ['app', 'components', 'contexts', 'hooks', 'lib', 'styles'].flatMap(siteFiles);
  assert.ok(files.length > 150, String(files.length));
  for (const file of files) {
    const src = code(file);
    const at = src.search(ARROW);
    assert.equal(at, -1, `${file}: ${src.slice(Math.max(0, at - 40), at + 20)}`);
    // No arrow element or pseudo-element left behind for a glyph to go back into.
    assert.doesNotMatch(src, /className="arr"|\.arr\b|\sarrow=[{"]/, file);
  }
  // The action component has no arrow at all; a row action is shown by its hover, a link by its colour and underline.
  assert.doesNotMatch(code('components/ui/Action.tsx'), /ARROWS|arrow/);
  assert.match(read('styles/pages.css'), /\.rowlink \{\n {2}display: grid; grid-template-columns: minmax\(0, 4fr\) minmax\(0, 7fr\);/);
  // My node's ways to connect: the solid action and text actions; How it works's titles open with no marker drawn.
  assert.match(read('styles/cabinet.css'), /\.cab-connect-alt \{ display: flex; flex-wrap: wrap;/);
  assert.match(read('styles/cabinet.css'), /\.cab-guide-t::-webkit-details-marker \{ display: none; \}/);
  // The pager's steps and the list's sort say what they do in words.
  const pager = english('components/ui/Pager.tsx');
  assert.match(pager, /disabled=\{page <= 1\}>Newer<\/button>/);
  assert.match(pager, /disabled=\{page >= pages\}>Older<\/button>/);
  const list = code('app/explorer/ExplorerClient.tsx');
  assert.match(list, /sort: sortOrder === 'desc' \? 'descending' : 'ascending',/);
  assert.match(code('components/ui/DataTable.tsx'), /aria-sort=\{c\.sort\}/);
  // A menu path in prose is written in words.
  assert.match(TEXTS.support_epochs_apple, /In Settings, then General, then Background App Refresh,/);
});

test('values are never cut: readouts set smaller by their length, entities whole where their cell has room', () => {
  const base = read('styles/base.css');
  const ro = base.match(/\n\.ro-v \{([^}]*)\}/)[1];
  assert.doesNotMatch(ro, /ellipsis|overflow: hidden/);
  assert.match(ro, /font-size: min\(var\(--ro-size\), calc\(100cqi \/ var\(--ro-len, 1\) \/ var\(--ro-ch\)\)\); line-height: calc\(var\(--ro-size\) \* 1\.1\);/);
  assert.match(base, /\.ro \{[^}]*container-type: inline-size; \}/);
  // The face advances .57 em a character with the reading's -.03 em, under the .6 the size rule counts; where a script
  // resets the spacing (.6 em) the rule counts .63. So a value of `readoutLength` characters (a unit half its size after a
  // .3 em gap, without the spacing) fits its reading in every language with a pixel to spare, two readings to a phone's
  // line (134 px) up to a computer's.
  assert.equal(token('--ro-ch'), '.6');
  for (const locale of LOCALES) {
    const { advance, ch } = valueFace(locale, ro);
    for (const [value, unit] of [['3,196.173813559', 'QNC'], ['genesis_node_005'], ['71,909,649.24', 'QNC'], ['super_node_…a4f93464']]) {
      for (const width of [134, 150, 169, 240, 300]) {
        const size = Math.min(36, width / readoutLength(value, unit) / ch);
        const drawn = size * (advance * textLength(value) + (unit ? 0.3 + 0.3 * textLength(unit) : 0));
        assert.ok(drawn <= width - 1, `${locale}: ${value} at ${width}px: ${drawn.toFixed(1)}`);
      }
    }
  }
  // A word in Arabic, as wide in the reading's face as the browser measured it (em): the length the rule counts (an Arabic
  // letter at .72 em, .63 em a character in Arabic) holds it with room to spare, so the widest status fits its reading on
  // a 320 px phone.
  const arabic = valueFace('ar', ro).ch;
  for (const [key, em] of [['badge_unknown', 6.5], ['badge_offline', 5.82], ['badge_online', 3.24], ['badge_waiting', 4.41],
    ['device_none_counted', 7.68], ['device_no_answer', 4.88], ['ro_not_answered', 4.13]]) {
    assert.ok(readoutLength(CATALOGS.ar[key]) * arabic >= em * 1.02, `${key}: ${CATALOGS.ar[key]}`);
  }
  assert.equal(readoutLength('3,196.173813559', 'QNC'), 17);
  assert.equal(readoutLength('1', undefined, true), 2.6);
  // A Chinese, Japanese or Korean character is one em wide, so it counts 1 / .6 characters (geometry.ts textLength);
  // My node's section datum is fitted by the same length.
  assert.ok(Math.abs(readoutLength('エポック 12') - (4 / 0.6 + 3)) < 1e-9);
  assert.ok(Math.abs(readoutLength('에포크 7') - (3 / 0.6 + 2)) < 1e-9);
  assert.match(code('components/cabinet/CabinetNav.tsx'), /const fit = \{ '--d-len': datum \? textLength\(datum, 0\.62, ARABIC_VALUE_EM\) : 1, '--d-num': shown \? textLength\(shown, 0\.62, ARABIC_VALUE_EM\) : 1 \} as CSSProperties;/);
  // An amount's unit is as large as its number, and its icon with its gap counts whole (geometry.ts amountLength).
  assert.match(code('components/ui/Readouts.tsx'), /const len = !known \? 1 : \(amount \? amountLength\(value, unitText\(amount, t\('token_unnamed'\)\)\) \+ \(mark \? 1\.6 : 0\)\n\s*: readoutLength\(value, unit, Boolean\(mark\)\)\);/);
  assert.match(code('components/ui/Readouts.tsx'), /\{known && amount && <>\{' '\}<AmountUnit \{\.\.\.amount\} link=\{amount\.link !== false && !href\} \/><\/>\}/);
  for (const [file, n] of [['app/explorer/tx/[hash]/TransactionClient.tsx', 2], ['app/explorer/address/[address]/AddressClient.tsx', 1], ['app/explorer/qnc/QncClient.tsx', 3], ['app/explorer/token/[contract]/TokenClient.tsx', 2], ['components/cabinet/NodeHistory.tsx', 3], ['components/cabinet/NodeHome.tsx', 1]]) {
    const src = code(file);
    assert.equal(src.match(/<Readout [^>]*amount=\{/g)?.length ?? (src.match(/^\s+amount=\{\{\}\}$/gm)?.length ?? 0), n, file);
    assert.doesNotMatch(src, /unit="QNC"/, file);
  }
  // The node balance figure: its unit with its icon at the figure's size, the whole set smaller by its length.
  assert.match(code('components/cabinet/NodeHome.tsx'), /<p className="cab-figure" style=\{\{ '--ro-len': balanceNano === null \? 1 : amountLength\(formatQnc\(balanceNano\), 'QNC'\) \} as CSSProperties\}>[\s\S]*?\{' '\}<AmountUnit \/>\n\s*<\/p>/);
  assert.doesNotMatch(read('styles/cabinet.css'), /\.cab-figure \.unit/);
  // My node's sections: the bar's datum leaves its unit out and is set smaller by its length; the narrow rail's too.
  const cabinet = read('styles/cabinet.css');
  assert.match(cabinet, /\.cab-nav-d \{ order: -1;[^}]*font-size: min\(var\(--t-th\), calc\(100cqi \/ var\(--d-num, 1\) \/ \.62\)\);/);
  assert.match(cabinet, /\.cab-nav-u \{ display: none; \}/);
  assert.match(cabinet, /\.cab-nav-d \{ justify-self: start;[^}]*font-size: min\(12px, calc\(100cqi \/ var\(--d-len, 1\) \/ \.62\)\);/);
  // The bar's name is set smaller by its longest word, which never breaks: four sections on a 320 px window (a computer's
  // 15 px scrollbar, the bar's 12 px sides, each section's 4 px padding) hold the widest words the browser measured at
  // 13.5 px in the bar's face.
  assert.match(code('components/cabinet/CabinetNav.tsx'), /const nameFit = \(label: string\) => \(\{ '--n-len': Math\.max\(\.\.\.label\.split\(' '\)\.map\(\(word\) => textLength\(word, 0\.58\)\)\) \}\) as CSSProperties;/);
  assert.match(code('components/cabinet/CabinetNav.tsx'), /<span className="cab-nav-n" style=\{nameFit\(item\.label\)\}>\{item\.label\}<\/span>/);
  assert.match(cabinet, /\n {2}\.cab-nav-n \{ font-size: min\(13\.5px, calc\(100cqi \/ var\(--n-len, 1\) \/ \.58\)\); font-weight: 600; \}/);
  const section = (320 - 15 - 2 * 12) / 4 - 2 * 4;
  for (const [word, px] of [['Panoramica', 74.6], ['d’ensemble', 71.9], ['Dispositivo', 70.2], ['Устройство', 69.7], ['Cronologia', 68.9], ['Активация', 65]]) {
    const size = Math.min(13.5, section / textLength(word, 0.58) / 0.58);
    assert.ok((px * size) / 13.5 <= section, `${word}: ${((px * size) / 13.5).toFixed(1)} in ${section.toFixed(1)}`);
  }
  // An entity in a table's flexible column or a side of From / To shows as much as fits, cut in the middle, never less
  // than its short form (site-entity.test.mjs); no step of a container query decides it.
  assert.doesNotMatch(base, /@container|\.ent-long|data-fit/);
  assert.match(base, /:is\(\.tbl-fit, \.ent-fit\) \.ent-cut > \.ent-short \{ display: none; \}/);
  assert.match(code('components/ui/DataTable.tsx'), /\{c\.width \? c\.cell\(row\) : <div className="tbl-fit">\{c\.cell\(row\)\}<\/div>\}/);
  // A full address link is underlined part by part (an underline does not reach into its inline blocks).
  assert.match(base, /a\.ent \.addr-part \{\n {2}text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: \.22em; text-decoration-color: var\(--signal-line\);/);
});

test('touch targets of 44 px each way on phones and tablets, moving nothing; a table row is the target of its first entity', () => {
  const base = read('styles/base.css');
  const touch = base.slice(base.indexOf('@media (max-width: 720px), (pointer: coarse) {'));
  assert.match(touch, /\.act, a\.ent, \.ro-v a\.unit, a\.ro-v, \.ex-sort \{ position: relative; \}/);
  // A one-digit link (block 0, epoch 1) is still 44 px wide: the overlay is centred and never narrower.
  assert.match(touch, /content: ''; position: absolute; left: 50%; top: 50%; width: max\(calc\(100% \+ 8px\), 44px\); height: 44px; transform: translate\(-50%, -50%\);/);
  assert.match(base, /\.tbl tbody td:first-child > a\.ent::after \{ top: 0; bottom: 0; left: 0; right: 0; width: auto; height: auto; transform: none; \}/);
  assert.match(base, /\.tbl tbody tr \{ position: relative; \}/);
  // Every button, the footer's and the policies' links, a filter name, an epoch's cell and the viewed address are 44 px
  // targets on a touch screen.
  assert.match(touch, /^@media \(max-width: 720px\), \(pointer: coarse\) \{\n\s*\.btn \{ min-height: 44px; \}/);
  assert.match(read('styles/shell.css'), /\.ftr-link \{ display: inline-flex; align-items: center; min-height: 44px;/);
  assert.match(read('styles/pages.css'), /\.toc-link \{\n\s*display: flex; align-items: center; min-height: 44px;/);
  assert.match(read('styles/explorer.css'), /\.ex-filter::before \{ content: ''; position: absolute; top: 0; bottom: 0; left: -11px; right: -11px; \}/);
  const cabinet = read('styles/cabinet.css');
  assert.match(cabinet, /@media \(max-width: 720px\), \(pointer: coarse\) \{\n\s*\.cab-strip \{ height: 44px; \}/);
  assert.match(cabinet, /@media \(max-width: 720px\), \(pointer: coarse\) \{\n\s*\.cab-id \.ent \{ padding-block: 12px; margin-block: -12px; \}/);
  assert.match(cabinet, /\.cab-pe-x span \{ text-align: center; overflow-x: clip; \}/);
});

// A grid's implicit column, or one sized `1fr`, grows to its widest item's unbreakable content (a row of tabs, a long
// word, a value), and the page with it: the step of the payment address laid out 426 px wide on a 393 px phone in
// Russian. So every grid names its columns and every share of the line is bounded below by 0 (an `auto` column holds a
// control sized by its own content); only the overlay of `.swap` takes its widest child's width on purpose.
test('every grid names its columns, and no column grows past its share of the line', () => {
  const found = [];
  for (const name of STYLES) {
    for (const [selector, body] of cssRules(read(`styles/${name}`))) {
      if (!/display:\s*(inline-)?grid\b/.test(body) || selector === '.swap') continue;
      const columns = /grid-template-columns:\s*([^;]+)/.exec(body)?.[1];
      if (!columns) found.push(`${name} ${selector}: no columns`);
      else if (/(^|[\s(,])[\d.]+fr(?=[\s),]|$)/.test(columns.replace(/minmax\(0, [\d.]+fr\)/g, ''))) found.push(`${name} ${selector}: ${columns}`);
    }
  }
  assert.deepEqual(found, []);
  // A whole address set into a sentence wraps (ent-full): a plain `.ent` never breaks, so a 44-character address would
  // push the page past a phone's edge.
  const whole = [];
  for (const file of readdirSync(new URL('components/', SRC), { recursive: true }).map((n) => `components/${n.replace(/\\/g, '/')}`).filter((n) => n.endsWith('.tsx'))) {
    for (const m of code(file).matchAll(/<span className="ent"[^>]*>\{(\w+)\}<\/span>/g)) if (/dest|address|pub|wallet|qnet|solana/i.test(m[1])) whole.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(whole, []);
  assert.match(code('components/cabinet/ActivateSteps.tsx'), /\{t\('act_refund_to'\)\} <span className="ent ent-full" translate="no">\{dest\}<\/span>/);
});

// A label is never wider than its line in any language: a button's label wraps inside the button (a one-line button
// keeps its height: the paddings give back the taller line), an amount's unit takes the next line, and in a phone's
// header the wordmark's two words take two lines before Connect or Menu would pass the edge.
test('a button, an amount and the header give way inside the line instead of widening the page', () => {
  const base = read('styles/base.css');
  const btn = cssRules(base).find(([s]) => s === '.btn')?.[1] ?? '';
  assert.doesNotMatch(btn, /white-space: nowrap/);
  assert.match(btn, /max-width: 100%;[^}]*line-height: 1\.2; overflow-wrap: break-word;/);
  const pad = (sel) => Number(/padding: ([\d.]+)px/.exec(cssRules(base).find(([s]) => s === sel)?.[1] ?? '')?.[1]);
  // One line at 1.2 is as tall as it was at 1: font size × 0.2 less padding, split over top and bottom.
  assert.ok(Math.abs(pad('.btn-solid') * 2 + 15.5 * 1.2 - (17 * 2 + 15.5)) < 0.2, 'solid');
  assert.ok(Math.abs(pad('.btn-sm') * 2 + 14.5 * 1.2 - (13 * 2 + 14.5)) < 0.2, 'small');
  assert.ok(Math.abs(pad('.btn-text') * 2 + 15.5 * 1.2 - (15 * 2 + 15.5)) < 0.2, 'text');
  const cabinet = read('styles/cabinet.css');
  assert.match(cabinet, /:is\(\.cab-amts, \.cab-send-amt\) \.amount \{ flex-wrap: wrap; row-gap: 2px; \}/);
  // A test token's name longer than a phone's line (the Spanish test 1DEV beside its icon at 320 px) breaks between its
  // words.
  assert.match(cabinet, /\n:is\(\.cab-amts, \.cab-send-amt\) \.ent-unit \{ white-space: normal; \}/);
  // A tablet puts the payment address's code after the address and the amounts, and its 196 px column with it, so the
  // amounts never take the code's column.
  assert.match(cabinet, /\nhtml\[data-device='ios'\] \.cab-pay-qr, html\[data-device='android'\] \.cab-pay-qr \{ order: 2; \}/);
  assert.match(cabinet, /\n\.cab-manual \{ display: grid; grid-template-columns: 196px minmax\(0, 1fr\);/);
  assert.match(cabinet, /\n@media \(min-width: 721px\) \{\n\s*html\[data-device='ios'\] \.cab-manual, html\[data-device='android'\] \.cab-manual \{ grid-template-columns: minmax\(0, 1fr\) 196px; \}\n\}/);
  assert.match(cabinet, /@media \(max-width: 720px\) \{[^@]*\n\s*\.cab-manual \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(read('styles/shell.css'), /@media \(max-width: 420px\) \{\n\s*\.hdr-in \{ gap: 10px; \}\n(?:\s*\/\*[\s\S]*?\*\/\n)?\s*\.brand \{ flex: 0 1 auto; min-width: 0; white-space: normal; \}/);
});

// A value is never cut or run into its neighbour: a token's exact supply sizes its column, a block's count fits a
// Latest blocks card (164 px less its padding) and the block list's column in every language, and the page never
// scrolls sideways, so a phone that laid it out before its styles arrived takes the screen's width back.
test('values fit their column and card in every language, and the page never stays zoomed out', () => {
  assert.equal(amountWidth([], 220), 220);
  assert.equal(amountWidth([{ value: '1,000', unit: 'QNC' }]), AMOUNT_W);
  const supply = amountWidth([{ value: '42,578,819.880000000000000001', unit: 'QLRTLONG' }], 220);
  assert.ok(supply >= Math.ceil((29 + 8) * 7.75 + 16 + 12) + 14, `${supply}`);
  assert.match(code('app/explorer/tokens/TokensClient.tsx'), /amountWidth\(\(tokens \?\? \[\]\)\.map\(\(x\) => \(\{ value: x\.total_supply, unit: x\.symbol \|\| t\('token_unnamed'\) \}\)\), 220\)/);
  for (const locale of LOCALES) {
    const tr = translator(locale, CATALOGS[locale]);
    assert.ok(wordsWidth([txCountText(1_234_567, tr)]) - 14 <= 164 - 32, `${locale}: ${txCountText(1_234_567, tr)}`);
  }
  assert.match(code('app/explorer/blocks/BlocksClient.tsx'), /Math\.max\(120, wordsWidth\(\[txCountText\(99_999, t\)\]\)\)/);
  // The token directory's day column holds every month's date in the page's language.
  assert.match(code('app/explorer/tokens/TokensClient.tsx'), /Math\.max\(108, wordsWidth\(\[\.\.\.Array\.from\(\{ length: 12 \}, \(_, m\) => day\(Date\.UTC\(2026, m, 28\), t\)\), t\('genesis'\)\]\)\)/);
  assert.match(cssRules(read('styles/base.css')).find(([s]) => s === 'html')?.[1] ?? '', /overflow-x: clip;/);
  // A heading's long word breaks inside its line: clipped at the page's edge it would lose its last letters.
  assert.match(read('styles/base.css'), /\n:where\(h1, h2, h3, h4\) \{ overflow-wrap: anywhere; \}/);
  assert.match(read('styles/base.css'), /\.tbl-head \{ display: flex; flex-wrap: wrap;/);
  // A table's or a group's title (a span beside its count) gives way too.
  assert.match(cssRules(read('styles/base.css')).find(([s]) => s === '.tbl-title')?.[1] ?? '', /min-width: 0;[^}]*overflow-wrap: anywhere;/);
  for (const name of STYLES) {
    for (const [selector, body] of cssRules(read(`styles/${name}`))) {
      if (/\.tbl-title\b/.test(selector)) assert.doesNotMatch(body, /white-space: nowrap/, `${name} ${selector}`);
    }
  }
});

// The text of each call of `name(` in `src`, its arguments with their brackets balanced.
const callsOf = (src, name) => [...src.matchAll(new RegExp(`\\b${name}(?:<[^>(]*>)?\\(`, 'g'))].map((m) => {
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if ('([{'.includes(src[i])) depth++;
    else if (')]}'.includes(src[i]) && --depth === 0) return src.slice(m.index, i + 1);
  }
  return src.slice(m.index);
});

// An amount to 18 decimals runs past the 20 characters a fixed column holds: every amount column of a list is as wide as
// the list's longest value with its sign and unit (columns.tsx amountsWidth, geometry.ts amountWidth), so none runs
// into the next column: an address's other tokens, its transactions and token transfers, a token's transfers and
// holders, QNC's, a block's and a batch's, and the feed's.
test('every amount column is as wide as its list\'s longest amount, a token\'s to 18 decimals too', () => {
  const eighteen = amountWidth([{ value: '−42,578,819.880000000000000001', unit: 'QLRTLONG' }]);
  assert.ok(eighteen >= Math.ceil((30 + 8) * 7.75 + 16 + 12) + 14, `${eighteen}`);
  assert.ok(eighteen > AMOUNT_W);
  const columns = code('components/explorer/columns.tsx');
  assert.match(columns, /export const amountsWidth = \(parts: readonly \(AmountParts \| null\)\[\], signed = false, least\?: number\): number =>\n\s*amountWidth\(parts\.filter\(\(p\): p is AmountParts => p !== null\)\.map\(\(p\) => \(\{ value: signed \? `\+\$\{p\.value\}` : p\.value, unit: p\.unit \}\)\), least\);/);
  assert.match(columns, /amountCol<R>\(t, \(h\) => <span className="tbl-amt" style=\{fit\}>\{balance\(h\)\}<\/span>, t\('col_balance'\), amountWidth\(amounts\)\),/);
  // Where a phone stacks a holder's row, the balance has the second line to itself and is set smaller by the list's
  // longest amount in table characters (.62 em each) when that line is narrower: the worst one fits 320 px.
  assert.match(columns, /const fit = \{ '--amt-len': amountChars\(amounts\)\.toFixed\(2\) \} as CSSProperties;/);
  const base = read('styles/base.css');
  assert.match(base, /grid-template-areas: 'rank address pct' 'amount amount amount'; height: var\(--row-2\);/);
  assert.match(base, /\.tbl-frame\[data-scroll\]\[data-stack='holders'\] \.tbl td\[data-k='amount'\] \{ container-type: inline-size; \}/);
  assert.match(base, /\.tbl-frame\[data-scroll\]\[data-stack='holders'\] \.tbl-amt \{ font-size: min\(1em, calc\(100cqi \/ var\(--amt-len, 1\) \/ \.62\)\); \}/);
  const worst = amountChars([{ value: '4,257,881,988.123456789012345678', unit: 'QLRTLONG10' }]);
  assert.ok(worst * 0.62 * 10 <= 320 - 2 * 16, `${worst} characters at 10 px`);
  assert.equal(amountWidth([{ value: '4,257,881,988.123456789012345678', unit: 'Q' }]), Math.ceil((32 + 1) * 7.75 + 16 + 12) + 14);
  const pages = {
    'app/explorer/ExplorerClient.tsx': 1, 'app/explorer/address/[address]/AddressClient.tsx': 3, 'app/explorer/token/[contract]/TokenClient.tsx': 1,
    'app/explorer/qnc/QncClient.tsx': 1, 'app/explorer/block/[hash]/BlockClient.tsx': 1, 'app/explorer/tx/[hash]/TransactionClient.tsx': 1,
  };
  for (const [file, count] of Object.entries(pages)) {
    const calls = callsOf(code(file), 'amountCol');
    assert.equal(calls.length, count, file);
    for (const call of calls) assert.match(call, /,\s+(?:amountsWidth\(|amountWidth\(|\w*[aA]mountW\b)[\s\S]*\)$/, `${file}: ${call.slice(0, 80)}`);
  }
  // A holder list's balance takes the list's widest, a token's with its symbol.
  for (const file of ['app/explorer/qnc/QncClient.tsx', 'app/explorer/token/[contract]/TokenClient.tsx']) {
    const [call] = callsOf(code(file), 'holderCols');
    assert.match(call, /, full, \((?:data\?\.)?holders \?\? \[\]\)\.map\(\(h\) => \(\{ value: h\.balance, unit: (?:symbol|'QNC') \}\)\)\)$/, file);
  }
  // The signed lists count the sign; the feed's and a block's are sized by their own rows.
  const address = code('app/explorer/address/[address]/AddressClient.tsx');
  assert.match(address, /amountsWidth\(txs\.map\(\(x\) => rowAmount\(x, t\('token_unnamed'\)\)\), true\)/);
  assert.match(address, /amountWidth\(otherTokens\.map\(\(x\) => \(\{ value: x\.balance, unit: x\.symbol \|\| t\('token_unnamed'\) \}\)\), 260\)/);
  // A live list keeps the widest width its view needed: a long amount that leaves the rows narrows nothing while the
  // reader stays, so From / To never moves under the reader; another page, order or filter starts from its own rows.
  let kept = steadyWidth(null, 'p1', 300);
  kept = steadyWidth(kept, 'p1', 240);
  assert.equal(kept.width, 300, 'the long amount left: the width stays');
  kept = steadyWidth(kept, 'p1', 320);
  assert.equal(kept.width, 320, 'a longer one widens it');
  assert.deepEqual(steadyWidth(kept, 'p2', 240), { view: 'p2', width: 240 });
  assert.match(columns, /export function useSteadyWidth\(width: number, view: string\): number \{\n\s*const kept = useRef<SteadyWidth \| null>\(null\);\n\s*kept\.current = steadyWidth\(kept\.current, view, width\);\n\s*return kept\.current\.width;\n\}/);
  assert.match(code('app/explorer/ExplorerClient.tsx'), /const amountW = useSteadyWidth\(useMemo\(\(\) => amountsWidth\(\(rows \?\? \[\]\)\.map\(\(r\) => rowAmount\(r, t\('token_unnamed'\)\)\)\), \[rows, t\]\),\n\s*`\$\{pos\.page\}:\$\{pos\.cursor \?\? ''\}:\$\{sortOrder\}:\$\{typeFilters\.join\(','\)\}`\);/);
  assert.equal(address.match(/useSteadyWidth\(useMemo\([\s\S]*?\), address\);/g)?.length, 2, 'the address\'s transactions and token transfers');
  assert.match(code('app/explorer/qnc/QncClient.tsx'), /const transferAmountW = useSteadyWidth\(useMemo\([\s\S]*?\), 'qnc'\);/);
  assert.match(code('app/explorer/token/[contract]/TokenClient.tsx'), /const transferAmountW = useSteadyWidth\(useMemo\([\s\S]*?\), contract\);/);
});

// On phones and tablets everything is convenient: nothing past a 360 px screen's
// gutters, nothing that moves as a live value changes, and tablets laid out for their width.
test('phones and tablets: the header and the big word fit 360 px, live values keep their place, tablets use the width', () => {
  // The header's wallet control reserves its waiting label: a phone shows the short words of both, so the menu button
  // stays inside the gutter at 360 px.
  const connect = code('components/wallet/connect-wallet-button.tsx');
  assert.match(connect, /<span data-on=\{!waiting\}><span className="c-long">\{t\('hdr_connect'\)\}<\/span><span className="c-short">\{t\('hdr_connect_short'\)\}<\/span><\/span>/);
  assert.match(connect, /<span data-on=\{waiting\}><span className="c-long">\{t\('hdr_approve'\)\}<\/span><span className="c-short">\{t\('hdr_approve_short'\)\}<\/span><\/span>/);
  assert.deepEqual([TEXTS.hdr_connect, TEXTS.hdr_connect_short, TEXTS.hdr_approve, TEXTS.hdr_approve_short], ['Connect wallet', 'Connect', 'Approve in wallet…', 'Approve…']);
  assert.match(read('styles/shell.css'), /\.connect \.c-long \{ display: none; \}\n\s*\.connect \.c-short \{ display: inline; \}/);
  assert.match(read('styles/shell.css'), /^\.connect \.c-short \{ display: none; \}/m);
  // VERIFY (4.6 em wide) inside the gutters under 390 px, its old size from 390 px up.
  assert.match(read('styles/tokens.css'), /--t-verify: clamp\(56px, max\(17\.5vw, min\(72px, 21\.5vw - 7px\)\), 262px\);/);
  const home = read('styles/home.css');
  // The phone's ticker window is the band's full height, so a height's target is not cut to its line; the column's age
  // holds the language's longest age, so its box stays put as it counts up.
  assert.match(home, /\.stream-view \{\n\s*flex: 1; align-self: stretch; display: flex; align-items: center;/);
  assert.match(code('app/HomeClient.tsx'), /const ageBox = useMemo\(\(\) => \(\{ minWidth: `\$\{Math\.ceil\(wordsLength\(ageForms\(t\)\)\)\}ch` \}\), \[t\]\);/);
  // Tablets: three readings across where the six or five fit, and the store button at a phone's width.
  assert.match(home, /@media \(min-width: 600px\) and \(max-width: 860px\) \{\n\s*\.hero-ro \.readouts \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}\n\s*\.hero-ro \.readouts \.ro\[data-wide='true'\] \{ grid-column: span 2; \}/);
  assert.match(home, /@media \(min-width: 600px\) \{\n\s*\.own \.btn-solid \{ width: auto; min-width: 360px; \}/);
  const explorer = read('styles/explorer.css');
  assert.match(explorer, /@media \(min-width: 600px\) and \(max-width: 860px\) \{\n\s*\.ex-ro-net \.readouts \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  // The strip's head keeps its whole title at 360 px; the block history's count keeps its width, so Show newest stays put.
  assert.match(explorer, /@media \(max-width: 380px\) \{\n\s*\.ex-chain-head \{ column-gap: 12px; \}/);
  assert.ok(explorer.indexOf('@media (max-width: 380px)') > explorer.indexOf('.ex-chain-head { column-gap: 14px; }'), 'the 360 px rule comes after the phone rule');
  assert.match(explorer, /\.ex-newer > \.num \{ min-width: 19ch; \}/);
  // In every language the strip's title keeps its letters, Show newest stays inside a phone's width, a header row leaves
  // the wallet control its room on a tablet, and the reward split's quarter keeps its whole name.
  const title = explorer.match(/\n\.ex-chain-title \{([^}]*)\}/)[1];
  assert.doesNotMatch(title, /nowrap|ellipsis|overflow: hidden/);
  assert.match(explorer, /\.ex-newer \{ display: flex; flex-wrap: wrap;/);
  const shell = read('styles/shell.css');
  assert.match(shell, /@media \(min-width: 861px\) and \(max-width: 1180px\) \{ \.lang-now \{ display: none; \} \}/);
  assert.match(shell, /@media \(min-width: 861px\) and \(max-width: 1099px\) \{\n\s*\.hdr-in \{ gap: clamp\(16px, 2vw, 28px\); \}\n\s*\.nav \{ gap: clamp\(12px, 1\.5vw, 20px\); \}/);
  assert.match(shell, /@media \(max-width: 1023px\) \{\n\s*\.connect \.c-long \{ display: none; \}\n\s*\.connect \.c-short \{ display: inline; \}/);
  assert.ok(shell.indexOf('@media (max-width: 1023px)') > shell.search(/^\.connect \.c-short \{ display: none; \}/m), 'after the rule it overrides');
  assert.match(home, /\.split > div \+ div \{ align-items: flex-end; \}/);
  assert.match(home, /\.split i \{ display: block; align-self: stretch;/);
});

// An amount is never crooked (the icon and the underlined unit above the number): number and unit stand on one baseline
// at one size; the icon, 1.25 times the text and never under 20 px, is centred on them.
test('an amount is one straight line: number and unit on one baseline, the icon centred on them, fixed gaps', () => {
  const base = read('styles/base.css');
  assert.match(base, /\.amount \{ display: inline-flex; align-items: baseline; gap: \.5em; font-family: var\(--font-mono\); font-stretch: 80%; white-space: nowrap; \}/);
  assert.match(base, /\.ent-unit \{ display: inline-flex; align-items: baseline; gap: \.4em; \}/);
  assert.doesNotMatch(base, /\.ent-unit \{[^}]*align-items: center/);
  // Icons large enough to read: 1.25 times the text in readouts and the payment card, at least 20 px in a
  // table row, centred on the figures; a drawn icon's letter is laid over it.
  assert.match(base, /\.tok-text \{ position: relative; width: max\(20px, 1\.25em\); height: max\(20px, 1\.25em\); align-self: center; \}/);
  assert.doesNotMatch(base, /1cap/);
  assert.match(code('components/explorer/ExplorerSearch.tsx'), /size=\{20\}/);
  assert.match(base, /\.tok-text > span \{ position: absolute; inset: 0;/);
  const link = code('components/ui/EntityLink.tsx');
  assert.match(link, /<TokenIcon native size="text" \/>QNC/);
  assert.match(link, /<TokenIcon address=\{token\} symbol=\{symbol\} logo=\{logo\} size="text" \/>/);
  assert.match(link, /<span className="ent-unit"><TokenIcon address=\{raw\} symbol=\{symbol\} size="text" \/>\{text\}<\/span>/);
  assert.doesNotMatch(link, /size=\{16\}/);
  // In text mode TokenIcon sets no pixel size of its own: the stylesheet sizes it from the text.
  const icon = code('components/TokenIcon.tsx');
  assert.match(icon, /size\?: number \| 'text';/);
  assert.match(icon, /const px = text \? undefined : `\$\{size\}px`;/);
  assert.match(icon, /const box = text \? 'tok-text' : undefined;/);
});

// In every language a table's headers stay in their columns, an epoch's result and times, My node's Overview beside a
// long balance, the newest move's label, a figure with its unit, the Latest blocks title and an age are shown whole,
// and the phone header keeps inside the screen.
test('every language fits its tables, My node, the Latest blocks head, its ages and the phone header', () => {
  const base = read('styles/base.css');
  const th = base.match(/\n\.tbl th \{([^}]*)\}/)[1];
  assert.doesNotMatch(th, /nowrap/);
  assert.match(th, /overflow-wrap: break-word;/);
  assert.match(base, /\.tbl :is\(\.txtype, \.status\) \{ white-space: normal; \}/);
  // Each word of an epoch table's header fits its column in every language (10.5 px capitals spaced .12 em).
  const history = { history_col_epoch: 76, history_col_result: 248, history_col_time: 248, history_col_amount: 200, history_col_tx: 132 };
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    for (const [key, width] of Object.entries(history)) {
      for (const word of catalog[key].toUpperCase().split(/\s+/)) {
        assert.ok(textLength(word, 0.62) * (10.5 * 0.62 + 1.26) <= (key === 'history_col_tx' ? width : width - 14), `${locale} ${key}: ${word}`);
      }
    }
  }
  const cabinet = read('styles/cabinet.css');
  assert.doesNotMatch(cabinet.match(/\n\.cab-nav-n \{([^}]*)\}/)[1], /nowrap|ellipsis|overflow: hidden/);
  // The newest move's label has a row of its own over the bars' column, so it never meets the group's head or an axis;
  // it stands at the marker by the same fraction of its own width (its left edge at --at x (W - w) >= 0, its right at
  // most W while w <= W), so it never crosses the chart's edges, and it wraps where the chart is narrower than it. The
  // marker's line reaches up to that row.
  const moved = cssRules(cabinet).find(([s]) => s === '.cab-pe-moved span')?.[1] ?? '';
  assert.match(cabinet, /\.cab-pe-moved \{ grid-column: 2; min-width: 0; margin: 0 0 8px; \}/);
  assert.match(moved, /position: relative; left: calc\(var\(--at\) \* 100%\); display: inline-block; max-width: 100%; transform: translateX\(calc\(var\(--at\) \* -100%\)\);/);
  assert.doesNotMatch(moved, /nowrap/);
  assert.match(cabinet, /\.cab-pe-moved\[aria-hidden='true'\] \{ visibility: hidden; \}/);
  assert.match(cabinet, /\.cab-pe-mark \{ position: absolute; top: -8px; bottom: 0;/);
  assert.doesNotMatch(cabinet, /\.cab-pe-mark span|data-flip|\.cab-pe \{[^}]*padding-top/);
  const charts = code('components/cabinet/EpochCharts.tsx');
  assert.match(charts, /<p className="cab-pe-moved" style=\{at\} aria-hidden=\{marker === null \|\| undefined\}><span>\{t\('per_epoch_moved'\)\}<\/span><\/p>/);
  assert.match(charts, /\{marker !== null && <span className="cab-pe-mark" style=\{at\} \/>\}/);
  // The axis values stand in flow and their column is at least as wide as the widest of them ("12,300", "0.565"), so
  // none reaches past the chart's edge at any width.
  assert.match(cabinet, /\n\.cab-pe \{ display: grid; grid-template-columns: minmax\(40px, max-content\) minmax\(0, 1fr\);/);
  assert.match(cabinet, /\n {2}\.cab-pe \{ grid-template-columns: minmax\(36px, max-content\) minmax\(0, 1fr\);/);
  const axis = cssRules(cabinet).find(([s]) => s === '.cab-pe-y')?.[1] ?? '';
  assert.match(axis, /display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; height: 170px;/);
  assert.match(axis, /white-space: nowrap;/);
  assert.doesNotMatch(cabinet, /\.cab-pe-y span \{[^}]*position: absolute/);
  assert.match(cabinet, /\.cab-pe-y span:first-child \{ transform: translateY\(-50%\); \}\n\.cab-pe-y span:last-child \{ transform: translateY\(50%\); \}/);
  assert.match(charts, /<span>\{tick\(data\.max\)\}<\/span>\s*<span>\{tick\(data\.max \/ 2\)\}<\/span>\s*<span>0<\/span>/);
  // On a phone the epochs under the bars stand every fourth one counted back from the newest: equal steps, never the
  // newest a step closer than the rest.
  assert.match(cabinet, /\n {2}\.cab-pe-x span:nth-last-child\(4n \+ 1\) \{ visibility: visible; \}/);
  assert.doesNotMatch(cabinet, /\.cab-pe-x span:nth-child\(/);
  assert.match(cabinet, /\.cab-epochs td\[data-k='time'\] \{ white-space: normal; \}/);
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    const text = span(new Date(2026, 9, 26, 20, 45).getTime(), new Date(2026, 9, 27, 0, 45).getTime(), translator(locale, catalog));
    assert.equal(text.split(' ').length, 3, `${locale}: ${text}`);
  }
  assert.match(cabinet, /\.cab-balance \{ container-type: inline-size; \}/);
  assert.match(cabinet, /\.cab-figure \{[^}]*font-size: min\(var\(--t-figure\), calc\(100cqi \/ var\(--ro-len, 1\) \/ var\(--ro-ch\)\)\);/);
  assert.match(cabinet, /\.cab-figure \{ font-size: min\(clamp\(30px, 9vw, 44px\), calc\(100cqi \/ var\(--ro-len, 1\) \/ var\(--ro-ch\)\)\); \}/);
  // An amount, a space, its icon, a .4 em gap and its unit fit the reading at the size the rule gives, in every language
  // with a pixel to spare: a reading two to a phone's line (134 px) up to a computer's, and My node's figure, whose own
  // spacing is -.04 em. The figure clips, so a hair past its box would take the unit off.
  const ro = base.match(/\n\.ro-v \{([^}]*)\}/)[1];
  const figure = cssRules(cabinet).find(([s]) => s === '.cab-figure')?.[1] ?? '';
  for (const locale of LOCALES) {
    for (const [rule, max, widths] of [[ro, 36, [134, 169, 189, 240, 358, 833]], [figure, 76, [288, 358, 833]]]) {
      const { advance, ch, icon } = valueFace(locale, rule);
      for (const [value, unit] of [['0.00015', 'QNC'], ['70,000', 'QNC'], ['2,901.142384615', 'QNC'], ['84,229,833.90', 'QNC'],
        ['3,226,160.478214069', 'QNC'], ['4,257,881,988.12', 'QNC'], ['42,578,819.880000000000000001', 'QLRTLONG']]) {
        for (const width of widths) {
          const size = Math.min(max, width / amountLength(value, unit) / ch);
          const drawn = size * advance * textLength(`${value} ${unit}`) + icon(size) + 0.4 * size;
          assert.ok(drawn <= width - 1, `${locale}: ${value} ${unit} at ${width}px: ${drawn.toFixed(1)}`);
        }
      }
    }
  }
  // An age's column holds the language's longest age ("il y a 59 min"), and the list of all transactions still leaves
  // From / To its room at 1,181 px in every language.
  assert.ok(ageForms(translator('fr', CATALOGS.fr)).includes('il y a 59 min'));
  assert.ok(wordsWidth(ageForms(translator('fr', CATALOGS.fr))) >= Math.ceil(13 * 7.75) + 14);
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    const age = Math.max(72, wordsWidth(ageForms(translator(locale, catalog))));
    assert.ok(1181 - 2 * 0.04 * 1181 - (136 + 136 + AMOUNT_W + 92 + age) >= FROM_TO_MIN, locale);
  }
  const columns = code('components/explorer/columns.tsx');
  assert.match(columns, /export const ageWidth = \(t: T, width: number\): number => Math\.max\(width, wordsWidth\(ageForms\(t\)\)\);/);
  assert.match(columns, /width: ageWidth\(t, width\), align: 'right'/);
  assert.match(code('app/explorer/blocks/BlocksClient.tsx'), /<Ago ts=\{b\.timestamp\} \/> : null\), ageWidth\(t, 88\)\),/);
  // The Latest blocks head: the actions take a line of their own where all does not fit; the title never breaks a word.
  const explorer = read('styles/explorer.css');
  assert.match(explorer, /\.ex-chain-head \{ display: flex; flex-wrap: wrap;/);
  assert.doesNotMatch(explorer.match(/\n\.ex-chain-title \{([^}]*)\}/)[1], /anywhere|min-width: 0/);
  assert.match(explorer, /\.ex-chain-acts \{ display: flex; align-items: center; column-gap: inherit; margin-inline-start: auto; \}/);
  assert.match(code('components/explorer/LatestBlocks.tsx'), /<span className="ex-chain-acts">\n\s*<Action kind="act" href="\/explorer\/blocks" className="ex-chain-all">[\s\S]*?<\/button>\n\s*<\/span>\n\s*<\/div>/);
  // The phone header closes up, then steps its words down, so its controls keep the gutters from 390 to 320 px.
  const shell = read('styles/shell.css');
  assert.match(shell, /@media \(max-width: 420px\) \{\n\s*\.hdr-in \{ gap: 10px; \}\n/);
  assert.match(shell, /@media \(max-width: 380px\) \{\n\s*\.brand \{ gap: 8px; \}\n\s*\.brand-name \{ font-size: 14\.5px; \}\n\s*\.connect \{ font-size: 14px; \}\n\s*\.menu-btn \{ font-size: 11px; letter-spacing: \.02em; \}/);
  assert.match(shell, /@media \(max-width: 340px\) \{\n\s*\.hdr-in \{ gap: 8px; \}\n\s*\.brand img \{ width: 24px; height: 24px; \}/);
  assert.ok(shell.indexOf('@media (max-width: 420px)') > shell.indexOf('@media (max-width: 860px)'), 'after the phone rules they refine');
});

// My node's journey on a phone: each step's label at 13 px, its longest word never broken (Chinese and Japanese break
// between characters). Four steps to a line hold every language's longest word from 380 px; under it, two rows of two.
test('My node\'s journey holds each step\'s longest word in every language', () => {
  const cabinet = read('styles/cabinet.css');
  assert.match(cabinet, /\n\.cab-journey \{\n\s*display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); column-gap: 6px;/);
  assert.match(cabinet, /\.cab-journey-t \{ font-size: 13px; \}/);
  assert.match(cabinet, /\n@media \(max-width: 379px\) \{\n\s*\.cab-journey \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); row-gap: 12px; \}\n\}/);
  const labels = code('components/cabinet/CabinetProgress.tsx').match(/const STEP_LABEL[^}]*\}/)[0];
  const keys = [...labels.matchAll(/: '(progress_\w+)'/g)].map((m) => m[1]);
  assert.equal(keys.length, 5);
  // A quarter (or half) of a phone's line between its 16 px gutters, less the 6 px gaps; the sans face averages .56 em.
  const room = (w, cols) => (w - 2 * 16 - (cols - 1) * 6) / cols;
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    const words = keys.flatMap((k) => catalog[k].split(/\s+/)).filter((word) => !/[\u3040-\u30ff\u4e00-\u9fff]/.test(word));
    const longest = Math.max(...words.map((word) => textLength(word, 0.56) * 0.56 * 13));
    for (const w of [380, 393, 412, 430]) assert.ok(longest <= room(w, 4), `${locale} at ${w}px: ${longest.toFixed(0)}`);
    for (const w of [320, 360, 379]) assert.ok(longest <= room(w, 2), `${locale} at ${w}px: ${longest.toFixed(0)}`);
  }
});
