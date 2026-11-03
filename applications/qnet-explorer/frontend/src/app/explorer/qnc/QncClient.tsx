'use client';

// QNC, the native coin: no contract, so this is the coin's own view: its supply as readouts, the top
// holders (the node's rich list, /api/qnc) and the recent QNC transfers (the explorer's list, value types only). The
// server renders the first answers into the page (page.tsx), so the tables have their final rows from the first paint;
// both are read again as the chain head moves, at most every 10 s and only while the tab is shown.

import { useCallback, useEffect, useMemo, useState } from 'react';
import TokenIcon from '@/components/TokenIcon';
import OnHead from '@/components/explorer/OnHead';
import { TxAmount } from '@/components/explorer/cells';
import { amountCol, amountsWidth, blockCol, fromToCol, hashCol, holderCols, timeCol, useSteadyWidth } from '@/components/explorer/columns';
import DataTable from '@/components/ui/DataTable';
import { Amount } from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { useActivationContent } from '@/contexts/AppContext';
import { useI18n } from '@/i18n/client';
import { QNC_PATH, QNC_TRANSFERS_PATH } from '@/lib/explorer-reads';
import { rowAmount } from '@/lib/explorer-view';
import { siteRequest } from '@/lib/site-request';
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

// One reading of each answer, for the server's first answer and the client's later reads alike; a failed read shows
// the page's own words for it.
function readQnc(body: unknown): { data: QncData } | { failed: true } {
  const result = body as { success?: boolean; holders?: unknown } | null;
  if (result?.success && Array.isArray(result.holders)) return { data: result as unknown as QncData };
  return { failed: true };
}

function readTransfers(body: unknown): QncTransfer[] {
  const rows = (body as { data?: unknown } | null)?.data;
  return (Array.isArray(rows) ? rows : []).map((t: Partial<QncTransfer>) => ({
    hash: t.hash || '', type: t.type || 'Transfer', from: t.from || '', to: t.to || '', amount_raw: t.amount_raw || '0', block: t.block ?? 0, timestamp: t.timestamp ?? 0,
  }));
}

// `first` is absent while the route loads (loading.tsx): the page's final shape with nothing in it, and no reads.
export default function QncClient({ first }: { first?: QncFirst }) {
  const { t, say, rich } = useI18n();
  // The app's view shows no burned supply.
  const full = useActivationContent();
  const [initial] = useState(() => (first?.qnc ? readQnc(first.qnc.body) : null));
  const [data, setData] = useState<QncData | null>(initial && 'data' in initial ? initial.data : null);
  const [failed, setFailed] = useState(Boolean(initial && 'failed' in initial));
  const [transfers, setTransfers] = useState<QncTransfer[] | null>(() => (first?.transfers ? readTransfers(first.transfers.body) : null));

  const fetchQnc = useCallback(async () => {
    try {
      const res = await fetch(QNC_PATH, siteRequest());
      const read = readQnc(await res.json());
      if ('data' in read) {
        setData(read.data);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    }
  }, []);

  // Recent native QNC transfers, from the main list (value-moving types only).
  const fetchTransfers = useCallback(async () => {
    try {
      const res = await fetch(QNC_TRANSFERS_PATH, siteRequest());
      setTransfers(readTransfers(await res.json()));
    } catch {
      setTransfers((shown) => shown ?? []);
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

  // Each amount column as wide as its longest value (columns.tsx amountsWidth).
  const holderColumns = useMemo(
    () => holderCols<QncHolder & { rank: number }>(t, (h) => <Amount value={h.balance} />, full, (data?.holders ?? []).map((h) => ({ value: h.balance, unit: 'QNC' }))),
    [t, full, data?.holders],
  );

  // The transfers' amounts keep their widest width while the list refreshes, so From / To never moves under the reader.
  const transferAmountW = useSteadyWidth(useMemo(() => amountsWidth((transfers ?? []).map((x) => rowAmount(x, t('token_unnamed')))), [transfers, t]), 'qnc');
  const transferColumns = useMemo(() => [
    hashCol<QncTransfer>(t, (x) => x.hash),
    fromToCol<QncTransfer>(t, (x) => x.from, (x) => x.to, full),
    amountCol<QncTransfer>(t, (x) => <TxAmount parts={rowAmount(x, t('token_unnamed'))} />, t('col_amount'), transferAmountW),
    blockCol<QncTransfer>(t, (x) => x.block),
    timeCol<QncTransfer>(t, (x) => x.timestamp),
  ], [t, full, transferAmountW]);

  const holders = data ? data.holders.map((h, i) => ({ ...h, rank: i + 1 })) : null;

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker={t('qnc_kicker')}
        title={<span className="ex-title-icon" translate="no"><TokenIcon native size={44} />QNC</span>}
        more={(
          <div className="ex-ro" data-field-dim="0.1">
            <Readouts cols={4} size="tool" label={t('ro_supply')}>
              <Readout label={t('qnc_total')} value={data ? data.total_supply : null} amount={{ link: false }} sub={t('qnc_total_sub')} />
              <Readout label={t('ro_supply_sub')} value={data ? data.circulating : null} amount={{ link: false }} sub={t('qnc_circulating_sub')} />
              <Readout label={t('tok_holders')} value={data ? number(data.holder_count) : null} sub={t('qnc_holders_sub')} />
              {full ? <Readout label={t('qnc_burned')} value={data ? data.burned : null} amount={{ link: false }} sub={t('qnc_burned_sub')} /> : <span />}
            </Readouts>
          </div>
        )}
      >
        <p className="ex-facts"><span>{say('qnc_note')}</span></p>
        {failed && <p className="ex-error" role="status">{t('qnc_unreadable')}</p>}
      </PageHead>

      <div className="wrap ex-body">
        {first && <OnHead every={REFRESH_MS} onHead={refresh} />}
        <section className="ex-group">
          <DataTable
            stack="holders"
            title={t('qnc_top')}
            caption={t('qnc_top_caption')}
            columns={holderColumns}
            rows={holders}
            rowKey={(h) => h.address}
            loadingRows={10}
            empty={failed ? t('qnc_holders_unreadable') : t('qnc_no_holders')}
          />
          {/* Under the table, so it moves nothing above it when a later answer brings it. */}
          {data?.genesis_allocations && data.genesis_allocations.accounts > 0 && (
            <p className="note">
              {rich('qnc_load_test', {
                accounts: <span className="num" translate="no">{number(data.genesis_allocations.accounts)}</span>,
                amount: <span className="num" translate="no">{data.genesis_allocations.balance}</span>,
              })}
            </p>
          )}
        </section>
        <DataTable
          title={t('qnc_recent')}
          caption={t('qnc_recent_caption')}
          columns={transferColumns}
          rows={transfers}
          rowKey={(x) => x.hash}
          loadingRows={15}
          empty={t('qnc_no_transfers')}
        />
      </div>
    </div>
  );
}
