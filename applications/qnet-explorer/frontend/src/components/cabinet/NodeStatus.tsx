'use client';

// A node's state in the words QNet Wallet uses: nothing about a light node is shown as
// final unless two genesis nodes said so, and "Online" never comes from anything but a linked device the network does
// not ask to come back (src/lib/cabinet/node-view.ts); a super node's server status as the nodes report it, with the
// network's admission of it.
// A node's latest epoch not counted shows as one line with the device (src/lib/cabinet/last-miss.ts): epochs and
// reasons only, never the time of an answer or a wake.

import type { CSSProperties, ReactNode } from 'react';
import EntityLink, { EpochNumber } from '@/components/ui/EntityLink';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { Failed, Waiting } from '@/components/ui/RequestState';
import { LiveDot, Status, type Tone } from '@/components/ui/Status';
import { number, type MessageKey, type T } from '@/lib/texts';
import { named } from '@/lib/rich';
import type { Loaded } from '@/hooks/useNodeStatus';
import {
  SERVER_SYNC_BLOCKS, deviceName, isLinkedState, nodeState, shownHeartbeats, superState, type DevicePlatform, type NodeState, type NodeStatusView,
  type SuperStatusView,
} from '@/lib/cabinet/node-view';
import { deviceMiss, missParts, shownMiss, type LastMiss } from '@/lib/cabinet/last-miss';
import { clockAgo, clockAt, dayUtc } from '@/lib/format';
import { readoutLength } from '@/lib/geometry';
import { Fact, Facts } from './parts';
import { useI18n } from '@/i18n/client';

// Checking, unreachable (with Try again), or the view itself. `loading`: the section's final geometry while it is read,
// so nothing below it moves when the answer comes.
export function StatusGate({ state, retry, loading, children }: {
  state: Loaded<NodeStatusView>; retry: () => void; loading?: ReactNode; children: (s: NodeStatusView) => ReactNode;
}) {
  const { t, say } = useI18n();
  if (state.phase === 'loading') return loading ?? <Waiting>{say('checking')}</Waiting>;
  if (state.phase === 'unavailable') return <Failed action={{ label: t('try_again'), onClick: retry }}>{say('unreachable')}</Failed>;
  return <>{children(state.value)}</>;
}

export interface Badge {
  tone: Tone;
  word: MessageKey;
  text: MessageKey;
}

const BADGE: Partial<Record<NodeState, Badge>> = {
  online: { tone: 'live', word: 'badge_online', text: 'device_state_online' },
  offline: { tone: 'needs', word: 'badge_offline', text: 'device_state_offline' },
  device_pending: { tone: 'quiet', word: 'badge_waiting', text: 'device_state_pending' },
  device_unknown: { tone: 'quiet', word: 'badge_unknown', text: 'device_state_unknown' },
};

// A light node's state as a word and a sentence, while a device runs it (or was just linked to) or while which device
// does cannot be read; null otherwise (no device).
export function lightBadge(status: NodeStatusView): Badge | null {
  const state = nodeState(status);
  return isLinkedState(state) || state === 'device_unknown' ? BADGE[state] ?? null : null;
}

// A super node's state as a word and a sentence.
export function superBadge(status: SuperStatusView): Badge {
  const state = superState(status);
  if (state === 'waiting') return { tone: 'quiet', word: 'badge_waiting', text: 'super_waiting' };
  if (state === 'online') return { tone: 'live', word: 'badge_online', text: 'super_online_note' };
  return { tone: 'needs', word: 'badge_offline', text: 'super_offline_note' };
}

// The state word and its sentence on one line.
export function StateLine({ badge }: { badge: Badge }) {
  const { say } = useI18n();
  return (
    <p className="cab-state">
      <Status tone={badge.tone}>{say(badge.word)}</Status>
      <span>{say(badge.text)}</span>
    </p>
  );
}

// The Status reading of a light or a super node: the word (the live dot while it runs) over its sentence; "—" while
// the status is read.
export function StatusReadout({ badge, none }: { badge: Badge | null | undefined; none?: string }) {
  const { t, say } = useI18n();
  if (badge === undefined) return <Readout label={t('ro_status')} value={null} />;
  if (badge === null) return <Readout label={t('ro_status')} value={none ?? t('badge_offline')} sub={t('no_device')} subTone="needs" />;
  return (
    <Readout
      label={t('ro_status')}
      value={t(badge.word)}
      mark={badge.tone === 'live' ? <LiveDot /> : undefined}
      sub={say(badge.text)}
      subTone={badge.tone === 'needs' ? 'needs' : undefined}
    />
  );
}

// A miss's line (last-miss.ts missParts): what happened in that epoch, its number a link, then the rest.
export function MissText({ miss, platform }: { miss: LastMiss; platform: DevicePlatform | null }) {
  const { t, rich } = useI18n();
  const { what, rest } = missParts(miss, platform, t);
  return <>{rich(what, { epoch: <EpochNumber epoch={miss.epoch} /> })} {named(rest)}</>;
}

// The latest epoch not counted, while it is newer than the last counted one; with `full` (the Device tab) also an
// earlier one that carries the device's own account of the wake (deviceMiss): what happened in that epoch, whether the
// wake reached the device when known, and what to do, in one line under an Ember label.
export function MissLine({ status, full }: { status: NodeStatusView; full: boolean }) {
  const { rich } = useI18n();
  const miss = full ? deviceMiss(status) : shownMiss(status);
  if (!miss) return null;
  return (
    <div className="cab-miss">
      <p className="label">{rich('device_miss_label', { epoch: <EpochNumber epoch={miss.epoch} /> })}</p>
      <p><MissText miss={miss} platform={status.device?.platform ?? null} /></p>
    </div>
  );
}

