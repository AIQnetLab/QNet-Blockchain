'use client';

// The picture of one guide step (src/lib/cabinet/guide.ts): a phone, a computer's browser with the extension's window,
// or both, showing that step's screen with the button it presses ringed. Drawn from the scene's parts; every label is
// the site's text of its key. The step's words say the same, so the picture is hidden from screen readers.

import { useId, type ReactNode, type SVGProps } from 'react';
import { t } from '@/lib/texts';
import type { ButtonPart, Label, Part, Scene } from '@/lib/cabinet/guide';

const C = {
  body: '#020b12',
  frame: 'rgba(0, 229, 240, 0.55)',
  screen: '#071a26',
  bar: '#0b2531',
  text: '#e8ffff',
  muted: '#8fb3bb',
  line: 'rgba(143, 179, 187, 0.32)',
  cyan: '#00e5f0',
  onCyan: '#00181c',
  soft: 'rgba(0, 229, 240, 0.16)',
  hot: '#00ffff',
  white: '#ffffff',
  black: '#000000',
};

const SANS = "Inter, -apple-system, 'Segoe UI', sans-serif";
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

function say(label: Label): string {
  if (typeof label === 'string') return t(label);
  if ('raw' in label) return label.raw;
  return t(label.key, label.vars);
}

const isRaw = (label: Label) => typeof label !== 'string' && 'raw' in label;

// Lines of `text` that fit `width` at `size`, by the average glyph width of the face (`em`); at most `most` lines.
function wrap(text: string, width: number, size: number, em = 0.56, most = 4): string[] {
  const max = Math.max(4, Math.floor(width / (size * em)));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= max) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  if (lines.length <= most) return lines;
  const kept = lines.slice(0, most);
  // The last line ends in …: without its last word when … would not fit, and a single word is cut, never dropped.
  const last = kept[most - 1];
  const cut = last.length < max ? last : last.includes(' ') ? last.replace(/\s*\S*$/, '') : last.slice(0, max - 1);
  kept[most - 1] = `${cut}…`;
  return kept;
}

const GAP = 6;

interface Drawn {
  node: ReactNode;
  h: number;
}

function Ring({ x, y, w, h, r }: { x: number; y: number; w: number; h: number; r: number }) {
  return (
    <>
      <rect x={x - 5} y={y - 5} width={w + 10} height={h + 10} rx={r + 5} fill="none" stroke={C.hot} strokeWidth={3} opacity={0.2} />
      <rect x={x - 2.5} y={y - 2.5} width={w + 5} height={h + 5} rx={r + 2.5} fill="none" stroke={C.hot} strokeWidth={1.4} />
    </>
  );
}

function textLines(lines: string[], x: number, y: number, size: number, props: SVGProps<SVGTextElement>, lead = 1.25): ReactNode {
  return lines.map((line, i) => (
    <text key={i} x={x} y={y + size + i * size * lead} fontSize={size} {...props}>{line}</text>
  ));
}

function drawButton(b: ButtonPart, x: number, y: number, w: number, s: number, key: string): Drawn {
  const label = b.site ? say(b.label).toUpperCase() : say(b.label);
  const em = b.site ? 0.7 : 0.6;
  let size = 8.2 * s;
  while (size > 6 * s && label.length * size * em > w - 12) size -= 0.5;
  const lines = label.length * size * em > w - 12 ? wrap(label, w - 12, size, em, 2) : [label];
  const h = lines.length > 1 ? 10 * s + lines.length * size * 1.2 : 21 * s;
  const tone = b.tone ?? 'primary';
  const fill = tone === 'primary' ? C.cyan : tone === 'done' ? C.soft : 'none';
  const stroke = tone === 'secondary' ? C.frame : tone === 'done' ? 'none' : C.cyan;
  const color = tone === 'primary' ? C.onCyan : tone === 'done' ? C.muted : '#9ff6ff';
  const top = y + (h - lines.length * size * 1.2) / 2 - size * 0.12;
  return {
    h,
    node: (
      <g key={key}>
        {b.hot && <Ring x={x} y={y} w={w} h={h} r={5} />}
        <rect x={x} y={y} width={w} height={h} rx={5} fill={fill} stroke={stroke} strokeWidth={1} />
        {lines.map((line, i) => (
          <text key={i} x={x + w / 2} y={top + size + i * size * 1.2} fontSize={size} fontWeight={700} textAnchor="middle" fill={color} letterSpacing={b.site ? 0.4 : 0}>
            {line}
          </text>
        ))}
      </g>
    ),
  };
}

