'use client';

// Copy, in one place for the site: a small act that answers "Copied" for 2.5 s, or "Select to copy" when the browser
// refuses both the clipboard and the fallback. Every label sits in one grid cell, so the width never changes; the labels
// are short, so that width stays close to the word "Copied".

import { useEffect, useRef, useState } from 'react';

type State = 'idle' | 'done' | 'blocked';

const SHOWN_MS = 2_500;

function fallbackCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

// `ariaLabel`: what a screen reader hears, naming what is copied ("Copy Merkle root"), where several Copy acts share a
// view; it keeps the visible label's words.
export default function Copy({ value, label = 'Copy', ariaLabel, className }: { value: string; label?: string; ariaLabel?: string; className?: string }) {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = (next: State) => {
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), SHOWN_MS);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      show('done');
    } catch {
      show(fallbackCopy(value) ? 'done' : 'blocked');
    }
  };

  const tone = state === 'done' ? ' done' : state === 'blocked' ? ' blocked' : '';
  return (
    <button type="button" className={`act copy${tone}${className ? ` ${className}` : ''}`} aria-label={ariaLabel ?? label} onClick={() => void copy()}>
      <span className="swap" aria-hidden="true">
        <span data-on={state === 'idle'}>{label}</span>
        <span data-on={state === 'done'}>Copied</span>
        <span data-on={state === 'blocked'}>Select to copy</span>
      </span>
      <span className="sr-only" aria-live="polite">{state === 'done' ? 'Copied' : state === 'blocked' ? 'Copying is blocked here: select the text to copy it' : ''}</span>
    </button>
  );
}
