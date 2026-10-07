// The registration the node cabinet submits for a light node (docs/protocols/light-node-messages.md section 4; unified
// plan R1 and flows A and B; shared contract C4). For a burn from a one-time payment address the page sends the wallet's
// consent from QNet Wallet (the consent body); the site's route checks it again, completes it with the burner and the
// payment key's owner bind that the site's activation record keeps for the wallet's burn (the v2 bind, signed right after
// the burn was signed and before it was sent: src/server/cabinet/activation-registry.ts). For a burn made from the
// wallet's own Solana address (by the extension or an older app) QNet Wallet's consent carries that Solana key's owner
// bind v1 at the consent's time, and the page sends the whole body (the own-burn body), which the route checks the same
// way. Either goes as the body of POST /api/v1/node-registration/submit (the extension's and the app's field order) to
// one genesis node (src/server/cabinet/register.ts), and the node's answer maps to the few outcomes the page acts on.
// Neither needs a key in the browser, so any browser where the wallet is connected can finish it.

import jsSha3 from 'js-sha3';
import { ed25519 } from '@noble/curves/ed25519';
import {
  MLDSA65_PUBLIC_KEY_BYTES,
  MLDSA65_SIGNATURE_BYTES,
  bytesToHex,
  consentMessage,
  consentProof,
  eonOfPublicKey,
  hexToBytes,
  isLightNodeId,
  isSolanaSignature,
  lightNodeId,
  utf8Bytes,
  verifyOwnerBind,
  type ConsentVerifier,
} from '../qnet-link.ts';
import { isEonAddress, isSolanaAddress } from '../qnet-provider.ts';
import { decodeKey } from '../solana-message.ts';
import { isWholeBurn } from './burn-tx.ts';

export const SUBMIT_PATH = '/api/v1/node-registration/submit';
// Two hex ML-DSA-65 values and the rest: about 10.7 KB.
export const SUBMIT_BODY_MAX_BYTES = 16 * 1024;

// What the page posts to /api/cabinet/register: the wallet's consent to this burn, nothing of the payment key.
export const CONSENT_KEYS = [
  'from', 'node_id', 'node_type', 'wallet_address', 'registration_proof', 'timestamp', 'burn_tx_hash', 'burn_amount',
  'dilithium_signature', 'dilithium_public_key',
] as const;

// What the site sends the node: the consent body with the burner and its owner bind, in the node's order.
export const SUBMIT_KEYS = [
  'from', 'node_id', 'node_type', 'wallet_address', 'registration_proof', 'timestamp', 'burn_tx_hash', 'burn_amount',
  'burn_wallet', 'dilithium_signature', 'dilithium_public_key', 'owner_signature',
] as const;

export interface ConsentBody {
  from: string;
  node_id: string;
  node_type: 'light';
  wallet_address: string;
  registration_proof: string;
  timestamp: number;
  burn_tx_hash: string;
  burn_amount: number;
  dilithium_signature: string;
  dilithium_public_key: string;
}

export interface SubmitBody extends ConsentBody {
  burn_wallet: string;
  owner_signature: string;
}

const HEX_RE = /^[0-9a-f]*$/;
const PROOF_RE = /^[0-9a-f]{32}$/;
export const OWNER_SIG_RE = /^[0-9a-f]{128}$/;

// The owner bind v2 the burner signs (qnet-state burn_owner_bind_message_v2), with no time: the light node, the
// wallet, the registration proof, the wallet key's SHA3-256 and the burn. It stays valid for as long as the burn is
// unregistered, so the registration can be finished later, anywhere, with a fresh consent.
export function ownerBindMessageV2(nodeId: string, wallet: string, proof: string, publicKey: Uint8Array, burnTx: string): string {
  return `qnet_burn_owner_v2:${nodeId}:${wallet}:${proof}:${jsSha3.sha3_256(publicKey)}:${burnTx}`;
}

// The light-node feature a genesis node lists while it takes the v2 owner bind (light_binding.rs light_node_features):
// from the network's one-wallet-one-node gate on. A payment address is shown, and its burn signed, only while two genesis
// nodes list it (activation.ts paymentOpen): before, the network would refuse the registration.
export const OWNER_BIND_V2_FEATURE = 'owner_bind_v2';

// The v2 owner bind of `burnTx` for `wallet`'s light node, by the Ed25519 key of `burner` (base58), as 128 lowercase hex.
export function verifyOwnerBindV2(wallet: string, publicKey: Uint8Array, burnTx: string, burner: string, ownerSig: unknown): boolean {
  const key = decodeKey(burner);
  if (!key || typeof ownerSig !== 'string' || !OWNER_SIG_RE.test(ownerSig) || !isEonAddress(wallet) || !isSolanaSignature(burnTx)) return false;
  const nodeId = lightNodeId(wallet);
  const message = utf8Bytes(ownerBindMessageV2(nodeId, wallet, consentProof(burnTx, nodeId, wallet), publicKey, burnTx));
  try {
    return ed25519.verify(hexToBytes(ownerSig), message, key);
  } catch {
    return false;
  }
}

