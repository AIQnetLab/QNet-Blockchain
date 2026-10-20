'use client';

// /node/history: the node's epochs one by one, newest first, from the wallet's first registration on (owner, 29.09 and
// 11.10): when each began and ended, counted or not (a super node outside the network's admission: not admitted, never
// not counted), the node balance it added and the transaction that moved it to the wallet
// (src/server/cabinet/node-proxy.ts history, with the explorer's archive), a page at a time with Show more. Under
// each epoch not counted, why, as the light node's shard owners keep it, in the Device tab's words (last-miss.ts
// MissText); none for an address only viewed. A light and a super node alike; a wallet with both has one list, since
// the network keeps the epochs per wallet. A wallet without a node gets the state its sources agree on, with the way
// on. The Overview shows the newest rows of the same table (Epochs). Above them, here and with the Overview's node
// balance, the total earned (Earned).

import { useEffect, useState } from 'react';
import Action from '@/components/ui/Action';
import DataTable, { type Column } from '@/components/ui/DataTable';
import EntityLink, { Amount, EpochNumber } from '@/components/ui/EntityLink';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { Failed, Waiting } from '@/components/ui/RequestState';
import { Dash } from '@/components/ui/Skeleton';
import { Status, type Tone } from '@/components/ui/Status';
import { t, type MessageKey } from '@/lib/texts';
import { TAB_HREF } from '@/lib/cabinet/tabs';
import { at, span as timeSpan } from '@/lib/format';
import { useEpochList, useNodeHistory, type EpochList } from '@/hooks/useNodeStatus';
import {
  EPOCHS_KEPT, HISTORY_KEPT_MS, earnedView, formatQnc, type HistoryResult, type HistoryRow, type HistoryView,
} from '@/lib/cabinet/node-view';
import CabinetFrame from './CabinetFrame';
import { useCabinet } from './CabinetProvider';
import { NoNode } from './NextSteps';
import { MissText } from './NodeStatus';
import { Group, Notes } from './parts';

const RESULT_TEXT: Record<HistoryResult, MessageKey> = {
  counted: 'history_counted',
  moved: 'history_moved',
  missed: 'history_missed',
  joined: 'history_joined',
  unchecked: 'history_unchecked',
  not_admitted: 'history_not_admitted',
  unknown: 'history_unknown',
};

// Counted is done, not counted needs the owner, the rest is the network's and quiet.
const RESULT_TONE: Record<HistoryResult, Tone> = {
  counted: 'done',
  moved: 'done',
  missed: 'needs',
  joined: 'quiet',
  unchecked: 'quiet',
  not_admitted: 'quiet',
  unknown: 'quiet',
};

export const resultText = (result: HistoryResult): string => t(RESULT_TEXT[result]);

const AMOUNT = new Intl.NumberFormat('en', { maximumFractionDigits: 9 });

// When an epoch began and ended, in the viewer's own time zone, the end's day only when it is another than the start's.
function span({ startedAt: start, endedAt: end }: HistoryRow): string {
  if (start !== null && end !== null) return timeSpan(start, end);
  return start === null && end === null ? '—' : t('history_span', { start: start === null ? '—' : at(start), end: end === null ? '—' : at(end) });
}

// The epoch and its result first, so a phone (360 to 430 px) shows both without scrolling sideways; when, what it added
// and the move after them.
const COLUMNS: Column<HistoryRow>[] = [
  { key: 'epoch', header: t('history_col_epoch'), width: 76, cell: (row) => <EpochNumber epoch={row.epoch} /> },
  { key: 'result', header: t('history_col_result'), width: 248, cell: (row) => <Status tone={RESULT_TONE[row.result]}>{resultText(row.result)}</Status> },
  { key: 'time', header: t('history_col_time'), min: 248, cell: (row) => span(row) },
  { key: 'amount', header: t('history_col_amount'), width: 200, align: 'right', cell: (row) => (row.amountQnc === null ? <Dash /> : <Amount value={AMOUNT.format(row.amountQnc)} />) },
  { key: 'tx', header: t('history_col_tx'), width: 132, align: 'right', cell: (row) => (row.claimTx ? <EntityLink kind="tx" value={row.claimTx} /> : <Dash />) },
];

// The epochs as one table: fixed columns and rows; `reasons` (History): under each epoch not counted whose miss an owner
// keeps, why, as one line across the row. The Overview names the latest miss beside the device's state instead.
function Table({ rows, reasons = false, loading = 6 }: { rows: HistoryRow[] | null; reasons?: boolean; loading?: number }) {
  const { devicePlatform } = useCabinet();
  return (
    <DataTable
      className="cab-epochs"
      caption={t('history_epochs')}
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => String(row.epoch)}
      loadingRows={loading}
      empty={t('history_empty')}
      detail={reasons ? (row) => (row.miss ? <><span className="cab-why">{t('history_why')}</span><MissText miss={row.miss} platform={devicePlatform} /></> : null) : undefined}
    />
  );
}

// Show more while older epochs follow: the waiting line while it reads, and after a read that failed the error with Try
// again. Older rows are added under the ones shown.
function More({ list }: { list: EpochList }) {
  if (!list.more) return null;
  if (list.phase === 'reading') return <div className="cab-more"><Waiting>{t('history_more_loading')}</Waiting></div>;
  if (list.phase === 'failed') return <div className="cab-more"><Failed action={{ label: t('try_again'), onClick: list.showMore }}>{t('history_more_failed')}</Failed></div>;
  return <div className="cab-more"><button type="button" className="btn btn-text" onClick={list.showMore}>{t('history_more')}</button></div>;
}

