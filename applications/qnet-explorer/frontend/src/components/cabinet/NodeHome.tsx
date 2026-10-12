'use client';

// /node, the Overview (owner, 29.09; unified plan R4): the wallet's node and the one thing to do next, right here
// (NextSteps.tsx: the state of a wallet without a node, a known burn's code and next step, activate, Link a device in
// numbered steps; for an Offline device, inside the status card, running the node on the phone again, owner 11.10: the
// network wakes a phone that holds the node by itself every epoch, an app that is alive answers once it is opened, and a
// phone that lost the node cannot be woken); for a light node its balance (kept on QNet Blockchain), Node details (the
// activation code, the node type and id, the burn and its amount, the block the node was recorded at; NodeDetails.tsx)
// and the latest epochs; for a super node its status (online or not, or "Registered, waiting for network admission" as
// the node's admission or the eligible set has it, when it was last seen, its heartbeats this epoch, the network's
// height and the server's), its balance, its
// details with the server's steps and its latest epochs. A balance of either type is moved into the wallet from here
// with Move to wallet (NodeClaim.tsx: the extension's window on this computer, or QNet Wallet; owner, 12.10), as from
// QNet Wallet's Node tab; every epoch on History (owner, 11.10: no count over a window of recent epochs, the epochs
// themselves). A wallet with both shows both.
// All of it follows the wallet, not the way it was connected: the network, the explorer's archive and the site's record
// for every wallet (src/lib/cabinet/wallet-activation.ts). A bare /node opens Activate only for a connected wallet with
// nothing anywhere (src/lib/cabinet/tabs.ts landingTab); ?tab=overview stays.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { number, t } from '@/lib/texts';
import { useNodeStatus, useSuperStatus } from '@/hooks/useNodeStatus';
import { STATUS_KEPT_MS, canMove, isLinkedState, type NodeStatusView } from '@/lib/cabinet/node-view';
import { isClaimNodeId } from '@/lib/qnet-link';
import { TAB_HREF, landingTab } from '@/lib/cabinet/tabs';
import { lightSectionState } from '@/lib/cabinet/wallet-activation';
import CabinetFrame from './CabinetFrame';
import { useCabinet } from './CabinetProvider';
import ConnectFirst from './ConnectFirst';
import LinkDevice from './LinkDevice';
import { LinkPhone, NoNode } from './NextSteps';
import { Move } from './NodeClaim';
import NodeDetails, { lightStatusText, useWalletActivation, type WalletActivation } from './NodeDetails';
import { Epochs } from './NodeHistory';
import { BalanceRow, DeviceRows, StatusGate, SuperRows } from './NodeStatus';

function Summary({ nodeId, status, refresh, known }: { nodeId: string; status: NodeStatusView; refresh: () => void; known: WalletActivation }) {
  const { choice, viewOnly, view } = useCabinet();
  // A move the wallet answered keeps its report on screen once the balance, read again, falls below 1 QNC.
  const [moved, setMoved] = useState(false);
  // A node the network lists shows as recorded even while its status catches up (wallet-activation.ts).
  const state = lightSectionState(status, view);
  // A reported link or move: the status is read again once the site's cache of it is over.
  const reread = () => {
    window.setTimeout(refresh, STATUS_KEPT_MS + 1_000);
  };
  // No light node yet: the state the other sources agree on, with the activation behind a record on its way.
  if (state === 'none' || state === 'pending') {
    return (
      <>
        <NoNode pending={state === 'pending'} overview />
        {choice && state === 'pending' && <NodeDetails nodeId={nodeId} statusText={lightStatusText(state, null)} known={known} />}
      </>
    );
  }
  const linked = isLinkedState(state);
  // A registered node's balance stays the wallet's to move with no device linked too (after its device was unlinked, say).
  const movable = canMove(status.balanceNano);
  return (
    <>
      {/* Recorded with no device: Link your phone is the step now, so it leads (owner, 30.09). */}
      {state === 'no_device' && <LinkPhone onLinked={reread} />}
      <div className="activate-card">
        <h3 className="activate-step">{t('overview_title')}</h3>
        <DeviceRows status={status} viewOnly={viewOnly} />
        {/* Offline: the one thing to do, right under the device rows, is to run the node on the phone again. */}
        {state === 'offline' && !viewOnly && <LinkDevice onLinked={reread} relink />}
        {linked && <p className="activate-note">{t('epoch_note')}</p>}
        {state === 'online' && <p>{t('next_running')}</p>}
      </div>
      <div className="activate-card">
        <h3 className="activate-step">{t('balance_title')}</h3>
        <BalanceRow status={status} />
        <p className="activate-note">{t('balance_lead')}</p>
        {movable && viewOnly && <ConnectFirst />}
        {(movable || moved) && !viewOnly && choice && (
          <Move
            qnet={choice.qnet}
            nodeId={nodeId}
            movable={movable}
            onAnswer={() => {
              setMoved(true);
              reread();
            }}
          />
        )}
      </div>
      {choice && <NodeDetails nodeId={nodeId} statusText={lightStatusText(state, known.facts?.height ?? null)} known={known} />}
      <div className="activate-card">
        <h3 className="activate-step">{t('history_recent')}</h3>
        <Epochs nodeId={nodeId} show="recent" />
      </div>
    </>
  );
}