export interface ConsentInputs {
  qnet: string;
  consentTs: number;
  consentPk: Uint8Array;
  consentSig: Uint8Array;
  burnTx: string;
  burnAmount: number;
}

export function buildConsentBody(i: ConsentInputs): ConsentBody {
  const nodeId = lightNodeId(i.qnet);
  return {
    from: i.qnet,
    node_id: nodeId,
    node_type: 'light',
    wallet_address: i.qnet,
    registration_proof: consentProof(i.burnTx, nodeId, i.qnet),
    timestamp: i.consentTs,
    burn_tx_hash: i.burnTx,
    burn_amount: i.burnAmount,
    dilithium_signature: bytesToHex(i.consentSig),
    dilithium_public_key: bytesToHex(i.consentPk),
  };
}

export type BodyCheck = { ok: true; body: ConsentBody } | { ok: false; reason: string };
export type OwnBurnCheck = { ok: true; body: SubmitBody } | { ok: false; reason: string };

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));

// Every field of the consent body, in the order the node checks them, and the wallet's signature: what the site
// completes and forwards is a body the node would admit up to its own chain checks (registered or not, the burn on
// Solana, the committee's attestations).
export function checkConsentBody(value: unknown, verifyConsent: ConsentVerifier): BodyCheck {
  if (!exactKeys(value, CONSENT_KEYS)) return { ok: false, reason: 'keys' };
  const reason = consentProblem(value, verifyConsent);
  return reason === null ? { ok: true, body: value as unknown as ConsentBody } : { ok: false, reason };
}

// The own-burn body: the consent's fields as above, the burner (the wallet's own Solana address, which made the burn)
// and its owner bind v1 at the consent's time, 128 lowercase hex, which must verify. The node checks exactly these
// (rpc check_client_submit); whether the burner made this burn the route reads from Solana.
export function checkOwnBurnBody(value: unknown, verifyConsent: ConsentVerifier): OwnBurnCheck {
  if (!exactKeys(value, SUBMIT_KEYS)) return { ok: false, reason: 'keys' };
  const reason = consentProblem(value, verifyConsent);
  if (reason !== null) return { ok: false, reason };
  if (!isSolanaAddress(value.burn_wallet)) return { ok: false, reason: 'burn_wallet' };
  const sig = value.owner_signature;
  if (typeof sig !== 'string' || !OWNER_SIG_RE.test(sig)
    || !verifyOwnerBind(value.wallet_address as string, hexToBytes(value.dilithium_public_key as string), value.burn_tx_hash as string,
      String(value.timestamp), value.burn_wallet, hexToBytes(sig))) return { ok: false, reason: 'owner_signature' };
  return { ok: true, body: Object.fromEntries(SUBMIT_KEYS.map((k) => [k, value[k]])) as unknown as SubmitBody };
}

// The first consent field that is not what the node takes, or null.
function consentProblem(b: Record<string, unknown>, verifyConsent: ConsentVerifier): string | null {
  if (b.node_type !== 'light') return 'node_type';
  if (!isEonAddress(b.wallet_address) || b.from !== b.wallet_address) return 'wallet';
  const wallet = b.wallet_address;
  if (!isLightNodeId(b.node_id) || b.node_id !== lightNodeId(wallet)) return 'node_id';
  if (!isSolanaSignature(b.burn_tx_hash)) return 'burn_tx_hash';
  if (!isWholeBurn(b.burn_amount)) return 'burn_amount';
  if (typeof b.registration_proof !== 'string' || !PROOF_RE.test(b.registration_proof)
    || b.registration_proof !== consentProof(b.burn_tx_hash, b.node_id, wallet)) return 'registration_proof';
  if (typeof b.timestamp !== 'number' || !Number.isSafeInteger(b.timestamp) || b.timestamp < 0) return 'timestamp';
  const hex = (v: unknown, bytes: number): Uint8Array | null =>
    typeof v === 'string' && v.length === bytes * 2 && HEX_RE.test(v) ? hexToBytes(v) : null;
  const pk = hex(b.dilithium_public_key, MLDSA65_PUBLIC_KEY_BYTES);
  if (!pk || eonOfPublicKey(pk) !== wallet) return 'dilithium_public_key';
  const sig = hex(b.dilithium_signature, MLDSA65_SIGNATURE_BYTES);
  let consentOk = false;
  try {
    consentOk = sig !== null && verifyConsent(pk, utf8Bytes(consentMessage(b.node_id, wallet, b.registration_proof, String(b.timestamp))), sig) === true;
  } catch {
    consentOk = false;
  }
  if (!consentOk) return 'dilithium_signature';
  return null;
}

