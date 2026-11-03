'use client';

// The token directory: every QRC-20 token deployed on QNet Blockchain, from the explorer's own index of
// deploy transactions (/api/tokens), with a filter and pages; and a lookup that opens a token by its contract address
// once the token route knows it. Each token, contract, deployer and deploy transaction is a link. The server renders
// the first page into the page (page.tsx), so the table has its final rows and count from the first paint.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { textCol } from '@/components/explorer/columns';
import DataTable from '@/components/ui/DataTable';
import EntityLink, { Amount } from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import Pager from '@/components/ui/Pager';
import { useI18n, useLocaleRouter } from '@/i18n/client';
import { TOKENS_PER_PAGE as PER_PAGE, tokensPath } from '@/lib/explorer-reads';
import { day, int } from '@/lib/format';
import { amountWidth, wordsWidth } from '@/lib/geometry';
import { siteRequest } from '@/lib/site-request';
import type { FirstAnswer } from '@/server/first-answer';

interface TokenListEntry {
  contract_address: string;
  name: string;
  symbol: string;
  decimals: number;
  deployer: string;
  total_supply: string;
  total_supply_raw: string;
  deployed_block: number;
  deployed_at: number;
  deploy_hash: string;
}

// A failed read has no rows and no count: what is shown stays, and the page says the directory could not be read.
interface Directory {
  tokens: TokenListEntry[] | null;
  total: number | null;
  failed: boolean;
}

// One reading of a directory answer, for the server's first answer and the client's later reads alike.
function readDirectory(ok: boolean, body: unknown): Directory {
  const result = body as { success?: boolean; data?: { tokens?: unknown; total?: unknown } } | null;
  if (ok && result?.success && result.data) {
    return { tokens: Array.isArray(result.data.tokens) ? (result.data.tokens as TokenListEntry[]) : [], total: Number(result.data.total) || 0, failed: false };
  }
  return { tokens: null, total: null, failed: true };
}

