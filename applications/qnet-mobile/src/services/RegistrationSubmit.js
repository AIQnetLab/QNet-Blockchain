/**
 * The light node's registration after the user consents on the QNet Link sheet to a one-time payment address's burn, sent
 * by the wallet itself to aiqnet.io's register route and kept as a job until the chain decides it, so a
 * failed network or a closed app only delays it (docs/applications/mobile-wallet.md, the link sheet).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';
import { EXPLORER_API, FIRST_CONTACT_MS } from '../config/nodes';
import { lightNodeId, registrationProof } from '../crypto/NodePreimages';
import { readRecordedBurn } from './NodeRecordRead';
import logger from '../utils/logger';
import { retryBackoff, retryPause } from '../utils/pause';

export const REGISTER_URL = `${EXPLORER_API}/api/cabinet/register`;
// The route's keys for a one-time payment address's burn, in its order (registration.ts CONSENT_KEYS).
export const CONSENT_KEYS = Object.freeze([
  'from', 'node_id', 'node_type', 'wallet_address', 'registration_proof', 'timestamp', 'burn_tx_hash', 'burn_amount',
  'dilithium_signature', 'dilithium_public_key',
]);

// One job per light node: a consent of another wallet on this device never takes the place of this one's.
const JOB_PREFIX = 'qnet_registration_submit:';
const jobKey = (nodeId) => `${JOB_PREFIX}${nodeId}`;
// The route waits for the genesis node, which gathers the committee's burn attestations inside the submit (30 s).
const SUBMIT_MS = 30000 + FIRST_CONTACT_MS;
export const FIRST_WAIT_MS = 5000;
export const MAX_WAIT_MS = 120000;
// A registration the node took into its pool that the chain does not list this long after goes again (the same body):
// the register route answers the same consent with that admission for as long (registration.ts ADMIT_HOLD_MS).
export const READMIT_MS = 180000;

const hexOf = (b64url) => Buffer.from(String(b64url), 'base64').toString('hex');
// The light node id of `qnet`, or null for a malformed address.
const nodeOf = (qnet) => { try { return lightNodeId(qnet); } catch (_) { return null; } };

/**
 * The route's consent body for `qnet`'s consent { ts, pk, sig } (b64url, as the sheet's answer carries it) to the light
 * burn `burnTx` of `burnAmount` whole 1DEV, the key and the signature as hex. Null when a part is missing.
 */
export function registrationBody({ qnet, burnTx, burnAmount, consent }) {
  const ts = consent ? Number(consent.ts) : NaN;
  if (!Number.isSafeInteger(ts) || ts < 0 || !Number.isSafeInteger(burnAmount) || burnAmount <= 0) return null;
  if (typeof consent.pk !== 'string' || typeof consent.sig !== 'string') return null;
  const nodeId = nodeOf(qnet);
  let proof = null;
  try { proof = nodeId && registrationProof(burnTx, nodeId, qnet); } catch (_) { proof = null; }
  if (!proof) return null;
  const full = {
    from: qnet, node_id: nodeId, node_type: 'light', wallet_address: qnet, registration_proof: proof, timestamp: ts,
    burn_tx_hash: burnTx, burn_amount: burnAmount, dilithium_signature: hexOf(consent.sig), dilithium_public_key: hexOf(consent.pk),
  };
  return Object.fromEntries(CONSENT_KEYS.map((k) => [k, full[k]]));
}

/**
 * POST the body to the route: { result: 'admitted', txHash } | { result: 'registered' } | { result: 'retry', code } |
 * { result: 'stale' } | { result: 'refused', code }, as the route answers; no answer, a busy route or one that cannot be
 * read is a retry.
 */
