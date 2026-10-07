// This wallet's light node on the QNet network (docs/protocols/light-node-messages.md section 4; CONTRACTS.md section
// 4.10). After a light burn the wallet records the node on chain: one pinned node builds the registration from the
// wallet's consent (ML-DSA-65) and the burner's owner bind (Ed25519) and collects the committee's burn attestations
// inside the submit. For aiqnet.io (qnet_claimNodeBalance) it moves the node balance into the wallet; for Recover it
// reads the burn the node's registration record names (a burn aiqnet.io paid for this wallet); before any burn it asks
// whether the network already holds the node (lightNodeKnown), which such a burn leaves no other trace of. The wallet
// key also ends the node on whatever device runs it (unlinkForSite, decision 38). The extension never runs a node: no
// device, ping key or push token here. A change of the registration's state calls events.notifyViews('activation').
import * as core from '../lib/qnet-core.js';
import { CLAIM_MIN_NANO, LIMITS, QNET, REGISTRATION_ALARM, TIMINGS } from './config.js';
import { WalletError } from './errors.js';
import { notifyViews } from './events.js';
import * as keys from './keys.js';
import { log } from './log.js';
import * as qnet from './qnet.js';
import * as session from './session.js';
import * as vault from './vault.js';

/**
 * @typedef {object} RegistrationView  what a page may show of VaultState.registration
 * @property {string} nodeId
 * @property {'queued'|'admitted'|'onchain'|'other_burn'|'refused'|'clock'} state other_burn: the chain lists the light
 *   node with a registration that names another burn (whoseBurn), so this burn recorded nothing
 * @property {number} attempts
 * @property {string|null} lastError a short code, never shown as text
 * @property {string|null} txHash
 * @property {number} updatedAt
 * @property {boolean} automatic the wallet still tries on its own: queued below the attempt cap, or admitted (its chain is
 *   read until the hold ends, past the cap too)
 * @property {boolean} deferred queued, and its next automatic attempt is more than TIMINGS.REGISTRATION_SOON_MS away: a
 *   page offers Record on the network meanwhile instead of saying it is being recorded
 *
 * @typedef {object} ClaimView  what the qnet_claimNodeBalance window offers (claimView)
 * @property {'claim'|'empty'|'unavailable'} mode empty: below CLAIM_MIN_NANO
 * @property {'NO_NODE'|'NETWORK'|'SIGNING_DISABLED'|null} reason unavailable only
 * @property {string} nodeId
 * @property {string|null} amountNano the balance two pinned nodes agree on
 *
 * @typedef {{status: 'ok', qnet: string, nodeId: string, amountNano: string, txHash: string,
 *   stoppedAtEpoch: string|null} | {status: 'empty', qnet: string, nodeId: string}} ClaimOutcome
 *
 * @typedef {object} UnlinkView  what the unlink of the light node's device offers (unlinkView)
 * @property {'confirm'|'unavailable'} mode
 * @property {'NOT_LINKED'|'UNSUPPORTED'|'NETWORK'|'SIGNING_DISABLED'|null} reason unavailable only; UNSUPPORTED: two pinned
 *   nodes do not list the `unbind_wallet` feature
 * @property {string} nodeId
 * @property {'android'|'ios'|'unknown'|null} platform confirm only: the device the public status names
 * @property {number|null} linkedSince confirm only: the UTC day (Unix s) the device was linked, as the status says
 *
 * @typedef {{status: 'ok', qnet: string, nodeId: string, unbound: true}} UnlinkOutcome
 */

const SUBMIT_PATH = '/api/v1/node-registration/submit';
const STATUS_PATH = '/api/v1/light-node/status';
const CLAIM_PATH = '/api/v1/rewards/claim';
const UNBIND_PATH = '/api/v1/light-node/unbind';
// The public status's feature that says a genesis node takes the wallet key's unbind (decision 38).
const UNBIND_FEATURE = 'unbind_wallet';
// The public status's `device` (light-node-messages.md section 7).
const DEVICE_STATES = new Set(['online', 'offline', 'unlinked', 'other_device_pending']);
const DEVICE_PLATFORMS = new Set(['android', 'ios', 'unknown']);
// The node's stable `code` of a submit answer (plan-node U5); the text is read when a node sends none. wallet_has_node:
// the network's one-node rule, this wallet has a node of either type already (a refusal for good, never retried).
// bind_v2_pending: an owner bind without a time, which the network takes only from its one-node gate on; the same
// registration goes through later, so it is tried again like the other temporary answers.
const RETRY_CODES = new Set([
  'behind_chain', 'committee_unavailable', 'quorum_pending', 'mempool_rejected', 'rate_limited', 'bind_v2_pending',
]);
const SUBMIT_CODES = new Set([...RETRY_CODES, 'already_registered', 'timestamp_window', 'bad_request', 'wallet_has_node']);
const SUBMIT_TEXTS = Object.freeze([
  [/node already registered/i, 'already_registered'],
  [/wallet already has a node/i, 'wallet_has_node'],
  [/timestamp too old or too far in future/i, 'timestamp_window'],
  [/node is behind the chain/i, 'behind_chain'],
  [/committee unavailable/i, 'committee_unavailable'],
  [/quorum not yet reached/i, 'quorum_pending'],
  [/failed to add tx to mempool/i, 'mempool_rejected'],
  [/rate limit exceeded/i, 'rate_limited'],
  [/bind_v2_pending|owner bind without a time is not accepted/i, 'bind_v2_pending'],
]);
const TX_HASH_RE = /^[0-9a-f]{64}$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
// The claim payload the node accepts back (rewards_api.rs MAX_CLAIMS_DATA).
const CLAIMS_DATA_MAX = 256 * 1024;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const u64Of = (v) => (typeof v === 'string' && U64_RE.test(v) && BigInt(v) <= 0xffffffffffffffffn ? v : null);

