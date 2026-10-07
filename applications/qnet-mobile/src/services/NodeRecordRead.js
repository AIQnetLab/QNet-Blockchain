/**
 * What aiqnet.io knows of this wallet's node before the QNet network lists it (GET
 * {EXPLORER_API}/api/cabinet/activation/{wallet}, the site's verified record of the wallet's node): a node the site
 * recorded for the wallet, or one on its way, and its type. The app reads only the state and the node type and ignores
 * every other field of the answer. Any failure (no answer, a refusal, a body it cannot read) is null: the Node tab then
 * shows what the network says, as it did before this read existed, and the QNet Link sheet gives no consent (one
 * wallet, one node type: services/QNetLink prepareOffer refuses a light consent for a wallet the site holds a super
 * node's burn for, and one it cannot read the record of).
 */
import { EXPLORER_API } from '../config/nodes';

const STATES = ['none', 'reserved', 'sending', 'recorded'];
const TYPES = ['light', 'super'];
const TIMEOUT_MS = 8000;

// The site's record states that mean a node of `nodeType` is this wallet's and the network has not listed it yet:
// recorded (the site holds its record, for good), or on its way (sent, not final yet).
const ON_ITS_WAY = new Set(['recorded', 'sending']);

/**
 * { state, nodeType } of the site's record for `wallet`, or null when it cannot be read. `nodeType` is null for the
 * state 'none'.
 */
export async function readNodeRecordState(wallet) {
  if (typeof wallet !== 'string' || !/^[0-9a-z]{16,128}$/.test(wallet)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${EXPLORER_API}/api/cabinet/activation/${encodeURIComponent(wallet)}`, {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', signal: ctl.signal,
    });
    if (!response || response.status !== 200) return null;
    const body = await response.json();
    if (!body || typeof body !== 'object' || !STATES.includes(body.state)) return null;
    const nodeType = TYPES.includes(body.nodeType) ? body.nodeType : null;
    if (body.state !== 'none' && nodeType === null) return null;
    return { state: body.state, nodeType: body.state === 'none' ? null : nodeType };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The node type the site holds for this wallet that the network does not list yet ('light' | 'super'), or null.
 * `record` is readNodeRecordState's answer; `listed` the node types the network lists for the wallet.
 */
export function pendingNodeType(record, listed = []) {
  if (!record || !ON_ITS_WAY.has(record.state) || !TYPES.includes(record.nodeType)) return null;
  return listed.includes(record.nodeType) ? null : record.nodeType;
}
