// Node activation (spec: Activate tab; QNet Link v1 section 10). In the extension the 1DEV burn happens
// from the Activate tab, or from aiqnet.io through qnet_activateNode, both on the same path below; the
// mobile app never burns. Each wallet has exactly one activation code, for a Light or a Super node, kept inside the
// vault ciphertext. The burn amount comes from the node's
// price endpoint, never from a message (MISS-04); Recover finds this wallet's oldest valid burn on chain
// and re-derives its code, it never issues a second one, and a settled burn stores that oldest burn too
// (another device of the same phrase may have burned first). Every change of the activation record or
// the pending burn calls events.notifyViews('activation'). A light activation is stored with its registration on the
// QNet network queued (VaultState.registration, nodes.js), which sw.js starts through setRegistrationHook. A light burn
// aiqnet.io's one-time payment key made for this wallet is found by Recover through the node's registration record and
// kept with the wallet's code; it answers the site NODE_EXISTS. Since no search of the phrase's addresses finds such a
// burn, no burn starts until the QNet network vouches that the wallet has no node (refuseExistingNodes, fail closed).
// aiqnet.io keeps a verified record of every wallet's burn and one reservation per wallet (CONTRACTS.md decision 35): no
// burn starts while it holds either, a burn is signed only under its reservation, which the wallet asks with its own
// signature (decision 36), and announced with the wallet's proof before it is sent, and a burn the vault holds is recorded
// there (syncRecord), so every browser and device of the wallet sees its one code and none offers a second burn. Any
// source that cannot answer means no burn.
import * as core from '../lib/qnet-core.js';
import { DECIMALS, QNET, RECORD_PATH, SOLANA, TIMINGS } from './config.js';
import { WalletError } from './errors.js';
import { notifyViews } from './events.js';
import * as keys from './keys.js';
import { log } from './log.js';
import { lightNodeKnown, publicRegistration, registeredBurn, registrationFor } from './nodes.js';
import * as qnet from './qnet.js';
import * as session from './session.js';
import * as solana from './solana.js';
import * as vault from './vault.js';

/**
 * @typedef {object} PublicActivation  what the popup may show without a password
 * @property {'light'|'super'} nodeType
 * @property {string} burnTx
 * @property {number} burnAmount
 * @property {string} solanaAddress
 * @property {string} cluster
 * @property {number} createdAt
 * @property {string} codeMasked e.g. QNET-L•••••-••••••-••••36
 * @property {boolean} paidOnSite a light burn aiqnet.io's one-time payment key made for this wallet: solanaAddress is that
 *   key, and the code names this wallet (core.walletActivationCode)
 *
 * @typedef {object} PriceQuote
 * @property {1|2} phase refuse to burn when 2
 * @property {{cost: number}} light whole 1DEV (phase 1)
 * @property {{cost: number}} super whole 1DEV (phase 1)
 * @property {number} fetchedAt ms epoch
 *
 * @typedef {object} SiteView  what the qnet_activateNode approval window offers (siteView)
 * @property {'burn'|'exists'|'pending'|'unavailable'|'checking'} mode checking: the search of the wallet's own address
 *   is running, so nothing is offered yet
 * @property {string|null} reason unavailable: PRICE_UNAVAILABLE, PHASE_UNSUPPORTED, NODE_EXISTS, NETWORK (the QNet
 *   network could not vouch that the wallet has no node), BURN_IN_PROGRESS, INSUFFICIENT_TOKENS, INSUFFICIENT_SOL,
 *   SIGNING_DISABLED, BURN_UNUSABLE, SOLANA_UNAVAILABLE, HISTORY_TOO_LONG (the search could not decide), or aiqnet.io's
 *   record: ACTIVATION_RECORDED (it holds a burn of this wallet), ACTIVATION_RESERVED (one is starting elsewhere),
 *   RECORD_UNAVAILABLE (it could not answer)
 * @property {number|null} cost whole 1DEV the window shows (burn, and the INSUFFICIENT_* reasons)
 * @property {PublicActivation|null} activation exists
 * @property {import('./vault.js').PendingBurn|null} pending pending
 * @property {{lamports: string, oneDevRaw: string}|null} balances null when Solana could not be read
 * @property {boolean} nodeChecked the QNet network vouched that this wallet has no node (refuseExistingNodes)
 * @property {import('./nodes.js').RegistrationView|null} registration the registration of the activation's light node
 *
 * @typedef {{status: 'ok', activation: import('./vault.js').Activation}
 *   | {status: 'exists', activation: import('./vault.js').Activation, superseded?: PublicBurn|null}
 *   | {status: 'pending', pending: import('./vault.js').PendingBurn}} SiteOutcome
 *   superseded: the burn this request sent, which another device's older burn of the phrase beat: the activation
 *   answered is that older one (XP-R5-03)
 *
 * @typedef {{burnTx: string, nodeType: 'light'|'super', burnAmount: number, solanaAddress: string, cluster: string,
 *   createdAt: number}} PublicBurn
 *
 * @typedef {object} RecordView  aiqnet.io's record of this wallet's burn as the Activate tab shows it (lookup)
 * @property {'reserved'|'sending'|'recorded'} state
 * @property {'light'|'super'} nodeType
 * @property {'extension'|'payment'} way
 * @property {string|null} burnTx
 * @property {number} burnAmount
 * @property {number|null} until
 * @property {boolean} paidOnSite way payment
 * @property {string|null} codeMasked recorded, once its burn was read from Solana
 * @property {number|null} createdAt recorded: the burn's block time, once read from Solana
 *
 * @typedef {object} ActivationLookup  the Activate tab's view (lookup): activation.status's fields, then
 * @property {'activation'|'pending'|'busy'|'checking'|'elsewhere'|'record'|'node'|'unusable'|'unavailable'|'none'} view
 *   activation: the vault's; pending: a burn on its way; busy: an activation runs here; checking: the search of the
 *   wallet's own address runs; elsewhere: aiqnet.io holds a reservation or a burn on its way (either way); record:
 *   aiqnet.io's record is the wallet's code and the vault holds none of it; node: the QNet network
 *   knows a node of this wallet and no code of it is known here; unusable: a burn no code derives from; unavailable: a
 *   source could not answer (reason); none: every source says there is no burn and no node, the only view that offers
 *   one
 * @property {string|null} reason unavailable: RECORD_UNAVAILABLE, NETWORK, SOLANA_UNAVAILABLE or HISTORY_TOO_LONG
 * @property {RecordView|null} record
 * @property {PublicBurn|null} keptBurn record: the vault's own burn, which aiqnet.io's record of another burn beat
 *
 * @typedef {{status: 'searching'|'none'|'unusable', qnet: string, solana: string}
 *   | {status: 'unknown', qnet: string, solana: string, reason: 'SOLANA_UNAVAILABLE'|'HISTORY_TOO_LONG'}
 *   | {status: 'pending', qnet: string, solana: string, nodeType: 'light'|'super', burnTx: string, burnAmount: number}
 *   | {status: 'exists', qnet: string, solana: string, nodeType: 'light'|'super', burnTx: string, burnAmount: number,
 *     code: string, paidOnSite: boolean}} SiteActivation  what qnet_getActivation answers (siteActivation)
 */

const MAX_PRICE = 1_000_000_000;
const validPrice = (price) => Number.isSafeInteger(price) && price >= 1 && price <= MAX_PRICE;
// A pending burn is cleared only once it can no longer land: the finalized block height passed its
// blockhash's lastValidBlockHeight and the ledger still has no trace of it (EXT-CHAINS-03). A record
// written before that height was kept falls back to this long wall-clock bound.
const PENDING_BURN_LEGACY_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Masks all but the node-type letter and the last two characters of a code.
 * @param {string} code
 * @returns {string}
 */
export function maskCode(code) {
  if (typeof code !== 'string' || code.length < 8) return '';
  return Array.from(code, (c, i) => (c === '-' || i < 6 || i >= code.length - 2 ? c : '•')).join('');
}

/**
 * The popup's view of an activation record (no code).
 * @param {import('./vault.js').Activation} activation
 * @returns {PublicActivation}
 */
export function publicActivation(activation) {
  const { nodeType, burnTx, burnAmount, solanaAddress, cluster, createdAt, code } = activation;
  return { nodeType, burnTx, burnAmount, solanaAddress, cluster, createdAt, codeMasked: maskCode(code), paidOnSite: paidOnSite(activation) };
}

// A light burn aiqnet.io's one-time payment key made for this wallet (Recover finds it through the node's registration
// record): the vault keeps only such a code that is not the burner's (vault.js), the wallet's own instead.
function paidOnSite(activation) {
  const { nodeType, code, solanaAddress, burnTx, burnAmount } = activation;
  return nodeType === 'light' && !core.activationCodeMatches(code, nodeType, solanaAddress, burnTx, burnAmount);
}

function publicPending(pending) {
  if (!pending) return null;
  const { burnTx, nodeType, burnAmount, solanaAddress, cluster, createdAt } = pending;
  return { burnTx, nodeType, burnAmount, solanaAddress, cluster, createdAt };
}

// This device's own burn that an older burn of the phrase beat (VaultState.supersededBurn, XP-R5-03), as shown.
const publicSuperseded = publicPending;

