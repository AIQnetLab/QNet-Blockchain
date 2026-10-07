// The extension end to end with every real module wired as sw.js wires it: setup page → vault → popup →
// QNet and Solana sends → Activate burn → dApp approvals → lock → delete. Only IndexedDB (in-memory),
// chrome.* and the network are stand-ins; the network verifies every signature the wallet produces. The
// wallet is the public recovery-phrase test vector; the counterparty is the second public vector.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contentScriptSender, createPort, pageSender, until } from './helpers/chrome-mock.mjs';
import { createIndexedDB } from './helpers/indexeddb-mock.mjs';
import { MANIFEST, createBrowser, createNetwork, installFetch, openView, turns } from './helpers/integration-world.mjs';
import { type } from './helpers/ui-dom.mjs';
import { KAT_MNEMONIC, PASSWORD, loadWorker } from './helpers/vault-session-env.mjs';

const PEER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SITE = 'https://aiqnet.io';
const MOBILE_BODY_ORDER = ['from', 'to', 'amount', 'dilithium_signature', 'gas_price', 'gas_limit', 'nonce', 'dilithium_public_key'];

const config = await import('../dist/background/config.js');
const browser = createBrowser(config);
globalThis.chrome = browser.chrome;
globalThis.indexedDB = createIndexedDB();
const { core, session } = await loadWorker();
const { STORAGE_KEYS, VAULT_DB } = config;

const WALLET = Object.freeze({ qnet: core.KAT.qnetAddress, solana: core.KAT.solanaAddress });
const peerSeed = core.mnemonicToSeed(PEER_MNEMONIC);
const PEER = Object.freeze({
  qnet: core.deriveQnetKeypair(peerSeed).address,
  solana: core.deriveSolanaKeypair(peerSeed).address,
});
core.zeroize(peerSeed);

const network = createNetwork(core, config, WALLET, PEER);
const POPUP_SENDER = pageSender(browser.chrome.runtime, 'popup');
let restoreFetch = null;
let popup = null;
let port = null;

before(async () => {
  restoreFetch = installFetch(network, browser);
  await import('../dist/background/sw.js');
  await turns(20);
});

// A failed step may leave approvals waiting on their timeout timers: close their windows and the page
// port, so the process can end.
after(async () => {
  popup?.close();
  if (port && !port.disconnected) port.close();
  for (let round = 0; round < 20 && browser.openWindows.size > 0; round += 1) {
    for (const windowId of [...browser.openWindows]) {
      browser.openWindows.delete(windowId);
      browser.chrome.windows.onRemoved.dispatch(windowId);
    }
    await turns(10);
  }
  restoreFetch?.();
});

const ask = (type, params) => browser.ask(POPUP_SENDER, type, params);

/** The approval window the provider opened after `count` earlier ones: its sender and id. */
async function approvalWindow(count) {
  await until(() => browser.windows.length > count && browser.openWindows.has(browser.windows[count].id), 10000);
  const { id: windowId, url } = browser.windows[count];
  const id = new URL(url, `chrome-extension://${browser.chrome.runtime.id}/`).searchParams.get('id');
  const sender = browser.approveSender(windowId, id);
  // a confirm names the revision of the view the page drew last (ApprovalView.revision)
  let revision = null;
  return {
    get: async () => {
      const reply = await browser.ask(sender, 'approval.get', { id });
      if (reply.ok) revision = reply.result.revision;
      return reply;
    },
    resolve: (approved) => browser.ask(sender, 'approval.resolve',
      approved && revision !== null ? { id, approved, revision } : { id, approved }),
  };
}

const replyTo = async (port, id) => {
  await until(() => port.posted.some((m) => m.id === id), 20000);
  return port.posted.find((m) => m.id === id);
};
const eventsOf = (port) => port.posted.filter((m) => Object.hasOwn(m, 'event'));

