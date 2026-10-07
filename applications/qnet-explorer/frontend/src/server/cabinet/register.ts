// POST /api/cabinet/register: the registration of a light node from any browser where the wallet is connected (unified
// plan SITE-4, R1; shared contract C4), with the wallet's fresh consent from QNet Wallet (src/lib/cabinet/registration.ts:
// the exact fields, the node id, the proof, the wallet key, its signature), in one of two forms:
// - the consent body, for a burn from a one-time payment address: the site finds the wallet's burn in the activation
//   registry (activation-registry.ts: the payment address's burn, final, of this amount, whose reservation the same
//   wallet key signed), completes the body with that burner and the payment key's v2 owner bind the record keeps, and
//   checks the bind again. A wallet whose record names another burn gets `other_burn`, one with no payment burn
//   `no_record`;
// - the own-burn body, for a burn made from the wallet's own Solana address (by the extension or an older app): the
//   consent with that burner and its owner bind v1, which QNet Wallet signed with the same recovery phrase's Solana key.
//   The site checks the bind, then that the burner made this light burn of this amount (the wallet's record of it, else
//   the search of the burner's address the page's reads keep, burn-scan.ts, charged to the client and the node: the
//   first burn it made), and the network's one-node rule.
// Either goes to one genesis node, never hedged (the node builds and hashes the transaction itself), with one submit in
// flight per node; anything refused is relayed nowhere. The explorer server may be on the nodes' whitelist, so the client
// and, once the signature verified, the node are metered here (limits.ts).

import { readCappedBytes } from '../../lib/capped-body.ts';
import { GENESIS_NODES } from '../../lib/genesis-nodes.ts';
import { MLDSA65_PUBLIC_KEY_BYTES, bytesToHex, decodeB64url, type ConsentVerifier } from '../../lib/qnet-link.ts';
import type { ScanView } from '../../lib/cabinet/burn-record.ts';
import {
  SUBMIT_BODY_MAX_BYTES, SUBMIT_PATH, checkConsentBody, checkOwnBurnBody, completeSubmitBody, submitOutcome, type ConsentBody, type SubmitBody,
  type SubmitOutcome,
} from '../../lib/cabinet/registration.ts';
import type { ActivationRow } from './activation-registry.ts';
import { readJsonPost } from '../request-guard.ts';
import { cabinetGate, cabinetJson, createGate, type Gate, type GateOptions } from './limits.ts';
import { sharedUpstreamBudget, unbudgeted, type UpstreamBudget } from './upstream.ts';
import type { WalletNode } from './wallet-node.ts';

// The node collects the committee's burn attestations inside the submit.
export const SUBMIT_TIMEOUT_MS = 30_000;
const NODE_BODY_MAX_BYTES = 64 * 1024;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// The registry's burn of a wallet (activation-api.ts paymentRecord): its row once it has a burn, null without one.
export type PaymentRecordReader = (wallet: string) => Promise<ActivationRow | null | 'unavailable'>;
// The search of a Solana address for the burns it made (burn-scan.ts BurnScanner, the scanner the page's reads use),
// charged to `clients`: the register client's key and the node's (SITE H-5), each its share of the signed lane.
export type OwnBurnScan = (address: string, clients: readonly string[]) => Promise<ScanView>;
// Whether the wallet has a node of either type (wallet-node.ts); null when the network could not answer.
export type WalletNodeReader = (wallet: string) => Promise<WalletNode | null>;

export interface RegisterOptions extends GateOptions {
  gate?: Gate;
  fetchFn?: FetchLike;
  nodes?: readonly string[];
  random?: () => number;
  budget?: UpstreamBudget;
  verifyConsent: ConsentVerifier;
  // Without it nothing is relayed.
  paymentRecord?: PaymentRecordReader;
  // Without them no own-burn body is relayed.
  scan?: OwnBurnScan;
  walletNode?: WalletNodeReader;
}

