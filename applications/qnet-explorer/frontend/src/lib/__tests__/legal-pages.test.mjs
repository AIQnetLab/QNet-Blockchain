// The legal and support pages after the unified scheme (unified plan SITE-8, technical plan DEV-7 and section 16.3):
// the Terms' node activation and Device rules, the privacy policy's device check and what the new app sends, the
// Support page's self-service way for a node that does not run on a device (owner, 04.10: no review step), the link
// page's three cases; each statement next to the protocol or the code it describes. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { CASE_LABEL, DEVICE_CASES, NOTE_MAX_CHARS, SUPPORT_ADDRESS, cleanNote, deviceCheckMail, looksLikePhrase, normalizeRef } from '../support-request.ts';
import { TEXTS } from '../texts.ts';

const SRC = new URL('../../', import.meta.url);
const REPO = new URL('../../../../../../', import.meta.url);
const read = (base, path) => readFileSync(new URL(path, base), 'utf8').replace(/\r\n/g, '\n');
const text = (path) => read(SRC, path).replace(/<[^>]+>/g, ' ').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const flat = (s) => s.replace(/\s+/g, ' ');
const protocol = flat(read(REPO, 'docs/protocols/light-node-messages.md'));

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
  const src = read(SRC, 'app/terms/page.tsx');
  assert.doesNotMatch(terms, /claim the rewards|Node rewards|enter or recover the code|opens it\. In Phase 1/);
  // The places that activate are named only outside the app's view.
  assert.match(src, /\{full && ' on aiqnet\.io\/node or in the QNet browser extension'\}\{!full && ' outside the mobile app'\}/);
  assert.match(terms, /The mobile app burns nothing, sells nothing and uses no activation codes: for a node it signs only a request that you confirm on its own screen, to register its own wallet's light node and run it on that device, or to move the node balance into the wallet; its SOL and 1DEV sends are ordinary transfers that you review and confirm, to an address you choose\./);
  assert.match(terms, /One light node per wallet\./);
  // Device rules (red team 2, section 4.5); owner, 04.10: no appeal or review, the node runs on another device.
  assert.match(src, /<div className="privacy-section" id="device-rules">\s*<h3>Device rules<\/h3>/);
  for (const sentence of [
    /A light node runs on one phone or tablet at a time, and one device runs one node\./,
    /Linking a node to a device includes a device check by the device's operating system\./,
    // No operating-system minimum: a device runs a node when its security hardware proves it (protocol section 1).
    /Computers, emulators, modified devices and devices whose security hardware cannot prove the device cannot run a node; on such a device the wallet works as before\./,
    /the node on that device can be paused for up to 30 days; the wallet and the balance already assigned to the node are not affected, and the balance can still be moved into the wallet\./,
    /The node can run on another phone or tablet at any time \(see Support \)\./,
    /Whether a device can run a node may change when Apple, Google or the network change their checks\./,
  ]) assert.match(terms, sentence);
  assert.match(src, /<a href=\{`\$\{keepFromApp\('\/support', fromApp\)\}#device-check`\}>Support<\/a>/);
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

// 29.09: the app sends SOL and 1DEV. The policy said it built, signed and sent no Solana transaction; it now names every
// Solana call the app makes, what the transfer carries from a scanned payment request, and what the endpoints see.
test('Privacy: the app\'s side as the code has it: token at link time, devnet Solana reads and the transfers it signs, no prices', () => {
  const policy = text('app/privacy/page.tsx');
  assert.match(policy, /The app asks Firebase for a push token only when you link a node on the device, and deletes it when you unlink the device or when the node moves to another device\./);
  assert.doesNotMatch(policy, /builds, signs and sends no Solana transaction|uses Solana for one thing only/);
  const solana = policy.slice(policy.indexOf('Solana. The mobile app'), policy.indexOf('Requests from aiqnet.io to the mobile app.'));
  assert.match(solana, /^Solana\. The mobile app uses Solana for the SOL and 1DEV of your Solana address, on Solana devnet\./);
  assert.match(solana, /It builds the SOL or 1DEV transfer, signs it on the device with the wallet's Solana key once you confirm it, sends it, and then asks for its status by its signature, with the chain's block height, until the network settles it\./);
  assert.match(solana, /A Solana payment request read from a QR code fills in the recipient, the token and the amount; its memo, which the review shows, and its reference addresses go into the transfer, and its label and message are ignored and never shown\./);
  assert.match(solana, /The app uses public Solana RPC endpoints \(Solana devnet today\), so those endpoints see your IP address, your Solana address, the addresses you send to, the amounts and the signed transfers, under their own terms\. The mobile app sells nothing\./);
  assert.match(policy, /A SOL or 1DEV transfer you confirm in the mobile app or the extension is recorded on the Solana blockchain, which is public too, with the memo and reference addresses of a payment request you scanned or pasted for it\./);
  // The extension's own transfers (SITE-F1): what it reads, signs, sends and follows, and what the endpoint sees.
  assert.match(policy, /For a SOL or 1DEV transfer you start and confirm, the extension reads what the transfer needs from that endpoint \(the recipient's balance and token accounts, the mint, the fee and a recent block hash\), signs it in the browser, sends it and follows its status by its signature/);
  assert.match(policy, /The app shows no prices and fetches none\./);
  assert.match(policy, /the push token never reaches aiqnet\.io/);
  const mobile = walk(new URL('applications/qnet-mobile/src/', REPO));
  assert.ok(mobile.length > 50);
  const firebase = JSON.parse(read(REPO, 'applications/qnet-mobile/firebase.json'));
  assert.equal(firebase['react-native'].messaging_auto_init_enabled, false);
  assert.equal(mobile.filter((s) => /messaging\(\)\.getToken\(\)/.test(s)).length, 1, 'one place takes the token');
  // The push channel is that token and nothing else (one Android package, the same file as Google Play's).
  assert.match(policy, /a Firebase Cloud Messaging push token, which the app takes only at that moment/);
  assert.doesNotMatch(policy, /push channel:| endpoint, which the app takes/);
  const nodes = read(REPO, 'applications/qnet-mobile/src/config/nodes.js');
  assert.match(nodes, /^export const SOLANA_CLUSTER = 'devnet';$/m);
  assert.match(nodes, /^export const SOLANA_RPC_ENDPOINTS = \['https:\/\/api\.devnet\.solana\.com'\];$/m);
  for (const re of [/coingecko/i, /'simulateTransaction'/]) {
    assert.equal(mobile.some((s) => re.test(s)), false, String(re));
  }
  // Every Solana call the app makes (services/SolanaSend and the balance in WalletManager), each named by the policy:
  // a call the policy does not name fails here until it does.
  const NAMED = {
    getBalance: /It reads the balance and the token accounts of that address/,
    getTokenAccountsByOwner: /the token accounts of that address/,
    getAccountInfo: /the balance and accounts of the recipient, the token's mint/,
    getMinimumBalanceForRentExemption: /the minimum balance an account keeps/,
    getFeeForMessage: /the network fee of that very transfer/,
    getLatestBlockhash: /and a recent block hash\./,
    sendTransaction: /signs it on the device with the wallet's Solana key once you confirm it, sends it/,
    getSignatureStatuses: /asks for its status by its signature/,
    getBlockHeight: /with the chain's block height/,
  };
  // Only two files reach a Solana endpoint (config/nodes names them), and nothing else calls the send module's RPC
  // helper, so every method either one names is every call the app makes.
  const clients = mobile.filter((s) => /\b(?:getSolanaRpcUrl|rotateSolanaRpc)\(|solana\.com/.test(s) && !/^export function getSolanaRpcUrl\(/m.test(s));
  assert.equal(clients.length, 2);
  assert.equal(mobile.filter((s) => /\bsolanaRpc\(/.test(s)).length, 1);
  const called = new Set();
  for (const s of clients) {
    for (const m of s.matchAll(/\b(?:solanaRpc|read)\('([A-Za-z]+)'/g)) called.add(m[1]);
    for (const m of s.matchAll(/\bmethod: '([a-z][A-Za-z]*)'/g)) called.add(m[1]);
  }
  assert.deepEqual([...called].sort(), Object.keys(NAMED).sort());
  for (const [method, sentence] of Object.entries(NAMED)) assert.match(solana, sentence, method);
  // The key that signs, after the review and the fresh check; what a scanned request puts into the transfer.
  const send = read(REPO, 'applications/qnet-mobile/src/services/SolanaSend.js');
  const screen = read(REPO, 'applications/qnet-mobile/src/screens/SolanaSend.js');
  assert.match(read(REPO, 'applications/qnet-mobile/src/components/WalletManager.js'), /async signSolanaMessage\(message, credential\) \{/);
  assert.match(screen, /if \(!reviewed\) return \{ outcome: 'cancelled' \};\s*if \(!\(await confirmFresh\(/);
  assert.match(screen, /memo: q\.memo,/);
  assert.match(send, /plan = \{ kind: 'sol', from, to: recipient, amount: amountBase, references, memo \};/);
  const request = read(REPO, 'applications/qnet-mobile/src/utils/solanaRequest.js');
  assert.match(request, /if \(!\['amount', 'spl-token', 'memo'\]\.includes\(name\)\) continue; \/\/ label, message and anything else: ignored/);
  assert.match(read(REPO, 'applications/qnet-mobile/src/crypto/SolanaTx.js'), /export const MEMO_PROGRAM_ID = /);
  // The store notes say the same of what leaves the device.
  const store = read(REPO, 'applications/qnet-mobile/store-listing/README.md').replace(/\s+/g, ' ');
  assert.match(store, /a Solana transfer the user confirms goes there to be sent and followed; so do the addresses it pays and the token accounts it reads/);
  // The requests from aiqnet.io are revision 2's five intents with their request fields.
  assert.match(policy, /A page of aiqnet\.io can ask the QNet app on your phone or tablet for the wallet's addresses, to confirm that a light node paid from a one-time payment address is for the wallet, to link the wallet's light node to that device \(with the wallet's consent to register it\), to unlink the wallet's node from that device, or to move the node balance into the wallet/);
  assert.match(policy, /the burn transaction it concerns \(or none\) and a short hash of the wallet address the page already knows \(or none\), and for the link of a burn made from the wallet's own Solana address also that Solana address, for a confirmation, that hash and the payment address, for an unlink, that hash;/);
  assert.match(policy, /for a confirmation, the wallet's signed reservation \(its public key, signature and time\)/);
  assert.match(policy, /for an unlink, the node identity and whether the network took the change/);
  // The device check ends with the unlink the app on that device confirms and signs; nothing names the removed button.
  assert.match(policy, /Unlinking the device ends the link and deletes the push token on the device: you ask for it on the Device page of aiqnet\.io and confirm it in the app on that device, which signs the change\./);
  assert.doesNotMatch(policy, /Stop on this device/);
  const link = read(SRC, 'lib/qnet-link.ts');
  assert.match(link, /export const INTENTS = \['connect', 'link', 'claim', 'reserve', 'unlink'\] as const;/);
  assert.match(link, /const REQUEST_KEYS = \{\s*link: \['burnTx', 'walletHash', 'check'\], claim: \['walletHash'\], reserve: \['walletHash', 'burner'\], unlink: \['walletHash'\],\s*\} as const;/);
});

test('the device-check request: the reference only, the note cleaned, never a recovery phrase, nothing sent from the page', () => {
  assert.equal(SUPPORT_ADDRESS, 'support@aiqnet.io');
  assert.equal(normalizeRef('AB12 cd34'), 'ab12cd34');
  for (const bad of ['', 'ab12cd3', 'ab12cd345', 'gh12cd34', 'ab12-cd34']) assert.equal(normalizeRef(bad), null, bad);
  assert.equal(cleanNote(` a\u0000b\tc\r\nd \u007f`), 'abc\nd');
  assert.equal(cleanNote('x'.repeat(NOTE_MAX_CHARS + 50)).length, NOTE_MAX_CHARS);
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.equal(looksLikePhrase(phrase), true);
  assert.equal(looksLikePhrase(`My note: ${phrase} thanks`), true);
  assert.equal(looksLikePhrase('The Node tab says the node is paused since I moved to a new phone last week.'), false);
  // SITE-R1-07: a phrase copied from notes, with a capital, commas or numbering, is caught as the plain one is.
  const words = phrase.split(' ');
  for (const written of [
    'Abandon ability able about above absent absorb abstract absurd abuse access accident',
    words.join(', '),
    words.join(','),
    words.map((w, i) => `${i + 1}. ${w}`).join(' '),
    words.map((w, i) => `${i + 1}) ${w}`).join('\n'),
    words.map((w, i) => `${i + 1}${w}`).join(' '),
    words.map((w) => w.toUpperCase()).join(' - '),
    `Here it is: "${words.slice(0, 6).join(' ')}\n${words.slice(6).join(' ')}".`,
  ]) {
    assert.equal(looksLikePhrase(written), true, written);
    assert.deepEqual(deviceCheckMail({ ref: 'ab12cd34', kind: 'other', note: written }), { ok: false, reason: 'phrase' }, written);
  }
  // Ordinary notes still go, in any language and with punctuation.
  for (const note of [
    'Hello. The node shows paused after I restored the phone from a backup; it was fine for two months before that.',
    'Bought it used, factory reset, Play Store updated. Still says it cannot run a node.',
    'Нода на паузе после обновления системы, телефон тот же самый уже год, ничего не менял и не устанавливал.',
    words.slice(0, 11).join(' '),
  ]) {
    assert.equal(looksLikePhrase(note), false, note);
  }

  assert.deepEqual(deviceCheckMail({ ref: 'zz', kind: 'paused', note: '' }), { ok: false, reason: 'ref' });
  assert.deepEqual(deviceCheckMail({ ref: 'ab12cd34', kind: 'lost', note: '' }), { ok: false, reason: 'ref' });
  assert.deepEqual(deviceCheckMail({ ref: 'ab12cd34', kind: 'other', note: phrase }), { ok: false, reason: 'phrase' });
  const mail = deviceCheckMail({ ref: 'AB12CD34', kind: 'cant_run', note: 'Bought it used.' });
  assert.equal(mail.ok, true);
  const url = new URL(mail.href);
  assert.equal(url.protocol, 'mailto:');
  assert.equal(url.pathname, 'support@aiqnet.io');
  assert.deepEqual([...url.searchParams.keys()], ['subject', 'body']);
  assert.equal(url.searchParams.get('subject'), 'Device check review ab12cd34');
  assert.equal(url.searchParams.get('body'), 'Reference: ab12cd34\nThis device can\'t run a node.\n\nBought it used.\n\nPlease review the device check of my node.');
  for (const c of DEVICE_CASES) assert.ok(CASE_LABEL[c].length > 10, c);

  const form = read(SRC, 'components/SupportRequest.tsx');
  assert.doesNotMatch(form, /\bfetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB|action=|method=/);
  assert.match(form, /<a className="qnet-button activate-primary" href=\{mail\.href\}>\{t\('support_form_write'\)\}<\/a>/);
  assert.equal(TEXTS.support_form_write, 'Write the email');
  // The form speaks the page's language; the message stays English for the person who answers it.
  for (const c of DEVICE_CASES) assert.equal(TEXTS[`support_case_${c}`], CASE_LABEL[c], c);
  assert.match(form, /onSubmit=\{\(e\) => e\.preventDefault\(\)\}/);
  // The reference is what the protocol calls `ref`: 8 hex digits for support tickets.
  assert.match(protocol, /\| `ref` \| first 8 hex of SHA3-256\(`qnet_dev_ref:v1\\\|` ‖ `nonce` ‖ `device_tag`\)/);
  assert.match(protocol, /the paused and "can't run" screens, support tickets/);
});

test('Support: the self-service section for a node that does not run on a device; in the app\'s view no platform is named', () => {
  const src = read(SRC, 'app/support/page.tsx');
  assert.match(src, /<div className="privacy-section" id="device-check">/);
  assert.doesNotMatch(src, /SupportRequest|support_device_ref/);
  assert.match(src, /<a href=\{`\$\{here\('\/terms'\)\}#device-rules`\}>\{t\('support_device_rules_link'\)\}<\/a>/);
  assert.equal(TEXTS.support_device_rules_link, 'Device rules');
  // Outside the {full && …} blocks nothing names a platform or points to the node pages, in the page or in the
  // text of the keys it shows there.
  const view = src.replace(/^import .*$/gm, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{full && [\s\S]*?\}(?=\n)/g, '');
  const shown = [...view.matchAll(/\b(?:t|rich)\('([a-z0-9_]+)'/g)].map((m) => TEXTS[m[1]]);
  assert.ok(shown.length > 20 && shown.every((s) => typeof s === 'string'));
  for (const part of [view, ...shown]) {
    assert.doesNotMatch(part, /iPhone|iPad|Android|\biOS\b/);
    assert.doesNotMatch(part, /href="\/node/);
  }
  assert.equal(TEXTS.support_subtitle, 'QNet Wallet on phones and tablets, and the browser extension');
  // Nothing on the site asks for a review.
  for (const file of ['components/cabinet/NodeDevices.tsx', 'app/terms/page.tsx', 'app/privacy/page.tsx', 'app/support/page.tsx']) {
    assert.doesNotMatch(read(SRC, file), /devices_review|appeal|reviews every/i, file);
  }
});

// Owner decision 26.09: one Android package, the same Play-signed file from Google Play and from the site. The older
// Android app installed from a file tells its users to move; Support says how, outside the app's view only.
test('Support: the move from the older Android app, restored with the recovery phrase, outside the app\'s view', () => {
  const src = read(SRC, 'app/support/page.tsx');
  assert.match(src, /\{full && \(\s*<div className="privacy-section" id="new-app">/);
  assert.match(TEXTS.support_move, /^An earlier Android build of QNet Wallet installed from a file is a separate, older app, and its last update asks you to move\. Install QNet Wallet from Google Play or from the \{walletPage\}: it is the same app\. Restore the wallet in it with the recovery phrase/);
  assert.match(TEXTS.support_move, /To run the wallet's light node in the new app, open its Node tab and choose Use this device\.$/);
  // The app's own words for its tab and its button.
  const app = read(REPO, 'applications/qnet-mobile/src/i18n/locales/en.js');
  assert.match(app, /^\s*node_use: 'Use this device',$/m);
  assert.match(app, /^\s*tab_node: 'Node',$/m);
});

test('the link page names the three reasons a browser shows it, and leads back to the node pages', () => {
  const page = read(SRC, 'app/l/page.tsx');
  for (const key of ['l_lead', 'l_reason_missing', 'l_reason_update', 'l_reason_embedded', 'l_only_yours']) {
    assert.match(page, new RegExp(`\\b(?:t|rich)\\('${key}'`), key);
  }
  assert.match(page, /const nodePage = <a href=\{`\$\{SITE_ORIGIN\}\/node`\}>aiqnet\.io\/node<\/a>;/);
  assert.match(TEXTS.l_reason_missing, /^QNet Wallet is not installed on this device\. Install it \(see \{walletPage\}\), then tap the button on \{nodePage\} again\.$/);
  assert.match(TEXTS.l_reason_update, /^The request needs a newer QNet Wallet\. Update it, then tap the button on \{nodePage\} again\.$/);
  assert.match(TEXTS.l_reason_embedded, /^The page is open inside another app, such as a messenger\. Open it in the device's own browser/);
  assert.equal(TEXTS.l_only_yours, 'Only continue in the app with a request you started on aiqnet.io yourself, just now.');
});
