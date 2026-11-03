'use client';

// Underlined tabs for switching views inside a block: a tab list whose arrow, Home and End keys move
// between tabs, and the one panel it controls. With a single way available the caller shows no tabs.

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n/client';

interface ViewTabsProps<K extends string> {
  items: readonly { key: K; label: ReactNode }[];
  value: K;
  onChange: (key: K) => void;
  // What the tabs choose between, for screen readers.
  label: string;
  // The panel of the selected tab.
  children: ReactNode;
  className?: string;
}

export default function ViewTabs<K extends string>({ items, value, onChange, label, children, className }: ViewTabsProps<K>) {
  const { dir } = useI18n();
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const tabId = (key: K) => `${base}-tab-${key}`;
  const panelId = `${base}-panel`;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = items.findIndex((item) => item.key === value);
    // The arrow toward the end of the line goes to the next tab: right in a left-to-right page, left in Arabic.
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const next = step ? at + (dir === 'rtl' ? -step : step) : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const item = items[(next + items.length) % items.length];
    onChange(item.key);
    list.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(item.key))}`)?.focus();
  };

  return (
    <div className={className}>
      <div className="tabs" role="tablist" aria-label={label} ref={list}>
        {items.map((item) => (
          <button
            key={item.key}
            id={tabId(item.key)}
            type="button"
            role="tab"
            className="tab"
            aria-selected={item.key === value}
            aria-controls={panelId}
            tabIndex={item.key === value ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={onKeyDown}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(value)}>
        {children}
      </div>
    </div>
  );
}
