// The legal and support pages: the Terms' node activation and Device rules, the privacy policy's device check and what
// the app sends, the Support page's self-service way for a node that does not run on a device (no review step: the owner
// links the node on another device), the link page's three cases; each statement next to the protocol or the code it
// describes. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { CATALOGS } from '../../i18n/catalogs.ts';
import { TEXTS, pageWords } from './texts-helper.mjs';
import { REPO, SRC, read, repo } from './source.mjs';

// A page's text as a reader sees it, in English (its catalog lookups written out).
const text = (path) => pageWords(path).replace(/&quot;/g, '"');
const flat = (s) => s.replace(/\s+/g, ' ');
const protocol = flat(repo('docs/protocols/light-node-messages.md'));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) out.push(...walk(new URL(`${name}/`, dir)));
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(read(url, ''));
  }
  return out;
}

test('Terms: activation outside the app, the app confirms only its own node, and the Device rules', () => {
  const terms = text('app/terms/page.tsx');
  const src = read('app/terms/page.tsx');
  assert.doesNotMatch(terms, /claim the rewards|Node rewards|enter or recover the code|opens it\. In Phase 1/);
  // The places that activate are named only outside the app's view.
  assert.match(src, /\{rich\('terms_activation_1', \{ where: full \? rich\('terms_activation_where', \{ page: <Link href="\/node" translate="no">aiqnet\.io\/node<\/Link> \}\) : t\('terms_activation_where_app'\) \}\)\}/);
  assert.equal(TEXTS.terms_activation_where, 'on {page} or in the QNet Wallet browser extension');
  assert.equal(TEXTS.terms_activation_where_app, 'outside the mobile app');
  assert.match(TEXTS.terms_activation_1, /^Activating a node is an on-chain action you start yourself \{where\}\. In Phase 1 it burns 1DEV tokens/);
  assert.match(terms, /The mobile app burns nothing, sells nothing and uses no activation codes: for a node it signs only a request that you confirm on its own screen, to register its own wallet's light node and run it on that device, or to move the node balance into the wallet; its SOL and 1DEV sends are ordinary transfers that you review and confirm, to an address you choose\./);
  assert.match(terms, /One light node per wallet\./);
  // Device rules: no appeal or review, the node runs on another device.
  assert.match(src, /<section className="doc-sec prose" id="device-rules">\s*<h2>\{t\('terms_device_rules_title'\)\}<\/h2>/);
  assert.equal(TEXTS.terms_device_rules_title, 'Device rules');
  for (const sentence of [
    /A light node runs on one phone or tablet at a time, and one device runs one node\./,
    /Linking a node to a device includes a device check by the device's operating system\./,
    // No operating-system minimum: a device runs a node when its security hardware proves it (protocol section 1).
    /Computers, emulators, modified devices and devices whose security hardware cannot prove the device cannot run a node; on such a device the wallet works as before\./,
    /the node on that device can be paused for up to 30 days; the wallet and the balance already assigned to the node are not affected, and the balance can still be moved into the wallet\./,
    /The node can run on another phone or tablet at any time \(see Support \)\./,
    /Whether a device can run a node may change when Apple, Google or the network change their checks\./,
  ]) assert.match(terms, sentence);
  assert.match(src, /support: <Link href="\/support#device-check">\{t\('support_title'\)\}<\/Link>/);
  // What the protocol says: one device one node, no device needed to move the balance, a pause keeps it claimable.
  assert.match(protocol, /One device runs one node, and one wallet has one node\./);
  assert.match(protocol, /There is no operating-system version minimum\. A device that cannot prove its hardware/);
  assert.doesNotMatch(terms, /Android 1\d|iOS 1\d|or later/);
  assert.match(protocol, /A claim of the node balance needs no device\./);
  assert.match(protocol, /\| `paused` \| stopped until `until_epoch`; the accrued node balance stays claimable \| no \|/);
  assert.match(protocol, /`two_strikes` \| a second foreign read within 7 days with an independent signal → `paused` for 30 days/);
});

test('Privacy: the device check as the protocol defines it, and what the new app sends and keeps', () => {
  const policy = text('app/privacy/page.tsx');
  const check = policy.slice(policy.indexOf('Device check for a light node'), policy.indexOf('Device permissions'));
  assert.ok(check.length > 500);
  for (const sentence of [
    /QNet Wallet asks the device's operating system to prove that the request comes from the genuine app on a real phone or tablet\. The app creates a key in the device's secure hardware; the key never leaves the device\./,
    /on iPhone and iPad from Apple's App Attest and DeviceCheck; on Android from Android key attestation and Google Play Integrity/,
    /a few yes\/no facts about the device type \(for example whether it is a computer or a watch\), and one signature with each node answer/,
    /Google keeps them up to three years after their last use, and Apple until they are reset or Apple deletes them\./,
    /the operating system's proof for 7 days, or 90 days when a check was refused or a node was paused/,
    /The IP address of these requests is used in memory only, to limit requests and to tell a data-centre address from others, and is never stored/,
    /A refusal or a pause never touches your wallet or the balance already assigned to the node, which can still be moved into the wallet, and the node can run on another phone or tablet\./,
    /Legal basis: your consent on the link screen for the device check \(withdrawn by unlinking the device\)/,
  ]) assert.match(check, sentence);
  assert.doesNotMatch(policy, /IP addresses of these requests for 30 days/);
  assert.doesNotMatch(policy, /appeal|person to review|writes that message for you/i);
  // The protocol's evidence: the platform keys and tokens, the device report's booleans, the signature per answer.
  for (const fact of [/DCAppAttestService\.generateKey/, /a DeviceCheck token/, /a Play Integrity classic token/, /"feature_pc":b/, /"watch":b/,
    /Every epoch the app answers with two signatures over the same public anchor/, /keeps the full wallet/]) {
    assert.match(protocol, fact);
  }
  // The Apple and Google processors are named in the sharing section; no price service is left.
  assert.match(policy, /Apple and Google for the device check of a light node/);
  assert.doesNotMatch(policy, /CoinGecko|dollar values|asks GitHub whether a newer version exists/);
});

// The app sends SOL and 1DEV: the policy names every Solana call the app makes, what the transfer carries from a scanned
// payment request, and what the endpoints see.
test('Privacy: the app\'s side as the code has it: token at link time, devnet Solana reads and the transfers it signs, no prices', () => {
  const policy = text('app/privacy/page.tsx');
  assert.match(policy, /The app asks Firebase for a push token only when you link a node on the device, and deletes it when you unlink the device or when the node moves to another device\./);
  assert.doesNotMatch(policy, /builds, signs and sends no Solana transaction|uses Solana for one thing only/);
  const solana = policy.slice(policy.indexOf('Solana. The mobile app'), policy.indexOf('Requests from aiqnet.io to the mobile app.'));
  assert.match(solana, /^Solana\. The mobile app uses Solana for the SOL and 1DEV of your Solana address, on Solana devnet\./);
  assert.match(solana, /It builds the SOL or 1DEV transfer, signs it on the device with the wallet's Solana key once you confirm it, sends it, and then asks for its status by its signature, with the chain's block height, until the network settles it\./);
  assert.match(solana, /A Solana payment request read from a QR code fills in the recipient, the token and the amount; its memo, which the review shows, and its reference addresses go into the transfer, and its label and message are ignored and never shown\./);
  assert.match(solana, /The app uses public Solana RPC endpoints \(Solana devnet today\), so those endpoints see your IP address, your Solana address, the addresses you send to, the amounts and the signed transfers, under their own terms\. When such an endpoint gives the device no answer at all, the app sends the same requests and the signed transfer to the aiqnet\.io server instead, which passes them on to Solana and returns Solana's answers; that server then sees your IP address and the same addresses, amounts and signed transfers, never a key, and does not log them\. The mobile app sells nothing\./);
  assert.match(policy, /A SOL or 1DEV transfer you confirm in the mobile app or the extension is recorded on the Solana blockchain, which is public too, with the memo and reference addresses of a payment request you scanned or pasted for it\./);
  // The extension's own transfers: what it reads, signs, sends and follows, and what the endpoint sees.
  assert.match(policy, /For a SOL or 1DEV transfer you start and confirm, the extension reads what the transfer needs from that endpoint \(the recipient's balance and token accounts, the mint, the fee and a recent block hash\), signs it in the browser, sends it and follows its status by its signature/);
  assert.match(policy, /The app shows no prices and fetches none\./);
  assert.match(policy, /the push token never reaches aiqnet\.io/);
  const mobile = walk(new URL('applications/qnet-mobile/src/', REPO));
  assert.ok(mobile.length > 50);
  const firebase = JSON.parse(repo('applications/qnet-mobile/firebase.json'));
  assert.equal(firebase['react-native'].messaging_auto_init_enabled, false);
  assert.equal(mobile.filter((s) => /messaging\(\)\.getToken\(\)/.test(s)).length, 1, 'one place takes the token');
  // The push channel is that token and nothing else (one Android package, the same file as Google Play's).
  assert.match(policy, /a Firebase Cloud Messaging push token, which the app takes only at that moment/);
  assert.doesNotMatch(policy, /push channel:| endpoint, which the app takes/);
  const nodes = repo('applications/qnet-mobile/src/config/nodes.js');
  assert.match(nodes, /^export const SOLANA_CLUSTER = 'devnet';$/m);
  assert.match(nodes, /^export const SOLANA_RPC_ENDPOINTS = \['https:\/\/api\.devnet\.solana\.com'\];$/m);
  for (const re of [/coingecko/i, /'simulateTransaction'/]) {
    assert.equal(mobile.some((s) => re.test(s)), false, String(re));
  }
  // Every Solana call the app makes, each named by the policy: a call the policy does not name fails here until it does.
  const NAMED = {
    getBalance: /It reads the balance and the token accounts of that address/,
    getTokenAccountsByOwner: /the token accounts of that address/,
    getAccountInfo: /the balance and accounts of the recipient, the token's mint/,
    getMinimumBalanceForRentExemption: /the minimum balance an account keeps/,
    getFeeForMessage: /the network fee of that very transfer/,
    getLatestBlockhash: /and a recent block hash\./,
    getSupply: /Opening SOL or 1DEV on its own screen also reads that token's supply: SOL's total and circulating supply, or the 1DEV mint\./,
    sendTransaction: /signs it on the device with the wallet's Solana key once you confirm it, sends it/,
    getSignatureStatuses: /asks for its status by its signature/,
    getBlockHeight: /with the chain's block height/,
  };
  // One file reaches a Solana endpoint (config/nodes names it), straight or through the site's relay: the app's Solana
  // client. It and every file that takes that client, under any name, are read for the methods they ask.
  const clients = mobile.filter((s) => /\b(?:getSolanaRpcUrl|rotateSolanaRpc)\(|solana\.com|\bSOLANA_RELAY_URL\b/.test(s) && !/^export function getSolanaRpcUrl\(/m.test(s));
  assert.equal(clients.length, 1);
  assert.match(clients[0], /export async function solanaRpc\(method, params\) \{/);
  const users = mobile.filter((s) => /from '[^']*\/SolanaSend';/.test(s) && /\bsolanaRpc\b/.test(s));
  assert.ok(users.length > 0);
  assert.match(repo('applications/qnet-mobile/src/config/nodes.js'), /^export const SOLANA_RELAY_URL = `\$\{EXPLORER_API\}\/api\/cabinet\/solana`;$/m);
  const called = new Set();
  for (const s of [...clients, ...users]) {
    for (const m of s.matchAll(/\b(?:solanaRpc|read|rpc)\('([A-Za-z]+)'/g)) called.add(m[1]);
    for (const m of s.matchAll(/\bmethod: '([a-z][A-Za-z]*)'/g)) called.add(m[1]);
  }
  assert.deepEqual([...called].sort(), Object.keys(NAMED).sort());
  for (const [method, sentence] of Object.entries(NAMED)) assert.match(solana, sentence, method);
  // The key that signs, after the review and the fresh check; what a scanned request puts into the transfer.
  const send = repo('applications/qnet-mobile/src/services/SolanaSend.js');
  const screen = repo('applications/qnet-mobile/src/screens/SolanaSend.js');
  assert.match(repo('applications/qnet-mobile/src/components/WalletManager.js'), /async signSolanaMessage\(message, credential\) \{/);
  assert.match(screen, /if \(!reviewed\) return \{ outcome: 'cancelled' \};\s*if \(!\(await confirmFresh\(/);
  assert.match(screen, /memo: q\.memo,/);
  assert.match(send, /plan = \{ kind: 'sol', from, to: recipient, amount: amountBase, references, memo \};/);
  const request = repo('applications/qnet-mobile/src/utils/solanaRequest.js');
  assert.match(request, /if \(!\['amount', 'spl-token', 'memo'\]\.includes\(name\)\) continue; \/\/ label, message and anything else: ignored/);
  assert.match(repo('applications/qnet-mobile/src/crypto/SolanaTx.js'), /export const MEMO_PROGRAM_ID = /);
  // The store notes say the same of what leaves the device.
  const store = repo('applications/qnet-mobile/store-listing/README.md').replace(/\s+/g, ' ');
  assert.match(store, /a Solana transfer the user confirms goes there to be sent and followed; so do the addresses it pays and the token accounts it reads/);
  // The requests from aiqnet.io are revision 2's five intents with their request fields; a move names the wallet's light
  // or super node.
  assert.match(policy, /A page of aiqnet\.io can ask the QNet Wallet app on your phone or tablet for the wallet's addresses, to confirm that a light node paid from a one-time payment address is for the wallet, to link the wallet's light node to that device \(with the wallet's consent to register it\), to unlink the wallet's node from that device, or to move the balance of the wallet's light or super node into the wallet: the page shows/);
  assert.match(policy, /the burn transaction it concerns \(or none\) and a short hash of the wallet address the page already knows \(or none\), and for the link of a burn made from the wallet's own Solana address also that Solana address, for a confirmation, that hash and the payment address, for an unlink, that hash, for a move, that hash and the node's public identity;/);
  assert.match(policy, /for an unlink, the node identity and whether the network took the change, for a move, the amount and the transaction;/);
  assert.match(policy, /for a confirmation, the wallet's signed reservation \(its public key, signature and time\)/);
  assert.match(policy, /for an unlink, the node identity and whether the network took the change/);
  // The device check ends with the unlink the app on that device confirms and signs; nothing names the removed button.
  assert.match(policy, /Unlinking the device ends the link and deletes the push token on the device: you ask for it on the Device page of aiqnet\.io and confirm it in the app on that device, which signs the change\./);
  assert.doesNotMatch(policy, /Stop on this device/);
  const link = read('lib/qnet-link.ts');
  assert.match(link, /export const INTENTS = \['connect', 'link', 'claim', 'reserve', 'unlink'\] as const;/);
  assert.match(link, /const REQUEST_KEYS = \{\s*link: \['burnTx', 'walletHash', 'check'\], claim: \['walletHash', 'nodeId'\], reserve: \['walletHash', 'burner'\], unlink: \['walletHash'\],\s*\} as const;/);
});

test('Support: the self-service section for a node that does not run on a device; in the app\'s view no platform is named', () => {
  const src = read('app/support/page.tsx');
  assert.match(src, /<section className="doc-sec" id="device-check">/);
  assert.doesNotMatch(src, /SupportRequest|support_device_ref/);
  assert.match(src, /<Link href="\/terms#device-rules">\{t\('support_device_rules_link'\)\}<\/Link>/);
  assert.equal(TEXTS.support_device_rules_link, 'Device rules');
  // Outside the {full && …} blocks nothing names a platform or points to the node pages, in the page or in the
  // text of the keys it shows there.
  const view = src.replace(/^import .*$/gm, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{full && [\s\S]*?\}(?=\n)/g, '');
  const shown = [...view.matchAll(/\b(?:t|say|rich)\('([a-z0-9_]+)'/g)].map((m) => TEXTS[m[1]]);
  assert.ok(shown.length > 20 && shown.every((s) => typeof s === 'string'));
  for (const part of [view, ...shown]) {
    assert.doesNotMatch(part, /iPhone|iPad|Android|\biOS\b/);
    assert.doesNotMatch(part, /href="\/node/);
  }
  assert.equal(TEXTS.support_subtitle, 'QNet Wallet on phones and tablets, and the browser extension');
  // The page has no form, and the policy names none: its website section says nothing of the Support page, in any
  // language.
  assert.doesNotMatch(src, /<form\b/);
  for (const [locale, catalog] of Object.entries(CATALOGS)) assert.ok(!catalog.privacy_website_intro.includes(catalog.support_title), locale);
  // Nothing on the site asks for a review.
  for (const file of ['components/cabinet/NodeDevices.tsx', 'app/terms/page.tsx', 'app/privacy/page.tsx', 'app/support/page.tsx']) {
    assert.doesNotMatch(read(file), /devices_review|appeal|reviews every/i, file);
  }
});

// One Android package, the same Play-signed file from Google Play and from the site. The older Android app installed from
// a file tells its users to move; Support says how, outside the app's view only.
test('Support: the move from the older Android app, restored with the recovery phrase, outside the app\'s view', () => {
  const src = read('app/support/page.tsx');
  assert.match(src, /\{full && \(\s*<section className="doc-sec" id="new-app">/);
  assert.match(TEXTS.support_move, /^An earlier Android build of QNet Wallet installed from a file is a separate, older app, and its last update asks you to move\. Install QNet Wallet from Google Play or from the \{walletPage\}: it is the same app\. Restore the wallet in it with the recovery phrase/);
  // The new app holds no binding of the node, so its Node tab shows none: the new device is linked from My node.
  assert.match(TEXTS.support_move, /To run the wallet's light node in the new app, link the new device on My node \(Device tab\) and confirm in QNet Wallet\.$/);
  assert.match(repo('applications/qnet-mobile/src/screens/NodeTab.js'), /if \(view\.state === 'elsewhere' \|\| view\.state === 'no_device'\) return false;/);
});

test('the link page names the three reasons a browser shows it, and leads back to the node pages', () => {
  const page = read('app/l/page.tsx');
  for (const key of ['l_lead', 'l_reason_missing', 'l_reason_update', 'l_reason_embedded', 'l_only_yours']) {
    assert.match(page, new RegExp(`\\b(?:t|say|rich)\\('${key}'`), key);
  }
  // The node pages of aiqnet.io in the visitor's language.
  assert.match(page, /const nodePage = <a href=\{`\$\{SITE_ORIGIN\}\$\{href\('\/node'\)\}`\} translate="no">aiqnet\.io\/node<\/a>;/);
  assert.match(TEXTS.l_reason_missing, /^QNet Wallet is not installed on this device\. Install it \(see \{walletPage\}\), then tap the button on \{nodePage\} again\.$/);
  assert.match(TEXTS.l_reason_update, /^The request needs a newer QNet Wallet\. Update it, then tap the button on \{nodePage\} again\.$/);
  assert.match(TEXTS.l_reason_embedded, /^The page is open inside another app, such as a messenger\. Open it in the device's own browser/);
  assert.equal(TEXTS.l_only_yours, 'Only continue in the app with a request you started on aiqnet.io yourself, just now.');
});

// A legal page's date is the date of its words: the digest of each page's English text is pinned beside its date, so a
// change of the text fails here until the page carries the day the new text took effect, and the digest is pinned anew.
test('the Terms and the privacy policy carry the date of their current text', () => {
  const PINNED = {
    'app/terms/page.tsx': ['Date.UTC(2026, 10, 2)', '16e5e26aa2274cfe292c30edf866617134e5b8bc04df019772bbebf319970f51'],
    'app/privacy/page.tsx': ['Date.UTC(2026, 10, 3)', 'b6659445f3dc9e1e0e41d5ed32765a44f879863aa68ea3adef1cbe61707de5be'],
  };
  for (const [page, [date, digest]] of Object.entries(PINNED)) {
    const src = read(page);
    assert.ok(src.includes(`\nconst EFFECTIVE = ${date};\n`), `${page}: ${date}`);
    const words = [...src.matchAll(/\b(?:t|say|rich)\('([a-z0-9_]+)'/g)].map((m) => TEXTS[m[1]]);
    assert.ok(words.length > 30 && words.every((w) => typeof w === 'string'), page);
    assert.equal(createHash('sha256').update(words.join('\n')).digest('hex'), digest, `${page}: the text changed; date the page and pin the new digest`);
  }
});
