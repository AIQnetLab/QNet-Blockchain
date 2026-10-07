// The whole extension in one process: the real worker (sw.js with every module, the cheap-KDF hook of
// vault-session-env.mjs), the real pages on the fake DOM, and a scripted network that checks what the
// wallet sends (ML-DSA-65 transfer signatures, Ed25519 Solana signatures, the burn instructions) and
// answers like the nodes, the explorer archive, aiqnet.io's burn record (decision 35) and the Solana RPC do. The nodes
// serve the wallet's account from a state their committee certifies (certified-net.mjs). Nothing reaches the real network.
import { readFile } from 'node:fs/promises';
import { createCabinet } from './cabinet-server.mjs';
import { certifiedNet } from './certified-net.mjs';
import { EXTENSION_ID, createChrome, pageSender } from './chrome-mock.mjs';
import { FakeEvent, installDom } from './ui-dom.mjs';

const DIST = new URL('../../dist/', import.meta.url);
const BASE = `chrome-extension://${EXTENSION_ID}`;

export const MANIFEST = JSON.parse(await readFile(new URL('manifest.json', DIST), 'utf8'));

/** Lets pending promise chains, immediates and IndexedDB mock callbacks run. */
export async function turns(count = 5) {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------- browser

/**
 * chrome.* shared by the worker and the page on show: runtime messages cross between them as Chrome
 * delivers them (never to the sender's own context), windows and tabs are recorded.
 * @param {{VIEW_EVENT_CHANNEL: string}} config
 */
export function createBrowser(config) {
  const chrome = createChrome({ manifest: MANIFEST });
  const { runtime } = chrome;
  const workerSender = Object.freeze({ id: runtime.id, url: runtime.getURL('background/sw.js'), origin: BASE });
  const owners = new Map();
  const browser = {
    chrome,
    view: null,
    windows: [],
    openWindows: new Set(),
    tabsCreated: [],
    tabsRemoved: [],
    inflight: 0,
  };
  const owner = () => browser.view?.name ?? 'worker';
  const deliver = (from, message, sender, sendResponse) => {
    for (const [listener, context] of [...owners]) {
      if (context !== from) listener(message, sender, sendResponse);
    }
  };

  runtime.onMessage = {
    addListener: (fn) => owners.set(fn, owner()),
    removeListener: (fn) => owners.delete(fn),
    hasListener: (fn) => owners.has(fn),
    listenerCount: () => owners.size,
    dispatch: (message, sender, sendResponse) => deliver(null, message, sender, sendResponse),
  };
  browser.dropListenersOf = (context) => {
    for (const [listener, name] of [...owners]) if (name === context) owners.delete(listener);
  };

  runtime.sendMessage = (message) => {
    const copy = JSON.parse(JSON.stringify(message));
    if (browser.view === null || copy?.channel === config.VIEW_EVENT_CHANNEL) {
      runtime.sent.push(copy);
      setImmediate(() => deliver('worker', copy, workerSender, () => {}));
      return Promise.resolve();
    }
    const { name, sender } = browser.view;
    browser.inflight += 1;
    return new Promise((resolve) => {
      let answered = false;
      deliver(name, copy, sender, (response) => {
        if (answered) return;
        answered = true;
        resolve(JSON.parse(JSON.stringify(response)));
      });
    }).finally(() => {
      browser.inflight -= 1;
    });
  };

  let nextWindowId = 500;
  chrome.windows.create = async (createData) => {
    const id = nextWindowId;
    nextWindowId += 1;
    browser.openWindows.add(id);
    browser.windows.push({ id, ...createData });
    return { id, type: createData.type };
  };
  // Chrome fires windows.onRemoved for a window the extension closes too.
  chrome.windows.remove = async (windowId) => {
    if (!browser.openWindows.delete(windowId)) throw new Error(`No window with id: ${windowId}.`);
    setImmediate(() => chrome.windows.onRemoved.dispatch(windowId));
  };
  chrome.tabs = {
    create: async (props) => {
      browser.tabsCreated.push(props);
      return { id: 301 };
    },
    getCurrent: async () => ({ id: 77 }),
    remove: async (tabId) => {
      browser.tabsRemoved.push(tabId);
    },
  };

  /** The sender Chrome reports for the approval window `windowId` showing approval `id`. */
  browser.approveSender = (windowId, id) => {
    const sender = pageSender(runtime, 'approve', { query: `?id=${id}` });
    return { ...sender, tab: { ...sender.tab, id: 9000 + windowId, windowId } };
  };

  /** A UI request as page `page` (with `sender`), answered by the real router. */
  browser.ask = (sender, type, params) => new Promise((resolve) => {
    deliver('test', { type, id: 't1', params }, sender, resolve);
  });

  return browser;
}

/**
 * Loads ui/<page>.js on a fresh fake DOM as the page on show. Requests go to the real worker.
 * @param {ReturnType<typeof createBrowser>} browser
 * @param {'popup'|'setup'} page
 */
let loadSeq = 0;
export async function openView(browser, page) {
  const dom = installDom();
  const name = `${page}#${(loadSeq += 1)}`;
  browser.view = { name, sender: pageSender(browser.chrome.runtime, page) };
  const handle = {
    ...dom,
    async settle() {
      let quiet = 0;
      for (let turn = 0; turn < 5000 && quiet < 6; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        quiet = browser.inflight === 0 ? quiet + 1 : 0;
      }
    },
    $: (selector) => dom.document.querySelector(selector),
    $$: (selector) => dom.document.querySelectorAll(selector),
    text: () => dom.app.textContent,
    async click(selector) {
      await handle.until(() => dom.document.querySelector(selector) !== null, selector, 10000);
      const node = dom.document.querySelector(selector);
      node.click();
      await handle.settle();
      return node;
    },
    /** Waits until `predicate()` holds, settling in between (for work that outlives one request). */
    async until(predicate, what, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${dom.app.textContent.slice(0, 600)}`);
        await handle.settle();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    close() {
      dom.window.dispatchEvent(new FakeEvent('pagehide'));
      browser.dropListenersOf(name);
      if (browser.view?.name === name) browser.view = null;
      dom.uninstall();
    },
  };
  await import(new URL(`ui/${page}.js?integration=${loadSeq}`, DIST).href);
  await handle.settle();
  return handle;
}

// ---------------------------------------------------------------- network

const u64le = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
const json = (value) => ({ status: 200, body: JSON.stringify(value) });

// A legacy wire transaction, decoded (every compact-u16 here is below 128).
function decodeWire(core, wire) {
  let i = 0;
  const count = wire[i++];
  const signatures = [];
  for (let k = 0; k < count; k += 1, i += 64) signatures.push(wire.slice(i, i + 64));
  const message = wire.slice(i);
  let j = 3;
  const header = [...message.slice(0, 3)];
  const keyCount = message[j++];
  const keys = [];
  for (let k = 0; k < keyCount; k += 1, j += 32) keys.push(core.base58Encode(message.slice(j, j + 32)));
  const blockhash = core.base58Encode(message.slice(j, j + 32));
  j += 32;
  const instructions = [];
  const ixCount = message[j++];
  for (let k = 0; k < ixCount; k += 1) {
    const program = keys[message[j++]];
    const accountCount = message[j++];
    const accounts = [...message.slice(j, j + accountCount)].map((index) => keys[index]);
    j += accountCount;
    const dataLength = message[j++];
    instructions.push({ program, accounts, data: message.slice(j, j + dataLength) });
    j += dataLength;
  }
  if (j !== message.length) throw new Error('trailing bytes in the message');
  return { signatures, message, header, keys, blockhash, instructions };
}

/**
 * The nodes, the explorer archive and the Solana RPC for one wallet.
 * @param {object} core the qnet-core bundle
 * @param {{QNET: object, SOLANA: object}} config
 * @param {{qnet: string, solana: string}} wallet
 * @param {{qnet: string}} peer another wallet's addresses (history counterparty)
 */
export function createNetwork(core, config, wallet, peer) {
  const { QNET, SOLANA } = config;
  const { TOKEN, MEMO, SYSTEM } = core.SOLANA_PROGRAMS;
  const ata = core.associatedTokenAddress(wallet.solana, SOLANA.ONE_DEV_MINT);
  const blockhash = core.base58Encode(core.sha256(core.utf8Encode('integration blockhash')));
  const net = {
    requests: [],
    qnc: { balance: 5_000_000_000n, nonce: 3n },
    transfers: [],
    // GET /api/v1/token/{address} answers by address (else no contract), and the contract calls POSTed
    contracts: {},
    calls: [],
    lamports: 2_000_000_000n,
    oneDevRaw: 3_000_000_000n,
    price: { light: 1500, super: 3000 },
    solanaTxs: [],
    verifyActivationWallets: [],
    // the light node's registration: the submits as the node checked them, the answers still to give (then success),
    // and whether the chain lists the node
    registrations: [],
    registration: { answers: [], onchain: false },
    history: [{
      source: 'tx', hash: 'a1'.repeat(32), from: peer.qnet, to: wallet.qnet, amount: 2_000_000_000, fee: 150000,
      timestamp: 1_750_000_000_000,
    }],
  };
  // The certified state of the wallet's account, as net.qnc starts: the light client verifies its macroblock under the
  // committee's real signature, and a send is decided by it. GET /api/v1/account follows net.qnc: the chain's nonce now,
  // which only tells the wallet's own transactions taken from those still pending.
  net.certified = certifiedNet({ accounts: { [wallet.qnet]: { balance: String(net.qnc.balance), nonce: String(net.qnc.nonce) } } }).install();
  // aiqnet.io's record of the wallet's burns: a burn that landed here is final there
  net.cabinet = createCabinet({ landed: (burnTx) => (net.solanaTxs.some((tx) => tx.signature === burnTx) ? 'final' : 'unknown') });

  function jsonParsedOf(tx) {
    const { decoded } = tx;
    const [signers, readonlySigners, readonlyUnsigned] = decoded.header;
    const accountKeys = decoded.keys.map((pubkey, index) => ({
      pubkey,
      signer: index < signers,
      writable: index < signers ? index < signers - readonlySigners : index < decoded.keys.length - readonlyUnsigned,
      source: 'transaction',
    }));
    const instructions = decoded.instructions.map(({ program, accounts, data }) => {
      if (program === TOKEN && data[0] === 8) {
        return {
          program: 'spl-token', programId: TOKEN, stackHeight: null,
          parsed: { type: 'burn', info: { account: accounts[0], mint: accounts[1], authority: accounts[2], amount: String(u64le(data.slice(1))) } },
        };
      }
      if (program === MEMO) return { program: 'spl-memo', programId: MEMO, stackHeight: null, parsed: new TextDecoder().decode(data) };
      return { programId: program, accounts, data: core.base58Encode(data), stackHeight: null };
    });
    return {
      slot: tx.slot,
      blockTime: tx.blockTime,
      meta: { err: null, fee: 5000, innerInstructions: [], logMessages: [] },
      transaction: { signatures: [tx.signature], message: { accountKeys, instructions, recentBlockhash: decoded.blockhash } },
      version: 'legacy',
    };
  }

  // Applies a transaction the wallet sent: it lands at once and finalizes.
  function land(decoded) {
    const signature = core.base58Encode(decoded.signatures[0]);
    const memo = decoded.instructions.find((ix) => ix.program === MEMO);
    for (const { program, data } of decoded.instructions) {
      if (program === TOKEN && data[0] === 8) net.oneDevRaw -= u64le(data.slice(1));
      if (program === SYSTEM && data[0] === 2) net.lamports -= u64le(data.slice(4));
    }
    net.lamports -= 5000n;
    const text = memo ? new TextDecoder().decode(memo.data) : null;
    const tx = {
      signature, decoded, slot: 1000 + net.solanaTxs.length, blockTime: 1_750_000_000 + net.solanaTxs.length,
      memo: text === null ? null : `[${text.length}] ${text}`,
    };
    net.solanaTxs.push(tx);
    return signature;
  }

  function verifiedWire(base64) {
    const decoded = decodeWire(core, core.base64Decode(base64));
    if (decoded.keys[0] !== wallet.solana || decoded.blockhash !== blockhash) throw new Error('foreign payer or blockhash');
    if (!core.verifySolanaSignature(decoded.signatures[0], decoded.message, core.solanaAddressToBytes(wallet.solana))) {
      throw new Error('bad Solana signature');
    }
    return decoded;
  }

  const context = { slot: 2000 };
  const rpcMethods = {
    getBalance: ([address]) => ({ context, value: address === wallet.solana ? Number(net.lamports) : 0 }),
    getTokenSupply: () => ({ context, value: { amount: '1000000000000000', decimals: 6, uiAmount: 1e9, uiAmountString: '1000000000' } }),
    getAccountInfo: ([address]) => {
      if (address !== ata) return { context, value: null };
      return {
        context,
        value: {
          owner: TOKEN, lamports: 2039280, executable: false, rentEpoch: 0, space: 165,
          data: {
            program: 'spl-token', space: 165,
            parsed: {
              type: 'account',
              info: {
                mint: SOLANA.ONE_DEV_MINT, owner: wallet.solana, state: 'initialized', isNative: false,
                tokenAmount: { amount: String(net.oneDevRaw), decimals: 6, uiAmountString: String(net.oneDevRaw / 1_000_000n) },
              },
            },
          },
        },
      };
    },
    getLatestBlockhash: () => ({ context, value: { blockhash, lastValidBlockHeight: 5000 } }),
    getFeeForMessage: () => ({ context, value: 5000 }),
    getMinimumBalanceForRentExemption: () => 2039280,
    simulateTransaction: ([wire]) => {
      verifiedWire(wire);
      return { context, value: { err: null, logs: [], accounts: null, unitsConsumed: 3000 } };
    },
    sendTransaction: ([wire]) => land(verifiedWire(wire)),
    getSignatureStatuses: ([[signature]]) => {
      const tx = net.solanaTxs.find((t) => t.signature === signature);
      return { context, value: [tx ? { slot: tx.slot, confirmations: null, err: null, confirmationStatus: 'finalized' } : null] };
    },
    // the history of the wallet's 1DEV account, newest first (before and until exclusive, limit)
    getSignaturesForAddress: ([address, query]) => {
      if (address !== ata) return [];
      const entries = [...net.solanaTxs].reverse().map((tx) => ({
        signature: tx.signature, slot: tx.slot, err: null, memo: tx.memo, blockTime: tx.blockTime, confirmationStatus: 'finalized',
      }));
      let start = query?.before ? entries.findIndex((e) => e.signature === query.before) + 1 : 0;
      const stop = query?.until ? entries.findIndex((e) => e.signature === query.until) : -1;
      const end = stop >= 0 ? stop : entries.length;
      start = Math.min(start, end);
      return entries.slice(start, Math.min(end, start + (query?.limit ?? 1000)));
    },
    getTransaction: ([signature]) => {
      const tx = net.solanaTxs.find((t) => t.signature === signature);
      return tx ? jsonParsedOf(tx) : null;
    },
    // the wallet holds one 1DEV account, its associated one (the burn guard lists the others: R4-ESA-01)
    getTokenAccountsByOwner: ([owner, filter]) => {
      if (owner !== wallet.solana || (filter.mint !== undefined && filter.mint !== SOLANA.ONE_DEV_MINT)
        || (filter.programId !== undefined && filter.programId !== TOKEN)) return { context, value: [] };
      return {
        context,
        value: [{
          pubkey: ata,
          account: {
            owner: TOKEN, lamports: 2039280, executable: false, rentEpoch: 0, space: 165,
            data: {
              program: 'spl-token', space: 165,
              parsed: {
                type: 'account',
                info: {
                  mint: SOLANA.ONE_DEV_MINT, owner: wallet.solana, state: 'initialized', isNative: false,
                  tokenAmount: { amount: String(net.oneDevRaw), decimals: 6, uiAmountString: String(net.oneDevRaw / 1_000_000n) },
                },
              },
            },
          },
        }],
      };
    },
  };

  async function nodeAnswer(url, init) {
    const { pathname, searchParams } = url;
    if (pathname === `/api/v1/account/${wallet.qnet}`) {
      return {
        status: 200,
        body: `{"address":"${wallet.qnet}","balance":${net.qnc.balance},"nonce":${net.qnc.nonce},"has_dilithium_pk":true}`,
      };
    }
    if (pathname === '/api/v1/transaction' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const fields = {
        from: body.from, to: body.to, amountNano: String(body.amount), nonce: String(body.nonce),
        gasPrice: String(body.gas_price), gasLimit: String(body.gas_limit),
      };
      const valid = core.verifyTransferSignature(fields, core.hexToBytes(body.dilithium_signature), core.hexToBytes(body.dilithium_public_key));
      net.transfers.push({ body: init.body, fields, keys: Object.keys(body), valid });
      if (!valid) return { status: 400, body: '{"success":false,"error":"invalid signature"}' };
      return json({ success: true, tx_hash: core.sha3_256Hex(core.utf8Encode(init.body)) });
    }
    // a contract call as the node checks it: the calldata it rebuilds from the body (serde_json sorts the keys), the
    // preimage over its SHA3-256 with the gas, and the ML-DSA-65 signature under the key of `from`
    if (pathname === '/api/v1/contract/call' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const callData = JSON.stringify({ args: body.args, contract: body.contract_address, method: body.method });
      const preimage = `q1337|contract_call:${body.from}:${core.sha3_256Hex(core.utf8Encode(callData))}:${body.nonce}:${body.gas_price}:${body.gas_limit}`;
      const valid = core.qnetAddressFromPublicKey(core.hexToBytes(body.dilithium_public_key)) === body.from
        && await core.verifyConsensusSignature(preimage, body.dilithium_signature, body.dilithium_public_key);
      net.calls.push({ body: init.body, fields: body, keys: Object.keys(body), callData, preimage, valid });
      if (!valid) return { status: 400, body: '{"success":false,"error":"invalid signature"}' };
      return json({ success: true, tx_hash: core.sha3_256Hex(core.utf8Encode(init.body)), message: 'Contract call submitted to mempool' });
    }
    const token = /^\/api\/v1\/token\/([0-9a-z]+)$/.exec(pathname);
    if (token) return json(net.contracts[token[1]] ?? { success: false, error: 'Token not found', contract_address: token[1] });
    if (pathname === '/api/v1/activation/price') {
      const type = searchParams.get('type');
      return { status: 200, body: `{"node_type":"${type}","phase":1,"cost":${net.price[type]},"currency":"1DEV"}` };
    }
    if (pathname === '/api/v1/light-node/status') {
      return json({ success: true, node_id: searchParams.get('node_id'), onchain_registered: net.registration.onchain });
    }
    // a registration as registration_api.rs admits it: the wallet's pseudonym and the burn's proof, the owner bind under
    // burn_wallet, the wallet derived from the ML-DSA-65 key, the consent under it (empty context), a fresh timestamp
    if (pathname === '/api/v1/node-registration/submit' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      let valid = false;
      try {
        const ownerBind = core.ownerBindPreimage(body.node_id, body.wallet_address, body.registration_proof, body.timestamp,
          body.dilithium_public_key, body.burn_tx_hash);
        valid = body.node_id === core.lightNodeId(body.wallet_address)
          && body.registration_proof === core.registrationProof(body.burn_tx_hash, body.node_id, body.wallet_address)
          && core.qnetAddressFromPublicKey(core.hexToBytes(body.dilithium_public_key)) === body.wallet_address
          && core.verifySolanaSignature(core.hexToBytes(body.owner_signature), core.utf8Encode(ownerBind), core.solanaAddressToBytes(body.burn_wallet))
          && await core.verifyConsensusSignature(core.consentPreimage(body.node_id, body.wallet_address, body.registration_proof, body.timestamp),
            body.dilithium_signature, body.dilithium_public_key)
          && Math.abs(body.timestamp - Math.floor(Date.now() / 1000)) <= 300;
      } catch {
        valid = false;
      }
      net.registrations.push({ body, keys: Object.keys(body), valid });
      if (!valid) return json({ success: false, error: 'ML-DSA-65 signature verification failed' });
      return json(net.registration.answers.shift() ?? { success: true, tx_hash: 'fe'.repeat(32), node_id: body.node_id });
    }
    if (pathname === '/api/v1/verify-activation') {
      net.verifyActivationWallets.push(init.headers?.['x-qnet-wallet'] ?? null);
      return json({ verified: false, authoritative: true });
    }
    // the applied history every node lists alike: the archive rows (History calls a row confirmed on it: R4-EXTQ-04)
    if (pathname === '/api/v1/transactions/history' && searchParams.get('address') === wallet.qnet) {
      const sent = searchParams.get('direction') === 'sent';
      const rows = net.history.filter((row) => !sent || row.from === wallet.qnet).map((row) => ({
        hash: row.hash, from: row.from, to: row.to, amount: row.amount, timestamp: row.timestamp, nonce: 1, type: 'transfer',
        direction: row.from === wallet.qnet ? 'sent' : 'received',
      }));
      return json({ success: true, address: wallet.qnet, transactions: rows });
    }
    // the certified state: proofs, the certified head, macroblocks and registry snapshots
    const certified = net.certified.answer(url.origin, pathname, searchParams, { method: init.method ?? 'GET' });
    if (certified !== undefined) return { status: certified.status, body: await certified.text() };
    return null;
  }

  net.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    net.requests.push(`${init.method ?? 'GET'} ${url.href}`);
    let answer = null;
    if (url.protocol !== 'https:') throw new TypeError(`cleartext request ${url.href}`);
    if (QNET.NODES.includes(url.origin)) answer = await nodeAnswer(url, init);
    else if (url.origin === QNET.EXPLORER_API && url.pathname === `/api/address/${wallet.qnet}/history`) {
      answer = json({ success: true, items: net.history, next_cursor: null });
    } else if (url.origin === QNET.EXPLORER_API && url.pathname.startsWith('/api/cabinet/activation/')) {
      const reply = await net.cabinet.route({ url: url.href, method: init.method ?? 'GET', body: init.body ?? null, init });
      answer = { status: reply.status ?? 200, body: JSON.stringify(reply.body) };
    } else if (SOLANA.RPC_URLS.includes(url.origin) && url.pathname === '/') {
      const { id, method, params } = JSON.parse(init.body);
      if (!Object.hasOwn(rpcMethods, method)) throw new TypeError(`unexpected Solana call ${method}`);
      answer = json({ jsonrpc: '2.0', id, result: rpcMethods[method](params) });
    }
    if (answer === null) throw new TypeError(`offline test: no route for ${init.method ?? 'GET'} ${url.href}`);
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
  };

  net.ata = ata;
  return net;
}

/**
 * globalThis.fetch for the whole process: extension files from dist/, everything else to `network`.
 * Requests count as in flight for the views' settle().
 * @param {{fetch: typeof fetch}} network
 * @param {{inflight: number}} browser
 */
export function installFetch(network, browser) {
  const saved = globalThis.fetch;
  const serve = async (input, init) => {
    const text = String(input);
    if (text.startsWith(`${BASE}/`)) {
      try {
        return new Response(await readFile(new URL(text.slice(BASE.length + 1), DIST), 'utf8'), { status: 200 });
      } catch {
        return new Response('', { status: 404 });
      }
    }
    return network.fetch(input, init);
  };
  globalThis.fetch = async (input, init) => {
    browser.inflight += 1;
    try {
      return await serve(input, init);
    } finally {
      browser.inflight -= 1;
    }
  };
  return () => {
    globalThis.fetch = saved;
  };
}