// `first` is the server's answer for the first page (null: it had none, the client reads it); absent while the route
// loads (loading.tsx): the page's final shape with nothing in it, and no reads.
export default function TokensClient({ first }: { first?: FirstAnswer | null }) {
  const { t, say } = useI18n();
  const router = useLocaleRouter();

  // Lookup by contract: checked against the token route before the page opens.
  const [contract, setContract] = useState('');
  const [checking, setChecking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const lookup = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const value = contract.trim();
    if (!value) {
      setLookupError(t('tokens_lookup_empty'));
      return;
    }
    setChecking(true);
    setLookupError(null);
    try {
      const res = await fetch(`/api/token/${encodeURIComponent(value)}`, siteRequest());
      const result = await res.json().catch(() => null);
      if (res.ok && result?.success) router.push(`/explorer/token/${value}`);
      else setLookupError(t('tokens_lookup_none'));
    } catch {
      setLookupError(t('tokens_lookup_unreachable'));
    } finally {
      setChecking(false);
    }
  }, [contract, router, t]);

  // The directory.
  const [initial] = useState(() => (first ? readDirectory(first.status < 400, first.body) : null));
  const [tokens, setTokens] = useState<TokenListEntry[] | null>(initial ? initial.tokens ?? [] : null);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [listFailed, setListFailed] = useState(initial ? initial.failed : false);
  // The read whose rows are on screen: the server's first page, when it read it.
  const shownPath = useRef(first ? tokensPath(1) : null);

  useEffect(() => {
    const path = tokensPath(page, search);
    // The loading state reads nothing, and rows already shown are not read again.
    if (first === undefined || path === shownPath.current) return;
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(path, siteRequest({ signal: controller.signal }));
        const body = await res.json().catch(() => null);
        if (!active) return;
        const read = readDirectory(res.ok, body);
        shownPath.current = path;
        setTokens((shown) => read.tokens ?? shown ?? []);
        if (read.total !== null) setTotal(read.total);
        setListFailed(read.failed);
      } catch (err) {
        if (!active || (err instanceof DOMException && err.name === 'AbortError')) return;
        setTokens((shown) => shown ?? []);
        setListFailed(true);
      }
    };
    // A short pause while the filter is typed.
    const timer = setTimeout(load, search ? 300 : 0);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [page, search, first]);

  const columns = useMemo(() => [
    textCol<TokenListEntry>('token', t('col_token'), (x) => <EntityLink kind="token" value={x.contract_address} symbol={x.name || x.symbol} />, 220),
    textCol<TokenListEntry>('symbol', t('tokens_symbol'), (x) => x.symbol || null, 104),
    // The same entity as the token cell's link, so plain text (one link per entity in a row).
    textCol<TokenListEntry>('contract', t('tx_contract'), (x) => <EntityLink kind="address" value={x.contract_address} link={false} />, undefined, undefined, 128),
    // As wide as the page's longest exact supply, so no amount runs into the next column.
    textCol<TokenListEntry>('supply', t('qnc_total'), (x) => <Amount value={x.total_supply} token={x.contract_address} symbol={x.symbol} />,
      amountWidth((tokens ?? []).map((x) => ({ value: x.total_supply, unit: x.symbol || t('token_unnamed') })), 220), 'right'),
    textCol<TokenListEntry>('deployer', t('tok_deployer'), (x) => <EntityLink kind="address" value={x.deployer} />, 156),
    textCol<TokenListEntry>('deployed', t('tok_deployed'), (x) => (x.deploy_hash ? <EntityLink kind="tx" value={x.deploy_hash} /> : null), 136),
    // Wider where the page's language writes a longer date ("28 окт. 2026 г."), so none is cut.
    textCol<TokenListEntry>('day', t('tokens_day'), (x) => (x.deployed_at ? day(x.deployed_at, t) : t('genesis')),
      Math.max(108, wordsWidth([...Array.from({ length: 12 }, (_, m) => day(Date.UTC(2026, m, 28), t)), t('genesis')])), 'right'),
  ], [t, tokens]);

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const listError = listFailed ? t('tokens_unreadable') : null;

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker={t('tokens_kicker')}
        title={t('tokens_title')}
        lead={say('tokens_lead')}
      >
        <form className="ex-lookup" onSubmit={(e) => void lookup(e)} data-field-clear>
          <label className="label form-label" htmlFor="token-lookup">{t('tokens_lookup_label')}</label>
          <div className="form-row">
            <input
              id="token-lookup"
              className="field"
              type="text"
              value={contract}
              onChange={(e) => setContract(e.target.value)}
              placeholder={t('tokens_lookup_placeholder')}
              disabled={checking}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={lookupError ? true : undefined}
              aria-describedby={lookupError ? 'token-lookup-error' : undefined}
            />
            <button type="submit" className="btn btn-solid" disabled={checking} aria-busy={checking || undefined}>
              <span className="swap"><span data-on={!checking}>{t('tokens_open')}</span><span data-on={checking}>{t('proof_checking')}</span></span>
            </button>
          </div>
          <p id="token-lookup-error" className="ex-error form-note" role="alert">{lookupError ?? '\u00a0'}</p>
        </form>
      </PageHead>

      <div className="wrap ex-body">
        <section className="ex-group">
          <DataTable
            title={t('tokens_all')}
            meta={<span className="label">{t('tokens_count', { count: tokens ? int(total) : '—' })}</span>}
            tools={(
              <div className="ex-filter-field">
                <label className="sr-only" htmlFor="token-filter">{t('tokens_filter')}</label>
                <input
                  id="token-filter"
                  className="field"
                  type="search"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder={t('tokens_filter')}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            )}
            caption={say('tokens_caption')}
            columns={columns}
            rows={tokens}
            rowKey={(x) => x.contract_address}
            loadingRows={PER_PAGE}
            error={listError && tokens && tokens.length > 0 ? listError : undefined}
            empty={listError ?? (search.trim() ? t('tokens_no_match') : t('tokens_none'))}
          />
          {total > PER_PAGE && <Pager page={page} pages={pages} total={total} onPage={(n) => setPage(Math.min(Math.max(1, n), pages))} />}
        </section>
      </div>
    </div>
  );
}
