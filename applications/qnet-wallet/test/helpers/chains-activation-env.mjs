// A deterministic wallet environment for the chains-activation tests: the public recovery-phrase test vector's
// keys, an in-memory vault state with the contract's shape checks, a session, and a fetch that serves
// only what a test routes (anything else fails: these tests never reach the network).
import * as core from '../../dist/lib/qnet-core.js';
import { RECORD_ORIGIN, SOLANA } from '../../dist/background/config.js';
import { WalletError } from '../../dist/background/errors.js';

export const KAT_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const PASSWORD = 'correct horse battery staple';

const seed = core.mnemonicToSeed(KAT_MNEMONIC);
const qnetKeys = core.deriveQnetKeypair(seed);
const solanaKeys = core.deriveSolanaKeypair(seed);

export const WALLET = Object.freeze({
  qnetAddress: qnetKeys.address,
  solanaAddress: solanaKeys.address,
  qnetPublicKey: qnetKeys.publicKey,
  solanaPublicKey: solanaKeys.publicKey,
  walletId: '6f1c2b1e-3d4a-4b5c-8d6e-7f8091a2b3c4',
});

export const emptyState = () => ({
  activation: null, pendingBurn: null, pendingTransfers: [], settings: { autoLockMinutes: 15 }, recipients: [], legacy: null,
  solanaRecipients: [], recentTransfers: [], exposedAdvice: false, supersededBurn: null, registration: null, spends: [],
});

const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
const ACTIVATION_KEYS = ['code', 'nodeType', 'burnTx', 'burnAmount', 'solanaAddress', 'cluster', 'createdAt'];
const PENDING_BURN_KEYS = ['burnTx', 'nodeType', 'burnAmount', 'solanaAddress', 'cluster', 'createdAt', 'lastValidBlockHeight'];
const PENDING_TRANSFER_KEYS = ['nonce', 'to', 'amountNano', 'feeNano', 'body', 'txHash', 'createdAt', 'lastSubmitAt', 'outcome', 'kind', 'call'];
const SPEND_KEYS = ['nonce', 'qncNano', 'token', 'tokenAmount', 'tokenUnknown', 'settledAt'];
const REGISTRATION_KEYS = ['nodeId', 'burnTx', 'burner', 'state', 'attempts', 'nextAt', 'txHash', 'admittedAt', 'lastError', 'updatedAt'];

