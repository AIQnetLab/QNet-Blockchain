'use client';

// /node, the Overview (owner, 29.09; unified plan R4): the wallet's node and the one thing to do next, right here
// (NextSteps.tsx: the state of a wallet without a node, a known burn's code and next step, activate, Link a device in
// numbered steps; for an Offline device, under the readouts, running the node on the phone again, owner 11.10: the
// network wakes a phone that holds the node by itself every epoch, an app that is alive answers once it is opened, and a
// phone that lost the node cannot be woken). For a light node: the readouts (its state, this epoch, its node balance with
// Move to wallet, the last 12 epochs), its node balance (kept on QNet Blockchain) with the total earned (moved plus the
// node balance, NodeHistory.tsx Earned; owner, 13.10) and the ways to move it into the wallet (NodeClaim.tsx: the
// extension's window on this computer, or QNet Wallet; owner, 12.10), as from QNet Wallet's Node tab; what each epoch
// added; the latest epochs (every epoch on History; owner, 11.10: the epochs themselves, no count over a window); Node
// details (the activation code, the node type and id, the burn and its amount, the block the node was recorded at;
// NodeDetails.tsx). For a super node the same with its server's facts (online or not, or "Registered, not admitted to
// consensus yet" as the node's admission or the eligible set has it, when it was last seen, its heartbeats this epoch,
// the network's height and the server's) and the server's steps. A wallet with both shows both, light first. An address
// only viewed gets the public facts alone: no action, no device details. All of it follows the wallet, not the way it
// was connected: the network, the explorer's archive and the site's record for every wallet
// (src/lib/cabinet/wallet-activation.ts). A bare /node opens Activate only for a connected wallet with nothing anywhere
// (src/lib/cabinet/tabs.ts landingTab); ?tab=overview stays. While it is read, the Overview stands at its final size.

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Action from '@/components/ui/Action';
import EntityLink, { AmountUnit } from '@/components/ui/EntityLink';
import { EpochReadout } from '@/components/explorer/ChainReadouts';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { Failed } from '@/components/ui/RequestState';
import { useChainHead } from '@/hooks/useChainHead';
import { number, t } from '@/lib/texts';
import { rich } from '@/lib/rich';
import { useNodeStatus, useSuperStatus } from '@/hooks/useNodeStatus';
import { STATUS_KEPT_MS, canMove, formatQnc, type NodeStatusView, type SuperStatusView } from '@/lib/cabinet/node-view';
import { isClaimNodeId } from '@/lib/qnet-link';
import { TAB_HREF, landingTab } from '@/lib/cabinet/tabs';
import { lightSectionState } from '@/lib/cabinet/wallet-activation';
import CabinetFrame from './CabinetFrame';
import { useCabinet } from './CabinetProvider';
import { LastEpochsReadout, PerEpochChart } from './EpochCharts';
import LinkDevice from './LinkDevice';
import { LinkPhone, NoNode } from './NextSteps';
import { Move, useMoveWays } from './NodeClaim';
import NodeDetails, { lightStatusText, recordedText, useWalletActivation, type WalletActivation } from './NodeDetails';
import { Earned, RecentEpochs } from './NodeHistory';
import { MissLine, StatusGate, StatusReadout, SuperFacts, lightBadge, superBadge } from './NodeStatus';
import { Group, Next } from './parts';

// This epoch: its number, the node's word for it (answered or not, a super node's heartbeats), the time left and the
// line of its blocks done, from the chain's head (one shared stream; only this reading follows it every block).
const epochLabel = (epoch: ReactNode) => rich('ro_epoch', { epoch });
function ThisEpoch({ value }: { value: string | null }) {
  const { height } = useChainHead();
  return <EpochReadout height={height} reading={{ label: epochLabel, value }} />;
}

