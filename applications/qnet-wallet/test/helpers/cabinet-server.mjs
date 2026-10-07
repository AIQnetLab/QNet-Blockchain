// A simulated aiqnet.io record of wallet burns (CONTRACTS.md decisions 35 and 36; the site runs the real one): one row per
// wallet as its table keeps it, the atomic reservation with the wallet's signed request checked as the server checks it
// (the key, the signature, how old it is), the announce with the burn record's proof, release, record with its upsert
// rules, and the settlement of an announced burn on GET. Tests route fetch through `route`, read `rows` and `requests`, and
// make any route fail (`down`, or a fixed answer).
import * as core from '../../dist/lib/qnet-core.js';
import { QNET, RECORD_ORIGIN, RECORD_PATH, SOLANA } from '../../dist/background/config.js';

export const RESERVATION_TTL_MS = 600000;
export const SETTLE_AFTER_MS = 600000;
// How old a signed reservation request may be (decision 36): 10 minutes for the extension's own; the payment key lives
// 24 hours before its burn, plus the same 10 minutes. A request may be 5 minutes ahead of the server's clock.
export const RESERVE_MAX_AGE_S = { extension: 600, payment: 87_000 };
export const RESERVE_MAX_AHEAD_S = 300;
const RECORD_KEYS = ['wallet', 'state', 'nodeType', 'way', 'burner', 'burnTx', 'burnAmount', 'code', 'until', 'recordedAt', 'scan'];

/** The text a burn record's proof covers, written out as the contract states it (independent of keys.js). */
export function burnRecordText({ wallet, nodeType, burner, burnTx, burnAmount }) {
  return `QNet burn record v1\nwallet: ${wallet}\nnode: ${nodeType}\nburner: ${burner}\nburn: ${burnTx}\namount: ${burnAmount}\ncluster: devnet`;
}

/** The text a node reservation's proof covers, written out as the contract states it (independent of keys.js). */
export function reservationText({ wallet, nodeType, way, burner, time }) {
  return `QNet node reservation v1\nwallet: ${wallet}\nnode: ${nodeType}\nway: ${way}\nburner: ${burner}\ntime: ${time}\ncluster: devnet`;
}

/** base64url (with or without padding) → bytes. */
export function base64urlDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new TypeError('not base64url');
  const plain = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  return core.base64Decode(plain + '='.repeat((4 - (plain.length % 4)) % 4));
}

/** The envelope both signatures of a proof cover: "QNet Signed Message:\n" + origin + "\n" + byteLength + "\n" + text. */
export function burnRecordEnvelope(fields) {
  const text = burnRecordText(fields);
  return new TextEncoder().encode(`QNet Signed Message:\n${RECORD_ORIGIN}\n${new TextEncoder().encode(text).length}\n${text}`);
}

/**
 * The server's check of a proof for a burn record of `fields`: the key is the wallet's, the ML-DSA-65 signature (context
 * QNET_OFFCHAIN_MSG_v1) and the burner's Ed25519 signature both cover the envelope.
 */
export function proofValid(fields, proof) {
  try {
    if (!proof || Object.keys(proof).sort().join() !== 'pk,sig,solanaSig') return false;
    const pk = base64urlDecode(proof.pk);
    const sig = base64urlDecode(proof.sig);
    if (pk.length !== 1952 || sig.length !== 3309 || core.qnetAddressFromPublicKey(pk) !== fields.wallet) return false;
    if (!core.verifySiteRecord(RECORD_ORIGIN, burnRecordText(fields), sig, pk)) return false;
    return core.verifySolanaSignature(core.base58Decode(proof.solanaSig), burnRecordEnvelope(fields), core.solanaAddressToBytes(fields.burner));
  } catch {
    return false;
  }
}

/**
 * The server's check of a reservation request's proof (decision 36): exactly {pk, sig, time}, the key is the wallet's, and
 * its ML-DSA-65 signature (context QNET_OFFCHAIN_MSG_v1) covers the envelope of reservationText(fields with that time).
 * Whether it is fresh is checked apart (reserveFreshness).
 */
export function reservationProofValid(fields, proof) {
  try {
    if (!proof || typeof proof !== 'object' || Object.keys(proof).sort().join() !== 'pk,sig,time') return false;
    if (!Number.isSafeInteger(proof.time) || proof.time < 1) return false;
    const pk = base64urlDecode(proof.pk);
    const sig = base64urlDecode(proof.sig);
    if (pk.length !== 1952 || sig.length !== 3309 || core.qnetAddressFromPublicKey(pk) !== fields.wallet) return false;
    return core.verifySiteRecord(RECORD_ORIGIN, reservationText({ ...fields, time: proof.time }), sig, pk);
  } catch {
    return false;
  }
}

