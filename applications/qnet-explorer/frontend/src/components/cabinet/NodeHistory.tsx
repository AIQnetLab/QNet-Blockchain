'use client';

// /node/history: how many of the last epochs a genesis indexed were counted (the node's uptime index), the counted
// epochs still in the node balance, and every epoch of the node one by one since its registration (owner, 29.09): when
// it ended, counted or missed, the node balance it added and the transaction that moved it to the wallet
// (src/server/cabinet/node-proxy.ts history, with the explorer's archive). A super node's epochs the same way (R4). A
// wallet without a node gets the state its sources agree on, with the way on. The Overview shows the newest rows of the
// same table (Epochs).

import Link from 'next/link';
import { number, t, type MessageKey } from '@/lib/texts';
import { TAB_HREF } from '@/lib/cabinet/tabs';
import { useNodeHistory, useNodeStatus } from '@/hooks/useNodeStatus';
import type { HistoryResult, HistoryRow } from '@/lib/cabinet/node-view';
import { lightSectionState } from '@/lib/cabinet/wallet-activation';
import CabinetFrame from './CabinetFrame';
import { useCabinet } from './CabinetProvider';
import { NoNode } from './NextSteps';
import { CountedRow, StatusGate } from './NodeStatus';

const RESULT_TEXT: Record<HistoryResult, MessageKey> = {
  counted: 'history_counted',
  moved: 'history_moved',
  missed: 'history_missed',
  joined: 'history_joined',
  unchecked: 'history_unchecked',
  unknown: 'history_unknown',
};

const AMOUNT = new Intl.NumberFormat('en', { maximumFractionDigits: 9 });
const WHEN = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// `startKnown`: the node's registration epoch is known, so every epoch listed is one of the node's. Otherwise epochs from
// before it may be listed, and one the node was not counted in is not called missed.
function Table({ rows, startKnown }: { rows: HistoryRow[]; startKnown: boolean }) {
  return (
    <div className="cabinet-table-wrap">
      <table className="cabinet-table">
        <thead>
          <tr>
            <th scope="col">{t('history_col_epoch')}</th>
            <th scope="col">{t('history_col_ended')}</th>
            <th scope="col">{t('history_col_result')}</th>
            <th scope="col">{t('history_col_amount')}</th>
            <th scope="col">{t('history_col_moved')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.epoch} className={`cabinet-epoch ${row.result}`}>
              <td>{number(row.epoch)}</td>
              <td>{row.endedAt === null ? '—' : WHEN.format(row.endedAt)}</td>
              <td>{t(row.result === 'missed' && !startKnown ? 'history_not_counted' : RESULT_TEXT[row.result])}</td>
              <td>{row.amountQnc === null ? '—' : `${AMOUNT.format(row.amountQnc)} QNC`}</td>
              <td>
                {row.claimTx ? (
                  <Link href={`/explorer/tx/${row.claimTx}`} className="activate-mono">{`${row.claimTx.slice(0, 10)}…`}</Link>
                ) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The node's epochs as the network reports them. `show`: every epoch with the notes and the archive's earlier moves,
// the counted ones still in the node balance (both on History), or the newest few (the Overview).
export function Epochs({ nodeId, show }: { nodeId: string; show: 'all' | 'recent' | 'balance' }) {
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
  const startKnown = view.registeredEpoch !== null;
  if (show === 'balance') {
    const waiting = view.rows.filter((r) => r.result === 'counted');
    return waiting.length === 0 ? <p>{t('claim_epochs_none')}</p> : (
      <>
        <p className="activate-note">{t('claim_epochs_note')}</p>
        <Table rows={waiting} startKnown={startKnown} />
      </>
    );
  }
  if (view.rows.length === 0 && view.earlier.length === 0) return <p>{t('history_empty')}</p>;
  if (show === 'recent') {
    return (
      <>
        <Table rows={[...view.rows, ...view.earlier].slice(0, 6)} startKnown={startKnown} />
        <Link href={TAB_HREF.history} className="qnet-button secondary">{t('history_see_all')}</Link>
      </>
    );
  }
  return (
    <>
      {view.rows.length > 0 && <Table rows={view.rows} startKnown={startKnown} />}
      <p className="activate-note">{t('history_settled_note')}</p>
      {view.rows.some((r) => r.result === 'unchecked') && <p className="activate-note">{t('history_unchecked_note')}</p>}
      {!startKnown && <p className="activate-note">{t('history_no_start')}</p>}
      {!view.archived && <p className="activate-note">{t('history_no_archive')}</p>}
      {view.earlier.length > 0 && (
        <>
          <h4 className="cabinet-subtitle">{t('history_earlier')}</h4>
          <p className="activate-note">{t('history_earlier_note')}</p>
          <Table rows={view.earlier} startKnown={startKnown} />
        </>
      )}
    </>
  );
}

// A super node's epochs: counted and missed, the ones waiting to be moved, and every epoch.
function SuperHistory({ nodeId }: { nodeId: string }) {
  return (
    <>
      <div className="activate-card">
        <h3 className="activate-step">{t('claim_epochs_title')}</h3>
        <Epochs nodeId={nodeId} show="balance" />
        <p className="activate-note">{t('super_move')}</p>
      </div>
      <div className="activate-card">
        <h3 className="activate-step">{t('history_epochs')}</h3>
        <Epochs nodeId={nodeId} show="all" />
      </div>
    </>
  );
}

function History({ nodeId }: { nodeId: string }) {
  const { view } = useCabinet();
  const { state, retry } = useNodeStatus(nodeId);
  return (
    <StatusGate state={state} retry={retry}>
      {(status) => {
        // A node the network lists is recorded even while its status catches up (wallet-activation.ts).
        const s = lightSectionState(status, view);
        if (s === 'none' || s === 'pending') return <NoNode pending={s === 'pending'} />;
        return (
          <>
            <div className="activate-card">
              <CountedRow status={status} />
              <p>
                {status.counted.lastCountedEpoch === null
                  ? t('history_never_counted')
                  : t('history_last_counted', { epoch: number(status.counted.lastCountedEpoch) })}
              </p>
              <p className="activate-note">{t('epoch_note')}</p>
            </div>
            <div className="activate-card">
              <h3 className="activate-step">{t('claim_epochs_title')}</h3>
              <Epochs nodeId={nodeId} show="balance" />
            </div>
            <div className="activate-card">
              <h3 className="activate-step">{t('history_epochs')}</h3>
              <Epochs nodeId={nodeId} show="all" />
            </div>
          </>
        );
      }}
    </StatusGate>
  );
}

function Section() {
  const { view, nodeId, superId } = useCabinet();
  if (view.state !== 'node') return <NoNode pending={view.state === 'recording'} />;
  return (
    <>
      {view.nodes.includes('light') && nodeId && <History key={nodeId} nodeId={nodeId} />}
      {view.nodes.includes('super') && superId && <SuperHistory key={superId} nodeId={superId} />}
    </>
  );
}

export default function NodeHistory() {
  const { choice } = useCabinet();
  return <CabinetFrame tab="history">{choice && <Section key={choice.qnet} />}</CabinetFrame>;
}
