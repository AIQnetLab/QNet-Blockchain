// The field: hex rain in a page's head zone (B-SPEC 4). Glyphs sit in a fixed grid and a stream lights them as it
// passes, the way a ledger is read: the head white with a Signal glow, two pale cells behind it, the trail Signal. A
// glyph atlas is drawn once; a frame is drawImage calls for the cells the heads step into, one fade of the canvas and the
// clearing of each trail's end, so its cost follows the number of streams, not their length. Framework-free, so its rules
// are tested (src/lib/__tests__/site-field.test.mjs); src/components/field/Field.tsx mounts it.

import { frameLoop, type FrameClock, type FrameLoop } from '../frame-loop.ts';

export const GLYPHS = '0123456789abcdef0123456789abcdefｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂ';

// The atlas colours. A canvas cannot read CSS variables per draw, so these are the values of --signal, --signal-pale,
// --white and the Signal glow in src/styles/tokens.css.
const TRAIL = '#3CF0DC';
const PALE = '#B9FFF6';
const HEAD = '#FFFFFF';
const GLOW = 'rgba(60, 240, 220, .95)';

export type FieldKind = 'home' | 'tool' | 'cabinet';

// Frames a second and the device pixel ratio cap: the home hero 30 (24 on a phone) at 1.5, other pages 30 (24) at 1.25,
// My node 15 at 1.25.
export function fieldCaps(kind: FieldKind, narrow: boolean): { fps: number; dpr: number } {
  if (kind === 'cabinet') return { fps: 15, dpr: 1.25 };
  return { fps: narrow ? 24 : 30, dpr: kind === 'home' ? 1.5 : 1.25 };
}

// Density across the zone for the tool pages: rising to the right (r = x / width), and the glyphs' opacity with it.
export const rightWeight = (r: number): number => 0.2 + 1.8 * r * r;
export const rightOpacity = (r: number): number => 0.25 + 0.75 * r;

export const SLOW_STEP_MS = 7;
export const SLOW_STEPS = 30;

// The cost ladder: when the moving average of a step stays over 7 ms for 30 steps, the field halves its density, then
// drops to 20 frames a second, then stops on a still frame. It never climbs back within a page view.
export class Ladder {
  level = 0;
  private average = 0;
  private slow = 0;

  record(ms: number): 'halve' | 'slower' | 'still' | null {
    this.average = this.average === 0 ? ms : this.average * 0.9 + ms * 0.1;
    this.slow = this.average > SLOW_STEP_MS ? this.slow + 1 : 0;
    if (this.slow < SLOW_STEPS || this.level >= 3) return null;
    this.slow = 0;
    this.average = 0;
    this.level += 1;
    return this.level === 1 ? 'halve' : this.level === 2 ? 'slower' : 'still';
  }
}

export interface Drawable {
  draw(dt: number): void;
  full(): void;
  halve(): void;
}

export interface FieldEnv {
  hidden(): boolean;
  reduced(): boolean;
  now(): number;
}

// Runs a field through frameLoop: frames only while the zone is in view, the tab is shown and motion is allowed. The
// whole picture is painted once when the zone first shows (and after a resize); under reduced motion, or once the ladder
// says still, that picture stays and nothing else is drawn. Off screen or on a hidden tab nothing is drawn at all.
export class FieldLoop {
  visible = false;
  stopped = false;
  fps: number;
  readonly ladder = new Ladder();
  private loop: FrameLoop;
  private last = 0;
  private painted = false;
  private readonly rain: Drawable;
  private readonly env: FieldEnv;
  private readonly clock: FrameClock;

  constructor(rain: Drawable, fps: number, env: FieldEnv, clock: FrameClock) {
    this.rain = rain;
    this.env = env;
    this.clock = clock;
    this.fps = fps;
    this.loop = frameLoop(() => this.step(), fps, () => this.running(), clock);
  }

  running(): boolean {
    return this.visible && !this.env.hidden() && !this.env.reduced() && !this.stopped;
  }

  // A new picture is due (a resize, new weights, the face arrived): painted whole when the zone shows.
  invalidate(): void {
    this.painted = false;
    this.sync();
  }

  sync(): void {
    this.loop.sync();
    if (!this.running()) this.last = 0;
    if (!this.visible || this.env.hidden() || this.painted) return;
    this.painted = true;
    this.rain.full();
  }

  stop(): void {
    this.loop.stop();
  }

  private step(): void {
    const start = this.env.now();
    const dt = this.last ? Math.min(start - this.last, 100) / 1000 : 1 / this.fps;
    this.last = start;
    this.rain.draw(dt);
    const next = this.ladder.record(this.env.now() - start);
    if (next === 'halve') this.rain.halve();
    else if (next === 'slower') {
      this.loop.stop();
      this.fps = 20;
      this.loop = frameLoop(() => this.step(), 20, () => this.running(), this.clock);
      this.loop.sync();
    } else if (next === 'still') {
      this.stopped = true;
      this.sync();
    }
  }
}