// Burn, Recover and the pending-burn check run one at a time (the popup cannot start two burns). A search the
// worker resumed on its own after an unlock (resumeBurnSearches), or the shared search of the wallet's own address
// (walletVerdict), is waited for, never refused: the action then goes on from where it got (R4-ESA-03). No shared
// search starts while an action waits for the lane.
let busy = false;
let resuming = null;
let searching = null;
let waiting = 0;
async function exclusive(fn) {
  waiting += 1;
  try {
    while (resuming !== null || searching !== null) await (resuming ?? searching);
  } finally {
    waiting -= 1;
  }
  if (busy) throw new WalletError('BURN_IN_PROGRESS');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- the registration on the QNet network

let registrationHook = null;

/**
 * sw.js wiring: what starts a registration this module queued (nodes.resumeRegistration), with {recheck: true} for a
 * confirmed site request, which has a record on chain read again. Without it (tests of this module alone) a queued
 * registration waits for the next resume.
 * @param {((options: {recheck: boolean}) => unknown)|null} fn
 * @returns {void}
 */
export function setRegistrationHook(fn) {
  registrationHook = typeof fn === 'function' ? fn : null;
}

// `recheck`: a record on chain is read again too (nodes.resumeRegistration), for a confirmed site request.
function startRegistration(record, { recheck = false } = {}) {
  const listed = record?.state === 'onchain' || record?.state === 'other_burn';
  if (registrationHook === null || !(record?.state === 'queued' || (recheck && listed))) return;
  Promise.resolve().then(() => registrationHook({ recheck })).catch((error) => log.warn('registration not started', error?.code ?? error?.name));
}

// A confirmed site request for the vault's light activation records it too: its registration is queued, again when it
// stopped, and one on chain is read again (two nodes that both no longer list the node queue it again). A vault that
// cannot be written now only delays it (Record on the network, the next request).
async function queueRegistration(wallet) {
  try {
    const state = await vault.updateState((s) => ({
      ...s, registration: registrationFor(s.registration, s.activation, wallet.qnetAddress, Date.now(), { retry: true }),
    }));
    startRegistration(state.registration, { recheck: true });
  } catch (error) {
    if (error instanceof WalletError && error.code === 'LOCKED') throw error;
    log.warn('registration not queued', error?.code ?? error?.name);
  }
}

// ---------------------------------------------------------------- price

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// One node's quote for `nodeType`: {phase, cost}, cost a whole number; anything else is refused.
async function quotePrice(nodeType, nodes) {
  let reply;
  try {
    reply = await qnet.nodeRequest(`/api/v1/activation/price?type=${nodeType}`, nodes ? { nodes } : {});
  } catch {
    throw new WalletError('PRICE_UNAVAILABLE');
  }
  let body = null;
  try {
    body = reply.status === 200 ? qnet.parseJsonLossless(reply.text) : null;
  } catch {
    body = null;
  }
  const valid = body && typeof body === 'object' && !Array.isArray(body) && body.error === undefined
    && (body.node_type === undefined || body.node_type === nodeType);
  const phase = valid ? { 1: 1, 2: 2 }[body.phase] : undefined;
  const cost = valid && typeof body.cost === 'string' && /^[1-9][0-9]{0,9}$/.test(body.cost) ? Number(body.cost) : null;
  if (!phase || cost === null || cost > MAX_PRICE) throw new WalletError('PRICE_UNAVAILABLE');
  if (phase === 1 && body.currency !== '1DEV') throw new WalletError('PRICE_UNAVAILABLE');
  return { phase, cost };
}

/**
 * Handler of `activation.price`: GET /api/v1/activation/price?type=light and ?type=super from the
 * pinned nodes. No fallback numbers: a missing, non-integer or error answer fails.
 * @returns {Promise<PriceQuote>}
 * @throws {WalletError} PRICE_UNAVAILABLE
 */
export async function getPrice() {
  const [light, superNode] = await Promise.all([quotePrice('light'), quotePrice('super')]);
  if (light.phase !== superNode.phase) throw new WalletError('PRICE_UNAVAILABLE');
  return { phase: light.phase, light: { cost: light.cost }, super: { cost: superNode.cost }, fetchedAt: Date.now() };
}

// The price the burn is built with: two different pinned nodes must quote the same phase-1 cost.
async function burnPrice(nodeType) {
  const quotes = [];
  const nodes = shuffled(QNET.NODES);
  while (quotes.length < 2 && nodes.length > 0) {
    const wave = nodes.splice(0, 2 - quotes.length);
    const answers = await Promise.all(wave.map((node) => quotePrice(nodeType, [node]).catch(() => null)));
    quotes.push(...answers.filter(Boolean));
  }
  if (quotes.length < 2 || quotes[0].phase !== quotes[1].phase || quotes[0].cost !== quotes[1].cost) {
    throw new WalletError('PRICE_UNAVAILABLE');
  }
  if (quotes[0].phase !== 1) throw new WalletError('PHASE_UNSUPPORTED');
  return quotes[0].cost;
}

// ---------------------------------------------------------------- one code per wallet

// The Solana addresses whose burns are this phrase's: the wallet's own.
const burners = (wallet) => [wallet.solanaAddress];

// The last check before a burn, after the burn searches: the QNet network must vouch that this wallet has no node. The
// searches of the phrase's addresses are not complete evidence: a light burn aiqnet.io's one-time payment key made for
// this wallet is found by none of them (Recover reads it from the registration record). refuseExistingNode for the
// wallet's QNet address; then the wallet's light node itself (nodes.lightNodeKnown): any pinned node that lists it or
// holds its registration refuses (NODE_EXISTS: Recover looks for its code), and the burn goes on only when at least
// two nodes answer and none does. Anything less is not known: NETWORK, and nothing is burned.
async function refuseExistingNodes(wallet) {
  await refuseExistingNode(wallet.qnetAddress);
  const known = await lightNodeKnown(core.lightNodeId(wallet.qnetAddress));
  if (known === true) throw new WalletError('NODE_EXISTS');
  if (known === null) throw new WalletError('NETWORK');
}

// One node's GET /api/v1/verify-activation for `qnetAddress` (wallet in the header, out of the URL), or null.
async function verifyActivation(qnetAddress, node) {
  try {
    const reply = await qnet.nodeRequest('/api/v1/verify-activation', { headers: { 'x-qnet-wallet': qnetAddress }, nodes: [node] });
    const body = reply.status === 200 ? qnet.parseJsonLossless(reply.text) : null;
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// Pinned nodes asked two first, then one more at a time: a node that knows a node for this wallet refuses the burn
// (NODE_EXISTS), and one authoritative "no" (a node at the network's height) is needed to go on. A non-authoritative
// "no" (a node behind the network) is no proof; no authoritative answer from any node is NETWORK: no burn.
async function refuseExistingNode(qnetAddress) {
  const nodes = shuffled(QNET.NODES);
  let first = true;
  while (nodes.length > 0) {
    const wave = nodes.splice(0, first ? 2 : 1);
    first = false;
    const answers = await Promise.all(wave.map((node) => verifyActivation(qnetAddress, node)));
    if (answers.some((body) => body?.verified === true)) throw new WalletError('NODE_EXISTS');
    if (answers.some((body) => body?.verified === false && body.authoritative === true)) return;
  }
  log.warn('verify-activation', 'no authoritative answer');
  throw new WalletError('NETWORK');
}

// The QNet network's word for the Activate tab: 'exists' (it knows a node of this wallet), 'none' (it vouched that there
// is none, refuseExistingNodes), 'unknown' (it could not vouch).
async function networkVerdict(wallet) {
  try {
    await refuseExistingNodes(wallet);
    return 'none';
  } catch (error) {
    if (error instanceof WalletError && error.code === 'NODE_EXISTS') return 'exists';
    if (error instanceof WalletError && error.code === 'NETWORK') return 'unknown';
    throw error;
  }
}

// ---------------------------------------------------------------- aiqnet.io's record of this wallet's burn

// CONTRACTS.md decisions 35 and 36. aiqnet.io keeps a verified record of every wallet's burn (both ways, both node types)
// and at most one reservation per wallet, taken in one atomic step and only with the wallet's own signature: a burn of this
// extension is signed only under the reservation it granted (reserveBurn), announced with the wallet's proof before it is
// sent (announceBurn), and its record is kept once final (syncRecord). Every client that burns for a wallet holds that
// same reservation, so two browsers or devices can never both burn for one wallet, and a wallet that has a record is never
// offered a burn again. A payment address's burn is announced with its owner bind too and recorded once final, for good.

const RECORD_STATES = Object.freeze(['none', 'reserved', 'sending', 'recorded']);
const RECORD_KEYS = 'burnAmount,burnTx,burner,code,nodeType,recordedAt,scan,state,until,wallet,way';
const RECORD_WAYS = Object.freeze(['extension', 'payment']);
const RESERVATION_RE = /^[0-9a-f]{32}$/;
const isMs = (value) => Number.isSafeInteger(value) && value >= 0;
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The code a record's burn yields: the burner's for a burn of the extension, the wallet's for a light burn aiqnet.io's
// one-time payment key made (core.walletActivationCode). null when it yields none.
function recordCode(qnetAddress, { way, nodeType, burner, burnTx, burnAmount }) {
  try {
    return way === 'payment' ? core.walletActivationCode(qnetAddress, burnTx, burnAmount)
      : core.generateActivationCode(nodeType, burner, burnTx, burnAmount);
  } catch {
    return null;
  }
}

/**
 * aiqnet.io's answer to GET RECORD_PATH{wallet} (decision 35), checked key by key: exactly the record's keys, the wallet
 * asked for, and the fields each state carries (a reservation has no burn yet; a payment burn is light; a record's own
 * `code` is not trusted: the Activate tab derives it from the burn once Solana shows it).
 * @param {unknown} body
 * @param {string} qnetAddress
 * @returns {{state: 'none'}|{state: string, nodeType: string, way: string, burner: string|null, burnTx: string|null,
 *   burnAmount: number, until: number|null, recordedAt: number|null}|null} null when it is no such answer
 */
export function parseRecord(body, qnetAddress) {
  if (!isObject(body) || Object.keys(body).sort().join(',') !== RECORD_KEYS || body.wallet !== qnetAddress
    || !RECORD_STATES.includes(body.state)) {
    return null;
  }
  const { state, nodeType, way, burner, burnTx, burnAmount, code, until, recordedAt } = body;
  if (state === 'none') {
    return [nodeType, way, burner, burnTx, burnAmount, code, until, recordedAt].every((value) => value === null) ? { state } : null;
  }
  const ok = core.ACTIVATION_NODE_TYPES.includes(nodeType) && RECORD_WAYS.includes(way) && (way === 'extension' || nodeType === 'light')
    && validPrice(burnAmount)
    && (state === 'reserved' ? burner === null && burnTx === null
      : core.isValidSolanaAddress(burner) && core.isValidSolanaSignature(burnTx))
    && (state === 'recorded' ? until === null && typeof code === 'string' : isMs(until) && code === null)
    && (recordedAt === null || isMs(recordedAt));
  return ok ? { state, nodeType, way, burner, burnTx, burnAmount, until, recordedAt } : null;
}

// aiqnet.io's record of this wallet; only an answer that parses counts (RECORD_UNAVAILABLE otherwise).
async function readRecord(qnetAddress) {
  const reply = await qnet.siteRequest('GET', `${RECORD_PATH}${encodeURIComponent(qnetAddress)}`);
  if (reply.status === 200) {
    const record = parseRecord(reply.body, qnetAddress);
    if (record !== null) return record;
  }
  throw new WalletError(reply.status === 400 ? 'INTERNAL' : 'RECORD_UNAVAILABLE');
}

// What a record says of a new burn: null (none), ACTIVATION_RECORDED (it holds a burn of this wallet) or
// ACTIVATION_RESERVED (a reservation, or a burn on its way, of either way).
function recordRefusal(record) {
  if (record.state === 'none') return null;
  return record.state === 'recorded' ? 'ACTIVATION_RECORDED' : 'ACTIVATION_RESERVED';
}

// The check of aiqnet.io's record before a burn: anything but "none" refuses, and no answer is RECORD_UNAVAILABLE.
async function refuseRecorded(wallet) {
  const refusal = recordRefusal(await readRecord(wallet.qnetAddress));
  if (refusal !== null) throw new WalletError(refusal);
}

// The wallet code of a refusal of aiqnet.io (decision 35): a burn it knows, one starting elsewhere, a node the network
// lists, a network it could not ask; anything else it could not answer.
const REFUSALS = Object.freeze({
  has_burn: 'ACTIVATION_RECORDED', burn_found: 'ACTIVATION_RECORDED', burn_unusable: 'ACTIVATION_RECORDED',
  reserved: 'ACTIVATION_RESERVED', burn_pending: 'ACTIVATION_RESERVED', reservation: 'ACTIVATION_RESERVED', has_node: 'NODE_EXISTS',
});
function refusalOf(reply) {
  const error = isObject(reply.body) && typeof reply.body.error === 'string' ? reply.body.error : null;
  if (reply.status === 409) return error !== null && Object.hasOwn(REFUSALS, error) ? REFUSALS[error] : 'ACTIVATION_RESERVED';
  if (reply.status === 503 && error === 'network_unavailable') return 'NETWORK';
  if (reply.status === 400) return 'INTERNAL';
  return 'RECORD_UNAVAILABLE';
}

// POST RECORD_PATH reserve: this wallet's one reservation, for a burn of `burnAmount` whole 1DEV from its own address,
// asked with the wallet's own signature, made here without a window inside the burn the user confirmed (decision 36:
// aiqnet.io refuses a reservation nobody signed, one another key signed and one more than 10 minutes old; its 400 reads
// INTERNAL). Its deadline is kept here: the reservation's life from the moment it was asked, or the end aiqnet.io named
// when sooner.
async function reserveBurn(wallet, nodeType, burnAmount) {
  const asked = Date.now();
  const burner = wallet.solanaAddress;
  const proof = await keys.signReservation({
    wallet: wallet.qnetAddress, nodeType, way: 'extension', burner, time: Math.floor(asked / 1000),
  });
  const reply = await qnet.siteRequest('POST', `${RECORD_PATH}reserve`, {
    wallet: wallet.qnetAddress, nodeType, way: 'extension', burner, burnAmount, solana: wallet.solanaAddress, proof,
  });
  const body = isObject(reply.body) ? reply.body : {};
  if (reply.status !== 200 || typeof body.reservation !== 'string' || !RESERVATION_RE.test(body.reservation) || !isMs(body.until)) {
    throw new WalletError(reply.status === 200 ? 'RECORD_UNAVAILABLE' : refusalOf(reply));
  }
  let deadline = asked + TIMINGS.RESERVATION_TTL_MS;
  if (body.until > Date.now() && body.until < deadline) deadline = body.until;
  return { reservation: body.reservation, deadline };
}

// POST RECORD_PATH release: a reservation nothing was sent under goes back. Best effort: one not released ends on its own.
function releaseBurn(wallet, reservation) {
  qnet.siteRequest('POST', `${RECORD_PATH}release`, { wallet: wallet.qnetAddress, reservation })
    .catch((error) => log.warn('reservation not released', error?.code ?? error?.name));
}

// POST RECORD_PATH announce: the burn about to be sent, with the wallet's proof, under the reservation. Nothing is sent
// without its 200.
async function announceBurn(wallet, reservation, burnTx, proof) {
  const reply = await qnet.siteRequest('POST', `${RECORD_PATH}announce`, { wallet: wallet.qnetAddress, reservation, burnTx, proof });
  if (reply.status === 200 && isObject(reply.body) && reply.body.ok === true) return;
  if (reply.status === 409) throw new WalletError('ACTIVATION_RESERVED');
  throw new WalletError(reply.status === 200 ? 'RECORD_UNAVAILABLE' : refusalOf(reply));
}

// A burn of the wallet's own address in the vault, which aiqnet.io records with the wallet's own proof. A payment burn
// aiqnet.io records itself, once final, with the owner bind it was announced with.
const ownBurn = (wallet, activation) => activation !== null && activation.solanaAddress === wallet.solanaAddress && !paidOnSite(activation);

// POST RECORD_PATH record: the vault's own burn with a fresh proof. The record as aiqnet.io keeps it then (this burn, or
// the other burn it keeps: other_burn), or null while the burn is not final there or no answer came.
async function postRecord(wallet, activation) {
  const fields = {
    wallet: wallet.qnetAddress, nodeType: activation.nodeType, burner: activation.solanaAddress, burnTx: activation.burnTx,
    burnAmount: activation.burnAmount,
  };
  const proof = await keys.signBurnRecord(fields);
  const reply = await qnet.siteRequest('POST', `${RECORD_PATH}record`, { ...fields, proof });
  if (reply.status === 200) return parseRecord(reply.body, wallet.qnetAddress);
  if (reply.status === 409 && isObject(reply.body) && reply.body.error === 'other_burn') {
    return parseRecord(reply.body.activation, wallet.qnetAddress);
  }
  return null;
}

// What a sync learnt of aiqnet.io's record, per wallet: the vault burn it was for (burnTx), the other burn the record
// keeps as the wallet's code (other, a parsed record, or null), and when a sync that could not finish may run again
// (nextAt, 0 once it finished).
const synced = new Map();
let syncing = null;
const SYNC_RETRY_MS = 60000;

// Keeps what aiqnet.io's record holds against the vault's burn; a change of the other burn redraws the Activate tab.
function noteRecord(wallet, activation, record) {
  if (record?.state !== 'recorded') return;
  const before = synced.get(wallet.qnetAddress)?.other ?? null;
  const other = record.burnTx === activation.burnTx ? null : record;
  synced.set(wallet.qnetAddress, { burnTx: activation.burnTx, other, nextAt: 0 });
  if ((before?.burnTx ?? null) !== (other?.burnTx ?? null)) notifyViews('activation');
}

// The other burn aiqnet.io's record keeps as this wallet's code instead of the vault's `activation`, or null.
function recordOther(wallet, activation) {
  const known = synced.get(wallet.qnetAddress);
  return known?.burnTx === activation?.burnTx ? known.other : null;
}

/**
 * Brings aiqnet.io's record in line with the vault's own burn (decision 35): after an unlock (sw.js), a settled burn,
 * Recover, a burn the search stored, and whenever the Activate tab or a site's read (qnet_getActivation) sees such an
 * activation. It reads the record; unless the record holds this burn already or a payment burn, it posts this burn with a
 * fresh proof (aiqnet.io keeps the older of two burns of one address, the extension's own rule, and never replaces a
 * payment burn, on its way or final: decision 36). A record of another burn it keeps is the wallet's code from then on, and
 * the vault's burn is shown as one that gives none. One at a time; after it finished, not again for the same burn; one
 * that could not finish runs again after SYNC_RETRY_MS. Never throws, and never holds up the code.
 * @returns {Promise<void>}
 */
export async function syncRecord() {
  if (syncing !== null) return syncing;
  syncing = (async () => {
    try {
      const wallet = await session.requireUnlocked();
      const { activation } = await vault.readState();
      if (!ownBurn(wallet, activation)) return;
      const known = synced.get(wallet.qnetAddress);
      if (known?.burnTx === activation.burnTx && (known.nextAt === 0 || Date.now() < known.nextAt)) return;
      synced.set(wallet.qnetAddress, { burnTx: activation.burnTx, other: known?.other ?? null, nextAt: Date.now() + SYNC_RETRY_MS });
      const record = await readRecord(wallet.qnetAddress);
      if (record.state === 'recorded' && (record.burnTx === activation.burnTx || record.way === 'payment')) {
        noteRecord(wallet, activation, record);
        return;
      }
      noteRecord(wallet, activation, await postRecord(wallet, activation));
    } catch (error) {
      log.warn('burn record not synced', error?.code ?? error?.name);
    }
  })();
  try {
    await syncing;
  } finally {
    syncing = null;
  }
}

// syncRecord without waiting for it.
const syncSoon = () => {
  Promise.resolve().then(syncRecord).catch(() => {});
};

// The burns of aiqnet.io records this worker read from Solana, by signature: {code, createdAt} of a valid burn of its
// record, or null for one that is not. At most RECORD_CHECKS_MAX.
const checkedRecords = new Map();
const RECORD_CHECKS_MAX = 16;

// A record's burn as Solana finalized it (decision 35: a record is shown, or stored, only once its burn reads as the
// burn it names): its fee payer the burner, one 1DEV burn of the recorded amount, the node type's memo.
async function checkRecordBurn(wallet, record) {
  if (checkedRecords.has(record.burnTx)) return checkedRecords.get(record.burnTx);
  const tx = await solana.rpc('getTransaction', [record.burnTx,
    { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  // not served at finalized yet: not known now
  if (!tx) throw new WalletError('SOLANA_UNAVAILABLE');
  const match = solana.validateBurnTx(tx, { owner: record.burner, signature: record.burnTx, mint: SOLANA.ONE_DEV_MINT, decimals: DECIMALS.ONE_DEV });
  const code = match !== null && match.nodeType === record.nodeType && match.amount === record.burnAmount
    ? recordCode(wallet.qnetAddress, record) : null;
  const checked = code === null ? null : { code, createdAt: Number.isSafeInteger(tx.blockTime) ? tx.blockTime * 1000 : Date.now() };
  checkedRecords.set(record.burnTx, checked);
  while (checkedRecords.size > RECORD_CHECKS_MAX) checkedRecords.delete(checkedRecords.keys().next().value);
  return checked;
}

// The code of an aiqnet.io record the Activate tab shows as this wallet's (a payment burn, or the other burn a record
// keeps), for activation.copy: {qnetAddress, burnTx, code}.
let shownRecord = null;

function recordView(record, checked) {
  return {
    state: record.state, nodeType: record.nodeType, way: record.way, burnTx: record.burnTx, burnAmount: record.burnAmount,
    until: record.until, paidOnSite: record.way === 'payment', codeMasked: checked === null ? null : maskCode(checked.code),
    createdAt: checked === null ? null : checked.createdAt,
  };
}

function activationOf(burn, solanaAddress, createdAt) {
  return {
    code: core.generateActivationCode(burn.nodeType, solanaAddress, burn.burnTx, burn.burnAmount),
    nodeType: burn.nodeType,
    burnTx: burn.burnTx,
    burnAmount: burn.burnAmount,
    solanaAddress,
    cluster: SOLANA.CLUSTER,
    createdAt,
  };
}

// A burn search of `owner` resumes from what the vault kept of it (vault.readBurnScan / writeBurnScan): the one over
// its 1DEV associated account ('account'), or the one over the transactions it signed ('signed', R5-ESA-01).
const scanStore = (owner, kind = 'account') => ({
  load: () => vault.readBurnScan(owner, kind),
  save: (scan) => vault.writeBurnScan(owner, scan, kind),
});

// A search that could not reach a verdict: cut short by its budget (it resumes on the next try), or Solana
// could not be read.
const undecided = (scan) => new WalletError(scan.exhausted ? 'HISTORY_TOO_LONG' : 'SOLANA_UNAVAILABLE');

// Whether `owner` made a 1DEV burn of its own that yields no Light or Super code (R4-ESA-01): one its kept search
// found with another memo (a Full node), or one from another of its token accounts, which the kept search of
// the transactions it signed finds (R5-ESA-01: nothing a third party creates can stop that search, it only slows
// it). The node counts such a burn for an activation, so no new burn is offered on top of it (BURN_UNUSABLE); a
// search that cannot tell yet throws (HISTORY_TOO_LONG resumes where it stopped, SOLANA_UNAVAILABLE).
async function hasUnusableBurn(owner, scan, confirmed) {
  if (scan.unusable.length > 0) return true;
  const signed = await solana.findSignedBurns(owner, { confirmed, store: scanStore(owner, 'signed') });
  if (signed.unusable.length > 0) return true;
  if (!signed.complete) throw undecided(signed);
  return false;
}

// A kept search a budget cut short: the listing has not reached the start, a range above its head is open, or
// candidates still wait.
const searchUnfinished = (scan) => scan !== null && typeof scan === 'object'
  && (scan.reachedStart !== true || scan.range !== null || (Array.isArray(scan.unchecked) && scan.unchecked.length > 0));
// What a resume after an unlock may spend on one owner's search.
const RESUME_DEADLINE_MS = 30000;

/**
 * The burns of `owner`, from its kept search (solana.findWalletBurns with the vault's store).
 * @param {string} owner
 * @param {{confirmed?: boolean}} [options]
 */
function scanBurns(owner, options = {}) {
  return solana.findWalletBurns(owner, { ...options, store: scanStore(owner) });
}

// The burn whose code the wallet keeps: this device's own finalized burn, unless the wallet's finalized
// history shows an older valid one (the same phrase burned on another device first). The oldest burn is
// the wallet's one code, as Recover derives it (EXT-CHAINS-03). Only candidates at or before our own slot
// can change that, so the answer never waits for newer history (R2-ESA-01): once the whole history was listed
// and nothing unchecked is at or before our slot, our burn is the first. While the range above the kept head
// is not listed to its end, an older burn may still lie in its unlisted part (R3-ESA-02): no answer yet.
async function oldestBurn(pending, ownSlot) {
  const scan = await scanBurns(pending.solanaAddress);
  const first = scan.canonical;
  if (first === null) {
    const olderUnchecked = !scan.reachedStart || !scan.listingComplete
      || (scan.oldestUnchecked !== null && (ownSlot === null || scan.oldestUnchecked.slot <= ownSlot));
    const olderFound = scan.burns.some((burn) => burn.signature !== pending.burnTx
      && (burn.slot === null || ownSlot === null || burn.slot <= ownSlot));
    if (olderUnchecked || olderFound) throw undecided(scan);
    return pending;
  }
  if (first.signature === pending.burnTx) return pending;
  // With this burn listed too, the scan ordered both; otherwise their slots do.
  const ownListed = scan.burns.some((burn) => burn.signature === pending.burnTx);
  if (!ownListed && (first.slot === null || ownSlot === null || first.slot === ownSlot)) {
    throw new WalletError('SOLANA_UNAVAILABLE');
  }
  if (!ownListed && first.slot > ownSlot) return pending;
  return { nodeType: first.nodeType, burnTx: first.signature, burnAmount: first.amount };
}

// Stores the activation of a burn the chain finalized, after checking the finalized transaction is the
// node-activation burn it was meant to be; the code is the wallet's oldest burn's. When that is another device's
// older burn, this device's own burn is kept as VaultState.supersededBurn, so the wallet still names it (XP-R5-03).
// null: the RPC does not serve the transaction yet.
async function settleBurn(pending) {
  const tx = await solana.rpc('getTransaction', [pending.burnTx,
    { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  if (!tx) return null;
  const match = solana.validateBurnTx(tx, {
    owner: pending.solanaAddress, signature: pending.burnTx, mint: SOLANA.ONE_DEV_MINT, decimals: DECIMALS.ONE_DEV,
  });
  // A finalized burn of ours that does not match stays pending: it blocks a second burn, and no code
  // is issued for a transaction the node would not accept.
  if (!match || match.nodeType !== pending.nodeType || match.amount !== pending.burnAmount) {
    throw new WalletError('INTERNAL');
  }
  const ownSlot = Number.isSafeInteger(tx.slot) ? tx.slot : null;
  const activation = activationOf(await oldestBurn(pending, ownSlot), pending.solanaAddress, Date.now());
  const superseded = activation.burnTx === pending.burnTx ? null : publicSuperseded(pending);
  const { qnetAddress } = await session.requireUnlocked();
  const state = await vault.updateState((s) => {
    if (s.activation && s.activation.burnTx !== activation.burnTx) throw new WalletError('ALREADY_ACTIVATED');
    const stored = s.activation ?? activation;
    return {
      ...s, activation: stored, pendingBurn: null, supersededBurn: superseded ?? s.supersededBurn,
      registration: registrationFor(s.registration, stored, qnetAddress),
    };
  });
  notifyViews('activation');
  startRegistration(state.registration);
  // the record on aiqnet.io: the burn it announced, or the older burn of this address that is the wallet's code
  syncSoon();
  return state.activation;
}

async function clearPending(burnTx) {
  await vault.updateState((s) => (s.pendingBurn?.burnTx === burnTx ? { ...s, pendingBurn: null } : s));
  notifyViews('activation');
}

// Whether an unseen burn can never land: the finalized height passed its lastValidBlockHeight (read
// before the status is asked again, so a burn that landed in time is already visible), or, for an old
// record without that height, the long wall-clock bound.
async function burnExpired(pending) {
  if (pending.lastValidBlockHeight === null) return Date.now() - pending.createdAt > PENDING_BURN_LEGACY_EXPIRY_MS;
  return (await solana.blockHeight('finalized')) > pending.lastValidBlockHeight;
}

// One look at a pending burn: finalized → activation stored; failed, or unseen after it expired →
// record cleared.
async function checkPending(pending) {
  let status = await solana.signatureStatus(pending.burnTx);
  if (status === 'unknown' && await burnExpired(pending)) {
    status = await solana.signatureStatus(pending.burnTx);
    if (status === 'unknown') {
      await clearPending(pending.burnTx);
      return;
    }
  }
  if (status === 'finalized') await settleBurn(pending);
  else if (status === 'failed') await clearPending(pending.burnTx);
}

/**
 * Handler of `activation.status`. If a burn is pending, checks it once: finalized and valid → stores
 * the activation (of the wallet's oldest burn) and clears pendingBurn; failed, or unseen once the
 * finalized block height passed its lastValidBlockHeight → clears pendingBurn. A Solana outage leaves
 * the record as it is.
 * @returns {Promise<{activation: PublicActivation|null, pending: import('./vault.js').PendingBurn|null, busy: boolean,
 *   superseded: PublicBurn|null, registration: import('./nodes.js').RegistrationView|null}>} superseded: this device's own
 *   burn another device's older burn beat (XP-R5-03); registration: the recording of a light activation on the QNet network
 * @throws {WalletError} LOCKED
 */
export async function getStatus() {
  await session.requireUnlocked();
  let state = await vault.readState();
  // not while a search holds the lane: the popup would wait for it
  if (state.pendingBurn && !busy && searching === null && resuming === null && waiting === 0) {
    try {
      await exclusive(() => checkPending(state.pendingBurn));
      state = await vault.readState();
    } catch (error) {
      if (error instanceof WalletError && error.code === 'LOCKED') throw error;
      log.warn('pending burn check', error?.code ?? error?.name);
    }
  }
  return {
    activation: state.activation ? publicActivation(state.activation) : null,
    pending: publicPending(state.pendingBurn),
    busy,
    superseded: publicSuperseded(state.supersededBurn),
    registration: publicRegistration(state.registration),
  };
}

/**
 * Handler of `activation.burn`, single-flight. No password: the unlocked session and the popup's acknowledged press
 * authorize it (decision 33). Steps (spec Activate 1-7): refuse when
 * the vault has an activation or a pending burn, when the kept burn search of the wallet's Solana address
 * finds a valid burn, finalized or in flight (→ Recover),
 * or cannot read the whole history yet (HISTORY_TOO_LONG: the next try goes on; SOLANA_UNAVAILABLE), when aiqnet.io
 * holds a record, a reservation or a burn on its way for this wallet or cannot answer (ACTIVATION_RECORDED,
 * ACTIVATION_RESERVED, RECORD_UNAVAILABLE: decision 35), or
 * when the QNet network knows a node of this wallet or cannot vouch that it has none (refuseExistingNodes: NODE_EXISTS,
 * NETWORK); then burnNow: the price again from two nodes (phase 1, integer, equal to expectedPrice), 1DEV >= price,
 * aiqnet.io's reservation (asked with the wallet's signature: decision 36), SOL covers FEE_BUFFER_LAMPORTS + fee, build,
 * sign, simulate, the announce with the wallet's
 * proof; the pending record (with its blockhash's lastValidBlockHeight) is stored before the send; wait for
 * finalized. Timeout → status 'pending'. Finalized → code = core.generateActivationCode(type,
 * solanaAddress, signature, price) of the wallet's oldest finalized burn (normally this one), stored and recorded.
 * @param {{nodeType: 'light'|'super', expectedPrice: number}} params
 * @returns {Promise<{status: 'finalized', code: string, activation: PublicActivation, superseded: PublicBurn|null}
 *   | {status: 'pending', burnTx: string}>} the full code is returned once, right after the burn; superseded: this
 *   burn, when another device's older burn of the phrase is the activation (XP-R5-03)
 * @throws {WalletError} LOCKED, BURN_IN_PROGRESS, ALREADY_ACTIVATED, BURN_EXISTS,
 *   BURN_UNUSABLE, ACTIVATION_RECORDED, ACTIVATION_RESERVED, RECORD_UNAVAILABLE, NODE_EXISTS, NETWORK, PRICE_UNAVAILABLE,
 *   PRICE_CHANGED, PHASE_UNSUPPORTED, INSUFFICIENT_SOL, INSUFFICIENT_TOKENS, SIMULATION_FAILED, TX_FAILED, SOLANA_UNAVAILABLE,
 *   HISTORY_TOO_LONG, SIGNING_DISABLED
 */
export async function burn(params) {
  const { nodeType, expectedPrice } = params ?? {};
  if (!core.ACTIVATION_NODE_TYPES.includes(nodeType)) throw new WalletError('INVALID_NODE_TYPE');
  if (!validPrice(expectedPrice)) throw new WalletError('INVALID_PARAMS');
  const wallet = await session.requireUnlocked();
  return exclusive(async () => {
    // The user acted; a lock during the wait for finalization would keep the code from being stored.
    await session.touch();
    const state = await vault.readState();
    if (state.activation) throw new WalletError('ALREADY_ACTIVATED');
    if (state.pendingBurn) throw new WalletError('BURN_IN_PROGRESS');

    // with the confirmed page: a burn sent from another device of this phrase is seen before it finalizes. Valid
    // burns first, then whether the search is complete, then the burns no code derives from (R5-ESA-01).
    const scans = await burnerScans(wallet);
    if (scans.some(([, scan]) => scan.burns.length > 0 || scan.inFlight.length > 0)) throw new WalletError('BURN_EXISTS');
    for (const [, scan] of scans) if (!scan.complete) throw undecided(scan);
    for (const [owner, scan] of scans) if (await hasUnusableBurn(owner, scan, true)) throw new WalletError('BURN_UNUSABLE');
    // aiqnet.io's record of every burn of this wallet, the reservation another browser or device holds among them
    await refuseRecorded(wallet);
    await refuseExistingNodes(wallet);

    const { activation, pending, settleError } = await burnNow(wallet, nodeType, expectedPrice);
    // The burn is final; an outage or a lock now only delays storing it (activation.status settles it).
    const delay = settleError instanceof WalletError && ['SOLANA_UNAVAILABLE', 'HISTORY_TOO_LONG', 'LOCKED'].includes(settleError.code);
    if (settleError && !delay) throw settleError;
    if (!activation) return { status: 'pending', burnTx: pending.burnTx };
    const superseded = activation.burnTx === pending.burnTx ? null : publicSuperseded(pending);
    return { status: 'finalized', code: activation.code, activation: publicActivation(activation), superseded };
  });
}

// The kept search of every burner of the phrase (the wallet's Solana address), with the confirmed page: [owner, scan]
// pairs.
async function burnerScans(wallet) {
  const scans = [];
  for (const owner of burners(wallet)) scans.push([owner, await scanBurns(owner, { confirmed: true })]);
  return scans;
}

// The burn after the one-code checks, shared by `burn` and `activateForSite` and run inside exclusive(), in this order
// (decision 35): the price again from two nodes (equal to the confirmed one), the balances, aiqnet.io's reservation for
// this wallet (its request signed by the wallet: decision 36), the blockhash, build, sign, simulate, the announce with the
// wallet's proof, the pending record, the send,
// the wait for finalized. A burn is signed only while TIMINGS.SIGN_MARGIN_MS of its reservation is left, and sent only
// once aiqnet.io took its announce; anything that fails before that gives the reservation back and sends nothing.
// Returns the stored activation, or null with the pending record when Solana did not finalize in time or the record
// could not be stored yet (settleError says why). Throws only before anything was sent, or TX_FAILED.
async function burnNow(wallet, nodeType, expectedPrice) {
  const price = await burnPrice(nodeType);
  if (price !== expectedPrice) throw new WalletError('PRICE_CHANGED');

  const balances = await solana.getBalances();
  const needed = BigInt(price) * 10n ** BigInt(DECIMALS.ONE_DEV);
  if (!balances.oneDev.exists || BigInt(balances.oneDev.raw) < needed) {
    throw new WalletError('INSUFFICIENT_TOKENS');
  }
  if (BigInt(balances.lamports) < BigInt(SOLANA.FEE_BUFFER_LAMPORTS)) throw new WalletError('INSUFFICIENT_SOL');

  const { reservation, deadline } = await reserveBurn(wallet, nodeType, price);
  let pending;
  let transaction;
  try {
    const { blockhash, lastValidBlockHeight } = await solana.latestBlockhash();
    // without it a sent burn could never be told expired from slow (EXT-CHAINS-03)
    if (lastValidBlockHeight === null) throw new WalletError('SOLANA_UNAVAILABLE');
    const fields = { nodeType, amountWhole: price, recentBlockhash: blockhash };
    const fee = BigInt(await solana.burnFee(fields));
    if (BigInt(balances.lamports) < BigInt(SOLANA.FEE_BUFFER_LAMPORTS) + fee) throw new WalletError('INSUFFICIENT_SOL');
    // too little of the reservation left to announce and send under it: nothing is signed
    if (deadline - Date.now() < TIMINGS.SIGN_MARGIN_MS) throw new WalletError('RECORD_UNAVAILABLE');

    const built = await solana.buildBurnTransaction(fields);
    ({ transaction } = built);
    await solana.simulate(transaction);
    const proof = await keys.signBurnRecord({
      wallet: wallet.qnetAddress, nodeType, burner: wallet.solanaAddress, burnTx: built.signature, burnAmount: price,
    });
    await announceBurn(wallet, reservation, built.signature, proof);
    pending = {
      burnTx: built.signature,
      nodeType,
      burnAmount: price,
      solanaAddress: wallet.solanaAddress,
      cluster: SOLANA.CLUSTER,
      createdAt: Date.now(),
      lastValidBlockHeight,
    };
  } catch (error) {
    releaseBurn(wallet, reservation);
    throw error;
  }
  // announced: aiqnet.io holds this burn as on its way (one that never lands leaves its record by itself)
  await vault.updateState((s) => {
    if (s.activation) throw new WalletError('ALREADY_ACTIVATED');
    if (s.pendingBurn) throw new WalletError('BURN_IN_PROGRESS');
    return { ...s, pendingBurn: pending };
  });
  notifyViews('activation');
  const { burnTx: signature } = pending;

  let sent;
  try {
    const timeoutMs = TIMINGS.BURN_FINALIZE_TIMEOUT_MS;
    sent = await solana.sendAndConfirm(transaction, { commitment: 'finalized', timeoutMs });
  } catch (error) {
    // sendAndConfirm throws only for a transaction that cannot land
    await clearPending(signature).catch((e) => log.warn('pending burn not cleared', e?.code));
    throw error;
  }
  if (sent.status !== 'finalized') return { activation: null, pending, settleError: null };
  try {
    return { activation: await settleBurn(pending), pending, settleError: null };
  } catch (error) {
    return { activation: null, pending, settleError: error };
  }
}

// A valid burn of this phrase that Solana confirmed and has not finalized, sent by another device, is on its
// way: QNet Link v1 section 7 answers it `pending` with that burn's data, as the app does (XP-R2-05). The
// oldest such burn of `burner` is answered. One from the wallet's own address is also kept as the vault's
// pending burn, so activation.status settles it once it is final and no burn starts here meanwhile.
async function inFlightOutcome(inFlight, burner, wallet) {
  const [oldest] = inFlight.map((burn, index) => ({ burn, index }))
    .sort((a, b) => ((a.burn.slot ?? Infinity) - (b.burn.slot ?? Infinity)) || (b.index - a.index))
    .map(({ burn }) => burn);
  const pending = {
    burnTx: oldest.signature,
    nodeType: oldest.nodeType,
    burnAmount: oldest.amount,
    solanaAddress: burner,
    cluster: SOLANA.CLUSTER,
    createdAt: oldest.blockTime !== null ? oldest.blockTime * 1000 : Date.now(),
  };
  if (burner === wallet.solanaAddress) {
    try {
      await vault.updateState((s) => (s.activation || s.pendingBurn ? s
        : { ...s, pendingBurn: { ...pending, lastValidBlockHeight: null } }));
      notifyViews('activation');
    } catch (error) {
      if (error instanceof WalletError && error.code === 'LOCKED') throw error;
      log.warn('burn in flight not kept', error?.code ?? error?.name);
    }
  }
  return { status: 'pending', pending };
}

// Stores the canonical (oldest valid) burn of `burner`'s scan as the wallet's activation unless the vault
// has one; its code is derived with the address that burned.
async function storeCanonical(canonical, burner) {
  const createdAt = canonical.blockTime !== null ? canonical.blockTime * 1000 : Date.now();
  const activation = activationOf({
    nodeType: canonical.nodeType, burnTx: canonical.signature, burnAmount: canonical.amount,
  }, burner, createdAt);
  const { qnetAddress } = await session.requireUnlocked();
  const stored = await vault.updateState((s) => (s.activation ? s
    : { ...s, activation, pendingBurn: null, registration: registrationFor(s.registration, activation, qnetAddress) }));
  notifyViews('activation');
  startRegistration(stored.registration);
  syncSoon();
  return stored.activation;
}

// Stores aiqnet.io's record of a burn of the wallet's own address, whose burn Solana showed as recorded (checkRecordBurn),
// as the activation unless the vault holds one or a pending burn (decision 35: a restore finds its code at once, before
// its search reached the burn).
async function adoptRecord(wallet, record, createdAt) {
  const activation = activationOf({ nodeType: record.nodeType, burnTx: record.burnTx, burnAmount: record.burnAmount }, record.burner, createdAt);
  const stored = await vault.updateState((s) => (s.activation || s.pendingBurn ? s
    : { ...s, activation, registration: registrationFor(s.registration, activation, wallet.qnetAddress) }));
  notifyViews('activation');
  startRegistration(stored.registration);
  if (stored.activation?.burnTx === record.burnTx) synced.set(wallet.qnetAddress, { burnTx: record.burnTx, other: null, nextAt: 0 });
  return stored.activation;
}

// The burn the node's registration record names for this wallet's light node (nodes.registeredBurn), read back from
// Solana as a finalized light burn of 1DEV and stored as the activation with its registration on chain: a burn of the
// phrase's own addresses keeps the burner's code, one aiqnet.io's payment key made gets this wallet's code
// (core.walletActivationCode). null when there is none, or when the record or the burn cannot be read now.
async function storeRegisteredBurn(wallet) {
  let burnTx;
  let tx;
  try {
    burnTx = await registeredBurn();
    if (burnTx === null) return null;
    tx = await solana.rpc('getTransaction', [burnTx,
      { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  } catch (error) {
    if (error instanceof WalletError && error.code === 'LOCKED') throw error;
    log.warn('registration record not read', error?.code ?? error?.name);
    return null;
  }
  const burner = tx?.transaction?.message?.accountKeys?.[0]?.pubkey;
  const match = solana.validateBurnTx(tx, { owner: burner, signature: burnTx, mint: SOLANA.ONE_DEV_MINT, decimals: DECIMALS.ONE_DEV });
  if (!match || match.nodeType !== 'light') return null;
  const createdAt = Number.isSafeInteger(tx.blockTime) ? tx.blockTime * 1000 : Date.now();
  const burn = { nodeType: 'light', burnTx, burnAmount: match.amount };
  const activation = burners(wallet).includes(burner) ? activationOf(burn, burner, createdAt) : {
    ...activationOf(burn, burner, createdAt), code: core.walletActivationCode(wallet.qnetAddress, burnTx, match.amount),
  };
  const stored = await vault.updateState((s) => (s.activation || s.pendingBurn ? s : {
    ...s, activation, registration: { ...registrationFor(null, activation, wallet.qnetAddress), state: 'onchain' },
  }));
  notifyViews('activation');
  return stored.activation;
}

/**
 * The action of qnet_activateNode (provider.js, after its approval): `burn`'s path under the same
 * single-flight lock, except that what already exists is answered instead of refused. No password: the unlocked
 * session and the armed confirm of the approval's own window authorize it (provider.resolveActivation);
 * the vault's activation → 'exists' (one aiqnet.io paid for → NODE_EXISTS); a pending burn, checked once (finalized → 'exists', failed →
 * dropped) → 'pending'; the canonical burn of the kept search of the wallet's Solana address, stored with the
 * address that burned → 'exists'; a valid burn Solana confirmed and has not
 * finalized (another device's) → 'pending' with that burn (kept as the pending burn when the wallet's own
 * address sent it: inFlightOutcome); a history not read in full → HISTORY_TOO_LONG or SOLANA_UNAVAILABLE;
 * aiqnet.io's record (decision 35): a record → ACTIVATION_RECORDED, a reservation or a burn on its way elsewhere →
 * ACTIVATION_RESERVED, no answer → RECORD_UNAVAILABLE (the site learns NODE_EXISTS, BURN_IN_PROGRESS and INTERNAL);
 * refuseExistingNodes → NODE_EXISTS, or NETWORK when the QNet network cannot vouch that the wallet has no node (the
 * site learns INTERNAL: QNet Link v1 section 7 has no code for it); then the burn of `burnNow` → 'ok', or 'pending' once it was sent
 * but not finalized or stored (TX_FAILED stays an error). BURN_IN_PROGRESS only for an activation already
 * running here (the single-flight lock). Every burner's canonical and in-flight burns are answered before any
 * search that is incomplete, or that looks for burns no code derives from, can refuse (R5-ESA-01). A burn sent here
 * that another device's older burn beat answers 'exists' with that older activation and names this one
 * (`superseded`), whatever its node type: once a burn is sent the answer is never an error (XP-R5-03).
 * @param {{nodeType: 'light'|'super', expectedPrice: number|null}} params
 *   expectedPrice: the price the approval showed; null when it offered no burn (exists or pending), and
 *   then a path that would burn throws PRICE_CHANGED, so the window shows the burn first
 * @returns {Promise<SiteOutcome>} the activation includes its code (the provider's result guard allows it)
 * @throws {WalletError} LOCKED, BURN_IN_PROGRESS, BURN_UNUSABLE, ACTIVATION_RECORDED, ACTIVATION_RESERVED, RECORD_UNAVAILABLE,
 *   NODE_EXISTS, NETWORK, PRICE_UNAVAILABLE, PRICE_CHANGED, PHASE_UNSUPPORTED, INSUFFICIENT_SOL, INSUFFICIENT_TOKENS,
 *   SIMULATION_FAILED, TX_FAILED, SOLANA_UNAVAILABLE, HISTORY_TOO_LONG, SIGNING_DISABLED
 */
export async function activateForSite(params) {
  const { nodeType, expectedPrice } = params ?? {};
  if (!core.ACTIVATION_NODE_TYPES.includes(nodeType)) throw new WalletError('INVALID_NODE_TYPE');
  if (expectedPrice !== null && !validPrice(expectedPrice)) throw new WalletError('INVALID_PARAMS');
  const wallet = await session.requireUnlocked();
  return exclusive(async () => {
    await session.touch();
    let state = await vault.readState();
    // a burn of an earlier request that settles here, beaten by another device's older burn, is named too (section 7.1)
    let settledSuperseded = null;
    if (!state.activation && state.pendingBurn) {
      const before = state.supersededBurn?.burnTx ?? null;
      try {
        await checkPending(state.pendingBurn);
      } catch (error) {
        if (error instanceof WalletError && error.code === 'LOCKED') throw error;
        log.warn('pending burn check', error?.code ?? error?.name);
      }
      state = await vault.readState();
      if (state.supersededBurn !== null && state.supersededBurn.burnTx !== before) settledSuperseded = publicSuperseded(state.supersededBurn);
    }
    // a node aiqnet.io paid for is on chain already, and its code is no burn of this wallet's addresses (section 7)
    if (state.activation && paidOnSite(state.activation)) throw new WalletError('NODE_EXISTS');
    if (state.activation) {
      await queueRegistration(wallet);
      return {
        status: 'exists', activation: state.activation, ...(settledSuperseded ? { superseded: settledSuperseded } : {}),
      };
    }
    if (state.pendingBurn) return { status: 'pending', pending: publicPending(state.pendingBurn) };

    // as `burn`, with the confirmed page; only a finalized burn is stored, a younger one is on its way. What the
    // search found is answered before an incomplete search refuses (R5-ESA-01).
    const scans = await burnerScans(wallet);
    for (const [owner, scan] of scans) {
      if (scan.canonical) return { status: 'exists', activation: await storeCanonical(scan.canonical, owner) };
    }
    for (const [owner, scan] of scans) {
      if (scan.inFlight.length > 0) return inFlightOutcome(scan.inFlight, owner, wallet);
    }
    for (const [, scan] of scans) if (scan.burns.length > 0 || !scan.complete) throw undecided(scan);
    // a burn of this wallet no code derives from: never a second burn (the site learns INTERNAL: R4-ESA-01)
    for (const [owner, scan] of scans) if (await hasUnusableBurn(owner, scan, true)) throw new WalletError('BURN_UNUSABLE');
    await refuseRecorded(wallet);
    await refuseExistingNodes(wallet);
    if (expectedPrice === null) throw new WalletError('PRICE_CHANGED');

    const { activation, pending } = await burnNow(wallet, nodeType, expectedPrice);
    if (!activation) return { status: 'pending', pending: publicPending(pending) };
    // another device's older burn of the phrase is the activation: answered as it exists, with this burn named
    if (activation.burnTx !== pending.burnTx) {
      return { status: 'exists', activation, superseded: publicSuperseded(pending) };
    }
    return { status: 'ok', activation };
  });
}

const unitsOf1dev = (whole) => BigInt(whole) * 10n ** BigInt(DECIMALS.ONE_DEV);

/**
 * What the qnet_activateNode approval window offers now (provider.js, while unlocked): this wallet's
 * activation or pending burn (checked once, as activation.status does), else whether a burn of
 * `nodeType` can be offered and at which price. A burn is offered only when every source answered "none" (decision
 * 35): the shared search of the wallet's own address (a burn it finds is stored and shown: 'exists' or 'pending';
 * still running: 'checking'; BURN_UNUSABLE; SOLANA_UNAVAILABLE or HISTORY_TOO_LONG), aiqnet.io's record
 * (ACTIVATION_RECORDED, ACTIVATION_RESERVED, RECORD_UNAVAILABLE) and the QNet network (NODE_EXISTS, NETWORK). Nothing
 * is burned here.
 * @param {'light'|'super'} nodeType
 * @param {{cost?: number|null, nodeChecked?: boolean}} [known] cost: the price the window already
 *   showed, kept for the approval's life (the burn re-checks it); nodeChecked: the network already vouched
 *   that the wallet has no node (the burn checks it again)
 * @returns {Promise<SiteView>}
 * @throws {WalletError} LOCKED, INVALID_NODE_TYPE
 */
export async function siteView(nodeType, known = {}) {
  if (!core.ACTIVATION_NODE_TYPES.includes(nodeType)) throw new WalletError('INVALID_NODE_TYPE');
  const wallet = await session.requireUnlocked();
  let status = await getStatus();
  const viewOf = () => ({
    mode: 'burn', reason: null, cost: null, activation: status.activation, pending: status.pending, balances: null,
    nodeChecked: known.nodeChecked === true, registration: status.registration,
  });
  let view = viewOf();
  const unavailable = (reason, extra = {}) => ({ ...view, ...extra, mode: 'unavailable', reason });
  const existing = () => {
    if (status.activation?.paidOnSite) return unavailable('NODE_EXISTS');
    if (status.activation) return { ...view, mode: 'exists' };
    if (status.pending) return { ...view, mode: 'pending' };
    return null;
  };
  const shown = existing();
  if (shown !== null) return shown;
  if (status.busy) return unavailable('BURN_IN_PROGRESS');
  if (!keys.signingEnabled()) return unavailable('SIGNING_DISABLED');

  const search = await walletVerdict(wallet);
  if (search.search === 'found' || search.search === 'pending') {
    status = await getStatus();
    view = viewOf();
    const found = existing();
    if (found !== null) return found;
    forgetVerdict(wallet);
    return { ...view, mode: 'checking' };
  }
  if (search.search === 'searching') return { ...view, mode: 'checking' };
  if (search.search === 'unusable') return unavailable('BURN_UNUSABLE');
  if (search.search === 'unknown') return unavailable(search.reason);
  try {
    const refusal = recordRefusal(await readRecord(wallet.qnetAddress));
    if (refusal !== null) return unavailable(refusal);
  } catch (error) {
    if (error instanceof WalletError && ['RECORD_UNAVAILABLE', 'INTERNAL'].includes(error.code)) return unavailable('RECORD_UNAVAILABLE');
    throw error;
  }

  let cost = validPrice(known.cost) ? known.cost : null;
  if (cost === null) {
    let quote;
    try {
      quote = await getPrice();
    } catch {
      return unavailable('PRICE_UNAVAILABLE');
    }
    if (quote.phase !== 1) return unavailable('PHASE_UNSUPPORTED');
    cost = quote[nodeType].cost;
  }
  if (!view.nodeChecked) {
    try {
      // the wallet's QNet address and its light node, as the burn asks (EXT-R1-01)
      await refuseExistingNodes(wallet);
    } catch (error) {
      // no burn is offered while the network cannot vouch that the wallet has no node; the next read asks again
      if (error instanceof WalletError && ['NODE_EXISTS', 'NETWORK'].includes(error.code)) return unavailable(error.code);
      throw error;
    }
    view.nodeChecked = true;
  }
  let balances = null;
  try {
    const read = await solana.getBalances();
    balances = { lamports: read.lamports, oneDevRaw: read.oneDev.exists ? read.oneDev.raw : '0' };
  } catch (error) {
    // unknown balances do not block: the burn checks them again before anything is signed
    log.warn('balances for the approval', error?.code ?? error?.name);
  }
  if (balances !== null) {
    if (BigInt(balances.oneDevRaw) < unitsOf1dev(cost)) return unavailable('INSUFFICIENT_TOKENS', { cost, balances });
    if (BigInt(balances.lamports) < BigInt(SOLANA.FEE_BUFFER_LAMPORTS)) return unavailable('INSUFFICIENT_SOL', { cost, balances });
  }
  return { ...view, cost, balances };
}

// ---------------------------------------------------------------- the search of the wallet's own address, shared

// The last shared search: {owner, startedAt, finishedAt, verdict}. How long a read waits for a running one before it
// answers 'searching'.
let lastSearch = null;
const SEARCH_WAIT_MS = 3000;

// One search of the wallet's own address as a site request reads it (activateForSite), with the confirmed page: a
// finalized burn is stored as the activation and one on its way as the pending burn, as Recover and a site request
// store them. verdict.search: 'found' | 'pending' | 'unusable' | 'unknown' (with reason) | 'none'.
async function searchWallet(wallet) {
  const state = await vault.readState();
  if (state.activation) return { search: 'found' };
  if (state.pendingBurn) return { search: 'pending' };
  try {
    const scans = await burnerScans(wallet);
    for (const [owner, scan] of scans) {
      if (scan.canonical) {
        await storeCanonical(scan.canonical, owner);
        return { search: 'found' };
      }
    }
    for (const [owner, scan] of scans) {
      if (scan.inFlight.length > 0) {
        await inFlightOutcome(scan.inFlight, owner, wallet);
        return { search: 'pending' };
      }
    }
    for (const [, scan] of scans) if (scan.burns.length > 0 || !scan.complete) return { search: 'unknown', reason: undecided(scan).code };
    for (const [owner, scan] of scans) if (await hasUnusableBurn(owner, scan, true)) return { search: 'unusable' };
    return { search: 'none' };
  } catch (error) {
    if (error instanceof WalletError && ['SOLANA_UNAVAILABLE', 'HISTORY_TOO_LONG'].includes(error.code)) {
      return { search: 'unknown', reason: error.code };
    }
    throw error;
  }
}

function startSearch(wallet) {
  const entry = { owner: wallet.solanaAddress, startedAt: Date.now(), finishedAt: null, verdict: null };
  lastSearch = entry;
  searching = (async () => {
    try {
      entry.verdict = await searchWallet(wallet);
    } catch (error) {
      const locked = error instanceof WalletError && error.code === 'LOCKED';
      log.warn('wallet search', error?.code ?? error?.name);
      entry.verdict = { search: 'unknown', reason: 'SOLANA_UNAVAILABLE', locked };
      // a lock or an error is no verdict to keep: the next read searches again
      entry.startedAt = 0;
    } finally {
      entry.finishedAt = Date.now();
      searching = null;
    }
  })();
  return searching;
}

// The shared search's verdict for the wallet: the site's read (qnet_getActivation), the approval window (siteView) and
// the Activate tab (lookup) ask it. A search starts at most every TIMINGS.WALLET_SEARCH_SPACING_MS (within that the
// last verdict is answered), and a 'none' is good for TIMINGS.WALLET_SEARCH_FRESH_MS after it finished. A running
// search is waited for up to SEARCH_WAIT_MS, then 'searching'; while an activation action holds the lane or waits for
// it, or the search the worker resumed after an unlock runs, none starts: 'searching'.
async function walletVerdict(wallet) {
  const owner = wallet.solanaAddress;
  if (searching === null) {
    const now = Date.now();
    const last = lastSearch?.owner === owner && lastSearch.verdict !== null ? lastSearch : null;
    if (last !== null && (now - last.startedAt < TIMINGS.WALLET_SEARCH_SPACING_MS
      || (last.verdict.search === 'none' && now - last.finishedAt < TIMINGS.WALLET_SEARCH_FRESH_MS))) {
      return last.verdict;
    }
    if (busy || waiting > 0 || resuming !== null) return { search: 'searching' };
    startSearch(wallet);
  }
  const running = searching;
  let timer = null;
  const done = await Promise.race([
    running.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), SEARCH_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  const verdict = lastSearch?.owner === owner ? lastSearch.verdict : null;
  if (!done || verdict === null) return { search: 'searching' };
  if (verdict.locked) throw new WalletError('LOCKED');
  return verdict;
}

// A verdict that found a burn the vault does not hold (a reset and a restore in this worker, a burn in flight that could
// not be kept) answers nothing: the next read searches again, and until then the wallet is still being checked.
function forgetVerdict(wallet) {
  if (searching === null && lastSearch?.owner === wallet.solanaAddress) lastSearch.startedAt = 0;
}

/**
 * Handler of `activation.lookup`, the Activate tab's view of this wallet's activation (decision 35): the vault
 * (activation.status's fields), aiqnet.io's record, the QNet network and the shared search of the wallet's own address,
 * as one `view`. A vault activation is shown at once and recorded on aiqnet.io in the background (syncRecord); a record
 * of another burn aiqnet.io keeps as the wallet's code is shown as the code, with the vault's burn as `keptBurn`. With
 * no vault activation: a burn the search finds is stored; aiqnet.io's record of a burn of the wallet's own address is
 * stored once Solana shows it (a restore's shortcut), a payment burn is shown with the wallet's code, never stored or
 * recorded here; an activation starting elsewhere, a burn no code derives from and a node the network knows are shown
 * as such; a source that could not answer is named (unavailable). Only 'none', every source's "none", offers a burn.
 * @returns {Promise<ActivationLookup>} never a code: activation.copy gives it
 * @throws {WalletError} LOCKED
 */
export async function lookup() {
  const wallet = await session.requireUnlocked();
  let status = await getStatus();
  const base = { record: null, keptBurn: null, network: null, search: null, reason: null };
  const out = (view, extra = {}) => ({ ...status, ...base, view, ...extra });
  const settled = () => {
    if (status.activation) return out('activation');
    if (status.pending) return out('pending');
    return null;
  };

  if (status.activation) {
    syncSoon();
    const state = await vault.readState();
    const other = recordOther(wallet, state.activation);
    if (other !== null) {
      try {
        const checked = await checkRecordBurn(wallet, other);
        if (checked !== null) {
          shownRecord = { qnetAddress: wallet.qnetAddress, burnTx: other.burnTx, code: checked.code };
          return out('record', { record: recordView(other, checked), keptBurn: publicPending(state.activation) });
        }
      } catch (error) {
        if (error instanceof WalletError && error.code === 'LOCKED') throw error;
        log.warn('recorded burn unread', error?.code ?? error?.name);
      }
    }
    return out('activation');
  }
  if (status.pending) return out('pending');
  if (status.busy) return out('busy');

  const [read, network, verdict] = await Promise.all([
    readRecord(wallet.qnetAddress).then((record) => ({ record, error: null }),
      (error) => ({ record: null, error: error instanceof WalletError && error.code === 'INTERNAL' ? 'INTERNAL' : 'RECORD_UNAVAILABLE' })),
    networkVerdict(wallet).catch(() => 'unknown'),
    walletVerdict(wallet),
  ]);
  let search = verdict;
  if (search.search === 'found' || search.search === 'pending') {
    status = await getStatus();
    const now = settled();
    if (now !== null) return now;
    // a burn the search found and the vault does not hold is never "none"
    forgetVerdict(wallet);
    search = { search: 'searching' };
  }
  const extra = { network, search: search.search };
  const { record } = read;
  if (record?.state === 'recorded') {
    let checked;
    try {
      checked = await checkRecordBurn(wallet, record);
    } catch (error) {
      if (error instanceof WalletError && error.code === 'LOCKED') throw error;
      return out('unavailable', { ...extra, record: recordView(record, null), reason: 'SOLANA_UNAVAILABLE' });
    }
    if (checked === null) return out('node', { ...extra, record: recordView(record, null) });
    if (record.way === 'extension' && record.burner === wallet.solanaAddress) {
      await adoptRecord(wallet, record, checked.createdAt);
      status = await getStatus();
      const now = settled();
      if (now !== null) return now;
    }
    shownRecord = { qnetAddress: wallet.qnetAddress, burnTx: record.burnTx, code: checked.code };
    return out('record', { ...extra, record: recordView(record, checked) });
  }
  if (record !== null && record.state !== 'none') return out('elsewhere', { ...extra, record: recordView(record, null) });
  if (search.search === 'unusable') return out('unusable', extra);
  if (network === 'exists') return out('node', extra);
  if (search.search === 'searching') return out('checking', extra);
  if (record === null) return out('unavailable', { ...extra, reason: read.error === 'INTERNAL' ? 'RECORD_UNAVAILABLE' : read.error });
  if (search.search === 'unknown') return out('unavailable', { ...extra, reason: search.reason });
  if (network === 'unknown') return out('unavailable', { ...extra, reason: 'NETWORK' });
  return out('none', extra);
}

// When the pending burn a site's read saw was last checked; at most every TIMINGS.ACTIVATE_RECHECK_MS.
let pendingCheckedAt = 0;
function checkPendingSoon(pending) {
  if (busy || searching !== null || resuming !== null || waiting > 0 || Date.now() - pendingCheckedAt < TIMINGS.ACTIVATE_RECHECK_MS) return;
  pendingCheckedAt = Date.now();
  exclusive(() => checkPending(pending)).catch((error) => log.warn('pending burn check', error?.code ?? error?.name));
}

/**
 * What qnet_getActivation answers aiqnet.io (decision 35; provider.js, never a window, for a connected site while
 * unlocked): the extension's own knowledge of this wallet's activation. The vault's activation → 'exists' with its code
 * (paidOnSite: a light burn aiqnet.io's payment key made, whose code names the wallet), and it is recorded on aiqnet.io
 * in the background; a pending burn → 'pending' (checked again in the background, at most every
 * TIMINGS.ACTIVATE_RECHECK_MS); otherwise the shared search of the wallet's own address: a burn it finds is stored and
 * answered as above, 'searching' while it runs (or an activation runs here), 'unknown' with the reason it could not
 * decide, 'unusable' for a burn no code derives from, and 'none' only for a search that finished with nothing within
 * TIMINGS.WALLET_SEARCH_FRESH_MS. Nothing is signed for the site or burned; a burn the search finds is stored as Recover
 * stores it (a Light activation's record on the QNet network then starts, as after Recover).
 * @returns {Promise<SiteActivation>} qnet and solana are the unlocked wallet's own
 * @throws {WalletError} LOCKED
 */
export async function siteActivation() {
  const wallet = await session.requireUnlocked();
  const base = { qnet: wallet.qnetAddress, solana: wallet.solanaAddress };
  if (busy) return { status: 'searching', ...base };
  let state = await vault.readState();
  if (!state.activation && !state.pendingBurn) {
    const verdict = await walletVerdict(wallet);
    if (verdict.search === 'searching') return { status: 'searching', ...base };
    if (verdict.search === 'unknown') return { status: 'unknown', ...base, reason: verdict.reason };
    if (verdict.search === 'unusable') return { status: 'unusable', ...base };
    if (verdict.search === 'none') return { status: 'none', ...base };
    state = await vault.readState();
  }
  const { activation, pendingBurn } = state;
  if (activation) {
    syncSoon();
    return {
      status: 'exists', ...base, nodeType: activation.nodeType, burnTx: activation.burnTx, burnAmount: activation.burnAmount,
      code: activation.code, paidOnSite: paidOnSite(activation),
    };
  }
  if (pendingBurn) {
    checkPendingSoon(pendingBurn);
    return { status: 'pending', ...base, nodeType: pendingBurn.nodeType, burnTx: pendingBurn.burnTx, burnAmount: pendingBurn.burnAmount };
  }
  forgetVerdict(wallet);
  return { status: 'searching', ...base };
}

// aiqnet.io's record of a burn of the wallet's own address, stored once Solana shows the burn (adoptRecord); null when
// it holds none, or it or Solana cannot answer now.
async function storeRecordedBurn(wallet) {
  try {
    const record = await readRecord(wallet.qnetAddress);
    if (record.state !== 'recorded' || record.way !== 'extension' || record.burner !== wallet.solanaAddress) return null;
    const checked = await checkRecordBurn(wallet, record);
    return checked === null ? null : await adoptRecord(wallet, record, checked.createdAt);
  } catch (error) {
    if (error instanceof WalletError && error.code === 'LOCKED') throw error;
    log.warn('burn record not read', error?.code ?? error?.name);
    return null;
  }
}

/**
 * Handler of `activation.recover`: the kept burn search of the wallet's Solana address; the first canonical
 * (oldest valid) burn's code is re-derived with the address that burned and stored when the vault has none. An existing record that
 * matches is left as is; one that does not is never replaced. A search its budget cut short resumes on
 * the next Recover (HISTORY_TOO_LONG when nothing was found yet). When none of those addresses burned and the
 * vault holds neither an activation nor a pending burn, the burn the node's registration record names for the
 * wallet's light node is read and stored (storeRegisteredBurn): a burn aiqnet.io's one-time payment key made for
 * this wallet gets the wallet's code (core.walletActivationCode), and nothing is registered again; failing that,
 * aiqnet.io's record of a burn of the wallet's own address, once Solana shows it (decision 35).
 * @returns {Promise<{found: boolean, complete: boolean, activation: PublicActivation|null}>}
 *   complete false: the history could not be fully listed, so `found: false` is not proof of no burn
 * @throws {WalletError} LOCKED, BURN_IN_PROGRESS, SOLANA_UNAVAILABLE, HISTORY_TOO_LONG, BURN_UNUSABLE (only burns of this
 *   wallet no code derives from were found: R4-ESA-01)
 */
export async function recover() {
  const wallet = await session.requireUnlocked();
  return exclusive(async () => {
    const state = await vault.readState();
    const current = state.activation ? publicActivation(state.activation) : null;
    let found = false;
    let complete = true;
    let exhausted = false;
    let unusable = false;
    for (const owner of burners(wallet)) {
      const scan = await scanBurns(owner);
      if (scan.canonical) {
        if (state.activation) return { found: true, complete: complete && scan.complete, activation: current };
        const stored = await storeCanonical(scan.canonical, owner);
        return { found: true, complete: complete && scan.complete, activation: publicActivation(stored) };
      }
      found ||= scan.burns.length > 0;
      complete &&= scan.complete;
      exhausted ||= scan.exhausted;
      try {
        unusable ||= await hasUnusableBurn(owner, scan, false);
      } catch (error) {
        if (error instanceof WalletError && error.code === 'LOCKED') throw error;
        // its other 1DEV accounts could not be read: whether no burn exists is not known
        complete = false;
      }
    }
    // no burn of the phrase's addresses: the burn the node's registration record names for this wallet's light node, a
    // burn aiqnet.io's one-time payment key made for it among them (burn_tx → wallet)
    if (!state.activation && !state.pendingBurn) {
      const stored = await storeRegisteredBurn(wallet) ?? await storeRecordedBurn(wallet);
      if (stored) return { found: true, complete, activation: publicActivation(stored) };
    }
    if (!found && exhausted) throw new WalletError('HISTORY_TOO_LONG');
    // a burn of this wallet was found, in a form no code derives from: not "no burn" (R4-ESA-01)
    if (!found && unusable && current === null) throw new WalletError('BURN_UNUSABLE');
    return { found, complete, activation: current };
  });
}

/**
 * After an unlock (sw.js): goes on with a kept burn search a budget cut short (HISTORY_TOO_LONG), of the associated
 * account or of the signed transactions (R5-ESA-01), spending at most RESUME_DEADLINE_MS per search, so a long or flooded history is worked through without the user starting the search
 * again and again (R4-ESA-03). Only a search the user already started and only while the vault has neither an
 * activation nor a pending burn; nothing is burned or stored but the search itself. A burn, Recover or activation
 * request meanwhile waits for it (exclusive) and goes on from where it got. Never throws.
 * @returns {Promise<{resumed: number}>} how many owners' searches were resumed
 */
export async function resumeBurnSearches() {
  if (resuming !== null || busy || searching !== null) return { resumed: 0 };
  let resumed = 0;
  const run = (async () => {
    try {
      const wallet = await session.requireUnlocked();
      const state = await vault.readState();
      if (state.activation || state.pendingBurn) return;
      for (const owner of burners(wallet)) {
        if (searchUnfinished(await vault.readBurnScan(owner))) {
          resumed += 1;
          await solana.findWalletBurns(owner, { store: scanStore(owner), deadlineMs: RESUME_DEADLINE_MS });
        }
        // the search of the transactions it signed, for burns no code derives from (R5-ESA-01)
        if (searchUnfinished(await vault.readBurnScan(owner, 'signed'))) {
          resumed += 1;
          await solana.findSignedBurns(owner, { store: scanStore(owner, 'signed'), deadlineMs: RESUME_DEADLINE_MS });
        }
      }
    } catch (error) {
      log.warn('burn search not resumed', error?.code ?? error?.name);
    }
  })();
  resuming = run;
  try {
    await run;
  } finally {
    resuming = null;
  }
  return { resumed };
}

/**
 * Handler of `activation.copy`: the full code for an explicit reveal or copy in the popup. No password: the unlocked
 * session authorizes it (decision 33); the page holds the code only while it is shown. The code is the one the Activate
 * tab shows: the vault's, or that of aiqnet.io's record it showed as this wallet's (a payment burn, or the other burn a
 * record keeps instead of the vault's: lookup).
 * @returns {Promise<{code: string}>}
 * @throws {WalletError} LOCKED, NOT_FOUND when the wallet has no activation
 */
export async function copyCode() {
  const wallet = await session.requireUnlocked();
  const state = await vault.readState();
  const shown = shownRecord?.qnetAddress === wallet.qnetAddress ? shownRecord : null;
  if (shown !== null && (state.activation === null ? state.pendingBurn === null : recordOther(wallet, state.activation)?.burnTx === shown.burnTx)) {
    return { code: shown.code };
  }
  if (!state.activation) throw new WalletError('NOT_FOUND');
  return { code: state.activation.code };
}