// Every epoch, a page at a time, with the notes its rows call for: an unreadable epoch the nodes no longer keep (as old
// as EPOCHS_KEPT behind the newest listed) is told apart from one they did not give now.
function AllEpochs({ nodeId, first }: { nodeId: string; first: HistoryView }) {
  const { viewOnly } = useCabinet();
  const list = useEpochList(nodeId, first, viewOnly);
  const has = (result: HistoryResult) => list.rows.some((r) => r.result === result);
  const newest = list.rows.length > 0 ? list.rows[0].epoch : 0;
  const unknown = list.rows.filter((r) => r.result === 'unknown');
  return (
    <>
      <Table rows={list.rows} reasons />
      <More list={list} />
      <Notes>
        <p className="note">{t('history_settled_note')}</p>
        {has('unchecked') && <p className="note">{t('history_unchecked_note')}</p>}
        {has('not_admitted') && <p className="note">{t('history_not_admitted_note')}</p>}
        {unknown.some((r) => newest - r.epoch < EPOCHS_KEPT) && <p className="note">{t('history_unknown_note')}</p>}
        {unknown.some((r) => newest - r.epoch >= EPOCHS_KEPT) && <p className="note">{t('history_retention_note')}</p>}
        {first.registeredEpoch === null && <p className="note">{t('history_no_start')}</p>}
        {!first.archived && <p className="note">{t('history_no_archive')}</p>}
      </Notes>
    </>
  );
}

// The node's epochs as the network reports them: every one (History) or the newest six (the Overview, with the way to
// every epoch). While they are read, the table stands with empty rows at its final height.
export function Epochs({ nodeId, show }: { nodeId: string | null; show: 'all' | 'recent' }) {
  const { viewOnly } = useCabinet();
  const { state, retry } = useNodeHistory(nodeId, viewOnly);
  if (state.phase === 'unavailable') return <Failed action={{ label: t('try_again'), onClick: retry }}>{t('history_unavailable')}</Failed>;
  const view = state.phase === 'ok' ? state.value : null;
  if (show === 'recent') return <Table rows={view ? view.rows.slice(0, 6) : null} />;
  return view && nodeId ? <AllEpochs nodeId={nodeId} first={view} /> : <Table rows={null} loading={10} />;
}

// The Overview's newest epochs, with the way to every epoch; empty rows while `nodeId` is not known.
export function RecentEpochs({ nodeId }: { nodeId: string | null }) {
  return (
    <Group title={t('history_recent')} meta={<Action href={TAB_HREF.history}>{t('history_see_all')}</Action>}>
      <Epochs nodeId={nodeId} show="recent" />
    </Group>
  );
}

// While the history's balance is not the one the page shows, the history is read again this many times: at once, then
// once the site's copy of it is over.
export const EARNED_RETRIES = 3;

// The total earned, moved to the wallet plus the node balance, with what was moved (node-view.ts earnedView), from the
// history's first page; `balanceNano`, the node balance the page shows (null where it shows none: History, which then
// names the history's own balance as a third reading). Public chain data, the same for a connected wallet and an address
// only viewed. Dashes while the history is read the first time.
export function Earned({ nodeId, balanceNano }: { nodeId: string; balanceNano: string | null }) {
  const { viewOnly } = useCabinet();
  const { state, refresh } = useNodeHistory(nodeId, viewOnly);
  const [tries, setTries] = useState(0);
  const earned = state.phase === 'ok' ? state.value.earned : null;
  const differs = earned !== null && balanceNano !== null && earned.balanceNano !== balanceNano;
  useEffect(() => {
    if (!differs) {
      setTries(0);
      return;
    }
    if (tries >= EARNED_RETRIES) return;
    const timer = window.setTimeout(() => {
      setTries((n) => n + 1);
      refresh();
    }, tries === 0 ? 0 : HISTORY_KEPT_MS + 1_000);
    return () => window.clearTimeout(timer);
  }, [differs, tries, refresh]);
  const shown = state.phase === 'loading' ? null : earnedView(earned, balanceNano, tries >= EARNED_RETRIES);
  const total = shown?.kind === 'total' ? shown : null;
  const sub = shown?.kind === 'reading' ? t('earned_reading') : shown?.kind === 'unknown' ? t('earned_unknown') : undefined;
  const qnc = (nano: string | null | undefined) => (nano == null ? null : formatQnc(nano));
  return (
    <Readouts cols={balanceNano === null ? 3 : 2} size="tool">
      <Readout label={t('ro_total_earned')} value={qnc(total?.totalNano)} amount={{}} sub={sub} wide />
      <Readout label={t('ro_moved')} value={qnc(total?.movedNano)} amount={{}} wide />
      {balanceNano === null && <Readout label={t('balance_title')} value={qnc(total?.balanceNano)} amount={{}} wide />}
    </Readouts>
  );
}

function EpochCard({ nodeId }: { nodeId: string }) {
  return (
    <>
      <div className="cab-earned"><Earned nodeId={nodeId} balanceNano={null} /></div>
      <Group>
        <Epochs nodeId={nodeId} show="all" />
      </Group>
    </>
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
