// Sentences of the privacy policy (src/app/privacy/page.tsx) and the support page checked against the code
// and the deployment: what the site stores in the browser, what the web server logs of the QNet Link relay,
// what the mobile app keeps and shares, what the faucet keeps, where logos load from, and what a second send
// does in each wallet. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { TEXTS } from '../texts.ts';

const SRC = new URL('../../', import.meta.url);
const REPO = new URL('../../../../../../', import.meta.url);
const read = (base, path) => readFileSync(new URL(path, base), 'utf8').replace(/\r\n/g, '\n');
// The page's text as a reader sees it: tags dropped, entities and whitespace folded.
const policy = read(SRC, 'app/privacy/page.tsx')
  .replace(/<[^>]+>/g, ' ').replace(/&apos;/g, "'").replace(/\s+/g, ' ');

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) {
      if (name !== '__tests__' && name !== '__release__') out.push(...sources(new URL(`${name}/`, dir)));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(url);
    }
  }
  return out;
}

test('what the site stores in the browser: the address view, the node pages\' wallet, their open request and the payment address', () => {
  assert.match(policy, /The site stores in your browser whether the QNet or the Solana address is shown and, for the node pages, the wallet address you chose there, or the extension's once you approved the site in it \(with its Solana address when the extension or QNet Wallet shared it\) until you change it, after you press Disconnect there a mark that keeps the page from connecting the extension's wallet by itself until you connect a wallet again, a request from those pages to QNet Wallet with its one-time key until the page has read the answer, so that it can still read it after the browser unloaded the tab, and the record of an activation on those pages: its payment address and key and what the activation has reached so far \(QNet Wallet's confirmation that the activation is for the wallet, with its QNet address, public key, signature and time; the burn and the transfer back, each with the pass the server gave for reading its state; the request to QNet Wallet; and the wallet's answer, with its public key and consent\), and the activation the QNet extension reported on those pages for a wallet \(the wallet's QNet and Solana addresses, the node type, the burn, its amount and the activation code, all public on Solana or on the QNet chain\), for at most five wallets, so that the node pages can show it again\./);
  // SITE-F6: the addresses Connect wallet gives the page are the wallet My node shows, and what My node sends is named.
  assert.doesNotMatch(policy, /they stay in the page and are not sent to the server|is not sent to the server either/);
  assert.match(policy, /When you press Connect wallet and approve the site in the QNet browser extension, the page receives your public QNet and Solana addresses; My node then shows that wallet, and what it sends the server is described next\./);
  assert.match(policy, /What the extension answers on the node pages about the wallet's activation is shown there, and an activation it reports is kept in the browser, as below\./);
  assert.match(policy, /They also send the wallet's QNet address, to ask the network whether the wallet has a node of either type and to read the wallet's activation record, the id of its super node, to read that node's status, and, when the page knows it, the wallet's own Solana address, whose public Solana history the server searches for an activation burn: the server asks a Solana RPC endpoint and keeps the answer in its memory for five minutes\./);
  assert.doesNotMatch(policy, /stays in the open tab/);
  assert.match(policy, /The browser keeps those keys for this site only and never hands them out\. A request expires after ten minutes; the page deletes what is left of an expired one when it next opens\./);
  assert.match(policy, /The node pages\{full && ' \(aiqnet\.io\/node\)'\} send the server the light node id of the wallet you choose there, or of the extension's once you approved the site in it, to read that node's public status and history from the network and, when you press I'm back, to ask the network to wake the node's linked device, and what an activation on those pages needs/);
  const users = [];
  for (const url of sources(SRC)) {
    const text = readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open/.test(text)) users.push(url.pathname.split('/src/')[1]);
  }
  // The view preference (AppContext), the node pages' wallet (CabinetProvider), open request (link-store) and
  // payment address (payment-store), the wallet's Solana address handed to the faucet page (faucet-handover), and the
  // explorer cache removing what an earlier version stored. No cookie.
  assert.deepEqual(users.sort(), ['components/cabinet/CabinetProvider.tsx', 'contexts/AppContext.tsx', 'lib/cabinet/payment-store.ts', 'lib/explorer-cache.ts', 'lib/faucet-handover.ts', 'lib/link-store.ts']);
  // The hand-over (owner, 29.09): one key in this tab's session storage, read once by the faucet page and removed.
  assert.match(policy, /When you follow the node pages' link to the testnet faucet, the page keeps the connected wallet's Solana address in this tab's session storage until the faucet page reads it once to fill in its field, and removes it then; nothing is sent until you press the faucet's button\./);
  const handover = read(SRC, 'lib/faucet-handover.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(handover, /export const HANDOVER_KEY = 'qnet\.faucet\.address';/);
  assert.deepEqual(handover.match(/sessionStorage\.?\w*/g), ['sessionStorage']);
  assert.match(handover, /const value = storage\?\.getItem\(HANDOVER_KEY\) \?\? null;\s*storage\?\.removeItem\(HANDOVER_KEY\);/);
  assert.match(policy, /It sets no tracking cookies and runs no analytics or advertising scripts\./);
  assert.doesNotMatch(policy, /qnet_lang|choose a language/);
  // The one key the node pages keep, and nothing else of theirs.
  const provider = readFileSync(new URL('components/cabinet/CabinetProvider.tsx', SRC), 'utf8');
  assert.deepEqual(provider.match(/localStorage\.?\w*/g), ['localStorage']);
  assert.match(readFileSync(new URL('lib/cabinet/wallet-choice.ts', SRC), 'utf8'), /export const WALLET_KEY = 'qnet\.cabinet\.wallet';/);
  // The extension's activation, kept per wallet with its public fields only, at most five wallets.
  const kept = read(SRC, 'lib/cabinet/kept-activation.ts');
  assert.match(kept, /export const ACTIVATIONS_KEY = 'qnet\.cabinet\.activations';/);
  assert.match(kept, /export const ACTIVATIONS_KEPT = 5;/);
  assert.match(provider, /setActivations\(loadKept\(storage\)\);/);
  assert.match(provider, /keepAnswer\(localStore\(\), current, answer, Date\.now\(\)\)/);
  // The Disconnect mark: one value, set by Disconnect and removed by the next wallet connected with a tap.
  const choice = readFileSync(new URL('lib/cabinet/wallet-choice.ts', SRC), 'utf8');
  assert.match(choice, /export const DISCONNECTED_KEY = 'qnet\.cabinet\.disconnected';/);
  assert.match(choice, /if \(disconnected\) storage\?\.setItem\(DISCONNECTED_KEY, '1'\);\s*else storage\?\.removeItem\(DISCONNECTED_KEY\);/);
  // The kept request expires with the relay's session and is purged when a node page opens.
  assert.match(provider, /void purgeSessions\(Date\.now\(\)\);/);
  const cache = read(SRC, 'lib/explorer-cache.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.deepEqual(cache.match(/sessionStorage\.\w+/g), ['sessionStorage.removeItem']);
});

test('the activation\'s payment address: what it signs, what the browser keeps, what the server sees and keeps', () => {
  // C4: the payment key signs the burn, the owner bind naming the wallet and the burn (before the burn is sent), and
  // the refund (payment-key.ts: signBurn, signOwnerBindV2, signRefund).
  assert.match(policy, /An activation on the node pages makes a one-time payment address in your browser, for the wallet QNet Wallet confirms first\. Its key never leaves the browser, and it signs only that activation's burn, the owner bind naming that wallet and the burn \(right after the burn is signed, before it is sent\), and the transfer of whatever is left back to the wallet\./);
  assert.deepEqual([...read(SRC, 'lib/cabinet/payment-key.ts').matchAll(/^export async function (sign\w+)/gm)].map((m) => m[1]), ['signBurn', 'signOwnerBindV2', 'signRefund']);
  // SITE-1, SITE-3: what the page does with the key and what is left, as flow.ts and activation.ts do it.
  assert.match(policy, /When the node is registered, the page sends what is left back to the wallet and deletes the key\. If nothing was burned within 24 hours after the activation started, it sends back what arrived and deletes the key then; after a burn it keeps the key only to send back what is left, until the node is registered or you ask for it at once, since the registration needs no key and can be finished in any browser where the wallet is connected\./);
  assert.doesNotMatch(policy, /you give the burn up|only that key can register a node/);
  assert.match(policy, /What is left goes to the wallet's Solana address when the extension or QNet Wallet on your device shared it, else to the Solana address you enter\. On testnet, when the page does not know the wallet's Solana address, it does not ask for one: it leaves the test tokens, which have no value, on the payment address and deletes the key\. You may instead leave it on the payment address: the page then tells you that nobody can move it once the key is gone, and deletes the key only after you confirm\. On mainnet a payment address with nothing on it keeps its key until you delete it, in case a transfer to it is still on its way\./);
  assert.doesNotMatch(policy, /at the latest 24 hours after the activation started, the page sends what is left back/);
  assert.match(policy, /Once the node is registered and the key deleted, only a receipt of the activation stays in the browser \(the payment address, the burn, its amount, the node and the wallet's QNet address\), at most ten, for the node details on My node; its activation code names the wallet, not the payment address\./);
  const flow = read(SRC, 'lib/cabinet/flow.ts');
  assert.match(flow, /burnFinal: \{ linkStarted: 'linkOpen', \.\.\.GIVE_BACK \},/);
  assert.match(flow, /const GIVE_BACK = \{ returnLeftovers: 'closing' \} as const;/);
  // What the page sends the server: the wallet's confirmation, the signed transactions with the owner bind, and the
  // registration, the wallet's key and consent alone.
  assert.match(policy, /The page sends the aiqnet\.io server the payment address, the wallet's confirmation, its signed transactions with the owner bind, and the registration \(the wallet's public key and its consent\), and My node sends the wallet address you chose to read its registration;/);
  assert.match(read(SRC, 'lib/cabinet/activation.ts'), /const keepsEmptyKey = \(record: PaymentRecord\): boolean => record\.stage === 'closing' && record\.network === 'mainnet';/);
  assert.match(policy, /every one of them is public on Solana or on the QNet chain\./);
  // One faucet (owner, 29.09): the user funds the payment address; the route that funded one, and what it kept, are gone.
  assert.match(policy, /A registration links the payment address that made the burn to the wallet's QNet address on chain\. The payment address gets its tokens from your own wallet\. Activation record\./);
  assert.doesNotMatch(policy, /refuse a second claim|testnet faucet funded|sends a payment address test tokens/);
  assert.equal(existsSync(new URL('server/cabinet/faucet.ts', SRC)), false);
  assert.match(policy, /beyond them the aiqnet\.io server holds the few request details described below in memory only, for at most a day\./);
  const store = read(SRC, 'lib/cabinet/payment-store.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(store, /const DB_NAME = 'qnet-cabinet';/);
  assert.match(store, /export const RECEIPTS_KEPT = 10;/);
  // The key is deleted when the activation is done, only the receipt staying, or with the whole record when it ended
  // unregistered; its lifetime is the policy's 24 hours.
  const activation = read(SRC, 'lib/cabinet/activation.ts');
  assert.match(activation, /current\.stage === record\.stage \? asReceipt\(current, deps\.now\(\)\) : null/);
  assert.match(activation, /if \(record\.stage === 'closing'\) \{\s*await removeRecord\(record\.pub, deps\.area\);/);
  assert.match(read(SRC, 'lib/cabinet/flow.ts'), /export const KEY_LIFETIME_MS = 24 \* 60 \* 60 \* 1000;/);
});

// R1, R6: the activation record the server keeps for a wallet, and for how long, as the registry and its table have it.
test('the activation record: what the server keeps, who reads it, and for how long, as the registry has it', () => {
  assert.match(policy, /Activation record\. One wallet gets one activation, for a light or a super node\./);
  assert.match(policy, /the aiqnet\.io server keeps, for each wallet whose activation starts or finishes through the node pages or the browser extension: the wallet's QNet address, the node type, how it was paid \(the extension or a one-time payment address\), the Solana address that burned, the burn transaction, its amount and the times it was reserved, sent, burned and recorded, and the proof that the reservation and the burn are that wallet's: the wallet's public key with its signed reservation \(its time included\) and, for a burn of the extension, its signatures over the burn, or, for a payment address's burn, the payment address's owner bind\./);
  assert.match(policy, /Anyone can read a wallet's record by its address, as the node pages, the extension and QNet Wallet do\./);
  // What is public and what only the record shows: its answer carries no proof (RECORD_VIEW_KEYS).
  assert.match(policy, /The burn, its amount and the Solana address that burned are public on Solana, and which wallet a burn is for becomes public on the QNet chain when its node registers; the record shows that link from the start and never shows the proof\./);
  assert.doesNotMatch(policy, /All of it but the times repeats what is public/);
  assert.doesNotMatch(read(SRC, 'lib/cabinet/burn-record.ts').match(/export const RECORD_VIEW_KEYS = \[[^\]]*\]/)[0], /proof/);
  // A2: a payment address's burn is the wallet's record like an extension burn; nothing ends it after a day.
  assert.match(policy, /A record is kept while the node pages run, since a burn is public and permanent, whether the extension or a payment address made it; a reservation without a burn goes within an hour after its ten minutes end\. No IP address is stored with it\./);
  assert.match(policy, /Activation records: on the aiqnet\.io server while the node pages run; a reservation without a burn at most an hour after its ten minutes end\./);
  assert.doesNotMatch(policy, /QNet Wallet never confirmed/);
  assert.match(policy, /The server's search of a wallet's Solana history for an activation burn: in server memory, five minutes\./);
  // SITE M-12: the ids of registered nodes the server read, kept a day so that their reads keep a share of their own,
  // with nothing of who read them; within the policy's day for the server's request details.
  assert.match(policy, /For a day after it last read one, the server also keeps in its memory the ids of the nodes the network lists as registered, with nothing of who read them, so that the reads of registered nodes keep a share of the network's answers of their own\./);
  assert.match(policy, /The ids of registered nodes the node pages read: in server memory, a day after the last read\./);
  const knownNodes = read(SRC, 'server/cabinet/known-nodes.ts');
  assert.match(knownNodes, /export const KNOWN_MS = 86_400_000;/);
  assert.match(knownNodes, /has\(nodeId: string\): boolean;\s*\/\/ The network listed it as registered now\.\s*note\(nodeId: string\): void;/);
  // The code: ten minutes a reservation, swept an hour after its end, a search kept five minutes, no hold of a day any
  // more, the table's columns, and no IP address.
  const record = read(SRC, 'lib/cabinet/burn-record.ts');
  assert.match(record, /export const RESERVATION_TTL_MS = 600_000;/);
  assert.match(record, /export const SCAN_CACHE_MS = 300_000;/);
  assert.doesNotMatch(record, /PAYMENT_HOLD_MS/);
  assert.match(record, /export const RECORD_STATES = \['none', 'reserved', 'sending', 'recorded'\] as const;/);
  const registry = read(SRC, 'server/cabinet/activation-registry.ts');
  assert.doesNotMatch(registry, /'burned'/);
  assert.match(registry, /sweep: `DELETE FROM cabinet_activations WHERE state = 'reserved' AND burn_tx IS NULL AND expires_at < now\(\) - interval '1 hour'`/);
  const migration = read(SRC, '../migrations/005_cabinet_activations.sql');
  for (const column of ['wallet', 'state', 'node_type', 'way', 'burner', 'burn_amount', 'reservation', 'reserved_at', 'expires_at', 'burn_tx', 'announced_at', 'burn_slot', 'burned_at', 'recorded_at', 'proof']) {
    assert.match(migration, new RegExp(`^  ${column} [A-Z]`, 'm'), column);
  }
  assert.equal([...migration.matchAll(/^  [a-z_]+ [A-Z]/gm)].length, 15, 'no column beyond these');
  // The site's pages read the record, not write it; the extension posts its own record (C3.5), and a payment key's burn
  // becomes the record once final, from its announce with the owner bind (C4); the registration only reads it.
  assert.match(read(SRC, 'server/cabinet/register.ts'), /const row = options\.paymentRecord \? await options\.paymentRecord\(checked\.body\.wallet_address\) : 'unavailable';/);
  assert.match(registry, /if \(got\.kind === 'final'\) next = \{ state: 'recorded', burnSlot: got\.burn\.slot, burnedAt: got\.burn\.blockTime \};/);
});

test('the explorer cache keeps viewed records in memory only and clears what an earlier version left', async () => {
  const calls = [];
  const storage = {
    getItem: (k) => { calls.push(['get', k]); return null; },
    setItem: (k) => { calls.push(['set', k]); },
    removeItem: (k) => { calls.push(['remove', k]); },
  };
  globalThis.window = { sessionStorage: storage };
  try {
    const cache = await import(`../explorer-cache.ts?memory=${Date.now()}`);
    cache.setCache('address', 'abc', { balance: 1 });
    cache.batchCache('tx', [{ key: 't1', data: 1 }, { key: 't2', data: 2 }]);
    assert.deepEqual(cache.getCache('address', 'abc'), { balance: 1 });
    assert.equal(cache.getCache('tx', 't2'), 2);
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(calls, [['remove', 'qnet_explorer_cache_v5']]);
    cache.clearCache();
    assert.equal(cache.getCache('address', 'abc'), null);
  } finally {
    delete globalThis.window;
  }
});

test('the relay\'s and the node pages\' requests are not in the access log, as the policy and the protocol say', () => {
  assert.doesNotMatch(policy, /access logs[^.]*list these requests/);
  assert.match(policy, /These requests are left out of the web server's access logs/);
  assert.match(policy, /except for the requests between aiqnet\.io's pages and the mobile app described above and the node pages' requests about a node, a wallet or a payment address, which it does not log/);
  const deploy = read(REPO, 'deployment/deploy-aiqnet.sh');
  assert.match(deploy, /location \^~ \/api\/link\/ \{\n\s+access_log off;/);
  assert.match(deploy, /location \^~ \/api\/cabinet\/ \{\n\s+access_log off;/);
  // Every route the node pages call about a node, a wallet or a payment address is under /api/cabinet/ or the
  // relay; the one other is the price, which names only a node type.
  const called = [];
  for (const url of [...sources(new URL('components/cabinet/', SRC)), ...sources(new URL('lib/cabinet/', SRC)), new URL('hooks/useNodeStatus.ts', SRC)]) {
    const text = readFileSync(url, 'utf8');
    for (const m of text.matchAll(/(?:\bfetch\(|getJson\(deps,|postJson\(deps,)\s*[`'"](\/api\/[^`'"?$]*)/g)) called.push(m[1]);
  }
  assert.ok(called.filter((p) => p.startsWith('/api/cabinet/')).length >= 10, called.join());
  for (const path of called) assert.match(path, /^\/api\/(cabinet|link)\/|^\/api\/activation\/price$/, path);
  // And the cabinet's server side logs nothing of them either.
  for (const url of sources(new URL('server/cabinet/', SRC))) assert.doesNotMatch(readFileSync(url, 'utf8'), /console\.|appendFile|writeFile/, url.pathname);
  const protocol = read(REPO, 'docs/protocols/qnet-link-v1.md').replace(/\s+/g, ' ');
  assert.match(protocol, /access_log off/);
  assert.doesNotMatch(protocol, /keeps it only in the limiter's memory\.?\s*$/m);
});

test('the policy covers the mobile app\'s in-app browser: what sites get, what stays on the phone', () => {
  assert.match(policy, /In-app browser \(mobile\)\. The mobile app includes a web browser\./);
  assert.match(policy, /receives your public QNet and Solana addresses only after you connect it on the app's own confirmation screen/);
  assert.match(policy, /a message signature, a QNC transfer, a token transfer or a contract call only after you confirm that request there/);
  assert.match(policy, /Clear browsing data deletes them together with the recent pages/);
  // What stays on the device lists the browser's data: the recent pages as not encrypted, the connected
  // sites as encrypted.
  const onDevice = policy.slice(policy.indexOf('What stays on your device'), policy.indexOf('What is sent to the network'));
  assert.match(onDevice, /the in-app browser's list of recent pages \(at most 20, each as its address without the query or fragment, and its title\)/);
  assert.match(onDevice, /Encrypted at rest: [^.]*, among them, in the mobile apps, the list of websites connected to the wallet/);
  assert.match(policy, /Websites you open in the mobile app's browser see your IP address/);
  // The app's own limits the policy relies on (applications/qnet-mobile/src/browser).
  const history = read(REPO, 'applications/qnet-mobile/src/browser/history.js');
  assert.match(history, /export const HISTORY_MAX = 20;/);
  assert.match(history, /return `\$\{originOfParsed\(p\)\}\$\{p\.path\}`;/, 'kept without query and fragment');
  assert.match(read(REPO, 'applications/qnet-mobile/src/browser/grants.js'), /putSealedRecord/);
});

const onDevice = () => policy.slice(policy.indexOf('What stays on your device'), policy.indexOf('What is sent to the network'));

test('the device section lists the app\'s unencrypted history, unconfirmed transactions and Solana sends as they are kept', () => {
  const text = onDevice();
  assert.match(text, /three records of public chain data: the QNet transactions it signed that the network has not confirmed yet/);
  // The SOL and 1DEV sends made on this device (services/SolanaSend): each entry's fields, the newest 100 per Solana
  // address, plain AsyncStorage JSON like the other two.
  assert.match(text, /and the SOL and 1DEV sends it made on this device \(each with its signature, token, amount, recipient, network fee and the SOL a new token account took, its status, the time it was sent and the block height until which it can land; the newest 100 for each Solana address\), which History lists and follows until the network settles them\./);
  const sends = read(REPO, 'applications/qnet-mobile/src/services/SolanaSend.js');
  assert.match(sends, /const HISTORY_MAX = 100;/);
  assert.match(sends, /const historyKey = \(owner\) => `qnet_solana_sends_v1:\$\{owner\}`;/);
  assert.match(sends, /await AsyncStorage\.setItem\(historyKey\(owner\), JSON\.stringify\(next\)\);/);
  assert.doesNotMatch(sends, /seal/i);
  assert.match(read(REPO, 'applications/qnet-mobile/src/screens/SolanaSend.js'), /const entry = \{\s*signature: sent\.signature, symbol: q\.symbol, amount: q\.amountText, to: recipient, fee: q\.feeLamports,\s*rent: q\.rentLamports, status: 'pending', at: now\(\), lastValidBlockHeight: sent\.lastValidBlockHeight,\s*\};/);
  assert.match(text, /at most 500 transactions for each of the three wallets used last/);
  assert.match(text, /removed once they settle \(a summary of each, its recipient and amount, stays 30 minutes for the same-payment-again warning\)/);
  assert.match(text, /the extension keeps its unconfirmed transfers there too/);
  const history = read(REPO, 'applications/qnet-mobile/src/utils/txHistory.js');
  assert.match(history, /export const HISTORY_CACHE_MAX = 500;/);
  const cache = read(REPO, 'applications/qnet-mobile/src/services/HistoryCache.js');
  assert.match(cache, /export const HISTORY_CACHE_KEY = 'qnet_tx_history';/);
  assert.match(cache, /export const MAX_WALLETS = 3;/);
  const pending = read(REPO, 'applications/qnet-mobile/src/services/PendingTx.js');
  assert.match(pending, /export const PENDING_KEY = 'qnet_pending_txs';/);
  assert.match(pending, /export const RECENT_MS = 30 \* 60_000;/);
  // The extension's pending transfers live in the encrypted vault state.
  const vault = read(REPO, 'applications/qnet-wallet/dist/background/vault.js');
  assert.match(vault, /export async function readState\(\) \{[\s\S]*?decryptWithSession/);
});

// R4-XPD-08: the policy said language and display settings and the in-app browser's recent pages were
// encrypted at rest (they are plain app storage in both apps), and that the cached history stays when a wallet
// is deleted (Delete wallet erases it). Each statement is pinned next to the code it describes.
test('what is encrypted, what is not, and what Delete wallet leaves, as the apps do it', () => {
  const text = onDevice();
  const encrypted = text.slice(text.indexOf('Encrypted at rest:'), text.indexOf('Not encrypted, in the mobile app'));
  const plain = text.slice(text.indexOf('Not encrypted, in the mobile app'), text.indexOf('Deleting the wallet'));
  assert.ok(encrypted.length > 0 && plain.length > 0);
  // Only what is sealed is called encrypted.
  assert.match(encrypted, /the recovery phrase, the private keys, the node signing key, in the browser extension the node's activation code/);
  assert.doesNotMatch(encrypted, /language|display|network|auto-lock|recent pages|history|address/i);
  assert.doesNotMatch(policy, /language and display settings\. They are encrypted/);
  for (const item of [/the wallet's public addresses/, /settings \(language, auto-lock, and how balances and tokens are shown\)/,
    /list of recent pages/, /the confirmed history it last showed/, /not confirmed yet/, /the SOL and 1DEV sends it made on this device/,
    /Not encrypted, in the browser extension's storage: the chosen language; the list of websites approved to see your addresses/]) {
    assert.match(plain, item);
  }
  // Retention: Delete wallet removes all of it but the app's language.
  assert.doesNotMatch(policy, /That history stays when a wallet is deleted/);
  assert.match(text, /Deleting the wallet removes all of this: in the mobile app everything but the language setting, in the browser extension everything\./);
  assert.match(policy, /Data on your device: until you delete the wallet \(the mobile app then keeps only its language setting\) or uninstall the app or the extension\./);

  // The mobile app: recent pages are plain AsyncStorage JSON; connected sites are sealed; it keeps no activation code
  // (it burns nothing and uses no codes).
  const browserHistory = read(REPO, 'applications/qnet-mobile/src/browser/history.js');
  assert.match(browserHistory, /await AsyncStorage\.setItem\(HISTORY_KEY, JSON\.stringify\(next\)\)/);
  assert.doesNotMatch(browserHistory, /seal/i);
  assert.match(read(REPO, 'applications/qnet-mobile/src/browser/grants.js'), /putSealedRecord\(SITES_KEY/);
  const wm = read(REPO, 'applications/qnet-mobile/src/components/WalletManager.js');
  assert.doesNotMatch(wm, /storeActivationCode|recoverActivationCode/);
  // Settings are plain AsyncStorage values; the network is no setting (devnet in every build).
  const screen = read(REPO, 'applications/qnet-mobile/src/screens/WalletScreen.js');
  for (const key of ['qnet_language', 'qnet_autolock_time', 'qnet_hide_balances', 'qnet_hidden_tokens']) {
    assert.match(screen, new RegExp(`AsyncStorage\\.setItem\\('${key}'`), key);
  }
  assert.doesNotMatch(screen, /AsyncStorage\.setItem\('qnet_testnet'/);
  // Delete wallet: every key but the language, the Keychain and the Keystore keys.
  assert.match(wm, /static ERASE_ALLOW_LIST = \['qnet_language'\];/);
  assert.match(wm, /async eraseAllData\(\) \{[\s\S]*?const doomed = all\.filter\(\(k\) => !WalletManager\.ERASE_ALLOW_LIST\.includes\(k\)\);[\s\S]*?await this\._wipeKeychain\(\);\s*await deleteDeviceKeys\(\);/);
  assert.match(screen, /const eraseWallet = async \(\) => \{[\s\S]*?await walletManager\.eraseAllData\(\);/);
  // A reinstall on iOS: Keychain items left from before are wiped at the first start.
  assert.match(wm, /if \(state === 'none'\) \{\s*await this\._wipeKeychain\(\);\s*await deleteDeviceKeys\(\);/);
  // The extension: Delete wallet clears its whole chrome.storage.local (language and approvals included).
  const vault = read(REPO, 'applications/qnet-wallet/dist/background/vault.js');
  assert.match(vault, /async function eraseAll\(\) \{[\s\S]*?await clearArea\(storage\.local\);/);
});

// R5-XPD-05: the policy listed two unencrypted items of the extension. The vault record keeps the wallet's
// addresses, its creation time and its activation's node type in its associated data, which is stored in the clear;
// the burn search and the light client's checkpoints sit next to it with a MAC only; session memory holds the key and
// the limits. Each is named. This version writes nothing of the store's 2.1.x wallet: it only reads what 2.1.x left, to
// move that wallet by its recovery phrase (earlier.js, 06.10), and removes it, so the list of what it stores names none of it.
test('the extension\'s unencrypted data is listed as the extension stores it', () => {
  const text = onDevice();
  const plain = text.slice(text.indexOf("Not encrypted, in the browser extension's storage:"), text.indexOf('Deleting the wallet'));
  for (const item of [
    /the chosen language; the list of websites approved to see your addresses, each approval carrying a check value/,
    /stored in the clear next to the encrypted wallet, the wallet's public QNet and Solana addresses, a random wallet identifier, when the wallet was created and whether its activation is for a light or a super node, which anyone who can read the browser profile sees without the password/,
    /two records of public chain data, each with a check value made with a key from the encrypted wallet data: how far the searches for the wallet's activation burn have read the Solana history of the wallet \(its address and 1DEV account: the transactions listed and checked\)/,
    /the network checkpoints the extension's light client verified/,
    /in the browser's session memory, which is not written to disk and is cleared when the browser closes: the key of the unlocked wallet with its addresses, until it locks; the count of wrong passwords; the result of its start-up self-test; and the recent approval requests of each website/,
  ]) assert.match(plain, item);
  assert.doesNotMatch(plain, /2\.1|earlier version/);
  // What 2.1.x left is never written by this version: earlier.js only reads and removes it.
  const earlier = read(REPO, 'applications/qnet-wallet/dist/background/earlier.js');
  assert.doesNotMatch(earlier, /\.set\(|\.put\(|\.add\(|setItem\(/);
  assert.match(earlier, /await local\.remove\(\[\.\.\.EARLIER_KEYS\]\);/);

  const vault = read(REPO, 'applications/qnet-wallet/dist/background/vault.js');
  // The record's associated data (stored in the clear, authenticated by the encryption); its key `legacy` is always null.
  assert.match(vault, /const RECORD_KEYS = Object\.freeze\(\['v', 'kdf', 'iv', 'ct', 'aad', 'sitesKey'\]\);/);
  assert.match(vault, /const AAD_KEYS = Object\.freeze\(\['v', 'kdf', 'walletId', 'qnetAddress', 'solanaAddress', 'createdAt', 'activationNodeType',\s*'legacy'\]\);/);
  assert.doesNotMatch(vault, /LEGACY_AAD_KEYS|spellingBox/);
  assert.match(vault, /&& \(!Object\.hasOwn\(aad, 'legacy'\) \|\| aad\.legacy === null\)/);
  // The kept burn searches (the wallet's) and the light client's anchors: MAC only.
  assert.match(vault, /store\.put\(\{ v: 1, scans, mac \}, BURN_SCANS_KEY\)/);
  assert.match(vault, /export async function writeBurnScan\(owner, /);
  assert.match(vault, /store\.put\(\{ v: 1, anchors: copy, mac \}, LIGHT_ANCHORS_KEY\)/);
  assert.doesNotMatch(read(REPO, 'applications/qnet-wallet/dist/ui/common.js'), /LEGACY_PASSWORD_EXPOSED_KEY|qnet_legacy_password_exposed/);
  // Session memory: the unlocked session, the backoff, the self-test pass and the approval cooldowns.
  const config = read(REPO, 'applications/qnet-wallet/dist/background/config.js');
  assert.match(config, /\/\/ chrome\.storage\.session \(TRUSTED_CONTEXTS\)\n\s*SESSION: 'qnet_session_v3',\n\s*BACKOFF: 'qnet_backoff_v3',\n\s*SELF_TEST: 'qnet_selftest_v3',\n\s*APPROVAL_COOLDOWN: 'qnet_approval_cooldown_v3',/);
  assert.match(read(REPO, 'applications/qnet-wallet/dist/background/session.js'), /key: core\.base64Encode\(s\.vaultKey\),\s*walletId: s\.walletId,\s*qnetAddress: s\.qnetAddress,\s*solanaAddress: s\.solanaAddress,/);

  // The extension's document says the same, and no longer "Nothing else is stored".
  const doc = read(REPO, 'docs/applications/browser-wallet.md').replace(/\s+/g, ' ');
  assert.doesNotMatch(doc, /the self-test pass and the per-site approval cooldowns\. Nothing else is stored\./);
  assert.match(doc, /The record's associated data is stored in the clear/);
  // It names the wallet 2.1.x left as kept by that version, untouched until moved or removed, never as written by this one.
  assert.match(doc, /a wallet of the earlier version stays there \(and its second copy in its own IndexedDB database\), untouched, until it is moved or removed; Delete wallet removes it too/);
  const storageParagraph = doc.slice(doc.indexOf('`chrome.storage.local` holds'), doc.indexOf('`chrome.storage.session`'));
  assert.doesNotMatch(storageParagraph, /2\.1/);
});

test('the testnet faucet is covered: what it sends, what it keeps and for how long', () => {
  assert.match(policy, /Testnet faucet\. The faucet\{full && ' on aiqnet\.io\/testnet'\} sends test tokens \(1DEV and SOL on Solana devnet\) to the Solana address you enter/);
  assert.match(policy, /that transfer publicly links the faucet wallet to your address on Solana/);
  assert.match(policy, /the server keeps the address and the time of its last claim in memory for 24 hours, and then drops it; it is never written to disk/);
  assert.match(policy, /Testnet faucet claims \(the Solana address and the time of its last claim, and with a faucet pass the wallet's QNet address and that time\): in server memory, 24 hours\./);
  // SITE M-13: the faucet pass, what the page sends for it, what it names, and the wallet's day of claims.
  assert.match(policy, /the node pages send the server the wallet's confirmation that QNet Wallet gave for the activation \(its QNet address, public key, signature and time\) with the payment address, and get a faucet pass for that wallet, which names the wallet and the time it ends, an hour later; the server keeps no list of the passes\. A claim with a pass allows one claim of each token per wallet a day: the server then also keeps the wallet's QNet address and the time of its last claim in memory for 24 hours, in the same way\./);
  assert.match(policy, /With it the page keeps the faucet pass the server gave for the wallet of the activation, the same way, until the faucet page reads it once and sends it with your claim\./);
  const pass = read(SRC, 'server/faucet-pass.ts');
  assert.match(pass, /export const FAUCET_PASS_TTL_S = 3_600;/);
  assert.match(pass, /return \{ pass: `\$\{wallet\}\.\$\{until\}\.\$\{macOf\(key, wallet, until\)\}`, until \};/);
  assert.doesNotMatch(pass, /new Map|new Set|console\.|writeFile|appendFile/, 'no list of passes, nothing written');
  // The cooldown the text states holds on every network (SITE-R1-02): the route admits each claim through the guard.
  const route = read(SRC, 'app/api/faucet/claim/route.ts');
  const guard = read(SRC, 'server/faucet-guard.ts');
  assert.match(route, /legacyFaucetGuard\(\)\.admit\(walletAddress, tokenType, getRateLimitKey\(request\), wallet\)/);
  assert.match(guard, /const walletKey = wallet === null \? null : `wallet:\$\{wallet\}:\$\{token\}`;/);
  assert.doesNotMatch(route, /environment !== 'testnet'/);
  assert.match(guard, /export const LEGACY_COOLDOWN_MS = 24 \* 60 \* 60 \* 1000;/);
  assert.match(guard, /createFaucetCooldowns\(\{ cooldownMs: LEGACY_COOLDOWN_MS, now \}\)/);
  assert.match(guard, /sweepCooldownsPeriodically\(cooldowns\)/);
  for (const src of [route, guard]) {
    assert.doesNotMatch(src, /new Map<string, (number|string)>|createFaucetCooldowns\(\{ cooldownMs: (?!LEGACY_COOLDOWN_MS)/, 'no other store of claims');
    assert.doesNotMatch(src, /console\.|writeFile|appendFile/);
  }
});

// The stated retention follows the longest per-IP window of every limiter the site keeps. The day allowance per client
// IP (SITE-R1-03) went with the node cabinet's faucet route (29.09): the longest window is now the /testnet faucet's
// hour. SD-R2-08, SITE-R3-03: the website paragraph and the Retention list say the same.
test('IP addresses counted for limits are kept no longer than the policy says', async () => {
  const { CABINET_LIMITS, KEYED_LIMITS } = await import('../../server/cabinet/limits.ts');
  const { LIMITS } = await import('../../server/link-relay.ts');
  const { LEGACY_PER_IP, PER_NETWORK } = await import('../../server/faucet-guard.ts');
  const { FAUCET_PASS_PER_IP, FAUCET_PASSES_PER_IP, FAUCET_PASSES_PER_NETWORK } = await import('../../server/faucet-pass.ts');
  const { CLIENT_BUDGETS } = await import('../../server/cabinet/limits.ts');
  const windows = [
    ...Object.values(CABINET_LIMITS), ...Object.values(KEYED_LIMITS), ...Object.values(CLIENT_BUDGETS), ...Object.values(LIMITS), LEGACY_PER_IP, PER_NETWORK,
    FAUCET_PASS_PER_IP, FAUCET_PASSES_PER_IP, FAUCET_PASSES_PER_NETWORK,
  ].map((l) => l.windowMs);
  assert.equal(Math.max(...windows), 3_600_000);
  assert.match(policy, /IP addresses counted for request limits: in server memory, for the length of each limit \(at most an hour\)\./);
  assert.match(policy, /the server counts requests per IP address in memory, for the length of each limit \(at most an hour\), and writes those counts nowhere\./);
  assert.doesNotMatch(policy, /each limit \(at most a day\)/);
  // The explorer's routes count in the shared limiter, whose sweep drops an address once its window has ended, each
  // window a minute to an hour. The balance check kept a map of its own that nothing swept, so an address stayed in
  // memory long after its minute (29.09).
  assert.match(read(SRC, '../lib/rate-limit.ts'), /limiter = createRateLimiter\(\);\s*sweepPeriodically\(limiter\);/);
  const routes = sources(new URL('app/api/', SRC));
  assert.ok(routes.length > 20);
  for (const url of routes) {
    const src = read(url, '');
    assert.doesNotMatch(src, /rateLimitMap|resetAt: now \+/, url.pathname);
    const window = /const RATE_LIMIT_WINDOW = ([\d_]+(?: \* [\d_]+)*);/.exec(src);
    if (window) {
      const ms = window[1].split(' * ').reduce((n, part) => n * Number(part.replace(/_/g, '')), 1);
      assert.ok(ms > 0 && ms <= 3_600_000, `${url.pathname}: ${ms}`);
    }
  }
  assert.match(read(SRC, 'app/api/address/[address]/balance-proof/route.ts'), /if \(!rateLimit\(`balance-proof:\$\{ipKey\.ip\}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW\)\.allowed\) \{/);
});

// SITE-R3-03: the policy and the activation page said what is left always goes back to the wallet, but on testnet,
// when the page knows no Solana address of the wallet, the page ends the activation without sending the test tokens
// and without asking (activation.ts mayForgo). Every text that promises the way back now says so.
test('on testnet, test tokens go back only when the page knows the wallet\'s Solana address, as every text says', async () => {
  const activation = read(SRC, 'lib/cabinet/activation.ts');
  assert.match(activation, /const mayForgo = \(record: PaymentRecord, dest: string \| null\): boolean => dest === null && record\.network === 'testnet';/);
  assert.match(activation, /if \(mayForgo\(record, dest\)\) return \{ outcome: 'nothing', record: await end\(record, deps\) \};/);
  assert.match(policy, /On testnet, when the page does not know the wallet's Solana address, it does not ask for one: it leaves the test tokens, which have no value, on the payment address and deletes the key\./);
  assert.match(TEXTS.act_keep_browser, /the page sends what arrived back to the wallet and deletes the payment address \(test tokens go back only when the page knows the wallet's Solana address\)\./);
  assert.match(TEXTS.act_keep_browser, /After the burn this browser keeps the payment address only to send back what is left; the registration can be finished in any browser\./);
  assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, 'act_abandon_warn'), false);
});

// SITE-R3-03: the Terms named "GitHub for token logos" only, while the site's logo proxy fetches each logo from the web
// server its token's creator recorded. GitHub serves the mobile app's Solana tab logos; the site's logos come from the
// creators' servers, fetched by the aiqnet.io server, so they see that server, never the visitor.
test('the third parties for token logos: GitHub for the app\'s Solana tab, the creators\' servers for the site\'s logos', () => {
  const terms = read(SRC, 'app/terms/page.tsx').replace(/<[^>]+>/g, ' ').replace(/&apos;/g, "'").replace(/\s+/g, ' ');
  assert.match(terms, /GitHub for the token logos of the mobile app's Solana tab, the web servers that token creators name for their tokens' logos \(the aiqnet\.io server fetches those logos itself\)/);
  assert.doesNotMatch(terms, /GitHub for token logos/);
  assert.match(policy, /GitHub for the token logos of the mobile app's Solana tab,/);
  assert.doesNotMatch(policy, /GitHub for token logos/);
  assert.match(policy, /The Solana tab loads token logos from GitHub/);
  // The app draws the Assets and History icons from one table (components/TokenIcons.js).
  const app = read(REPO, 'applications/qnet-mobile/src/components/TokenIcons.js');
  assert.match(app, /'https:\/\/raw\.githubusercontent\.com\//);
  // The site's proxy takes any https host the chain names, never a pinned one.
  const proxy = read(SRC, 'server/logo-proxy.ts');
  assert.match(proxy, /A QRC-20 logo is an https URL\s*\/\/ its deployer recorded on chain/);
  assert.doesNotMatch(proxy, /github/i);
});

test('pages load images only from the site; token logos come through the site', () => {
  assert.match(policy, /Pages load images only from aiqnet\.io: a token's logo, which its creator records on chain as a link to any web server, is fetched by the aiqnet\.io server and served from aiqnet\.io/);
  const proxy = read(SRC, 'proxy.ts');
  assert.match(proxy, /"img-src 'self' data:",/);
  const icon = read(SRC, 'components/TokenIcon.tsx');
  assert.deepEqual(icon.match(/src=\{?[^\s>]+/g), ['src="/qnc-logo.png"', 'src={`/api/token/${contract}/logo`}']);
});

test('Support says what a second send does in each wallet, never that it cannot charge twice', () => {
  // The page shows these texts by key (src/lib/texts.ts).
  const page = read(SRC, 'app/support/page.tsx');
  for (const key of ['support_pending_lead', 'support_pending_app', 'support_pending_extension', 'support_pending_once']) {
    assert.match(page, new RegExp(`\\{t\\('${key}'\\)\\}`), key);
  }
  const support = Object.entries(TEXTS).filter(([k]) => k.startsWith('support_')).map(([, v]) => v).join(' ');
  assert.doesNotMatch(support, /can never charge you twice|only one of the two can ever apply/);
  assert.match(TEXTS.support_pending_lead, /Sending the same payment again can pay it twice/);
  assert.equal(TEXTS.support_pending_app, 'In the mobile app, the next send from that wallet asks what to do with the unconfirmed one. Replace it: the new send takes its place, and only one of the two can go through. Send in addition: both can go through.');
  // SITE-F5: the extension's send review offers to replace an unconfirmed transfer (a refused one by default).
  assert.equal(TEXTS.support_pending_extension, 'In the browser extension, the send review lists the unconfirmed transfers and offers to replace one of them (only one of the two can go through); otherwise the new send goes in addition, and all of them can go through.');
  // What the wallets do: the app asks (replace or append), the extension numbers after every pending send.
  const app = read(REPO, 'applications/qnet-mobile/src/i18n/locales/en.js');
  assert.match(app, /pending_replace_note: 'Replace: only one of the two can go through\.'/);
  assert.match(app, /pending_append_note: 'In addition: both can go through\.'/);
  const qnet = read(REPO, 'applications/qnet-wallet/dist/background/qnet.js');
  assert.match(qnet, /if \(BigInt\(p\.nonce\) >= nextNonce\) nextNonce = BigInt\(p\.nonce\) \+ 1n;/);
});

// SD-R2-02: on Android, Google Play Integrity's answer carries app activity (whether apps that can capture the screen,
// draw over other apps or control the device are present), which the Data safety form declares; the policy's device
// check said nothing of it. The device layer uses only that the report is there (a phone or tablet: Google evaluates it
// only on those), and it stays inside the kept proof.
test('the device check names the app activity Play Integrity reports, what it is used for and how long it is kept', () => {
  const section = policy.slice(policy.indexOf('Device check for a light node'), policy.indexOf('Device permissions'));
  assert.match(section, /On Android, Google Play Integrity's answer also reports app activity on the device: whether apps are running that could view the screen, show themselves over other apps or control the device, and whether other apps are installed, telling apps from Google Play or the device maker apart from apps installed any other way\. The report names no app, only whether such apps are present\. QNet uses it only to tell a phone or tablet from other devices, and keeps it only as part of the operating system's proof, for as long as that proof \(below\)\./);
  assert.match(policy, /Device check: the device record while the node is linked and 90 days after; the operating system's proof \(on Android with Google Play Integrity's report of app activity: apps running that could view the screen or control the device, and whether apps from Google Play, from the device maker or from elsewhere are installed\) 7 days, or 90 days after a refusal or a pause;/);
  // SD-R3-01: Google's verdict also carries KNOWN_INSTALLED and UNKNOWN_INSTALLED (apps installed from Google Play or
  // preloaded, and apps installed any other way, whatever their permissions), and the device service keeps the whole
  // answer. The policy said the report covered only apps that capture the screen, draw overlays or control the device.
  assert.doesNotMatch(policy, /whether apps that can capture the screen, show themselves over other apps or control the device are installed or running/);
  assert.doesNotMatch(policy, /report of apps that can capture the screen or control the device\)/);
  // What the device layer does with it: the verdict's presence only, as the phone-or-tablet signal; the day it reads
  // which apps were detected, this sentence of the policy changes with it.
  const play = read(REPO, 'core/qnet-device-attest/src/play.rs');
  assert.match(play, /\/environmentDetails\/appAccessRiskVerdict/);
  assert.doesNotMatch(play, /appsDetected/);
});

// SD-R2-10: the policy said a website gets only a message signature or a QNC transfer from the wallets, and that the app
// has no camera, photo or file access, while both wallets also sign token transfers and contract calls for sites, and
// below iOS 18.4 a page's upload sheet can still hand a photo or file to the site (hence the camera text in Info.plist).
test('what a website can ask the wallets for, and what a page\'s upload sheet can pass, as the apps do it', () => {
  assert.match(policy, /At a site's request the extension signs a message, sends a QNC transfer, a token transfer or a contract call, or moves a light node's balance into its wallet, each only after you confirm that request in its own window\./);
  assert.match(policy, /it receives a message signature, a QNC transfer, a token transfer or a contract call only after you confirm that request there with the device's authentication or your app password\./);
  assert.match(policy, /Camera: only after you tap the scan icon on a Send screen and allow it, to read a QNet address, a Solana address or a Solana payment request from a QR code; what it reads only fills in that Send form\. Frames are decoded on the device, on Android and iOS alike, and never stored or sent\. The app itself uses no photos, location, contacts, microphone or files\. On iOS below 18\.4 a website's upload sheet in the in-app browser can still pass that website a photo or file you pick or take there; the camera opens only if you choose it in that sheet\./);
  assert.doesNotMatch(policy, /tap Scan on the Send screen/);
  assert.doesNotMatch(policy, /uses no camera/);
  assert.doesNotMatch(policy, /No camera, photos, location, contacts, microphone or file access/);
  // The four request types in both wallets, and the camera text the app declares for the scan icon of its Send screens.
  const requests = read(REPO, 'applications/qnet-mobile/src/browser/dappRequests.js');
  for (const type of ['tokenTransfer', 'contractCall']) assert.match(requests, new RegExp(`type === '${type}'`), type);
  const provider = read(REPO, 'applications/qnet-wallet/dist/background/provider.js');
  assert.match(provider, /const TX_KINDS = new Set\(\['sendTransaction', 'tokenTransfer', 'contractCall'\]\);/);
  for (const method of ['qnet_signMessage', 'qnet_sendTransaction', 'qnet_claimNodeBalance']) assert.ok(provider.includes(`'${method}'`), method);
  const cameraText = 'QNet Wallet uses the camera only to scan an address from a QR code when you tap the scan icon on the Send screen.';
  assert.ok(read(REPO, 'applications/qnet-mobile/ios/QNetMobile/Info.plist').includes(`<key>NSCameraUsageDescription</key>\n\t<string>${cameraText}</string>`));
  assert.ok(read(REPO, 'applications/qnet-mobile/ios/QNetMobile/en.lproj/InfoPlist.strings').includes(`"NSCameraUsageDescription" = "${cameraText}";`));
  // Both Send screens have the scan: the QNet one takes a QNet address, the Solana one an address or a payment request.
  const scan = read(REPO, 'applications/qnet-mobile/src/components/QrScanSheet.js');
  assert.match(scan, /export const readQnetScan = \(text\) => \{/);
  assert.match(read(REPO, 'applications/qnet-mobile/src/screens/SolanaSend.js'), /accessibilityLabel=\{t\('scan_title_solana'\)\}/);
  assert.match(read(REPO, 'applications/qnet-mobile/src/utils/solanaRequest.js'), /export function solanaScanToForm\(text, tokens\) \{/);
  // On Android the app's patch of the camera library swaps its network-reporting decoder and face model for an
  // on-device QR decoder, so "on Android and iOS alike" holds.
  const cameraPatch = read(REPO, 'applications/qnet-mobile/patches/react-native-camera-kit+18.0.1.patch');
  assert.match(cameraPatch, /^-    implementation 'com\.google\.mlkit:barcode-scanning:17\.3\.0'$/m);
  assert.match(cameraPatch, /^-    implementation 'com\.google\.android\.gms:play-services-mlkit-face-detection:17\.1\.0'$/m);
  assert.match(cameraPatch, /^\+    implementation 'com\.google\.zxing:core:3\.5\.4'$/m);
});

// SITE-R3-03: the policy named a receipt of the payment address, the burn, its amount and the node, while a finished
// activation kept its whole record (the wallet's answer and consent, the owner bind, the refund), and the server kept every
// burn and refund signature it sent in memory for two days, which the Retention list did not name. The receipt now keeps
// what the policy names (flow.ts asReceipt), the policy names what an activation's record holds while it runs, and the
// server keeps no list of the transactions it sent.
test('SITE-R3-03: what an activation keeps in the browser and on the server is what the policy says', async () => {
  const { asReceipt } = await import('../cabinet/flow.ts');
  const full = {
    v: 1, pub: '9z1QsPH2k9xpYY9EQYh8EdPjhnt9CXnsxZZkYgT5Km96', key: {}, network: 'testnet', createdAt: 1, updatedAt: 2, stage: 'leftovers',
    burn: { tx: 't', lastValidBlockHeight: 3, amount: 1500, pass: 'p' }, link: { request: {} }, answer: { qnet: 'q', nodeId: 'n', consent: {} },
    submit: { qnet: 'q', nodeId: 'n' }, refund: { dest: 'd', tx: 'r' }, dropped: [{ tx: 'x' }], wallet: 'q',
    hold: { wallet: 'q', pk: 'p', sig: 's', time: 1 }, reservation: { id: 'a', wallet: 'q', until: 1, amount: 1500 },
  };
  const receipt = asReceipt(full, 9);
  // The payment address, the burn, its amount, the node and the wallet; the times, network and stage the page needs.
  assert.deepEqual(receipt, {
    v: 1, pub: full.pub, key: null, network: 'testnet', createdAt: 1, updatedAt: 9, stage: 'done', burn: { tx: 't', lastValidBlockHeight: 3, amount: 1500 },
    link: null, answer: null, submit: null, refund: null, receipt: { qnet: 'q', nodeId: 'n' },
  });
  assert.match(policy, /only a receipt of the activation stays in the browser \(the payment address, the burn, its amount, the node and the wallet's QNet address\)/);
  // The server: no list of sent transactions, and the policy says so.
  const proxy = read(SRC, 'server/cabinet/solana-proxy.ts');
  assert.doesNotMatch(proxy, /FORWARDED_KEPT|forwarded = new Map/);
  assert.match(proxy, /createHmac\('sha256', readKey\)/);
  // SITE M-14: a refund earns its pass only from a payment address a reservation named.
  assert.match(policy, /The server keeps no list of the transactions it passed on: so that a page can read the state of its own, the server gives the page a pass for each burn, and for each transfer back from a payment address one of its reservations named, computed from the transaction's public signature\./);
  assert.match(proxy, /const earns = shape\.kind === 'burn' \|\| \(knownPayer !== undefined && \(await knownPayer\(shape\.payer\)\.catch\(\(\) => false\)\)\);/);
  assert.doesNotMatch(policy, /A registered activation leaves a receipt in the browser \(the payment address, the burn, its amount and the node\)/);
});

// M-1 (06.10): the policy said "no analytics" and named the light node's link records as the only data kept beyond the
// device, while every answer reports how the wake-up messages reached the device and the genesis nodes keep the node's
// latest miss and answer from it. It also left out what QNet Link carries for a burn of the wallet's own Solana address
// (SITE-C-04). What an answer reports, what is kept and for how long, and what the public status shows (H-1) are now
// stated next to the code that does it.
test('M-1: what a light node answer reports, what the network keeps and for how long, and what the public status shows', () => {
  assert.doesNotMatch(policy, /no analytics, no advertising SDK and no tracking of any kind/);
  assert.match(policy, /There is no account, no sign-up, no analytics or advertising SDK, and no tracking for advertising or across other apps and websites\./);
  assert.match(policy, /and the node's answers report how the network's wake-up messages reached the device \(light node answers, below\)\. Those records, the node's latest epoch not counted and latest answer that the network keeps from those reports, and the aiqnet\.io server's record of each node activation/);
  assert.match(policy, /Light node answers\. With each answer the app also reports, for the earlier epochs whose wake-up messages reached the device without an answer, when the network sent the message, when the device received it, and whether QNet Wallet could answer it: for example that it had been closed by a swipe since it was last opened, had not been opened since the phone restarted, held no key for the node, answered after the epoch's check had closed, or answered and the answer did not get through\./);
  assert.match(policy, /The device keeps its record for the last six epochs \(about a day\) and deletes it when the device is unlinked\./);
  assert.match(policy, /while an epoch runs they hold in memory when each wake-up message was sent and taken by the push service, until that epoch's check closes \(about four hours\); then each keeps, for the node, only its latest epoch not counted \(the epoch, the reason, the times of its wake-up message and of a late answer, the delay, the network's refusal code and what the app reported\) and its latest counted answer \(when it arrived, the delay and how long the app took\), each replaced by the next one\./);
  assert.match(policy, /The node's public status, which anyone can read by the node identity, as the Device page of aiqnet\.io does, shows the device's platform and model, the day it was linked, its state, the epoch of its last answer and, for an epoch not counted, the epoch, the reason and whether the wake-up message reached the device; it shows no exact time, delay or what the app reported\. Those are shown only to the node's own keys, in the app on the linked device\./);
  assert.match(policy, /A light node's answer reports: on the device, the last six epochs \(about a day\), deleted when the device is unlinked; on the genesis nodes that wake the device, in memory until the epoch's check closes \(about four hours\), then only the latest epoch not counted and the latest counted answer, each replaced by the next one\./);
  assert.match(onDevice(), /the record of the wake-up messages the device received in the last six epochs \(light node answers, below\)/);
  // On Android the model is the maker and the model, never the name the user gave the device.
  assert.match(policy, /on Android the maker and the model the system reports, never the name you gave the device in its settings; never a serial number, IMEI or other identifier/);
  assert.doesNotMatch(policy, /the device name in the system settings when it reads as a model/);
  // The node: an epoch's ledger in memory until its commit, one row per node of its last miss and last answer, each
  // overwritten by the next, never gossiped; the public form of the device, and the full one for the node's own keys.
  const push = read(REPO, 'development/qnet-integration/src/rpc/light_push.rs');
  assert.match(push, /pub\(crate\) fn take_epoch\(&self, epoch: u64\) -> Vec<\(String, PushEntry\)> \{/);
  assert.match(push, /One node's row here \(`Storage::light_push_row`\): its last miss and its last answer, each overwritten by the\s*\n\/\/\/ next\. Node-local, never gossiped/);
  assert.match(push, /const EPOCH_BLOCKS: u64 = 14_400;/);
  assert.match(push, /json!\(\{ "epoch": self\.epoch, "reason": self\.reason\.as_str\(\), "delivered": self\.delivered\(\) \}\)/);
  const status = read(REPO, 'development/qnet-integration/src/rpc/light_status.rs');
  const publicDevice = status.slice(status.indexOf('pub(crate) fn public_json(&self) -> Value {'), status.indexOf('pub(crate) fn signed_json(&self) -> Value {'));
  for (const field of ['"platform"', '"model"', '"linked_since"', '"last_answer_epoch"', '"state"', '"last_miss"']) assert.ok(publicDevice.includes(field), field);
  assert.doesNotMatch(publicDevice, /last_answer_at|"last_answer"|app_outcome|woken_at/);
  // The app: the record of the last six epochs, gone with the binding.
  const receipts = read(REPO, 'applications/qnet-mobile/src/services/PushReceipts.js');
  assert.match(receipts, /export const REPORT_EPOCHS = 6;/);
  assert.match(receipts, /gone with it \(PushService\.teardownLightNode\)/);
  // The site: neither the route's answer nor its shared cache holds a time, a delay or what the app reported.
  const view = read(SRC, 'lib/cabinet/node-view.ts');
  assert.match(view, /const DEVICE_KEYS = \['platform', 'model', 'linkedSince', 'lastAnswerEpoch', 'state', 'lastMiss'\];/);
  assert.match(read(SRC, 'lib/cabinet/last-miss.ts'), /const MISS_KEYS = \['epoch', 'reason', 'delivered'\];/);
});

test('SITE-C-04: QNet Link names the wallet\'s own Solana address for its burn\'s link, and the answer\'s owner bind goes to the nodes', () => {
  assert.match(policy, /and for the link of a burn made from the wallet's own Solana address also that Solana address, for a confirmation, that hash and the payment address/);
  assert.match(policy, /and for a burn of the wallet's own Solana address the owner bind that Solana key signed for the node, which the page sends with the registration to the aiqnet\.io server and on to the network's nodes, for an unlink,/);
  const link = read(SRC, 'lib/qnet-link.ts');
  assert.match(link, /export const OWN_BURN_REQUEST_KEYS = \['burnTx', 'walletHash', 'check', 'burner'\] as const;/);
  assert.match(link, /const OWN_BURN_CONSENT_KEYS = \['ts', 'pk', 'sig', 'ownerSig'\] as const;/);
});
