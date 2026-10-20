// Concept B's foundation (B-SPEC 2, 3, 5): one set of tokens, squared controls, no blur over the moving field, layouts
// that nothing moves (device decided at first paint, fixed table geometry, labels that keep their width), and the
// header's one account control with My node's rows. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { accountRows, nodeOnline, BALANCE_HREF } from '../account-menu.ts';
import { readoutLength } from '../geometry.ts';
import { TAB_HREF } from '../cabinet/tabs.ts';
import { TEXTS } from '../texts.ts';
import { SRC, code, read } from './source.mjs';

const STYLES = readdirSync(new URL('styles/', SRC)).filter((n) => n.endsWith('.css'));

test('every token of the spec is defined once, in tokens.css, imported first', () => {
  const tokens = read('styles/tokens.css');
  const spec = {
    '--ink': '#05080A', '--surface': '#0A1013', '--rule': '#1A2529', '--rule-strong': '#2B3A3F', '--edge': '#56686D', '--edge-hover': '#6A7C81',
    '--fog': '#8D9CA1', '--paper': '#E8F0F0', '--text': 'rgb(232 240 240 / .8)', '--signal': '#3CF0DC', '--signal-line': 'rgb(60 240 220 / .55)',
    '--ember': '#FFB547', '--mint': '#9BE7A6', '--lilac': '#C7B8FF', '--fill-field': 'rgb(232 240 240 / .035)', '--fill-row': 'rgb(232 240 240 / .03)',
    '--fill-signal': 'rgb(60 240 220 / .06)', '--fill-disabled': 'rgb(232 240 240 / .07)', '--ember-tint': 'rgb(255 181 71 / .11)',
    '--scrim': 'rgb(0 0 0 / .6)', '--shadow-menu': '0 24px 48px rgb(0 0 0 / .5)', '--maxw': '1360px', '--gut': 'clamp(16px, 4vw, 56px)',
    '--hdr': '64px', '--bar': '64px', '--row': '44px', '--row-2': '60px', '--radius': '2px', '--focus': '2px solid var(--signal)',
    '--ease-out': 'cubic-bezier(.2, .7, .2, 1)',
  };
  for (const [name, value] of Object.entries(spec)) {
    assert.equal(tokens.match(new RegExp(`^\\s*${name}: ([^;]+);`, 'm'))?.[1], value, name);
  }
  assert.match(tokens, /color-scheme: dark;/);
  const layout = code('app/layout.tsx');
  assert.ok(layout.indexOf("import '@/styles/tokens.css';") < layout.indexOf("import '@/styles/base.css';"));
  assert.ok(layout.indexOf("import '@/styles/base.css';") < layout.indexOf("import './globals.css';"));
  assert.ok(layout.indexOf("import './globals.css';") < layout.indexOf("import '@/styles/shell.css';"));
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

test('nothing jumps: the device at first paint, fixed table geometry, labels that keep their width, menus that shift nothing', () => {
  const layout = code('app/layout.tsx');
  assert.match(layout, /const device = installTarget\(request\.get\('user-agent'\)\);/);
  assert.match(layout, /<html lang="en" data-device=\{device\}/);
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
  assert.match(read('styles/shell.css'), /\.hdr-acct \{ margin-left: auto; flex: none; \}/);
  assert.match(read('styles/shell.css'), /\.nav\[data-pending\] \{ visibility: hidden; \}/);
  // The footer's row keeps its height in the app's view; the home readouts keep two lines under each value.
  assert.match(read('styles/home.css'), /\.hero-ro \{[^}]*--ro-sub-lines: 2;/);
  assert.match(base, /\.ro-s \{ margin: 0; min-height: calc\(1\.4em \* var\(--ro-sub-lines, 1\)\);/);
  // The live column is a window of fixed height that rows fill from the top.
  assert.match(read('styles/home.css'), /\.stream-view \{\n {2}height: 460px; overflow: hidden;/);
});

// REAL.md 7.5 (owner 19.10: nothing jumps, everything clickable): with a block a second a phone's list moved between
// aiming at a row and tapping it (a tap aimed at block 5,093 opened 5,094), since a touch held nothing. A touch now holds
// a live list from the press until 3 s after the last touch or scroll there, and the list says how many rows wait.
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
  assert.equal(heldText({ count: 3, more: false }, true), '3 new');
  assert.equal(heldText({ count: 1200, more: true }, false), '1,200+ new');
  assert.equal(heldText({ count: 0, more: false }, true), 'Paused');
  assert.equal(heldText({ count: 0, more: false }, false), 'Paused while you point at it');
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
  assert.match(label, /<span data-on=\{!said\}>\{idle\}<\/span>\s*<span data-on=\{said === POINTING\} data-k="point">\{POINTING\}<\/span>\s*<span data-on=\{!!said && said !== POINTING\}>\{said && said !== POINTING \? said : ' '\}<\/span>/);
  assert.match(read('styles/base.css'), /@media \(max-width: 720px\) \{\n\s*\.swap > \[data-k='point'\] \{ display: none; \}/);
  // The block lists (the home page's column and the explorer's strip) hold through the one hook, with their own frame.
  assert.match(code('components/explorer/useRecentBlocks.ts'), /const hold = useHold\(blocks, box, blockKey\);/);
  assert.match(code('app/HomeClient.tsx'), /<HoldLabel hold=\{hold\} idle="Live blocks" \/>/);
  const strip = code('components/explorer/LatestBlocks.tsx');
  assert.match(strip, /const \{ shown, hold, near, landed \} = useLiveBlocks\(seed, RECENT_BLOCKS, view, list\);/);
  assert.match(strip, /<span className="label tbl-live"><HoldLabel hold=\{hold\} \/><\/span>/);
  // The strip's own handlers start with the hook's, so a finger's press still holds it while a mouse drags it.
  assert.match(strip, /const onPointerDown = \(e: PointerEvent<HTMLDivElement>\) => \{\n\s*hold\.handlers\.onPointerDown\(e\);/);
  assert.match(strip, /const onPointerUp = \(e: PointerEvent<HTMLDivElement>\) => \{\n\s*hold\.handlers\.onPointerUp\(e\);/);
  assert.match(strip, /\{\.\.\.hold\.handlers\}\n\s*onPointerDown=\{onPointerDown\}\n\s*onPointerMove=\{onPointerMove\}\n\s*onPointerUp=\{onPointerUp\}/);
});

// Review 19.10: next/font's stand-in matches Archivo and Martian Mono at their normal width only, while the sheets set
// most text from 75 % to 125 % wide, so text took another line or moved when a late face arrived. Each width and weight
// the sheets use now has a stand-in of the same length (styles/fonts.css).
test('nothing jumps when a face arrives: a stand-in of the same length for every width and weight the sheets use', () => {
  const fonts = code('app/fonts.ts');
  assert.match(fonts, /import '@\/styles\/fonts\.css';/);
  assert.match(fonts, /export const archivo = Archivo\(\{[^}]*adjustFontFallback: false,\s*fallback: \['Archivo Stand-in', 'Archivo Stand-in R'\],/);
  assert.match(fonts, /export const martian = Martian_Mono\(\{[^}]*adjustFontFallback: false,\s*fallback: \['Martian Stand-in'\],/);
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
    const css = read(`styles/${name}.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const stretch = body.match(/font-stretch: ([\d.]+)%/);
      const weight = body.match(/font-weight: (\d+)/);
      if (!stretch && !weight) continue;
      checked++;
      const s = stretch ? Number(stretch[1]) : 100;
      const w = weight ? Number(weight[1]) : 400;
      if (/font-family: var\(--font-mono\)/.test(body)) assert.ok(mono.some((f) => f.stretch === s), `${name}: ${selector.trim()} mono ${s}%`);
      else assert.ok(sans.some((f) => f.stretch === s && f.lo <= w && w <= f.hi), `${name}: ${selector.trim()} ${s}% ${w}`);
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
  const none = accountRows({ network: ok({ state: 'none' }), light: ok({ ...light(), registered: false, device: null }), superNode: ok(NONE_SUPER), history: LOADING });
  assert.deepEqual(none.map((r) => [r.key, r.href, r.datum, r.tone, r.mark]), [
    ['node', TAB_HREF.overview, 'No node yet', null, 'ring'],
    ['activate', TAB_HREF.activate, 'Step 2 of 4', 'ember', null],
  ]);
  const rows = accountRows({ network: ok({ state: 'registered', nodeId: 'light_mobile_1', nodeType: 'light' }), light: ok(light()), superNode: ok(NONE_SUPER), history: history('counted') });
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
  const low = accountRows({ network: LOADING, light: ok(light({ balanceNano: NANO(0.5), device: { ...light().device, state: 'offline' } })), superNode: ok(NONE_SUPER), history: history('missed') });
  assert.equal(low[0].datum, 'Light node · Offline');
  assert.equal(low[0].mark, 'ring');
  assert.equal(low[1].tone, null);
  assert.equal(low[3].tone, 'ember');
  // A super node: the server's state stands where a device would.
  const sup = accountRows({ network: ok({ state: 'registered', nodeId: 'super_node_1', nodeType: 'super' }), light: ok({ ...light(), registered: false, device: null }), superNode: ok(superNode()), history: LOADING });
  assert.equal(sup[0].datum, 'Super node · Online');
  assert.equal(sup[2].datum, 'Server online');
  assert.equal(sup[3].datum, null, 'not read yet: a dash at the same width');
  const both = accountRows({ network: ok({ state: 'registered', nodeId: 'light_mobile_1', nodeType: 'light' }), light: ok(light()), superNode: ok(superNode()), history: LOADING });
  assert.equal(both[0].datum, 'Light and super node');
  // Not read yet: every datum is a dash, the rows already in place.
  const loading = accountRows({ network: LOADING, light: LOADING, superNode: LOADING, history: LOADING });
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
  assert.match(shell, /\.acct-menu \{\n {2}position: absolute; top: calc\(100% \+ 6px\); right: 0; z-index: 55; width: 368px;/);
  // Copy answers on the control itself and keeps its width.
  const copy = code('components/ui/Copy.tsx');
  assert.match(copy, /<span data-on=\{state === 'done'\}>Copied<\/span>/);
  assert.match(copy, /<span data-on=\{state === 'blocked'\}>Select to copy<\/span>/);
  // Its widest label is short (review 19.10: a 24-character answer made every Copy about 207 px wide), and the stand-in
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

test('no arrows (owner 19.10): no arrow glyph on any page, link, button, row or text, and nothing drawn in their place', () => {
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
  const pager = code('components/ui/Pager.tsx');
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
  assert.match(ro, /font-size: min\(var\(--ro-size\), calc\(100cqi \/ var\(--ro-len, 1\) \/ \.6\)\); line-height: calc\(var\(--ro-size\) \* 1\.1\);/);
  assert.match(base, /\.ro \{[^}]*container-type: inline-size; \}/);
  // Martian Mono at the readout's 75 % width, weight 300 and -.03 em spacing advances .57 em a character (measured in the
  // browser), under the .6 the size rule assumes, so a value of `readoutLength` characters always fits its reading.
  const ADVANCE = 0.57;
  for (const [value, unit] of [['3,196.173813559', 'QNC'], ['genesis_node_005'], ['71,909,649.24', 'QNC'], ['super_node_…a4f93464']]) {
    const length = readoutLength(value, unit);
    for (const width of [150, 169, 240, 300]) {
      const size = Math.min(36, width / length / 0.6);
      assert.ok(size * ADVANCE * length <= width, `${value} at ${width}px`);
    }
  }
  assert.equal(readoutLength('3,196.173813559', 'QNC'), 17);
  assert.equal(readoutLength('1', undefined, true), 2.6);
  // An amount's unit is as large as its number, its icon one mark more: it counts whole (owner 20.10).
  assert.match(code('components/ui/Readouts.tsx'), /const len = !known \? 1 : \(amount \? readoutLength\(`\$\{value\} \$\{unitText\(amount\)\}`, undefined, true\) \+ \(mark \? 1\.6 : 0\)\n\s*: readoutLength\(value, unit, Boolean\(mark\)\)\);/);
  assert.match(code('components/ui/Readouts.tsx'), /\{known && amount && <>\{' '\}<AmountUnit \{\.\.\.amount\} link=\{amount\.link !== false && !href\} \/><\/>\}/);
  for (const [file, n] of [['app/explorer/tx/[hash]/TransactionClient.tsx', 2], ['app/explorer/address/[address]/AddressClient.tsx', 1], ['app/explorer/qnc/QncClient.tsx', 3], ['app/explorer/token/[contract]/TokenClient.tsx', 2], ['components/cabinet/NodeHistory.tsx', 3], ['components/cabinet/NodeHome.tsx', 1]]) {
    const src = code(file);
    assert.equal(src.match(/<Readout [^>]*amount=\{/g)?.length ?? (src.match(/^\s+amount=\{\{\}\}$/gm)?.length ?? 0), n, file);
    assert.doesNotMatch(src, /unit="QNC"/, file);
  }
  // The node balance figure: its unit with its icon at the figure's size.
  assert.match(code('components/cabinet/NodeHome.tsx'), /<p className="cab-figure">[\s\S]*?\{' '\}<AmountUnit \/>\n\s*<\/p>/);
  assert.doesNotMatch(read('styles/cabinet.css'), /\.cab-figure \.unit/);
  // My node's sections: the bar's datum leaves its unit out and is set smaller by its length; the narrow rail's too.
  const cabinet = read('styles/cabinet.css');
  assert.match(cabinet, /\.cab-nav-d \{ order: -1;[^}]*font-size: min\(var\(--t-th\), calc\(100cqi \/ var\(--d-num, 1\) \/ \.62\)\);/);
  assert.match(cabinet, /\.cab-nav-u \{ display: none; \}/);
  assert.match(cabinet, /\.cab-nav-d \{ justify-self: start;[^}]*font-size: min\(12px, calc\(100cqi \/ var\(--d-len, 1\) \/ \.62\)\);/);
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
  // targets on a touch screen (device pass 20.10).
  assert.match(touch, /^@media \(max-width: 720px\), \(pointer: coarse\) \{\n\s*\.btn \{ min-height: 44px; \}/);
  assert.match(read('styles/shell.css'), /\.ftr-link \{ display: inline-flex; align-items: center; min-height: 44px;/);
  assert.match(read('styles/pages.css'), /\.toc-link \{\n\s*display: flex; align-items: center; min-height: 44px;/);
  assert.match(read('styles/explorer.css'), /\.ex-filter::before \{ content: ''; position: absolute; top: 0; bottom: 0; left: -11px; right: -11px; \}/);
  const cabinet = read('styles/cabinet.css');
  assert.match(cabinet, /@media \(max-width: 720px\), \(pointer: coarse\) \{\n\s*\.cab-strip \{ height: 44px; \}/);
  assert.match(cabinet, /@media \(max-width: 720px\), \(pointer: coarse\) \{\n\s*\.cab-id \.ent \{ padding-block: 12px; margin-block: -12px; \}/);
  assert.match(cabinet, /\.cab-pe-x span \{ text-align: center; overflow-x: clip; \}/);
});

// Device pass (owner 20.10, "on phones and tablets everything must be convenient"): nothing past a 360 px screen's
// gutters, nothing that moves as a live value changes, and tablets laid out for their width.
test('phones and tablets: the header and the big word fit 360 px, live values keep their place, tablets use the width', () => {
  // The header's wallet control reserves its waiting label: a phone shows the short words of both, so the menu button
  // stays inside the gutter at 360 px.
  const connect = code('components/wallet/connect-wallet-button.tsx');
  assert.match(connect, /<span data-on=\{!waiting\}>Connect<span className="c-long"> wallet<\/span><\/span>/);
  assert.match(connect, /<span data-on=\{waiting\}>Approve<span className="c-long"> in wallet<\/span>…<\/span>/);
  assert.match(read('styles/shell.css'), /\.connect \.c-long \{ display: none; \}/);
  // VERIFY (4.6 em wide) inside the gutters under 390 px, its old size from 390 px up.
  assert.match(read('styles/tokens.css'), /--t-verify: clamp\(56px, max\(17\.5vw, min\(72px, 21\.5vw - 7px\)\), 262px\);/);
  const home = read('styles/home.css');
  // The phone's ticker window is the band's full height, so a height's target is not cut to its line; the column's age
  // keeps a fixed width, so its box stays put as it counts up.
  assert.match(home, /\.stream-view \{\n\s*flex: 1; align-self: stretch; display: flex; align-items: center;/);
  assert.match(home, /\.blk-age \{ min-width: 7ch;/);
  // Tablets: three readings across where the six or five fit, and the store button at a phone's width.
  assert.match(home, /@media \(min-width: 600px\) and \(max-width: 860px\) \{\n\s*\.hero-ro \.readouts \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}\n\s*\.hero-ro \.readouts \.ro\[data-wide='true'\] \{ grid-column: span 2; \}/);
  assert.match(home, /@media \(min-width: 600px\) \{\n\s*\.own \.btn-solid \{ width: auto; min-width: 360px; \}/);
  const explorer = read('styles/explorer.css');
  assert.match(explorer, /@media \(min-width: 600px\) and \(max-width: 860px\) \{\n\s*\.ex-ro-net \.readouts \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  // The strip's head keeps its whole title at 360 px; the block history's count keeps its width, so Show newest stays put.
  assert.match(explorer, /@media \(max-width: 380px\) \{\n\s*\.ex-chain-head \{ column-gap: 12px; \}/);
  assert.ok(explorer.indexOf('@media (max-width: 380px)') > explorer.indexOf('.ex-chain-head { column-gap: 14px; }'), 'the 360 px rule comes after the phone rule');
  assert.match(explorer, /\.ex-newer > \.num \{ min-width: 19ch; \}/);
});

// Owner 20.10 (a transaction row's amount was crooked: the icon and the underlined unit sat above the number): number
// and unit stand on one baseline at one size; the icon, 1.25 times the text and never under 20 px, is centred on them.
test('an amount is one straight line: number and unit on one baseline, the icon centred on them, fixed gaps', () => {
  const base = read('styles/base.css');
  assert.match(base, /\.amount \{ display: inline-flex; align-items: baseline; gap: \.5em; font-family: var\(--font-mono\); font-stretch: 80%; white-space: nowrap; \}/);
  assert.match(base, /\.ent-unit \{ display: inline-flex; align-items: baseline; gap: \.4em; \}/);
  assert.doesNotMatch(base, /\.ent-unit \{[^}]*align-items: center/);
  // Owner 20.10 (the icons were too small): 1.25 times the text in readouts and the payment card, at least 20 px in a
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