// A pattern that looks like a QR code and encodes nothing, so nobody scans a picture.
function FakeQr({ x, y, size }: { x: number; y: number; size: number }) {
  const n = 21;
  const cell = size / (n + 2);
  let seed = 7;
  const cells: string[] = [];
  const finder = (i: number, j: number) => {
    for (const [fi, fj] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      const a = i - fi;
      const b = j - fj;
      if (a >= 0 && a < 7 && b >= 0 && b < 7) return a === 0 || a === 6 || b === 0 || b === 6 || (a >= 2 && a <= 4 && b >= 2 && b <= 4);
    }
    return null;
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const f = finder(i, j);
      if (f === null ? (seed >> 16) % 3 === 0 : f) cells.push(`M${(j + 1) * cell} ${(i + 1) * cell}h${cell}v${cell}h${-cell}z`);
    }
  }
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={size} height={size} rx={3} fill={C.white} />
      <path d={cells.join('')} fill={C.black} />
    </g>
  );
}

// One part of a screen at `y`, `w` wide; `s` scales the type and the controls.
function drawPart(part: Part, x: number, y: number, w: number, s: number, key: string): Drawn {
  switch (part.kind) {
    case 'title': {
      const size = 9.6 * s;
      const lines = wrap(say(part.label), w, size, 0.58, 3);
      return { h: lines.length * size * 1.2, node: <g key={key}>{textLines(lines, x, y - 1, size, { fill: C.text, fontWeight: 700 }, 1.2)}</g> };
    }
    case 'small': {
      const size = 7.6 * s;
      const lines = wrap(say(part.label), w, size, 0.55, 3);
      const raw = isRaw(part.label);
      return { h: lines.length * size * 1.25, node: <g key={key}>{textLines(lines, x, y - 1, size, { fill: raw ? C.text : C.muted, fontFamily: raw ? MONO : SANS })}</g> };
    }
    case 'lines': {
      const widths = [1, 0.86, 0.93, 0.68, 0.8];
      const step = 8 * s;
      return {
        h: part.count * step - 4 * s,
        node: (
          <g key={key}>
            {Array.from({ length: part.count }, (_, i) => (
              <rect key={i} x={x} y={y + i * step} width={w * widths[i % widths.length] * (i === part.count - 1 && part.count > 1 ? 0.7 : 1)} height={4 * s} rx={2 * s} fill={C.line} />
            ))}
          </g>
        ),
      };
    }
    case 'button':
      return drawButton(part, x, y, w, s, key);
    case 'pair': {
      const half = (w - 6) / 2;
      // Side by side as the app and the extension show them, unless a label would not fit half the width: then stacked.
      const fits = [part.left, part.right].every((b) => say(b.label).length * 7.6 * s * 0.6 <= half - 12);
      if (!fits) {
        const top = drawButton(part.left, x, y, w, s, 'l');
        const below = drawButton(part.right, x, y + top.h + GAP, w, s, 'r');
        return { h: top.h + GAP + below.h, node: <g key={key}>{top.node}{below.node}</g> };
      }
      const left = drawButton(part.left, x, y, half, s, 'l');
      const right = drawButton(part.right, x + half + 6, y, half, s, 'r');
      return { h: Math.max(left.h, right.h), node: <g key={key}>{left.node}{right.node}</g> };
    }
    case 'field': {
      const size = 7.4 * s;
      const box = 17 * s;
      const labelH = part.label ? size * 1.5 : 0;
      const value = part.secret ? '••••••••' : part.value ? say(part.value) : '';
      const raw = part.value !== undefined && isRaw(part.value);
      const shown = wrap(value, w - 10, size, raw ? 0.62 : 0.55, 1)[0] ?? '';
      return {
        h: labelH + box,
        node: (
          <g key={key}>
            {part.label && <text x={x} y={y + size} fontSize={size} fill={C.muted}>{say(part.label)}</text>}
            {part.hot && <Ring x={x} y={y + labelH} w={w} h={box} r={4} />}
            <rect x={x} y={y + labelH} width={w} height={box} rx={4} fill="rgba(0, 0, 0, 0.45)" stroke={C.frame} strokeWidth={0.8} />
            {shown && (
              <text x={x + 5} y={y + labelH + box / 2 + size * 0.36} fontSize={size} fill={part.secret || raw ? C.text : C.muted} fontFamily={raw ? MONO : SANS}>
                {shown}
              </text>
            )}
          </g>
        ),
      };
    }
    case 'row': {
      const size = 7.4 * s;
      const raw = isRaw(part.value);
      return {
        h: size * 1.6,
        node: (
          <g key={key}>
            <text x={x} y={y + size} fontSize={size} fill={C.muted}>{say(part.label)}</text>
            <text x={x + w} y={y + size} fontSize={size} fontWeight={700} textAnchor="end" fill={C.text} fontFamily={raw ? MONO : SANS}>{say(part.value)}</text>
          </g>
        ),
      };
    }
    case 'check': {
      const size = 7.4 * s;
      const box = 9 * s;
      const lines = wrap(say(part.label), w - box - 5, size, 0.55, 2);
      return {
        h: Math.max(box + 1, lines.length * size * 1.25),
        node: (
          <g key={key}>
            <rect x={x} y={y + 0.5} width={box} height={box} rx={2} fill={C.cyan} />
            <path d={`M${x + box * 0.22} ${y + box * 0.55} l${box * 0.24} ${box * 0.24} l${box * 0.44} ${-box * 0.48}`} fill="none" stroke={C.onCyan} strokeWidth={1.4} />
            {textLines(lines, x + box + 5, y - 0.5, size, { fill: C.text })}
          </g>
        ),
      };
    }
    case 'words': {
      const cols = 3;
      const pillW = (w - 8) / cols;
      const pillH = 11 * s;
      const row = pillH + 3;
      return {
        h: 4 * row - 3,
        node: (
          <g key={key}>
            {Array.from({ length: 12 }, (_, i) => {
              const cx = x + (i % cols) * (pillW + 4);
              const cy = y + Math.floor(i / cols) * row;
              return (
                <g key={i}>
                  <rect x={cx} y={cy} width={pillW} height={pillH} rx={3} fill="rgba(0, 0, 0, 0.45)" stroke={C.line} strokeWidth={0.6} />
                  <text x={cx + 3} y={cy + pillH * 0.72} fontSize={6.4 * s} fill={C.muted}>{i + 1}</text>
                  <rect x={cx + 12 * s} y={cy + pillH / 2 - 1.5} width={pillW - 16 * s} height={3} rx={1.5} fill={C.line} />
                </g>
              );
            })}
          </g>
        ),
      };
    }
    case 'picks': {
      // The word's label, then its buttons, each a word drawn as a bar; the picked one filled.
      const size = 7.4 * s;
      const pillH = 12 * s;
      const pillW = (w - (part.count - 1) * 4) / part.count;
      return {
        h: size * 1.5 + pillH,
        node: (
          <g key={key}>
            <text x={x} y={y + size} fontSize={size} fill={C.muted}>{say(part.label)}</text>
            {Array.from({ length: part.count }, (_, i) => {
              const cx = x + i * (pillW + 4);
              const cy = y + size * 1.5;
              const on = i === part.chosen;
              return (
                <g key={i}>
                  <rect x={cx} y={cy} width={pillW} height={pillH} rx={pillH / 2} fill={on ? C.soft : 'rgba(0, 0, 0, 0.45)'} stroke={on ? C.cyan : C.line} strokeWidth={on ? 1 : 0.6} />
                  <rect x={cx + pillW * 0.22} y={cy + pillH / 2 - 1.5} width={pillW * 0.56} height={3} rx={1.5} fill={on ? C.cyan : C.line} />
                </g>
              );
            })}
          </g>
        ),
      };
    }
    case 'qr': {
      const size = Math.min(60 * s, w * 0.6);
      return { h: size, node: <FakeQr key={key} x={x + (w - size) / 2} y={y} size={size} /> };
    }
    case 'code': {
      const size = 7.8 * s;
      const box = 18 * s;
      return {
        h: box,
        node: (
          <g key={key}>
            <rect x={x} y={y} width={w} height={box} rx={4} fill="rgba(0, 0, 0, 0.5)" stroke={C.frame} strokeWidth={0.8} />
            <text x={x + w / 2} y={y + box / 2 + size * 0.36} fontSize={size} fontWeight={700} textAnchor="middle" fill={C.white} fontFamily={MONO}>
              {wrap(say(part.label), w - 8, size, 0.62, 1)[0]}
            </text>
          </g>
        ),
      };
    }
    case 'status': {
      const size = 7.6 * s;
      const lines = wrap(say(part.label), w - 10, size, 0.55, 3);
      return {
        h: lines.length * size * 1.25,
        node: (
          <g key={key}>
            <circle cx={x + 3} cy={y + size * 0.62} r={2.6} fill={C.cyan} />
            {textLines(lines, x + 10, y - 1, size, { fill: '#9adfe6' })}
          </g>
        ),
      };
    }
    case 'tabs': {
      const box = 15 * s;
      const each = (w - (part.items.length - 1) * 3) / part.items.length;
      // Smaller type where the longest label would not fit its tab, never below 5.
      const longest = Math.max(...part.items.map((item) => say(item).length));
      const size = Math.max(5, Math.min(7 * s, (each - 4) / (longest * 0.56)));
      return {
        h: box,
        node: (
          <g key={key}>
            {part.items.map((item, i) => {
              const cx = x + i * (each + 3);
              const on = i === part.current;
              return (
                <g key={i}>
                  <rect x={cx} y={y} width={each} height={box} rx={box / 2} fill={on ? 'rgba(0, 255, 255, 0.16)' : 'none'} stroke={on ? C.hot : C.line} strokeWidth={on ? 1 : 0.8} />
                  <text x={cx + each / 2} y={y + box / 2 + size * 0.36} fontSize={size} fontWeight={on ? 700 : 500} textAnchor="middle" fill={on ? C.white : C.muted}>
                    {wrap(say(item), each - 4, size, 0.56, 1)[0]}
                  </text>
                </g>
              );
            })}
          </g>
        ),
      };
    }
    case 'choice': {
      // Side by side as the Activate tab shows them on a computer, one under the other where they would not fit; the
      // selected card outlined.
      const cols = w >= 220 ? part.items.length : 1;
      const cardW = (w - (cols - 1) * 6) / cols;
      const name = 8.8 * s;
      const small = 7.2 * s;
      const notes = part.items.map((item) => wrap(say(item.note), cardW - 12, small, 0.55, 3));
      const nodes: ReactNode[] = [];
      let top = y;
      for (let first = 0; first < part.items.length; first += cols) {
        const row = part.items.slice(first, first + cols).map((item, col) => ({ item, col, i: first + col }));
        const most = Math.max(...row.map(({ i }) => notes[i].length));
        const h = 12 * s + name * 1.2 + small * (most * 1.25 + 1.1);
        const noteTop = top + 7 * s + name * 1.2;
        for (const { item, col, i } of row) {
          const cx = x + col * (cardW + 6);
          const on = i === part.current;
          nodes.push(
            <g key={i}>
              <rect x={cx} y={top} width={cardW} height={h} rx={6} fill={on ? 'rgba(0, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.35)'} stroke={on ? C.hot : C.line} strokeWidth={on ? 1.2 : 0.8} />
              <text x={cx + 6} y={top + 5 * s + name} fontSize={name} fontWeight={700} fill={on ? C.white : C.text}>{say(item.label)}</text>
              {textLines(notes[i], cx + 6, noteTop, small, { fill: C.muted })}
              <text x={cx + 6} y={noteTop + small * (most * 1.25 + 1.1)} fontSize={small} fontWeight={700} fill={C.cyan}>{say(item.price)}</text>
            </g>,
          );
        }
        top += h + GAP;
      }
      return { h: top - GAP - y, node: <g key={key}>{nodes}</g> };
    }
  }
}