// A zone of the dim table: cells whose centre lies inside take `dim` (0 clears them: no glyph crosses a control).
export interface DimZone {
  l: number;
  r: number;
  t: number;
  b: number;
  dim: number;
}

interface Stream {
  y: number;
  v: number;
  len: number;
  on: boolean;
  a: number;
  at: number;
  tail: number;
}

interface Decoder extends Stream {
  x: number;
  row: number;
  fired: boolean;
  cb: () => void;
}

export interface RainOptions {
  cell: number;
  density: number;
  // The family list of the mono face (--font-mono), read once by the page.
  font: string;
  // Density by x (css px) and opacity by x, as multipliers.
  weight?: ((x: number, width: number) => number) | null;
  opacity?: ((x: number, width: number) => number) | null;
}

type Ctx = CanvasRenderingContext2D;

export class Rain implements Drawable {
  cell: number;
  density: number;
  font: string;
  weight: RainOptions['weight'];
  opacity: RainOptions['opacity'];
  zones: DimZone[] = [];
  w = 0;
  h = 0;
  private cols = 0;
  private rows = 0;
  private dpr = 1;
  private grid = new Uint8Array(0);
  private dim = new Float32Array(0);
  private streams: Stream[] = [];
  private decoders: Decoder[] = [];
  private atlas: { img: CanvasImageSource; cw: number } | null = null;
  // Time gathered since the last fade: the trails fade every other frame, by the time that passed.
  private fadeDt = 0;
  private fadeNow = false;
  private readonly ctx: Ctx;
  private readonly makeCanvas: () => HTMLCanvasElement;

  constructor(ctx: Ctx, makeCanvas: () => HTMLCanvasElement, o: RainOptions) {
    this.ctx = ctx;
    this.makeCanvas = makeCanvas;
    this.cell = o.cell;
    this.density = o.density;
    this.font = o.font;
    this.weight = o.weight ?? null;
    this.opacity = o.opacity ?? null;
  }

  private chance(i: number): number {
    const x = i * this.cell;
    return Math.min(0.95, this.density * (this.weight ? this.weight(x, this.w) : 1));
  }

  private spawn(i: number, initial: boolean): Stream {
    const y = initial ? Math.random() * this.rows * 1.3 - this.rows * 0.3 : -Math.random() * this.rows * 0.3;
    const len = 14 + ((Math.random() * 27) | 0);
    return { y, v: 8 + Math.random() * 16, len, on: Math.random() < this.chance(i), a: 0.45 + Math.random() * 0.55, at: Math.floor(y), tail: Math.floor(y) - len + 1 };
  }

  buildAtlas(): void {
    const cell = this.cell;
    const cw = cell * this.dpr;
    const canvas = this.makeCanvas();
    canvas.width = Math.ceil(cw * GLYPHS.length);
    canvas.height = Math.ceil(cw * 3);
    const x = canvas.getContext('2d');
    if (!x) return;
    x.scale(this.dpr, this.dpr);
    x.font = `400 ${Math.round(cell * 0.72)}px ${this.font}`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    for (let i = 0; i < GLYPHS.length; i++) {
      const cx = i * cell + cell / 2;
      x.fillStyle = TRAIL;
      x.fillText(GLYPHS[i], cx, cell / 2);
      x.fillStyle = PALE;
      x.fillText(GLYPHS[i], cx, cell * 1.5);
      x.save();
      x.shadowColor = GLOW;
      x.shadowBlur = cell * 0.5;
      x.fillStyle = HEAD;
      x.fillText(GLYPHS[i], cx, cell * 2.5);
      x.restore();
    }
    this.atlas = { img: canvas, cw };
  }

  // A new size: the grid, the streams and the atlas are made again.
  resize(width: number, height: number, dpr: number): void {
    this.w = width;
    this.h = height;
    this.dpr = dpr;
    const canvas = this.ctx.canvas;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cols = Math.ceil(width / this.cell);
    this.rows = Math.ceil(height / this.cell) + 1;
    this.grid = new Uint8Array(this.cols * this.rows);
    for (let k = 0; k < this.grid.length; k++) this.grid[k] = (Math.random() * GLYPHS.length) | 0;
    this.streams = [];
    for (let i = 0; i < this.cols; i++) this.streams.push(this.spawn(i, true));
    this.buildAtlas();
    this.bake();
  }

