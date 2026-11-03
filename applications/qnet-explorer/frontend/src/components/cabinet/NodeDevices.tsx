'use client';

// /node/device, the Device tab: the device that runs the light node, from the public status's `device`, as one ledger
// entry (its state: Online, Offline, or a new device waiting for its first answer; its model and platform as it said
// when it linked, the UTC day it linked, whether it answered this epoch and the epoch of its last answer; for an address
// only viewed its state and epochs only, read without the device's details). With a device linked, the two actions side
// by side: "Move the node to another device", the same request that runs the node on a phone again, and "Unlink the
// device" (UnlinkDevice.tsx: the wallet signs it, the QNet extension that holds it or QNet Wallet on any device; the
// device's own form while the network does not take the wallet's). With none, Link a device in numbered steps
// (NextSteps.tsx LinkPhone). A super node runs on its server: no device to link, its server's status instead,
// or that it is not on the network yet. Without a node, the state the wallet's sources agree on and the way on
// (NextSteps.tsx). While the status is read, the ledger stands at its final size.

import { Readout, Readouts } from '@/components/ui/Readouts';
import { Failed, Waiting } from '@/components/ui/RequestState';
import { useNodeStatus, useSuperStatus } from '@/hooks/useNodeStatus';
import { STATUS_KEPT_MS, isLinkedState } from '@/lib/cabinet/node-view';
import { serverWord } from '@/lib/cabinet/server-words';
import { lightSectionState } from '@/lib/cabinet/wallet-activation';
import CabinetFrame from './CabinetFrame';
import { useCabinet } from './CabinetProvider';
import LinkDevice from './LinkDevice';
import { LinkPhone, NoNode } from './NextSteps';
import { DeviceRows, StatusGate, SuperRows } from './NodeStatus';
import UnlinkDevice from './UnlinkDevice';
import { Group } from './parts';
import { useI18n } from '@/i18n/client';

// The ledger's geometry while the status is read.
function Reading() {
  const { t } = useI18n();
  return (
    <div className="cab-dev" aria-busy="true">
      <div className="cab-dev-top">
        <div>
          <p className="label">{t('device_runs')}</p>
          <p className="cab-dev-name"><span className="dash">—</span></p>
        </div>
      </div>
      <Readouts cols={3} size="tool">
        <Readout label={t('device_since')} value={null} />
        <Readout label={t('device_answered')} value={null} />
        <Readout label={t('device_last')} value={null} />
      </Readouts>
    </div>
  );
}

function Devices({ nodeId }: { nodeId: string }) {
  const { t } = useI18n();
  const { viewOnly, view } = useCabinet();
  const { state, retry, refresh } = useNodeStatus(nodeId, viewOnly);
  return (
    <StatusGate state={state} retry={retry} loading={<Reading />}>
      {(status) => {
        // A node the network lists is recorded even while its status catches up (wallet-activation.ts).
        const s = lightSectionState(status, view);
        if (s === 'none' || s === 'pending') return <NoNode pending={s === 'pending'} />;
        // A reported link or unlink: the status is read again once the site's cache of it is over.
        const reread = () => window.setTimeout(refresh, STATUS_KEPT_MS + 1_000);
        // Which device runs it cannot be read now: said, with no step to link one (the status is read again by itself).
        if (s === 'device_unknown') return <DeviceRows status={status} />;
        // No device: the steps to link one, with Link a device in place.
        if (!isLinkedState(s)) return <LinkPhone onLinked={reread} />;
        return (
          <>
            <h2 className="sr-only">{t('device_title')}</h2>
            <DeviceRows status={status} full viewOnly={viewOnly} />
            <p className="note cab-dev-note">{t('devices_lead')}</p>
            {/* An address only viewed: nothing that needs the wallet. */}
            {!viewOnly && (
              <div className="cab-acts">
                <LinkDevice onLinked={reread} move />
                <UnlinkDevice status={status} onUnlinked={reread} />
              </div>
            )}
          </>
        );
      }}
    </StatusGate>
  );
}

// A super node: no device to link; its server's status.
function SuperServer({ nodeId }: { nodeId: string }) {
  const { t, say } = useI18n();
  const { state, retry } = useSuperStatus(nodeId);
  return (
    <Group title={say(serverWord(nodeId, 'title'))}>
      <p>{say(serverWord(nodeId, 'device'))}</p>
      {state.phase === 'loading' && <Waiting>{say(serverWord(nodeId, 'checking'))}</Waiting>}
      {state.phase === 'unavailable' && <Failed action={{ label: t('try_again'), onClick: retry }}>{say('unreachable')}</Failed>}
      {state.phase === 'ok' && (state.value.registered ? <SuperRows status={state.value} /> : <p>{say(state.value.connected ? 'super_connected' : 'super_not_yet')}</p>)}
    </Group>
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
