'use client';

// Copies a value to the clipboard; says so, or that the browser blocked it. `label`: the button's words, Copy by default.

import { useState } from 'react';
import { t } from '@/lib/texts';

export default function CopyButton({ value, label }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'blocked'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('blocked');
    }
  };
  return (
    <>
      <button type="button" className="qnet-button secondary activate-copy" onClick={() => void copy()}>
        {state === 'copied' ? t('copied') : label ?? t('copy')}
      </button>
      {state === 'blocked' && <span className="activate-note">{t('copy_blocked')}</span>}
    </>
  );
}