// The node's body for a checked consent from the wallet's record, or the outcome that stops it: the database cannot
// answer (the page submits again later), no payment burn of the wallet, another burn, the burn not final yet, another
// amount, or an owner bind that does not verify for this consent's key.
export function fromRecord(body: ConsentBody, row: ActivationRow | null | 'unavailable'): SubmitBody | SubmitOutcome {
  if (row === 'unavailable') return { result: 'retry', code: 'unavailable' };
  if (row === null || row.burnTx === null) return { result: 'refused', code: 'no_record' };
  if (row.burnTx !== body.burn_tx_hash) return { result: 'refused', code: 'other_burn' };
  if (row.way !== 'payment') return { result: 'refused', code: 'no_record' };
  if (row.state !== 'recorded') return { result: 'retry', code: 'not_final' };
  if (row.burnAmount !== body.burn_amount) return { result: 'refused', code: 'invalid_burn' };
  const pk = row.proof ? decodeB64url(row.proof.pk, MLDSA65_PUBLIC_KEY_BYTES) : null;
  const ownerSig = row.proof?.ownerSig;
  if (!pk || bytesToHex(pk) !== body.dilithium_public_key || typeof ownerSig !== 'string') return { result: 'refused', code: 'owner_bind' };
  return completeSubmitBody(body, row.burner, ownerSig) ?? { result: 'refused', code: 'owner_bind' };
}

// Whether a checked own-burn body's burner made its burn, a light one of its amount, or the outcome that stops it. The
// wallet's record decides when it has a burn: another burn is `other_burn`; this burn as a payment address's is
// finished from the record (`owner_bind`), as is a record of another burner; not final yet is a retry. Without one, the
// burner's search decides: its first burn must be this one (the burn the page shows, and the wallet's one activation),
// `no_record` when a finished search has none, a retry when the search did not finish. Null when the burn is proven.
export function ownBurnProof(body: SubmitBody, row: ActivationRow | null | 'unavailable', scan: ScanView | null): SubmitOutcome | null {
  if (row === 'unavailable') return { result: 'retry', code: 'unavailable' };
  if (row !== null && row.burnTx !== null) {
    if (row.burnTx !== body.burn_tx_hash) return { result: 'refused', code: 'other_burn' };
    if (row.way === 'payment' || row.burner !== body.burn_wallet) return { result: 'refused', code: 'owner_bind' };
    if (row.nodeType !== 'light' || row.burnAmount !== body.burn_amount) return { result: 'refused', code: 'invalid_burn' };
    return row.state === 'recorded' ? null : { result: 'retry', code: 'not_final' };
  }
  if (scan === null) return { result: 'retry', code: 'unavailable' };
  const first = scan.burns[0];
  if (first === undefined) return scan.complete ? { result: 'refused', code: 'no_record' } : { result: 'retry', code: 'scan_incomplete' };
  if (first.burnTx !== body.burn_tx_hash) {
    return scan.burns.some((b) => b.burnTx === body.burn_tx_hash) ? { result: 'refused', code: 'other_burn' } : { result: 'refused', code: 'no_record' };
  }
  if (first.nodeType !== 'light' || first.burnAmount !== body.burn_amount) return { result: 'refused', code: 'invalid_burn' };
  return null;
}

// The network's one-node rule before an own-burn body goes: the wallet's own light node on the network already is that
// registration done; any other node of the wallet refuses it; a network that cannot answer is a retry.
export function oneNodeOutcome(body: SubmitBody, node: WalletNode | null): SubmitOutcome | null {
  if (node === null) return { result: 'retry', code: 'network' };
  if (node.state === 'none') return null;
  return node.nodeType === 'light' && node.nodeId === body.node_id ? { result: 'registered' } : { result: 'refused', code: 'wallet_has_node' };
}

export interface Register {
  submit(request: Request): Promise<Response>;
}

