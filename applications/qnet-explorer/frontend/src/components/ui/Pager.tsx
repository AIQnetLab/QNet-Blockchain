'use client';

// The pager under a table: Newer, the page numbers with ellipses, Older, and "Page 1 of 1,710 (85,491
// total)" at the right. Each is a 44 px tall target; the current page is filled. The data logic (page size, cursors,
// how far a jump may go) stays with the page that owns the list.

import { useT } from '@/i18n/client';
import { int } from '@/lib/format';

// The page numbers to show around `page` (1-based): the first, the last, two either side, ellipses between.
export function pageNumbers(page: number, pages: number): (number | null)[] {
  const out: (number | null)[] = [];
  const add = (n: number) => {
    if (n >= 1 && n <= pages && !out.includes(n)) out.push(n);
  };
  add(1);
  if (page - 2 > 2) out.push(null);
  for (let n = page - 2; n <= page + 2; n++) add(n);
  if (page + 2 < pages - 1) out.push(null);
  add(pages);
  return out;
}

interface PagerProps {
  page: number;
  pages: number;
  total?: number;
  onPage: (page: number) => void;
  // The highest page a number may jump to (the list's own cap); further pages are reached one at a time.
  maxJump?: number;
}

export default function Pager({ page, pages, total, onPage, maxJump }: PagerProps) {
  const t = useT();
  if (pages <= 0) return null;
  const numbers = pageNumbers(page, pages);
  return (
    <nav className="pager" aria-label={t('pager_label')}>
      <div className="pager-pages">
        <button type="button" className="pager-btn pager-step" onClick={() => onPage(page - 1)} disabled={page <= 1}>{t('pager_newer')}</button>
        {numbers.map((n, i) => n === null ? (
          <span key={`gap-${i}`} className="pager-gap" aria-hidden="true">…</span>
        ) : (
          <button
            key={n}
            type="button"
            className="pager-btn"
            aria-current={n === page ? 'page' : undefined}
            disabled={maxJump !== undefined && n > maxJump && Math.abs(n - page) > 1}
            onClick={() => onPage(n)}
          >
            {int(n)}
          </button>
        ))}
        <button type="button" className="pager-btn pager-step" onClick={() => onPage(page + 1)} disabled={page >= pages}>{t('pager_older')}</button>
      </div>
      <span>{total !== undefined ? t('pager_of_total', { page: int(page), pages: int(pages), total: int(total) }) : t('pager_of', { page: int(page), pages: int(pages) })}</span>
    </nav>
  );
}