function parse(text) {
  try {
    return qnet.parseJsonLossless(text);
  } catch {
    return null;
  }
}

// `count` distinct pinned nodes, in random order.
function pickNodes(count) {
  const out = [...QNET.NODES];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, count);
}

// The first `key` two pinned nodes of `among` (default: all, in random order) report alike (`read(node)`: {key, ...} with
// a string key, or null for none), asking two first and then one more at a time: {key, answers} with the two agreeing
// answers as [{node, answer}], or {key: null, answers: []} when no two agree.
async function agreedOn(read, among = pickNodes(QNET.NODES.length)) {
  const nodes = [...among];
  const seen = [];
  while (nodes.length > 0) {
    const wave = nodes.splice(0, seen.length === 0 ? 2 : 1);
    const reads = await Promise.all(wave.map(async (node) => ({ node, answer: await read(node) })));
    for (const entry of reads) {
      if (entry.answer === null) continue;
      const earlier = seen.find((other) => other.answer.key === entry.answer.key);
      if (earlier) return { key: entry.answer.key, answers: [earlier, entry] };
      seen.push(entry);
    }
  }
  return { key: null, answers: [] };
}

// The first value two pinned nodes of `among` report alike (`read(node)`: a string, or null for none); null when no two
// agree (agreedOn).
async function agreed(read, among = pickNodes(QNET.NODES.length)) {
  const { key } = await agreedOn(async (node) => {
    const value = await read(node);
    return value === null ? null : { key: value };
  }, among);
  return key;
}

// ---------------------------------------------------------------- the registration record

/**
 * The registration VaultState.registration should hold next to `activation` (activation.js writes it in the same
 * vault update as the activation): the current one for the same burn, or a new queued one for a light activation;
 * null for none or a super one. `retry` (a request of the user) queues a registration that stopped (refused, the
 * clock, or past the attempt cap) again, never one whose node the chain lists (onchain, other_burn): attempt reads those.
 * @param {import('./vault.js').PendingRegistration|null} current
 * @param {import('./vault.js').Activation|null} activation
 * @param {string} wallet the vault's QNet address
 * @param {number} [now]
 * @param {{retry?: boolean}} [options]
 * @returns {import('./vault.js').PendingRegistration|null}
 */
export function registrationFor(current, activation, wallet, now = Date.now(), { retry = false } = {}) {
  if (activation?.nodeType !== 'light') return null;
  if (current && current.burnTx === activation.burnTx) {
    return retry && !LISTED_STATES.has(current.state) && !publicRegistration(current).automatic
      ? { ...current, state: 'queued', attempts: 0, nextAt: now, lastError: null, updatedAt: now } : current;
  }
  return {
    nodeId: core.lightNodeId(wallet), burnTx: activation.burnTx, burner: activation.solanaAddress, state: 'queued',
    attempts: 0, nextAt: now, txHash: null, admittedAt: null, lastError: null, updatedAt: now,
  };
}

/**
 * The page's view of a registration record. An admitted record stays automatic past the attempt cap: reading the chain
 * during its hold is no submit, and once the hold ends without a block it stops (attempt).
 * @param {import('./vault.js').PendingRegistration|null} record
 * @param {number} [now]
 * @returns {RegistrationView|null}
 */
export function publicRegistration(record, now = Date.now()) {
  if (!record) return null;
  const { nodeId, state, attempts, lastError, txHash, updatedAt } = record;
  const automatic = state === 'admitted' || (state === 'queued' && attempts < LIMITS.REGISTRATION_MAX_ATTEMPTS);
  const deferred = automatic && state === 'queued' && record.nextAt - now > TIMINGS.REGISTRATION_SOON_MS;
  return { nodeId, state, attempts, lastError, txHash, updatedAt, automatic, deferred };
}

// The alarm runs while a registration waits for its next automatic attempt, and only then.
async function syncAlarm(record) {
  const alarms = globalThis.chrome?.alarms;
  if (!alarms) return;
  try {
    if (publicRegistration(record)?.automatic === true) {
      if (!(await alarms.get(REGISTRATION_ALARM))) await alarms.create(REGISTRATION_ALARM, { periodInMinutes: 1 });
    } else {
      await alarms.clear(REGISTRATION_ALARM);
    }
  } catch (error) {
    log.warn('registration alarm', error?.name);
  }
}

// Writes `fields` into the registration of `burnTx`, if the vault still holds it; the stored record (or null).
async function patch(record, fields) {
  const now = Date.now();
  const state = await vault.updateState((s) => (s.registration?.burnTx === record.burnTx
    ? { ...s, registration: { ...s.registration, ...fields, updatedAt: now } } : s));
  const next = state.registration;
  if (next?.state !== record.state) notifyViews('activation');
  await syncAlarm(next);
  return next;
}

// The first record of an activation the vault has none for (an earlier build's), once the chain lists its node: `listed`
// 'onchain' or 'other_burn' (whoseBurn).
async function recordFound(activation, wallet, listed) {
  const now = Date.now();
  const state = await vault.updateState((s) => (s.registration === null && s.activation?.burnTx === activation.burnTx
    ? { ...s, registration: { ...registrationFor(null, s.activation, wallet, now), state: listed } } : s));
  notifyViews('activation');
  return state.registration;
}

// The public status's `device`: {state, platform, linkedSince}, or null when absent or malformed (a node that does not
// serve it yet).
function deviceOf(value) {
  if (!isObject(value) || !DEVICE_STATES.has(value.state)) return null;
  const since = u64Of(value.linked_since);
  return {
    state: value.state,
    platform: DEVICE_PLATFORMS.has(value.platform) ? value.platform : null,
    linkedSince: since !== null && since !== '0' && Number.isSafeInteger(Number(since)) ? Number(since) : null,
  };
}

