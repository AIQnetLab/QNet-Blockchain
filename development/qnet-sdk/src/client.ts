// A client of the QNet nodes' HTTP API for servers and the command line. A web page asks the wallet instead, and
// reads the nodes' public routes, which allow any origin, with its own requests.
// Integers the node sends as JSON numbers are read exactly (a balance passes 2^53); every answer is size-bounded.
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { EXPLORER_API, GENESIS_NODES } from '#mobile/config/nodes.js';
import { parseStrictJson, u64Text } from '#mobile/utils/strictJson.js';
import {
  clearQcCache, exportVerifiedAnchors, importVerifiedAnchors, verifyLogInclusion, verifyLogWindowInclusion,
  verifyMacroblockLogsRoot, verifyMacroblockStateRoot, type VerifiedAnchors,
} from '#mobile/crypto/QcLightClient.js';
import { verifyAccountProof } from '#wallet-core/lightclient.js';
import { QNetError, QNetNodeError } from './errors.js';
import { isValidAddress, requestBody } from './tx.js';
import type { Tx } from './types.js';

export type Network = 'testnet';

export const NETWORKS: Readonly<Record<Network, { chainId: string; nodes: readonly string[]; archive: string }>> = Object.freeze({
  testnet: Object.freeze({ chainId: 'q1337', nodes: GENESIS_NODES, archive: EXPLORER_API }),
});

/** Heights one GET /api/v1/logs covers at most: `to` is clamped to `from + 500`. */
export const LOG_WINDOW = 501;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;
/**
 * How long one verified read may keep walking the checkpoint lineage by default. One light-client call verifies at
 * most 64 checkpoints; the client calls again while each call makes progress and this time has not passed, so the
 * walk is bounded by time, not by a count of calls that a pin a few days old already exceeds (DEVP-R1-02).
 */
export const DEFAULT_WALK_TIME_MS = 5 * 60_000;
// Blocks per macroblock: a proof at height h is checked against macroblock floor(h / 90).
const MACROBLOCK_BLOCKS = 90;

// ---- the checkpoints kept between reads (DEVP-R2-01, DEVP-R2-03) ----
// A macroblock's committee comes from the checkpoint two below it, so even and odd macroblocks form two parity chains,
// and a walk starts only from a checkpoint below its target on the target's chain. The light client holds every
// checkpoint it verified in memory, without a bound, and exports only the highest of each chain: kept alone, that one
// would send a new process's read at the same checkpoint, at an older one, or on the other chain back to the release's
// anchor. The client keeps a ladder instead, for the whole process like the light client's own memory: each checkpoint
// as the walk verifies it, thinned on each chain to the LADDER_RECENT newest and the highest of each band of
// LADDER_BAND macroblocks, for the newest LADDER_BANDS bands (about eight and a half days of macroblocks). Rooted on
// it, a read re-walks one step at the newest checkpoint, and at most about 33 steps below any other a walk passed.
type Anchor = VerifiedAnchors[string];
const LADDER_RECENT = 2;
/** Macroblocks per band of the kept-checkpoint ladder: 32 steps of one parity chain. */
export const LADDER_BAND = 64;
const LADDER_BANDS = 128;
// The light client forgets nothing by itself: once VERIFIED_CACHE_SOFT checkpoints were verified since it last
// forgot, the client clears its memory and hands it the ladder back, at a moment no other read is walking. Past
// VERIFIED_CACHE_HARD, new reads wait until the running ones end, so that moment comes.
const VERIFIED_CACHE_SOFT = 128;
const VERIFIED_CACHE_HARD = 512;

const kept = {
  ladder: new Map<number, Anchor>(),
  verifiedSinceClear: 0,
  // Checkpoints any read of this process verified, per parity chain. The light client runs one walk per chain and a
  // read that finds one running only waits for it (its own hook never fires), so a read counts the chain's progress,
  // not its own, when it decides to call again (DEVP-R3-01).
  verifiedOn: [0, 0],
  walking: 0,
  gate: null as Promise<void> | null,
  openGate: null as (() => void) | null,
};

// Keeps only the ladder's rungs on each parity chain.
function thinLadder() {
  for (const parity of [0, 1]) {
    const on = [...kept.ladder.keys()].filter((j) => j % 2 === parity).sort((a, b) => b - a);
    const keep = new Set(on.slice(0, LADDER_RECENT));
    const bands = new Set<number>();
    for (const j of on) {
      const band = Math.floor(j / LADDER_BAND);
      if (bands.has(band)) continue;
      if (bands.size === LADDER_BANDS) break;
      bands.add(band);
      keep.add(j); // newest first: the first one of a band is its highest
    }
    for (const j of on) if (!keep.has(j)) kept.ladder.delete(j);
  }
}

// Macroblock j, just verified by a walk: onto the ladder, when it is the highest the light client holds on its chain
// (a walk below a higher checkpoint already verified passes rungs the ladder has).
function keepVerified(j: number) {
  kept.verifiedSinceClear += 1;
  kept.verifiedOn[j % 2] += 1;
  const e = exportVerifiedAnchors()[j];
  if (!e) return;
  kept.ladder.set(j, e);
  thinLadder();
}

// What a store handed back: each checkpoint the light client takes (malformed ones and those at or below the pin it
// leaves out) goes onto the ladder.
function keepLoaded(saved: unknown) {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return;
  for (const [key, e] of Object.entries(saved)) {
    const j = Number(key);
    if (importVerifiedAnchors({ [key]: e }) !== 1 || kept.ladder.has(j)) continue;
    const a = e as Anchor;
    kept.ladder.set(j, { eligible_ids: a.eligible_ids.slice(), beacon: a.beacon, registry_root: a.registry_root });
  }
  thinLadder();
}

