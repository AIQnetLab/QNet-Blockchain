// The field, the hex rain: one canvas inside a page's head zone, never fixed behind the whole page; frames
// only while its zone is in view, the tab is shown and motion is allowed, at the page's frame and pixel-ratio caps; one
// still picture under reduced motion; a cost ladder that steps down on slow frames and never climbs back; each lit
// stream's head flickering and its trail glyphs changing as it falls, at the brightness their cells show.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldLoop, Ladder, SLOW_STEPS, fieldCaps, rightOpacity, rightWeight } from '../field/rain.ts';
import { frameLoop } from '../frame-loop.ts';
import { fakeClock as clock } from './frame-clock.mjs';
import { code, read } from './source.mjs';

function setup({ fps = 30, slowMs = 0 } = {}) {
  const c = clock();
  const env = { hidden: false, reduced: false, t: 0 };
  const rain = { draws: 0, pictures: 0, halved: 0, draw() { this.draws++; env.t += slowMs; }, full() { this.pictures++; }, halve() { this.halved++; } };
  const loop = new FieldLoop(rain, fps, { hidden: () => env.hidden, reduced: () => env.reduced, now: () => env.t }, c);
  return { c, env, rain, loop };
}

test('frames only while the zone is in view and the tab is shown, at the page\'s cap; none at all otherwise', () => {
  const { c, env, rain, loop } = setup();
  loop.sync();
  c.run(60, 1000);
  assert.equal(rain.draws + rain.pictures, 0, 'off screen: nothing drawn');
  loop.visible = true;
  loop.sync();
  assert.equal(rain.pictures, 1, 'the whole picture once when the zone shows');
  c.run(60, 1000, 2000);
  assert.ok(rain.draws >= 29 && rain.draws <= 31, String(rain.draws));
  env.hidden = true;
  loop.sync();
  assert.equal(c.queued.size, 0);
  const before = rain.draws;
  c.run(60, 1000, 4000);
  assert.equal(rain.draws, before, 'hidden tab: nothing drawn');
  env.hidden = false;
  loop.visible = false;
  loop.sync();
  c.run(60, 1000, 6000);
  assert.equal(rain.draws, before, 'scrolled away: nothing drawn');
  loop.stop();
  assert.equal(c.queued.size, 0);
});

test('under reduced motion one still picture and no frame', () => {
  const { c, env, rain, loop } = setup();
  env.reduced = true;
  loop.visible = true;
  loop.sync();
  loop.sync();
  c.run(60, 2000);
  assert.equal(rain.pictures, 1);
  assert.equal(rain.draws, 0);
  // A resize asks for the picture again, once.
  loop.invalidate();
  assert.equal(rain.pictures, 2);
});

test('the caps: 30 frames (24 on a phone), 15 in My node; pixel ratio 1.5 on the home hero, 1.25 elsewhere', () => {
  assert.deepEqual(fieldCaps('home', false), { fps: 30, dpr: 1.5 });
  assert.deepEqual(fieldCaps('home', true), { fps: 24, dpr: 1.5 });
  assert.deepEqual(fieldCaps('tool', false), { fps: 30, dpr: 1.25 });
  assert.deepEqual(fieldCaps('tool', true), { fps: 24, dpr: 1.25 });
  assert.deepEqual(fieldCaps('cabinet', false), { fps: 15, dpr: 1.25 });
  const { c, rain, loop } = setup({ fps: 15 });
  loop.visible = true;
  loop.sync();
  c.run(120, 2000);
  assert.ok(rain.draws >= 29 && rain.draws <= 31, String(rain.draws));
  // The tool pages weight the rain to the right.
  assert.ok(Math.abs(rightWeight(0) - 0.2) < 1e-9 && Math.abs(rightWeight(1) - 2) < 1e-9);
  assert.ok(Math.abs(rightOpacity(0) - 0.25) < 1e-9 && rightOpacity(1) === 1);
});