// One pinned node's public status of the light node (GET /api/v1/light-node/status, read from committed storage):
// `listed` its `onchain_registered`, `pending` its `registration_pending` (a registration the node's pool holds or a
// submit collecting attestations there), `signed` whether its `features` list `status_signed` (it serves the signed
// status registeredBurn reads), `unbind` whether they list `unbind_wallet` (it takes the wallet key's unbind), `device`
// its device fields (deviceOf); null for no readable answer.
async function readStatus(nodeId, node) {
  try {
    const reply = await qnet.nodeRequest(`${STATUS_PATH}?node_id=${nodeId}`, { nodes: [node] });
    const body = reply.status === 200 ? parse(reply.text) : null;
    if (!isObject(body) || typeof body.onchain_registered !== 'boolean') return null;
    const features = Array.isArray(body.features) ? body.features : [];
    return {
      listed: body.onchain_registered,
      pending: body.registration_pending === true,
      signed: features.includes('status_signed'),
      unbind: features.includes(UNBIND_FEATURE),
      device: deviceOf(body.device),
    };
  } catch {
    return null;
  }
}

/**
 * Whether the chain lists the light node, as two pinned nodes report it alike (`onchain_registered`): true when two say
 * so, false when two say not, null when no two agree. One node's word is never enough: a node's stale row, or a block a
 * rollback took back, would end the registration for good.
 * @param {string} nodeId
 * @returns {Promise<boolean|null>}
 */
export async function onChain(nodeId) {
  const word = await agreed(async (node) => {
    const status = await readStatus(nodeId, node);
    return status === null ? null : String(status.listed);
  });
  return word === null ? null : word === 'true';
}

// Whether the network serves the signed status (POST /api/v1/light-node/status), as two pinned nodes list it alike in the
// public status's `features` (`status_signed`, docs/protocols/light-node-messages.md section 7); null when no two agree.
async function signedStatusServed(nodeId) {
  const word = await agreed(async (node) => {
    const status = await readStatus(nodeId, node);
    return status === null ? null : String(status.signed);
  });
  return word === null ? null : word === 'true';
}

/**
 * Whose burn the chain's registration of this wallet's light node names, once two pinned nodes list the node: 'own' when
 * it is `burnTx`, 'other' when two nodes' signed status name another burn (one aiqnet.io's payment key made for this
 * wallet and registered first, say: then this burn recorded nothing), null when that cannot be told now. A network that
 * serves no signed status (two nodes list no `status_signed`) has only the listing to go by: 'own' (EXT-R2A-03).
 * @param {string} burnTx the registration record's burn
 * @param {string} nodeId
 * @returns {Promise<'own'|'other'|null>}
 * @throws {WalletError} LOCKED
 */
async function whoseBurn(burnTx, nodeId) {
  let registered = null;
  try {
    registered = await registeredBurn();
  } catch (error) {
    if (error instanceof WalletError && error.code === 'LOCKED') throw error;
    log.warn('registration burn unreadable', error?.code ?? error?.name);
  }
  if (registered !== null) return registered === burnTx ? 'own' : 'other';
  return (await signedStatusServed(nodeId)) === false ? 'own' : null;
}

// The record's state once the chain lists the node, by whoseBurn's answer.
const LISTED = Object.freeze({ own: 'onchain', other: 'other_burn' });
// The states of a record whose node the chain lists: a retry never queues them (registrationFor), a recheck reads them.
const LISTED_STATES = new Set(Object.values(LISTED));

/**
 * The check before a burn (activation.js): whether the QNet network may already hold this light node. Every pinned
 * node is asked at once: true when any of them lists it or holds its registration (a node ahead of the others is right,
 * and a burn is final); false when none does and at least two answer; null when fewer than two answer, and then nothing
 * is burned.
 * @param {string} nodeId
 * @returns {Promise<boolean|null>}
 */
export async function lightNodeKnown(nodeId) {
  const answers = (await Promise.all(QNET.NODES.map((node) => readStatus(nodeId, node)))).filter((status) => status !== null);
  if (answers.some((status) => status.listed || status.pending)) return true;
  return answers.length >= 2 ? false : null;
}

// 15 s, 30 s, 60 s, then 2, 4, 8 ... minutes up to 6 hours after the `attempts`th failed submit.
function retryDelay(attempts) {
  if (attempts <= 3) return TIMINGS.REGISTRATION_FIRST_RETRY_MS * 2 ** (attempts - 1);
  return Math.min(2 ** (attempts - 3) * 60000, TIMINGS.REGISTRATION_BACKOFF_MAX_MS);
}

// A submit answer: admitted (with its hash), on chain already, a retry, the clock, or a refusal, with a short code.
function submitOutcome(reply) {
  if (reply.status !== 200) return { state: 'refused', code: `http_${reply.status}` };
  const body = parse(reply.text);
  if (!isObject(body)) return { state: 'queued', code: 'unreadable' };
  if (body.success === true) {
    return typeof body.tx_hash === 'string' && TX_HASH_RE.test(body.tx_hash)
      ? { state: 'admitted', txHash: body.tx_hash } : { state: 'queued', code: 'unreadable' };
  }
  const text = typeof body.error === 'string' ? body.error : '';
  const code = typeof body.code === 'string' && SUBMIT_CODES.has(body.code) ? body.code
    : SUBMIT_TEXTS.find(([re]) => re.test(text))?.[1] ?? null;
  if (code === 'already_registered') return { state: 'onchain', code };
  if (code === 'timestamp_window') return { state: 'clock', code };
  if (RETRY_CODES.has(code)) return { state: 'queued', code };
  return { state: 'refused', code: code ?? 'refused' };
}