// The parts of a screen, top to bottom from `y`, and where they end.
function layout(parts: Part[], x: number, y0: number, w: number, s = 1): { nodes: ReactNode[]; end: number } {
  let y = y0;
  const nodes = parts.map((part, index) => {
    const drawn = drawPart(part, x, y, w, s, `p${index}`);
    y += drawn.h + GAP;
    return drawn.node;
  });
  return { nodes, end: y - GAP };
}

// A phone or tablet, 164 × 224: QNet Wallet, or its own browser with the address it shows.
function Phone({ x, y, w, h, screen, url, urlHot, parts, clip, s = 1 }: {
  x: number; y: number; w: number; h: number; screen: 'app' | 'web'; url?: string; urlHot?: boolean; parts: Part[]; clip: string; s?: number;
}) {
  const web = screen === 'web' && url !== undefined;
  const inner = { x: x + 5, y: y + 5, w: w - 10, h: h - 10 };
  const top = web ? y + 42 : y + 24;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={18} fill={C.body} stroke={C.frame} strokeWidth={1.4} />
      <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} rx={14} fill={C.screen} />
      <rect x={x + w / 2 - 15} y={y + 9} width={30} height={5} rx={2.5} fill={C.body} />
      <clipPath id={clip}>
        <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} rx={14} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        {web && (
          <g>
            {urlHot && <Ring x={x + 12} y={y + 20} w={w - 24} h={15} r={7.5} />}
            <rect x={x + 12} y={y + 20} width={w - 24} height={15} rx={7.5} fill={C.bar} stroke={urlHot ? C.hot : 'none'} strokeWidth={0.8} />
            <text x={x + w / 2} y={y + 30.6} fontSize={7.8} textAnchor="middle" fill={C.text} fontFamily={MONO}>{url}</text>
          </g>
        )}
        {layout(parts, x + 13, top, w - 26, s).nodes}
      </g>
      <rect x={x + w / 2 - 17} y={y + h - 9} width={34} height={3} rx={1.5} fill={C.frame} opacity={0.6} />
    </g>
  );
}