// The node balance as a reading, with Move to wallet down to its ways while at least 1 QNC can move.
function BalanceReadout({ balanceNano, move }: { balanceNano: string | null | undefined; move: boolean }) {
  return (
    <Readout
      label={t('balance_title')}
      value={balanceNano == null ? null : formatQnc(balanceNano)}
      amount={{}}
      wide
      sub={move ? <Action kind="solid" small href="#balance">{t('action_move')}</Action> : undefined}
    />
  );
}

// The node balance: the figure, the total earned and what was moved, and the ways to move it.
function Balance({ nodeId, balanceNano, children }: { nodeId: string; balanceNano: string | null; children?: ReactNode }) {
  return (
    <Group id="balance" title={t('balance_title')} className="cab-balance">
      <p className="cab-figure">
        {balanceNano === null ? <span className="dash">—</span> : formatQnc(balanceNano)}
        {' '}<AmountUnit />
      </p>
      {balanceNano === null && <p className="note">{t('balance_unknown')}</p>}
      {balanceNano !== null && !canMove(balanceNano) && <p className="note">{t('balance_min')}</p>}
      <Earned nodeId={nodeId} balanceNano={balanceNano} />
      {children ? (
        <div className="cab-move">
          <p className="body">{t('balance_lead')}</p>
          {children}
        </div>
      ) : (
        <p className="body">{t('balance_lead')}</p>
      )}
    </Group>
  );
}

// A wallet with both nodes: each node's group headed by its type and id.
function NodeHead({ title, nodeId }: { title: string; nodeId: string }) {
  const { choice } = useCabinet();
  return (
    <h2 className="cab-node-h">
      {title}
      <EntityLink kind="node" value={nodeId} address={choice?.qnet ?? null} />
    </h2>
  );
}

// The Overview's geometry while the node is read: the readouts with dashes, the epochs' empty rows. `nodeId`: the node
// whose epochs are read meanwhile, null while it is not known (nothing is asked then).
function Reading({ nodeId }: { nodeId: string | null }) {
  return (
    <div aria-busy="true">
      <Readouts cols={4} size="tool">
        <StatusReadout badge={undefined} />
        <ThisEpoch value={null} />
        <BalanceReadout balanceNano={undefined} move={false} />
        <LastEpochsReadout nodeId={nodeId} />
      </Readouts>
      <RecentEpochs nodeId={nodeId} />
    </div>
  );
}

function Summary({ nodeId, status, refresh, known }: { nodeId: string; status: NodeStatusView; refresh: () => void; known: WalletActivation }) {
  const { choice, viewOnly, view } = useCabinet();
  // A move the wallet answered keeps its report on screen once the balance, read again, falls below 1 QNC.
  const [moved, setMoved] = useState(false);
  const ways = useMoveWays(choice?.qnet ?? null);
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
  // A registered node's balance stays the wallet's to move with no device linked too (after its device was unlinked, say).
  const movable = canMove(status.balanceNano);
  const mayMove = !viewOnly && choice !== null && (ways.extension || ways.app);
  return (
    <>
      <Readouts cols={4} size="tool">
        <StatusReadout badge={lightBadge(status)} none={t('account_no_device')} />
        <ThisEpoch value={t(status.answeredThisEpoch ? 'ro_answered' : 'ro_not_answered')} />
        <BalanceReadout balanceNano={status.balanceNano} move={movable && mayMove} />
        <LastEpochsReadout nodeId={nodeId} />
      </Readouts>
      {/* Recorded with no device: Link your phone is the step now, so it leads (owner, 30.09). */}
      {state === 'no_device' && <LinkPhone onLinked={reread} />}
      {/* Offline: the latest epoch not counted, then the one thing to do, running the node on the phone again. */}
      {state === 'offline' && !viewOnly && <MissLine status={status} full={false} />}
      {state === 'offline' && !viewOnly && <LinkDevice onLinked={reread} relink />}
      {state === 'online' && <Next><p>{t('next_running')} {t('epoch_note')}</p></Next>}
      {state === 'device_pending' && <p className="note cab-epoch-note">{t('epoch_note')}</p>}
      <Balance nodeId={nodeId} balanceNano={status.balanceNano}>
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
      </Balance>
      <PerEpochChart nodeId={nodeId} />
      <RecentEpochs nodeId={nodeId} />
      {choice && <NodeDetails nodeId={nodeId} statusText={lightStatusText(state, known.facts?.height ?? null)} known={known} />}
    </>
  );
}