// One submit to one pinned node (never hedged: the node builds and hashes the transaction itself), with a fresh
// timestamp and fresh signatures.
async function submit(record, wallet, activation) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = await keys.signNodeRegistration({
    nodeId: record.nodeId, wallet, burnTx: record.burnTx, burner: record.burner, timestamp,
  });
  // the app's field order (WalletManager.createAndSubmitNodeRegistrationTx); keys and signatures in hex
  const body = {
    from: wallet,
    node_id: record.nodeId,
    node_type: 'light',
    wallet_address: wallet,
    registration_proof: signed.proof,
    timestamp,
    burn_tx_hash: record.burnTx,
    burn_amount: activation.burnAmount,
    burn_wallet: record.burner,
    dilithium_signature: core.bytesToHex(signed.consentSignature),
    dilithium_public_key: core.bytesToHex(signed.publicKey),
    owner_signature: core.bytesToHex(signed.ownerSignature),
  };
  let outcome;
  try {
    const reply = await qnet.nodeRequest(SUBMIT_PATH, {
      method: 'POST', body, nodes: pickNodes(1), timeoutMs: TIMINGS.REGISTRATION_SUBMIT_TIMEOUT_MS,
    });
    outcome = submitOutcome(reply);
  } catch {
    outcome = { state: 'queued', code: 'network' };
  }
  const attempts = record.attempts + 1;
  const now = Date.now();
  if (outcome.state === 'admitted') {
    return patch(record, {
      state: 'admitted', attempts, txHash: outcome.txHash, admittedAt: now, nextAt: now + TIMINGS.REGISTRATION_ADMIT_CHECK_MS,
      lastError: null,
    });
  }
  // "already registered" is one node's word: recorded once two pinned nodes list the node, as this burn's or another's
  // (whoseBurn), else tried again (the next attempt reads the chain first, and another node takes the submit)
  if (outcome.state === 'onchain' && (await onChain(record.nodeId)) === true) {
    const whose = await whoseBurn(record.burnTx, record.nodeId);
    if (whose !== null) return patch(record, { state: LISTED[whose], attempts, lastError: null });
  }
  if (outcome.state === 'onchain' || outcome.state === 'queued') {
    return patch(record, { state: 'queued', attempts, nextAt: now + retryDelay(attempts), lastError: outcome.code });
  }
  log.warn('node registration refused', outcome.code);
  return patch(record, { state: outcome.state, attempts, lastError: outcome.code });
}

const due = (record, now) => publicRegistration(record, now).automatic && record.nextAt <= now;
let lastLookup = 0;
let lastRecheck = 0;

// Whether the light activation's burn is the wallet's own (its Solana address burned): only such a registration is
// ever submitted again; one aiqnet.io's payment key burned has no owner bind here, and the vault keeps it on chain
// (vault.isPaidOnSite).
const ownBurn = (activation, wallet) => activation.solanaAddress === wallet.solanaAddress;

// One step for the vault's light activation: the chain first (two nodes listing it end it: onchain when its
// registration names this burn, other_burn when it names another, a submit never when that is not known yet), the hold
// after an admission (the chain read at most every REGISTRATION_ADMIT_CHECK_MS; past the attempt cap, a hold that ends
// without a block stops it), then a submit. `manual`: the user asked (Record on the network), so a stopped or not yet due
// registration goes too, and an activation without a record is looked up at once. A record on chain (onchain or
// other_burn) is read again when the user or a confirmed site request asks (`manual`, `recheck`), else at most every
// REGISTRATION_CHECK_MS: two nodes that both say the chain does not list the node (a block a rollback took back) queue it
// again from the start.
async function attempt(manual, recheck = false) {
  const wallet = await session.requireUnlocked();
  const state = await vault.readState();
  const { activation } = state;
  let { registration } = state;
  if (activation?.nodeType !== 'light') {
    await syncAlarm(null);
    return null;
  }
  const now = Date.now();
  if (registration === null) {
    // an activation of an earlier build: recorded when the chain lists it, submitted only when the user asks
    if (!manual && now - lastLookup < TIMINGS.REGISTRATION_CHECK_MS) return null;
    lastLookup = now;
    const nodeId = core.lightNodeId(wallet.qnetAddress);
    if ((await onChain(nodeId)) !== true) return null;
    const whose = await whoseBurn(activation.burnTx, nodeId);
    return whose === null ? null : publicRegistration(await recordFound(activation, wallet.qnetAddress, LISTED[whose]));
  }
  if (LISTED_STATES.has(registration.state)) {
    const asked = manual || recheck || now - lastRecheck >= TIMINGS.REGISTRATION_CHECK_MS;
    if (asked && ownBurn(activation, wallet)) lastRecheck = now;
    if (!asked || !ownBurn(activation, wallet) || (await onChain(registration.nodeId)) !== false) {
      await syncAlarm(registration);
      return publicRegistration(registration);
    }
    log.warn('node registration', 'no longer listed on chain');
    registration = await patch(registration, {
      state: 'queued', attempts: 0, nextAt: now, txHash: null, admittedAt: null, lastError: 'not_listed',
    });
    if (registration?.state !== 'queued') return publicRegistration(registration);
    return publicRegistration(await submit(registration, wallet.qnetAddress, activation));
  }
  if (!manual && !due(registration, now)) {
    await syncAlarm(registration);
    return publicRegistration(registration);
  }
  if ((await onChain(registration.nodeId)) === true) {
    const whose = await whoseBurn(registration.burnTx, registration.nodeId);
    if (whose !== null) return publicRegistration(await patch(registration, { state: LISTED[whose], lastError: null }));
    // listed, and whose burn it names is not known yet: no submit (the node refuses one for a listed node), read again
    // after a retry's wait, counted as an attempt so that the cap stops it
    const attempts = registration.attempts + 1;
    return publicRegistration(await patch(registration, {
      state: 'queued', attempts, nextAt: now + retryDelay(attempts), lastError: 'burn_unknown',
    }));
  }
  if (registration.state === 'admitted') {
    const holdEnds = (registration.admittedAt ?? 0) + TIMINGS.REGISTRATION_ADMIT_HOLD_MS;
    if (now < holdEnds) {
      return publicRegistration(await patch(registration, { nextAt: Math.min(now + TIMINGS.REGISTRATION_ADMIT_CHECK_MS, holdEnds) }));
    }
    // no block took it within the hold: past the cap only the user's Record on the network sends it again
    if (!manual && registration.attempts >= LIMITS.REGISTRATION_MAX_ATTEMPTS) {
      return publicRegistration(await patch(registration, { state: 'queued', nextAt: now, lastError: 'not_in_block' }));
    }
  }
  return publicRegistration(await submit(registration, wallet.qnetAddress, activation));
}

