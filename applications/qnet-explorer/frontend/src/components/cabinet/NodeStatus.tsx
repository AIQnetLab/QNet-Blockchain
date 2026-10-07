'use client';

// A node's state in the words QNet Wallet uses (unified plan section 3.1): nothing about a light node is shown as
// final unless two genesis nodes said so, and "Online" never comes from anything but a linked device the network does
// not ask to come back (src/lib/cabinet/node-view.ts); a super node's server status as the nodes report it.
// A node's latest epoch not counted shows as one line with the device rows (src/lib/cabinet/last-miss.ts): epochs and
// reasons only, never the time of an answer or a wake.

import type { ReactNode } from 'react';
import { number, t, type MessageKey } from '@/lib/texts';
import type { Loaded } from '@/hooks/useNodeStatus';
import { canMove, deviceName, formatQnc, isLinkedState, nodeState, type NodeState, type NodeStatusView, type SuperStatusView } from '@/lib/cabinet/node-view';
import { deviceMiss, missText, shownMiss, type WakePlace } from '@/lib/cabinet/last-miss';
import { canWake } from '@/lib/cabinet/wake';

// Checking, unreachable (with Try again), or the view itself.
export function StatusGate({ state, retry, children }: { state: Loaded<NodeStatusView>; retry: () => void; children: (s: NodeStatusView) => ReactNode }) {
  if (state.phase === 'loading') return <p className="activate-status" aria-live="polite">{t('checking')}</p>;
  if (state.phase === 'unavailable') {
    return (
      <div role="alert">
        <p className="activate-error">{t('unreachable')}</p>
        <button type="button" className="qnet-button secondary" onClick={retry}>{t('try_again')}</button>
      </div>
    );
  }
  return <>{children(state.value)}</>;
}

const BADGE: Partial<Record<NodeState, { badge: MessageKey; text: MessageKey; tone: string }>> = {
  online: { badge: 'badge_online', text: 'device_state_online', tone: 'online' },
  offline: { badge: 'badge_offline', text: 'device_state_offline', tone: 'offline' },
  device_pending: { badge: 'badge_waiting', text: 'device_state_pending', tone: 'waiting' },
};

// The UTC day a device linked, as English writes it.
const DAY = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

// The latest epoch not counted, while it is newer than the last counted one; with `full` (the Device tab) also an
// earlier one that carries the device's own account of the wake (deviceMiss): what happened in that epoch, whether the
// wake reached the device when known, and what to do, in one line. `wake`: where I'm back is for the node.
function MissLine({ status, wake, full }: { status: NodeStatusView; wake: WakePlace; full: boolean }) {
  const miss = full ? deviceMiss(status) : shownMiss(status);
  if (!miss) return null;
  return <p>{missText(miss, status.device?.platform ?? null, wake)}</p>;
}

// The device rows: the device's state (Online, Offline, or a new device waiting for its first answer; else no device)
// and whether the node answered this epoch; with `full` (the Device tab) also the device's model and platform
// (node-view.ts deviceName), the day it linked and the epoch of its last answer, from the public status's `device`
// (none from a node of an earlier version: then the last counted epoch). Last, the latest epoch not counted: on the
// Device tab for an Online or Offline device (also once counted again, when the device told what happened to the
// wake), on the Overview beside the Offline state, where I'm back follows. `viewOnly` (a typed address): the platform,
// the state and the epochs only, no model, no day it linked and no miss.
// Shown for a node on the network only, also one listed while its status still catches up.
export function DeviceRows({ status, full = false, viewOnly = false }: { status: NodeStatusView; full?: boolean; viewOnly?: boolean }) {
  const state = nodeState(status);
  const shown = BADGE[state];
  if (!shown || !isLinkedState(state)) return <p>{t('no_device')}</p>;
  const device = status.device ?? null;
  const last = device ? device.lastAnswerEpoch : status.counted.lastCountedEpoch;
  const missed = !viewOnly && (state === 'offline' || (full && state === 'online'));
  const named = device && viewOnly ? { platform: device.platform, model: null } : device;
  const wake: WakePlace = state === 'offline' && canWake(status) ? (full ? 'overview' : 'here') : null;
  return (
    <>
      <p className="cabinet-badge-row">
        <span className={`cabinet-badge ${shown.tone}`}>{t(shown.badge)}</span>
        <span>{t(shown.text)}</span>
      </p>
      {full && named && deviceName(named) && <p>{deviceName(named)}</p>}
      {full && !viewOnly && device?.linkedSince != null && <p>{t('device_linked_since', { day: DAY.format(device.linkedSince * 1000) })}</p>}
      <p>{t(status.answeredThisEpoch ? 'answered_yes' : 'answered_no')}</p>
      {full && (device
        ? <p>{last === null ? t('device_no_answer') : t('device_last_answer', { epoch: number(last) })}</p>
        : <p>{last === null ? t('devices_not_counted') : t('devices_last_counted', { epoch: number(last) })}</p>)}
      {missed && <MissLine status={status} wake={wake} full={full} />}
    </>
  );
}

export function CountedRow({ status }: { status: NodeStatusView }) {
  return <p>{t('counted', { counted: number(status.counted.counted), total: number(status.counted.sinceRegistration) })}</p>;
}

// The balance of a light or a super node, and below 1 QNC the note that it moves from 1 QNC; the ways to move it follow
// it (NodeClaim.tsx Move, or QNet Wallet's Node tab for a super node).
export function BalanceRow({ status }: { status: Pick<NodeStatusView, 'balanceNano'> }) {
  if (status.balanceNano === null) return <p>{t('balance_unknown')}</p>;
  return (
    <div className="cabinet-balance">
      <p>{t('balance', { amount: formatQnc(status.balanceNano) })}</p>
      {!canMove(status.balanceNano) && <p className="activate-note">{t('balance_min')}</p>}
    </div>
  );
}

const TIME = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY_TIME = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// A time the page names (a reservation's or a hold's end): the hour today, else the day too.
export function shownTime(ms: number | null): string {
  if (ms === null) return '—';
  return ms - Date.now() < 12 * 3_600_000 ? TIME.format(ms) : DAY_TIME.format(ms);
}

// A super node's status rows (the Overview and the Device tab): online or not, when it was last seen, its heartbeats this
// epoch, and whether the network bars it.
export function SuperRows({ status }: { status: SuperStatusView }) {
  const online = status.online;
  return (
    <>
      <p className="cabinet-badge-row">
        <span className={`cabinet-badge ${online ? 'online' : 'offline'}`}>{t(online ? 'badge_online' : 'badge_offline')}</span>
        <span>{t(online ? 'super_online_note' : 'super_offline_note')}</span>
      </p>
      <p>{status.lastSeenAt === null ? t('super_last_seen_unknown') : t('super_last_seen', { time: shownTime(status.lastSeenAt) })}</p>
      <p>{status.heartbeats === null ? t('super_heartbeats_unknown') : t('super_heartbeats', { current: number(status.heartbeats.current), required: number(status.heartbeats.required) })}</p>
      {status.banned && <p className="activate-error">{t('super_barred')}</p>}
    </>
  );
}