function LightOverview({ nodeId }: { nodeId: string }) {
  const { viewOnly } = useCabinet();
  const { state, retry, refresh } = useNodeStatus(nodeId, viewOnly);
  const known = useWalletActivation('light');
  return (
    <StatusGate state={state} retry={retry} loading={<Reading nodeId={nodeId} />}>
      {(status) => <Summary nodeId={nodeId} status={status} refresh={refresh} known={known} />}
    </StatusGate>
  );
}

// A super node on the network (R4): its readouts and server facts, balance (moved from here as a light node's is: the
// request names the super node; a genesis node's id names no wallet's node, so its balance is only shown), details with
// the server's steps and latest epochs.
function SuperOverview({ nodeId }: { nodeId: string }) {
  const { state, retry, refresh } = useSuperStatus(nodeId);
  const { choice, viewOnly } = useCabinet();
  const [moved, setMoved] = useState(false);
  const known = useWalletActivation('super');
  const ways = useMoveWays(choice?.qnet ?? null);
  if (state.phase === 'loading') return <Reading nodeId={nodeId} />;
  if (state.phase === 'unavailable') return <Failed action={{ label: t('try_again'), onClick: retry }}>{t('unreachable')}</Failed>;
  const status: SuperStatusView = state.value;
  const movable = isClaimNodeId(nodeId) && canMove(status.balanceNano);
  const beats = status.heartbeats;
  return (
    <>
      <Readouts cols={4} size="tool">
        <StatusReadout badge={status.registered ? superBadge(status) : undefined} />
        <ThisEpoch value={beats === null ? null : t('ro_heartbeats', { current: number(beats.current), required: number(beats.required) })} />
        <BalanceReadout balanceNano={status.balanceNano} move={movable && !viewOnly && choice !== null && (ways.extension || ways.app)} />
        <LastEpochsReadout nodeId={nodeId} />
      </Readouts>
      <Group title={t('super_title')}>
        {status.registered ? <SuperFacts status={status} /> : <p>{t(status.connected ? 'super_connected' : 'super_not_yet')}</p>}
        <p className="note">{t('epoch_note')}</p>
      </Group>
      <Balance nodeId={nodeId} balanceNano={status.balanceNano}>
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
      </Balance>
      <PerEpochChart nodeId={nodeId} />
      <RecentEpochs nodeId={nodeId} />
      <NodeDetails
        nodeType="super"
        nodeId={nodeId}
        statusText={recordedText(status.registered ? 'recorded' : 'none', status.registered ? known.facts?.height ?? null : null)}
        known={known}
      />
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
  // While the wallet's state is read, the Overview of a node stands in place: most wallets that come here have one.
  if (view.state === 'loading') return <Reading nodeId={null} />;
  if (view.state !== 'node') return <NoNode pending={view.state === 'recording'} overview />;
  const both = view.nodes.includes('light') && view.nodes.includes('super');
  return (
    <>
      {view.nodes.includes('light') && nodeId && (
        <section className="cab-node">
          {both && <NodeHead title={t('overview_title')} nodeId={nodeId} />}
          <LightOverview nodeId={nodeId} />
        </section>
      )}
      {view.nodes.includes('super') && superId && (
        <section className="cab-node">
          {both && <NodeHead title={t('super_title')} nodeId={superId} />}
          <SuperOverview nodeId={superId} />
        </section>
      )}
    </>
  );
}

export default function NodeHome({ explicit = false }: { explicit?: boolean }) {
  const { choice } = useCabinet();
  return <CabinetFrame tab="overview">{choice && <Overview key={choice.qnet} explicit={explicit} />}</CabinetFrame>;
}
