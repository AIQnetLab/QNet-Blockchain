// What the node cabinet shows of the QNet extension (src/lib/cabinet/extension-view.ts, the texts
// src/lib/texts.ts and components/cabinet/ExtensionActivate.tsx and NodeClaim.tsx): the words of every
// answer and failure, the hold while a burn may be on its way, a light node shown as registered only from the
// chain, the claim's report; and the one rule of the QNet app's view (src/lib/activate-view.ts). /activate is only
// a redirect now (next.config.js); the header and the other pages of the app's view are in in-app-pages.test.mjs.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IN_APP_NAV, isInAppBrowser, keepFromApp, openedFromApp, showsActivationContent } from '../activate-view.ts';
import {
  answerKind,
  answerMayHaveBurned,
  claimErrorKey,
  claimReport,
  errorKey,
  extensionMayHaveBurned,
  failureKey,
  headingKey,
  leadKey,
  recordsLightNode,
} from '../cabinet/extension-view.ts';
import { TEXTS } from '../texts.ts';
import { ERROR_CODES, LINK_ERRORS, validateActivation } from '../qnet-link.ts';
import { WALLET_APK_ENV, walletApkUrl } from '../../server/wallet-apk.ts';
import { VECTORS } from './link-helpers.mjs';

const code = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const has = (key) => Object.prototype.hasOwnProperty.call(TEXTS, key);
const plain = (name) => JSON.parse(VECTORS.cases.find((c) => c.name === name).plaintext);
const answer = (status, error) => ({ v: 1, intent: 'activate', status, ...(error ? { error } : {}) });

