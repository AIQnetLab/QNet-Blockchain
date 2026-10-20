// My node (/node) as a personal cabinet: a connect screen before a wallet, then the wallet's dashboard (its full
// address, how it was connected, Disconnect, the way to a running node, the sections Overview, Device and History, and
// Activate while it is the way on); each section at its own address with Activate the only one that loads the payment
// key, and the sections of before 29.09 leading to their new places; a bare /node landing on the step the wallet needs;
// a typed address that only views; one connect logic with the header; the site's background with opaque panels; and the
// phone layout.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { GUIDE_HREF, JOURNEY, MOVED_PAGES, MOVED_TABS, TABS, TAB_HREF, isNodePath, journey, landingTab, tabRoute, visibleTabs } from '../cabinet/tabs.ts';
import { TEXTS } from '../texts.ts';
import { VIEW_STATES } from '../cabinet/wallet-activation.ts';
import { SRC, read, code } from './source.mjs';

const CSS = read('app/globals.css');

test('every section is a page of its own, and /node?tab= opens it', () => {
  // Owner, 29.09: Overview, Device and History, and Activate only while it is the way on.
  assert.deepEqual([...TABS], ['overview', 'activate', 'device', 'history']);
  for (const tab of TABS) {
    const path = TAB_HREF[tab].split('?')[0];
    assert.ok(existsSync(new URL(`app${path}/page.tsx`, SRC)), path);
  }
  assert.equal(TAB_HREF.overview, '/node?tab=overview');
  assert.equal(tabRoute('device'), '/node/device');
  assert.equal(tabRoute('history'), '/node/history');
  // The sections of before: Devices is Device, Node balance and Activation code are on the Overview, How it works is in
  // the Docs menu.
  assert.equal(tabRoute('devices'), '/node/device');
  assert.equal(tabRoute('balance'), '/node?tab=overview');
  assert.equal(tabRoute('code'), '/node?tab=overview');
  assert.equal(tabRoute('guide'), '/docs/how-it-works');
  assert.equal(GUIDE_HREF, '/docs/how-it-works');
  for (const other of ['overview', undefined, '', 'x', ['devices'], 'constructor', 'hasOwnProperty', '__proto__', '/node/claim']) assert.equal(tabRoute(other), null, String(other));
  assert.deepEqual(Object.keys(MOVED_TABS).sort(), ['balance', 'code', 'devices', 'guide']);
  const page = code('app/node/page.tsx');
  // The rest of the query goes along (the guide's ?way=; LD-07).
  assert.match(page, /const \{ tab, \.\.\.rest \} = await searchParams;\s*const route = tabRoute\(tab\);\s*if \(route\) \{/);
  assert.match(page, /redirect\(kept \? `\$\{route\}\$\{route\.includes\('\?'\) \? '&' : '\?'\}\$\{kept\}` : route\);/);
  assert.match(page, /return <NodeHome explicit=\{tab === 'overview'\} \/>;/);
  // Each page renders its section in the one frame, named by its tab.
  const frames = {
    'components/cabinet/NodeHome.tsx': 'overview',
    'components/cabinet/NodeActivate.tsx': 'activate',
    'components/cabinet/NodeDevices.tsx': 'device',
    'components/cabinet/NodeHistory.tsx': 'history',
  };
  for (const [file, tab] of Object.entries(frames)) assert.match(code(file), new RegExp(`<CabinetFrame tab="${tab}"`), file);
  // The payment key stays with the Activate page alone (cabinet-custody.test.mjs): the frame reads the store only.
  const frame = code('components/cabinet/CabinetFrame.tsx');
  assert.doesNotMatch(frame, /payment-key|cabinet\/activation'|NodeActivate/);
  assert.match(frame, /import \{ usePaymentRecords \} from '@\/hooks\/usePaymentRecords';/);
});

// Owner, 29.09: the old addresses keep working. Each old page redirects (next.config.js) where its section is now, with
// the query along (the guide's ?way=), and has no page of its own left.
test('the sections of before lead to their new places', async () => {
  const nextConfig = (await import(new URL('../next.config.js', SRC).href)).default;
  const redirects = await nextConfig.redirects();
  for (const [source, destination] of Object.entries(MOVED_PAGES)) {
    const found = redirects.find((r) => r.source === source);
    assert.ok(found, source);
    assert.equal(found.destination, destination, source);
    // Personal pages that may move again are temporary; the guide, an indexed page, moved for good.
    assert.equal(found.permanent, source === '/node/guide', source);
    assert.equal(existsSync(new URL(`app${source}`, SRC)), false, source);
  }
  assert.deepEqual(Object.keys(MOVED_PAGES).sort(), ['/node/claim', '/node/code', '/node/devices', '/node/guide']);
  // The guide renders on its own page in the Docs section, with the running server's phone flows.
  const guide = code('app/docs/how-it-works/page.tsx');
  assert.match(guide, /export const dynamic = 'force-dynamic';/);
  // The way shown first follows the device that asked, read from the request, so the steps never swap after load.
  assert.match(guide, /const phone = installTarget\(\(await headers\(\)\)\.get\('user-agent'\)\) !== 'desktop';\s*return <NodeGuide phoneFlows=\{phoneFlowsEnabled\(\)\} phone=\{phone\} \/>;/);
  assert.doesNotMatch(code('components/cabinet/NodeGuide.tsx'), /CabinetFrame|useCabinet\(/);
  // Links inside the site name the new places.
  assert.match(code('components/cabinet/GuideSummary.tsx'), /<Action href=\{GUIDE_HREF\}>\{t\('guide_full'\)\}<\/Action>/);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /<Action href=\{`\$\{GUIDE_HREF\}\?way=computer`\}>/);
  // Owner, 11.10: Support sends nobody to an I'm back the site no longer has.
  assert.doesNotMatch(read('app/support/page.tsx'), /support_epochs_wake/);
  for (const file of ['components/cabinet/NextSteps.tsx', 'components/cabinet/NodeDetails.tsx', 'components/cabinet/NodeHistory.tsx', 'components/cabinet/NodeStatus.tsx', 'components/cabinet/ActivateSteps.tsx', 'components/cabinet/NodeActivate.tsx', 'app/support/page.tsx']) {
    assert.doesNotMatch(code(file), /\/node\/(claim|code|devices|guide)\b/, file);
  }
});

test('the sections shown, the way to a running node and the landing section follow the wallet\'s state from every source', () => {
  const withoutActivate = TABS.filter((t) => t !== 'activate');
  assert.deepEqual(withoutActivate, ['overview', 'device', 'history']);
  // Activate only in the state `none` (R1, R6; cabinet-wallet-activation.test.mjs has the whole table).
  assert.deepEqual(visibleTabs('none', false, 'overview'), [...TABS]);
  // Every state the view has (a payment burn is the wallet's record once final: no state waits for a consent).
  assert.deepEqual([...VIEW_STATES], ['loading', 'locked', 'unknown', 'none', 'reserved', 'sending', 'burned', 'recording', 'node']);
  for (const state of [...VIEW_STATES.filter((s) => s !== 'none'), null]) {
    assert.deepEqual(visibleTabs(state, false, 'device'), withoutActivate, String(state));
  }
  // An unfinished activation of this browser for this wallet, or the Activate page itself, keeps it.
  assert.deepEqual(visibleTabs('node', true, 'device'), [...TABS]);
  assert.deepEqual(visibleTabs('burned', false, 'activate'), [...TABS]);
  const frame = code('components/cabinet/CabinetFrame.tsx');
  assert.match(frame, /<CabinetNav tab=\{tab\} openActivation=\{openActivation\} \/>/);
  assert.match(code('components/cabinet/CabinetNav.tsx'), /const items = navItems\(view\.state, openActivation, tab, viewOnly, accountRows\(reads\), journey\(true, view\)\.current\);/);
  assert.match(code('lib/cabinet/tabs.ts'), /return visibleTabs\(state, openActivation, current, viewOnly\)/);
  assert.match(frame, /const openActivation = \(records \?\? \[\]\)\.some\(\(r\) => isUnfinished\(r\) && \(pinnedWallet\(r\) === null \|\| pinnedWallet\(r\) === choice\.qnet\)\);/);
  // An address only viewed is offered no Activate section, unless its page is open.
  assert.deepEqual(visibleTabs('none', true, 'overview', true), withoutActivate);
  assert.deepEqual(visibleTabs('none', false, 'activate', true), [...TABS]);
  assert.deepEqual([...JOURNEY], ['connect', 'activate', 'link', 'running']);
  assert.deepEqual(journey(false, null), { done: 0, current: 0, nodeType: null });
  assert.deepEqual(journey(true, null), { done: 1, current: null, nodeType: null });
  // A bare /node: Activate only for a connected wallet with nothing anywhere; the Overview otherwise; nothing while loading.
  assert.equal(landingTab('none', false), 'activate');
  assert.equal(landingTab('none', true), 'overview');
  for (const state of VIEW_STATES.filter((s) => s !== 'none' && s !== 'loading')) assert.equal(landingTab(state, false), 'overview', state);
  assert.equal(landingTab('loading', false), null);
  assert.equal(landingTab(null, false), null);
  const home = code('components/cabinet/NodeHome.tsx');
  assert.match(home, /const landing = !explicit \? landingTab\(view\.state, viewOnly\) : null;/);
  assert.match(home, /if \(landing === 'activate'\) router\.replace\(TAB_HREF\.activate\);/);
  // After an activation the next step opens the Overview, which a no-node reading does not send back to Activate.
  assert.match(code('components/cabinet/ActivateSteps.tsx'), /<Action kind="solid" href="\/node\?tab=overview">\{t\('act_go_cabinet'\)\}<\/Action>/);
  // A finished registration with nothing to send back opens My node by itself (owner 20.10).
  assert.match(code('components/cabinet/NodeActivate.tsx'), /const finished = record\?\.stage === 'done' && registered !== null && !mayReturnLeftovers\(record\);\n\s*useEffect\(\(\) => \{\n\s*if \(finished\) router\.replace\('\/node\?tab=overview'\);/);
});

// Owner, 20.10: before a wallet, one clear main action by device (the header's Connect wallet too), the other ways as
// visible text actions, and View by address with How it works apart and quieter.
test('before a wallet: one main action by device, the other ways as text actions, the rest apart', () => {
  const frame = code('components/cabinet/CabinetFrame.tsx');
  assert.match(frame, /if \(ready && choice\) body = <Dashboard choice=\{choice\} tab=\{tab\}>\{children\}<\/Dashboard>;\s*else if \(ready && open\) body = <div className="cab-main cab-wide">\{children\}<\/div>;\s*else if \(ready && open === false\) body = <div className="cab-main cab-wide"><ConnectScreen \/><\/div>;/);
  // Activate shows an unfinished activation of this browser without a wallet.
  assert.match(code('components/cabinet/NodeActivate.tsx'), /<CabinetFrame tab="activate" open=\{record === undefined \? null : record !== null && isUnfinished\(record\)\}>/);
  const screen = code('components/cabinet/ConnectScreen.tsx');
  // No journey before Activate (B-SPEC 5.18): connecting is the screen's one subject.
  assert.doesNotMatch(screen, /CabinetProgress/);
  assert.match(screen, /id=\{CONNECT_ID\}/);
  assert.match(screen, /<p className="lead">\{t\('connect_lead'\)\}<\/p>\s*<WalletChoice \/>\s*<p className="note">\{t\('wallet_remembered'\)\}<\/p>\s*<\/section>\s*<div className="cab-connect-more">\s*<ViewByAddress \/>\s*<GuideSummary phoneFlows=\{phoneFlows\} \/>\s*<\/div>/);
  const choice = code('components/cabinet/WalletChoice.tsx');
  // The one Connect wallet (useConnectWallet, the header's too); the main action is the view's one solid action: a link
  // for the store page, else the device's way.
  assert.match(choice, /const \{ way, waiting, failed, run, askExtension \} = useConnectWallet\(\);/);
  assert.equal(choice.match(/kind="solid"/g)?.length, 2);
  assert.match(choice, /\{way\.kind === 'install'\s*\? <Action kind="solid" href=\{way\.href\} external=\{way\.store\}>\{t\(label\)\}<\/Action>\s*: <Action kind="solid" onClick=\{run\}>\{t\(label\)\}<\/Action>\}/);
  assert.match(choice, /if \(way\.kind === 'app'\) return \['connect_app_here', 'connect_app_here_note'\];/);
  assert.match(choice, /if \(way\.kind === 'extension'\) return \['connect_ext', 'connect_ext_note'\];/);
  assert.match(choice, /return \['connect_get_ext_link', way\.store \? 'connect_get_ext' : 'connect_get_ext_other'\];/);
  // Nothing before the device and the wallet are known; a request or the extension's window takes the main action's place.
  assert.match(choice, /if \(!device \|\| way\.kind === 'wait'\) return null;/);
  assert.match(choice, /\} else if \(waiting\) \{\s*main = <Waiting>\{t\('wallet_extension_waiting'\)\}<\/Waiting>;/);
  // The other ways while nothing is asked, as text actions: a phone gets QNet Wallet's page (and the extension only when
  // its browser has it), a computer the QR request for a phone.
  assert.match(choice, /others = device\.phone \? \(\s*<>\s*<Action href="\/wallet">\{t\('connect_get_app_link'\)\}<\/Action>\s*\{extension && <Action onClick=\{askExtension\}>\{t\('connect_ext'\)\}<\/Action>\}\s*<\/>\s*\) : \(\s*<Action onClick=\{showQr\}>\{t\('connect_app_qr'\)\}<\/Action>\s*\);/);
  assert.doesNotMatch(choice, /RowAction|installTarget|cab-ways/);
  // QNet Wallet's request on this device starts when Connect wallet asks for it, here or from the header.
  assert.match(choice, /if \(!takeAppConnect\(\)\) return;\s*stopQr\(\);\s*void startHere\('connect'\);/);
  assert.match(choice, /window\.addEventListener\(APP_CONNECT_EVENT, take\);/);
  // View by address only looks.
  assert.match(choice, /export function ViewByAddress\(\) \{/);
  assert.match(choice, /viewAddress\(value\);/);
  assert.doesNotMatch(choice, /source: 'entered'/);
  assert.match(choice, /<button type="submit" className="btn btn-text">\{t\('wallet_enter_submit'\)\}<\/button>/);
  // How it works in short: each way opened by its title, no marker drawn.
  const guides = code('components/cabinet/GuideSummary.tsx');
  assert.match(guides, /<details className="cab-guide">\s*<summary className="cab-guide-t">\{t\(title\)\}<\/summary>/);
  assert.match(guides, /<h2 className="label" id="guide-short-heading">\{t\('guide_title'\)\}<\/h2>/);
  assert.match(read('styles/cabinet.css'), /\.cab-guide-t::-webkit-details-marker \{ display: none; \}/);
  assert.match(read('styles/cabinet.css'), /\.cab-guide-t \{\n {2}display: flex; align-items: center; min-height: 48px; list-style: none;/);
  assert.equal(TEXTS.wallet_remembered, 'This browser remembers your wallet until you press Disconnect.');
  assert.equal(TEXTS.connect_app_here, 'Connect QNet Wallet');
  assert.equal(TEXTS.connect_ext, 'Connect the QNet Wallet extension');
  assert.equal(TEXTS.connect_get_ext_link, 'Get the QNet Wallet extension');
  // The guide's words name the buttons as they are.
  assert.match(TEXTS.guide_phone_connect, /^Tap "Connect QNet Wallet", then "Open QNet Wallet"\.$/);
  assert.match(TEXTS.guide_pc_connect, /click "Connect the QNet Wallet extension"\./);
  for (const key of ['connect_app_qr_note', 'connect_get_app']) assert.equal(key in TEXTS, false, key);
});

// B-SPEC 5.2, 5.20: the wallet itself (its whole address with Copy, how it is connected, Disconnect) is the header's account
// menu on every page, never a card of My node; My node's frame heads its sections with the node it shows.
test('the dashboard: the node\'s line and the sections from one list, the wallet itself in the header\'s account menu', () => {
  const frame = code('components/cabinet/CabinetFrame.tsx');
  assert.doesNotMatch(frame, /WalletCard|cabinet-address|clipboard|wallet_source_|wallet_disconnect|wallet_copy/);
  const button = code('components/wallet/connect-wallet-button.tsx');
  assert.match(button, /\{choice\.source !== 'entered' && <p className="acct-src">\{t\(SOURCE_TEXT\[choice\.source\]\)\}<\/p>\}/);
  for (const key of ['wallet_source_extension', 'wallet_source_app', 'wallet_source_app_qr']) assert.ok(button.includes(`'${key}'`), key);
  // A typed address is no way of connecting.
  assert.equal('wallet_source_entered' in TEXTS, false);
  // The rail's head: each node's state in the account menu's own words, its id a link to the wallet's address page.
  const nav = code('components/cabinet/CabinetNav.tsx');
  assert.match(nav, /const lines = nodeLines\(reads\);/);
  assert.match(nav, /\{id && <EntityLink kind="node" value=\{id\} address=\{wallet\} \/>\}/);
  // The sections, each with its datum ("—" until it is read), the current one marked.
  assert.match(nav, /<Link key=\{item\.tab\} href=\{item\.href\} className="cab-nav-a" aria-current=\{item\.tab === tab \? 'page' : undefined\}>/);
  assert.match(nav, /\{datum === null \? <span className="dash">—<\/span> : amount \?/);
  assert.match(nav, /<NavDatum datum=\{item\.datum\} tone=\{item\.tone\} \/>/);
  // The journey only while a step after Activate is open; its step now marked for screen readers too.
  assert.match(frame, /\{!viewOnly && showJourney\(tab, true, view\) && <CabinetProgress connected view=\{view\} \/>\}/);
  assert.match(code('components/cabinet/CabinetProgress.tsx'), /aria-current=\{at === 'now' \? 'step' : undefined\}/);
});

// Owner, 13.10: View by address is no connection. The page says the address is viewed read only, with Stop viewing; no
// action the wallet itself confirms (activate, link, unlink, move) is offered, nor a button to it in its place.
test('an address only viewed: read only, with Stop viewing, and no action that needs the wallet', () => {
  assert.match(code('components/cabinet/CabinetProvider.tsx'), /const \{ taken, connected, current, viewOnly \} = useMemo\(\s*\(\) => shownWallet\(/);
  assert.match(code('lib/cabinet/wallet-choice.ts'), /const viewOnly = connected === null && viewing !== null;/);
  assert.equal(existsSync(new URL('components/cabinet/ConnectFirst.tsx', SRC)), false);
  for (const file of ['NodeHome', 'NodeDevices', 'NextSteps', 'NodeActivate', 'CabinetFrame', 'NodeHistory']) {
    assert.doesNotMatch(code(`components/cabinet/${file}.tsx`), /ConnectFirst|leaveView/, file);
  }
  assert.match(code('components/cabinet/NodeDevices.tsx'), /\{!viewOnly && \(\s*<div className="cab-acts">\s*<LinkDevice onLinked=\{reread\} move \/>\s*<UnlinkDevice status=\{status\} onUnlinked=\{reread\} \/>\s*<\/div>\s*\)\}/);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /\} else if \(!record && viewOnly\) \{\s*body = <Next><p>\{t\('connect_first'\)\}<\/p><\/Next>;\s*\} else if \(!record && !offer\) \{/);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /<p>\{t\(viewOnly \? 'connect_first' : 'act_no_wallet'\)\}<\/p>/);
  const home = code('components/cabinet/NodeHome.tsx');
  // No node: the one card every section shows (NextSteps.tsx), with the wallet's state; on the Overview with the code
  // and its next step when a burn is known.
  assert.match(home, /if \(view\.state !== 'node'\) return <NoNode pending=\{view\.state === 'recording'\} overview \/>;/);
  assert.match(home, /if \(state === 'none' \|\| state === 'pending'\) \{\s*return \(\s*<>\s*<NoNode pending=\{state === 'pending'\} overview \/>/);
  const steps = code('components/cabinet/NextSteps.tsx');
  // With nothing anywhere: both node types (R2), none for an address only viewed.
  assert.match(steps, /action=\{!viewOnly && \(\s*<div className="actions">\s*<Action kind="solid" href=\{`\$\{TAB_HREF\.activate\}\?type=light`\}>\{t\('action_activate_light'\)\}<\/Action>\s*<Action href=\{`\$\{TAB_HREF\.activate\}\?type=super`\}>\{t\('action_activate_super'\)\}<\/Action>/);
  assert.equal(TEXTS.action_activate_light, 'Activate a light node');
  assert.equal(TEXTS.action_activate_super, 'Activate a super node');
  for (const file of ['components/cabinet/NodeDevices.tsx', 'components/cabinet/NodeHistory.tsx']) {
    assert.match(code(file), /if \(view\.state !== 'node'\) return <NoNode pending=\{view\.state === 'recording'\} \/>;/, file);
  }
  // History lists the wallet's epochs whatever the light node's status read says; the Device tab follows that status.
  assert.match(code('components/cabinet/NodeDevices.tsx'), /if \(s === 'none' \|\| s === 'pending'\) return <NoNode pending=\{s === 'pending'\} \/>;/);
  // Link your phone: the numbered steps, then Link a device in place while the site sends link requests.
  assert.match(home, /\{state === 'no_device' && <LinkPhone onLinked=\{reread\} \/>\}/);
  assert.match(steps, /\{onLinked && phoneFlows && !viewOnly && <LinkDevice onLinked=\{onLinked\} \/>\}/);
  // The way back into an activation of this browser, and asking the extension to record again: not for a view.
  assert.match(steps, /action=\{!viewOnly && <Action kind="solid" href=\{TAB_HREF\.activate\}>\{t\('code_continue'\)\}<\/Action>\}/);
  assert.match(steps, /\{late && askAgain && extension && !viewOnly && \(/);
  assert.match(code('components/cabinet/NodeDetails.tsx'), /\{facts\?\.open && !viewOnly && <div className="cab-next"><Action kind="solid" href=\{TAB_HREF\.activate\}/);
  // The node balance of either type moves from here too (owner, 12.10), never for an address only viewed.
  assert.equal(home.match(/\{\(movable \|\| moved\) && !viewOnly && choice && \(/g)?.length, 2);
  // Each action keeps itself from a view as well.
  for (const file of ['LinkDevice', 'UnlinkDevice']) assert.match(code(`components/cabinet/${file}.tsx`), /if \(viewOnly\) return null;/, file);
  assert.match(code('components/cabinet/NodeClaim.tsx'), /if \(viewOnly\) return null;\s*return \(/);
  // The rail's head: viewed, read only, and Stop viewing (back to the connect screen, no Disconnect).
  assert.match(code('components/cabinet/CabinetNav.tsx'), /<p className="cab-id-line" role="status">\{rich\('view_line', \{ wallet: <EntityLink kind="address" value=\{wallet\} \/> \}\)\}<\/p>/);
  assert.equal(TEXTS.view_line, 'Viewing {wallet} — read only');
  assert.equal(TEXTS.view_stop, 'Stop viewing');
  assert.match(TEXTS.view_note, /^Only what QNet Blockchain shows publicly for this address\. Nothing here acts for it/);
});

test('the Overview offers the one next step in place: activate, link a device, or run the node on the phone again', () => {
  const home = code('components/cabinet/NodeHome.tsx');
  // Owner, 11.10: no I'm back. The network wakes a phone that holds the node every epoch, an app that is alive answers
  // once it is opened, and a phone whose push address is gone cannot be woken: the Offline card's one action, right
  // under the device rows, is to run the node on the phone again, the link request (the app's Node tab while the site
  // sends no link requests). Nothing says the network has not agreed.
  assert.match(home, /<StatusReadout badge=\{lightBadge\(status\)\} none=\{t\('account_no_device'\)\} \/>[\s\S]*?\{state === 'offline' && !viewOnly && <MissLine status=\{status\} full=\{false\} \/>\}\s*\{state === 'offline' && !viewOnly && <LinkDevice onLinked=\{reread\} relink \/>\}/);
  for (const file of ['components/cabinet/NodeHome.tsx', 'components/cabinet/NodeDevices.tsx', 'components/cabinet/NodeHistory.tsx', 'components/cabinet/NodeActivate.tsx', 'components/cabinet/NextSteps.tsx', 'components/cabinet/NodeStatus.tsx']) {
    assert.doesNotMatch(code(file), /WakePanel|canWake|cabinet\/wake|device_wake_overview/, file);
  }
  for (const file of ['components/cabinet/WakePanel.tsx', 'lib/cabinet/wake.ts', 'server/cabinet/wake.ts', 'app/api/cabinet/wake/route.ts']) {
    assert.equal(existsSync(new URL(file, SRC)), false, file);
  }
  assert.equal(Object.keys(TEXTS).some((k) => k.startsWith('wake_') || k === 'device_wake_overview'), false);
  for (const [key, text] of Object.entries(TEXTS)) assert.doesNotMatch(text, /I'm back|not agreed|has not agreed/, key);
  const link = code('components/cabinet/LinkDevice.tsx');
  assert.match(link, /if \(!phoneFlows && relink\) return <p className="note">\{t\('relink_closed'\)\}<\/p>;/);
  // On a computer the same request shows a QR code for the phone: the button names that phone, not "this phone".
  assert.match(link, /const label: MessageKey = relink \? \(device && !device\.phone \? 'relink_button_qr' : 'relink_button'\) : title;/);
  assert.match(link, /if \(device\.phone\) void button\.start\('link', request\(false\)\);\s*else void qr\.start\('link', request\(true\)\);/);
  assert.match(link, /if \(relink\) return <div className="cab-next">\{body\}<\/div>;/);
  assert.equal(TEXTS.relink_button, 'Run the node on this phone');
  assert.equal(TEXTS.relink_button_qr, 'Run the node on that phone');
  // A phone that no longer holds the node shows none in QNet Wallet (no binding of its own), so it is linked again
  // from this page.
  assert.match(TEXTS.relink_closed, /running it there again from this page opens soon\.$/);
  // "Answered this epoch" never makes the node Running: step 4 follows the device's state alone (tabs.ts).
  assert.doesNotMatch(code('lib/cabinet/tabs.ts'), /answeredThisEpoch/);
  // A move the wallet answered keeps its report once the balance, read again, falls below 1 QNC (owner, 12.10: for a
  // light and a super node).
  assert.match(home, /<Move\s+qnet=\{choice\.qnet\}\s+nodeId=\{nodeId\}\s+movable=\{movable\}\s+onAnswer=\{\(\) => \{\s+setMoved\(true\);\s+reread\(\);\s+\}\}\s+\/>/);
  // The balance moves with the one component that asks the wallets, never a copy of its logic.
  assert.match(home, /import \{ Move, useMoveWays \} from '\.\/NodeClaim';/);
  assert.match(code('components/cabinet/NodeClaim.tsx'), /export function Move\(/);
  assert.equal(TEXTS.epoch_note, 'QNet Blockchain checks each node once per epoch, a period of about 4 hours.');
});

test('one connect logic: the header connects as My node does, by device, and shows the wallet My node remembers', () => {
  const header = code('components/Header.tsx');
  assert.match(header, /\{ href: '\/node', label: 'My node' \}/);
  assert.doesNotMatch(read('components/Header.tsx'), /label: 'Node'/);
  const button = code('components/wallet/connect-wallet-button.tsx');
  assert.match(button, /const choice = useHeldChoice\(\);\s*const held = choice\?\.qnet \?\? null;/);
  // The remembered wallet opens the account menu: its whole address with Copy, how it is connected, My node's rows and
  // Disconnect (B-SPEC 5.2).
  assert.match(button, /\{held && choice \? \(\s*<AccountMenu\s+key="account"\s+address=\{held\}/);
  assert.match(button, /<p className="acct-addr mono"><AddressParts value=\{held\} \/><\/p>\s*<Copy value=\{held\} label=\{t\('account_copy'\)\} \/>/);
  assert.match(button, /<NodeRows wallet=\{held\} active=\{active\} onNode=\{onNode\} \/>/);
  // Owner, 20.10: the header's Connect wallet is My node's own function (useConnectWallet): a computer with the QNet
  // extension asks it at once and My node keeps that wallet and opens; a computer without it gets the store page in a
  // new tab; a phone or tablet goes to the connect card, where QNet Wallet's request starts; nothing while detecting.
  assert.match(button, /const \{ way, run \} = useConnectWallet\(\(\) => \{\s*if \(!isNodePath\(pathname\)\) router\.push\('\/node'\);\s*\}\);/);
  assert.match(button, /if \(way\.kind === 'extension'\) \{\s*connectControl = \(\s*<button key="extension" type="button" className="connect" onClick=\{run\} disabled=\{connecting\} aria-busy=\{connecting\}>/);
  assert.match(button, /connectControl = way\.store \? \(\s*<a key="store" className="connect" href=\{way\.href\} target="_blank" rel="noopener noreferrer"><ConnectLabel \/><\/a>\s*\) : \(\s*<Link key="install" className="connect" href=\{way\.href\}><ConnectLabel \/><\/Link>\s*\);/);
  assert.match(button, /<Link key="app" href=\{`\/node#\$\{CONNECT_ID\}`\} className="connect" onClick=\{\(event\) => toConnect\(event, run\)\}>/);
  assert.match(button, /connectControl = <button key="wait" type="button" className="connect" disabled><ConnectLabel \/><\/button>;/);
  // The connection itself is the hook's alone: it asks the extension, keeps its wallet, and starts the phone's request.
  assert.doesNotMatch(button, /chooseWallet|askAppConnect|useDeviceKind/);
  const hook = code('components/wallet/useConnectWallet.ts');
  assert.match(hook, /const way = connectWay\(providerStatus, providerChannel, device, device \? window\.navigator : null\);/);
  assert.match(hook, /chooseWallet\(\{ qnet: accounts\.qnet, source: 'extension', solana: accounts\.solana \}\);\s*done\.current\?\.\(\);/);
  assert.match(hook, /const askExtension = useCallback\(\(\) => \{\s*endView\(\);\s*setTried\(true\);\s*setAsked\(true\);\s*if \(!accounts\) void connect\(\);\s*\}, \[accounts, connect\]\);/);
  assert.match(hook, /if \(kind === 'extension'\) askExtension\(\);\s*else if \(kind === 'app'\) \{\s*endView\(\);\s*askAppConnect\(\);\s*\}/);
  // Every caller of the wallet's connect outside the provider's own context is this hook (the app's view aside).
  for (const file of ['components/cabinet/WalletChoice.tsx', 'components/cabinet/ConnectScreen.tsx']) assert.doesNotMatch(code(file), /\bconnect\(\)|chooseWallet/, file);
  // Disconnect from the menu is My node's one step, and ends the extension's own connection when it is that wallet.
  assert.match(button, /if \(choice\?\.source === 'extension' && accounts\?\.qnet === choice\.qnet\) void disconnect\(\);\s*forgetWallet\(\);/);
  // On a page with the card, the card is brought into view, focused and marked for a moment.
  assert.match(button, /function toConnect\(event: MouseEvent<HTMLAnchorElement>, run: \(\) => void\) \{\s*run\(\);\s*const card = document\.getElementById\(CONNECT_ID\);\s*if \(!card\) return;\s*event\.preventDefault\(\);\s*showConnectCard\(card, true\);/);
  const flash = code('lib/cabinet/connect-card.ts');
  assert.match(flash, /card\.focus\(\{ preventScroll: true \}\);/);
  assert.match(flash, /card\.classList\.add\(FLASH_CLASS\);/);
  assert.match(read('styles/cabinet.css'), /\.cab-connect-ways\.cabinet-flash \{ animation: cab-flash 1\.6s ease-out; \}/);
  // The header reads the one remembered wallet and Disconnect mark, through My node's provider, and hears their changes.
  const provider = code('components/cabinet/CabinetProvider.tsx');
  assert.match(provider, /export function useHeldWallet\(\): string \| null \{/);
  assert.match(provider, /const read = \(\) => setKept\(heldHere \?\? storedHeld\(\)\);/);
  // Choosing, Disconnect, the header's wallet and the extension's wallet taken up all write through one step that tells
  // the page; My node's pages hear it too.
  assert.equal(provider.match(/window\.dispatchEvent\(new Event\(HELD_EVENT\)\);/g)?.length, 1);
  assert.match(provider, /export function chooseWallet\(next: WalletChoice\): void \{\s*hold\(\{ choice: next, disconnected: false \}\);\s*\}/);
  assert.match(provider, /window\.addEventListener\(HELD_EVENT, onHeld\);/);
  const screen = code('components/cabinet/ConnectScreen.tsx');
  assert.match(screen, /if \(!shown \|\| window\.location\.hash !== `#\$\{CONNECT_ID\}`\) return;\s*if \(card\.current\) showConnectCard\(card\.current, false\);/);
  // A tap on a link in the phone's menu closes it, a link that stays on the page included.
  assert.match(code('components/Header.tsx'), /if \(\(e\.target as HTMLElement\)\.closest\('a'\)\) setIsMenuOpen\(false\);/);
  // The sitemap names the guide; the guide is readable without a wallet and indexed like /node.
  assert.match(read('app/sitemap.ts'), /'\/node', '\/docs', '\/docs\/how-it-works',/);
  assert.doesNotMatch(read('app/docs/how-it-works/page.tsx'), /robots/);
});

// Owner, 04.10: My node keeps the rain, now in its title band like every page's field in its head zone (B-SPEC 4.2); the
// rows below sit on the page itself, with no panel and no blur over a moving canvas.
test('My node keeps the site\'s rain in its title band, the rows on the page itself', () => {
  for (const path of ['/node', '/node/activate', '/node/device']) assert.equal(isNodePath(path), true, path);
  for (const path of ['/', '/explorer', '/nodes', '/nodeX', null]) assert.equal(isNodePath(path), false, String(path));
  // B-SPEC 4.2: the field lives in each page's head zone (components/ui/PageHead.tsx), never behind the whole page.
  const field = code('components/field/Field.tsx');
  assert.doesNotMatch(field, /still|isNodePath|usePathname/);
  assert.match(field, /if \(!canvas \|\| !ctx\) return;/);
  assert.doesNotMatch(CSS, /\.still-backdrop/);
  assert.doesNotMatch(code('components/SiteShell.tsx'), /MatrixRain|<Field/);
  // The title band is the layout's, so moving between the sections keeps it and its field running.
  assert.match(code('app/node/layout.tsx'), /<PageHead title=\{t\('cabinet_title'\)\} strength=\{0\.32\} kind="cabinet" opacity=\{0\.7\} \/>/);
  assert.doesNotMatch(read('styles/cabinet.css'), /backdrop-filter|rgba\(/);
  assert.doesNotMatch(CSS, /\.activate-card|\.cabinet-/);
});

// Review, 18.10: the rain redrew at the display's full rate forever, on a hidden page and against reduced motion too.
test('the rain draws at most 30 frames a second, and none while the page is hidden or motion is reduced', async () => {
  const { frameLoop } = await import('../frame-loop.ts');
  const { fakeClock: clock } = await import('./frame-clock.mjs');
  for (const hz of [60, 90, 120, 144]) {
    const c = clock();
    let steps = 0;
    frameLoop(() => steps++, 30, () => true, c).sync();
    c.run(hz, 10_000);
    assert.ok(steps >= 299 && steps <= 302, `${hz} Hz: ${steps} frames in 10 s`);
  }
  // Hidden or reduced motion: no frame is even asked for; shown again, it goes on; stopped, nothing is left queued.
  const c = clock();
  let on = false;
  let steps = 0;
  const loop = frameLoop(() => steps++, 30, () => on, c);
  loop.sync();
  c.run(60, 1000);
  assert.equal(steps, 0);
  assert.equal(c.queued.size, 0);
  on = true;
  loop.sync();
  loop.sync();
  assert.equal(c.queued.size, 1, 'one loop, however often it is synced');
  c.run(60, 1000, 5000);
  assert.ok(steps >= 30 && steps <= 31, String(steps));
  on = false;
  loop.sync();
  assert.equal(c.queued.size, 0);
  const before = steps;
  c.run(60, 1000, 7000);
  assert.equal(steps, before);
  on = true;
  loop.sync();
  loop.stop();
  assert.equal(c.queued.size, 0);
  // The field runs its drawing through that loop (lib/field/rain.ts FieldLoop) at its page's cap, and syncs it on the
  // page's visibility, the motion setting and whether its zone is in view; it asks for no frame of its own.
  const field = code('components/field/Field.tsx');
  assert.match(field, /const motion = window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\);/);
  assert.match(field, /const loop = new FieldLoop\(rain, caps\.fps, \{ hidden: \(\) => document\.hidden, reduced: \(\) => motion\.matches, now: \(\) => performance\.now\(\) \}, window\);/);
  assert.match(field, /document\.addEventListener\('visibilitychange', sync\);\s*motion\.addEventListener\('change', sync\);/);
  assert.match(field, /loop\.stop\(\);[\s\S]*document\.removeEventListener\('visibilitychange', sync\);\s*motion\.removeEventListener\('change', sync\);/);
  assert.doesNotMatch(field, /requestAnimationFrame/);
  assert.match(code('lib/field/rain.ts'), /this\.loop = frameLoop\(\(\) => this\.step\(\), fps, \(\) => this\.running\(\), clock\);/);
});

// The rules of one selector block, in `within` (a media query's text, or the whole sheet).
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function block(selector, within = CSS) {
  const m = new RegExp(`^[ \\t]*${escape(selector)} \\{`, 'm').exec(within);
  assert.ok(m, selector);
  return within.slice(m.index, within.indexOf('}', m.index));
}
function lastMedia(query, sheet = CSS) {
  const at = sheet.lastIndexOf(`@media (${query}) {`);
  assert.ok(at >= 0, query);
  let depth = 0;
  for (let i = sheet.indexOf('{', at); i < sheet.length; i++) {
    if (sheet[i] === '{') depth++;
    else if (sheet[i] === '}' && --depth === 0) return sheet.slice(at, i + 1);
  }
  assert.fail(query);
}
// How it works is a page of the Docs menu: its rules are in the pages' sheet.
const PAGES = read('styles/pages.css');

test('phones: the way fits four across, the guide stacks its picture under its words, buttons take the row', () => {
  assert.match(read('styles/cabinet.css'), /\.cab-journey \{\n {2}display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  // How it works: a step's number, words and picture side by side; on a phone the picture goes under the words.
  assert.match(block('.guide-list .cab-step', PAGES), /grid-template-columns: 52px minmax\(0, 1fr\) minmax\(0, 360px\);/);
  assert.match(block('.guide-art', PAGES), /max-width: 360px; height: auto;/);
  assert.match(block('.guide-art-phone', PAGES), /max-width: 250px;/);
  assert.match(block('.guide-list .cab-step', lastMedia('max-width: 860px', PAGES)), /grid-template-columns: 30px minmax\(0, 1fr\);/);
  assert.ok(PAGES.indexOf('.guide-list .cab-step {') < PAGES.lastIndexOf('@media (max-width: 860px) {'));
  // Two columns (the ways to connect, How it works) only where they fit; stacked below 1,100 px.
  const cabinet = read('styles/cabinet.css');
  assert.match(cabinet, /\.cab-connect-ways \{ grid-column: 1 \/ span 7;/);
  assert.match(cabinet, /\.cab-connect-more \{ grid-column: 9 \/ span 4;/);
  assert.match(cabinet, /@media \(max-width: 1100px\) \{\n {2}\.cab-connect-ways, \.cab-connect-more \{ grid-column: 1 \/ -1; \}/);
  // On a phone the main action takes the row, and so does the request's Open QNet Wallet that takes its place.
  assert.match(lastMedia('max-width: 720px', cabinet), /\.cab-connect-main > \.btn-solid, \.cab-connect-main \.cab-req-phone > \.btn-solid \{ width: 100%; min-width: 0; justify-content: center; \}/);
});

// Review, 28.09: a computer's picture in the guide read at 6 to 8 px on a phone; it is drawn a second time, narrower,
// and the stylesheet shows that one below 640 px. A label cut to one line keeps its first word ("Node…", never "…").
test('phones: the guide\'s computer pictures have a narrower twin, and a cut label keeps its first word', () => {
  const art = code('components/cabinet/GuideArt.tsx');
  assert.match(art, /const BROWSER_NARROW_W = 208;/);
  assert.match(art, /const SCAN_NARROW_W = 236;/);
  assert.match(art, /className=\{`guide-art \$\{i === 0 \? 'guide-art-wide' : 'guide-art-narrow'\}`\}/);
  assert.match(art, /return <Both clip=\{clip\} wide=\{\(id\) => Browser\(\{ scene, clip: id \}\)\} narrow=\{\(id\) => Browser\(\{ scene, clip: id, narrow: true \}\)\} \/>;/);
  assert.match(art, /narrow=\{\(id\) => \(\{ node: <Scan scene=\{scene\} clip=\{id\} narrow \/>, width: SCAN_NARROW_W, height: 220 \}\)\}/);
  assert.ok(art.includes("const cut = last.length < max ? last : last.includes(' ') ? last.replace(/\\s*\\S*$/, '') : last.slice(0, max - 1);"));
  assert.match(block('.guide-art-narrow', PAGES), /display: none;/);
  assert.ok(PAGES.indexOf('.guide-art-narrow {') > PAGES.indexOf('.guide-art {'));
  const phone = lastMedia('max-width: 640px', PAGES);
  assert.match(block('.guide-art-wide', phone), /display: none;/);
  assert.match(block('.guide-art-narrow', phone), /display: block; max-width: 360px;/);
});

// Review, 28.09: a phone without QNet Wallet had no way to it on the connect screen (a computer is offered the
// extension); a node read that lands between a component's render and its subscription is still shown.
test('a phone without QNet Wallet is told where to get it, and a node read is never missed', () => {
  const choice = code('components/cabinet/WalletChoice.tsx');
  assert.match(choice, /<Action href="\/wallet">\{t\('connect_get_app_link'\)\}<\/Action>/);
  assert.equal(TEXTS.connect_get_app_link, 'Get QNet Wallet');
  const hook = code('hooks/useNodeStatus.ts');
  assert.match(hook, /const state = useSyncExternalStore\(subscribe, snapshot, \(\) => LOADING\) as Loaded<T>;/);
  assert.doesNotMatch(hook, /useReducer/);
  assert.match(code('components/Header.tsx'), /onClick=\{\(\) => setIsMenuOpen\(\(was\) => !was\)\}\s*aria-expanded=\{isMenuOpen\}\s*aria-controls=\{navId\}/);
});

// Owner, 29.09 and 11.10: real epochs everywhere, no placeholders and no count over a window of recent epochs; History
// is one list of the epochs themselves, a page at a time; a wallet without a node is told so, with the way on.
test('the epochs: one list on History, a page at a time with Show more, the newest on the Overview, no count of the last epochs', () => {
  const history = code('components/cabinet/NodeHistory.tsx');
  for (const key of ['history_col_epoch', 'history_col_time', 'history_col_result', 'history_col_amount', 'history_col_tx']) assert.ok(history.includes(`t('${key}')`), key);
  // The site's one table (fixed columns, fixed rows), five columns.
  assert.match(history, /<DataTable\s+className="cab-epochs"/);
  assert.equal(history.slice(history.indexOf('const COLUMNS'), history.indexOf('function Table(')).match(/\{ key: '/g)?.length, 5);
  for (const result of ['counted', 'moved', 'missed', 'joined', 'unchecked', 'not_admitted', 'unknown']) assert.ok(TEXTS[`history_${result}`], result);
  // A super node outside the network's admission: "Not admitted", never "Not counted", with the note that says why.
  assert.equal(TEXTS.history_not_admitted, 'Not admitted');
  assert.match(history, /not_admitted: 'history_not_admitted',/);
  assert.match(history, /\{has\('not_admitted'\) && <p className="note">\{t\('history_not_admitted_note'\)\}<\/p>\}/);
  assert.match(TEXTS.history_not_admitted_note, /That is the network's admission, not missed heartbeats\.$/);
  // "Missed" and "Not counted" are one word.
  assert.equal(TEXTS.history_missed, 'Not counted');
  assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, 'history_not_counted'), false);
  // An epoch's time is its start and end; its result a word; the move to the wallet its own transaction link.
  assert.match(history, /\{ key: 'time', header: t\('history_col_time'\), min: 248, cell: \(row\) => span\(row\) \}/);
  // Each epoch leads to its first block (owner 19.10: epochs are clickable), its number as the column names the kind.
  assert.match(history, /cell: \(row\) => <EpochNumber epoch=\{row\.epoch\} \/>/);
  assert.match(code('components/ui/EntityLink.tsx'), /export function EpochNumber\(\{ epoch \}: \{ epoch: number \}\) \{\n\s*return <EntityLink kind="epoch" value=\{epoch\} label=\{int\(epoch\)\} \/>;/);
  assert.match(history, /if \(start !== null && end !== null\) return timeSpan\(start, end\);/);
  assert.equal(TEXTS.history_span, '{start} – {end}');
  assert.match(history, /cell: \(row\) => <Status tone=\{RESULT_TONE\[row\.result\]\}>\{resultText\(row\.result\)\}<\/Status>/);
  assert.match(history, /cell: \(row\) => \(row\.claimTx \? <EntityLink kind="tx" value=\{row\.claimTx\} \/> : <Dash \/>\)/);
  assert.match(history, /cell: \(row\) => \(row\.amountQnc === null \? <Dash \/> : <Amount value=\{AMOUNT\.format\(row\.amountQnc\)\} \/>\)/);
  // One table on History: the first page (the Overview's shared read), then the older pages on Show more, joined; why
  // each epoch not counted was missed only there (cabinet-last-miss.test.mjs).
  assert.equal(history.match(/<Table rows=\{[^}]+\}(?: reasons)? \/>/g)?.length, 2);
  assert.match(history, /const list = useEpochList\(nodeId, first, viewOnly\);/);
  assert.match(history, /if \(!list\.more\) return null;/);
  // Show more, its waiting line while it reads (older rows come under the ones shown), its failure with Try again.
  assert.match(history, /if \(list\.phase === 'reading'\) return <div className="cab-more"><Waiting>\{t\('history_more_loading'\)\}<\/Waiting><\/div>;/);
  assert.match(history, /if \(list\.phase === 'failed'\) return <div className="cab-more"><Failed action=\{\{ label: t\('try_again'\), onClick: list\.showMore \}\}>\{t\('history_more_failed'\)\}<\/Failed><\/div>;/);
  assert.match(history, /<button type="button" className="btn btn-text" onClick=\{list\.showMore\}>\{t\('history_more'\)\}<\/button>/);
  // The notes the rows call for.
  assert.match(history, /\{has\('unchecked'\) && <p className="note">\{t\('history_unchecked_note'\)\}<\/p>\}/);
  // An unreadable epoch: "kept about six weeks" only for one at least EPOCHS_KEPT behind the newest listed (a recent one
  // is one the nodes did not give now).
  assert.match(history, /\{unknown\.some\(\(r\) => newest - r\.epoch < EPOCHS_KEPT\) && <p className="note">\{t\('history_unknown_note'\)\}<\/p>\}/);
  assert.match(history, /\{unknown\.some\(\(r\) => newest - r\.epoch >= EPOCHS_KEPT\) && <p className="note">\{t\('history_retention_note'\)\}<\/p>\}/);
  assert.match(code('lib/cabinet/node-view.ts'), /export const EPOCHS_KEPT = 256;/);
  assert.doesNotMatch(TEXTS.history_unknown_note, /six weeks/);
  assert.match(history, /\{first\.registeredEpoch === null && <p className="note">\{t\('history_no_start'\)\}<\/p>\}/);
  assert.match(history, /\{!first\.archived && <p className="note">\{t\('history_no_archive'\)\}<\/p>\}/);
  // A light and a super node alike, one list for a wallet with both, read by whichever id it has, whatever the light
  // node's status read says.
  assert.match(history, /const id = view\.nodes\.includes\('light'\) && nodeId \? nodeId : view\.nodes\.includes\('super'\) \? superId : null;/);
  assert.match(history, /return id \? <EpochCard key=\{id\} nodeId=\{id\} \/> : null;/);
  assert.doesNotMatch(history, /useNodeStatus\(|StatusGate|LightHistory/);
  assert.match(history, /<Epochs nodeId=\{nodeId\} show="all" \/>/);
  // The Overview: the newest rows of the same read, and the way to every epoch; while it is read, the rows stand empty
  // at their final height.
  assert.equal(code('components/cabinet/NodeHome.tsx').match(/<RecentEpochs nodeId=\{nodeId\} \/>/g)?.length, 3);
  assert.match(history, /<Epochs nodeId=\{nodeId\} show="recent" \/>/);
  assert.match(history, /if \(show === 'recent'\) return <Table rows=\{view \? view\.rows\.slice\(0, 6\) : null\} \/>;/);
  assert.match(history, /<Group title=\{t\('history_recent'\)\} meta=\{<Action href=\{TAB_HREF\.history\}>\{t\('history_see_all'\)\}<\/Action>\}>/);
  // No count over the last epochs, on History or the Overview, for a light or a super node; no separate lists of the
  // epochs waiting to be moved or of earlier ones.
  for (const file of ['components/cabinet/NodeHistory.tsx', 'components/cabinet/NodeHome.tsx', 'components/cabinet/NodeStatus.tsx', 'components/cabinet/NodeDevices.tsx']) {
    assert.doesNotMatch(code(file), /CountedRow|SuperEpochCounts|t\('counted'|super_epochs|claim_epochs|history_earlier|sinceRegistration|counted\.counted/, file);
  }
  // No text speaks of earnings here either.
  for (const key of Object.keys(TEXTS).filter((k) => /^(history|next)_/.test(k))) assert.doesNotMatch(TEXTS[key], /reward|\bearn/i, key);
});

// Owner, 30.09, 04.10 and 06.10: the Device tab shows the linked device from the public status (its state, its model
// and platform (cabinet-device-model.test.mjs), the day it linked, whether it answered this epoch, the epoch of its last answer),
// "Unlink the device" (the wallet signs it: the extension that holds it, or QNet Wallet on any device through a QNet
// Link `unlink` request; today's device form while the network does not take the wallet's) and "Move the node to
// another device" while one is linked; while none is, Link a device in numbered steps.
test('the Device tab: the linked device\'s rows, unlink signed by the wallet, move to another device, the steps without one', () => {
  const devices = code('components/cabinet/NodeDevices.tsx');
  assert.match(devices, /if \(!isLinkedState\(s\)\) return <LinkPhone onLinked=\{reread\} \/>;/);
  assert.match(devices, /<DeviceRows status=\{status\} full viewOnly=\{viewOnly\} \/>/);
  const rows = code('components/cabinet/NodeStatus.tsx');
  // One ledger entry: what runs the node, then its readings: the day it linked, whether it answered, its last answer.
  assert.match(rows, /<p className="label">\{t\('device_runs'\)\}<\/p>\s*\{named && deviceName\(named\) && <p className="cab-dev-name">\{deviceName\(named\)\}<\/p>\}/);
  assert.match(rows, /\{!viewOnly && <Readout label=\{t\('device_since'\)\} value=\{device\?\.linkedSince != null \? DAY\.format\(device\.linkedSince \* 1000\) : null\} \/>\}/);
  assert.match(rows, /<Readout label=\{t\('device_answered'\)\} value=\{t\(status\.answeredThisEpoch \? 'device_yes' : 'ro_not_answered'\)\} \/>/);
  assert.match(rows, /<Readout label=\{t\(device \? 'device_last' : 'device_last_counted'\)\} value=\{t\(device \? 'device_no_answer' : 'device_none_counted'\)\} \/>/);
  assert.match(rows, /\{rich\('device_epoch', \{ epoch: <EpochNumber epoch=\{last\} \/> \}\)\}/);
  assert.match(rows, /const DAY = new Intl\.DateTimeFormat\('en', \{ year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' \}\);/);
  for (const [key, words] of [['device_platform_android', 'Android'], ['device_platform_ios', 'iPhone or iPad'], ['device_platform_unknown', 'Unknown device'],
    ['device_no_answer', 'No answer yet'], ['badge_waiting', 'Waiting'], ['unlink_title_wallet', 'Unlink the device']]) {
    assert.equal(TEXTS[key], words, key);
  }
  const unlink = code('components/cabinet/UnlinkDevice.tsx');
  // The wallet's own unbind once both genesis nodes take it and a device runs the node; today's card before.
  assert.match(unlink, /return status\.features\.includes\('unbind_wallet'\) && device !== null && device\.state !== 'unlinked';/);
  // The extension only for its own wallet, as Move; QNet Wallet on any device otherwise.
  assert.match(unlink, /const extension = wallet && choice !== null && providerStatus === 'available' && providerChannel === 'extension'\s*&& \(choice\.source === 'extension' \|\| accounts\?\.qnet === choice\.qnet\);/);
  assert.match(unlink, /const result = await unlinkNodeDevice\(choice\.qnet\);/);
  assert.match(unlink, /const request: UnlinkRequest = \{ walletHash \};/);
  assert.match(unlink, /if \(device\.phone\) void button\.start\('unlink', request\);\s*else void qr\.start\('unlink', request\);/);
  // The answer is the wallet's report: taken, not confirmed by the network, refused, or declined.
  const view = code('lib/cabinet/extension-view.ts');
  assert.match(view, /if \(answer\.status === 'ok'\) return answer\.unbound === true \? 'unlink_answer_ok' : 'unlink_answer_unconfirmed';/);
  assert.match(view, /return `unlink_error_\$\{error\}`;/);
  // A lost device: unlinked here from any device with the wallet; on today's card it moves to another device instead.
  assert.match(unlink, /<p className="note">\{t\(wallet \? 'unlink_lost_wallet' : 'unlink_lost'\)\}<\/p>/);
  // Unlinking is never the solid action (B-SPEC 5.5); moving the node is the Device tab's one.
  assert.doesNotMatch(unlink, /kind="solid"/);
  assert.doesNotMatch(unlink, /fetch\(|\/api\/cabinet/);
  const link = code('components/cabinet/LinkDevice.tsx');
  assert.match(link, /const title: MessageKey = move \? 'devices_move_title' : 'action_link_device';/);
  assert.match(link, /\{t\(relink \? 'relink_lead' : move \? 'devices_move_lead' : 'devices_link_lead'\)\}/);
  for (const key of ['unlink_title', 'unlink_lead', 'unlink_button', 'unlink_lost', 'unlink_closed', 'unlink_answer_ok', 'unlink_answer_unconfirmed',
    'link_error_NOT_LINKED', 'link_error_UNLINK_REFUSED', 'unlink_error_NOT_LINKED', 'unlink_error_NETWORK', 'unlink_error_UNLINK_REFUSED',
    'devices_move_title', 'devices_move_lead', 'device_last_counted', 'device_none_counted', 'device_epoch']) {
    assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, key), key);
  }
  assert.deepEqual(TEXTS.device_epoch.match(/\{\w+\}/g), ['{epoch}']);
});

// REAL.md 7.10 (owner 19.10: phones convenient, the cabinet included): on a phone History's Result started past the
// right edge behind an empty Time column. The epoch and its result come first, and together they fit the narrowest
// phone's frame (360 px less two 16 px gutters), so the result reads without scrolling sideways; rows stay fixed.
test('History on a phone: the epoch and its result fit the frame at 360 px, the other columns follow', () => {
  const history = code('components/cabinet/NodeHistory.tsx');
  const columns = history.slice(history.indexOf('const COLUMNS'), history.indexOf('function Table('));
  const keys = [...columns.matchAll(/\{ key: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['epoch', 'result', 'time', 'amount', 'tx']);
  const width = (key) => Number(columns.match(new RegExp(`\\{ key: '${key}',[^}]*?width: (\\d+)`))?.[1]);
  assert.ok(width('epoch') + width('result') <= 360 - 2 * 16, `${width('epoch')} + ${width('result')}`);
  // "Counted, moved to the wallet", the longest result, fits its cell in the mono data face (80 % width, 0.62 em a
  // character at 12.5 px) with the cell's 14 px of padding.
  const longest = Math.max(...['history_counted', 'history_moved', 'history_missed', 'history_joined', 'history_unchecked', 'history_not_admitted', 'history_unknown'].map((k) => TEXTS[k].length));
  assert.ok(longest * 12.5 * 0.62 + 14 <= width('result'), String(longest));
  // The rows keep their fixed height; the epoch stays sticky at the left while the rest scrolls.
  assert.doesNotMatch(history, /tall\b/);
  assert.match(read('styles/base.css'), /\.tbl td \{ height: var\(--row\);/);
});