// The checks vault.decodePlaintext / updateState promise (CONTRACTS.md section 5), so a module that
// writes a field the vault would refuse fails here too.
function assertState(next, previous) {
  const fail = (why) => {
    throw new Error(`vault would refuse this state: ${why}`);
  };
  if (!exactKeys(next, ['activation', 'pendingBurn', 'pendingTransfers', 'settings', 'recipients', 'legacy', 'solanaRecipients',
    'recentTransfers', 'exposedAdvice', 'supersededBurn', 'registration', 'spends'])) fail('state keys');
  // vault isValidSpends: what each recent transaction of this wallet can take, by nonce
  if (!Array.isArray(next.spends) || next.spends.length > 64 || next.spends.some((r) => !exactKeys(r, SPEND_KEYS)
    || !/^(0|[1-9][0-9]*)$/.test(r.nonce) || !/^(0|[1-9][0-9]*)$/.test(r.qncNano)
    || !((r.token === null && r.tokenAmount === null) || (core.isValidQnetAddress(r.token) && /^(0|[1-9][0-9]*)$/.test(r.tokenAmount)))
    || typeof r.tokenUnknown !== 'boolean' || (r.tokenUnknown && r.token !== null)
    || !(r.settledAt === null || Number.isSafeInteger(r.settledAt)))) fail('spends');
  // a registration records the light activation of this wallet's own light node (vault.isConsistentState)
  if (next.registration !== null && (!exactKeys(next.registration, REGISTRATION_KEYS)
    || !['queued', 'admitted', 'onchain', 'other_burn', 'refused', 'clock'].includes(next.registration.state)
    || next.activation?.nodeType !== 'light' || next.registration.burnTx !== next.activation.burnTx
    || next.registration.burner !== next.activation.solanaAddress || next.registration.nodeId !== core.lightNodeId(WALLET.qnetAddress)
    || !Number.isSafeInteger(next.registration.attempts) || !Number.isSafeInteger(next.registration.nextAt)
    || !(next.registration.lastError === null || /^[a-z0-9_]{1,32}$/.test(next.registration.lastError)))) {
    fail('registration');
  }
  if (next.legacy !== null) fail('legacy');
  if (typeof next.exposedAdvice !== 'boolean') fail('exposedAdvice');
  if (next.supersededBurn !== null && (!exactKeys(next.supersededBurn, ['burnTx', 'nodeType', 'burnAmount', 'solanaAddress', 'cluster', 'createdAt'])
    || next.supersededBurn.solanaAddress !== WALLET.solanaAddress || next.supersededBurn.burnTx === next.activation?.burnTx)) {
    fail('supersededBurn');
  }
  if (!Array.isArray(next.solanaRecipients) || next.solanaRecipients.length > 128
    || next.solanaRecipients.some((a) => !core.isValidSolanaAddress(a)) || new Set(next.solanaRecipients).size !== next.solanaRecipients.length
    || next.solanaRecipients.includes(WALLET.solanaAddress)) fail('solanaRecipients');
  if (!Array.isArray(next.recentTransfers) || next.recentTransfers.length > 64
    || next.recentTransfers.some((r) => !exactKeys(r, ['to', 'amountNano', 'createdAt']) || !core.isValidQnetAddress(r.to)
      || !/^(0|[1-9][0-9]*)$/.test(r.amountNano) || !Number.isSafeInteger(r.createdAt))) fail('recentTransfers');
  if (!Array.isArray(next.recipients) || next.recipients.length > 128 || next.recipients.some((a) => !core.isValidQnetAddress(a))
    || new Set(next.recipients).size !== next.recipients.length || next.recipients.includes(WALLET.qnetAddress)) fail('recipients');
  if (next.activation !== null) {
    const a = next.activation;
    if (!exactKeys(a, ACTIVATION_KEYS)) fail('activation keys');
    if (!core.ACTIVATION_CODE_RE.test(a.code)) fail('activation code');
    if (!Number.isSafeInteger(a.burnAmount) || !Number.isSafeInteger(a.createdAt)) fail('activation numbers');
    // vault.isConsistentState: the burner's code for a burn of the phrase's addresses, the wallet's code for a light burn
    // aiqnet.io paid for this wallet, which exists only with its registration on chain
    const burners = [WALLET.solanaAddress];
    const own = burners.includes(a.solanaAddress) && core.activationCodeMatches(a.code, a.nodeType, a.solanaAddress, a.burnTx, a.burnAmount);
    const paid = a.nodeType === 'light' && !burners.includes(a.solanaAddress) && next.registration?.state === 'onchain'
      && core.walletActivationCode(WALLET.qnetAddress, a.burnTx, a.burnAmount) === a.code;
    if (!own && !paid) fail('activation code of another burn or wallet');
  }
  if (previous.activation !== null && JSON.stringify(previous.activation) !== JSON.stringify(next.activation)) {
    fail('an activation is never replaced or removed (R15)');
  }
  if (next.pendingBurn !== null && !exactKeys(next.pendingBurn, PENDING_BURN_KEYS)) fail('pendingBurn keys');
  if (next.pendingBurn !== null && !(next.pendingBurn.lastValidBlockHeight === null || Number.isSafeInteger(next.pendingBurn.lastValidBlockHeight))) {
    fail('pendingBurn lastValidBlockHeight');
  }
  if (!Array.isArray(next.pendingTransfers) || next.pendingTransfers.length > 16) fail('pendingTransfers');
  for (const p of next.pendingTransfers) {
    if (!exactKeys(p, PENDING_TRANSFER_KEYS)) fail('pendingTransfer keys');
    for (const f of ['nonce', 'amountNano', 'feeNano']) if (!/^(0|[1-9][0-9]*)$/.test(p[f])) fail(`pendingTransfer ${f}`);
    if (typeof p.body !== 'string' || !(p.txHash === null || typeof p.txHash === 'string')) fail('pendingTransfer body');
    if (!['pending', 'replaced', 'passed', 'superseded', 'refused'].includes(p.outcome)) fail('pendingTransfer outcome');
    if (p.kind === 'transfer' ? p.call !== null : p.kind !== 'call' || !exactKeys(p.call, ['method', 'recipient', 'amount'])) fail('pendingTransfer kind');
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Installs a fresh environment as globalThis.__qnetChainsEnv.
 * @param {{state?: object, locked?: boolean}} [options]
 */
export function installEnv({ state = emptyState(), locked = false } = {}) {
  let stored = clone(state);
  let queue = Promise.resolve();
  const env = {
    locked,
    calls: {
      touch: 0, verifyPassword: 0, updateState: 0, signQnetTransfer: 0, signQnetCall: 0, signSolanaMessage: 0, signNodeRegistration: 0,
      signNodeClaim: 0, signClaimPayload: 0, signNodeStatus: 0, signNodeUnbind: 0, signBurnRecord: 0, signReservation: 0,
    },
    // session.cachedViews: the popup's view cache of this session (decision 39)
    views: { qnetBalance: null, qnetHistory: null, solanaBalances: null, solanaHistory: null, qnetTokens: null },
    stateHistory: [],
    session: {
      async requireUnlocked() {
        if (env.locked) throw new WalletError('LOCKED');
        return { walletId: WALLET.walletId, qnetAddress: WALLET.qnetAddress, solanaAddress: WALLET.solanaAddress, lockDeadline: Date.now() + 900000 };
      },
      async touch() {
        env.calls.touch++;
      },
      async cachedViews() {
        if (env.locked) throw new WalletError('LOCKED');
        return clone(env.views);
      },
      // session.forgetViews: the views of a chain the wallet no longer follows (qnet.followChain)
      async forgetViews(names) {
        env.forgotten.push(...names);
        for (const name of names) env.views[name] = null;
      },
    },
    vault: {
      async readState() {
        if (env.locked) throw new WalletError('LOCKED');
        return clone(stored);
      },
      updateState(mutator) {
        const run = queue.then(async () => {
          if (env.locked) throw new WalletError('LOCKED');
          env.calls.updateState++;
          const next = await mutator(clone(stored));
          assertState(next, stored);
          stored = clone(next);
          env.stateHistory.push(clone(next));
          return clone(stored);
        });
        queue = run.catch(() => {});
        return run;
      },
      async verifyPassword(password) {
        env.calls.verifyPassword++;
        if (password !== PASSWORD) throw new WalletError('BAD_PASSWORD');
      },
      // the light client's verified anchors (vault.readLightAnchors / writeLightAnchors)
      async readLightAnchors() {
        return env.anchors === null ? null : clone(env.anchors);
      },
      async writeLightAnchors(anchors) {
        env.anchorWrites++;
        env.anchors = clone(anchors);
      },
      // the chain cache (vault.readChainCache / updateChainCache): the head this wallet saw and the kept balances
      async readChainCache() {
        if (env.locked) throw new WalletError('LOCKED');
        return clone(env.chainCache);
      },
      async updateChainCache(mutator) {
        if (env.locked) throw new WalletError('LOCKED');
        env.chainCache = clone(mutator(clone(env.chainCache)));
        return clone(env.chainCache);
      },
      // the kept burn searches (vault.readBurnScan / writeBurnScan), per owner and kind ('account', or 'signed' under
      // `${owner}:signed`)
      async readBurnScan(owner, kind = 'account') {
        if (env.locked) throw new WalletError('LOCKED');
        const key = kind === 'signed' ? `${owner}:signed` : owner;
        return Object.hasOwn(env.burnScans, key) ? clone(env.burnScans[key]) : null;
      },
      async writeBurnScan(owner, scan, kind = 'account') {
        if (env.locked) throw new WalletError('LOCKED');
        env.burnScans[kind === 'signed' ? `${owner}:signed` : owner] = clone(scan);
      },
    },
    burnScans: {},
    chainCache: {},
    forgotten: [],
    anchors: null,
    anchorWrites: 0,
    keys: {
      async signQnetTransfer(fields) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signQnetTransfer++;
        const { preimage, signature } = core.signTransfer(fields, qnetKeys.secretKey, qnetKeys.publicKey);
        return { preimage, signature, publicKey: qnetKeys.publicKey.slice() };
      },
      async signSolanaMessage(messageBytes) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signSolanaMessage++;
        return { signature: core.signSolanaMessage(messageBytes, solanaKeys.privateKey), publicKey: solanaKeys.publicKey.slice() };
      },
      // keys.signQnetTokenTransfer / signQnetContractCall: the shared builder's transaction, signed with the KAT key
      async signQnetTokenTransfer(fields) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signQnetCall++;
        const signed = core.signTokenTransfer(fields, qnetKeys.secretKey, qnetKeys.publicKey);
        return { ...signed, publicKey: qnetKeys.publicKey.slice() };
      },
      async signQnetContractCall(fields) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signQnetCall++;
        const signed = core.signContractCall(fields, qnetKeys.secretKey, qnetKeys.publicKey);
        return { ...signed, publicKey: qnetKeys.publicKey.slice() };
      },
      // keys.signNodeRegistration / signNodeClaim / signClaimPayload / signNodeStatus: the core's node signers with the
      // KAT keys, the owner bind by the wallet's Solana key (the burner the activation names)
      async signNodeRegistration({ nodeId, wallet, burnTx, burner, timestamp }) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signNodeRegistration++;
        const { activation } = stored;
        if (activation?.nodeType !== 'light' || activation.burnTx !== burnTx || activation.solanaAddress !== burner) {
          throw new WalletError('NOT_FOUND');
        }
        if (burner !== solanaKeys.address) throw new WalletError('ADDRESS_MISMATCH');
        const message = { nodeId, wallet, burnTx, ts: timestamp };
        const consent = core.signNodeConsent(message, qnetKeys.secretKey, qnetKeys.publicKey);
        const owner = core.signOwnerBind(message, qnetKeys.publicKey, solanaKeys.privateKey, solanaKeys.publicKey);
        return { proof: consent.proof, consentSignature: consent.signature, ownerSignature: owner.signature, publicKey: qnetKeys.publicKey.slice() };
      },
      async signNodeClaim({ nodeId, wallet }) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signNodeClaim++;
        return { signature: core.signClaimQuote({ nodeId, wallet }, qnetKeys.secretKey, qnetKeys.publicKey).signature, publicKey: qnetKeys.publicKey.slice() };
      },
      async signClaimPayload({ wallet, timestamp, claimsData }) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signClaimPayload++;
        const signed = core.signClaimPayload({ wallet, ts: timestamp, claimsData }, qnetKeys.secretKey, qnetKeys.publicKey);
        return { signature: signed.signature, publicKey: qnetKeys.publicKey.slice() };
      },
      async signNodeStatus({ nodeId, wallet, timestamp }) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signNodeStatus++;
        const signed = core.signNodeStatus({ nodeId, wallet, ts: timestamp }, qnetKeys.secretKey, qnetKeys.publicKey);
        return { signature: signed.signature, publicKey: qnetKeys.publicKey.slice() };
      },
      // keys.signNodeUnbind: the wallet key's unbind of the node's device (decision 38)
      async signNodeUnbind({ nodeId, wallet, seq, timestamp }) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signNodeUnbind++;
        const signed = core.signNodeUnbind({ nodeId, wallet, seq, ts: timestamp }, qnetKeys.secretKey, qnetKeys.publicKey);
        return { signature: signed.signature, publicKey: qnetKeys.publicKey.slice() };
      },
      // keys.signBurnRecord: the proof of a burn record for aiqnet.io (CONTRACTS.md decision 35), with the KAT keys and
      // the same checks against the session
      async signBurnRecord({ wallet, nodeType, burner, burnTx, burnAmount }) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signBurnRecord++;
        if (wallet !== WALLET.qnetAddress || burner !== WALLET.solanaAddress) throw new WalletError('ADDRESS_MISMATCH');
        const message = ['QNet burn record v1', `wallet: ${wallet}`, `node: ${nodeType}`, `burner: ${burner}`, `burn: ${burnTx}`,
          `amount: ${burnAmount}`, `cluster: ${SOLANA.CLUSTER}`].join('\n');
        const envelope = core.buildSiteRecord(RECORD_ORIGIN, message);
        const signed = core.signSiteRecord(RECORD_ORIGIN, message, qnetKeys.secretKey, qnetKeys.publicKey);
        const url = (bytes) => core.base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return { pk: url(qnetKeys.publicKey), sig: url(signed.signature), solanaSig: core.base58Encode(core.signSolanaMessage(envelope, solanaKeys.privateKey)) };
      },
      // keys.signReservation: the wallet's signed request of aiqnet.io's reservation (decision 36), with the KAT key and the
      // same checks against the session
      async signReservation({ wallet, nodeType, way, burner, time }) {
        if (env.locked) throw new WalletError('LOCKED');
        env.calls.signReservation++;
        if (wallet !== WALLET.qnetAddress || burner !== WALLET.solanaAddress) throw new WalletError('ADDRESS_MISMATCH');
        if (way !== 'extension' || !core.ACTIVATION_NODE_TYPES.includes(nodeType) || !Number.isSafeInteger(time) || time < 1) {
          throw new WalletError('INTERNAL');
        }
        const message = ['QNet node reservation v1', `wallet: ${wallet}`, `node: ${nodeType}`, `way: ${way}`, `burner: ${burner}`,
          `time: ${time}`, `cluster: ${SOLANA.CLUSTER}`].join('\n');
        const signed = core.signSiteRecord(RECORD_ORIGIN, message, qnetKeys.secretKey, qnetKeys.publicKey);
        const url = (bytes) => core.base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return { pk: url(qnetKeys.publicKey), sig: url(signed.signature), time };
      },
      async getQnetPublicKey() {
        return qnetKeys.publicKey.slice();
      },
      signingEnabled: () => true,
    },
    state: () => clone(stored),
    setState: (next) => {
      stored = clone(next);
    },
  };
  globalThis.__qnetChainsEnv = env;
  return env;
}