// A loop that asked for a frame on every refresh and drew on some of them would wake the page several times per frame
// drawn: below the display's rate it sleeps until a frame is nearly due.
test('below the display\'s rate the loop makes about one frame callback per frame it draws', () => {
  // 144, 165 and 240 Hz put refreshes between "nearly due" and "due"; a woken frame there must still draw.
  for (const [fps, hz] of [[30, 60], [24, 60], [15, 60], [30, 90], [30, 120], [15, 120], [30, 144], [24, 144], [20, 144], [30, 165], [24, 165], [30, 240]]) {
    const c = clock();
    let steps = 0;
    const loop = frameLoop(() => steps++, fps, () => true, c);
    loop.sync();
    c.run(hz, 10_000);
    assert.ok(Math.abs(steps - fps * 10) <= 2, `${fps} fps on ${hz} Hz: ${steps} frames in 10 s`);
    assert.ok(c.frames - steps <= 2, `${fps} fps on ${hz} Hz: ${c.frames} frame callbacks for ${steps} frames`);
    loop.stop();
    assert.equal(c.queued.size + c.timers.size, 0, 'stopped: no frame and no timer left');
  }
  // At the display's own rate there is nothing to sleep through: one frame callback per refresh, each drawing.
  const c = clock();
  let steps = 0;
  frameLoop(() => steps++, 60, () => true, c).sync();
  c.run(60, 2000);
  assert.ok(Math.abs(steps - 120) <= 2 && c.frames - steps <= 1, `${steps} frames, ${c.frames} callbacks`);
});

test('slow frames step the field down: half the density, then 20 frames a second, then a still picture', () => {
  const ladder = new Ladder();
  for (let i = 0; i < SLOW_STEPS - 1; i++) assert.equal(ladder.record(9), null);
  assert.equal(ladder.record(9), 'halve');
  for (let i = 0; i < 200; i++) ladder.record(2);
  assert.equal(ladder.level, 1, 'fast frames never climb back');
  const { c, rain, loop } = setup({ slowMs: 12 });
  loop.visible = true;
  loop.sync();
  c.run(60, 2000);
  assert.equal(rain.halved, 1);
  assert.equal(loop.fps, 20);
  c.run(60, 3000, 3000);
  assert.equal(loop.stopped, true);
  const drawn = rain.draws;
  c.run(60, 2000, 7000);
  assert.equal(rain.draws, drawn, 'the still picture stays');
  assert.equal(c.queued.size, 0);
});