  // The per-cell opacity table, from the zones and the opacity by x; made on resize and on new weights only.
  bake(): void {
    const { cols, rows, cell } = this;
    const table = new Float32Array(cols * rows);
    for (let i = 0; i < cols; i++) {
      const x = i * cell + cell / 2;
      const across = this.opacity ? this.opacity(x, this.w) : 1;
      for (let r = 0; r < rows; r++) {
        const y = r * cell + cell / 2;
        let d = across;
        for (const z of this.zones) if (x > z.l && x < z.r && y > z.t && y < z.b) d = Math.min(d, across * z.dim);
        table[i * rows + r] = d;
      }
    }
    this.dim = table;
  }

  // New zones only (the text over the field changed): the dim table again, and the cells a clearing zone now covers
  // cleared at once, so no glyph drawn before stays behind the new text; the streams go on as they are.
  rezone(zones: DimZone[]): void {
    this.zones = zones;
    this.bake();
    for (const z of zones) if (z.dim === 0) this.ctx.clearRect(z.l, z.t, z.r - z.l, z.b - z.t);
  }

  // New weights apply as streams restart; idle columns re-roll at once, so a dense zone fills within a second.
  settle(density: number, weight: RainOptions['weight'], zones: DimZone[]): void {
    this.density = density;
    if (weight !== undefined) this.weight = weight;
    this.zones = zones;
    this.bake();
    for (let i = 0; i < this.streams.length; i++) if (!this.streams[i].on) this.streams[i] = this.spawn(i, false);
  }

  halve(): void {
    this.density /= 2;
    for (let i = 0; i < this.streams.length; i++) if (this.streams[i].on && Math.random() < 0.5) this.streams[i].on = false;
  }

  // A bright stream that reaches `row` after `delay` ms and then calls `cb` (the headline decode).
  decoder(x: number, row: number, delay: number, cb: () => void): void {
    const v = 34;
    const y = row - (v * delay) / 1000;
    this.decoders.push({ x, y, v, len: 16, row, cb, fired: false, at: Math.floor(y), tail: Math.floor(y) - 15, on: true, a: 1 });
  }

  // One cell: cleared, then a glyph from atlas row `kind` (0 trail, 1 pale, 2 head) when it is bright enough to see.
  private put(x: number, r: number, g: number, kind: number, alpha: number): void {
    const c = this.cell;
    this.ctx.clearRect(x, r * c, c, c);
    if (alpha > 0.02 && this.atlas) {
      this.ctx.globalAlpha = Math.min(1, alpha);
      this.ctx.drawImage(this.atlas.img, g * this.atlas.cw, kind * this.atlas.cw, this.atlas.cw, this.atlas.cw, x, r * c, c, c);
    }
  }

  // The whole picture at once: the first frame and the still frame.
  full(): void {
    if (!this.w || !this.atlas) return;
    const { rows, cell, dim } = this;
    this.ctx.clearRect(0, 0, this.w, this.h);
    for (let i = 0; i < this.cols; i++) {
      const s = this.streams[i];
      if (!s.on) continue;
      const head = Math.floor(s.y);
      for (let k = 0; k < s.len; k++) {
        const r = head - k;
        if (r < 0 || r >= rows) continue;
        const shade = k === 0 ? 1.4 : k < 3 ? 1.05 : (1 - k / s.len) ** 1.25;
        this.put(i * cell, r, this.grid[i * rows + r], k === 0 ? 2 : k < 3 ? 1 : 0, shade * s.a * dim[i * rows + r]);
      }
    }
    this.ctx.globalAlpha = 1;
  }

  // A head moves to row `to`: the cells it leaves turn pale, the cell two behind takes the trail colour, the head is
  // drawn fresh and the cells past the trail's end are cleared. `quiet` only moves the end (a landed decoder).
  private step(s: Stream, x: number, col: number, to: number, flat: boolean, quiet: boolean): void {
    const { rows, grid, dim, cell } = this;
    const base = col * rows;
    const d = (row: number) => (flat ? 1 : dim[base + row]);
    if (!quiet) {
      for (let r = s.at; r < to; r++) {
        if (r >= 0 && r < rows) this.put(x, r, grid[base + r], 1, 1.05 * s.a * d(r));
        const t = r - 2;
        if (t >= 0 && t < rows) this.put(x, t, grid[base + t], 0, 0.85 * s.a * d(t));
      }
      if (to >= 0 && to < rows) this.put(x, to, grid[base + to], 2, 1.4 * s.a * d(to));
    }
    s.at = to;
    for (const end = to - s.len; s.tail <= end; s.tail++) if (s.tail >= 0 && s.tail < rows) this.ctx.clearRect(x, s.tail * cell, cell, cell);
  }