/** Whether a signed reservation request of `way` made at `time` (Unix s) is still good at `nowMs`. */
export function reserveFreshness(way, time, nowMs) {
  const nowS = Math.floor(nowMs / 1000);
  return time >= nowS - RESERVE_MAX_AGE_S[way] && time <= nowS + RESERVE_MAX_AHEAD_S;
}

const codeOf = (row) => (row.way === 'payment' ? core.walletActivationCode(row.wallet, row.burnTx, row.burnAmount)
  : core.generateActivationCode(row.nodeType, row.burner, row.burnTx, row.burnAmount));

/**
 * @param {{now?: () => number, landed?: (burnTx: string) => 'final'|'failed'|'unknown', slotOf?: (burnTx: string) => number,
 *   hasNode?: (wallet: string) => boolean|null}} [options] landed: what Solana says of a burn (default final); slotOf:
 *   its slot (default 1); hasNode: the network's word (null: it cannot answer)
 */
export function createCabinet(options = {}) {
  const { now = () => Date.now(), landed = () => 'final', slotOf = () => 1, hasNode = () => false } = options;
  const rows = new Map();
  const requests = [];
  // per route ('get', 'reserve', 'announce', 'release', 'record'): 'down' (no answer) or {status, body}
  const fail = {};
  let seq = 0;

  const bodyOf = (wallet) => {
    const row = rows.get(wallet);
    if (!row) return { ...Object.fromEntries(RECORD_KEYS.map((key) => [key, null])), wallet, state: 'none' };
    const recorded = row.state === 'recorded';
    return {
      wallet, state: row.state, nodeType: row.nodeType, way: row.way, burner: row.state === 'reserved' ? null : row.burner,
      burnTx: row.state === 'reserved' ? null : row.burnTx, burnAmount: row.burnAmount, code: recorded ? codeOf(row) : null,
      until: recorded ? null : row.until, recordedAt: recorded ? row.recordedAt : null, scan: null,
    };
  };

  // An announced burn is settled on every read: final → recorded, of either way (a payment burn for good: decision 36);
  // failed, or unseen SETTLE_AFTER_MS after its announce → the row goes.
  const settle = (wallet) => {
    const row = rows.get(wallet);
    if (!row) return;
    if (row.state === 'reserved' && row.until <= now()) rows.delete(wallet);
    if (row.state !== 'sending') return;
    const seen = landed(row.burnTx);
    if (seen === 'final') {
      Object.assign(row, { state: 'recorded', until: null, recordedAt: now() });
    } else if (seen === 'failed' || now() > row.until) {
      rows.delete(wallet);
    }
  };

  const blocking = (row) => {
    if (!row) return null;
    if (row.state === 'recorded') return 'has_burn';
    if (row.state === 'sending') return 'burn_pending';
    return row.until > now() ? 'reserved' : null;
  };

  const handlers = {
    get(wallet) {
      settle(wallet);
      return { body: bodyOf(wallet) };
    },
    reserve(body) {
      const keys = Object.keys(body ?? {}).sort().join();
      const { wallet, nodeType, way, burner, burnAmount, solana, proof } = body ?? {};
      const ok = keys === 'burnAmount,burner,nodeType,proof,solana,wallet,way' && core.isValidQnetAddress(wallet)
        && ['light', 'super'].includes(nodeType) && ['extension', 'payment'].includes(way) && core.isValidSolanaAddress(burner)
        && Number.isSafeInteger(burnAmount) && burnAmount > 0 && (way === 'payment' ? nodeType === 'light' : solana === burner);
      if (!ok) return { status: 400, body: { error: 'invalid_request' } };
      // only the wallet itself holds a reservation: its signature over this request, made at most 10 minutes ago
      if (!reservationProofValid({ wallet, nodeType, way, burner }, proof)) return { status: 400, body: { error: 'invalid_proof' } };
      if (!reserveFreshness(way, proof.time, now())) return { status: 400, body: { error: 'stale_proof' } };
      settle(wallet);
      const error = blocking(rows.get(wallet));
      if (error !== null) return { status: 409, body: { error, activation: bodyOf(wallet) } };
      const node = hasNode(wallet);
      if (node === null) return { status: 503, body: { error: 'network_unavailable' } };
      if (node) return { status: 409, body: { error: 'has_node', nodeId: core.lightNodeId(wallet), nodeType: 'light' } };
      seq += 1;
      const reservation = core.bytesToHex(core.sha256(core.utf8Encode(`reservation ${seq} ${wallet}`))).slice(0, 32);
      rows.set(wallet, {
        wallet, state: 'reserved', nodeType, way, burner, burnAmount, reservation, until: now() + RESERVATION_TTL_MS, burnTx: null,
        proof, recordedAt: null,
      });
      return { body: { reservation, until: now() + RESERVATION_TTL_MS } };
    },
    announce(body) {
      const { wallet, reservation, burnTx, proof } = body ?? {};
      const row = rows.get(wallet);
      if (row?.state === 'sending' && row.reservation === reservation && row.burnTx === burnTx) return { body: { ok: true, until: row.until } };
      if (!row || row.state !== 'reserved' || row.reservation !== reservation || row.until <= now() || row.way !== 'extension'
        || row.burnTx !== null) {
        return { status: 409, body: { error: 'reservation' } };
      }
      const fields = { wallet, nodeType: row.nodeType, burner: row.burner, burnTx, burnAmount: row.burnAmount };
      if (!core.isValidSolanaSignature(burnTx) || !proofValid(fields, proof)) return { status: 400, body: { error: 'invalid_proof' } };
      Object.assign(row, { state: 'sending', burnTx, proof, until: now() + SETTLE_AFTER_MS });
      return { body: { ok: true, until: row.until } };
    },
    release(body) {
      const { wallet, reservation } = body ?? {};
      const row = rows.get(wallet);
      if (row && row.reservation === reservation && row.state === 'reserved' && row.burnTx === null) rows.delete(wallet);
      return { body: { ok: true } };
    },
    record(body) {
      const { wallet, nodeType, burner, burnTx, burnAmount, proof } = body ?? {};
      const fields = { wallet, nodeType, burner, burnTx, burnAmount };
      if (!proofValid(fields, proof)) return { status: 400, body: { error: 'invalid_proof' } };
      if (landed(burnTx) !== 'final') return { status: 409, body: { error: 'not_final' } };
      settle(wallet);
      const row = rows.get(wallet);
      // a payment burn, on its way or recorded, is never replaced (decision 36)
      const proven = row && row.way === 'extension' && (row.state === 'recorded' || row.state === 'sending');
      const allowed = !row || (row.state === 'reserved' && row.burnTx === null) || row.burnTx === burnTx
        || (proven && row.burner === burner && slotOf(burnTx) < slotOf(row.burnTx));
      if (!allowed) return { status: 409, body: { error: 'other_burn', activation: bodyOf(wallet) } };
      rows.set(wallet, {
        wallet, state: 'recorded', nodeType, way: 'extension', burner, burnAmount, reservation: null, until: null, burnTx, proof,
        recordedAt: now(),
      });
      return { body: bodyOf(wallet) };
    },
  };

  const cabinet = {
    rows,
    requests,
    fail,
    /** A row as the table would hold it (a payment burn, another browser's reservation, a record). */
    put(row) {
      rows.set(row.wallet, {
        reservation: null, proof: null, recordedAt: row.state === 'recorded' ? now() : null, until: null, burnTx: null, ...row,
      });
    },
    async route(request) {
      const url = new URL(request.url);
      if (url.origin !== QNET.EXPLORER_API || !url.pathname.startsWith(RECORD_PATH)) return undefined;
      const rest = url.pathname.slice(RECORD_PATH.length);
      const name = request.method === 'GET' ? 'get' : rest;
      const body = request.method === 'POST' ? JSON.parse(request.body) : null;
      requests.push({ route: name, method: request.method, path: url.pathname, body, init: request.init });
      if (fail[name] === 'down') throw new TypeError('aiqnet.io down');
      if (fail[name]) return { status: fail[name].status ?? 200, body: fail[name].body ?? {} };
      if (!Object.hasOwn(handlers, name)) return { status: 404, body: { error: 'not_found' } };
      const answer = name === 'get' ? handlers.get(decodeURIComponent(rest)) : handlers[name](body);
      return { status: answer.status ?? 200, body: answer.body };
    },
    of: (route) => requests.filter((r) => r.route === route),
  };
  return cabinet;
}

// The Solana cluster the proofs name: the contract's text says devnet.
export const CLUSTER = SOLANA.CLUSTER;