test('one canvas inside a head zone, never fixed, never in the shell; tokens for its colours', () => {
  const field = code('components/field/Field.tsx');
  assert.match(field, /<div className="field-zone" aria-hidden="true"[^>]*>\s*<canvas ref=\{ref\} className="field-canvas" \/>/);
  assert.match(field, /const caps = fieldCaps\(kind, narrow\);/);
  assert.match(field, /Math\.min\(window\.devicePixelRatio \|\| 1, caps\.dpr\)/);
  assert.match(field, /new IntersectionObserver\(/);
  const base = read('styles/base.css');
  assert.match(base, /\.field-zone \{ position: absolute; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; \}/);
  assert.doesNotMatch(base + read('styles/home.css'), /\.field[^{]*\{[^}]*position: fixed/);
  assert.match(code('components/ui/PageHead.tsx'), /<Field strength=\{strength\} kind=\{kind\} opacity=\{opacity\} \/>/);
  assert.match(code('app/HomeClient.tsx'), /<Field strength=\{0\.85\} kind="home" weighting="none" onReady=\{onField\} \/>/);
  assert.doesNotMatch(code('components/SiteShell.tsx'), /Field|canvas/);
  // A frame draws from a glyph atlas made once: drawImage only, no text drawn per frame.
  const rain = code('lib/field/rain.ts');
  const draw = rain.slice(rain.indexOf('  draw(dt: number): void {'));
  assert.doesNotMatch(draw, /fillText/);
  assert.match(rain, /this\.ctx\.drawImage\(this\.atlas\.img,/);
  // Controls and text dim the cells over them; header controls clear them.
  assert.match(rain, /const dim = raw === null \? 0 : Math\.max\(0, Math\.min\(1, Number\(raw\) \|\| 0\)\);/);
  assert.match(code('components/Header.tsx'), /<header className="hdr"[^>]*data-field-fixed data-field-dim="0\.25">/);
});

// In a title band the cells under text are cleared, never dimmed, also for text that comes after the first paint (a
// block's hash and neighbours), so no glyph sits behind words. Every line of a band's text clears the cells under it, line by line, and a change of the band's text clears its new lines
// at once.
test('a title band clears every cell under each line of its text, and follows the text as it changes', async () => {
  const { Rain, lineZones } = await import('../field/rain.ts');
  const cleared = [];
  const ctx = { canvas: { width: 0, height: 0 }, setTransform() {}, clearRect(...r) { cleared.push(r); } };
  const rain = new Rain(ctx, () => ({ getContext: () => null }), { cell: 18, density: 0.3, font: 'mono' });
  rain.resize(360, 180, 1);
  const canvas = { left: 0, top: 100, width: 360, height: 180 };
  // A paragraph of two lines, the second short: 0 to 300 px, then 0 to 90 px, each 20 px tall.
  const lines = [{ left: 0, right: 300, top: 136, bottom: 156 }, { left: 0, right: 90, top: 158, bottom: 178 }];
  const zones = lineZones(canvas, lines, rain.cell / 2);
  assert.deepEqual(zones.map((z) => z.dim), [0, 0]);
  rain.rezone(zones);
  const dim = (x, y) => rain.dim[Math.floor(x / 18) * rain.rows + Math.floor(y / 18)];
  // Every cell any part of which lies under a letter shows no glyph...
  for (const [x, y] of [[9, 45], [290, 45], [9, 63], [80, 63]]) assert.equal(dim(x, y), 0, `${x},${y}`);
  // ...while the space beside the short second line, and above and below the text, keeps its rain.
  for (const [x, y] of [[200, 81], [300, 75], [9, 9], [9, 99]]) assert.equal(dim(x, y), 1, `${x},${y}`);
  // The cells under a new line are cleared on the canvas at once, not left to fade.
  assert.deepEqual(cleared.slice(-2).map((r) => r.map(Math.round)), [[-9, 27, 318, 38], [-9, 49, 108, 38]]);
  // A line outside the canvas makes no zone.
  assert.equal(lineZones(canvas, [{ left: 0, right: 50, top: 400, bottom: 420 }], 9).length, 0);
  // The field: in a band (PageHead's data-field-band) the zones add the band's lines of text and its icons; a change of
  // the band's text measures again and makes the table again only when a line moved.
  const field = code('components/field/Field.tsx');
  assert.match(field, /const band = canvas\.closest\('\[data-field-band\]'\);/);
  assert.match(field, /return band \? \[\.\.\.marked, \.\.\.lineZones\(box, bandLines\(band\), rain\.cell \/ 2\)\] : marked;/);
  assert.match(field, /const walker = document\.createTreeWalker\(band, NodeFilter\.SHOW_TEXT\);/);
  assert.match(field, /for \(const r of range\.getClientRects\(\)\) if \(r\.width && r\.height\) out\.push\(r\);/);
  assert.match(field, /edits\?\.observe\(band, \{ childList: true, subtree: true, characterData: true \}\);/);
  assert.match(field, /if \(key === lines\) return;\n\s*lines = key;\n\s*rain\.rezone\(next\);/);
  const head = code('components/ui/PageHead.tsx');
  assert.match(head, /<div className="page-head" data-field-band>/);
  // The band's own text is cleared line by line, no longer dimmed as whole boxes.
  assert.match(head, /<h1 className="page-title">\{title\}<\/h1>/);
  assert.match(head, /\{lead && <p className="lead">\{lead\}<\/p>\}/);
});

// A model of the canvas the field draws on, per cell: a cell-sized clearRect clears it, drawImage draws at globalAlpha,
// a destination-out fill keeps (1 - its alpha) of what lies under it. `last(key)` is the cell's last clear and draw in
// the current frame, with what the cell showed just before that clear.
function canvasModel(cell) {
  const shows = new Map();
  let ops = new Map();
  const inside = (key, x, y, w, h) => {
    const [kx, ky] = key.split(',').map(Number);
    return kx >= x && kx < x + w && ky >= y && ky < y + h;
  };
  const ctx = {
    canvas: { width: 0, height: 0 },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    setTransform() {},
    clearRect(x, y, w, h) {
      if (w === cell && h === cell) {
        const key = `${x},${y}`;
        ops.set(key, { before: shows.get(key) ?? 0, drawn: 0, kind: -1 });
        shows.delete(key);
      } else for (const key of [...shows.keys()]) if (inside(key, x, y, w, h)) shows.delete(key);
    },
    drawImage(img, sx, sy, sw, sh, dx, dy) {
      const key = `${dx},${dy}`;
      shows.set(key, this.globalAlpha);
      const op = ops.get(key);
      if (op) Object.assign(op, { drawn: this.globalAlpha, kind: sy / sw, glyph: sx / sw });
    },
    fillRect(x, y, w, h) {
      assert.equal(this.globalCompositeOperation, 'destination-out');
      const keep = 1 - Number(/^rgba\(0, 0, 0, ([\d.]+)\)$/.exec(this.fillStyle)[1]);
      for (const [key, a] of shows) if (inside(key, x, y, w, h)) shows.set(key, a * keep);
    },
  };
  return { ctx, frame: () => (ops = new Map()), last: (key) => ops.get(key), alpha: (key) => shows.get(key) ?? 0 };
}

// A live field on the canvas model, the same on every run (a seeded source in place of Math.random): 100 lit columns of
// an 1800 px square, with the spawn's spread of speeds (8 to 24 rows a second), lengths (14 to 40) and brightness (0.45
// to 1), run two seconds so every trail on screen was drawn by its stepping head. `frame()` draws one more frame and
// returns the grid and the head rows from before it.
async function liveField(fps, body) {
  const { Rain, GLYPHS } = await import('../field/rain.ts');
  const random = Math.random;
  let seed = 7;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    const model = canvasModel(18);
    const atlas = { scale() {}, fillText() {}, save() {}, restore() {} };
    const rain = new Rain(model.ctx, () => ({ width: 0, height: 0, getContext: () => atlas }), { cell: 18, density: 1, font: 'mono' });
    rain.resize(1800, 1800, 1);
    rain.streams.forEach((s, i) => {
      const len = 14 + ((i * 7) % 27);
      Object.assign(s, { on: true, v: 8 + (16 * (i % 10)) / 9, len, a: 0.45 + (0.55 * ((i * 3) % 10)) / 9, y: 10.5, at: 10, tail: 11 - len });
    });
    rain.full();
    for (let f = 0; f < 2 * fps; f++) rain.draw(1 / fps);
    const frame = () => {
      const before = rain.grid.slice();
      const heads = rain.streams.map((s) => s.at);
      model.frame();
      rain.draw(1 / fps);
      return { before, heads };
    };
    return body({ rain, model, frame, GLYPHS });
  } finally {
    Math.random = random;
  }
}

const FRAME_RATES = [15, 24, 30];
// A glyph is in sight while its cell shows it at more than the field's 0.02 (MIN_ALPHA in rain.ts).
const IN_SIGHT = 0.02;

// A stream's head flickers and its trail keeps changing as it falls, at the same pace at every frame rate the field
// runs at (fieldCaps: 15, 24, 30).
test('over a second every lit stream changes its head glyph at least ten times and 0.65 of its trail cells in sight', async () => {
  for (const fps of FRAME_RATES) {
    await liveField(fps, ({ rain, model, frame, GLYPHS }) => {
      const { rows } = rain;
      const headGlyph = (i) => GLYPHS[rain.grid[i * rows + rain.streams[i].at]];
      const prev = rain.streams.map((_, i) => headGlyph(i));
      const heads = new Array(100).fill(0);
      const swaps = new Array(100).fill(0);
      const expected = new Array(100).fill(0);
      for (let f = 0; f < fps; f++) {
        const { before } = frame();
        rain.streams.forEach((s, i) => {
          const glyph = headGlyph(i);
          if (glyph !== prev[i]) heads[i]++;
          prev[i] = glyph;
          let inSight = 0;
          for (let r = Math.max(0, s.at - s.len + 1); r <= s.at - 3; r++) {
            const k = i * rows + r;
            if (before[k] !== rain.grid[k]) swaps[i]++;
            if (model.alpha(`${i * 18},${r * 18}`) > IN_SIGHT) inSight++;
          }
          expected[i] += (0.65 * inSight) / fps;
        });
      }
      assert.ok(Math.min(...heads) >= 10, `${fps} fps: head glyph changes per stream ${heads.join(' ')}`);
      // 2.5 per stream: the carried fraction rounds a second's count by up to one, the reach behind a head is whole cells
      // rounded up (one cell more, 0.65), and a cell picked twice in one frame may come back to its glyph (one fewer).
      const miss = expected.map((e, i) => Math.abs(swaps[i] - e)).filter((d) => d > 2.5);
      assert.deepEqual(miss, [], `${fps} fps: trail changes ${swaps.join(' ')} against ${expected.map((e) => e.toFixed(1)).join(' ')}`);
      // Over 100 streams the roundings cancel; 5% is the rounded-up reach, one cell in about twenty.
      const total = swaps.reduce((a, b) => a + b, 0);
      const want = expected.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - want) <= want * 0.05, `${fps} fps: ${total} trail changes in all, ${want.toFixed(0)} expected`);
    });
  }
  // The rates the field runs at, as docs/applications/explorer.md states them.
  const { HEAD_FLICKER_PER_S, TRAIL_SWAP_PER_CELL_S } = await import('../field/rain.ts');
  assert.deepEqual([HEAD_FLICKER_PER_S, TRAIL_SWAP_PER_CELL_S], [12, 0.65]);
});

