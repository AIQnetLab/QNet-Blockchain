/**
 * The pushes this device took, so a missed epoch can be put down to its cause (light-node-messages section 5.10): per
 * epoch, when the network sent its first push that reached this device (the sending genesis's clock), when this device
 * took it (this device's clock) and what the app did with that epoch's pushes. An answer carries the record of the
 * epochs before its own (`push_receipts`): every push of them that reached this device, so a push missing from it never
 * reached it. A genesis reads it as display data for the node's last miss, never for counting; one of an earlier
 * release ignores it. One small record for the binding, gone with it (PushService.teardownLightNode).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { heldBecause } from './AnswerGate';
import { APP_OUTCOMES } from './LightNode';

export const PUSH_RECEIPTS_KEY = 'qnet_push_receipts';

// What the app did with an epoch's pushes is one of APP_OUTCOMES; the last word is kept, and 'answered' is never replaced.
export { APP_OUTCOMES };

// The epochs before its own an answer reports, a day of them; the record keeps no older epoch.
export const REPORT_EPOCHS = 6;

const natural = (v) => Number.isSafeInteger(v) && v >= 0;
const valid = (e) => !!e && natural(e.epoch) && (e.outcome === null || APP_OUTCOMES.includes(e.outcome))
  && (e.push === null || (!!e.push && natural(e.push.receivedAt) && (e.push.sentAt === null || natural(e.push.sentAt))));

// The record of `nodeId`: { nodeId, since, epochs: [{ epoch, push: { sentAt, receivedAt } | null, outcome }] }, or
// null.
// `since`: every push of an epoch from it on that reached this device is in the record. One with an entry it cannot read
// is none: a push left out of it would read as one that never came.
async function read(nodeId) {
  try {
    const r = JSON.parse((await AsyncStorage.getItem(PUSH_RECEIPTS_KEY)) || 'null');
    if (!r || r.nodeId !== nodeId || !natural(r.since) || !Array.isArray(r.epochs) || !r.epochs.every(valid)) return null;
    return { nodeId, since: r.since, epochs: r.epochs };
  } catch (_) {
    return null;
  }
}

// One change at a time: pushes the system held back may arrive together.
let lane = Promise.resolve();
function change(nodeId, fn) {
  const run = lane.then(async () => {
    try {
      const rec = fn(await read(nodeId));
      if (!rec) return;
      // Bounded: nothing older than REPORT_EPOCHS before the latest epoch, and `since` past what was dropped.
      const cutoff = Math.max(...rec.epochs.map((e) => e.epoch), rec.since) - REPORT_EPOCHS;
      rec.epochs = rec.epochs.filter((e) => e.epoch >= cutoff);
      rec.since = Math.max(rec.since, cutoff);
      await AsyncStorage.setItem(PUSH_RECEIPTS_KEY, JSON.stringify(rec));
    } catch (_) { /* the next push writes it */ }
  });
  lane = run;
  return run;
}

const entryOf = (rec, epoch) => {
  let e = rec.epochs.find((x) => x.epoch === epoch);
  if (!e) {
    e = { epoch, push: null, outcome: null };
    rec.epochs.push(e);
  }
  return e;
};

/**
 * A push of `epoch` reached this device (`evidence`: PushService.pushEvidence). The epoch keeps the times of its first
 * push; a later one waits for its outcome again unless the epoch was answered. A record started by a push covers its
 * epoch: that push is in it.
 */
export function noteReceived(nodeId, epoch, evidence) {
  if (!natural(epoch) || !evidence || !natural(evidence.receivedAt)) return Promise.resolve();
  return change(nodeId, (cur) => {
    const rec = cur || { nodeId, since: epoch, epochs: [] };
    const e = entryOf(rec, epoch);
    if (!e.push) {
      e.push = { sentAt: natural(evidence.sentAt) ? evidence.sentAt : null, receivedAt: evidence.receivedAt };
    }
    if (e.outcome !== 'answered') e.outcome = null;
    return rec;
  });
}

/** What the app did with the pushes of `epoch` that reached it (APP_OUTCOMES); none for an epoch no push reached. */
export function noteOutcome(nodeId, epoch, outcome) {
  if (!natural(epoch) || !APP_OUTCOMES.includes(outcome)) return Promise.resolve();
  return change(nodeId, (cur) => {
    const e = cur && cur.epochs.find((x) => x.epoch === epoch);
    if (!e || !e.push || e.outcome === 'answered') return null;
    e.outcome = outcome;
    return cur;
  });
}

/** A push of `epoch` came while the app may not answer: why (AnswerGate.heldBecause). */
export async function noteHeld(nodeId, epoch) {
  let why = null;
  try { why = await heldBecause(); } catch (_) { why = null; }
  return noteOutcome(nodeId, epoch, why || 'not_opened_since_boot');
}

/** An answer of this device for `epoch` was taken, whichever wake sent it. */
export function noteAnswered(nodeId, epoch) {
  if (!natural(epoch)) return Promise.resolve();
  return change(nodeId, (cur) => {
    // A record started now covers the next epoch only: a push of this one may have reached an older build.
    const rec = cur || { nodeId, since: epoch + 1, epochs: [] };
    entryOf(rec, epoch).outcome = 'answered';
    return rec;
  });
}

/** The chain is at `epoch` as this device read it: a record starts with the next epoch where there is none. */
export function noteEpochSeen(nodeId, epoch) {
  if (!natural(epoch)) return Promise.resolve();
  return change(nodeId, (cur) => (cur ? null : { nodeId, since: epoch + 1, epochs: [] }));
}

/**
 * What an answer for `epoch` reports (`push_receipts`): { since, pushes: [{ epoch, sent_at, received_at, outcome }] },
 * every push of the epochs from `since` to the one before `epoch` that reached this device, the first of each epoch, an
 * outcome never noted (the wake ended first) as 'answer_failed'. Null when the record covers none of those epochs, or this device's answer of each of them was taken
 * (nothing to tell).
 */
export async function reportFor(nodeId, epoch) {
  if (!natural(epoch)) return null;
  await lane;
  const rec = await read(nodeId);
  if (!rec) return null;
  const since = Math.max(rec.since, epoch - REPORT_EPOCHS);
  if (since >= epoch) return null;
  const covered = rec.epochs.filter((e) => e.epoch >= since && e.epoch < epoch).sort((a, b) => a.epoch - b.epoch);
  if (covered.filter((e) => e.outcome === 'answered').length === epoch - since) return null;
  const pushes = covered.filter((e) => e.push).map((e) => ({
    epoch: e.epoch, sent_at: e.push.sentAt, received_at: e.push.receivedAt, outcome: e.outcome || 'answer_failed',
  }));
  return { since, pushes };
}

export default { noteReceived, noteOutcome, noteHeld, noteAnswered, noteEpochSeen, reportFor };