  // The fade, over the columns that hold a trail only (a column without a stream is already clear), every other frame:
  // on a canvas without a GPU it is the frame's largest cost, and it follows the area it covers.
  private fade(dt: number): void {
    this.fadeDt += dt;
    this.fadeNow = !this.fadeNow;
    if (!this.fadeNow) return;
    const { ctx, cell } = this;
    const lit = new Uint8Array(this.cols + 1);
    for (let i = 0; i < this.cols; i++) if (this.streams[i].on) lit[i] = 1;
    for (const dc of this.decoders) {
      const col = Math.floor(dc.x / cell);
      for (const c of [col, col + 1]) if (c >= 0 && c < this.cols) lit[c] = 1;
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(0, 0, 0, ${(1 - 0.925 ** (this.fadeDt * 30)).toFixed(3)})`;
    for (let i = 0, run = -1; i <= this.cols; i++) {
      if (lit[i] && run < 0) run = i;
      else if (!lit[i] && run >= 0) {
        ctx.fillRect(run * cell, 0, (i - run) * cell, this.h);
        run = -1;
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    this.fadeDt = 0;
  }

  draw(dt: number): void {
    if (!this.w || !this.atlas) return;
    const { ctx, cell, rows } = this;
    this.fade(dt);
    for (let i = 0; i < this.cols; i++) {
      const s = this.streams[i];
      s.y += s.v * dt;
      if (s.tail >= rows) {
        this.streams[i] = this.spawn(i, false);
        continue;
      }
      if (s.on) this.step(s, i * cell, i, Math.floor(s.y), false, false);
      else {
        s.at = Math.floor(s.y);
        s.tail = s.at - s.len + 1;
      }
    }
    // Four lit cells change their glyph, as the ledger is read.
    for (let m = 0; m < 4; m++) {
      const i = (Math.random() * this.cols) | 0;
      const s = this.streams[i];
      if (!s || !s.on) continue;
      const k = 3 + ((Math.random() * (s.len - 3)) | 0);
      const r = s.at - k;
      if (r < 0 || r >= rows) continue;
      const g = (this.grid[i * rows + r] = (Math.random() * GLYPHS.length) | 0);
      this.put(i * cell, r, g, 0, 0.7 * (1 - k / s.len) ** 1.25 * s.a * this.dim[i * rows + r]);
    }
    for (let i = this.decoders.length - 1; i >= 0; i--) {
      const dc = this.decoders[i];
      dc.y += dc.v * dt;
      if (!dc.fired && dc.y >= dc.row) {
        dc.fired = true;
        dc.cb();
      }
      const col = Math.min(this.cols - 1, Math.max(0, Math.round(dc.x / cell)));
      this.step(dc, dc.x, col, Math.min(Math.floor(dc.y), dc.row), true, dc.fired && dc.at >= dc.row);
      if (dc.fired) {
        dc.len = Math.max(0, dc.len - 1);
        if (!dc.len) this.decoders.splice(i, 1);
      }
    }
    ctx.globalAlpha = 1;
  }
}

// The zones that clear the cells under each line of text in a title band (B-SPEC 4.2, per-line clearing): one per line
// box, padded by half a cell, so every cell any part of which lies under a letter shows no glyph, while the space beside
// a short line keeps its rain. The boxes and the canvas in the same (viewport) coordinates.
export function lineZones(canvas: DOMRect, lines: Iterable<{ left: number; right: number; top: number; bottom: number }>, pad: number): DimZone[] {
  const zones: DimZone[] = [];
  for (const r of lines) {
    const zone = { l: r.left - canvas.left - pad, r: r.right - canvas.left + pad, t: r.top - canvas.top - pad, b: r.bottom - canvas.top + pad, dim: 0 };
    if (zone.b > 0 && zone.t < canvas.height && zone.r > 0 && zone.l < canvas.width) zones.push(zone);
  }
  return zones;
}

// The zones of the dim table from the elements marked data-field-clear (0) or data-field-dim="0.1" that overlap the
// canvas, in the canvas's own coordinates at the top of the page: an element of the fixed header sits where it is at
// scroll 0.
export function zonesFrom(canvas: DOMRect, scrollY: number, elements: Iterable<Element>, pad: number): DimZone[] {
  const zones: DimZone[] = [];
  const top = canvas.top + scrollY;
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const fixed = el.closest('[data-field-fixed]') !== null;
    const docTop = fixed ? r.top : r.top + scrollY;
    const raw = el.getAttribute('data-field-dim');
    const dim = raw === null ? 0 : Math.max(0, Math.min(1, Number(raw) || 0));
    const zone = { l: r.left - canvas.left - pad, r: r.right - canvas.left + pad, t: docTop - top - pad, b: docTop - top + r.height + pad, dim };
    if (zone.b > 0 && zone.t < canvas.height && zone.r > 0 && zone.l < canvas.width) zones.push(zone);
  }
  return zones;
}
