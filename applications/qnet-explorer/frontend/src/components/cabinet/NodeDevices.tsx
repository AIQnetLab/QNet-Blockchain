'use client';

// /node/device, the Device tab: the device that runs the light node, from the public status's `device` (its state:
// Online, Offline, or a new device waiting for its first answer; its model and platform as it said when it linked, the
// UTC day it linked, whether it answered this epoch and the epoch of its last answer; for a typed address its platform,
// state and epochs only). With a device linked, "Unlink the device" (UnlinkDevice.tsx:
// the wallet signs it, the QNet extension that holds it or QNet Wallet on any device; the device's own form while the
// network does not take the wallet's) and "Move the node to another device"; an Offline device's row leads to the
// Overview, where I'm back is (owner, 04.10: one place only). With none, Link a device in numbered steps (NextSteps.tsx
// LinkPhone). A super node runs on its server: no device to link, its server's status instead (R3, R4). Without a node,
// the state the wallet's sources agree on and the way on (NextSteps.tsx).

import Link from 'next/link';
import { useNodeStatus, useSuperStatus } from '@/hooks/useNodeStatus';
import { t } from '@/lib/texts';
import { STATUS_KEPT_MS, isLinkedState } from '@/lib/cabinet/node-view';
import { TAB_HREF } from '@/lib/cabinet/tabs';
import { canWake } from '@/lib/cabinet/wake';
import { lightSectionState } from '@/lib/cabinet/wallet-activation';
import CabinetFrame from './CabinetFrame';
import { useCabinet } from './CabinetProvider';
import ConnectFirst from './ConnectFirst';
import LinkDevice from './LinkDevice';
import { LinkPhone, NoNode } from './NextSteps';
import { DeviceRows, StatusGate, SuperRows } from './NodeStatus';
import UnlinkDevice from './UnlinkDevice';

function Devices({ nodeId }: { nodeId: string }) {
  const { viewOnly, view } = useCabinet();
  const { state, retry, refresh } = useNodeStatus(nodeId);
  return (
    <StatusGate state={state} retry={retry}>
      {(status) => {
        // A node the network lists is recorded even while its status catches up (wallet-activation.ts).
        const s = lightSectionState(status, view);
        if (s === 'none' || s === 'pending') return <NoNode pending={s === 'pending'} />;
        // A reported link or unlink: the status is read again once the site's cache of it is over.
        const reread = () => window.setTimeout(refresh, STATUS_KEPT_MS + 1_000);
        // No device: the steps to link one, with Link a device in place.
        if (!isLinkedState(s)) return <LinkPhone onLinked={reread} />;
        return (
          <>
            <div className="activate-card">
              <h3 className="activate-step">{t('device_title')}</h3>
              <DeviceRows status={status} full viewOnly={viewOnly} />
              {s === 'offline' && canWake(status) && <p><Link href={TAB_HREF.overview}>{t('device_wake_overview')}</Link></p>}
              <p className="activate-note">{t('devices_lead')}</p>
            </div>
            {viewOnly ? <div className="activate-card"><ConnectFirst /></div> : (
              <>
                <UnlinkDevice status={status} onUnlinked={reread} />
                <LinkDevice onLinked={reread} move />
              </>
            )}
          </>
        );
      }}
    </StatusGate>
  );
}

// A super node: no device to link; its server's status.
function SuperServer({ nodeId }: { nodeId: string }) {
  const { state, retry } = useSuperStatus(nodeId);
  return (
    <div className="activate-card">
      <p>{t('super_device')}</p>
      {state.phase === 'loading' && <p className="activate-status" aria-live="polite">{t('super_status_checking')}</p>}
      {state.phase === 'unavailable' && (
        <div role="alert">
          <p className="activate-error">{t('unreachable')}</p>
          <button type="button" className="qnet-button secondary" onClick={retry}>{t('try_again')}</button>
        </div>
      )}
      {state.phase === 'ok' && state.value.registered && <SuperRows status={state.value} />}
    </div>
  );
}

function Section() {
  const { view, nodeId, superId } = useCabinet();
  if (view.state !== 'node') return <NoNode pending={view.state === 'recording'} />;
  return (
    <>
      {view.nodes.includes('light') && nodeId && <Devices key={nodeId} nodeId={nodeId} />}
      {view.nodes.includes('super') && superId && <SuperServer nodeId={superId} />}
    </>
  );
}

export default function NodeDevices() {
  const { choice } = useCabinet();
  return <CabinetFrame tab="device">{choice && <Section key={choice.qnet} />}</CabinetFrame>;
}