// Attempts run one at a time; a background resume asked while one waits is that one.
let lane = Promise.resolve();
let resumeWaiting = null;
function inLane(fn) {
  const run = lane.then(fn);
  lane = run.then(() => undefined, () => undefined);
  return run;
}

let recheckAsked = false;

/**
 * The next automatic step of the registration when one is due (sw.js after an unlock, the REGISTRATION_ALARM,
 * activation.js after it queued one, a page reading it). Never throws.
 * @param {{recheck?: boolean}} [options] recheck: a confirmed site request for the activation asks the chain again about
 *   a record on chain (attempt)
 * @returns {Promise<RegistrationView|null>}
 */
export function resumeRegistration(options = {}) {
  if (options?.recheck === true) recheckAsked = true;
  resumeWaiting ??= inLane(() => {
    resumeWaiting = null;
    const recheck = recheckAsked;
    recheckAsked = false;
    return attempt(false, recheck);
  }).catch(async (error) => {
    log.warn('node registration not resumed', error?.code ?? error?.name);
    // locked: the unlock resumes it (sw.js), so the alarm stops waking the worker meanwhile
    if (error instanceof WalletError && error.code === 'LOCKED') await syncAlarm(null);
    return null;
  });
  return resumeWaiting;
}

/**
 * Handler of `activation.register` (Record on the network): the vault's light activation is queued again when its
 * registration stopped (or queued for the first time), and one attempt runs now. No password: the unlocked session
 * authorizes it (decision 33); it costs no fee and burns nothing.
 * @returns {Promise<{registration: RegistrationView|null}>}
 * @throws {WalletError} LOCKED, NOT_FOUND (no light activation), SIGNING_DISABLED
 */
export async function requestRecord() {
  const wallet = await session.requireUnlocked();
  const { activation } = await vault.readState();
  if (activation?.nodeType !== 'light') throw new WalletError('NOT_FOUND');
  const state = await vault.updateState((s) => (s.activation?.burnTx === activation.burnTx
    ? { ...s, registration: registrationFor(s.registration, s.activation, wallet.qnetAddress, Date.now(), { retry: true }) } : s));
  notifyViews('activation');
  await syncAlarm(state.registration);
  return { registration: await inLane(() => attempt(true)) };
}

/**
 * Handler of `activation.registration` (the popup's status line, the activation window after its answer): the
 * vault's registration, and the next step started in the background when one is due.
 * @returns {Promise<{registration: RegistrationView|null}>}
 * @throws {WalletError} LOCKED
 */
export async function getRegistration() {
  await session.requireUnlocked();
  const { registration } = await vault.readState();
  resumeRegistration();
  return { registration: publicRegistration(registration) };
}

/**
 * sw.js alarm listener: the REGISTRATION_ALARM resumes the registration; any other alarm is not this module's.
 * @param {{name: string}} alarm
 * @returns {Promise<void>}
 */
export async function onAlarm(alarm) {
  if (alarm?.name === REGISTRATION_ALARM) await resumeRegistration();
}

/**
 * The burn that registered this wallet's light node, from the node's registration record as two pinned nodes report it
 * alike (the signed status only the wallet key reads: POST /api/v1/light-node/status, signer "wallet"); null when the
 * chain does not list the node or that is not known. Recover reads it for a burn aiqnet.io's one-time payment key made
 * for this wallet, which no search of the wallet's own addresses finds (activation.js).
 * @returns {Promise<string|null>} the burn's signature
 * @throws {WalletError} LOCKED, SIGNING_DISABLED
 */
export async function registeredBurn() {
  const wallet = (await session.requireUnlocked()).qnetAddress;
  const nodeId = core.lightNodeId(wallet);
  const { key } = await signedStatus(wallet, nodeId, (read) => (read.onchain_registered === true && core.isValidSolanaSignature(read.burn_tx)
    ? read.burn_tx : null));
  return key;
}

// The first value two pinned nodes' signed status of this wallet's light node give alike (agreedOn), read with the wallet
// key (POST /api/v1/light-node/status, signer "wallet"; a node never linked to a device checks the signature under the
// key the chain vouches for): `pick(read)` turns one node's answer into the value compared, or null.
async function signedStatus(wallet, nodeId, pick) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = await keys.signNodeStatus({ nodeId, wallet, timestamp });
  const body = {
    node_id: nodeId, ts: timestamp, signer: 'wallet', sig: core.bytesToHex(signed.signature),
    identity_pubkey: core.bytesToHex(signed.publicKey),
  };
  return agreedOn(async (node) => {
    try {
      const reply = await qnet.nodeRequest(STATUS_PATH, { method: 'POST', body, nodes: [node] });
      const read = reply.status === 200 ? parse(reply.text) : null;
      const value = isObject(read) && read.node_id === nodeId ? pick(read) : null;
      return value === null ? null : { key: value };
    } catch {
      return null;
    }
  });
}