// The device that runs the light node: its state (Online, Offline, or a new device waiting for its first answer; not
// known while no answer can say; else no device); with `full` (the Device tab) as one ledger entry, its model and platform (node-view.ts deviceName) and the
// readings: the day it linked, whether it answered this epoch and the epoch of its last answer, from the public status's
// `device` (none from a node of an earlier version: then the last counted epoch). Last, the latest epoch not counted: on
// the Device tab for an Online or Offline device (also once counted again, when the device told what happened to the
// wake), elsewhere beside the Offline state. `viewOnly` (an address only viewed, whose status comes without them,
// node-view.ts publicStatus): the network's facts only, the state and the epochs; no platform, no model, no day it linked
// and no miss, which are the owner's device details.
export function DeviceRows({ status, full = false, viewOnly = false }: { status: NodeStatusView; full?: boolean; viewOnly?: boolean }) {
  const { t, rich } = useI18n();
  const state = nodeState(status);
  const badge = lightBadge(status);
  if (!badge) return <p>{t('no_device')}</p>;
  // Which device runs the node cannot be read now: said, with no device's readings.
  if (state === 'device_unknown') return <StateLine badge={badge} />;
  const device = status.device ?? null;
  const last = device ? device.lastAnswerEpoch : status.counted.lastCountedEpoch;
  const missed = !viewOnly && (state === 'offline' || (full && state === 'online'));
  const named = viewOnly ? null : device;
  return (
    <>
      {full ? (
        <div className="cab-dev">
          <div className="cab-dev-top">
            <div>
              <p className="label">{t('device_runs')}</p>
              {named && deviceName(named, t) && <p className="cab-dev-name">{deviceName(named, t)}</p>}
            </div>
            <StateLine badge={badge} />
          </div>
          <Readouts cols={viewOnly ? 2 : 3} size="tool">
            {!viewOnly && <Readout label={t('device_since')} value={device?.linkedSince != null ? dayUtc(device.linkedSince * 1000, t) : null} />}
            <Readout label={t('device_answered')} value={t(status.answeredThisEpoch ? 'device_yes' : 'ro_not_answered')} />
            {last === null ? (
              <Readout label={t(device ? 'device_last' : 'device_last_counted')} value={t(device ? 'device_no_answer' : 'device_none_counted')} />
            ) : (
              // "Epoch 287", the number the one EntityLink to that epoch, at the readout's size.
              <Readout label={t(device ? 'device_last' : 'device_last_counted')} value={null}>
                <span className="ro-v" style={{ '--ro-len': readoutLength(t('device_epoch', { epoch: number(last) })) } as CSSProperties}>
                  {rich('device_epoch', { epoch: <EpochNumber epoch={last} /> })}
                </span>
              </Readout>
            )}
          </Readouts>
        </div>
      ) : (
        <StateLine badge={badge} />
      )}
      {missed && <MissLine status={status} full={full} />}
    </>
  );
}

// A time the page names (a reservation's or a hold's end): the hour within the next 12 hours, else the day too.
export function shownTime(ms: number | null, t: T): string {
  return ms === null ? '—' : clockAt(ms, Date.now(), t);
}

// A super node's status rows (the Overview and the Device tab): online or not, or registered with its server answering
// and not admitted to consensus yet (the node's own admission, which costs it the super node share, else outside
// the eligible set: that, not Offline; node-view.ts superState), when it was last seen, its heartbeats
// this epoch and whether they keep pace for it to count, the network's height and the server's own when the network
// reports it, and whether the network bars it.
export function SuperRows({ status }: { status: SuperStatusView }) {
  return (
    <>
      <StateLine badge={superBadge(status)} />
      <SuperFacts status={status} />
    </>
  );
}

// The server's facts without its state word (the Overview's readouts name the state).
export function SuperFacts({ status }: { status: SuperStatusView }) {
  const { t, say } = useI18n();
  const state = superState(status);
  const beats = status.heartbeats === null ? null : shownHeartbeats(status.heartbeats);
  return (
    <>
      {state === 'waiting' && <p className="note">{say(status.admission === 'waiting' ? 'super_waiting_note' : 'super_waiting_set_note')}</p>}
      <Facts>
        <Fact label={t('super_last_seen_label')}>{status.lastSeenAt === null ? t('super_not_known') : clockAgo(status.lastSeenAt, Date.now(), t)}</Fact>
        <Fact label={t('ro_heartbeats_sub')}>
          {beats === null ? t('super_not_known') : t('super_heartbeats_of', { current: number(beats.current), required: number(beats.required) })}
        </Fact>
        {status.onPace !== null && <Fact label={t('super_pace_label')}>{t(status.onPace ? 'super_on_pace' : 'super_behind')}</Fact>}
        <HeightRow status={status} />
      </Facts>
      {status.banned && <p className="rq-failed">{say('super_barred')}</p>}
    </>
  );
}

// The server's height against the network's, when the network reports it; else the network's own height alone. Each
// height links to its block.
function HeightRow({ status }: { status: SuperStatusView }) {
  const { t, rich } = useI18n();
  const { networkHeight: network, serverHeight: server } = status;
  if (server !== null && network !== null) {
    const behind = network - server;
    const height = <EntityLink kind="block" value={server} />;
    return (
      <Fact label={t('super_height_label')}>
        {behind <= SERVER_SYNC_BLOCKS ? rich('super_height_synced', { height }) : rich('super_height_behind', { height, behind: number(behind) })}
      </Fact>
    );
  }
  return network === null ? null : <Fact label={t('super_height_label')}>{rich('super_height_network', { height: <EntityLink kind="block" value={network} /> })}</Fact>;
}