const ladderObject = (): VerifiedAnchors => Object.fromEntries([...kept.ladder].sort((a, b) => a[0] - b[0]));

// The light client's memory, cleared and rooted on the ladder again; only while no other read walks (`alone` counts
// the caller's own read, when it is one).
function forgetVerified(alone: number) {
  if (kept.walking > alone || kept.verifiedSinceClear < VERIFIED_CACHE_SOFT) return;
  clearQcCache();
  importVerifiedAnchors(ladderObject());
  kept.verifiedSinceClear = 0;
  kept.openGate?.();
  kept.gate = null;
  kept.openGate = null;
}

export interface NodeClientOptions {
  network?: Network;
  /** Node base URLs (https, or plain http on this machine). Default: the network's public nodes. */
  nodes?: readonly string[];
  /** Site archive for transactions the nodes no longer index (older than about a day); null to skip it. */
  archive?: string | null;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Keeps the light client's verified checkpoints between runs (the ladder of LADDER_BAND), so a verified read in a
   * new process starts from them instead of the release's anchor. A trust root, not a cache: what `load` returns is
   * taken as verified, like the release's own anchor, so whoever can change the store can make a forged state root
   * read as verified. Keep it where only this program can write it.
   */
  anchors?: { load(): unknown; save(anchors: unknown): void };
  /**
   * How long one verified read may walk the checkpoint lineage (default DEFAULT_WALK_TIME_MS). The walk goes on
   * while each round verifies something; the checkpoints kept are handed to `anchors.save` after every round, so a
   * read that stops early (the time ran out, or no node served the next proof) goes on from them next time on the
   * same parity chain (even or odd macroblocks: each chain is walked on its own, see LADDER_BAND).
   */
  walkTimeMs?: number;
  /** Called as the walk verifies checkpoints: the highest macroblock verified so far on the way to `target`. */
  onWalkProgress?: (progress: WalkProgress) => void;
}

export interface WalkProgress {
  /** The highest macroblock this walk verified so far on the target's lineage. */
  verified: number;
  /** The macroblock the proof is checked against. */
  target: number;
}

export interface AccountInfo {
  address: string;
  balanceNano: string;
  /** The last nonce the chain applied; the next transaction uses nonce + 1. */
  nonce: string;
  /** Whether the chain holds the account's public key; until it does, a transaction must carry it. */
  hasPublicKey: boolean;
  isContract: boolean;
  /** For a contract: 'wasm', 'qrc20' or 'qrc721'. */
  contractType: string | null;
}

export interface VerifiedAccount {
  address: string;
  balanceNano: string;
  nonce: string;
  /** The height the balance and nonce are proved at: they are the account's as of this height. */
  blockHeight: number;
  /** The chain's tip as the other configured nodes report it (the one node, when only one is configured); null when none answered. */
  tipHeight: number | null;
  /** How far `blockHeight` is below `tipHeight` (0 when not below); null when the tip is unknown. */
  behindBlocks: number | null;
  /** The served proof folds the account's own fields up to the served state root. */
  proofFolds: boolean;
  /**
   * That state root is in a checkpoint the committee signed, checked from the release's trust anchor, and the proof is
   * at most `maxAgeBlocks` below the tip (`MAX_PROOF_AGE_BLOCKS` by default).
   */
  verified: boolean;
}

/** How far below the chain's tip a balance proof may be and still count as verified: three macroblocks. */
export const MAX_PROOF_AGE_BLOCKS = 270;

export interface TokenInfo {
  contract: string;
  standard: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  deployer: string | null;
  deployedAt: number | null;
}

export interface LogEntry {
  height: number;
  /**
   * The event's position among all events of its block (the index a log proof names), when known: the node gives it,
   * or the page was read for every contract. null for a page of one contract from a node that does not give it:
   * verifyLog then finds it from the height.
   */
  logIndex: number | null;
  txHash: string;
  contract: string;
  /** The bytes the contract emitted, as hex. */
  data: string;
}

export interface LogPage {
  from: number;
  to: number;
  /** The lowest height this node still holds logs for. */
  oldestAvailable: number;
  /** Set when `from` is below what the node holds: results under it are missing, not absent. */
  prunedBelow: number | null;
  logs: LogEntry[];
}

export interface TransactionInfo {
  hash: string;
  /** 'pending': in a node's pool; 'in_block': a block holds it (it may still have failed to apply). */
  status: 'pending' | 'in_block' | 'not_found';
  blockHeight: number | null;
  finality: string | null;
  from: string | null;
  to: string | null;
  nonce: string | null;
  txType: string | null;
  source: 'node' | 'archive' | null;
}

export interface SubmitResult {
  /** The hash the answering node gave its copy; null for a deploy, whose route returns none, or when the node gave none. */
  txHash: string | null;
  /** For a deploy: the address the node derived. */
  contractAddress: string | null;
  node: string;
}

export interface WaitResult {
  /**
   * 'applied': the account's nonce reached the transaction's (a contract call is then applied or stopped by the
   * contract; the network records which in neither case). 'not_applied': two nodes (the only one, when one is
   * configured) each hold it in a block settled a few blocks deep and each report the account's nonce still one below
   * it, so it failed at apply and cost nothing; never for an account's first transaction (nonce 1), since a node of
   * an earlier release answers nonce 0 for a failed read as well. 'timeout': neither within the wait.
   */
  state: 'applied' | 'not_applied' | 'timeout';
  nonce: string;
  blockHeight: number | null;
}

type Json = Record<string, unknown>;

function nodeUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new QNetError('INVALID_RESPONSE', `Not a node URL: ${base}`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new QNetError('INVALID_RESPONSE', `A node URL must be https (plain http only on this machine): ${base}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new QNetError('INVALID_RESPONSE', `A node URL is a scheme, host and port only: ${base}`);
  }
  return url.origin;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// The reason of a node that was never reached (no connection was made), so it cannot hold a body sent to it.
const NOT_REACHED = 'not reached';
// Connection errors that happen before a request leaves this machine. Anything else (a timeout, a reset, a TLS or
// protocol failure, a redirect) may come after the node read the request.
const BEFORE_SENDING = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);
// The reason of a connection the node closed or reset under the request. The usual cause is a kept-alive connection
// that the node closed while this process was busy (the key file's Argon2 blocks it for seconds) and that was reused
// before its closing was seen: a new connection to the same node then works (DEVP-R1-08).
const CONNECTION_RESET = 'connection reset';
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);
const isReset = (error: unknown): boolean => error instanceof QNetNodeError && error.reason === CONNECTION_RESET;

function connectCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null)?.cause;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return typeof code === 'string' ? code : null;
}

const TOO_LARGE = 'answer too large';

/** Whether a read failed only because the answer was larger than the client takes (a contract's whole storage, say). */
export const isAnswerTooLarge = (error: unknown): boolean => error instanceof QNetNodeError && error.code === 'INVALID_RESPONSE'
  && error.reason === TOO_LARGE;

/** Whether a failed request may have reached the node: anything but a connection that was never made. */
const mayHaveArrived = (error: QNetError): boolean => !(error instanceof QNetNodeError && error.reason === NOT_REACHED)
  && error.code !== 'RATE_LIMITED';

function parseAccount(a: Json, address: string): AccountInfo {
  const balance = u64Text(a.balance);
  const nonce = u64Text(a.nonce);
  if (a.address !== address || balance === null || nonce === null) throw new QNetNodeError('INVALID_RESPONSE', 'account');
  const storage = a.contract_storage as Record<string, unknown> | undefined;
  return {
    address,
    balanceNano: balance,
    nonce,
    hasPublicKey: a.has_dilithium_pk === true,
    isContract: a.is_contract === true,
    contractType: a.is_contract === true && typeof storage?.type === 'string' ? storage.type : null,
  };
}

// A node's answer for a token: its description, or null for "no token there".
function parseToken(body: Json, contract: string): TokenInfo | null {
  if (body.success !== true) return null;
  const t = (body.token ?? {}) as Json;
  const decimals = num(t.decimals);
  const supply = typeof t.total_supply === 'string' && /^(0|[1-9][0-9]*)$/.test(t.total_supply) ? t.total_supply : null;
  if (t.contract_address !== contract || decimals === null || decimals > 38 || supply === null
    || typeof t.name !== 'string' || typeof t.symbol !== 'string' || typeof t.standard !== 'string') {
    throw new QNetNodeError('INVALID_RESPONSE', 'token');
  }
  return {
    contract,
    standard: t.standard,
    name: t.name,
    symbol: t.symbol,
    decimals,
    totalSupply: supply,
    deployer: str(t.deployer) || null,
    // The node stores it as text.
    deployedAt: typeof t.deployed_at === 'string' && /^[0-9]{1,15}$/.test(t.deployed_at) ? Number(t.deployed_at) : num(t.deployed_at),
  };
}

// What two answers must share to describe the same token: every field a send or its review is built from.
const tokenKey = (t: TokenInfo | null): string => (t === null ? 'none' : JSON.stringify([t.standard, t.decimals, t.symbol, t.name]));

// A node's answer for GET /api/v1/transaction/{hash}: the transaction, or null when the node does not know it.
function parseNodeTransaction(hash: string, body: Json): TransactionInfo | null {
  if (body.status === 'not_found') return null;
  if (body.status !== 'found') throw new QNetNodeError('INVALID_RESPONSE', str(body.message) ?? 'transaction');
  const t = (body.transaction ?? {}) as Json;
  const pending = t.status === 'pending';
  const indicators = (t.finality_indicators ?? {}) as Json;
  return {
    hash,
    status: pending ? 'pending' : 'in_block',
    blockHeight: pending ? null : num(t.block_height),
    finality: pending ? null : str(indicators.level),
    from: str(t.from),
    to: str(t.to),
    nonce: u64Text(t.nonce),
    txType: str(t.tx_type),
    source: 'node',
  };
}

// One log row of GET /api/v1/logs.
function parseLogRow(row: Json): Omit<LogEntry, 'logIndex'> & { nodeIndex: number | null } {
  const height = num(row.height);
  if (height === null || typeof row.tx_hash !== 'string' || !isValidAddress(row.contract) || typeof row.data !== 'string'
    || !/^(?:[0-9a-f]{2})*$/.test(row.data)) {
    throw new QNetNodeError('INVALID_RESPONSE', 'log row');
  }
  return { height, txHash: row.tx_hash, contract: row.contract, data: row.data, nodeIndex: num(row.log_index) };
}

/** One log's leaf in the checkpoint's logs root (the node's wasm_exec log_leaf). */
export function logLeaf(txHash: string, logIndex: number, contract: string, data: Uint8Array): string {
  const index = new Uint8Array(4);
  new DataView(index.buffer).setUint32(0, logIndex >>> 0, true);
  return bytesToHex(sha3_256(concatBytes(utf8ToBytes(txHash), index, utf8ToBytes(contract), Uint8Array.of(0), data)));
}

// A submit refusal about the answering node rather than the transaction (DEVP-R3-04). Each comes before the node's
// pool takes the body, so the node holds nothing and another node may take the same body:
// - `recipient_unreadable`: the node could not read the recipient's account ("ask again or ask another node");
// - "Server busy" or `verify_overloaded`: its signature checks are at capacity ("retry shortly");
// - a gas price below the floor its own pool's backlog sets;
// - "Invalid nonce: expected N, got M" with N below the nonce sent: its state is behind the one the nonce was read from;
// - `pk_unresolved`: it cannot find the elided public key yet (a block behind the key's first use); the caller may
//   send the same transaction to it once more with the key.
// A refusal of the transaction itself (its signature, the balance, a used nonce, a contract recipient) is none of these.
function localRefusal(r: Record<string, unknown>, nonce: string): 'pk_unresolved' | 'busy' | 'behind' | 'unreadable' | null {
  if (r.code === 'recipient_unreadable') return 'unreadable';
  const error = typeof r.error === 'string' ? r.error : '';
  const details = typeof r.details === 'string' ? r.details : '';
  if (/^Server busy\b/.test(error) || /\bverify_overloaded\b/.test(details)) return 'busy';
  if (/\bpk_unresolved\b/.test(details)) return 'pk_unresolved';
  if (/\bgas_price [0-9]+ below current floor [0-9]+/.test(details)) return 'busy';
  const m = /\bInvalid nonce(?: for new account)?: expected ([0-9]{1,20}), got ([0-9]{1,20})/.exec(details);
  if (m && m[2] === nonce && BigInt(m[1]) < BigInt(m[2])) return 'behind';
  return null;
}

export class NodeClient {
  readonly network: Network;
  readonly nodes: readonly string[];
  readonly archive: string | null;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly anchors: NodeClientOptions['anchors'];
  private readonly walkTimeMs: number;
  private readonly onWalkProgress: NodeClientOptions['onWalkProgress'];
  private next = 0;

  constructor(options: NodeClientOptions = {}) {
    this.network = options.network ?? 'testnet';
    const net = NETWORKS[this.network];
    if (!net) throw new QNetError('INVALID_RESPONSE', `Unknown network: ${String(options.network)}`);
    const nodes = options.nodes ?? net.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) throw new QNetError('NODE_UNAVAILABLE');
    this.nodes = Object.freeze(nodes.map(nodeUrl));
    this.archive = options.archive === undefined ? net.archive : options.archive === null ? null : nodeUrl(options.archive);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
    this.anchors = options.anchors;
    const walkTimeMs = options.walkTimeMs ?? DEFAULT_WALK_TIME_MS;
    if (typeof walkTimeMs !== 'number' || Number.isNaN(walkTimeMs) || walkTimeMs < 0) throw new QNetError('INVALID_INTEGER', 'walkTimeMs');
    this.walkTimeMs = walkTimeMs;
    this.onWalkProgress = options.onWalkProgress;
  }

  // The nodes in the order to ask them: round robin, so reads spread.
  private order(): string[] {
    const start = this.next++ % this.nodes.length;
    return [...this.nodes.slice(start), ...this.nodes.slice(0, start)];
  }

  private async fetchText(url: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxBytes) throw new QNetNodeError('INVALID_RESPONSE', TOO_LARGE);
      const reader = res.body?.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > this.maxBytes) {
            await reader.cancel();
            throw new QNetNodeError('INVALID_RESPONSE', TOO_LARGE);
          }
          parts.push(value);
        }
      }
      return { status: res.status, text: new TextDecoder().decode(concatBytes(...parts)) };
    } catch (error) {
      if (error instanceof QNetError) throw error;
      if (controller.signal.aborted) throw new QNetNodeError('NODE_UNAVAILABLE', 'timed out');
      const code = connectCode(error);
      if (code !== null && RESET_CODES.has(code)) throw new QNetNodeError('NODE_UNAVAILABLE', CONNECTION_RESET);
      throw new QNetNodeError('NODE_UNAVAILABLE', code !== null && BEFORE_SENDING.has(code) ? NOT_REACHED : 'no answer');
    } finally {
      clearTimeout(timer);
    }
  }

  // JSON of `path` from the first node that answers it; a rate-limited, failing or unreachable node yields to the next.
  private async get(path: string, base?: string): Promise<Json> {
    return (await this.answer(path, base)).body;
  }

  // The same, with the node that gave the answer.
  private async answer(path: string, base?: string): Promise<{ body: Json; node: string }> {
    let last: QNetError = new QNetNodeError('NODE_UNAVAILABLE', '');
    for (const node of base ? [base] : this.order()) {
      try {
        const get = () => this.fetchText(node + path, { headers: { Accept: 'application/json' } });
        // A read is repeated once on a new connection when the node reset the one it came on.
        const { status, text } = await get().catch((error: unknown) => (isReset(error) ? get() : Promise.reject(error)));
        if (status < 200 || status >= 300) throw new QNetNodeError('NODE_UNAVAILABLE', `HTTP ${status}`);
        const body = this.parse(text);
        if (body.success === false && body.error === 'Rate limit exceeded') {
          throw new QNetNodeError('RATE_LIMITED', 'rate limit exceeded', num(body.retry_after_seconds));
        }
        return { body, node };
      } catch (error) {
        if (!(error instanceof QNetError)) throw error;
        last = error;
      }
    }
    throw last;
  }

  private parse(text: string): Json {
    let value: unknown;
    try {
      value = parseStrictJson(text);
    } catch {
      throw new QNetNodeError('INVALID_RESPONSE', 'not JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new QNetNodeError('INVALID_RESPONSE', 'not an object');
    return value as Json;
  }

  /** The height of the chain a node reports. */
  async height(): Promise<number> {
    const h = num((await this.get('/api/v1/height')).height);
    if (h === null) throw new QNetNodeError('INVALID_RESPONSE', 'height');
    return h;
  }

  /** An account as one node reports it. A node that lies about the nonce only gets the next transaction refused. */
  async getAccount(address: string): Promise<AccountInfo> {
    if (!isValidAddress(address)) throw new QNetError('INVALID_ADDRESS');
    return parseAccount(await this.get(`/api/v1/account/${address}`), address);
  }

  /** The nonce the account's next transaction must carry: the applied nonce plus one. */
  async nextNonce(address: string): Promise<string> {
    return (BigInt((await this.getAccount(address)).nonce) + 1n).toString();
  }

  private lightNodes = (): string[] => this.order();

  /**
   * Balance and nonce with the node's proof checked: the account's fields fold up to the proof's state root, and that
   * root is in a committee-signed checkpoint the light client verifies from the release's trust anchor (the
   * mobile wallet's verifier, compiled here). The balance is the one at the proof's `blockHeight`: a node that kept an
   * old state could prove a balance the account has since spent, so the proof must also be at most `maxAgeBlocks`
   * below the chain's tip as the other configured nodes report it (the one node, when only one is configured).
   * `verified` is false when any step cannot be completed.
   */
  async getVerifiedAccount(address: string, { maxAgeBlocks = MAX_PROOF_AGE_BLOCKS }: { maxAgeBlocks?: number } = {}):
    Promise<VerifiedAccount> {
    if (!isValidAddress(address)) throw new QNetError('INVALID_ADDRESS');
    if (!Number.isSafeInteger(maxAgeBlocks) || maxAgeBlocks < 0) throw new QNetError('INVALID_INTEGER', 'maxAgeBlocks');
    const { body: p, node: prover } = await this.answer(`/api/v1/account/${address}/balance/proof`);
    const balance = u64Text(p.balance);
    const nonce = u64Text(p.nonce);
    const lastClaimedEpoch = p.last_claimed_epoch === undefined ? '0' : u64Text(p.last_claimed_epoch);
    const blockHeight = num(p.block_height);
    if (p.error === 'account not found') throw new QNetError('NOT_FOUND');
    if (p.address !== address || balance === null || nonce === null || lastClaimedEpoch === null || blockHeight === null) {
      throw new QNetNodeError('INVALID_RESPONSE', 'balance proof');
    }
    const proof = Array.isArray(p.merkle_proof) ? (p.merkle_proof as Array<{ sibling: string; is_right: boolean }>) : [];
    const stateRoot = str(p.state_root) ?? '';
    const proofFolds = verifyAccountProof({ address, balance, nonce, lastClaimedEpoch, isNode: p.is_node === true }, proof, stateRoot);
    const tipHeight = await this.tipBeside(prover);
    const behindBlocks = tipHeight === null ? null : Math.max(0, tipHeight - blockHeight);
    const fresh = behindBlocks !== null && behindBlocks <= maxAgeBlocks;
    const verified = proofFolds && fresh
      && (await this.anchored(Math.floor(blockHeight / MACROBLOCK_BLOCKS),
        (hooks) => verifyMacroblockStateRoot(stateRoot, blockHeight, this.lightNodes, hooks))) === true;
    return { address, balanceNano: balance, nonce, blockHeight, tipHeight, behindBlocks, proofFolds, verified };
  }

  // The chain's tip as the configured nodes other than `prover` report it (`prover` itself when it is the only one):
  // the upper median of their answers, so one node can neither hide an old proof nor make a fresh one look old
  // while three or more answer. null when none answers.
  private async tipBeside(prover: string): Promise<number | null> {
    const others = this.nodes.filter((n) => n !== prover);
    const heights = await Promise.all((others.length ? others : [prover]).map(async (node) => {
      try {
        return num((await this.get('/api/v1/height', node)).height);
      } catch (error) {
        if (!(error instanceof QNetError)) throw error;
        return null;
      }
    }));
    const known = heights.filter((h): h is number => h !== null).sort((a, b) => a - b);
    return known.length ? known[Math.floor(known.length / 2)] : null;
  }

  // Runs a light-client check of macroblock `target`, again while the walk up its checkpoint lineage keeps making
  // progress (one call walks at most 64 steps) and the walk time lasts. Progress is the target's parity chain's, from
  // any read of this process: the light client walks one chain at a time, and a read that found a walk running waits
  // for that call and comes back without having verified anything itself, while the other read goes on (DEVP-R3-01).
  // The kept checkpoints (the ladder) are loaded before, and saved after every round, so a walk cut short (by the time,
  // a node's rate limit, a process that is stopped) goes on from where it got to. Between rounds the light client's
  // memory is traded for the ladder once it holds VERIFIED_CACHE_SOFT new checkpoints and no other read walks.
  private async anchored<R>(target: number, check: (hooks: object) => Promise<R>): Promise<R> {
    while (kept.gate) await kept.gate;
    kept.walking += 1;
    try {
      this.loadAnchors();
      const deadline = Date.now() + this.walkTimeMs;
      const parity = target % 2;
      let progressed = false;
      let best = -1;
      const onProgress = (j: unknown) => {
        progressed = true;
        if (typeof j !== 'number' || !Number.isSafeInteger(j) || j < 0) return;
        keepVerified(j);
        if (j % 2 !== target % 2 || j <= best) return;
        best = j;
        try {
          this.onWalkProgress?.({ verified: j, target });
        } catch {
          // reporting never stops the walk
        }
      };
      const hooks = { registryNodes: this.lightNodes, onProgress };
      let chainBefore = kept.verifiedOn[parity];
      let result = await check(hooks);
      while (result !== true && result !== 'mismatch' && (progressed || kept.verifiedOn[parity] > chainBefore)
        && Date.now() < deadline) {
        this.saveAnchors();
        forgetVerified(1);
        progressed = false;
        chainBefore = kept.verifiedOn[parity];
        result = await check(hooks);
      }
      this.saveAnchors();
      return result;
    } finally {
      kept.walking -= 1;
      forgetVerified(0);
      // Past the hard bound, reads that start now wait for the running ones, so the memory is cleared when they end.
      if (kept.verifiedSinceClear >= VERIFIED_CACHE_HARD && kept.gate === null) {
        kept.gate = new Promise<void>((open) => {
          kept.openGate = open;
        });
      }
    }
  }

  private loadAnchors() {
    try {
      keepLoaded(this.anchors?.load());
    } catch {
      // unreadable anchors: the walk starts from what this process verified, else the release's own anchor
    }
  }

  private saveAnchors() {
    try {
      this.anchors?.save(ladderObject());
    } catch {
      // the next run walks again
    }
  }

  /** A built-in token's description, as one node reports it (the chain offers no proof of it). */
  async getTokenInfo(contract: string): Promise<TokenInfo> {
    if (!isValidAddress(contract)) throw new QNetError('INVALID_ADDRESS');
    const t = parseToken(await this.get(`/api/v1/token/${contract}`), contract);
    if (t === null) throw new QNetError('NOT_FOUND', `No token at ${contract}`);
    return t;
  }

  /**
   * A built-in token's description as two nodes give it alike (standard, decimals, symbol and name; the only node, when
   * one is configured): what to build a send from, since one node's decimals scale the amount. NODES_DISAGREE when no
   * two answers match, NOT_FOUND when two say there is no token.
   */
  async getAgreedTokenInfo(contract: string): Promise<TokenInfo> {
    if (!isValidAddress(contract)) throw new QNetError('INVALID_ADDRESS');
    const need = Math.min(2, this.nodes.length);
    const answers = new Map<string, number>();
    let last: QNetError = new QNetNodeError('NODE_UNAVAILABLE', '');
    for (const node of this.order()) {
      let t: TokenInfo | null;
      try {
        t = parseToken(await this.get(`/api/v1/token/${contract}`, node), contract);
      } catch (error) {
        if (!(error instanceof QNetError)) throw error;
        last = error;
        continue;
      }
      const key = tokenKey(t);
      const count = (answers.get(key) ?? 0) + 1;
      answers.set(key, count);
      if (count >= need) {
        if (t === null) throw new QNetError('NOT_FOUND', `No token at ${contract}`);
        return t;
      }
    }
    if (answers.size > 1) throw new QNetNodeError('NODES_DISAGREE', 'the nodes describe the token differently');
    throw last;
  }

  /** A holder's balance of a built-in token in base units, as one node reports it. */
  async getTokenBalance(contract: string, holder: string): Promise<string> {
    if (!isValidAddress(contract) || !isValidAddress(holder)) throw new QNetError('INVALID_ADDRESS');
    const body = await this.get(`/api/v1/token/${contract}/balance/${holder}`);
    if (body.success !== true) throw new QNetError('NOT_FOUND', `No token at ${contract}`);
    const balance = typeof body.balance === 'string' && /^(0|[1-9][0-9]*)$/.test(body.balance) ? body.balance : null;
    if (body.holder_address !== holder || balance === null) throw new QNetNodeError('INVALID_RESPONSE', 'token balance');
    return balance;
  }

  /**
   * Events of one window of at most LOG_WINDOW heights from `from` (optionally of one contract). Each carries its
   * position in its block (`logIndex`) when the node gives it or the page covers every contract.
   */
  async getLogs({ contract, from, to }: { contract?: string; from: number; to?: number }): Promise<LogPage> {
    if (contract !== undefined && !isValidAddress(contract)) throw new QNetError('INVALID_ADDRESS');
    if (num(from) === null || (to !== undefined && (num(to) === null || to < from))) throw new QNetError('INVALID_INTEGER');
    const query = new URLSearchParams();
    if (contract) query.set('contract', contract);
    query.set('from', String(from));
    if (to !== undefined) query.set('to', String(Math.min(to, from + LOG_WINDOW - 1)));
    const body = await this.get(`/api/v1/logs?${query}`);
    const pageFrom = num(body.from);
    const pageTo = num(body.to);
    const oldest = num(body.oldest_available);
    if (body.success !== true || pageFrom === null || pageTo === null || oldest === null || !Array.isArray(body.logs)) {
      throw new QNetNodeError('INVALID_RESPONSE', 'logs');
    }
    // A page of every contract lists each block's events in order, so the position is the count at that height.
    const perHeight = new Map<number, number>();
    const logs = (body.logs as Json[]).map((row) => {
      const { nodeIndex, ...entry } = parseLogRow(row);
      const counted = perHeight.get(entry.height) ?? 0;
      perHeight.set(entry.height, counted + 1);
      return { ...entry, logIndex: nodeIndex ?? (contract ? null : counted) };
    });
    return { from: pageFrom, to: pageTo, oldestAvailable: oldest, prunedBelow: num(body.pruned_below), logs };
  }

  // The position of an event in its block's list, read from one node's page of that height for every contract.
  private async logIndexAt(log: { height: number; txHash: string; contract: string; data: string }): Promise<number | null> {
    const body = await this.get(`/api/v1/logs?from=${log.height}&to=${log.height}`);
    if (body.success !== true || !Array.isArray(body.logs)) throw new QNetNodeError('INVALID_RESPONSE', 'logs');
    const rows = (body.logs as Json[]).map(parseLogRow).filter((r) => r.height === log.height);
    const i = rows.findIndex((r) => r.txHash === log.txHash && r.contract === log.contract && r.data === log.data);
    return i < 0 ? null : rows[i].nodeIndex ?? i;
  }

  /**
   * Checks one event against the chain: the node's proof must commit exactly this event (transaction hash, position
   * among all events of its block, contract, bytes), fold to the window's logs root, and that root must be in a
   * committee-signed checkpoint. Give `logIndex` (from getLogs) or, when it is null, the event's `height`, and the
   * position is read from that height. 'verified'; 'consistent' (the proof holds but the checkpoint cannot be checked
   * yet, for example the window is not final); 'rejected' (the proof is for something else, or forged); 'pending' (no
   * proof now).
   */
  async verifyLog(log: { txHash: string; logIndex?: number | null; height?: number; contract: string; data: string }):
    Promise<'verified' | 'consistent' | 'rejected' | 'pending'> {
    const given = log.logIndex ?? null;
    if (!HASH_RE.test(log.txHash) || !isValidAddress(log.contract) || typeof log.data !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(log.data)
      || (given !== null && (!Number.isSafeInteger(given) || given < 0))
      || (given === null && num(log.height) === null)) {
      throw new QNetError('INVALID_CALL');
    }
    let index: number;
    let d: Json;
    try {
      const found = given ?? (await this.logIndexAt({ height: log.height as number, txHash: log.txHash, contract: log.contract, data: log.data }));
      if (found === null) return 'pending';
      index = found;
      d = await this.get(`/api/v1/logs/proof?tx_hash=${log.txHash}&log_index=${index}`);
    } catch {
      return 'pending';
    }
    if (d.error || typeof d.leaf !== 'string' || !Array.isArray(d.proof) || typeof d.block_root !== 'string'
      || !Array.isArray(d.window_proof) || typeof d.logs_root !== 'string' || num(d.window_end) === null) {
      return 'pending';
    }
    const expected = logLeaf(log.txHash, index, log.contract, hexToBytes(log.data));
    if (expected !== d.leaf.toLowerCase()) return 'rejected';
    if (!verifyLogInclusion(d.leaf, d.proof, d.block_root)) return 'rejected';
    if (!verifyLogWindowInclusion(d.block_root, d.window_proof, d.logs_root)) return 'rejected';
    const logsRoot = d.logs_root;
    const windowEnd = d.window_end as number;
    const anchored = await this.anchored(Math.floor(windowEnd / MACROBLOCK_BLOCKS),
      (hooks) => verifyMacroblockLogsRoot(logsRoot, windowEnd, this.lightNodes, hooks));
    return anchored === true ? 'verified' : anchored === 'mismatch' ? 'rejected' : 'consistent';
  }

  /** A transaction by the hash a node gave it: from a node, else (when it is older than the nodes keep) the site archive. */
  async getTransaction(hash: string): Promise<TransactionInfo> {
    if (!HASH_RE.test(hash)) throw new QNetError('INVALID_CALL', 'A transaction hash is 64 lowercase hex characters');
    const onNode = parseNodeTransaction(hash, await this.get(`/api/v1/transaction/${hash}`));
    if (onNode) return onNode;
    if (this.archive) {
      let a: Json | null = null;
      try {
        a = await this.get(`/api/tx/${hash}`, this.archive);
      } catch {
        a = null;
      }
      const d = (a?.success === true ? a.data : null) as Json | null;
      if (d && d.hash === hash) {
        const block = typeof d.block === 'string' && /^[0-9]+$/.test(d.block) ? Number(d.block) : num(d.block);
        return {
          hash,
          status: block === null ? 'pending' : 'in_block',
          blockHeight: block,
          finality: null,
          from: str(d.from),
          to: str(d.to),
          nonce: u64Text(d.nonce),
          txType: str(d.tx_type),
          source: 'archive',
        };
      }
    }
    return { hash, status: 'not_found', blockHeight: null, finality: null, from: null, to: null, nonce: null, txType: null, source: null };
  }

  /**
   * Sends a signed transaction to its route. When a node gives no answer the same body goes to the next one: it is
   * the same transaction (from, nonce), and at most one copy applies; a node that reset the connection is asked once
   * more on a new one first. A node that refuses for a reason of its own (localRefusal: it is busy, behind, or could
   * not read the recipient) did not take the body, and the next node is asked too; one that cannot resolve an elided
   * public key (`pk_unresolved`, a node a block behind the key's first use) is sent the same transaction once more
   * with `publicKeyIfUnresolved` attached, which only adds the key. Any other refusal is final (NODE_REJECTED) only
   * while no earlier node may hold the body: once one timed out or failed after the request could have reached it, a
   * refusal (a used nonce, a duplicate) or no answer at all is SUBMIT_UNCERTAIN, since that copy may still apply.
   * Then wait for the account's nonce (waitForTransaction without a hash), or send again at the same nonce.
   */
  async submit(tx: Tx, signature: Uint8Array, publicKey: Uint8Array | null,
    { publicKeyIfUnresolved = null }: { publicKeyIfUnresolved?: Uint8Array | null } = {}): Promise<SubmitResult> {
    let body = requestBody(tx, signature, publicKey);
    // The body with the key, for a node that cannot resolve the elided one (the key is checked like any: a bad one throws).
    let keyBody = publicKey === null && publicKeyIfUnresolved !== null ? requestBody(tx, signature, publicKeyIfUnresolved) : null;
    let last: QNetError = new QNetNodeError('NODE_UNAVAILABLE', '');
    let maybeHeld = false;
    const refusal = (reason: string): QNetNodeError => new QNetNodeError(maybeHeld ? 'SUBMIT_UNCERTAIN' : 'NODE_REJECTED', reason);
    nodes: for (const node of this.order()) {
      // At most twice per node: once more with the public key when the node could not resolve the elided one.
      for (;;) {
        let answer: { status: number; text: string } | null = null;
        // A connection the node reset is tried once more on a new one: the same body, so at most one copy applies, and
        // the first attempt counts as one that may have arrived.
        for (let attempt = 0; attempt < 2 && answer === null; attempt += 1) {
          try {
            answer = await this.fetchText(node + tx.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          } catch (error) {
            if (!(error instanceof QNetError)) throw error;
            last = error;
            maybeHeld ||= mayHaveArrived(error);
            if (!isReset(error)) break;
          }
        }
        if (answer === null) continue nodes;
        if (answer.status < 200 || answer.status >= 300) {
          // The node's web layer refuses a body it cannot read with plain text.
          if (answer.status >= 500) {
            last = new QNetNodeError('NODE_UNAVAILABLE', `HTTP ${answer.status}`);
            maybeHeld = true;
            continue nodes;
          }
          throw refusal(`HTTP ${answer.status}: ${answer.text.slice(0, 300)}`);
        }
        let r: Json;
        try {
          r = this.parse(answer.text);
        } catch (error) {
          last = error as QNetError;
          maybeHeld = true;
          continue nodes;
        }
        if (r.success === false && r.error === 'Rate limit exceeded') {
          last = new QNetNodeError('RATE_LIMITED', 'rate limit exceeded', num(r.retry_after_seconds));
          continue nodes;
        }
        if (r.success !== true) {
          const code = str(r.code);
          const reason = [str(r.error), str(r.details)].filter(Boolean).join(': ') || 'refused';
          const why = code && !reason.includes(code) ? `${reason} (${code})` : reason;
          const local = localRefusal(r, tx.nonce);
          if (local === 'pk_unresolved' && keyBody !== null) {
            // The same transaction with its key: to this node now, and to every node after it.
            body = keyBody;
            keyBody = null;
            continue;
          }
          if (local !== null) {
            // Refused before admission: this node holds nothing, and whether an earlier one may is unchanged.
            last = new QNetNodeError('NODE_REJECTED', why);
            continue nodes;
          }
          throw refusal(why);
        }
        const txHash = typeof r.tx_hash === 'string' && HASH_RE.test(r.tx_hash) ? r.tx_hash : null;
        const contractAddress = isValidAddress(r.contract_address) ? r.contract_address : null;
        // The node took the body: whatever else its answer says, the transaction may apply.
        if (tx.kind === 'contractDeploy' && contractAddress !== tx.contractAddress) {
          throw new QNetNodeError('SUBMIT_UNCERTAIN', 'the node took the deploy but named another contract address');
        }
        return { txHash, contractAddress: tx.kind === 'contractDeploy' ? contractAddress : null, node };
      }
    }
    if (!maybeHeld) throw last;
    throw new QNetNodeError('SUBMIT_UNCERTAIN', last instanceof QNetNodeError ? last.reason : last.message);
  }

  /**
   * Waits until the account's applied nonce reaches `nonce` ('applied'), or a block holds `txHash` while the nonce
   * stays one below it for `settleBlocks` blocks on two nodes, each read for all three facts ('not_applied'), or
   * `timeoutMs` passes. Without `txHash`, or for an account's first transaction (nonce 1), only 'applied' or
   * 'timeout' can come back.
   */
  async waitForTransaction(
    { from, nonce, txHash = null }: { from: string; nonce: string; txHash?: string | null },
    { timeoutMs = 90_000, intervalMs = 2_000, settleBlocks = 3 } = {},
  ): Promise<WaitResult> {
    if (!isValidAddress(from)) throw new QNetError('INVALID_ADDRESS');
    if (txHash !== null && !HASH_RE.test(txHash)) throw new QNetError('INVALID_CALL', 'A transaction hash is 64 lowercase hex characters');
    const target = BigInt(nonce);
    const deadline = Date.now() + timeoutMs;
    let inBlock: number | null = null;
    for (;;) {
      try {
        const account = await this.getAccount(from);
        if (BigInt(account.nonce) >= target) return { state: 'applied', nonce, blockHeight: inBlock };
        if (txHash) {
          const t = await this.getTransaction(txHash);
          if (t.status === 'in_block' && t.blockHeight !== null) {
            inBlock = t.blockHeight;
            const verdict = await this.settledVerdict(from, target, txHash, settleBlocks);
            if (verdict) return { state: verdict.state, nonce, blockHeight: verdict.height };
          }
        }
      } catch (error) {
        if (!(error instanceof QNetNodeError)) throw error;
      }
      if (Date.now() + intervalMs > deadline) return { state: 'timeout', nonce, blockHeight: inBlock };
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  // Each node in turn, all three reads from that one node: the transaction in a block, its tip at least `settle` blocks
  // above it, and the account. 'applied' on any node whose nonce reached the target; 'not_applied' once two nodes (the
  // only one, when one is configured) report the nonce exactly one below it. A node behind, or one whose nonce is
  // anything else, counts for neither. A node answers the default account (nonce 0, balance 0) for a missing row, and a
  // node of an earlier release for a failed storage read too (a current one answers 503 account_unreadable, which
  // reads as no answer), so nonce 0 proves nothing: for a first transaction (target 1) no node's answer can
  // count towards 'not_applied', and only 'applied' or nothing comes back (DEV-R2-05).
  private async settledVerdict(from: string, target: bigint, txHash: string, settle: number):
    Promise<{ state: 'applied' | 'not_applied'; height: number } | null> {
    const need = target > 1n ? Math.min(2, this.nodes.length) : Infinity;
    let agree = 0;
    for (const node of this.order()) {
      try {
        const t = parseNodeTransaction(txHash, await this.get(`/api/v1/transaction/${txHash}`, node));
        const h = t?.status === 'in_block' ? t.blockHeight : null;
        if (h === null) continue;
        const tip = num((await this.get('/api/v1/height', node)).height);
        if (tip === null || tip < h + settle) continue;
        const account = parseAccount(await this.get(`/api/v1/account/${from}`, node), from);
        const applied = BigInt(account.nonce);
        if (applied >= target) return { state: 'applied', height: h };
        if (applied + 1n !== target) continue;
        agree += 1;
        if (agree >= need) return { state: 'not_applied', height: h };
      } catch (error) {
        if (!(error instanceof QNetError)) throw error;
      }
    }
    return null;
  }
}