// ---------------------------------------------------------------- the node balance (qnet_claimNodeBalance)

// A node's pending balance of `nodeId` (GET /api/v1/rewards/pending/{id}, exact nano), or null.
async function readPending(nodeId, node) {
  try {
    const reply = await qnet.nodeRequest(`/api/v1/rewards/pending/${nodeId}`, { nodes: [node] });
    const body = reply.status === 200 ? parse(reply.text) : null;
    return isObject(body) && body.node_id === nodeId ? { amount: u64Of(body.pending_rewards_nano), head: body.first_unclaimed_epoch } : null;
  } catch {
    return null;
  }
}

/**
 * What the qnet_claimNodeBalance window offers now (provider.js, while unlocked): this wallet's light node, whether
 * the chain lists it, and the balance two pinned nodes agree on. Nothing is signed or sent.
 * @returns {Promise<ClaimView>}
 * @throws {WalletError} LOCKED
 */
export async function claimView() {
  const wallet = await session.requireUnlocked();
  const nodeId = core.lightNodeId(wallet.qnetAddress);
  const unavailable = (reason) => ({ mode: 'unavailable', reason, nodeId, amountNano: null });
  if (!keys.signingEnabled()) return unavailable('SIGNING_DISABLED');
  const listed = await onChain(nodeId);
  if (listed !== true) return unavailable(listed === false ? 'NO_NODE' : 'NETWORK');
  const amountNano = await agreed(async (node) => (await readPending(nodeId, node))?.amount ?? null);
  if (amountNano === null) return unavailable('NETWORK');
  return { mode: BigInt(amountNano) < BigInt(CLAIM_MIN_NANO) ? 'empty' : 'claim', reason: null, nodeId, amountNano };
}

// The quote of step 1, checked as the app checks it (WalletManager.claimRewards): claims strictly ascending above the
// wallet's watermark, amounts summing to amount_nano (at least CLAIM_MIN_NANO for a full batch, above zero for a part),
// a timestamp, and a message the wallet builds itself.
function checkedQuote(body, wallet) {
  const refuse = () => {
    throw new WalletError('CLAIM_REFUSED');
  };
  const claimsData = body.claims_data;
  if (typeof claimsData !== 'string' || claimsData.length === 0 || claimsData.length > CLAIMS_DATA_MAX) refuse();
  const claims = parse(claimsData)?.claims;
  const watermark = u64Of(body.last_claimed_epoch);
  if (!Array.isArray(claims) || claims.length === 0 || watermark === null) refuse();
  let previous = BigInt(watermark);
  let sum = 0n;
  const entries = [];
  for (const claim of claims) {
    const epoch = isObject(claim) ? u64Of(claim.epoch) : null;
    const amount = isObject(claim) ? u64Of(claim.amount) : null;
    if (epoch === null || amount === null || BigInt(epoch) <= previous) refuse();
    previous = BigInt(epoch);
    sum += BigInt(amount);
    entries.push({ epoch, amount });
  }
  const amountNano = u64Of(body.amount_nano);
  const timestamp = u64Of(body.claim_timestamp);
  // a part of the balance stops at the first epoch the node did not quote, above the last one it did
  const stopped = body.stopped_at_epoch ?? null;
  if (stopped !== null && (u64Of(stopped) === null || BigInt(stopped) <= previous)) refuse();
  // a full batch moves at least CLAIM_MIN_NANO; a part of the balance moves any positive amount, so a balance whose
  // epochs outgrow one quote still moves whole in several claims (EXT-R1-03, owner decision of 2026-09-27)
  const least = stopped === null ? BigInt(CLAIM_MIN_NANO) : 1n;
  if (amountNano === null || BigInt(amountNano) < least || BigInt(amountNano) !== sum) refuse();
  if (timestamp === null || timestamp === '0' || !Number.isSafeInteger(Number(timestamp))) refuse();
  // the node's own copy of the message is never signed; one that differs from the wallet's is refused
  const message = core.claimPayloadPreimage(wallet, timestamp, claimsData);
  if (body.sign_message !== undefined && body.sign_message !== null && body.sign_message !== message) refuse();
  return {
    claimsData, entries, watermark, firstEpoch: entries[0].epoch, lastEpoch: entries.at(-1).epoch, amountNano,
    timestamp: Number(timestamp), stoppedAtEpoch: stopped,
  };
}

// A refusal of either step as the site learns it.
function claimRefusal(body) {
  const text = isObject(body) && typeof body.error === 'string' ? body.error : '';
  if (/already in progress/i.test(text)) return 'CLAIM_BUSY';
  if (/not registered on-chain/i.test(text)) return 'NO_NODE';
  if (/rate limit exceeded/i.test(text)) return 'NETWORK';
  return 'CLAIM_REFUSED';
}

// A claim request to the first of `nodes` that answers (hedged as the app's): {body, node}.
async function claimRequest(nodes, body) {
  let reply;
  try {
    reply = await qnet.nodeRequest(CLAIM_PATH, { method: 'POST', body, nodes });
  } catch {
    throw new WalletError('NETWORK');
  }
  return { body: reply.status === 200 ? parse(reply.text) : null, node: reply.node };
}

// A step-1 answer of a node that cannot serve an epoch (its root or shard is not there: rewards_api.rs), which says to
// retry on another node: no quote, `stopped_reason` set.
const cannotServe = (body) => isObject(body) && body.needs_signature !== true && typeof body.stopped_reason === 'string';