function LightOverview({ nodeId }: { nodeId: string }) {
  const { state, retry, refresh } = useNodeStatus(nodeId);
  const known = useWalletActivation('light');
  return <StatusGate state={state} retry={retry}>{(status) => <Summary nodeId={nodeId} status={status} refresh={refresh} known={known} />}</StatusGate>;
}

// A super node on the network (R4): its status, balance (moved from here as a light node's is: the request names the
// super node; a genesis node's id names no wallet's node, so its balance is only shown), details with the server's
// steps and latest epochs.
function SuperOverview({ nodeId }: { nodeId: string }) {
  const { state, retry, refresh } = useSuperStatus(nodeId);
  const { choice, viewOnly } = useCabinet();
  const [moved, setMoved] = useState(false);
  const known = useWalletActivation('super');
  if (state.phase === 'loading') return <p className="activate-status" aria-live="polite">{t('super_status_checking')}</p>;
  if (state.phase === 'unavailable') {
    return (
      <div role="alert">
        <p className="activate-error">{t('unreachable')}</p>
        <button type="button" className="qnet-button secondary" onClick={retry}>{t('try_again')}</button>
      </div>
    );
  }
  const status = state.value;
  const movable = isClaimNodeId(nodeId) && canMove(status.balanceNano);
  return (
    <>
      <div className="activate-card">
        <h3 className="activate-step">{t('super_title')}</h3>
        {status.registered ? <SuperRows status={status} /> : <p>{t(status.connected ? 'super_connected' : 'super_not_yet')}</p>}
        <p className="activate-note">{t('epoch_note')}</p>
      </div>
      <div className="activate-card">
        <h3 className="activate-step">{t('balance_title')}</h3>
        <BalanceRow status={status} />
        <p className="activate-note">{t('balance_lead')}</p>
        {movable && viewOnly && <ConnectFirst />}
        {(movable || moved) && !viewOnly && choice && (
          <Move
            qnet={choice.qnet}
            nodeId={nodeId}
            movable={movable}
            onAnswer={() => {
              setMoved(true);
              window.setTimeout(refresh, STATUS_KEPT_MS + 1_000);
            }}
          />
        )}
      </div>
      <NodeDetails
        nodeType="super"
        nodeId={nodeId}
        statusText={status.registered ? (known.facts?.height != null ? t('code_status_recorded_at', { height: number(known.facts.height) }) : t('code_status_recorded')) : t('code_status_not_yet')}
        known={known}
      />
      <div className="activate-card">
        <h3 className="activate-step">{t('history_recent')}</h3>
        <Epochs nodeId={nodeId} show="recent" />
      </div>
    </>
  );
}

function Overview({ explicit }: { explicit: boolean }) {
  const { viewOnly, view, nodeId, superId } = useCabinet();
  const router = useRouter();
  const landing = !explicit ? landingTab(view.state, viewOnly) : null;
  useEffect(() => {
    if (landing === 'activate') router.replace(TAB_HREF.activate);
  }, [landing, router]);
  if (landing === 'activate') return null;
  if (view.state !== 'node') return <NoNode pending={view.state === 'recording'} overview />;
  return (
    <>
      {view.nodes.includes('light') && nodeId && <LightOverview nodeId={nodeId} />}
      {view.nodes.includes('super') && superId && <SuperOverview nodeId={superId} />}
    </>
  );
}

export default function NodeHome({ explicit = false }: { explicit?: boolean }) {
  const { choice } = useCabinet();
  return <CabinetFrame tab="overview">{choice && <Overview key={choice.qnet} explicit={explicit} />}</CabinetFrame>;
}
