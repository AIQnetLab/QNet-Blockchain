'use client';

// The field inside a head zone (B-SPEC 4.2): one canvas, absolutely placed in its zone (never fixed to the viewport,
// never behind a table, a form or reading text). It runs through FieldLoop (src/lib/field/rain.ts): frames only while
// the zone is in view, the tab is shown and motion is allowed, at the page's frame and pixel-ratio caps; one still frame
// under reduced motion. Elements marked data-field-clear (controls, the search field) or data-field-dim="0.1" (text)
// dim the cells over them; in a title band (an ancestor marked data-field-band) every line of text and every icon
// clears the cells under it, line by line, and the band's content changing clears its new lines at once.

import { useEffect, useRef } from 'react';
import { FieldLoop, Rain, fieldCaps, lineZones, rightOpacity, rightWeight, zonesFrom, type DimZone, type FieldKind, type RainOptions } from '@/lib/field/rain';

export interface FieldApi {
  rain: Rain;
  canvas: HTMLCanvasElement;
  // Zones from the marked elements, in the canvas's coordinates.
  zones: () => DimZone[];
  // New density, weight by x and zones; the next still frame follows them.
  settle: (density: number, weight: RainOptions['weight'], zones: DimZone[]) => void;
}

interface FieldProps {
  // Share of columns with a stream (B-SPEC 4.2: home 0.75, explorer 0.55, My node 0.32, other pages 0.3).
  strength: number;
  kind?: FieldKind;
  // The canvas's opacity (My node .7).
  opacity?: number;
  // Tool pages weight the rain to the right; the home hero sets its own weights through onReady.
  weighting?: 'right' | 'none';
  onReady?: (api: FieldApi) => void;
}

const NARROW = '(max-width: 860px)';
const MARKED = '[data-field-clear], [data-field-dim]';

// The boxes of a band's lines of text (one per line of each text node) and of its icons.
function bandLines(band: Element): DOMRect[] {
  const out: DOMRect[] = [];
  const walker = document.createTreeWalker(band, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.trim()) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width && r.height) out.push(r);
  }
  for (const el of band.querySelectorAll('img, svg')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height) out.push(r);
  }
  return out;
}

export default function Field({ strength, kind = 'tool', opacity, weighting = 'right', onReady }: FieldProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const narrow = window.matchMedia(NARROW).matches;
    const caps = fieldCaps(kind, narrow);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    // next/font names the family by a hash; the canvas reads the mono stack once.
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
    const right = weighting === 'right';
    const rain = new Rain(ctx, () => document.createElement('canvas'), {
      cell: narrow ? 16 : 18,
      density: strength,
      font,
      weight: right ? (x, w) => rightWeight(w ? x / w : 0) : null,
      opacity: right ? (x, w) => rightOpacity(w ? x / w : 0) : null,
    });
    const loop = new FieldLoop(rain, caps.fps, { hidden: () => document.hidden, reduced: () => motion.matches, now: () => performance.now() }, window);
    const band = canvas.closest('[data-field-band]');
    const zones = () => {
      const box = canvas.getBoundingClientRect();
      const marked = zonesFrom(box, window.scrollY, document.querySelectorAll(MARKED), rain.cell / 2);
      return band ? [...marked, ...lineZones(box, bandLines(band), rain.cell / 2)] : marked;
    };

    // The band's text comes and changes after the first paint (a record read, an age counting on): its lines are
    // measured again once per batch of changes (the observer gathers them), and the table is made again only when a
    // line moved.
    let lines = '';
    const remeasure = () => {
      if (!rain.w) return;
      const next = zones();
      const key = next.map((z) => `${Math.round(z.l)},${Math.round(z.t)},${Math.round(z.r)},${Math.round(z.b)},${z.dim}`).join(';');
      if (key === lines) return;
      lines = key;
      rain.rezone(next);
      if (!loop.running()) loop.invalidate();
    };
    const edits = band ? new MutationObserver(remeasure) : null;
    if (band) edits?.observe(band, { childList: true, subtree: true, characterData: true });

    let size = '';
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
      if (!r.width || !r.height || key === size) return;
      size = key;
      rain.resize(r.width, r.height, Math.min(window.devicePixelRatio || 1, caps.dpr));
      rain.settle(rain.density, undefined, zones());
      lines = '';
      loop.invalidate();
    };
    const sizes = new ResizeObserver(resize);
    sizes.observe(canvas);
    const view = new IntersectionObserver((entries) => {
      loop.visible = entries[entries.length - 1].isIntersecting;
      loop.sync();
    });
    view.observe(canvas);
    const sync = () => loop.sync();
    document.addEventListener('visibilitychange', sync);
    motion.addEventListener('change', sync);
    // The atlas is drawn again once the mono face is in.
    const family = font.split(',')[0]?.trim();
    if (family && document.fonts) {
      void document.fonts.load(`400 13px ${family}`).then(() => {
        if (!rain.w) return;
        rain.buildAtlas();
        rain.settle(rain.density, undefined, zones());
        loop.invalidate();
      });
    }
    resize();
    ready.current?.({
      rain,
      canvas,
      zones,
      settle: (density, weight, next) => {
        rain.settle(density, weight, next);
        // A running field follows the new weights as streams restart; a still one is painted again.
        if (!loop.running()) loop.invalidate();
      },
    });
    return () => {
      loop.stop();
      edits?.disconnect();
      sizes.disconnect();
      view.disconnect();
      document.removeEventListener('visibilitychange', sync);
      motion.removeEventListener('change', sync);
    };
  }, [strength, kind, weighting]);

  return (
    <div className="field-zone" aria-hidden="true" style={opacity === undefined ? undefined : { opacity }}>
      <canvas ref={ref} className="field-canvas" />
    </div>
  );
}