const BROWSER_W = 320;
// On a phone the same browser is drawn narrower, so its words read at the size of the page's own small print: the
// extension's window then sits below the page's parts instead of beside them, or over the page when the page shows
// only placeholder lines.
const BROWSER_NARROW_W = 208;
const PAGE_S = 1.3;
const POPUP_S = 1.18;

// A computer's browser, as tall as what it shows; the extension's window over the right of the page (`narrow`: over
// its lower part).
function Browser({ scene, clip, narrow = false }: { scene: Extract<Scene, { frame: 'browser' }>; clip: string; narrow?: boolean }): { node: ReactNode; height: number; width: number } {
  const width = narrow ? BROWSER_NARROW_W : BROWSER_W;
  const x = 4;
  const y = 4;
  const w = width - 8;
  const pageW = scene.popup && !narrow ? 146 - 24 : w - 24;
  const page = layout(scene.parts, x + 12, y + 38, pageW, PAGE_S);
  const onlyLines = scene.parts.every((part) => part.kind === 'lines');
  // Where the extension's window starts, left and top, and its width.
  const popupX = narrow ? x + 8 : x + 146;
  const popupTop = narrow && !onlyLines ? page.end + 10 : y + 22;
  const popupW = narrow ? w - 16 : w - 146 - 4;
  const popup = scene.popup ? layout(scene.popup, popupX + 8, popupTop + 28, popupW - 16, POPUP_S) : null;
  const popupEnd = popup ? popup.end + 12 : 0;
  const h = Math.max(narrow ? 120 : 150, page.end + 18 - y, popupEnd + 10 - y);
  const address = scene.url ?? (scene.tab ? say(scene.tab) : '');
  const barEnd = scene.pin ? w - 30 : w - 8;
  return {
    width,
    height: h + 8,
    node: (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={10} fill={C.body} stroke={C.frame} strokeWidth={1.4} />
        <line x1={x} y1={y + 26} x2={x + w} y2={y + 26} stroke={C.frame} strokeWidth={0.8} />
        {[0, 1, 2].map((i) => <circle key={i} cx={x + 12 + i * 10} cy={y + 13} r={3} fill={C.line} />)}
        <rect x={x + 44} y={y + 5} width={barEnd - 44} height={16} rx={8} fill={C.bar} />
        <text x={x + 54} y={y + 16.2} fontSize={8.6} fill={C.text} fontFamily={scene.url ? MONO : SANS}>{address}</text>
        {scene.pin && (
          <g>
            <Ring x={x + w - 24} y={y + 5} w={16} h={16} r={4} />
            <rect x={x + w - 24} y={y + 5} width={16} height={16} rx={4} fill={C.bar} stroke={C.cyan} strokeWidth={1} />
            <text x={x + w - 16} y={y + 16.5} fontSize={9.5} fontWeight={800} textAnchor="middle" fill={C.cyan}>Q</text>
          </g>
        )}
        <clipPath id={clip}>
          <rect x={x + 1} y={y + 27} width={w - 2} height={h - 28} rx={9} />
        </clipPath>
        <g clipPath={`url(#${clip})`}>
          {page.nodes}
          {popup && (
            <g>
              <rect x={popupX} y={popupTop} width={popupW} height={popupEnd - popupTop} rx={8} fill="rgba(0, 0, 0, 0.5)" transform="translate(2 3)" />
              <rect x={popupX} y={popupTop} width={popupW} height={popupEnd - popupTop} rx={8} fill={C.screen} stroke={C.hot} strokeWidth={1} />
              <path d={`M${popupX} ${popupTop + 18} v-10 a8 8 0 0 1 8 -8 h${popupW - 16} a8 8 0 0 1 8 8 v10 z`} fill={C.bar} />
              <text x={popupX + 8} y={popupTop + 13} fontSize={8.4} fontWeight={700} fill={C.cyan}>{t('ui_ext_name')}</text>
              {popup.nodes}
            </g>
          )}
        </g>
      </g>
    ),
  };
}

