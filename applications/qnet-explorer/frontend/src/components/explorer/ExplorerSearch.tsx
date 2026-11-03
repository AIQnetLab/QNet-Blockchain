'use client';

// The explorer's search: one field with Search attached and a list of what the query matches under it
// (/api/search/suggest, 250 ms after typing stops). Arrow keys move through the list, Enter opens the active match (or
// the first), Escape closes it. A match opens with a full navigation. On a computer "/" focuses the field; nothing on
// the page shows that key.

import { useEffect, useId, useRef, useState } from 'react';
import TokenIcon from '@/components/TokenIcon';
import { useI18n } from '@/i18n/client';
import { heightOf, suggestionView, type Suggestion } from '@/lib/explorer-view';
import { siteRequest } from '@/lib/site-request';

const DEBOUNCE_MS = 250;

// The query's own page when nothing was suggested: a block height, a 64-hex hash, an address.
function directHref(q: string): string | null {
  const height = heightOf(q);
  if (height !== null) return `/explorer/block/${height}`;
  const v = q.replace(/,/g, '');
  if (v.length === 64 && /^[0-9A-Fa-f]+$/.test(v)) return `/explorer/tx/${v}`;
  if (v.length >= 38 && v.toLowerCase().includes('eon')) return `/explorer/address/${v}`;
  return null;
}

export default function ExplorerSearch({ className }: { className?: string }) {
  const { t, href: local } = useI18n();
  const id = useId();
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  // "/" anywhere outside a field focuses the search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (timer.current) clearTimeout(timer.current);
    if (!q) {
      abort.current?.abort();
      setItems([]);
      setOpen(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      try {
        const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(q.replace(/,/g, ''))}`, siteRequest({ signal: ac.signal }));
        const body = await res.json();
        if (ac.signal.aborted) return;
        setItems(Array.isArray(body?.results) ? body.results : []);
        setActive(-1);
        setOpen(true);
      } catch {
        if (ac.signal.aborted) return;
        setItems([]);
        setOpen(true);
      } finally {
        if (!ac.signal.aborted) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  // A match opens in the page's language.
  const go = (href: string) => {
    window.location.href = local(href);
  };
  const submit = () => {
    const pick = active >= 0 ? items[active] : items[0];
    if (pick) return go(pick.href);
    const href = directHref(query.trim());
    if (href) go(href);
  };

  const shown = open && query.trim() !== '';
  return (
    <form
      className={`ex-search${className ? ` ${className}` : ''}`}
      role="search"
      autoComplete="off"
      data-field-clear
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor={`${id}-q`}>{t('search_label')}</label>
      {/* One group at one height: the field and Search flush, focus marking the whole group (styles/explorer.css). */}
      <div className="ex-search-row">
        <input
          ref={input}
          id={`${id}-q`}
          className="ex-search-q"
          type="search"
          // The words a person reads stand in .ex-search-ph, short on a phone so they are never cut.
          placeholder=" "
          value={query}
          spellCheck={false}
          enterKeyHint="search"
          role="combobox"
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown && active >= 0 ? `${id}-o${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (query.trim() && items.length) setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        <span className="ex-search-ph" aria-hidden="true">
          <span className="ex-ph-long">{t('search_label')}</span>
          <span className="ex-ph-short">{t('search_short')}</span>
        </span>
        <button type="submit" className="btn btn-solid btn-sm ex-search-go">{t('search_go')}</button>
      </div>
      <div className="ex-sugg" id={listId} role="listbox" hidden={!shown} aria-label={t('search_matches')}>
        {searching && items.length === 0 && <p className="ex-sugg-note">{t('search_searching')}</p>}
        {!searching && items.length === 0 && <p className="ex-sugg-note">{t('search_nothing')}</p>}
        {items.map((s, i) => {
          const v = suggestionView(s, t);
          return (
            <a
              key={`${s.type}-${s.href}`}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={i === active}
              className="ex-sugg-opt"
              href={local(s.href)}
              onMouseDown={(e) => {
                e.preventDefault();
                go(s.href);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="ex-sugg-kind">
                {s.type === 'token' ? <TokenIcon logo={s.logo} symbol={s.symbol} address={s.address} size={20} /> : v.kind}
              </span>
              <span className="ex-sugg-val" translate="no">{v.value}</span>
              <span className="ex-sugg-note2">{v.note}</span>
            </a>
          );
        })}
      </div>
    </form>
  );
}
