// A worker for the provider tests: the real router and provider state machine over chrome-mock, with
// fakes for the session, vault binding, signer and QNet node (areas A and B are not needed). Approval
// windows, timers and view broadcasts are recorded so tests can drive them.
import { readFile } from 'node:fs/promises';
import * as core from '../../dist/lib/qnet-core.js';
import { WalletError } from '../../dist/background/errors.js';
import { createProviderService } from '../../dist/background/provider.js';
import { createRouter } from '../../dist/background/router.js';
import { contentScriptSender, createChrome, createEvent, createPort, pageSender, until } from './chrome-mock.mjs';

export const MANIFEST = JSON.parse(await readFile(new URL('../../dist/manifest.json', import.meta.url), 'utf8'));
export const SITE = 'https://aiqnet.io';
// A second dApp origin for the tests: the store build names aiqnet.io only (R4-ERP-02), so the test world's
// manifest adds this host (manifestWithHosts) the way the dev overlay adds loopback.
export const APP = 'https://dapp.qnet.test';

/**
 * The store manifest with extra content-script hosts: APP, and any given (the store build names one exact host;
 * tests need a second origin the router accepts, and the IDN display tests more).
 * @param {...string} origins canonical https origins
 */
export function manifestWithHosts(...origins) {
  const manifest = structuredClone(MANIFEST);
  for (const script of manifest.content_scripts) script.matches.push(...[APP, ...origins].map((origin) => `${origin}/*`));
  return manifest;
}
export const WALLET_ID = '6f1c1d52-8f0a-4c43-9d1e-2b7b8c9a0e11';
export const SITES_KEY = 'qnet_sites_v3';
export const ACCOUNTS = Object.freeze({ qnet: core.KAT.qnetAddress, solana: core.KAT.solanaAddress });
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The fake vault.unlock accepts only this password.
export const PASSWORD = 'correct horse battery staple';

const seed = core.mnemonicToSeed(core.KAT.mnemonic);
export const KEYPAIR = core.deriveQnetKeypair(seed);
seed.fill(0);

// A built-in token and a WASM contract the chain derived from this wallet's deploys (nonces 1 and 3).
export const TOKEN = core.deriveContractAddress(core.KAT.qnetAddress, 1);
export const GAME = core.deriveContractAddress(core.KAT.qnetAddress, 3);
export const TOKEN_INFO = Object.freeze({ kind: 'token', standard: 'qrc20', name: 'Gold Coin', symbol: 'GOLD', decimals: 6 });

// This wallet's light node id (nodes.js answers for it).
export const NODE_ID = core.lightNodeId(core.KAT.qnetAddress);

// A well-formed burn signature (the public activation-code vector's) for this wallet's activation records.
export const BURN_TX = core.KAT.activation.burnTx;

/** The vault's Activation of this wallet (with its code), as activation.activateForSite returns it. */
export function activationRecord(nodeType = 'light', burnAmount = 1500) {
  return {
    code: core.generateActivationCode(nodeType, ACCOUNTS.solana, BURN_TX, burnAmount),
    nodeType, burnTx: BURN_TX, burnAmount, solanaAddress: ACCOUNTS.solana, cluster: 'devnet', createdAt: 1_790_000_000_000,
  };
}

/**
 * A grant entry exactly as CONTRACTS.md 4.7 defines it, computed independently of provider.js:
 * mac = base64(HMAC-SHA256(sitesKey, UTF-8(canonicalJson({origin, grantedAt, chains, walletId})))).
 */
export function grantEntry(origin, { walletId = WALLET_ID, sitesKey, grantedAt = 1_700_000_000_000, chains = ['qnet', 'solana'] }) {
  // canonical JSON: keys sorted (chains, grantedAt, origin, walletId), no whitespace
  const text = JSON.stringify({ chains, grantedAt, origin, walletId });
  const mac = core.base64Encode(core.hmac(core.sha256, sitesKey, core.utf8Encode(text)));
  return { grantedAt, chains, walletId, mac };
}