// The computer's QR code and the phone that scanned it, 320 wide (`narrow`, on a phone: 236, the computer smaller).
const SCAN_W = 320;
const SCAN_NARROW_W = 236;

function Scan({ scene, clip, narrow = false }: { scene: Extract<Scene, { frame: 'scan' }>; clip: string; narrow?: boolean }) {
  const panelW = narrow ? 106 : 176;
  const page = narrow ? layout(scene.parts, 12, 58, 90, 1.2) : layout(scene.parts, 16, 58, 150, PAGE_S);
  const bottom = Math.max(page.end + 14, 150);
  return (
    <g>
      <rect x={4} y={30} width={panelW} height={bottom - 30} rx={9} fill={C.body} stroke={C.frame} strokeWidth={1.4} />
      <line x1={4} y1={48} x2={4 + panelW} y2={48} stroke={C.frame} strokeWidth={0.8} />
      {[0, 1, 2].map((i) => <circle key={i} cx={(narrow ? 12 : 15) + i * (narrow ? 7 : 9)} cy={39} r={narrow ? 2.2 : 2.6} fill={C.line} />)}
      <text x={narrow ? 33 : 46} y={42} fontSize={8} fill={C.text} fontFamily={MONO}>aiqnet.io/node</text>
      {page.nodes}
      <path d={narrow ? 'M 112 112 L 118 112' : 'M 184 112 L 198 112'} stroke={C.hot} strokeWidth={1.4} strokeDasharray="3 3" />
      <Phone x={narrow ? 120 : 202} y={4} w={narrow ? 112 : 114} h={212} screen="app" parts={scene.phone} clip={clip} s={1.1} />
    </g>
  );
}