test('the head writes a new glyph into every cell it enters and is drawn with it', async () => {
  for (const fps of FRAME_RATES) {
    await liveField(fps, ({ rain, model, frame, GLYPHS }) => {
      const { rows } = rain;
      let entered = 0;
      const off = [];
      for (let f = 0; f < fps; f++) {
        const { before, heads } = frame();
        rain.streams.forEach((s, i) => {
          for (let r = heads[i] + 1; r <= s.at; r++) {
            const k = i * rows + r;
            entered++;
            if (GLYPHS[before[k]] === GLYPHS[rain.grid[k]]) off.push(`column ${i} row ${r} kept ${GLYPHS[before[k]]}`);
          }
          const op = model.last(`${i * 18},${s.at * 18}`);
          if (op.kind !== 2 || op.glyph !== rain.grid[i * rows + s.at]) off.push(`column ${i}: head drawn as ${op.kind}/${op.glyph}`);
        });
      }
      assert.ok(entered >= 100 * 8, `${fps} fps: ${entered} cells entered`);
      assert.deepEqual(off.slice(0, 5), [], `${fps} fps`);
    });
  }
});

test('a trail glyph that changes is drawn at the brightness its cell shows; the still picture changes none', async () => {
  for (const fps of FRAME_RATES) {
    await liveField(fps, ({ rain, model, frame }) => {
      const { rows } = rain;
      const still = rain.grid.slice();
      rain.full();
      assert.deepEqual(rain.grid, still, 'the still picture changes no glyph');
      let changed = 0;
      const off = [];
      for (let f = 0; f < fps; f++) {
        const { before } = frame();
        rain.streams.forEach((s, i) => {
          for (let r = Math.max(0, s.at - s.len + 1); r <= s.at - 3; r++) {
            const k = i * rows + r;
            if (before[k] === rain.grid[k]) continue;
            changed++;
            const op = model.last(`${i * 18},${r * 18}`);
            const fits = Math.abs(op.drawn - op.before) <= op.before * 0.03 + 0.002 || (op.drawn === 0 && op.before < 0.022);
            if (!fits || (op.drawn && op.kind !== 0)) off.push(`column ${i} row ${r}: drawn ${op.drawn} kind ${op.kind} over ${op.before}`);
          }
        });
      }
      assert.ok(changed > 500, `${fps} fps: ${changed} trail glyphs changed`);
      assert.deepEqual(off.slice(0, 5), [], `${fps} fps: a changed glyph off its cell's brightness`);
    });
  }
});

