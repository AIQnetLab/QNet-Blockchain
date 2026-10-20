// The field, the hex rain (B-SPEC 4): one canvas inside a page's head zone, never fixed behind the whole page; frames
// only while its zone is in view, the tab is shown and motion is allowed, at the page's frame and pixel-ratio caps; one
// still picture under reduced motion; a cost ladder that steps down on slow frames and never climbs back.
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

// Review 19.10: the loop asked for a frame on every refresh and drew on some of them, so a 15 fps field woke the page
// four times per frame drawn. Below the display's rate it now sleeps until a frame is nearly due.
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

// REAL.md 7.11 (B-SPEC 4.2, per-line clearing): in a title band the cells under text were dimmed, not cleared, and text
// that came after the first paint (a block's hash and neighbours) had no zone at all, so glyphs sat behind words. Every
// line of a band's text now clears the cells under it, line by line, and a change of the band's text clears its new lines
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