describe('integration: one wallet from setup to delete', () => {
  it('setup imports a pasted phrase in canonical form, writes the vault and closes its tab', async () => {
    const page = await openView(browser, 'setup');
    try {
      await page.click('[data-action="import"]');
      type(page.$('textarea[name="phrase"]'), `  ${KAT_MNEMONIC.toUpperCase().split(' ').join('\n')}  `);
      await page.click('[data-action="continue"]');
      type(page.$('input[name="new-password"]'), PASSWORD);
      type(page.$('input[name="confirm-password"]'), PASSWORD);
      await page.click('[data-action="submit"]');
      await page.until(() => /Your wallet is ready/.test(page.text()), 'the wallet');
      assert.ok(page.text().includes(WALLET.qnet) && page.text().includes(WALLET.solana), 'the KAT addresses');
    } finally {
      page.close();
    }
    const status = (await ask('vault.status')).result;
    assert.equal(status.exists, true);
    assert.equal(status.unlocked, true);
    assert.equal(status.signingEnabled, true);
    assert.deepEqual(status.addresses, WALLET);
    const stored = globalThis.indexedDB.dump(VAULT_DB.NAME).stores[VAULT_DB.STORE][VAULT_DB.KEY];
    assert.equal(stored.aad.qnetAddress, WALLET.qnet);
    assert.ok(!JSON.stringify(stored).includes('abandon'), 'the phrase is never stored in the clear');
  });

  it('the popup shows the QNet balance its committee certified, and the archive history', async () => {
    popup = await openView(browser, 'popup');
    await popup.until(() => popup.$('.token-amount') !== null, 'the balance');
    assert.equal(popup.$('.token-amount').textContent, '5 QNC');
    // the worker verifies the balance; the home screen shows the amount, no verification badge (owner, 28.09)
    assert.equal(popup.$('.badge'), null);
    await popup.click('[data-tab="history"]');
    await popup.until(() => popup.$('.history-in') !== null, 'the history row');
    assert.match(popup.$('.history-in').textContent, /\+2 QNC/);
    // every pinned node lists the archive row alike: Confirmed (R4-EXTQ-04), which its detail says; the row says a state
    // only while it is not confirmed (owner, 06.10)
    assert.equal(popup.$('.history-in .history-status'), null);
    await popup.click('.history-in [data-action="open-detail"]');
    assert.equal(popup.$('.history-detail .badge').textContent, 'Confirmed');
    await popup.click('.history-detail [data-action="back"]');
    assert.ok(network.requests.some((r) => r.includes('/api/v1/transactions/history')), 'checked against the nodes');
  });

  it('a QNC send is signed with ML-DSA-65 over the node preimage and sent in the mobile field order', async () => {
    await popup.click('[data-tab="send"]');
    type(popup.$('input[name="to"]'), PEER.qnet);
    type(popup.$('input[name="amount"]'), '1.25');
    await popup.click('[data-action="review"]');
    await popup.until(() => popup.$('[data-action="confirm-send"]') !== null, 'the review');
    assert.match(popup.text(), /0\.00015 QNC/);
    await popup.click('[data-action="confirm-send"]');
    await popup.until(() => network.transfers.length === 1 && popup.$('[data-action="done"]') !== null, 'the submit');
    assert.match(popup.text(), /Sent/);
    const [sent] = network.transfers;
    assert.equal(sent.valid, true, 'the node verifies the ML-DSA-65 signature');
    assert.deepEqual(sent.keys, MOBILE_BODY_ORDER);
    assert.deepEqual(sent.fields, {
      from: WALLET.qnet, to: PEER.qnet, amountNano: '1250000000', nonce: '4', gasPrice: '10', gasLimit: '10000',
    });
    const history = (await ask('qnet.history', { limit: 10 })).result;
    assert.equal(history.pending.length, 1);
    assert.equal(history.pending[0].status, 'pending');
  });

  it('Solana: the balances of the cluster, and a SOL send signed with the hardened-derivation key', async () => {
    await popup.click('.network-switch [data-value="solana"]');
    await popup.click('[data-tab="assets"]');
    await popup.until(() => popup.$$('.token-amount').length === 2, 'the Solana balances');
    assert.deepEqual(popup.$$('.token-amount').map((n) => n.textContent), ['2 SOL', '3000 1DEV']);
    await popup.click('[data-tab="send"]');
    type(popup.$('input[name="to"]'), PEER.solana);
    type(popup.$('input[name="amount"]'), '0.5');
    await popup.click('[data-action="review"]');
    await popup.until(() => popup.$('[data-action="confirm-send"]') !== null, 'the review');
    // Send arms after TIMINGS.CONFIRM_ARM_VALUE_MS (a value move), no password
    assert.equal(popup.$('[data-action="confirm-send"]').disabled, true);
    await popup.until(() => popup.$('[data-action="confirm-send"]').disabled === false, 'the armed Send');
    await popup.click('[data-action="confirm-send"]');
    await popup.until(() => network.solanaTxs.length === 1 && popup.$('[data-action="explorer"]') !== null, 'the send');
    assert.match(popup.text(), /Confirmed/, 'the cluster finalized it at once');
    const [tx] = network.solanaTxs[0].decoded.instructions;
    assert.equal(tx.program, core.SOLANA_PROGRAMS.SYSTEM);
    assert.deepEqual(tx.accounts, [WALLET.solana, PEER.solana]);
    assert.equal(network.lamports, 2_000_000_000n - 500_000_000n - 5000n);
  });

  it('Activate: Light burns the node price once and the code, in Settings, is the one the node derives from the burn', async () => {
    await popup.click('[data-tab="activate"]');
    await popup.until(() => popup.$('[data-action="choose-light"]') !== null, 'the price cards');
    assert.match(popup.text(), /1500 1DEV/);
    // the node's first two answers to the registration are retries; then it admits it
    network.registration.answers.push({ success: false, error: 'burn-attestation quorum not yet reached; retry shortly' },
      { success: false, error: 'node is behind the chain; retry shortly' });
    await popup.click('[data-action="choose-light"]');
    // no password: the unlocked session and the acknowledged press (decision 33)
    assert.equal(popup.$('input[name="password"]'), null);
    popup.$('input[name="acknowledge"]').click();
    await popup.click('[data-action="burn"]');
    // the tab after the burn: the line to aiqnet.io/node (owner, 06.10: the code is in Settings)
    await popup.until(() => popup.$('.tab-body .inline-link') !== null, 'the tab after the burn');

    assert.equal(network.solanaTxs.length, 2);
    const burn = network.solanaTxs[1];
    const [burnIx, memoIx] = burn.decoded.instructions;
    assert.equal(burnIx.program, core.SOLANA_PROGRAMS.TOKEN);
    assert.equal(burnIx.data[0], 8, 'SPL Burn, not BurnChecked');
    assert.deepEqual(burnIx.accounts, [network.ata, config.SOLANA.ONE_DEV_MINT, WALLET.solana]);
    assert.equal(new DataView(burnIx.data.buffer, burnIx.data.byteOffset + 1, 8).getBigUint64(0, true), 1_500_000_000n);
    assert.equal(memoIx.program, core.SOLANA_PROGRAMS.MEMO);
    assert.deepEqual(memoIx.accounts, [WALLET.solana]);
    assert.equal(new TextDecoder().decode(memoIx.data), 'QNET_NODE_TYPE:LIGHT');
    assert.equal(network.oneDevRaw, 1_500_000_000n);
    assert.deepEqual([...new Set(network.verifyActivationWallets)], [WALLET.qnet]);
    // decision 35: aiqnet.io's record said "none" before anything was signed; the burn went out under its reservation,
    // announced with the wallet's proof, and is recorded there once final
    const routes = network.cabinet.requests.map((request) => request.route);
    assert.ok(routes.indexOf('reserve') > routes.indexOf('get') && routes.indexOf('announce') > routes.indexOf('reserve'), routes.join());
    assert.equal(network.cabinet.of('announce')[0].body.burnTx, burn.signature);
    for (const request of network.cabinet.requests) assert.equal(request.init.credentials, 'omit');
    await until(() => network.cabinet.rows.get(WALLET.qnet)?.state === 'recorded', 20000);
    assert.equal(network.cabinet.rows.get(WALLET.qnet).burnTx, burn.signature);
    assert.equal(network.cabinet.of('release').length, 0, 'a reservation a burn was sent under is never given back');

    const code = core.generateActivationCode('light', WALLET.solana, burn.signature, 1500);
    assert.ok(!popup.text().includes(code), 'not on the Activate tab');
    assert.equal(popup.$('.tab-body .code-box'), null);
    // Settings: the code masked, shown on one press
    await popup.click('[data-tab="settings"]');
    await popup.until(() => popup.$('[data-action="show-code"]') !== null, 'the code row');
    assert.ok(!popup.text().includes(code), 'masked until Show');
    await popup.click('[data-action="show-code"]');
    await popup.until(() => popup.$('.code-box')?.textContent === code, 'the code shown');

    const status = (await ask('activation.status')).result;
    assert.equal(status.activation.nodeType, 'light');
    assert.equal(status.activation.burnTx, burn.signature);
    assert.equal(status.pending, null);
    const again = await ask('activation.burn', { nodeType: 'super', expectedPrice: 3000 });
    assert.equal(again.error.code, 'ALREADY_ACTIVATED', 'one code per wallet');
    const recovered = (await ask('activation.recover')).result;
    assert.deepEqual(recovered, { found: true, complete: true, activation: status.activation });
    assert.deepEqual((await ask('activation.copy')).result, { code });
    assert.equal(network.solanaTxs.length, 2, 'nothing else was burned');
  });

  it('Activate: the Light burn records its node on the QNet network: retried, admitted, then listed', async () => {
    const burnTx = network.solanaTxs[1].signature;
    // the worker started it right after the burn
    await until(() => network.registrations.length >= 1, 20000);
    let registration = (await ask('activation.registration')).result.registration;
    assert.deepEqual([registration.state, registration.attempts, registration.lastError], ['queued', 1, 'quorum_pending']);
    assert.equal(registration.nodeId, core.lightNodeId(WALLET.qnet));
    registration = (await ask('activation.register')).result.registration;
    assert.deepEqual([registration.state, registration.attempts, registration.lastError], ['queued', 2, 'behind_chain']);
    registration = (await ask('activation.register')).result.registration;
    assert.deepEqual([registration.state, registration.attempts, registration.txHash], ['admitted', 3, 'fe'.repeat(32)]);
    assert.equal(network.registrations.length, 3);
    for (const submit of network.registrations) {
      assert.equal(submit.valid, true, 'the node admits what the wallet signed');
      assert.deepEqual(submit.keys, ['from', 'node_id', 'node_type', 'wallet_address', 'registration_proof', 'timestamp',
        'burn_tx_hash', 'burn_amount', 'burn_wallet', 'dilithium_signature', 'dilithium_public_key', 'owner_signature']);
      assert.deepEqual([submit.body.burn_tx_hash, submit.body.burn_amount, submit.body.burn_wallet, submit.body.wallet_address],
        [burnTx, 1500, WALLET.solana, WALLET.qnet]);
    }
    // the chain lists it: recorded, with no other submit, and the popup says so
    network.registration.onchain = true;
    registration = (await ask('activation.register')).result.registration;
    assert.equal(registration.state, 'onchain');
    assert.equal(network.registrations.length, 3);
    assert.equal((await ask('activation.status')).result.registration.state, 'onchain');
    await popup.click('[data-tab="activate"]');
    await popup.until(() => /Recorded on the QNet network for this wallet/.test(popup.text()), 'the record');
    assert.equal(popup.$('[data-action="record"]'), null);
  });

  it('a dApp on aiqnet.io connects, signs a domain-separated message and sends QNC through approvals', async () => {
    port = createPort({ sender: contentScriptSender(`${SITE}/wallet`) });
    browser.chrome.runtime.onConnect.dispatch(port);
    assert.equal(port.disconnected, false);

    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const connect = await approvalWindow(0);
    const view = (await connect.get()).result;
    assert.equal(view.kind, 'connect');
    assert.equal(view.origin, SITE);
    assert.equal(view.locked, false);
    assert.deepEqual((await connect.resolve(true)).result, { resolved: true });
    assert.deepEqual((await replyTo(port, 'c')).result, WALLET);

    const message = 'Sign in to aiqnet.io';
    port.send({ id: 's', method: 'qnet_signMessage', params: { message } });
    const sign = await approvalWindow(1);
    assert.deepEqual((await sign.get()).result.details, { message, byteLength: message.length });
    await sign.resolve(true);
    const signed = (await replyTo(port, 's')).result;
    assert.equal(signed.address, WALLET.qnet);
    assert.equal(core.verifyOffchainMessage(SITE, message, core.hexToBytes(signed.signature), core.hexToBytes(signed.publicKey)), true);
    assert.equal(core.verifyTransferSignature(network.transfers[0].fields, core.hexToBytes(signed.signature), core.hexToBytes(signed.publicKey)),
      false, 'a message signature never verifies as a transfer');

    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: PEER.qnet, amount: '0.5' } });
    const send = await approvalWindow(2);
    const details = (await send.get()).result.details;
    assert.equal(details.nonce, '5', 'after the pending nonce 4');
    assert.equal(details.amountNano, '500000000');
    // the node admits only the committed nonce + 1: behind the popup's transfer at nonce 4, the site's waits
    assert.equal(details.inFlight, true);
    assert.equal((await send.resolve(true)).error.code, 'NONCE_CHANGED');
    assert.equal(network.transfers.length, 1, 'nothing signed or sent');
    // the transfer at nonce 4 is in a block: the next view is the one to confirm
    network.qnc.nonce = 4n;
    network.qnc.balance -= 150000n;
    const ready = (await send.get()).result.details;
    assert.deepEqual([ready.nonce, ready.inFlight], ['5', false]);
    await send.resolve(true);
    const sent = (await replyTo(port, 't')).result;
    assert.equal(sent.status, 'submitted');
    assert.equal(network.transfers.length, 2);
    assert.equal(network.transfers[1].valid, true);
    assert.equal(network.transfers[1].fields.nonce, '5');

    // a contract call, signed with the vault's key over the preimage the node rebuilds from the body
    network.qnc.nonce = 5n;
    const game = core.deriveContractAddress(PEER.qnet, 1);
    network.contracts[game] = { success: false, error: 'Contract exists but is not a QRC-20/QRC-721 token', contract_address: game };
    const args = core.bytesToHex(core.utf8Encode('move e2e4'));
    port.send({ id: 'k', method: 'qnet_sendTransaction', params: { type: 'contractCall', contract: game, method: 'play', args } });
    const call = await approvalWindow(3);
    const callView = (await call.get()).result;
    assert.equal(callView.kind, 'contractCall');
    assert.deepEqual([callView.details.nonce, callView.details.argsText, callView.details.inFlight], ['6', 'move e2e4', false]);
    await call.resolve(true);
    assert.deepEqual((await replyTo(port, 'k')).result, {
      status: 'submitted', from: WALLET.qnet, contract: game, method: 'play', nonce: '6',
      txHash: core.sha3_256Hex(core.utf8Encode(network.calls[0].body)),
    });
    assert.equal(network.calls.length, 1);
    assert.equal(network.calls[0].valid, true, 'the node would accept the signature');
    assert.equal(network.calls[0].fields.args, args);
    assert.equal(network.calls[0].fields.gas_limit, core.contractCallIntrinsicGas(network.calls[0].callData) + core.WASM_DEFAULT_FUEL);
    assert.deepEqual((await ask('sites.list')).result.sites.map((s) => s.origin), [SITE]);
  });

  it('Lock in the popup locks the worker, tells the site, and only the password unlocks', async () => {
    await popup.click('[data-action="lock"]');
    await popup.until(() => popup.$('[data-action="unlock"]') !== null, 'the lock screen');
    assert.equal(await session.isUnlocked(), false);
    await until(() => eventsOf(port).some((e) => e.event === 'accountsChanged' && Object.keys(e.data).length === 0), 5000);
    port.send({ id: 'a1', method: 'qnet_accounts' });
    assert.deepEqual((await replyTo(port, 'a1')).result, {});

    type(popup.$('input[name="password"]'), 'not the password at all');
    await popup.click('[data-action="unlock"]');
    await popup.until(() => /Wrong password/.test(popup.text()), 'the refusal');
    type(popup.$('input[name="password"]'), PASSWORD);
    await popup.click('[data-action="unlock"]');
    await popup.until(() => popup.$('[data-tab="assets"]') !== null, 'the wallet');
    port.send({ id: 'a2', method: 'qnet_accounts' });
    assert.deepEqual((await replyTo(port, 'a2')).result, WALLET);
  });

  it('a revoke disconnects the site for good: the old grant written back is refused', async () => {
    const old = (await browser.chrome.storage.local.get(STORAGE_KEYS.SITES))[STORAGE_KEYS.SITES];
    assert.deepEqual(Object.keys(old), [SITE]);
    assert.deepEqual((await ask('sites.revoke', { origin: SITE })).result, { revoked: true });
    await until(() => eventsOf(port).some((e) => e.event === 'disconnect'), 5000);
    await browser.chrome.storage.local.set({ [STORAGE_KEYS.SITES]: old });
    port.send({ id: 'a3', method: 'qnet_accounts' });
    assert.deepEqual((await replyTo(port, 'a3')).result, {});
    port.send({ id: 's2', method: 'qnet_signMessage', params: { message: 'again' } });
    assert.equal((await replyTo(port, 's2')).error.code, 4100);
    assert.equal(browser.windows.length, 4, 'no window for a site without a grant');
  });

  it('Settings: the phrase shows at once after the password and goes with Done; Delete wipes every store', async () => {
    await popup.click('[data-tab="settings"]');
    await popup.click('[data-action="reveal-phrase"]');
    assert.ok(!popup.text().includes('abandon'));
    type(popup.$('input[name="password"]'), PASSWORD);
    await popup.click('[data-action="reveal"]');
    await popup.until(() => popup.$('.phrase') !== null, 'the phrase screen');
    assert.match(popup.$('.phrase').textContent, /^1\. abandon\n[\s\S]*\n12\. about$/);
    assert.equal(popup.$('[data-action="hold-phrase"]'), null, 'no press-and-hold (owner, 06.10)');
    await popup.click('[data-action="done"]');
    assert.ok(!popup.text().includes('abandon'));

    await popup.click('[data-tab="settings"]');
    await popup.click('[data-action="delete-wallet"]');
    type(popup.$('input[name="confirm"]'), 'DELETE');
    type(popup.$('input[name="password"]'), PASSWORD);
    await popup.click('[data-action="confirm-delete"]');
    await popup.until(() => popup.location.reloads > 0, 'the reload');
    assert.deepEqual(browser.chrome.storage.local.dump(), {});
    assert.deepEqual(browser.chrome.storage.session.dump(), {});
    assert.equal((await globalThis.indexedDB.databases()).some((d) => d.name === VAULT_DB.NAME), false);
    assert.equal((await ask('vault.status')).result.exists, false);
    assert.equal(eventsOf(port).at(-1).event, 'disconnect');
  });

  it('talked only to the pinned HTTPS origins of the manifest', () => {
    const allowed = MANIFEST.host_permissions.map((p) => p.replace(/\/\*$/, ''));
    assert.ok(network.requests.length > 20);
    for (const request of network.requests) {
      const origin = new URL(request.split(' ')[1]).origin;
      assert.ok(allowed.includes(origin), request);
    }
  });
});