// ---------------------------------------------------------------- fetch

/**
 * Replaces globalThis.fetch. `route({url, method, headers, body})` returns {status?, body} (body text or
 * a JSON value), a Response, or throws to simulate a network failure. Every request is recorded.
 * @param {(request: object) => unknown} route
 */
export function installFetch(route) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const request = { url: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body ?? null, init };
    requests.push(request);
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const answer = await route(request);
    if (answer instanceof Response) return answer;
    if (answer === undefined) throw new TypeError(`offline test: no route for ${request.method} ${request.url}`);
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return requests;
}

/**
 * A route for the Solana RPC URL: `methods[name](params, request)` returns the JSON-RPC result, or
 * {rpcError: {code, message}} for an error answer; a missing method fails the test.
 * @param {Record<string, Function>} methods
 */
export function solanaRoute(methods) {
  return async (request) => {
    if (!SOLANA.RPC_URLS.includes(request.url)) return undefined;
    const { method, params, id } = JSON.parse(request.body);
    if (!Object.hasOwn(methods, method)) throw new TypeError(`offline test: unexpected Solana call ${method}`);
    const result = await methods[method](params, request);
    if (result && typeof result === 'object' && result.rpcError) {
      return { body: { jsonrpc: '2.0', id, error: result.rpcError } };
    }
    return { body: { jsonrpc: '2.0', id, result } };
  };
}

/** Tries each route in turn; the first that answers wins. */
export const routes = (...list) => async (request) => {
  for (const route of list) {
    const answer = await route(request);
    if (answer !== undefined) return answer;
  }
  return undefined;
};

/** A 64-byte base58 signature that is not a real one, distinct per n. */
export function fakeSignature(n) {
  const bytes = new Uint8Array(64);
  new DataView(bytes.buffer).setUint32(0, n + 1);
  bytes[63] = 7;
  return core.base58Encode(bytes);
}

/** Lets pending promise chains and immediate callbacks run. */
export const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};