// Step 1 from the first node of `among` (default: every pinned node, in random order) that can quote: a node that cannot
// serve an epoch hands over to the next one, as its answer asks. When none can, the last such answer (a refusal);
// NETWORK only when no node answered at all.
async function quoteRequest(body, among = pickNodes(QNET.NODES.length)) {
  let nodes = [...among];
  let unservable = null;
  while (nodes.length > 0) {
    let answer;
    try {
      answer = await claimRequest(nodes, body);
    } catch (error) {
      if (unservable !== null) return unservable;
      throw error;
    }
    if (!cannotServe(answer.body)) return answer;
    unservable = answer;
    nodes = nodes.filter((node) => node !== answer.node);
  }
  return unservable;
}

// What pinned nodes other than the quoting one report of the node balance (GET /api/v1/rewards/pending), asking two
// first and then one more at a time: every head they report must be the quote's first epoch (one disagreeing refuses: a
// quote that dropped the head would burn those epochs behind the monotonic watermark), and for a full batch (no
// `stopped_at_epoch`) the pending total two of them report alike must not exceed the quote. The pending figure counts the
// epochs the claim path serves and can only under-report it, so a full quote below it skipped an epoch the wallet holds a
// leaf in. None answering (or, for a full batch, no two agreeing) is no check: NETWORK.
async function crossChecked(nodeId, others, checked) {
  const full = checked.stoppedAtEpoch === null;
  const queue = [...others];
  const amounts = [];
  let heads = 0;
  let agreedAmount = null;
  let first = true;
  while (queue.length > 0 && (heads === 0 || (full && agreedAmount === null))) {
    const wave = queue.splice(0, first ? 2 : 1);
    first = false;
    for (const read of await Promise.all(wave.map((other) => readPending(nodeId, other)))) {
      if (read === null) continue;
      const head = u64Of(read.head);
      if (head !== null) {
        if (head !== checked.firstEpoch) throw new WalletError('CLAIM_REFUSED');
        heads += 1;
      }
      if (read.amount !== null) {
        if (agreedAmount === null && amounts.includes(read.amount)) agreedAmount = read.amount;
        amounts.push(read.amount);
      }
    }
  }
  if (heads === 0 || (full && agreedAmount === null)) throw new WalletError('NETWORK');
  if (full && BigInt(checked.amountNano) < BigInt(agreedAmount)) throw new WalletError('CLAIM_REFUSED');
}

// A part of the balance (`stopped_at_epoch` set) escapes the pending-total check, so an epoch the quoting node left out
// below its last one would pass, and the claim's watermark would forfeit it (EXT-R3-01). Another pinned node quotes the
// same request (the claim_rewards signature carries no time); honest nodes list the same epochs and amounts from the
// same watermark and differ only in where they stop. The quote ending lower is signed, and only if the other lists
// exactly its entries up to its last epoch: the other covers every epoch below its own, higher stop. Returns that quote.
async function corroborated(request, checked, wallet) {
  const answer = await quoteRequest(request, pickNodes(QNET.NODES.length).filter((other) => other !== checked.node));
  const body = answer?.body ?? null;
  if (!isObject(body) || body.needs_signature !== true) throw new WalletError(claimRefusal(body));
  const second = { ...checkedQuote(body, wallet), node: answer.node };
  if (second.watermark !== checked.watermark) throw new WalletError('CLAIM_REFUSED');
  const [short, long] = BigInt(second.lastEpoch) < BigInt(checked.lastEpoch) ? [second, checked] : [checked, second];
  const covered = long.entries.filter((entry) => BigInt(entry.epoch) <= BigInt(short.lastEpoch));
  const same = covered.length === short.entries.length
    && covered.every((entry, i) => entry.epoch === short.entries[i].epoch && entry.amount === short.entries[i].amount);
  if (!same) throw new WalletError('CLAIM_REFUSED');
  return short;
}

/**
 * The action of qnet_claimNodeBalance (provider.js, after its approval), as the app moves the node balance: the quote
 * of the first pinned node that can serve it for this wallet's own light node (ML-DSA-65 over claim_rewards), checked;
 * a part of the balance held to a second node's quote (corroborated); the first epoch of the quote to sign (and, for a
 * full batch, its total) compared with what other pinned nodes report (crossChecked); then the payload signed over the
 * message the wallet builds and sent back to the node that quoted it. The site learns the result; the network credits
 * it once a block includes it.
 * @returns {Promise<ClaimOutcome>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED, NO_NODE, NETWORK, CLAIM_REFUSED, CLAIM_BUSY
 */
export async function claimForSite() {
  const wallet = (await session.requireUnlocked()).qnetAddress;
  const nodeId = core.lightNodeId(wallet);
  const quote = await keys.signNodeClaim({ nodeId, wallet });
  const signature = core.bytesToHex(quote.signature);
  const publicKey = core.bytesToHex(quote.publicKey);
  const request = { node_id: nodeId, wallet_address: wallet, dilithium_signature: signature, dilithium_public_key: publicKey };
  const { body: first, node } = await quoteRequest(request);
  if (!isObject(first) || first.needs_signature !== true) {
    if (isObject(first) && /no claimable rewards/i.test(String(first.error ?? ''))) return { status: 'empty', qnet: wallet, nodeId };
    throw new WalletError(claimRefusal(first));
  }
  let checked = { ...checkedQuote(first, wallet), node };
  if (checked.stoppedAtEpoch !== null) checked = await corroborated(request, checked, wallet);
  await crossChecked(nodeId, pickNodes(QNET.NODES.length).filter((other) => other !== checked.node), checked);
  const payload = await keys.signClaimPayload({ wallet, timestamp: checked.timestamp, claimsData: checked.claimsData });
  const { body: second } = await claimRequest([checked.node], {
    node_id: nodeId,
    wallet_address: wallet,
    dilithium_signature: signature,
    dilithium_public_key: publicKey,
    claims_data: checked.claimsData,
    claims_signature: core.bytesToHex(payload.signature),
    claim_timestamp: checked.timestamp,
  });
  if (!isObject(second) || second.success !== true || typeof second.tx_hash !== 'string' || !TX_HASH_RE.test(second.tx_hash)) {
    throw new WalletError(claimRefusal(second));
  }
  return {
    status: 'ok', qnet: wallet, nodeId, amountNano: checked.amountNano, txHash: second.tx_hash, stoppedAtEpoch: checked.stoppedAtEpoch,
  };
}