// Forgot password → Reset wallet, the popup against the real worker: the phrase of another wallet is named before
// anything goes, Back keeps the old vault, and only the ticked checkbox replaces it.
describe('integration: Reset wallet from the lock screen', () => {
  const NEW_PASSWORD = 'quantum otter lantern meadow';
  const storedRecord = () => structuredClone(globalThis.indexedDB.dump(VAULT_DB.NAME).stores[VAULT_DB.STORE][VAULT_DB.KEY]);

  async function forgotWithPeerPhrase() {
    await popup.click('[data-action="forgot-password"]');
    type(popup.$('textarea[name="phrase"]'), PEER_MNEMONIC);
    type(popup.$('input[name="new-password"]'), NEW_PASSWORD);
    type(popup.$('input[name="confirm-password"]'), NEW_PASSWORD);
    await popup.click('[data-action="restore"]');
    await popup.until(() => popup.$('input[name="understand"]') !== null, 'the confirmation');
  }

  it('names both wallets and erases nothing until the checkbox is ticked; then the other wallet takes its place', async () => {
    const setup = pageSender(browser.chrome.runtime, 'setup');
    assert.equal((await browser.ask(setup, 'vault.import', { mnemonic: KAT_MNEMONIC, password: PASSWORD })).ok, true);
    await ask('vault.lock');
    const before = storedRecord();
    popup?.close();
    popup = await openView(browser, 'popup');
    await popup.until(() => popup.$('[data-action="forgot-password"]') !== null, 'the lock screen');

    await forgotWithPeerPhrase();
    const text = popup.text();
    assert.match(popup.$('.notice-danger').textContent, /different wallet/);
    for (const address of [WALLET.qnet, WALLET.solana, PEER.qnet, PEER.solana]) assert.ok(text.includes(address), address);
    assert.equal(popup.$('[data-action="restore-confirm"]').disabled, true);
    assert.deepEqual(storedRecord(), before, 'the check erased nothing');
    await popup.click('[data-action="back"]');
    assert.ok(popup.$('[data-action="unlock"]'));
    assert.deepEqual(storedRecord(), before, 'Back erased nothing');
    assert.equal((await ask('vault.unlock', { password: PASSWORD })).result.qnet, WALLET.qnet, 'the old vault still opens');
    await ask('vault.lock');

    await popup.until(() => popup.$('[data-action="forgot-password"]') !== null, 'the lock screen');
    await forgotWithPeerPhrase();
    popup.$('input[name="understand"]').click();
    await popup.click('[data-action="restore-confirm"]');
    await popup.until(() => /Wallet restored/.test(popup.text()), 'the result');
    assert.ok(popup.text().includes(PEER.qnet) && popup.text().includes(PEER.solana));
    assert.equal(popup.location.reloads, 0, "the popup's own reset does not reload it");
    assert.equal(storedRecord().aad.qnetAddress, PEER.qnet);
    await ask('vault.lock');
    assert.equal((await ask('vault.unlock', { password: PASSWORD })).error.code, 'BAD_PASSWORD');
    assert.equal((await ask('vault.unlock', { password: NEW_PASSWORD })).result.qnet, PEER.qnet);
  });
});