export function createRegister(options: RegisterOptions): Register {
  const gate = options.gate ?? createGate(options);
  const fetchFn = options.fetchFn ?? fetch;
  const nodes = options.nodes ?? GENESIS_NODES;
  const random = options.random ?? Math.random;
  const budget = options.budget ?? unbudgeted;
  const inFlight = new Set<string>();

  // One genesis node: a random one, else the next whose submit budget this second is not spent (upstream.ts); with
  // none left the page submits again later.
  async function toNode(body: unknown): Promise<SubmitOutcome> {
    const first = Math.floor(random() * nodes.length);
    const base = nodes.map((_, i) => nodes[(first + i) % nodes.length]).find((b) => budget('submit', b));
    if (base === undefined) return { result: 'retry', code: 'busy' };
    try {
      const res = await fetchFn(`${base}${SUBMIT_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      });
      const bytes = await readCappedBytes(res, NODE_BODY_MAX_BYTES);
      let parsed: unknown = null;
      try {
        parsed = bytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null;
      } catch {
        parsed = null;
      }
      return submitOutcome(res.status, parsed);
    } catch {
      return { result: 'retry', code: 'network' };
    }
  }

  // An own-burn body checked: the record, the burner's burn, the one-node rule, then the node. A search of the burner is
  // charged to the register client and to the node (`clients`), never to the server's lane alone.
  async function ownBurn(body: SubmitBody, clients: readonly string[]): Promise<SubmitOutcome> {
    if (!options.paymentRecord || !options.scan || !options.walletNode) return { result: 'retry', code: 'unavailable' };
    const row = await options.paymentRecord(body.wallet_address);
    const noRow = row === null || (row !== 'unavailable' && row.burnTx === null);
    const scan = noRow ? await options.scan(body.burn_wallet, clients).catch(() => null) : null;
    const stop = ownBurnProof(body, row, scan) ?? oneNodeOutcome(body, await options.walletNode(body.wallet_address).catch(() => null));
    return stop ?? toNode(body);
  }

  return {
    async submit(request) {
      const read = await readJsonPost(request, SUBMIT_BODY_MAX_BYTES);
      if (!read.ok) return cabinetJson(read.status, { error: read.error });
      const refused = gate(request, 'register');
      if (refused) return refused;
      const own = read.value !== null && typeof read.value === 'object' && Object.prototype.hasOwnProperty.call(read.value, 'burn_wallet');
      const checked = own ? checkOwnBurnBody(read.value, options.verifyConsent) : checkConsentBody(read.value, options.verifyConsent);
      if (!checked.ok) return cabinetJson(400, { error: 'invalid_request', reason: checked.reason });
      const id = checked.body.node_id;
      // Only once the wallet's consent verified: a junk body naming someone's node spends nothing of its budget.
      const limited = gate.keyed('register', id);
      if (limited) return limited;
      if (inFlight.has(id)) return cabinetJson(200, { result: 'retry', code: 'in_flight' });
      inFlight.add(id);
      try {
        if (own) {
          const client = gate.client(request);
          return cabinetJson(200, await ownBurn(checked.body as SubmitBody, [...(client === null ? [] : [client]), `node:${id}`]));
        }
        const row = options.paymentRecord ? await options.paymentRecord(checked.body.wallet_address) : 'unavailable';
        const full = fromRecord(checked.body, row);
        if ('result' in full) return cabinetJson(200, full);
        return cabinetJson(200, await toNode(full));
      } finally {
        inFlight.delete(id);
      }
    },
  };
}

const GLOBAL_KEY = Symbol.for('qnet.cabinetRegister');

export function cabinetRegister(
  verifyConsent: ConsentVerifier, paymentRecord: PaymentRecordReader, own: { scan: OwnBurnScan; walletNode: WalletNodeReader },
): Register {
  const holder = globalThis as unknown as Record<symbol, Register | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createRegister({ gate: cabinetGate(), budget: sharedUpstreamBudget(), verifyConsent, paymentRecord, ...own });
  holder[GLOBAL_KEY] = created;
  return created;
}
