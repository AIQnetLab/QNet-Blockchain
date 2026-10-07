// The wallet's state follows the wallet, not the way it was connected (owner, 29.09; R1): the network and the explorer's
// archive, the site's record of its activation (with the search of its Solana address) and the QNet extension that holds
// it, for every browser and device, and on top what this browser keeps (the extension's answer, an activation made
// here). A wallet with an activation is never offered one from scratch; an unfinished activation resumes at its step in
// the browser that holds its key, whatever wallet way is used now, and other browsers say where it is; and every expired
// piece is asked for again in one tap, the progress kept. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STAGES, TRANSITIONS, isUnfinished } from '../cabinet/flow.ts';
import { activationFacts, browserActivation, knownOfKept } from '../cabinet/code-check.ts';
import { visibleTabs, landingTab } from '../cabinet/tabs.ts';
import { TEXTS } from '../texts.ts';

const SRC = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const BURN = { tx: '5'.repeat(88), lastValidBlockHeight: 1, amount: 1500 };

test('every stage of an activation resumes from the record after a reload: a step the page runs, or one it offers', () => {
  const page = code('components/cabinet/NodeActivate.tsx');
  const run = page.slice(page.indexOf('switch (r.stage) {'), page.indexOf('default:', page.indexOf('switch (r.stage) {')));
  const stopped = page.slice(page.indexOf('const STOPPED_TEXT'), page.indexOf('};', page.indexOf('const STOPPED_TEXT')));
  for (const stage of STAGES) {
    const polled = run.includes(`case '${stage}':`);
    const offered = new RegExp(`stage === '${stage}'`).test(page) || stopped.includes(`${stage}:`);
    assert.ok(polled || offered, stage);
  }
  // The record followed is the one shown, else the unfinished one of this browser, whichever wallet is connected; a
  // request to QNet Wallet is kept per activation and read again after a reload.
  assert.match(page, /const found = all\.find\(\(r\) => r\.pub === followed\) \?\? all\.find\(isUnfinished\) \?\? null;/);
  assert.match(page, /useLinkSession\(\{ slot: record \? `activate\.\$\{record\.pub\}` : undefined/);
  // The wallet a request names is the one the activation is for (QNet Wallet confirmed it, or is asked to), else the one
  // connected now (flow.ts pinnedWallet, linkFacts); QNet Wallet's confirmation is kept per activation too.
  assert.match(page, /const pinned = record \? pinnedWallet\(record\) : null;/);
  assert.match(page, /const named = pinned \?\? choice\?\.qnet \?\? null;/);
  assert.match(page, /useLinkSession\(\{ slot: record \? `reserve\.\$\{record\.pub\}` : undefined/);
  // Only `done` is finished; `closing` still sends what is left back.
  assert.deepEqual(STAGES.filter((s) => !isUnfinished({ stage: s })), ['done']);
  assert.deepEqual(TRANSITIONS.done, {});
});

test('a wallet with an activation is never offered one from scratch', () => {
  // The tabs: Activate only in the state `none`, or for an unfinished activation of this browser.
  assert.equal(visibleTabs('burned', false, 'overview').includes('activate'), false);
  assert.equal(visibleTabs('burned', true, 'overview').includes('activate'), true);
  assert.equal(landingTab('burned', false), 'overview');
  // The card every section shows without a node follows the wallet's state; both node types only in `none`.
  const steps = code('components/cabinet/NextSteps.tsx');
  const noNode = steps.slice(steps.indexOf('export function NoNode('));
  for (const state of ['loading', 'locked', 'unknown', 'reserved', 'sending', 'burned', 'recording', 'none']) {
    assert.ok(noNode.includes(`case '${state}':`), state);
  }
  assert.ok(noNode.indexOf("t('action_activate_light')") > noNode.indexOf("case 'none':"));
  assert.equal(steps.match(/action_activate_light/g)?.length, 1);
  // The Activate page: nothing new unless the state is `none`; the payment address only then.
  const page = code('components/cabinet/NodeActivate.tsx');
  assert.match(page, /const offer = view\.state === 'none';/);
  assert.match(page, /\} else if \(!record && !offer\) \{/);
  assert.match(page, /if \(!offer\) return;\s*setWorking\(true\);\s*const open = await act\.paymentOpen\(choice\.qnet, deps\);\s*if \(open !== true\) \{[^}]*\}\s*const created = await createPaymentKey\(\{ wallet: choice\.qnet \}\);/);
  // A funded payment address burns only while the chosen, connected wallet's state is still `none` (or this browser holds
  // its reservation): a known burn, a source loading, locked or unreachable, or another browser's reservation shows the
  // state in place of Burn, and the step itself refuses (R6).
  assert.match(page, /const mayBurn = choice !== null && !viewOnly && \(offer \|\| \(view\.state === 'reserved' && view\.here\)\);/);
  assert.match(page, /const burn = \(\) => withRecord\(async \(r\) => \{\s*if \(price === null \|\| !mayBurn \|\| choice === null\) return undefined;/);
  // While QNet Wallet is asked to confirm the wallet again, Burn waits for it.
  assert.match(page, /\{stage === 'funded' && price !== null && !confirming && \(mayBurn \? \(\s*<div className="activate-card">\s*<p>\{t\('act_burn_lead'/);
  assert.equal(page.match(/onClick=\{\(\) => void burn\(\)\}/g)?.length, 1);
  assert.match(TEXTS.act_has_activation, /nothing more is burned for it/);
});

test('the Overview shows what is known of the wallet\'s activation, from the network first, then every other source', () => {
  const kept = { status: 'ok', qnet: WALLET, solana: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', nodeType: 'light', burnTx: BURN.tx, burnAmount: 1500, code: 'QNET-LAAAAA-000000-000000', at: 1 };
  const record = { pub: 'p', stage: 'submitted', burn: BURN, submit: { qnet: WALLET, nodeId: 'n' }, answer: null, updatedAt: 1 };
  const registration = { kind: 'code', code: 'QNET-LBBBBB-111111-111111', record: { height: 9, burnTx: 'b', burner: 'x', amount: 1500 } };
  // The network's record wins; then the other sources (the kept answer here); then an activation made in this browser.
  assert.equal(activationFacts(registration, knownOfKept(kept), record).source, 'network');
  assert.equal(activationFacts({ kind: 'none' }, knownOfKept(kept), record).source, 'kept');
  assert.equal(activationFacts({ kind: 'none' }, null, browserActivation([record], WALLET)).source, 'browser');
  assert.equal(activationFacts({ kind: 'none' }, null, browserActivation([record], WALLET)).open, true);
  assert.equal(activationFacts({ kind: 'none' }, null, browserActivation([record], 'other')), null);
  // Burned, not recorded yet: the code first, then its next step; never Activate.
  const home = code('components/cabinet/NodeHome.tsx');
  assert.match(home, /if \(view\.state !== 'node'\) return <NoNode pending=\{view\.state === 'recording'\} overview \/>;/);
  assert.match(home, /const known = useWalletActivation\('light'\);/);
  assert.match(home, /const known = useWalletActivation\('super'\);/);
  // Recorded: the node, its balance with Move, the details, the latest epochs; a super node's own summary (R4).
  for (const part of ["t('overview_title')", "t('claim_title')", '<NodeDetails nodeId={nodeId}', '<Epochs nodeId={nodeId} show="recent" />', "t('super_title')", "t('super_move')"]) assert.ok(home.includes(part), part);
  const details = code('components/cabinet/NodeDetails.tsx');
  for (const key of ['details_title', 'code_field_status', 'ext_field_type', 'act_code', 'act_burn_tx', 'code_field_amount']) assert.ok(details.includes(`t('${key}')`), key);
  assert.match(home, /lightStatusText\(state, known\.facts\?\.height \?\? null\)/);
});

test('another browser\'s activation: the site\'s record follows the wallet, and the page says where it goes on', () => {
  // The server keeps a record per wallet (activation-registry.ts); another browser's reservation or burn on its way shows
  // here as such, never as a fresh activation.
  const steps = code('components/cabinet/NextSteps.tsx');
  assert.match(steps, /<p>\{t\('state_reserved', \{ time: shownTime\(view\.until\) \}\)\}<\/p>/);
  assert.match(TEXTS.state_reserved, /^An activation of this wallet is starting in another browser or on another device\./);
  // A2: a payment address's final burn is the wallet's record like the extension's; any browser where the wallet is
  // connected registers the node with QNet Wallet's fresh consent, and the browser that holds the record goes on there.
  for (const key of ['state_payment_waiting', 'burned_payment_finish']) assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, key), false, key);
  assert.doesNotMatch(steps, /payment_waiting/);
  // Owner, 06.10: every light burn of the wallet with no node goes on with QNet Wallet from this browser, a phone
  // included: a payment address's from the site's record, one from the wallet's own Solana address with that address
  // named in the request (burn-next.ts; cabinet-own-burn.test.mjs routes every source and way).
  assert.match(steps, /\) : next\.step === 'finish' \? \(\s*<FinishLight qnet=\{qnet\} burn=\{burn\} burner=\{next\.burner\} \/>/);
  assert.match(steps, /const named: LinkDeviceRequest = \{ burnTx: burn\.burnTx, walletHash: walletHash\(qnet\), check: false \};/);
  assert.match(steps, /const request: LinkDeviceRequest = burner === null \? named : \{ \.\.\.named, burner \};/);
  // No check number: the request names the wallet, and only that wallet's answer (by its full address) for this very
  // burn and burner is taken, since the owner bind names that wallet's node (qnet-link-v1.md section 14.9).
  assert.match(steps, /const usable = answer\?\.status === 'ok' && answer\.qnet === qnet && !!answer\.consent && asked\?\.burnTx === burn\.burnTx\s*&& \(asked\.burner \?\? null\) === burner;/);
  assert.match(steps, /\? consentBodyOf\(qnet, answer\.consent, burn\.burnTx, burn\.burnAmount\)\s*: ownBurnBodyOf\(qnet, answer\.consent, burn\.burnTx, burn\.burnAmount, burner\);/);
  // No extension text on that path any more.
  assert.doesNotMatch(steps, /burned_scan_open/);
  assert.match(steps, /return <Recording qnet=\{qnet\} since=\{null\} pending=\{outcome\.result === 'registered'\} askAgain=\{false\} \/>;/);
  assert.match(TEXTS.burned_payment_lead, /^The burn for this wallet's light node is final, and the code above is its receipt\. Register the node with QNet Wallet, in this browser or any other where this wallet is connected\.$/);
  // In the browser that holds it, it goes on.
  assert.match(steps, /\{t\('next_resume'\)\}/);
  // The provider reads the record for every wallet, with the search of its Solana address at most once per SCAN_CACHE_MS.
  const provider = code('components/cabinet/CabinetProvider.tsx');
  assert.match(provider, /fetch\(`\/api\/cabinet\/activation\/\$\{encodeURIComponent\(wallet\)\}\$\{withScan \? `\?solana=\$\{encodeURIComponent\(solana\)\}` : ''\}`, REQUEST\)/);
  // A search that did not finish is asked again after two minutes; a record that cannot be read is no "none" (R6).
  assert.match(provider, /const fresh = kept && kept\.key === key && kept\.view\.complete && now - kept\.at < SCAN_CACHE_MS;/);
  assert.match(provider, /cur\.wallet === wallet && cur\.read\.phase === 'ok' && cur\.read\.value\.state !== 'none' \? cur : \{ wallet, read: \{ phase: 'unavailable' \} \}/);
  // So is the network's "no node": a failed read keeps a node it listed, never a "none".
  const hooks = code('hooks/useNodeStatus.ts');
  assert.match(hooks, /const keepListed = \(value: WalletNodeView\) => value\.state === 'registered';/);
  assert.match(hooks, /parseWalletNode, true, keepListed\);/);
  assert.match(hooks, /\(entry\.state\.phase === 'ok' && keep && !keep\(entry\.state\.value\)\)\) \{\s*publish\(entry, \{ phase: 'unavailable' \}\);/);
});

test('every expired piece is asked for again in one tap, the progress kept', () => {
  // A QNet Wallet request past its ten minutes: Ask again, a new request with the same content, wherever one is made.
  const waiting = code('components/cabinet/LinkWaiting.tsx');
  assert.match(waiting, /\{state\.failure === 'expired' \? \(\s*<button type="button" className="qnet-button activate-primary" onClick=\{onRetry\}>\{t\('link_ask_again'\)\}<\/button>/);
  assert.equal(TEXTS.link_ask_again, 'Ask again');
  assert.match(TEXTS.link_expired, /Ask again: nothing was lost\.$/);
  const retries = {
    'components/cabinet/WalletChoice.tsx': /onRetry=\{active === qr \? \(\) => void qr\.start\('connect'\) : \(\) => void button\.start\('connect'\)\}/,
    // Link a device: a new QR code, or a new button request.
    'components/cabinet/LinkDevice.tsx': /onRetry=\{active === qr \? \(\) => void qr\.start\('link', request\(true\)\) : \(\) => void button\.start\('link', request\(false\)\)\}/,
    'components/cabinet/NodeClaim.tsx': /onRetry=\{active === qr \? \(\) => void qr\.start\('claim', request\) : \(\) => void button\.start\('claim', request\)\}/,
  };
  for (const [file, pattern] of Object.entries(retries)) assert.match(code(file), pattern, file);
  // The activation's request: the same request for the same burn, again.
  const page = code('components/cabinet/NodeActivate.tsx');
  assert.match(page, /const retryRequest = \(\) => \{\s*if \(record\?\.link\) void session\.start\('link', record\.link\.request\);\s*\};/);
  // A payment address unused for 24 hours: what arrived goes back by the rules, then the page offers a new address in
  // one tap (the start card of a page without a record).
  assert.match(page, /if \(isExpired\(r, deps\.now\(\)\)\) return act\.expire\(r, deps\);/);
  assert.match(page, /if \(next === null\) setNotice\(from\.burn \? 'act_returned' : 'act_closed'\);/);
  assert.match(page, /<button type="button" className="qnet-button activate-primary" onClick=\{\(\) => void start\(\)\} disabled=\{working \|\| !device\}>\{t\('act_start'\)\}<\/button>/);
  assert.match(TEXTS.act_closed, /To start again, make a new payment address\.$/);
  // A wallet that has its node or its activation gets no start card, so its notice offers no new address (owner, 29.09).
  assert.match(page, /\} else if \(!record && !offer\) \{/);
  assert.match(page, /const shown: MessageKey \| null = notice === 'act_closed' && !record && !offer \? 'act_closed_has_node' : notice;/);
  assert.match(page, /\{shown && shown !== 'act_refund_failed' && <p className="activate-note" aria-live="polite">\{t\(shown\)\}<\/p>\}/);
  assert.doesNotMatch(TEXTS.act_closed_has_node, /make a new payment address/);
  assert.match(TEXTS.act_closed_has_node, /^The activation ended and its payment address is deleted\. This wallet already has a node or an activation, so it needs no new payment address\.$/);
  // The extension's window closed or timed out: Try again on the same step, while the wallet still has nothing anywhere;
  // Record on the network stays offered.
  const ext = code('components/cabinet/ExtensionActivate.tsx');
  assert.match(ext, /\{again && <button type="button" className="qnet-button secondary" onClick=\{\(\) => setExt\(\{ phase: 'idle' \}\)\}>\{t\('try_again'\)\}<\/button>\}/);
  // A state not known is read again every half minute by itself, and on Try again.
  const noNode = code('components/cabinet/NextSteps.tsx');
  assert.match(noNode, /const timer = window\.setInterval\(refreshActivation, UNKNOWN_RETRY_MS\);/);
  assert.match(noNode, /const UNKNOWN_RETRY_MS = 30_000;/);
  const steps = code('components/cabinet/NextSteps.tsx');
  assert.match(steps, /\{ask\.phase === 'waiting' \? \(\s*<p className="activate-status" aria-live="polite">\{t\('wallet_extension_waiting'\)\}<\/p>\s*\) : \(\s*<button type="button" className="qnet-button activate-primary" onClick=\{\(\) => void again\(\)\}>\{t\('next_record_again'\)\}<\/button>/);
});
