'use client';

// The token directory (B-SPEC 6.6): every QRC-20 token deployed on QNet Blockchain, from the explorer's own index of
// deploy transactions (/api/tokens), with a filter and pages; and a lookup that opens a token by its contract address
// once the token route knows it. Each token, contract, deployer and deploy transaction is a link. The server renders
// the first page into the page (page.tsx), so the table has its final rows and count from the first paint.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { textCol } from '@/components/explorer/columns';
import DataTable from '@/components/ui/DataTable';
import EntityLink, { Amount } from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import Pager from '@/components/ui/Pager';
import { TOKENS_PER_PAGE as PER_PAGE, tokensPath } from '@/lib/explorer-reads';
import { day, int } from '@/lib/format';
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

// A failed read has no rows and no count: what is shown stays.
interface Directory {
  tokens: TokenListEntry[] | null;
  total: number | null;
  error: string | null;
}

const UNREADABLE = 'The token directory cannot be read right now.';

// One reading of a directory answer, for the server's first answer and the client's later reads alike.
function readDirectory(ok: boolean, body: unknown): Directory {
  const result = body as { success?: boolean; data?: { tokens?: unknown; total?: unknown }; error?: string } | null;
  if (ok && result?.success && result.data) {
    return { tokens: Array.isArray(result.data.tokens) ? (result.data.tokens as TokenListEntry[]) : [], total: Number(result.data.total) || 0, error: null };
  }
  return { tokens: null, total: null, error: result?.error || UNREADABLE };
}

// `first` is the server's answer for the first page (null: it had none, the client reads it); absent while the route
// loads (loading.tsx): the page's final shape with nothing in it, and no reads.
export default function TokensClient({ first }: { first?: FirstAnswer | null }) {
  const router = useRouter();

  // Lookup by contract: checked against the token route before the page opens.
  const [contract, setContract] = useState('');
  const [checking, setChecking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const lookup = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const value = contract.trim();
    if (!value) {
      setLookupError('Enter a token contract address.');
      return;
    }
    setChecking(true);
    setLookupError(null);
    try {
      const res = await fetch(`/api/token/${encodeURIComponent(value)}`);
      const result = await res.json().catch(() => null);
      if (res.ok && result?.success) router.push(`/explorer/token/${value}`);
      else setLookupError(result?.error || 'No QRC-20 token found at that contract address.');
    } catch {
      setLookupError('Could not reach the token service. Try again.');
    } finally {
      setChecking(false);
    }
  }, [contract, router]);

  // The directory.
  const [initial] = useState(() => (first ? readDirectory(first.status < 400, first.body) : null));
  const [tokens, setTokens] = useState<TokenListEntry[] | null>(initial ? initial.tokens ?? [] : null);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [listError, setListError] = useState<string | null>(initial ? initial.error : null);
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
        const res = await fetch(path, { signal: controller.signal });
        const body = await res.json().catch(() => null);
        if (!active) return;
        const read = readDirectory(res.ok, body);
        shownPath.current = path;
        setTokens((shown) => read.tokens ?? shown ?? []);
        if (read.total !== null) setTotal(read.total);
        setListError(read.error);
      } catch (err) {
        if (!active || (err instanceof DOMException && err.name === 'AbortError')) return;
        setTokens((t) => t ?? []);
        setListError(UNREADABLE);
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
    textCol<TokenListEntry>('token', 'Token', (t) => <EntityLink kind="token" value={t.contract_address} symbol={t.name || t.symbol} />, 220),
    textCol<TokenListEntry>('symbol', 'Symbol', (t) => t.symbol || null, 104),
    // The same entity as the token cell's link, so plain text (one link per entity in a row).
    textCol<TokenListEntry>('contract', 'Contract', (t) => <EntityLink kind="address" value={t.contract_address} link={false} />, undefined, undefined, 128),
    textCol<TokenListEntry>('supply', 'Total supply', (t) => <Amount value={t.total_supply} token={t.contract_address} symbol={t.symbol} />, 220, 'right'),
    textCol<TokenListEntry>('deployer', 'Deployer', (t) => <EntityLink kind="address" value={t.deployer} />, 156),
    textCol<TokenListEntry>('deployed', 'Deployed', (t) => (t.deploy_hash ? <EntityLink kind="tx" value={t.deploy_hash} /> : null), 136),
    textCol<TokenListEntry>('day', 'Day', (t) => (t.deployed_at ? day(t.deployed_at) : 'Genesis'), 108, 'right'),
  ], []);

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker="Tokens"
        title="Token Directory"
        lead="Every QRC-20 token deployed on QNet Blockchain, from the explorer's own index of deploy transactions. A token also shows under Other tokens on the address page of anyone who holds it."
      >
        <form className="ex-lookup" onSubmit={(e) => void lookup(e)} data-field-clear>
          <label className="label form-label" htmlFor="token-lookup">Look up a QRC-20 token</label>
          <div className="form-row">
            <input
              id="token-lookup"
              className="field"
              type="text"
              value={contract}
              onChange={(e) => setContract(e.target.value)}
              placeholder="Token contract address"
              disabled={checking}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={lookupError ? true : undefined}
              aria-describedby={lookupError ? 'token-lookup-error' : undefined}
            />
            <button type="submit" className="btn btn-solid" disabled={checking} aria-busy={checking || undefined}>
              <span className="swap"><span data-on={!checking}>Open</span><span data-on={checking}>Checking…</span></span>
            </button>
          </div>
          <p id="token-lookup-error" className="ex-error form-note" role="alert">{lookupError ?? '\u00a0'}</p>
        </form>
      </PageHead>

      <div className="wrap ex-body">
        <section className="ex-group">
          <DataTable
            title="All tokens"
            meta={<span className="label">{tokens ? `${int(total)} tokens` : '— tokens'}</span>}
            tools={(
              <div className="ex-filter-field">
                <label className="sr-only" htmlFor="token-filter">Filter by symbol, name or contract address</label>
                <input
                  id="token-filter"
                  className="field"
                  type="search"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Filter by symbol, name or contract address"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            )}
            caption="QRC-20 tokens deployed on QNet Blockchain"
            columns={columns}
            rows={tokens}
            rowKey={(t) => t.contract_address}
            loadingRows={PER_PAGE}
            error={listError && tokens && tokens.length > 0 ? listError : undefined}
            empty={listError ?? (search.trim() ? 'No tokens match this filter.' : 'No QRC-20 tokens have been deployed yet.')}
          />
          {total > PER_PAGE && <Pager page={page} pages={pages} total={total} onPage={(n) => setPage(Math.min(Math.max(1, n), pages))} />}
        </section>
      </div>
    </div>
  );
}
