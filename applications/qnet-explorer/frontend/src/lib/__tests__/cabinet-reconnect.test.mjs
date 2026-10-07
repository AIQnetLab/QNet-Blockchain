// My node takes up the QNet extension's wallet by itself once the extension approved this site: on load the page asks
// only the silent qnet_accounts, never qnet_requestAccounts; a Disconnect in this browser holds until a wallet is
// connected with a tap; a wallet chosen another way (QNet Wallet, a typed address) is never replaced.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DISCONNECTED_KEY, WALLET_KEY, awaitsExtension, extensionReconnect, loadChoice, loadDisconnected, saveChoice, saveDisconnected,
} from '../cabinet/wallet-choice.ts';
import { isEonAddress, readAccounts } from '../qnet-provider.ts';

const SRC = new URL('../../', import.meta.url);
const code = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const EON = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const OTHER = '60b4f3e026e24dcc7d8eonfda2b095a258ab95c1db2c0';
const SOL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL2 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

function memory() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const blocked = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); },
};

test('on load the page asks the extension only the silent qnet_accounts', async () => {
  const calls = [];
  const provider = { request: ({ method }) => { calls.push(method); return Promise.resolve({ qnet: EON, solana: SOL }); } };
  assert.deepEqual(await readAccounts(provider), { qnet: EON, solana: SOL });
  assert.deepEqual(calls, ['qnet_accounts']);
  // The extension: qnet_accounts never opens a window; qnet_requestAccounts asks the user when the site is not approved.
  const ext = readFileSync(new URL('../../../../../qnet-wallet/dist/background/provider.js', import.meta.url), 'utf8');
  assert.match(ext, /case 'qnet_accounts':\s*return \(await accountsFor\(ctx\.origin\)\) \?\? \{\};/);
  assert.match(ext, /case 'qnet_requestAccounts':\s*return \(await accountsFor\(ctx\.origin\)\) \?\? enqueue\(ctx, 'connect', \{\}\);/);
  // The site's wrapper: the asking method has one caller, the context's connect, which only a tap runs.
  const wrapper = code('lib/qnet-provider.ts');
  assert.equal(wrapper.match(/'qnet_requestAccounts'/g)?.length, 1);
  assert.match(wrapper, /export async function readAccounts\(provider: QNetProvider\): Promise<WalletAccounts \| null> \{\s*try \{\s*const result = parseAccounts\(await callProvider\(provider, 'qnet_accounts', PASSIVE_TIMEOUT_MS\)\);/);
  const context = code('contexts/AppContext.tsx');
  assert.equal(context.match(/requestAccounts\(/g)?.length, 1);
  assert.match(context, /const connect = useCallback\(async \(\) => \{\s*if \(!provider \|\| inFlight\.current\) return;[\s\S]{0,160}const result = await requestAccounts\(provider\);/);
  // The answer counts only from the latest step: a read overtaken by another leaves both to it, and every other step
  // (connect, disconnect, the wallet's disconnect event) settles the answer itself, so the cabinet never waits forever.
  assert.match(context, /const current = await readAccounts\(provider\);\s*if \(!alive \|\| mine !== seq\.current\) return;\s*setAccounts\(current\);\s*setAccountsKnown\(true\);/);
  assert.match(context, /const onDisconnect = \(\) => \{\s*\+\+seq\.current;\s*if \(!alive\) return;\s*setAccounts\(null\);\s*setAccountsKnown\(true\);\s*\};/);
  assert.match(context, /const latest = mine === seq\.current;\s*if \(latest\) setAccountsKnown\(true\);\s*if \(!result\.ok\) \{\s*setError\(result\.message\);\s*return;\s*\}\s*if \(latest\) setAccounts\(result\.accounts\);/);
  assert.match(context, /const disconnect = useCallback\(async \(\) => \{\s*\+\+seq\.current;\s*setAccounts\(null\);\s*setAccountsKnown\(true\);/);
  assert.equal(context.match(/setAccountsKnown\(true\)/g)?.length, 4);
  assert.doesNotMatch(context, /qnet_requestAccounts/);
  // The cabinet's provider reads the context's accounts and never asks the wallet anything itself.
  const cabinet = code('components/cabinet/CabinetProvider.tsx');
  assert.doesNotMatch(cabinet, /\bconnect\b|requestAccounts|qnet_|activateNode|claimNodeBalance/);
  assert.match(cabinet, /const \{ providerStatus, providerChannel, accounts, accountsKnown \} = useWallet\(\);/);
  // The connect screen asks the extension only from its button.
  const choice = code('components/cabinet/WalletChoice.tsx');
  assert.equal(choice.match(/connect\(\)/g)?.length, 1);
  assert.match(choice, /const askExtension = \(\) => \{\s*setAskedExtension\(true\);\s*if \(!accounts\) void connect\(\);\s*\};/);
  assert.match(choice, /onClick=\{askExtension\}/);
});

test('the extension\'s wallet is taken up only with nothing chosen, from the extension, and not after a Disconnect', () => {
  assert.ok(isEonAddress(EON) && isEonAddress(OTHER));
  const accounts = { qnet: EON, solana: SOL };
  assert.deepEqual(extensionReconnect(null, 'extension', accounts, false), { qnet: EON, source: 'extension', solana: SOL });
  // Disconnect was the last word in this browser.
  assert.equal(extensionReconnect(null, 'extension', accounts, true), null);
  // The QNet app's in-app browser, or no provider yet: the cabinet takes nothing up by itself.
  assert.equal(extensionReconnect(null, 'mobile', accounts, false), null);
  assert.equal(extensionReconnect(null, null, accounts, false), null);
  // The extension has not approved this site, is locked, or did not answer.
  assert.equal(extensionReconnect(null, 'extension', null, false), null);
  // A wallet chosen another way stays, whichever wallet the extension holds.
  for (const source of ['app', 'app-qr', 'entered']) {
    const chosen = source === 'entered' ? { qnet: OTHER, source } : { qnet: OTHER, source, solana: SOL2 };
    assert.equal(extensionReconnect(chosen, 'extension', accounts, false), null, source);
    assert.equal(extensionReconnect({ ...chosen, qnet: EON }, 'extension', accounts, false), null, `${source}, same wallet`);
  }
  // The extension's own wallet: unchanged while it answers the same, followed when it answers with another.
  assert.equal(extensionReconnect({ qnet: EON, source: 'extension', solana: SOL }, 'extension', accounts, false), null);
  assert.deepEqual(
    extensionReconnect({ qnet: OTHER, source: 'extension', solana: SOL2 }, 'extension', accounts, false),
    { qnet: EON, source: 'extension', solana: SOL },
  );
  // One the extension's activation chose without its Solana address gains it.
  assert.deepEqual(extensionReconnect({ qnet: EON, source: 'extension' }, 'extension', accounts, false), { qnet: EON, source: 'extension', solana: SOL });
  // A lock (no accounts) keeps the remembered wallet.
  assert.equal(extensionReconnect({ qnet: EON, source: 'extension', solana: SOL }, 'extension', null, false), null);
});

test('the cabinet waits for the extension\'s first answer only while that answer may set its wallet', () => {
  const ext = { qnet: OTHER, source: 'extension', solana: SOL2 };
  // Nothing chosen and no Disconnect, or the extension's own wallet (it may follow): wait, until the answer came.
  assert.equal(awaitsExtension(null, 'extension', false, false), true);
  assert.equal(awaitsExtension(ext, 'extension', false, false), true);
  assert.equal(awaitsExtension(null, 'extension', true, false), false);
  assert.equal(awaitsExtension(ext, 'extension', true, false), false);
  // After a Disconnect, or with a wallet chosen another way, the answer changes nothing: no wait.
  assert.equal(awaitsExtension(null, 'extension', false, true), false);
  for (const source of ['app', 'app-qr', 'entered']) assert.equal(awaitsExtension({ qnet: OTHER, source }, 'extension', false, false), false, source);
  // No extension (yet), or the QNet app's in-app browser: no wait.
  assert.equal(awaitsExtension(null, null, false, false), false);
  assert.equal(awaitsExtension(ext, 'mobile', false, false), false);
});

test('a Disconnect is kept in this browser until a tap connects, and blocked storage never throws', () => {
  assert.equal(DISCONNECTED_KEY, 'qnet.cabinet.disconnected');
  assert.notEqual(DISCONNECTED_KEY, WALLET_KEY);
  const s = memory();
  assert.equal(loadDisconnected(s), false);
  saveDisconnected(s, true);
  assert.equal(s.getItem(DISCONNECTED_KEY), '1');
  assert.equal(loadDisconnected(s), true);
  saveDisconnected(s, false);
  assert.equal(s.map.has(DISCONNECTED_KEY), false);
  assert.equal(loadDisconnected(s), false);
  s.setItem(DISCONNECTED_KEY, 'true');
  assert.equal(loadDisconnected(s), false, 'only its own mark counts');
  assert.equal(loadDisconnected(blocked), false);
  assert.doesNotThrow(() => saveDisconnected(blocked, true));
  assert.doesNotThrow(() => saveDisconnected(null, true));
  assert.equal(loadDisconnected(undefined), false);

  // The cabinet's steps over one browser: taken up, Disconnect, the extension still approving, a tap, a reload.
  const accounts = { qnet: EON, solana: SOL };
  let choice = loadChoice(s);
  assert.equal(choice, null);
  choice = extensionReconnect(choice, 'extension', accounts, loadDisconnected(s));
  saveChoice(s, choice);
  assert.deepEqual(loadChoice(s), { qnet: EON, source: 'extension', solana: SOL });
  // Disconnect (forget): the wallet goes, the mark stays.
  s.removeItem(WALLET_KEY);
  saveDisconnected(s, true);
  assert.equal(extensionReconnect(loadChoice(s), 'extension', accounts, loadDisconnected(s)), null);
  // A reload changes nothing.
  assert.equal(extensionReconnect(loadChoice(s), 'extension', accounts, loadDisconnected(s)), null);
  // Connected with a tap (choose): the mark goes; after a later reload the remembered wallet stands.
  saveChoice(s, { qnet: OTHER, source: 'app', solana: SOL2 });
  saveDisconnected(s, false);
  assert.equal(extensionReconnect(loadChoice(s), 'extension', accounts, loadDisconnected(s)), null);
  assert.deepEqual(loadChoice(s), { qnet: OTHER, source: 'app', solana: SOL2 });
});

test('the cabinet: Disconnect sets the mark, a tap lifts it, a typed address and the reconnect never touch it', () => {
  const cabinet = code('components/cabinet/CabinetProvider.tsx');
  assert.match(cabinet, /const channel = providerStatus === 'available' \? providerChannel : null;/);
  assert.match(cabinet, /setChoice\(loadChoice\(storage\)\);\s*setDisconnected\(loadDisconnected\(storage\)\);\s*setLoaded\(true\);/);
  // One step writes the mark before the wallet and then tells the page (the header and My node's pages read both): a
  // tap lifts the mark, Disconnect sets it, a typed address and the reconnect leave it.
  assert.match(cabinet, /function hold\(next: WalletChoice \| null, disconnected\?: boolean\): void \{\s*const storage = localStore\(\);\s*if \(disconnected !== undefined\) saveDisconnected\(storage, disconnected\);\s*if \(next\) saveChoice\(storage, next\);\s*else clearChoice\(storage\);/);
  assert.match(cabinet, /export function chooseWallet\(next: WalletChoice\): void \{\s*hold\(next, next\.source !== 'entered' \? false : undefined\);\s*\}/);
  assert.match(cabinet, /const choose = useCallback\(\(next: WalletChoice\) => chooseWallet\(next\), \[\]\);/);
  assert.match(cabinet, /const forget = useCallback\(\(\) => hold\(null, true\), \[\]\);/);
  assert.match(cabinet, /const keep = useCallback\(\(next: WalletChoice \| null\) => hold\(next\), \[\]\);/);
  assert.match(cabinet, /const leaveView = useCallback\(\(\) => keep\(null\), \[keep\]\);/);
  assert.equal(cabinet.match(/saveDisconnected\(/g)?.length, 1);
  // Every change, the header's included, reaches the provider's state.
  assert.match(cabinet, /const onHeld = \(\) => \{\s*if \(!heldHere\) return;\s*setChoice\(heldHere\.choice\);\s*setDisconnected\(heldHere\.disconnected\);\s*\};/);
  // The reconnect writes through `keep`, never `choose`, so it does not count as a tap; the pages see its wallet in the
  // same render (no earlier wallet for a moment).
  assert.match(cabinet, /const taken = loaded \? extensionReconnect\(choice, channel, accounts, disconnected\) : null;\s*useEffect\(\(\) => \{\s*if \(taken\) keep\(taken\);\s*\}, \[taken, keep\]\);\s*const current = taken \?\? choice;/);
  assert.match(cabinet, /ready, choice: current, nodeId: cv\?\.nodeId \?\? null, walletHash: cv\?\.walletHash \?\? null, viewOnly: current\?\.source === 'entered'/);
  // A Disconnect or another wallet in another tab reaches this tab's pages too (SITE-F11).
  assert.match(cabinet, /if \(event\.key !== null && event\.key !== WALLET_KEY && event\.key !== DISCONNECTED_KEY && event\.key !== ACTIVATIONS_KEY\) return;\s*heldHere = null;/);
  assert.match(cabinet, /window\.addEventListener\('storage', onStorage\);/);
  // No connect screen or earlier wallet for a moment while the extension answers.
  assert.match(cabinet, /const ready = loaded && !awaitsExtension\(choice, channel, accountsKnown, disconnected\);/);
  // The provider and the header decide with the one rule.
  assert.equal(cabinet.match(/extensionReconnect\(/g)?.length, 2);
  // Every change of the remembered wallet goes through `keep`, which tells the header.
  assert.equal(cabinet.match(/window\.dispatchEvent\(new Event\(HELD_EVENT\)\);/g)?.length, 1);
  assert.equal(cabinet.match(/saveChoice\(/g)?.length, 1);
  // Disconnect on the wallet card forgets the wallet (and ends the extension's approval when it is that wallet).
  const frame = code('components/cabinet/CabinetFrame.tsx');
  assert.match(frame, /if \(choice\.source === 'extension' && accounts\?\.qnet === choice\.qnet\) void disconnect\(\);\s*forget\(\);/);
  assert.equal(frame.match(/forget\(\)/g)?.length, 1);
  // "Connect your wallet" on a typed address is no Disconnect: it leaves the view without a mark.
  const first = code('components/cabinet/ConnectFirst.tsx');
  assert.match(first, /const \{ leaveView \} = useCabinet\(\);/);
  assert.doesNotMatch(first, /forget/);
});

test('the header shows the wallet My node shows: the remembered one, or the extension\'s it takes up', () => {
  const cabinet = code('components/cabinet/CabinetProvider.tsx');
  assert.match(cabinet, /setKept\(heldHere \?\? \{ choice: loadChoice\(storage\), disconnected: loadDisconnected\(storage\) \}\);/);
  // Another tab's change of the store ends this tab's memory of it.
  assert.match(cabinet, /const onStorage = \(\) => \{\s*heldHere = null;\s*read\(\);\s*\};/);
  assert.match(cabinet, /return \(extensionReconnect\(kept\.choice, channel, accounts, kept\.disconnected\) \?\? kept\.choice\)\?\.qnet \?\? null;/);
  // The same steps on plain inputs.
  const held = (choice, channel, accounts, disconnected) => (extensionReconnect(choice, channel, accounts, disconnected) ?? choice)?.qnet ?? null;
  const accounts = { qnet: EON, solana: SOL };
  assert.equal(held(null, 'extension', accounts, false), EON);
  assert.equal(held(null, 'extension', accounts, true), null, 'after a Disconnect');
  assert.equal(held(null, 'extension', null, false), null, 'not approved or locked');
  assert.equal(held({ qnet: OTHER, source: 'app', solana: SOL2 }, 'extension', accounts, false), OTHER);
  assert.equal(held({ qnet: OTHER, source: 'extension', solana: SOL2 }, 'extension', accounts, false), EON, 'follows the extension');
  assert.equal(held(null, 'mobile', accounts, false), null, 'the in-app browser');
});