// ---------------------------------------------------------------- the light node's device (qnet_unlinkNodeDevice)

/**
 * What the unlink of this wallet's light node from its device offers now (the popup's Activate tab, the
 * qnet_unlinkNodeDevice window, while unlocked), from the public status two pinned nodes report alike: the chain does
 * not list the node, or no device runs it (NOT_LINKED); the nodes do not take the wallet key's unbind yet (UNSUPPORTED:
 * no `unbind_wallet` feature); no two nodes alike (NETWORK); else the device it names, to confirm. Nothing is signed.
 * @returns {Promise<UnlinkView>}
 * @throws {WalletError} LOCKED
 */
export async function unlinkView() {
  const wallet = await session.requireUnlocked();
  const nodeId = core.lightNodeId(wallet.qnetAddress);
  const unavailable = (reason) => ({ mode: 'unavailable', reason, nodeId, platform: null, linkedSince: null });
  if (!keys.signingEnabled()) return unavailable('SIGNING_DISABLED');
  const { key, answers } = await agreedOn(async (node) => {
    const status = await readStatus(nodeId, node);
    if (status === null) return null;
    if (!status.listed) return { key: 'not_listed' };
    if (!status.unbind) return { key: 'unsupported' };
    // a node that lists the feature names the device; one that does not is unreadable
    if (status.device === null) return null;
    return { key: status.device.state === 'unlinked' ? 'unlinked' : 'bound', device: status.device };
  });
  if (key === null) return unavailable('NETWORK');
  if (key === 'unsupported') return unavailable('UNSUPPORTED');
  if (key !== 'bound') return unavailable('NOT_LINKED');
  // a genesis that took the binding only by gossip names no platform yet ('unknown'): the other answer may
  const devices = answers.map((entry) => entry.answer.device);
  const named = devices.find((device) => device.platform === 'android' || device.platform === 'ios') ?? devices[0];
  return {
    mode: 'confirm', reason: null, nodeId, platform: named.platform ?? 'unknown',
    linkedSince: devices.map((device) => device.linkedSince).find((since) => since !== null) ?? null,
  };
}

// The device binding two pinned nodes' signed status report alike: {key: 'bound:{binding_seq}' | 'unbound', answers}, key
// null when no two agree. A sequence a JSON number cannot carry exactly is no answer.
function deviceBinding(wallet, nodeId) {
  return signedStatus(wallet, nodeId, (read) => {
    if (read.device_bound === false) return 'unbound';
    const seq = read.device_bound === true ? u64Of(read.binding_seq) : null;
    return seq !== null && seq !== '0' && Number.isSafeInteger(Number(seq)) ? `bound:${seq}` : null;
  });
}

// One node's answer to the unbind: 'ok' (it took it), 'stale' (stale_seq: no binding at that sequence any more), 'refused'
// (any other refusal), or null (no answer).
async function postUnbind(node, body) {
  let reply;
  try {
    reply = await qnet.nodeRequest(UNBIND_PATH, { method: 'POST', body, nodes: [node] });
  } catch {
    return null;
  }
  const read = parse(reply.text);
  if (!isObject(read)) return reply.status === 200 ? null : 'refused';
  if (reply.status === 200 && read.success === true && read.unbound === true && read.node_id === body.node_id) return 'ok';
  return read.reason === 'stale_seq' ? 'stale' : 'refused';
}

/**
 * The action of qnet_unlinkNodeDevice and of the popup's Unlink (decision 38): the wallet key ends this wallet's light
 * node on whatever device runs it. The binding's sequence S is the one two pinned nodes' signed status report alike for
 * a bound device; the wallet key signs q1337|light_unbind_wallet:{N}:{S}:{ts}, and the unbind goes to the node whose
 * status gave S, then to the other one that agreed (which also answers when the first did not). A node answering
 * stale_seq is read again: two nodes saying no device is bound is the unlink done. The genesis nodes copy the unbind to
 * each other; the device stops on its next read or answer.
 * @returns {Promise<UnlinkOutcome>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED, NOT_LINKED, NETWORK, UNLINK_REFUSED
 */
export async function unlinkForSite() {
  const wallet = (await session.requireUnlocked()).qnetAddress;
  const nodeId = core.lightNodeId(wallet);
  const binding = await deviceBinding(wallet, nodeId);
  if (binding.key === null) throw new WalletError('NETWORK');
  if (binding.key === 'unbound') throw new WalletError('NOT_LINKED');
  const seq = binding.key.slice('bound:'.length);
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = await keys.signNodeUnbind({ nodeId, wallet, seq, timestamp });
  const body = {
    node_id: nodeId, seq: Number(seq), ts: timestamp, signer: 'wallet', sig: core.bytesToHex(signed.signature),
    identity_pubkey: core.bytesToHex(signed.publicKey),
  };
  const [first, second] = binding.answers.map((entry) => entry.node);
  // the other node takes it too: in place of the first when that one did not answer, else to save the copy its trip
  const answers = [await postUnbind(first, body), await postUnbind(second, body)];
  const done = { status: 'ok', qnet: wallet, nodeId, unbound: true };
  if (answers.includes('ok')) return done;
  if (answers.every((answer) => answer === null)) throw new WalletError('NETWORK');
  // another unbind or a newer binding came first: done only when two nodes now say no device is bound
  if (answers.includes('stale') && (await deviceBinding(wallet, nodeId)).key === 'unbound') return done;
  throw new WalletError('UNLINK_REFUSED');
}