export async function postRegistration(body, { fetchFn = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SUBMIT_MS);
  try {
    const res = await fetchFn(REGISTER_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
      credentials: 'omit', signal: ctl.signal,
    });
    // A refusal of the request itself is final; a busy route (429) or a timeout is not.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      return { result: 'refused', code: res.status === 400 ? 'bad_request' : `http_${res.status}` };
    }
    if (res.status !== 200) return { result: 'retry', code: `http_${res.status}` };
    const a = await res.json().catch(() => null);
    const result = a && typeof a === 'object' ? a.result : null;
    if (result === 'admitted' && typeof a.txHash === 'string' && /^[0-9a-f]{64}$/.test(a.txHash)) return { result, txHash: a.txHash };
    if (result === 'registered' || result === 'stale') return { result };
    if (result === 'refused' && typeof a.code === 'string') return { result, code: a.code };
    return { result: 'retry', code: result === 'retry' && typeof a.code === 'string' ? a.code : 'unreadable' };
  } catch (_) {
    return { result: 'retry', code: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Node `nodeId`'s kept job, or null.
async function readJob(nodeId) {
  try {
    const job = JSON.parse((await AsyncStorage.getItem(jobKey(nodeId))) || 'null');
    return job && typeof job.qnet === 'string' && nodeOf(job.qnet) === nodeId && job.consent && Number.isFinite(job.until)
      ? job : null;
  } catch (_) {
    return null;
  }
}

const sameJob = (a, b) => !!a && !!b && a.qnet === b.qnet && a.burnTx === b.burnTx && a.consent.ts === b.consent.ts;

async function writeJob(job) {
  try { await AsyncStorage.setItem(jobKey(nodeOf(job.qnet)), JSON.stringify(job)); } catch (_) { /* this run still sends it */ }
}

// Drops its node's stored job when it is still `job` (a newer consent's for the same node stays).
async function dropJob(job) {
  const nodeId = nodeOf(job.qnet);
  if (sameJob(await readJob(nodeId), job)) {
    try { await AsyncStorage.removeItem(jobKey(nodeId)); } catch (_) { /* the next read finds it settled by the chain */ }
  }
}

// The one send running per node: a second call for the same consent joins it.
const running = new Map();

async function run(nodeId, job, { onStage, now, sleep, fetchFn, readBurn }) {
  let current = job;
  const backoff = retryBackoff(FIRST_WAIT_MS, MAX_WAIT_MS, sleep);
  // Once read back, a job that is gone was settled meanwhile (the chain lists the node, its window ended): nothing goes
  // again and nothing is written back. One the device could not keep still goes from this run.
  let seen = false;
  const ours = async () => !seen || sameJob(await readJob(nodeId), job);
  for (;;) {
    backoff.trying();
    const kept = await readJob(nodeId);
    if (kept && !sameJob(kept, job)) return 'replaced';
    if (kept) seen = true;
    else if (seen) {
      logger.info('[INFO][NODEREG] registration_settled reason=job_gone');
      return 'settled';
    }
    // The burn's amount is the site's record of the payment address's burn, as the route checks the body against. A
    // record that names no such burn, or another one, leaves the registration to the page (a burn of the wallet's own
    // address).
    if (!Number.isSafeInteger(current.burnAmount)) {
      const burn = await readBurn(job.qnet).catch(() => null);
      if (burn && burn.burnTx !== job.burnTx) {
        await dropJob(job);
        logger.warn(`[WARN][NODEREG] registration_not_sent reason=${burn.burnTx === null ? 'no_record' : 'other_burn'}`);
        return 'no_record';
      }
      if (burn) {
        if (!(await ours())) continue;
        current = { ...current, burnAmount: burn.burnAmount };
        await writeJob(current);
      }
    }
    const body = Number.isSafeInteger(current.burnAmount) ? registrationBody(current) : null;
    if (Number.isSafeInteger(current.burnAmount) && !body) {
      await dropJob(job);
      logger.warn('[WARN][NODEREG] registration_not_sent reason=consent');
      return 'refused';
    }
    if (body) {
      const outcome = await postRegistration(body, { fetchFn });
      if (outcome.result === 'admitted' || outcome.result === 'registered') {
        // Kept until the chain lists the node: one the pool lost goes again (resumeRegistration).
        if (await ours()) await writeJob({ ...current, admittedAt: now() });
        logger.info(`[INFO][NODEREG] registration_sent result=${outcome.result}`);
        onStage(outcome.result);
        return outcome.result;
      }
      if (outcome.result !== 'retry') {
        await dropJob(job);
        logger.warn(`[WARN][NODEREG] registration_not_taken result=${outcome.result} code=${outcome.code || ''}`);
        return outcome.result;
      }
    }
    if (now() + backoff.nextMs() >= job.until) {
      await dropJob(job);
      logger.warn('[WARN][NODEREG] registration_not_sent reason=expired');
      return 'expired';
    }
    await backoff.pause();
  }
}

/**
 * Sends the registration of `job` { qnet, burnTx, consent, until (ms) }: kept first, then posted, again after
 * 5 s doubling to 2 min (at once when the network comes back or the app comes to the front, the back-off then starting
 * again from 5 s) while the route cannot answer and the consent's window lasts. `onStage('admitted' |
 * 'registered')` once the route took it. Resolves the last outcome: admitted | registered | refused | stale |
 * no_record (the site's record names no such payment burn) | expired | replaced (a newer consent for the same node took
 * its place) | settled (its job went meanwhile: the chain lists the node, or the consent's window ended).
 */
export function sendRegistration(job, { onStage = () => {}, now = Date.now, sleep = retryPause, fetchFn = fetch, readBurn = readRecordedBurn } = {}) {
  const nodeId = job && job.consent ? nodeOf(job.qnet) : null;
  if (!nodeId) return Promise.resolve('refused');
  const on = running.get(nodeId);
  if (on && sameJob(on.job, job)) return on.promise;
  const entry = { job, promise: null };
  entry.promise = (async () => {
    try {
      // What a kept copy of the same consent learnt (the burn's amount) goes on with it.
      const kept = await readJob(nodeId);
      const merged = sameJob(kept, job) ? { ...kept, ...job, burnAmount: job.burnAmount ?? kept.burnAmount } : job;
      await writeJob(merged);
      return await run(nodeId, merged, { onStage, now, sleep, fetchFn, readBurn });
    } finally {
      if (running.get(nodeId) === entry) running.delete(nodeId);
    }
  })();
  running.set(nodeId, entry);
  return entry.promise;
}

/**
 * The kept job of node `nodeId` by a status read (`onChain`): forgotten once the chain lists the node or the consent's
 * window ended; sent again while the chain does not list it, unless a send runs or the pool took it less than
 * READMIT_MS ago. Null when nothing goes, else sendRegistration's promise.
 */
export async function resumeRegistration(nodeId, onChain, { now = Date.now, ...options } = {}) {
  const job = await readJob(nodeId);
  if (!job) return null;
  if (onChain === true || now() >= job.until) {
    await dropJob(job);
    return null;
  }
  if (onChain !== false || running.has(nodeId)) return null;
  if (Number.isFinite(job.admittedAt) && now() - job.admittedAt < READMIT_MS) return null;
  return sendRegistration(job, { now, ...options });
}

/**
 * Every job kept on this device, whichever wallet it is for, by one status read of its own node (`readStatus(nodeId)`
 * → { onChain }), then resumeRegistration: the open wallet carries on the others' too. A job whose consent's window
 * ended goes without a read. `onStage(nodeId, result)` once the route took one.
 */
export async function resumeKept({ readStatus, onStage = () => {}, now = Date.now, ...options } = {}) {
  let keys = [];
  try { keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(JOB_PREFIX)); } catch (_) { keys = []; }
  return Promise.all(keys.map(async (key) => {
    const nodeId = key.slice(JOB_PREFIX.length);
    const job = await readJob(nodeId);
    if (!job || running.has(nodeId)) return null;
    if (now() >= job.until) return resumeRegistration(nodeId, null, { now });
    const status = await Promise.resolve().then(() => readStatus(nodeId)).catch(() => null);
    return resumeRegistration(nodeId, status ? status.onChain : null, { now, onStage: (r) => onStage(nodeId, r), ...options });
  }));
}
