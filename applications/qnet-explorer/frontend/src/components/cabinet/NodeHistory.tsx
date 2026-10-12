'use client';

// /node/history: the node's epochs one by one, newest first, from the wallet's first registration on (owner, 29.09 and
// 11.10): when each began and ended, counted or not (a super node outside the network's admission: not admitted, never
// not counted), the node balance it added and the transaction that moved it to the
// wallet (src/server/cabinet/node-proxy.ts history, with the explorer's archive), a page at a time with Show more. A
// light and a super node alike; a wallet with both has one list, since the network keeps the epochs per wallet. A
// wallet without a node gets the state its sources agree on, with the way on. The Overview shows the newest rows of the
// same table (Epochs).

import Link from 'next/link';
import { number, t, type MessageKey } from '@/lib/texts';
import { TAB_HREF } from '@/lib/cabinet/tabs';
import { useEpochList, useNodeHistory, type EpochList } from '@/hooks/useNodeStatus';
import { EPOCHS_KEPT, type HistoryResult, type HistoryRow, type HistoryView } from '@/lib/cabinet/node-view';
import CabinetFrame from './CabinetFrame';
import { useCabinet } from './CabinetProvider';
import { NoNode } from './NextSteps';

const RESULT_TEXT: Record<HistoryResult, MessageKey> = {
  counted: 'history_counted',
  moved: 'history_moved',
  missed: 'history_missed',
  joined: 'history_joined',
  unchecked: 'history_unchecked',
  not_admitted: 'history_not_admitted',
  unknown: 'history_unknown',
};

const AMOUNT = new Intl.NumberFormat('en', { maximumFractionDigits: 9 });
// In the viewer's own time zone.
const WHEN = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const TIME = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// When an epoch began and ended, the end's day only when it is another than the start's.
function span({ startedAt: start, endedAt: end }: HistoryRow): string {
  if (start === null && end === null) return '—';
  const sameDay = start !== null && end !== null && new Date(start).toDateString() === new Date(end).toDateString();
  return t('history_span', { start: start === null ? '—' : WHEN.format(start), end: end === null ? '—' : (sameDay ? TIME : WHEN).format(end) });
}

function Table({ rows }: { rows: HistoryRow[] }) {
  return (
    <div className="cabinet-table-wrap">
      <table className="cabinet-table">
        <thead>
          <tr>
            <th scope="col">{t('history_col_epoch')}</th>
            <th scope="col">{t('history_col_time')}</th>
            <th scope="col">{t('history_col_result')}</th>
            <th scope="col">{t('history_col_amount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.epoch} className={`cabinet-epoch ${row.result}`}>
              <td>{number(row.epoch)}</td>
              <td>{span(row)}</td>
              <td>{row.claimTx ? <Link href={`/explorer/tx/${row.claimTx}`}>{t(RESULT_TEXT[row.result])}</Link> : t(RESULT_TEXT[row.result])}</td>
              <td>{row.amountQnc === null ? '—' : `${AMOUNT.format(row.amountQnc)} QNC`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Show more while older epochs follow: off while it reads, and after a read that failed the error with Try again.
function More({ list }: { list: EpochList }) {
  if (!list.more) return null;
  const label: MessageKey = list.phase === 'reading' ? 'history_more_loading' : list.phase === 'failed' ? 'try_again' : 'history_more';
  return (
    <>
      {list.phase === 'failed' && <p className="activate-error" role="alert">{t('history_more_failed')}</p>}
      <button type="button" className="qnet-button secondary" onClick={list.showMore} disabled={list.phase === 'reading'}>{t(label)}</button>
    </>
  );
}

// Every epoch, a page at a time, with the notes its rows call for: an unreadable epoch the nodes no longer keep (as old
// as EPOCHS_KEPT behind the newest listed) is told apart from one they did not give now.
function AllEpochs({ nodeId, first }: { nodeId: string; first: HistoryView }) {
  const list = useEpochList(nodeId, first);
  const has = (result: HistoryResult) => list.rows.some((r) => r.result === result);
  const newest = list.rows.length > 0 ? list.rows[0].epoch : 0;
  const unknown = list.rows.filter((r) => r.result === 'unknown');
  return (
    <>
      <Table rows={list.rows} />
      <More list={list} />
      <p className="activate-note">{t('history_settled_note')}</p>
      {has('unchecked') && <p className="activate-note">{t('history_unchecked_note')}</p>}
      {has('not_admitted') && <p className="activate-note">{t('history_not_admitted_note')}</p>}
      {unknown.some((r) => newest - r.epoch < EPOCHS_KEPT) && <p className="activate-note">{t('history_unknown_note')}</p>}
      {unknown.some((r) => newest - r.epoch >= EPOCHS_KEPT) && <p className="activate-note">{t('history_retention_note')}</p>}
      {first.registeredEpoch === null && <p className="activate-note">{t('history_no_start')}</p>}
      {!first.archived && <p className="activate-note">{t('history_no_archive')}</p>}
    </>
  );
}

// The node's epochs as the network reports them: every one (History) or the newest few (the Overview).
export function Epochs({ nodeId, show }: { nodeId: string; show: 'all' | 'recent' }) {
  const { state, retry } = useNodeHistory(nodeId);
  if (state.phase === 'loading') return <p className="activate-status" aria-live="polite">{t('checking')}</p>;
  if (state.phase === 'unavailable') {
    return (
      <div role="alert">
        <p className="activate-error">{t('history_unavailable')}</p>
        <button type="button" className="qnet-button secondary" onClick={retry}>{t('try_again')}</button>
      </div>
    );
  }
  const view = state.value;
  if (view.rows.length === 0) return <p>{t('history_empty')}</p>;
  if (show === 'recent') {
    return (
      <>
        <Table rows={view.rows.slice(0, 6)} />
        <Link href={TAB_HREF.history} className="qnet-button secondary">{t('history_see_all')}</Link>
      </>
    );
  }
  return <AllEpochs nodeId={nodeId} first={view} />;
}

function EpochCard({ nodeId }: { nodeId: string }) {
  return (
    <div className="activate-card">
      <h3 className="activate-step">{t('history_epochs')}</h3>
      <p className="activate-note">{t('epoch_note')}</p>
      <Epochs nodeId={nodeId} show="all" />
    </div>
  );
}

// One list for the wallet, read by its light node's id, else its super node's (the nodes resolve either to the wallet,
// whose epochs they keep), whatever its light node's status read says.
function Section() {
  const { view, nodeId, superId } = useCabinet();
  if (view.state !== 'node') return <NoNode pending={view.state === 'recording'} />;
  const id = view.nodes.includes('light') && nodeId ? nodeId : view.nodes.includes('super') ? superId : null;
  return id ? <EpochCard key={id} nodeId={id} /> : null;
}

export default function NodeHistory() {
  const { choice } = useCabinet();
  return <CabinetFrame tab="history">{choice && <Section key={choice.qnet} />}</CabinetFrame>;
}
