'use client';

// QNC, the native coin (B-SPEC 6.6): no contract, so this is the coin's own view: its supply as readouts, the top
// holders (the node's rich list, /api/qnc) and the recent QNC transfers (the explorer's list, value types only). The
// server renders the first answers into the page (page.tsx), so the tables have their final rows from the first paint;
// both are read again as the chain head moves, at most every 10 s and only while the tab is shown.

import { useCallback, useEffect, useMemo, useState } from 'react';
import TokenIcon from '@/components/TokenIcon';
import OnHead from '@/components/explorer/OnHead';
import { TxAmount } from '@/components/explorer/cells';
import { amountCol, blockCol, fromToCol, hashCol, holderCols, timeCol } from '@/components/explorer/columns';
import DataTable from '@/components/ui/DataTable';
import { Amount } from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { useActivationContent } from '@/contexts/AppContext';
import { QNC_PATH, QNC_TRANSFERS_PATH } from '@/lib/explorer-reads';
import { rowAmount } from '@/lib/explorer-view';
import { number } from '@/lib/texts';
import type { FirstAnswer } from '@/server/first-answer';

interface QncHolder {
  address: string;
  balance: string; // exact QNC decimal, no unit
  percent: string;
}

interface GenesisAllocations {
  accounts: number;
  holding: number;
  balance: string; // exact QNC decimal, no unit
}

interface QncData {
  total_supply: string;
  circulating: string;
  burned: string;
  holder_count: number;
  genesis_allocations: GenesisAllocations | null;
  holders: QncHolder[];
}

interface QncTransfer {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount_raw: string; // nano QNC
  block: number | string;
  timestamp: number;
}

// The first answers of /api/qnc and /api/activity, read by the server (null: it had none, the client reads it).
export interface QncFirst {
  qnc: FirstAnswer | null;
  transfers: FirstAnswer | null;
}

const REFRESH_MS = 10_000;
const UNREADABLE = 'The supply and the holders cannot be read right now.';

// One reading of each answer, for the server's first answer and the client's later reads alike.
function readQnc(body: unknown): { data: QncData } | { error: string } {
  const result = body as { success?: boolean; holders?: unknown; error?: string } | null;
  if (result?.success && Array.isArray(result.holders)) return { data: result as unknown as QncData };
  return { error: result?.error || UNREADABLE };
}

function readTransfers(body: unknown): QncTransfer[] {
  const rows = (body as { data?: unknown } | null)?.data;
  return (Array.isArray(rows) ? rows : []).map((t: Partial<QncTransfer>) => ({
    hash: t.hash || '', type: t.type || 'Transfer', from: t.from || '', to: t.to || '', amount_raw: t.amount_raw || '0', block: t.block ?? 0, timestamp: t.timestamp ?? 0,
  }));
}

// `first` is absent while the route loads (loading.tsx): the page's final shape with nothing in it, and no reads.
export default function QncClient({ first }: { first?: QncFirst }) {
  // The app's view shows no burned supply (L-14).
  const full = useActivationContent();
  const [initial] = useState(() => (first?.qnc ? readQnc(first.qnc.body) : null));
  const [data, setData] = useState<QncData | null>(initial && 'data' in initial ? initial.data : null);
  const [error, setError] = useState<string | null>(initial && 'error' in initial ? initial.error : null);
  const [transfers, setTransfers] = useState<QncTransfer[] | null>(() => (first?.transfers ? readTransfers(first.transfers.body) : null));

  const fetchQnc = useCallback(async () => {
    try {
      const res = await fetch(QNC_PATH, { cache: 'no-store' });
      const read = readQnc(await res.json());
      if ('data' in read) {
        setData(read.data);
        setError(null);
      } else {
        setError(read.error);
      }
    } catch {
      setError(UNREADABLE);
    }
  }, []);

  // Recent native QNC transfers, from the main list (value-moving types only).
  const fetchTransfers = useCallback(async () => {
    try {
      const res = await fetch(QNC_TRANSFERS_PATH, { cache: 'no-store' });
      setTransfers(readTransfers(await res.json()));
    } catch {
      setTransfers((t) => t ?? []);
    }
  }, []);

  const refresh = useCallback(() => {
    void fetchQnc();
    void fetchTransfers();
  }, [fetchQnc, fetchTransfers]);
  // Only what the server could not read is read now.
  useEffect(() => {
    if (!first) return;
    if (!first.qnc) void fetchQnc();
    if (!first.transfers) void fetchTransfers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const holderColumns = useMemo(() => holderCols<QncHolder & { rank: number }>((h) => <Amount value={h.balance} />, full), [full]);

  const transferColumns = useMemo(() => [
    hashCol<QncTransfer>((t) => t.hash),
    fromToCol<QncTransfer>((t) => t.from, (t) => t.to, full),
    amountCol<QncTransfer>((t) => <TxAmount parts={rowAmount(t)} />),
    blockCol<QncTransfer>((t) => t.block),
    timeCol<QncTransfer>((t) => t.timestamp),
  ], [full]);

  const holders = data ? data.holders.map((h, i) => ({ ...h, rank: i + 1 })) : null;

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker="Native coin"
        title={<span className="ex-title-icon"><TokenIcon native size={44} />QNC</span>}
        more={(
          <div className="ex-ro" data-field-dim="0.1">
            <Readouts cols={4} size="tool" label="QNC supply">
              <Readout label="Total supply" value={data ? data.total_supply : null} amount={{ link: false }} sub="Issued so far" />
              <Readout label="Circulating" value={data ? data.circulating : null} amount={{ link: false }} sub="Held by accounts" />
              <Readout label="Holders" value={data ? number(data.holder_count) : null} sub="Accounts with a balance" />
              {full ? <Readout label="Burned" value={data ? data.burned : null} amount={{ link: false }} sub="Out of the supply" /> : <span />}
            </Readouts>
          </div>
        )}
      >
        <p className="ex-facts"><span>The coin of QNet Blockchain itself: it has no contract address.</span></p>
        {error && <p className="ex-error" role="status">{error}</p>}
      </PageHead>

      <div className="wrap ex-body">
        {first && <OnHead every={REFRESH_MS} onHead={refresh} />}
        <section className="ex-group">
          <DataTable
            stack="holders"
            title="Top holders"
            caption="The accounts holding the most QNC"
            columns={holderColumns}
            rows={holders}
            rowKey={(h) => h.address}
            loadingRows={10}
            empty={error ? 'The holders cannot be read right now.' : 'No holders yet.'}
          />
          {/* Under the table, so it moves nothing above it when a later answer brings it. */}
          {data?.genesis_allocations && data.genesis_allocations.accounts > 0 && (
            <p className="note">
              {number(data.genesis_allocations.accounts)} load-test accounts were funded in the genesis block for stress tests,
              holding {data.genesis_allocations.balance} QNC. Their keys are public; they are not part of the supply above and
              are left out of holders and shares.
            </p>
          )}
        </section>
        <DataTable
          title="Recent QNC transfers"
          caption="The newest QNC transfers"
          columns={transferColumns}
          rows={transfers}
          rowKey={(t) => t.hash}
          loadingRows={15}
          empty="No transfers yet."
        />
      </div>
    </div>
  );
}