// The node's body: the checked consent body with the burner and the owner bind the record keeps, in the node's order;
// null unless that bind verifies once more for this wallet, its key and this burn.
export function completeSubmitBody(body: ConsentBody, burner: string, ownerSig: string): SubmitBody | null {
  const pk = hexToBytes(body.dilithium_public_key);
  if (!verifyOwnerBindV2(body.wallet_address, pk, body.burn_tx_hash, burner, ownerSig)) return null;
  const full: Record<string, unknown> = { ...body, burn_wallet: burner, owner_signature: ownerSig };
  return Object.fromEntries(SUBMIT_KEYS.map((k) => [k, full[k]])) as unknown as SubmitBody;
}

// ---------------------------------------------------------------- the node's answer

// The node's stable `code` of a submit answer (unified plan section 3.4); the text is read when a node sends none,
// as the extension reads it (applications/qnet-wallet/dist/background/nodes.js). `wallet_has_node`: the network's
// one-node rule (one wallet, one node of either type). `bind_v2_pending`: the v2 owner bind verifies, but the network
// takes it only from its one-wallet-one-node gate on; the same body goes through later.
export const RETRY_CODES = ['behind_chain', 'committee_unavailable', 'quorum_pending', 'mempool_rejected', 'rate_limited', 'bind_v2_pending'] as const;
const SUBMIT_CODES: readonly string[] = [...RETRY_CODES, 'already_registered', 'timestamp_window', 'bad_request', 'wallet_has_node'];
const SUBMIT_TEXTS: [RegExp, string][] = [
  [/node already registered/i, 'already_registered'],
  [/wallet already has a node/i, 'wallet_has_node'],
  [/timestamp too old or too far in future/i, 'timestamp_window'],
  [/node is behind the chain/i, 'behind_chain'],
  [/committee unavailable/i, 'committee_unavailable'],
  [/quorum not yet reached/i, 'quorum_pending'],
  [/failed to add tx to mempool/i, 'mempool_rejected'],
  [/rate limit exceeded/i, 'rate_limited'],
  [/bind_v2_pending|owner bind without a time is not accepted/i, 'bind_v2_pending'],
];
const TX_HASH_RE = /^[0-9a-f]{64}$/;

// What the site's register route answers the page, and what it maps each node answer to. The route's own refusals:
// `no_record` (the site keeps no payment burn for the wallet, or the own burn's burner made no such burn), `other_burn`
// (its burn is another one), `invalid_burn` (another amount or node type), `owner_bind` (the kept bind does not verify
// for this consent's key, or an own-burn body names another burner than the wallet's record).
export type SubmitOutcome =
  | { result: 'admitted'; txHash: string }
  | { result: 'registered' }
  | { result: 'retry'; code: string }
  | { result: 'stale' }
  | { result: 'refused'; code: string };

export function submitOutcome(status: number, body: unknown): SubmitOutcome {
  if (status !== 200) return status === 429 ? { result: 'retry', code: 'rate_limited' } : { result: 'retry', code: `http_${status}` };
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { result: 'retry', code: 'unreadable' };
  const b = body as Record<string, unknown>;
  if (b.success === true) {
    return typeof b.tx_hash === 'string' && TX_HASH_RE.test(b.tx_hash) ? { result: 'admitted', txHash: b.tx_hash } : { result: 'retry', code: 'unreadable' };
  }
  const text = typeof b.error === 'string' ? b.error : '';
  const code = typeof b.code === 'string' && SUBMIT_CODES.includes(b.code) ? b.code : SUBMIT_TEXTS.find(([re]) => re.test(text))?.[1] ?? null;
  if (code === 'already_registered') return { result: 'registered' };
  if (code === 'timestamp_window') return { result: 'stale' };
  if (code !== null && (RETRY_CODES as readonly string[]).includes(code)) return { result: 'retry', code };
  return { result: 'refused', code: code ?? 'refused' };
}

const OUTCOME_KEYS: Record<SubmitOutcome['result'], string[]> = {
  admitted: ['result', 'txHash'],
  registered: ['result'],
  retry: ['result', 'code'],
  stale: ['result'],
  refused: ['result', 'code'],
};
const CODE_RE = /^[a-z0-9_]{1,40}$/;

// The route's answer, read again in the page: exactly one of the outcomes.
export function parseSubmitOutcome(value: unknown): SubmitOutcome | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = typeof v.result === 'string' && Object.prototype.hasOwnProperty.call(OUTCOME_KEYS, v.result) ? OUTCOME_KEYS[v.result as SubmitOutcome['result']] : null;
  if (!keys || Object.keys(v).length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(v, k))) return null;
  if (v.result === 'admitted' && (typeof v.txHash !== 'string' || !TX_HASH_RE.test(v.txHash))) return null;
  if ((v.result === 'retry' || v.result === 'refused') && (typeof v.code !== 'string' || !CODE_RE.test(v.code))) return null;
  return v as unknown as SubmitOutcome;
}