test('every error code has the extension\'s own text; NO_WALLET, HISTORY_TOO_LONG, BURN_UNUSABLE and INTERNAL say what they are', () => {
  for (const c of ERROR_CODES) {
    const key = errorKey(c);
    assert.ok(has(key), key);
    assert.ok(TEXTS[key].length > 20, key);
    // The extension answers for itself: no word of another wallet.
    assert.doesNotMatch(TEXTS[key], /\bthe app\b|QNet app|here or in/i, key);
  }
  assert.equal(TEXTS.ext_error_NO_WALLET, 'The extension has no wallet yet. Create or import one in the extension, then start again.');
  assert.doesNotMatch(TEXTS.ext_error_HISTORY_TOO_LONG, /could not reach Solana/);
  assert.match(TEXTS.ext_error_HISTORY_TOO_LONG, /Nothing was burned\. The wallet keeps what it checked: start again to continue the search\.$/);
  assert.match(TEXTS.ext_error_BURN_UNUSABLE, /^This wallet already burned 1DEV for a node in a form no Light or Super activation code comes from/);
  assert.match(TEXTS.ext_error_BURN_UNUSABLE, /The network counts that burn as the wallet's one activation\. Nothing was burned\. Do not start another activation of this wallet\./);
  // INTERNAL does not say whether a burn was sent, so the page claims neither.
  assert.doesNotMatch(TEXTS.ext_error_INTERNAL, /burn/i);
  for (const c of ['PRICE_UNAVAILABLE', 'INSUFFICIENT_TOKENS', 'SIMULATION_FAILED', 'NODE_EXISTS']) assert.match(TEXTS[errorKey(c)], /Nothing was burned\.$/, c);
  assert.match(TEXTS.ext_error_TX_FAILED, /No tokens were burned\.$/);
  for (const error of ['HISTORY_TOO_LONG', 'BURN_UNUSABLE']) {
    assert.equal(validateActivation(JSON.stringify(answer('error', error)), 'light').ok, true, error);
  }
});

test('a burn may be on its way after a pending answer, an error that does not rule it out, or an unknown outcome', () => {
  assert.equal(extensionMayHaveBurned({ ok: true, answer: answer('pending') }), true);
  for (const error of ['BURN_IN_PROGRESS', 'INTERNAL']) {
    assert.equal(answerMayHaveBurned(answer('error', error)), true, error);
    assert.equal(extensionMayHaveBurned({ ok: true, answer: answer('error', error) }), true, error);
  }
  for (const failure of ['timeout', 'failed', 'unverifiable', 'disconnected']) assert.equal(extensionMayHaveBurned({ ok: false, failure }), true, failure);
  for (const status of ['ok', 'exists', 'rejected']) assert.equal(extensionMayHaveBurned({ ok: true, answer: answer(status) }), false, status);
  for (const error of ERROR_CODES.filter((c) => c !== 'BURN_IN_PROGRESS' && c !== 'INTERNAL')) {
    assert.equal(extensionMayHaveBurned({ ok: true, answer: answer('error', error) }), false, error);
  }
  for (const failure of ['rejected', 'cooldown', 'unauthorized', 'unsupported']) assert.equal(extensionMayHaveBurned({ ok: false, failure }), false, failure);
  assert.match(TEXTS.ext_in_flight, /^The extension may still be sending this wallet's burn\. Do not start another activation of this wallet until the burn is final on Solana; the extension then shows the code on its Activate tab\.$/);
});

// XP-R5-03: a burn of this device that another device's older burn beat went through; the page never says "nothing
// was burned" of it.
test('every answer\'s heading and lead are site texts; a superseded burn', () => {
  const every = VECTORS.cases.map((c) => JSON.parse(c.plaintext)).filter((a) => a.intent === 'activate');
  for (const a of every) {
    assert.ok(has(headingKey(a)), `${a.status} heading`);
    assert.ok(has(leadKey(a)), `${a.status} lead`);
    assert.ok(TEXTS[leadKey(a)].length > 20);
  }
  const superseded = plain('activate-super-exists-superseded');
  assert.equal(answerKind(superseded), 'superseded');
  assert.equal(TEXTS[headingKey(superseded)], 'An older burn is this wallet\'s activation');
  assert.doesNotMatch(TEXTS[leadKey(superseded)], /Nothing was burned/i);
  assert.match(TEXTS[leadKey(superseded)], /went through and its 1DEV are destroyed, but an older burn of the wallet, made on another device, is its one activation/);
  assert.equal(answerMayHaveBurned(superseded), false, 'the superseded burn is final');
  assert.equal(TEXTS[headingKey(plain('activate-super-exists-light'))], 'This wallet already has an activation');
  assert.equal(TEXTS[leadKey(plain('activate-super-exists-light'))], 'Nothing was burned. A wallet has one activation, and this is its code.');

  assert.equal(extensionMayHaveBurned({ ok: true, answer: plain('activate-light-pending') }), true);
  assert.equal(extensionMayHaveBurned({ ok: true, answer: plain('activate-super-exists-light') }), false);
  // Nothing of a 2.x wallet is left on the page (28.09).
  assert.equal(Object.keys(TEXTS).some((key) => /previous/.test(key)), false);
  // A light activation is followed on the chain; a declined or failed one is not.
  assert.equal(recordsLightNode(plain('activate-light-ok')), true);
  assert.equal(recordsLightNode(plain('activate-light-pending')), true);
  assert.equal(recordsLightNode(plain('activate-super-ok')), false);
  assert.equal(recordsLightNode(plain('activate-light-rejected')), false);
});

test('the extension\'s activation on /node/activate: one call, the hold kept for the page\'s life, "Registered" only from the chain', () => {
  const page = code('components/cabinet/ExtensionActivate.tsx');
  // The extension is asked through the context's checked call; no QNet Link request from here.
  assert.match(page, /const result = await activateNode\(requested\);/);
  assert.doesNotMatch(page, /useLinkSession|androidIntentUrl|qrMatrix|link\.start\(/);
  // The hold: set from the checked result only, never cleared.
  assert.match(page, /if \(extensionMayHaveBurned\(result\)\) setBurnInFlight\(true\);/);
  assert.deepEqual(page.match(/setBurnInFlight\(/g), ['setBurnInFlight(']);
  assert.match(page, /\{burnInFlight && <p className="activate-note" role="status">\{t\('ext_in_flight'\)\}<\/p>\}/);
  // Every heading from headingKey; one copy button, for the checked code.
  const view = page.slice(page.indexOf('function AnswerView('), page.indexOf('export default function ExtensionActivate'));
  assert.match(view, /const title = t\(headingKey\(answer\)\);/);
  assert.equal(view.match(/<h4>\{title\}<\/h4>/g)?.length, 3, 'declined, error and result');
  assert.equal(view.match(/<CopyButton /g)?.length, 1);
  assert.match(view, /\{answer\.supersededBurnTx && \(\s*<Field label=\{t\('ext_field_superseded'\)\}>/);
  assert.match(view, /\{recordsLightNode\(answer\) && requested === 'light' \? \(\s*<LightNext qnet=\{answer\.qnet\} since=\{at\} burnFinal=\{answer\.status !== 'pending'\} \/>/);
  // A light node is shown as registered once two genesis nodes list it; until then its record on the network
  // (NextSteps.tsx), then Link a device in numbered steps, then running. A super node gets its server steps.
  assert.match(view, /\) : answer\.nodeType === 'super' && answer\.code \? \(\s*<SuperNext code=\{answer\.code\} burnTx=\{burnTx\} burnAmount=\{burnAmount\} \/>/);
  const light = page.slice(page.indexOf('function LightNext('), page.indexOf('function AnswerView('));
  assert.match(light, /const \{ state \} = useNodeStatus\(lightNodeId\(qnet\)\);/);
  // Or as soon as the network lists it for the cabinet's wallet (owner, 30.09: the page moves on by itself).
  assert.match(light, /const listed = choice\?\.qnet === qnet && view\.nodes\.includes\('light'\);/);
  assert.match(light, /const registered = listed \|\| \(state\.phase === 'ok' && nodeState\(state\.value\) !== 'none' && nodeState\(state\.value\) !== 'pending'\);/);
  assert.match(light, /\{registered \? \(\s*<>\s*<p className="activate-result">\{t\('ext_light_registered'\)\}<\/p>\s*\{linked \? <p>\{t\(offline \? 'next_offline' : waiting \? 'next_device_pending' : 'next_running'\)\}<\/p> : <LinkPhone \/>\}/);
  assert.match(light, /const linked = state\.phase === 'ok' && isLinkedState\(nodeState\(state\.value\)\);/);
  assert.match(light, /const waiting = state\.phase === 'ok' && nodeState\(state\.value\) === 'device_pending';/);
  assert.match(light, /const offline = state\.phase === 'ok' && nodeState\(state\.value\) === 'offline';/);
  assert.match(light, /<Recording qnet=\{qnet\} since=\{since\} burnFinal=\{burnFinal\} pending=\{pending\} \/>/);
  // A browser without the extension is never sent to it for a light node (owner, 06.10).
  assert.equal(has('ext_light_not_listed'), false);
  // The extension answers aiqnet.io only.
  assert.match(page, /const ok = origin === SITE_ORIGIN \|\| LOCAL_ORIGIN_RE\.test\(origin\);/);
  // Offered only when the extension is there, keyed by the wallet; the node type and the burn only in the state `none`
  // (R1, R6): neither another type nor Try again brings the button back otherwise.
  const activate = code('components/cabinet/NodeActivate.tsx');
  // Audit M4: the extension burns for its own wallet only, so its activation is offered only when it holds the chosen
  // wallet; one with another wallet is said, never offered.
  assert.match(activate, /const extensionHolds = extension && choice !== null && \(choice\.source === 'extension' \|\| accounts\?\.qnet === choice\.qnet\);/);
  assert.match(activate, /\{extensionHolds && <ExtensionActivate key=\{choice\?\.qnet \?\? ''\} offer onAnswered=\{\(\) => setExtensionAnswered\(true\)\} \/>\}/);
  assert.match(activate, /\{extension && !extensionHolds && <div className="activate-card"><p>\{t\('act_extension_other_wallet'\)\}<\/p><\/div>\}/);
  assert.doesNotMatch(activate, /\{extension && <ExtensionActivate key=\{choice\?\.qnet \?\? ''\} offer onAnswered/);
  assert.match(activate, /\{extension && <ExtensionActivate key=\{choice\?\.qnet \?\? ''\} offer=\{false\} onAnswered=\{\(\) => setExtensionAnswered\(true\)\} \/>\}/);
  assert.match(activate, /const offer = view\.state === 'none';/);
  assert.match(page, /const choose = \(next: NodeType\) => \{\s*if \(busy \|\| !offer \|\| next === nodeType\) return;/);
  assert.match(page, /const run = async \(\) => \{\s*if \(busy \|\| !offer\) return;/);
  assert.match(page, /\{ext\.phase === 'idle' && offer && \(/);
  assert.match(page, /const again = offer && \(ext\.phase === 'failed' \|\| \(ext\.phase === 'done' && \(ext\.answer\.status === 'rejected' \|\| ext\.answer\.status === 'error'\)\)\);/);
  // After any answer every source is read again.
  assert.match(page, /onAnswered\?\.\(\);\s*refreshActivation\(\);/);
  // ?type=super preselects the super node.
  assert.match(page, /setNodeType\(requestedType\(window\.location\.search\)\);/);
});

// Owner, 29.09: the answer stays on screen (no Done), the cabinet keeps it for its wallet, and the page shows it again.
test('the extension\'s answer stays: kept for its wallet, its code shown again on the next visit from every source, no Done', () => {
  const page = code('components/cabinet/ExtensionActivate.tsx');
  assert.doesNotMatch(page, /ext_done/);
  assert.equal(has('ext_done'), false);
  assert.match(page, /if \(result\.ok\) keepActivation\(result\.answer\);/);
  assert.match(page, /\{ext\.phase === 'done' && <AnswerView answer=\{ext\.answer\} requested=\{ext\.nodeType\} at=\{ext\.at\} \/>\}/);
  // A declined request, an error answer or a failed call offers Try again, only while the wallet has nothing anywhere.
  assert.match(page, /\{again && <button type="button" className="qnet-button secondary" onClick=\{\(\) => setExt\(\{ phase: 'idle' \}\)\}>\{t\('try_again'\)\}<\/button>\}/);
  assert.match(page, /\{ext\.phase === 'failed' && <p className="activate-error" role="alert">\{t\(failureKey\(ext\.failure, 'activate'\)\)\}<\/p>\}/);
  // The next visit: the code comes back through the wallet's view (the site's record, the extension, the kept answer),
  // on the Overview and the Activate page (NextSteps.tsx), not through a window.
  const steps = code('components/cabinet/NextSteps.tsx');
  assert.match(steps, /return <Burned burn=\{view\.burn\} qnet=\{choice\.qnet\} \/>;/);
  assert.match(steps, /<span className="activate-code">\{burn\.code\}<\/span> <CopyButton value=\{burn\.code\} \/>/);
});

// Owner, 29.09: after the code, the next step. "Record on the network" asks the extension again only after a few minutes
// without the record, only the extension that holds this wallet, and keeps its answer; elsewhere the page says where.
test('the record on the network: its progress, and Record on the network after a few minutes, from the wallet\'s own extension', () => {
  const steps = code('components/cabinet/NextSteps.tsx');
  assert.match(steps, /export const RECORD_AGAIN_MS = 3 \* 60_000;/);
  assert.match(steps, /const late = now - from >= RECORD_AGAIN_MS;/);
  assert.match(steps, /const holds = extension && \(accounts \? accounts\.qnet === qnet : choice\?\.source === 'extension' && choice\.qnet === qnet\);/);
  assert.match(steps, /const result = await activateNode\('light'\);/);
  assert.equal(steps.match(/activateNode\(/g)?.length, 1);
  assert.match(steps, /keepActivation\(answer\);/);
  assert.match(steps, /<p className="activate-note">\{t\('next_record_other_wallet'\)\}<\/p>/);
  assert.equal(TEXTS.next_record_again, 'Record on the network');
  assert.match(TEXTS.next_record_again_lead, /nothing is burned again/);
  // "Nothing is burned again" only for a final burn; a registration the extension did not make is not asked of it.
  assert.match(steps, /\{t\(burnFinal \? 'next_record_again_lead' : 'next_record_again_lead_pending'\)\}/);
  assert.doesNotMatch(TEXTS.next_record_again_lead_pending, /nothing is burned/);
  // Only where the extension is: a browser without it waits for the network (owner, 06.10).
  assert.match(steps, /\{late && askAgain && extension && \(/);
  // Asked of the extension again only for a burn of the extension.
  assert.match(steps, /<Recording qnet=\{choice\.qnet\} since=\{null\} pending askAgain=\{view\.burn\?\.way === 'extension'\} \/>/);
  // The steps to the phone: the Wallet page, the same recovery phrase, then Link a device or the app's Node tab.
  assert.match(steps, /\{t\(phoneFlows \? 'next_link_3_qr' : 'next_link_3_app'\)\}/);
  assert.match(steps, /\{t\('next_link_1'\)\} <Link href="\/wallet">\{t\('guide_link_wallet'\)\}<\/Link>/);
  assert.match(TEXTS.next_link_2, /"Import Existing Wallet"/);
  assert.match(TEXTS.next_link_3_app, /"Node" tab and tap "Use this device"/);
});

test('an extension too old for a method is told to update; the claim\'s failures say that nothing is known to have moved', () => {
  assert.equal(failureKey('unsupported', 'activate'), 'ext_failure_unsupported');
  assert.equal(failureKey('unsupported', 'claim'), 'ext_failure_unsupported');
  assert.match(TEXTS.ext_failure_unsupported, /^This version of the QNet extension cannot do this\. Update the QNet extension, reload this page and try again\.$/);
  for (const failure of ['timeout', 'failed', 'unverifiable']) {
    assert.equal(failureKey(failure, 'claim'), `claim_failure_${failure}`);
    assert.match(TEXTS[`claim_failure_${failure}`], /The node balance above shows whether it moved\.$/);
    assert.equal(failureKey(failure, 'activate'), `ext_failure_${failure}`);
  }
  assert.equal(failureKey('other_wallet', 'claim'), 'claim_failure_other_wallet');
  for (const failure of ['rejected', 'cooldown', 'unauthorized', 'disconnected']) assert.ok(has(failureKey(failure, 'claim')), failure);
});

test('a claim answer is the wallet\'s report, in the words of the wallet that answered', () => {
  for (const error of LINK_ERRORS.claim) {
    for (const via of ['app', 'extension']) assert.ok(has(claimErrorKey(error, via)), `${error} ${via}`);
  }
  assert.equal(claimErrorKey('NO_WALLET', 'extension'), 'ext_error_NO_WALLET');
  assert.equal(claimErrorKey('NO_WALLET', 'app'), 'link_error_NO_WALLET');
  const base = { v: 1, intent: 'claim', qnet: 'x', nodeId: 'y' };
  assert.deepEqual(claimReport({ ...base, status: 'ok', amountNano: '2500000000', txHash: 'a'.repeat(64), stoppedAtEpoch: null }, 'app'), { key: 'claim_ok', amountNano: '2500000000' });
  assert.deepEqual(claimReport({ ...base, status: 'ok', amountNano: '2500000000', txHash: 'a'.repeat(64), stoppedAtEpoch: '41' }, 'extension'), { key: 'claim_ok_part', amountNano: '2500000000', epoch: '41' });
  assert.deepEqual(claimReport({ ...base, status: 'empty' }, 'app'), { key: 'claim_empty' });
  assert.deepEqual(claimReport({ v: 1, intent: 'claim', status: 'rejected' }, 'app'), { key: 'link_answer_rejected' });
  assert.deepEqual(claimReport({ v: 1, intent: 'claim', status: 'rejected' }, 'extension'), { key: 'ext_failure_rejected' });
  // Every report says "the answer says" or is a failure: the page shows the balance from the chain.
  for (const key of ['claim_ok', 'claim_ok_part', 'claim_empty']) assert.match(TEXTS[key], /^The answer says /);
  assert.match(TEXTS.claim_ok, /the node balance above follows the QNet network\.$/);
});

test('Move to wallet on the Overview: the extension for its own wallet, QNet Wallet otherwise, the balance re-read after a report', () => {
  const page = code('components/cabinet/NodeClaim.tsx');
  assert.match(page, /const extension = providerStatus === 'available' && providerChannel === 'extension'\s*&& \(choice\?\.source === 'extension' \|\| accounts\?\.qnet === qnet\);/);
  assert.match(page, /const result = await claimNodeBalance\(qnet\);/);
  // The app's request names the wallet the page shows; a button on a phone or tablet, a QR otherwise.
  assert.match(page, /const request = \{ walletHash \};/);
  assert.match(page, /if \(device\.phone\) void button\.start\('claim', request\);\s*else void qr\.start\('claim', request\);/);
  assert.match(page, /\{!phoneFlows \? \(\s*<p className="activate-note">\{t\('claim_closed'\)\}<\/p>/);
  // Below 1 QNC nothing is offered; the balance is the network's, read again after an answer. The Overview holds the
  // balance and its Move (owner, 29.09), for every registered node: after its device is unlinked no device is linked, and
  // the balance stays the wallet's to move.
  const home = code('components/cabinet/NodeHome.tsx');
  assert.match(home, /const movable = canMove\(status\.balanceNano\);/);
  assert.doesNotMatch(home, /\{running && \(\s*<div className="activate-card">\s*<h3 className="activate-step">\{t\('claim_title'\)\}/);
  assert.match(home, /<Move\s+qnet=\{choice\.qnet\}\s+movable=\{movable\}/);
  assert.match(home, /window\.setTimeout\(refresh, STATUS_KEPT_MS \+ 1_000\);/);
  assert.match(home, /<h3 className="activate-step">\{t\('claim_title'\)\}<\/h3>\s*<BalanceRow status=\{status\} \/>/);
  // The context's call checks the result for the wallet the page shows.
  const context = code('contexts/AppContext.tsx');
  assert.match(context, /provider \? claimWithExtension\(provider, wallet, Math\.floor\(Date\.now\(\) \/ 1000\)\) : \{ ok: false, failure: 'unsupported' \}/);
});

test('the app\'s view gets no activation text, and none before the page knows where it is', () => {
  assert.equal(showsActivationContent('detecting', null), false);
  assert.equal(showsActivationContent('available', 'mobile'), false);
  assert.equal(showsActivationContent('available', 'extension'), true);
  assert.equal(showsActivationContent('missing', null), true);
  assert.equal(showsActivationContent('missing', null, true), false, 'a page the app opened');
  assert.equal(showsActivationContent('available', 'extension', true), false);
  assert.equal(isInAppBrowser('mobile'), true);
  assert.equal(isInAppBrowser('extension'), false);
  assert.equal(isInAppBrowser(null), false);
  assert.deepEqual(IN_APP_NAV.map((l) => l.href), ['/explorer', '/privacy', '/terms', '/support']);

  assert.equal(openedFromApp('?from=app'), true);
  assert.equal(openedFromApp('?x=1&from=app'), true);
  for (const search of ['', '?from=App', '?from=apps', '?from=', '?source=app', '?from=app2']) assert.equal(openedFromApp(search), false, search);
  assert.equal(keepFromApp('/privacy', true), '/privacy?from=app');
  assert.equal(keepFromApp('/explorer?q=1', true), '/explorer?q=1&from=app');
  assert.equal(keepFromApp('/support#legal', true), '/support?from=app#legal');
  assert.equal(keepFromApp('/privacy', false), '/privacy');
  for (const href of ['https://aiqnet.io/privacy', '//evil.example/x', 'mailto:support@aiqnet.io']) assert.equal(keepFromApp(href, true), href);

  // One rule for every page: the context's hook, which includes the app's marker.
  const context = code('contexts/AppContext.tsx');
  assert.match(context, /export function useActivationContent\(\): boolean \{\s*const \{ providerStatus, providerChannel, fromApp \} = useWallet\(\);\s*return showsActivationContent\(providerStatus, providerChannel, fromApp\);/);
  assert.match(context, /if \(openedFromApp\(window\.location\.search\)\) setFromApp\(true\);/);
  assert.equal(context.match(/setFromApp\(/g)?.length, 1, 'set once, never cleared');
});

test('/wallet: one app on every phone and tablet, one unlock rule, one Android package, activation at the node pages', () => {
  const wallet = code('app/wallet/page.tsx');
  assert.match(wallet, /<h4>The app — iPhone, iPad, Android phones and tablets<\/h4>/);
  assert.doesNotMatch(wallet, /<h4>(Android|iOS)<\/h4>/);
  assert.match(wallet, /Face ID, Touch ID, a fingerprint or the device passcode —\s*and, on a device without any of them, with an app password; a wallet set up with an app password can\s*switch to the device&apos;s authentication\./);
  // SD-R2-03: the file from aiqnet.io runs the wallet; its node needs Google Play's licence, so the Play listing live for
  // the account (store-listing/README.md, the Node tab's device_unlicensed text). The page says so next to the file.
  assert.match(wallet, /On Android it is one app, io\.aiqnet\.wallet:\s*the file shared outside Google Play is the same signed build\. It runs the whole wallet; its light node\s*runs once Google Play licenses the install, which needs the Google Play listing to be live for your\s*account, and until then its Node tab says to install QNet Wallet from Google Play\. The app does not\s*update itself: a newer version comes from the store, or as a newer file from the same place\./);
  assert.doesNotMatch(wallet, /same signed build, with the same features|the Android file is here/);
  // Owner, 05.10: the Google Play listing is live; the App Store one is not yet, so only iPhone builds go to the channel.
  assert.match(wallet, /On Android\s*it is on\{' '\}\s*<a href=\{PLAY_URL\} target="_blank" rel="noopener noreferrer">Google Play<\/a>\. The App Store listing is\s*in preparation/);
  assert.match(wallet, /import \{ ANDROID_PLAY_URL as PLAY_URL \} from '@\/lib\/app-links';/);
  assert.match(wallet, /\{apk \? 'the Android file here also runs the wallet, and iPhone builds are shared in the ' : 'iPhone builds are shared in the '\}/);
  assert.doesNotMatch(wallet, /Google Play listings are in preparation/);
  const listing = readFileSync(new URL('../../../../../qnet-mobile/store-listing/README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(listing, /the copy from aiqnet\.io runs the wallet, and its node only once the user accepts Google Play's licence dialog, which needs the Play listing to be live for that user/);
  // The file is offered only once the setting names one, read per request by the server page.
  assert.doesNotMatch(wallet, /^'use client'/m);
  assert.match(wallet, /const apk = walletApkUrl\(\);/);
  assert.match(wallet, /\{apk && \(\s*<a href=\{apk\} rel="noopener noreferrer" style=\{BUTTON\}>\s*Download QNet Wallet for Android \(APK\)\s*<\/a>\s*\)\}/);
  // The older Android app installed from a file: install this one and restore with the recovery phrase.
  assert.match(wallet, /An earlier Android build of QNet Wallet installed from a file is a separate, older app; its last update\s*asks you to move\. Install this one, restore the wallet in it with the recovery phrase/);
  // A4 (owner, 29.09): a light node from the page's payment address or the extension, a super node only from the
  // extension, running on the user's own server; one node per wallet.
  assert.match(wallet, /Nodes are activated at <a href="\/node">aiqnet\.io\/node<\/a>\. In Phase 1 a light node&apos;s 1DEV burn is made\s+by the page from a one-time payment address in the browser, after QNet Wallet confirms the wallet, or by\s+the QNet extension from its own address; a super node&apos;s burn only by the extension, and the super node\s+runs on the user&apos;s own server with the QNet node software\./);
  assert.match(wallet, /One node per wallet, light or super\. The app burns nothing, sells nothing and shows\s+no price\. Phase 2 moves activation to QNC\./);
  assert.doesNotMatch(wallet, /One light node per wallet/);
  assert.doesNotMatch(wallet, /href="\/activate"|rewards are claimed|enter or recover the code/);
  // The page never shows in the app's view (its layout's guard), so it needs no guard of its own.
  assert.doesNotMatch(wallet, /useActivationContent|\{full &&/);
});

test('WALLET_APK_URL: an https address of an .apk file, or no file at all', () => {
  assert.equal(WALLET_APK_ENV, 'WALLET_APK_URL');
  const url = (value) => walletApkUrl({ WALLET_APK_URL: value });
  // A file on aiqnet.io, or the asset of one fixed GitHub release outside the move release's tag pattern and asset name
  // (docs/applications/mobile-wallet.md).
  const fixed = 'https://github.com/AIQnetLab/QNet-Blockchain/releases/download/app-1.3.0-20/io.aiqnet.wallet-1.3.0-20.apk';
  assert.equal(url(fixed), fixed);
  assert.equal(url('https://aiqnet.io/downloads/QNet-Wallet.APK'), 'https://aiqnet.io/downloads/QNet-Wallet.APK');
  assert.equal(walletApkUrl({}), null);
  for (const bad of ['', ' ', 'QNet-Wallet.apk', 'http://aiqnet.io/QNet-Wallet.apk', 'javascript:alert(1)//x.apk',
    'https://user:pass@aiqnet.io/QNet-Wallet.apk', 'https://aiqnet.io/QNet-Wallet.apk#x', 'https://aiqnet.io/QNet-Wallet.zip',
    'https://aiqnet.io/QNet-Wallet.apk.exe', 'data:application/octet-stream,x.apk',
    // The latest release could be the move build; its tag pattern and asset name are the move build's alone.
    'https://github.com/AIQnetLab/QNet-Blockchain/releases/latest/download/QNet-Wallet.apk',
    'https://github.com/AIQnetLab/QNet-Blockchain/releases/latest/download/io.aiqnet.wallet.apk',
    'https://github.com/AIQnetLab/QNet-Blockchain/releases/download/latest/io.aiqnet.wallet.apk',
    'https://github.com/AIQnetLab/QNet-Blockchain/releases/download/wallet-1.3.0-20/io.aiqnet.wallet-1.3.0-20.apk',
    'https://github.com/AIQnetLab/QNet-Blockchain/releases/download/app-1.3.0-20/QNet-Wallet.apk',
    'https://www.github.com/AIQnetLab/QNet-Blockchain/releases/download/app-1.3.0-20/qnet-wallet.APK']) {
    assert.equal(url(bad), null, bad);
  }
  // The rule the document states, word for word where the code relies on it.
  const doc = readFileSync(new URL('../../../../../../docs/applications/mobile-wallet.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(doc, /whose tag matches `wallet-<versionName>-<versionCode>` and which carries an asset named `QNet-Wallet\.apk`/);
  assert.match(doc, /`WALLET_APK_URL` names that fixed release \(`\.\.\.\/releases\/download\/<tag>\/<asset>`\), never `\.\.\.\/releases\/latest\/download\/\.\.\.`/);
  // The deploy scripts and the example leave it empty: no file until the owner names one.
  for (const path of ['../../../ecosystem.config.example.js', '../../../../../../deployment/deploy-aiqnet.sh', '../../../../../../deployment/deploy-to-1984.sh']) {
    assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /WALLET_APK_URL: ''/, path);
  }
});

// Owner, 29.09: the payment address way says in plain words that it makes a light node, who it is for (a phone, or a
// computer without the extension) and what happens, in five steps: QNet Wallet confirms the wallet first, the burn is the
// wallet's activation at once, and the registration also works later from any browser. The super node is the QNet
// extension's alone (A4). The safety sentences the other tests pin stay (cabinet-flow, privacy-claims).
test('the payment address way: a light node, who it is for and five plain steps, the testnet faucet named on testnet', () => {
  const page = code('components/cabinet/NodeActivate.tsx');
  assert.match(page, /<h3 className="activate-step">\{t\('act_payment_title'\)\}<\/h3>\s*<p className="cabinet-lead">\{t\('act_lead'\)\}<\/p>\s*<ol className="activate-facts">\s*<li>\{t\('act_way_1'\)\}<\/li>\s*<li>\{t\('act_way_2'\)\}<\/li>\s*<li>\{t\(ACTIVATION_NETWORK === 'testnet' \? 'act_way_3_testnet' : 'act_way_3_mainnet'\)\}<\/li>\s*<li>\{t\('act_way_4'\)\}<\/li>\s*<li>\{t\('act_way_5'\)\}<\/li>\s*<\/ol>/);
  assert.equal(TEXTS.act_payment_title, 'Light node: pay with a one-time address');
  assert.match(TEXTS.act_lead, /^A light node, which runs in QNet Wallet on a phone or tablet\. For a phone, or a computer without the QNet extension\. Five steps:$/);
  assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, 'act_browser_title'), false);
  assert.equal(TEXTS.act_way_1, 'QNet Wallet confirms the wallet the node is for.');
  assert.match(TEXTS.act_way_3_testnet, /"Get test tokens"/);
  assert.match(TEXTS.act_way_4, /From then on the burn is this wallet's activation, and its code shows at once\.$/);
  assert.match(TEXTS.act_way_5, /^QNet Wallet confirms again, and the page records your node on the QNet network\. That step also works later, from any browser where this wallet is connected\.$/);
  assert.match(TEXTS.act_price, /One wallet, one node: this light node or a super node made in the QNet extension, never both\.$/);
  // The super node's card: only the QNet extension; first when the Overview asked for a super node.
  assert.equal(TEXTS.act_super_title, 'Super node: only in the QNet extension');
  assert.match(TEXTS.super_note, /^A super node is activated only in the QNet browser extension on a computer, with this same wallet; its server then runs with the same recovery phrase\. A phone or the one-time payment address activates light nodes only\.$/);
  assert.match(page, /<h3 className="activate-step">\{t\('act_super_title'\)\}<\/h3>\s*<p>\{t\('super_note'\)\}<\/p>/);
  assert.match(page, /\{wantsSuper \? <>\{superCard\}\{paymentCard\}<\/> : <>\{paymentCard\}\{superCard\}<\/>\}/);
  assert.match(page, /setWantsSuper\(requestedType\(window\.location\.search\) === 'super'\);/);
  // QNet Wallet's confirmation before the address: its words, and a request kept for the record.
  assert.match(TEXTS.act_reserve_lead, /it shows "Set up a light node for this wallet"\. Nothing leaves the wallet\. The payment address appears here once it is confirmed\.$/);
  assert.ok(TEXTS.act_reserve_lead.includes(`"${TEXTS.ui_app_reserve_title}"`));
  assert.match(TEXTS.act_address_note, /^Send only to this address\./);
  for (const key of ['act_lead', 'act_keep_browser', 'act_address_note']) assert.doesNotMatch(TEXTS[key], /\s{2}/, key);
  assert.ok(TEXTS.act_keep_browser.length < 560, 'shorter than before');
});