/** Resolves with the first message posted to `port` that answers `id`. */
export async function replyTo(port, id) {
  await until(() => port.posted.some((m) => m.id === id));
  return port.posted.find((m) => m.id === id);
}

/** Sends a request on a port and resolves with its answer. */
export async function ask(port, message) {
  port.send(message);
  return replyTo(port, message.id);
}

export const eventsOf = (port) => port.posted.filter((m) => Object.hasOwn(m, 'event'));

/** Lets pending promise chains and setImmediate callbacks run. */
export async function settleAll(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {{unlocked?: boolean, manifest?: object, now?: () => number}} [options] now: the provider's clock
 *   (approval cooldowns); default Date.now
 */
export function createWorld(options = {}) {
  const chrome = createChrome({ manifest: options.manifest ?? manifestWithHosts() });
  const state = {
    unlocked: options.unlocked ?? true,
    vaultExists: true,
    walletId: WALLET_ID,
    sitesKey: core.sha256(core.utf8Encode('provider test sites key')),
    nonce: '5',
    balanceNano: '10000000000',
    lockAtSigning: false,
    sendError: null,
    // qnet.recipientCheck: how the recipient relates to this wallet's own sends; recipientError fails it
    recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true },
    recipientError: null,
    // the wallet's earlier sends not seen applied, as qnet.prepareTransfer lists them
    outstanding: [],
    // promises a test holds a collaborator on (a slow read, a slow unlock check), or null
    gates: { prepare: null, siteView: null, unlock: null },
    verification: 'proof',
    // a WalletError the previews (qnet.prepareTransfer, prepareCall) fail with, e.g. the send rule's BALANCE_UNCONFIRMED
    prepareError: null,
    // an earlier transaction still holds the nonce before this one's (qnet previews' inFlight)
    inFlight: false,
    // qnet.readContract answers by address (anything else: no contract); contractError fails it
    contracts: { [TOKEN]: TOKEN_INFO, [GAME]: { kind: 'contract' } },
    contractError: null,
    // a token transfer's reads: the sender's token balance (null: unreadable, for tokenProblem) and the deposit for a new holder
    tokenBalance: '5000000000',
    tokenProblem: 'BALANCE_UNCONFIRMED',
    depositNano: '10000000',
    // qnet.transactionStatus's answer, or null for a pending one; statusError fails it
    status: null,
    statusError: null,
    // activation.siteView / activateForSite (qnet_activateNode)
    price: 1500,
    siteView: null,
    siteViewError: null,
    activateOutcome: null,
    activateError: null,
    // activation.siteActivation (qnet_getActivation, decision 35): its answer, or an error it throws
    siteActivation: null,
    siteActivationError: null,
    // nodes.claimView / claimForSite (qnet_claimNodeBalance) and getRegistration (the activation window after its answer)
    claimBalance: '2500000000',
    claimView: null,
    claimViewError: null,
    claimOutcome: null,
    claimError: null,
    registration: null,
    // nodes.unlinkView / unlinkForSite (qnet_unlinkNodeDevice, decision 38)
    unlinkView: null,
    unlinkViewError: null,
    unlinkOutcome: null,
    unlinkError: null,
  };
  const log = {
    windows: [], removed: [], views: [], signCalls: [], sendCalls: [], unlockAttempts: [], recipientChecks: [], maxOpen: 0,
    siteViews: [], activations: [], contractReads: [], recipientReads: [], callPreviews: [], callSends: [], statusReads: [], claimViews: 0,
    claims: 0, siteActivations: 0, unlinkViews: 0, unlinks: 0,
  };
  const openWindows = new Set();
  const timers = [];
  let nextWindowId = 500;
  const world = { chrome, state, log, timers, openWindows };

  chrome.windows.create = async (createData) => {
    const id = nextWindowId;
    nextWindowId += 1;
    openWindows.add(id);
    log.maxOpen = Math.max(log.maxOpen, openWindows.size);
    log.windows.push({ id, ...createData });
    return { id, type: createData.type };
  };
  // Chrome fires windows.onRemoved for a window the extension closes too (sw.js forwards it).
  chrome.windows.remove = async (windowId) => {
    if (!openWindows.delete(windowId)) throw new Error(`No window with id: ${windowId}.`);
    log.removed.push(windowId);
    setImmediate(() => world.provider.onWindowRemoved(windowId));
  };

  const account = () => ({ walletId: state.walletId, qnetAddress: ACCOUNTS.qnet, solanaAddress: ACCOUNTS.solana, lockDeadline: Date.now() + 900_000 });
  const session = {
    isUnlocked: async () => state.unlocked,
    requireUnlocked: async () => {
      if (state.gates.unlock) await state.gates.unlock;
      if (!state.unlocked) throw new WalletError('LOCKED');
      return account();
    },
  };
  const vault = {
    vaultExists: async () => state.vaultExists,
    readSiteBinding: async () => (state.vaultExists ? { walletId: state.walletId, sitesKey: state.sitesKey.slice() } : null),
    rotateSitesKey: async () => {
      if (!state.vaultExists) return null;
      state.sitesKey = crypto.getRandomValues(new Uint8Array(32));
      return { walletId: state.walletId, sitesKey: state.sitesKey.slice() };
    },
  };
  const keys = {
    signOffchain: async (origin, message) => {
      log.signCalls.push({ origin, message });
      if (!state.unlocked || state.lockAtSigning) throw new WalletError('LOCKED');
      return core.signOffchainMessage(origin, message, KEYPAIR.secretKey, KEYPAIR.publicKey);
    },
  };
  const qnet = {
    transferFeeNano: () => '150000',
    prepareTransfer: async ({ to, amountNano }) => (state.gates.prepare ? state.gates.prepare : Promise.resolve()).then(() => {
      if (state.prepareError) throw state.prepareError;
    }).then(() => ({
      from: ACCOUNTS.qnet,
      to,
      amountNano,
      feeNano: '150000',
      totalNano: (BigInt(amountNano) + 150000n).toString(),
      nonce: state.nonce,
      balanceNano: state.balanceNano,
      verified: state.verification !== 'none',
      verification: state.verification,
      // qnet.prepareTransfer's earlier sends not seen applied (R2-EXTQ-03), and its own record of a same-amount send
      // to the same address in the last 30 minutes (R3-EXTQ-01)
      outstanding: state.outstanding,
      duplicate: state.duplicate === true,
      // a transfer a node refused, which a new one replaces by default (R5-EXTQ-02)
      replacesNonce: state.replacesNonce ?? null,
      inFlight: state.inFlight,
    })),
    sendTransfer: async (transfer) => {
      log.sendCalls.push(transfer);
      if (transfer.expectedNonce !== state.nonce) throw new WalletError('NONCE_CHANGED');
      if (state.sendError) throw state.sendError;
      return { txHash: 'ab'.repeat(32), status: 'submitted', nonce: transfer.expectedNonce };
    },
    recipientCheck: async (to) => {
      log.recipientChecks.push(to);
      if (!state.unlocked) throw new WalletError('LOCKED');
      if (state.recipientError) throw state.recipientError;
      return { ...state.recipient };
    },
    readContract: async (address) => {
      log.contractReads.push(address);
      if (state.contractError) throw state.contractError;
      return { ...(state.contracts[address] ?? { kind: 'none' }) };
    },
    // qnet.assertPayableRecipient over the same answers: a contract or token is refused, an unreadable one unchecked
    assertPayableRecipient: async (to) => {
      log.recipientReads.push(to);
      if (state.contractError) throw state.contractError.code === 'NETWORK' ? new WalletError('RECIPIENT_UNCHECKED') : state.contractError;
      if ((state.contracts[to]?.kind ?? 'none') !== 'none') throw new WalletError('RECIPIENT_IS_CONTRACT');
    },
    // qnet.prepareCall as the shared builder makes the call at state.nonce, with the harness's account and token reads
    prepareCall: async (request) => (state.gates.prepare ? state.gates.prepare : Promise.resolve()).then(() => {
      log.callPreviews.push(request);
      if (!state.unlocked) throw new WalletError('LOCKED');
      if (state.prepareError) throw state.prepareError;
      const token = request.kind === 'tokenTransfer';
      const tx = token
        ? core.buildTokenTransfer({ from: ACCOUNTS.qnet, token: request.token, to: request.to, amount: request.amountBase, nonce: state.nonce })
        : core.buildContractCall({ ...request, from: ACCOUNTS.qnet, nonce: state.nonce });
      const depositNano = token ? state.depositNano : '0';
      const preview = {
        kind: tx.kind, from: ACCOUNTS.qnet, contract: tx.contract, method: tx.method, gasLimit: tx.gasLimit, feeNano: tx.maxFeeNano,
        depositNano, totalNano: (BigInt(tx.maxFeeNano) + BigInt(depositNano)).toString(), nonce: state.nonce,
        balanceNano: state.balanceNano, verified: state.verification !== 'none', verification: state.verification, outstanding: state.outstanding,
        replacesNonce: state.replacesNonce ?? null, inFlight: state.inFlight,
      };
      return token ? {
        ...preview, to: tx.to, amountBase: tx.amount, tokenBalance: state.tokenBalance,
        tokenProblem: state.tokenBalance === null ? state.tokenProblem : null, duplicate: state.duplicate === true,
      }
        : { ...preview, args: tx.args };
    }),
    sendCall: async (call) => {
      log.callSends.push(call);
      if (call.expectedNonce !== state.nonce) throw new WalletError('NONCE_CHANGED');
      if (state.sendError) throw state.sendError;
      return { txHash: 'cd'.repeat(32), status: 'submitted', nonce: call.expectedNonce, from: ACCOUNTS.qnet };
    },
    transactionStatus: async (query) => {
      log.statusReads.push(query);
      if (state.statusError) throw state.statusError;
      return state.status ?? { status: 'pending', from: query.from, nonce: query.nonce, txHash: null, blockHeight: null };
    },
  };

  // What activation.js would answer: a burn view at state.price unless the test sets state.siteView; an
  // 'ok' activation of this wallet unless it sets state.activateOutcome.
  const activation = {
    siteView: async (nodeType, known) => {
      log.siteViews.push({ nodeType, known: { ...known } });
      if (state.gates.siteView) await state.gates.siteView;
      if (!state.unlocked) throw new WalletError('LOCKED');
      if (state.siteViewError) throw state.siteViewError;
      const burn = {
        mode: 'burn', reason: null, cost: known.cost ?? state.price, activation: null, pending: null,
        balances: { lamports: '2000000000', oneDevRaw: '5000000000' }, nodeChecked: true,
      };
      return state.siteView ? { ...burn, ...state.siteView } : burn;
    },
    // no password reaches it: the unlocked session and the window's armed confirm authorize the activation
    activateForSite: async (params) => {
      log.activations.push({ ...params });
      if (!state.unlocked) throw new WalletError('LOCKED');
      if (state.activateError) throw state.activateError;
      return state.activateOutcome ?? { status: 'ok', activation: activationRecord(params.nodeType, params.expectedPrice ?? state.price) };
    },
    // what the extension knows of the wallet's activation, for aiqnet.io's read (never a window)
    siteActivation: async () => {
      log.siteActivations += 1;
      if (!state.unlocked) throw new WalletError('LOCKED');
      if (state.siteActivationError) throw state.siteActivationError;
      return state.siteActivation ?? { status: 'none', qnet: ACCOUNTS.qnet, solana: ACCOUNTS.solana };
    },
  };

  // What nodes.js would answer: a claim view of this wallet's light node at state.claimBalance unless the test sets
  // state.claimView, a submitted move of it unless it sets state.claimOutcome, and state.registration.
  const nodes = {
    claimView: async () => {
      log.claimViews += 1;
      if (!state.unlocked) throw new WalletError('LOCKED');
      if (state.claimViewError) throw state.claimViewError;
      return { mode: 'claim', reason: null, nodeId: NODE_ID, amountNano: state.claimBalance, ...(state.claimView ?? {}) };
    },
    claimForSite: async () => {
      log.claims += 1;
      if (!state.unlocked) throw new WalletError('LOCKED');
      if (state.claimError) throw state.claimError;
      return state.claimOutcome ?? {
        status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: state.claimBalance, txHash: 'ef'.repeat(32), stoppedAtEpoch: null,
      };
    },
    getRegistration: async () => ({ registration: state.registration }),
    // the device of this wallet's light node (an Android phone linked on a day) unless the test sets state.unlinkView, and
    // the network's taking of the unbind unless it sets state.unlinkOutcome or state.unlinkError
    unlinkView: async () => {
      log.unlinkViews += 1;
      if (!state.unlocked) throw new WalletError('LOCKED');
      if (state.unlinkViewError) throw state.unlinkViewError;
      return { mode: 'confirm', reason: null, nodeId: NODE_ID, platform: 'android', linkedSince: 1_790_035_200, ...(state.unlinkView ?? {}) };
    },
    unlinkForSite: async () => {
      log.unlinks += 1;
      if (!state.unlocked) throw new WalletError('LOCKED');
      if (state.unlinkError) throw state.unlinkError;
      return state.unlinkOutcome ?? { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, unbound: true };
    },
  };

  world.provider = createProviderService({
    chrome,
    session,
    vault,
    keys,
    qnet,
    activation,
    nodes,
    emit: (origin, event, data) => world.router.emitProviderEvent(origin, event, data),
    notifyViews: (event) => log.views.push(event),
    now: options.now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  world.router = createRouter({
    runtime: chrome.runtime,
    handlers: {
      'approval.get': world.provider.getApproval,
      'approval.resolve': world.provider.resolveApproval,
      'sites.list': world.provider.listSites,
      'sites.revoke': world.provider.revokeSite,
      'vault.unlock': async ({ password }) => {
        log.unlockAttempts.push(password);
        if (password !== PASSWORD) throw new WalletError('BAD_PASSWORD');
        state.unlocked = true;
        return { qnet: ACCOUNTS.qnet, solana: ACCOUNTS.solana, lockDeadline: Date.now() + 900_000 };
      },
      'wallet.addresses': async () => ({ ...ACCOUNTS }),
      'activation.registration': async () => ({ registration: state.registration }),
    },
    requireUnlocked: session.requireUnlocked,
    touch: async () => {},
    providerRequest: world.provider.handleRequest,
    providerPortClosed: world.provider.onPortClosed,
  });

  /** A relay port of `url`'s page, accepted (or refused) by the router. */
  world.connect = (url, sender) => {
    const port = createPort({ sender: sender ?? contentScriptSender(url) });
    world.router.handleProviderConnect(port);
    return port;
  };

  /** The sender Chrome reports for ui/approve.html?id=<id> in window `windowId`. */
  world.approveSender = (windowId, id) => {
    const sender = pageSender(chrome.runtime, 'approve', { query: `?id=${id}` });
    return { ...sender, tab: { ...sender.tab, id: 9000 + windowId, windowId } };
  };

  world.ui = (sender, type, params) => world.router.handleUiMessage({ type, id: 'ui-1', params }, sender);
  world.popup = (type, params) => world.ui(pageSender(chrome.runtime, 'popup'), type, params);

  /**
   * Waits until an approval window is shown (other than `after`) and returns what its page would know.
   * @param {{after?: number}} [options]
   */
  world.shown = async ({ after = null } = {}) => {
    const current = () => world.provider.snapshot().windowId;
    await until(() => current() !== null && current() !== after && openWindows.has(current()));
    const windowId = current();
    const { url } = log.windows.find((w) => w.id === windowId);
    const id = new URL(url).searchParams.get('id');
    const sender = world.approveSender(windowId, id);
    // the revision of the view this page last drew (ApprovalView.revision): a confirm names it
    let revision = null;
    const get = async () => {
      const reply = await world.ui(sender, 'approval.get', { id });
      if (reply.ok) revision = reply.result.revision;
      return reply;
    };
    return {
      windowId,
      id,
      url,
      sender,
      get,
      get revision() {
        return revision;
      },
      /**
       * approval.resolve as the page sends it. A confirm names the revision of the view last drawn; a page
       * confirms only what it drew, so a view is read first when none was (as the real page does on load).
       * @param {boolean} approved
       * @param {{revision?: number|null, password?: string}} [options] revision: the one to send instead (null: none);
       *   password: sent along, as no page does (every approval refuses it)
       */
      resolve: async (approved, options = {}) => {
        if (approved && revision === null && !Object.hasOwn(options, 'revision')) await get();
        const sent = Object.hasOwn(options, 'revision') ? options.revision : revision;
        const params = { id, approved };
        if (options.password !== undefined) params.password = options.password;
        if (approved && sent !== null) params.revision = sent;
        return world.ui(sender, 'approval.resolve', params);
      },
    };
  };

  /** The user closes an approval window. */
  world.userCloses = (windowId) => {
    openWindows.delete(windowId);
    return world.provider.onWindowRemoved(windowId);
  };

  /** Runs the live timers armed with `ms`. */
  world.fireTimers = (ms) => {
    for (const timer of timers.filter((t) => !t.cleared && t.ms === ms)) {
      timer.cleared = true;
      timer.fn();
    }
  };

  /** Stores valid grants the way provider.js writes them. */
  world.grant = async (...origins) => {
    const stored = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY] ?? {};
    for (const origin of origins) stored[origin] = grantEntry(origin, { sitesKey: state.sitesKey });
    await chrome.storage.local.set({ [SITES_KEY]: stored });
  };

  world.storedSites = async () => (await chrome.storage.local.get(SITES_KEY))[SITES_KEY];

  return world;
}

/**
 * A relay-side port joined to a worker-side port the router accepts, as Chrome joins the two ends of
 * runtime.connect. Messages cross as JSON, asynchronously.
 */
export function joinedPorts(world, url) {
  const sender = contentScriptSender(url);
  const relaySide = {
    name: 'qnet-provider',
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    connected: true,
    postMessage(message) {
      if (!relaySide.connected) throw new Error('Attempting to use a disconnected port object');
      const copy = JSON.parse(JSON.stringify(message));
      setImmediate(() => workerSide.onMessage.dispatch(copy, workerSide));
    },
    disconnect() {
      relaySide.connected = false;
      workerSide.connected = false;
      setImmediate(() => workerSide.onDisconnect.dispatch(workerSide));
    },
  };
  const workerSide = {
    name: 'qnet-provider',
    sender,
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    connected: true,
    posted: [],
    postMessage(message) {
      if (!workerSide.connected) throw new Error('Attempting to use a disconnected port object');
      const copy = JSON.parse(JSON.stringify(message));
      workerSide.posted.push(copy);
      setImmediate(() => relaySide.onMessage.dispatch(copy, relaySide));
    },
    disconnect() {
      workerSide.connected = false;
      relaySide.connected = false;
      setImmediate(() => relaySide.onDisconnect.dispatch(relaySide));
    },
    /** The worker ends (restart): both sides see the disconnect. */
    crash() {
      workerSide.disconnect();
      setImmediate(() => workerSide.onDisconnect.dispatch(workerSide));
    },
  };
  world.router.handleProviderConnect(workerSide);
  return { relaySide, workerSide };
}