// The cost ladder's first step switches half the lit streams off: what they drew fades as a lit trail's glyphs do, and
// once the head's glyph (1.4 times its stream's brightness, at most 1) is under 0.02 nothing of them is left on the
// canvas, at every frame rate the field runs at.
test('streams a halving switches off fade out by the trail\'s own law and leave no frozen glyph behind', async () => {
  for (const fps of FRAME_RATES) {
    await liveField(fps, ({ rain, model, frame }) => {
      const { rows } = rain;
      const cellKey = (i, r) => `${i * 18},${r * 18}`;
      const streams = rain.streams.slice();
      rain.halve();
      const off = streams.flatMap((s, i) => (s.on ? [] : [i]));
      assert.ok(off.length > 30 && off.length < 70, `${fps} fps: ${off.length} of 100 streams switched off`);
      const drawn = off.map((i) => [...Array(rows).keys()].filter((r) => model.alpha(cellKey(i, r)) > IN_SIGHT));
      assert.ok(drawn.every((cells) => cells.length > 3), `${fps} fps: every stream switched off had a trail in sight`);
      const before = off.map((i, n) => drawn[n].map((r) => model.alpha(cellKey(i, r))));
      // Half a second on, each of those glyphs keeps what the fade leaves of a lit trail's in that time (the fade runs
      // every other frame, so within a frame either way).
      const half = Math.round(fps / 2);
      for (let f = 0; f < half; f++) frame();
      const keep = (frames) => 0.925 ** ((30 * frames) / fps);
      const wrong = [];
      off.forEach((i, n) => drawn[n].forEach((r, j) => {
        const a = model.alpha(cellKey(i, r));
        if (a > before[n][j] * keep(half - 1) * 1.03 || a < before[n][j] * keep(half + 1) * 0.97) wrong.push(`column ${i} row ${r}: ${before[n][j].toFixed(3)} -> ${a.toFixed(3)}`);
      }));
      assert.deepEqual(wrong.slice(0, 5), [], `${fps} fps: a switched-off glyph not fading as a trail's`);
      // Past the time the brightest glyph needs to fall under 0.02, the cells those streams drew are cleared.
      const window = Math.log(IN_SIGHT) / Math.log(0.925 ** 30);
      for (let f = half; f < Math.ceil((window + 0.25) * fps); f++) frame();
      let checked = 0;
      off.forEach((i, n) => {
        if (rain.streams[i] !== streams[i]) return;
        checked++;
        assert.deepEqual(drawn[n].filter((r) => model.alpha(cellKey(i, r)) > 0), [], `${fps} fps: column ${i} keeps glyphs`);
      });
      assert.ok(checked > 30, `${fps} fps: ${checked} columns checked`);
    });
  }
});