// A computer's picture twice: as wide as a computer shows it, and narrower for a phone's screen, where the stylesheet
// shows it instead (globals.css, .guide-art-narrow).
function Both({ clip, wide, narrow }: { clip: string; wide: (clip: string) => { node: ReactNode; width: number; height: number }; narrow: (clip: string) => { node: ReactNode; width: number; height: number } }) {
  return (
    <>
      {[wide(`${clip}-w`), narrow(`${clip}-n`)].map((drawn, i) => (
        <svg key={i} className={`guide-art ${i === 0 ? 'guide-art-wide' : 'guide-art-narrow'}`} viewBox={`0 0 ${drawn.width} ${drawn.height}`} fontFamily={SANS} aria-hidden="true" focusable="false">
          {drawn.node}
        </svg>
      ))}
    </>
  );
}

export default function GuideArt({ scene }: { scene: Scene }) {
  const clip = `guide-art-${useId().replace(/:/g, '')}`;
  if (scene.frame === 'phone') {
    return (
      <svg className="guide-art guide-art-phone" viewBox="0 0 164 224" fontFamily={SANS} aria-hidden="true" focusable="false">
        <Phone x={6} y={4} w={152} h={216} screen={scene.screen} url={scene.url} urlHot={scene.urlHot} parts={scene.parts} clip={clip} />
      </svg>
    );
  }
  if (scene.frame === 'scan') {
    return (
      <Both
        clip={clip}
        wide={(id) => ({ node: <Scan scene={scene} clip={id} />, width: SCAN_W, height: 220 })}
        narrow={(id) => ({ node: <Scan scene={scene} clip={id} narrow />, width: SCAN_NARROW_W, height: 220 })}
      />
    );
  }
  return <Both clip={clip} wide={(id) => Browser({ scene, clip: id })} narrow={(id) => Browser({ scene, clip: id, narrow: true })} />;
}
