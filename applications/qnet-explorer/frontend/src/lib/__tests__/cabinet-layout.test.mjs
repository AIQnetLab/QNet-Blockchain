// My node (/node) as a personal cabinet: a connect screen before a wallet, then the wallet's dashboard (its full
// address, how it was connected, Disconnect, the way to a running node, the sections Overview, Device and History, and
// Activate while it is the way on); each section at its own address with Activate the only one that loads the payment
// key, and the sections of before 29.09 leading to their new places; a bare /node landing on the step the wallet needs;
// a typed address that only views; one connect logic with the header; the site's background with opaque panels; and the
// phone layout.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { GUIDE_HREF, JOURNEY, MOVED_PAGES, MOVED_TABS, TABS, TAB_HREF, isNodePath, journey, landingTab, tabRoute, visibleTabs } from '../cabinet/tabs.ts';
import { TEXTS } from '../texts.ts';
import { VIEW_STATES } from '../cabinet/wallet-activation.ts';

const SRC = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
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
  // The rest of the query goes along (the app's ?from=app marker, the guide's ?way=; LD-07).
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
  assert.match(guide, /return <NodeGuide phoneFlows=\{phoneFlowsEnabled\(\)\} \/>;/);
  assert.doesNotMatch(code('components/cabinet/NodeGuide.tsx'), /CabinetFrame|useCabinet\(/);
  // Links inside the site name the new places.
  assert.match(code('components/cabinet/GuideSummary.tsx'), /<Link href=\{GUIDE_HREF\} className="qnet-button secondary">\{t\('guide_full'\)\}<\/Link>/);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /<Link href=\{`\$\{GUIDE_HREF\}\?way=computer`\} className="qnet-button secondary">/);
  assert.match(read('app/support/page.tsx'), /<a href="\/node\?tab=overview">\{t\('support_epochs_wake_link'\)\}<\/a>/);
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
  assert.match(frame, /visibleTabs\(view\.state, openActivation, tab\)/);
  assert.match(frame, /const openActivation = \(records \?\? \[\]\)\.some\(\(r\) => isUnfinished\(r\) && \(pinnedWallet\(r\) === null \|\| pinnedWallet\(r\) === choice\?\.qnet\)\);/);
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
  assert.match(code('components/cabinet/ActivateSteps.tsx'), /<Link href="\/node\?tab=overview" className="qnet-button activate-primary">\{t\('act_go_cabinet'\)\}<\/Link>/);
});

test('before a wallet: one connect screen with the three ways and How it works in short', () => {
  const frame = code('components/cabinet/CabinetFrame.tsx');
  assert.match(frame, /if \(ready && choice\) body = <Dashboard tab=\{tab\}>\{children\}<\/Dashboard>;\s*else if \(ready && open\) body = children;\s*else if \(ready && open === false\) body = <ConnectScreen \/>;/);
  // Activate shows an unfinished activation of this browser without a wallet.
  assert.match(code('components/cabinet/NodeActivate.tsx'), /<CabinetFrame tab="activate" open=\{record === undefined \? null : record !== null && isUnfinished\(record\)\}>/);
  // How it works is readable without a wallet: a page of its own (the test above).
  const screen = code('components/cabinet/ConnectScreen.tsx');
  assert.match(screen, /<CabinetProgress connected=\{false\} view=\{null\} \/>/);
  assert.match(screen, /id=\{CONNECT_ID\}/);
  assert.match(screen, /<WalletChoice \/>/);
  assert.match(screen, /<GuideSummary phoneFlows=\{phoneFlows\} \/>/);
  const choice = code('components/cabinet/WalletChoice.tsx');
  // QNet Wallet: the button on this phone, a QR code elsewhere; the extension when it is there, else where to get it
  // on a computer; an address typed only to look.
  assert.match(choice, /if \(device\.phone\) void button\.start\('connect'\);\s*else void qr\.start\('connect'\);/);
  assert.match(choice, /\{t\(device\.phone \? 'connect_app_here' : 'connect_app_qr'\)\}/);
  assert.match(choice, /const install = !extension && !device\.phone \? installTarget\(window\.navigator\) : null;/);
  assert.match(choice, /choose\(\{ qnet: value, source: 'entered' \}\);/);
  // One filled button: the extension's when it is there, else QNet Wallet's.
  assert.match(choice, /className=\{buttonClass\(!extension\)\} onClick=\{ask\}/);
  assert.match(choice, /className=\{buttonClass\(true\)\} onClick=\{askExtension\}/);
  assert.match(choice, /\{extension \? ext : app\}\s*\{extension \? app : ext\}/);
  assert.match(choice, /<button type="submit" className="qnet-button secondary">\{t\('wallet_enter_submit'\)\}<\/button>/);
  assert.equal(TEXTS.wallet_remembered, 'This browser remembers your wallet until you press Disconnect.');
});

test('the dashboard: the whole address copied by a tap, how it was connected, Disconnect, the way, the sections', () => {
  const frame = code('components/cabinet/CabinetFrame.tsx');
  assert.doesNotMatch(frame, /shortAddress/);
  assert.match(frame, /<button type="button" className="cabinet-address" onClick=\{\(\) => void copyAddress\(\)\} title=\{t\('wallet_copy_label'\)\}>\s*\{choice\.qnet\}\s*<\/button>/);
  assert.match(frame, /await navigator\.clipboard\.writeText\(choice\.qnet\);/);
  assert.match(frame, /\{t\(SOURCE_TEXT\[choice\.source\]\)\}/);
  for (const key of ['wallet_source_extension', 'wallet_source_app', 'wallet_source_app_qr', 'wallet_source_entered']) assert.ok(frame.includes(`'${key}'`), key);
  // Disconnect forgets the wallet; the extension's own connection ends with it when it is that wallet.
  assert.match(frame, /if \(choice\.source === 'extension' && accounts\?\.qnet === choice\.qnet\) void disconnect\(\);\s*forget\(\);/);
  assert.match(frame, /<CabinetProgress connected view=\{view\} \/>\s*<WalletCard \/>\s*<nav className="cabinet-nav"/);
  assert.match(frame, /aria-current=\{key === tab \? 'page' : undefined\}/);
  // The address wraps and is never cut.
  assert.match(CSS, /\.cabinet-address \{[^}]*word-break: break-all;[^}]*\}/);
  assert.match(CSS, /\.cabinet-address \{[^}]*min-height: 44px;[^}]*\}/);
  // The way's step now is marked for screen readers too.
  assert.match(code('components/cabinet/CabinetProgress.tsx'), /aria-current=\{at === 'now' \? 'step' : undefined\}/);
});

// A typed address only views: every action the wallet itself confirms asks to connect it first; I'm back, which asks
// nothing of the wallet, stays.
test('a typed address views: the actions the wallet confirms ask to connect first', () => {
  assert.match(code('components/cabinet/CabinetProvider.tsx'), /viewOnly: current\?\.source === 'entered',/);
  assert.match(code('components/cabinet/NodeDevices.tsx'), /\{viewOnly \? <div className="activate-card"><ConnectFirst \/><\/div> : \(\s*<>\s*<UnlinkDevice status=\{status\} onUnlinked=\{reread\} \/>\s*<LinkDevice onLinked=\{reread\} move \/>\s*<\/>\s*\)\}/);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /\} else if \(!record && viewOnly\) \{\s*body = <div className="activate-card"><ConnectFirst \/><\/div>;\s*\} else if \(!record && !offer\) \{/);
  const home = code('components/cabinet/NodeHome.tsx');
  // No node: the one card every section shows (NextSteps.tsx), with the wallet's state; on the Overview with the code
  // and its next step when a burn is known.
  assert.match(home, /if \(view\.state !== 'node'\) return <NoNode pending=\{view\.state === 'recording'\} overview \/>;/);
  assert.match(home, /if \(state === 'none' \|\| state === 'pending'\) \{\s*return \(\s*<>\s*<NoNode pending=\{state === 'pending'\} overview \/>/);
  const steps = code('components/cabinet/NextSteps.tsx');
  // With nothing anywhere: both node types (R2), or Connect your wallet for an address only viewed.
  assert.match(steps, /\{viewOnly \? <ConnectFirst \/> : \(\s*<div className="cabinet-actions">\s*<Link href=\{`\$\{TAB_HREF\.activate\}\?type=light`\} className="qnet-button activate-primary">\{t\('action_activate_light'\)\}<\/Link>\s*<Link href=\{`\$\{TAB_HREF\.activate\}\?type=super`\} className="qnet-button secondary">\{t\('action_activate_super'\)\}<\/Link>/);
  assert.equal(TEXTS.action_activate_light, 'Activate a light node');
  assert.equal(TEXTS.action_activate_super, 'Activate a super node');
  for (const file of ['components/cabinet/NodeDevices.tsx', 'components/cabinet/NodeHistory.tsx']) {
    assert.match(code(file), /if \(s === 'none' \|\| s === 'pending'\) return <NoNode pending=\{s === 'pending'\} \/>;/, file);
    assert.match(code(file), /if \(view\.state !== 'node'\) return <NoNode pending=\{view\.state === 'recording'\} \/>;/, file);
  }
  // Link your phone: the numbered steps, then Link a device in place while the site sends link requests.
  assert.match(home, /\{state === 'no_device' && <LinkPhone onLinked=\{reread\} \/>\}/);
  assert.match(steps, /\{onLinked && phoneFlows && \(viewOnly \? <div className="activate-card"><ConnectFirst \/><\/div> : <LinkDevice onLinked=\{onLinked\} \/>\)\}/);
  assert.match(home, /\{!wake && movable && viewOnly && <ConnectFirst \/>\}/);
  assert.match(home, /\{!wake && \(movable \|\| moved\) && !viewOnly && choice && \(/);
  // Connecting leaves the typed address (no Disconnect); the connect screen, or the extension's wallet, follows.
  assert.match(code('components/cabinet/ConnectFirst.tsx'), /<button type="button" className="qnet-button activate-primary" onClick=\{leaveView\}>\{t\('connect_first_button'\)\}<\/button>/);
});

test('the Overview offers the one next step in place: activate, link a device, I\'m back, or move the balance', () => {
  const home = code('components/cabinet/NodeHome.tsx');
  assert.match(home, /const wake = state === 'offline' && canWake\(status\);/);
  // Owner, 04.10: I'm back in one place only, inside the status card right under the device rows; the Device tab leads
  // there from an Offline device's row and shows no copy of its own.
  assert.match(home, /<h3 className="activate-step">\{t\('overview_title'\)\}<\/h3>\s*<DeviceRows status=\{status\} viewOnly=\{viewOnly\} \/>\s*\{wake && <WakePanel nodeId=\{nodeId\} status=\{status\} refresh=\{refresh\} \/>\}/);
  assert.equal(home.match(/<WakePanel/g)?.length, 1);
  for (const file of ['components/cabinet/NodeDevices.tsx', 'components/cabinet/NodeHistory.tsx', 'components/cabinet/NodeActivate.tsx', 'components/cabinet/NextSteps.tsx']) {
    assert.doesNotMatch(code(file), /WakePanel/, file);
  }
  assert.match(code('components/cabinet/NodeDevices.tsx'), /\{s === 'offline' && canWake\(status\) && <p><Link href=\{TAB_HREF\.overview\}>\{t\('device_wake_overview'\)\}<\/Link><\/p>\}/);
  const panel = code('components/cabinet/WakePanel.tsx');
  assert.doesNotMatch(panel, /activate-card|activate-step|wake_title/);
  // A move the wallet answered keeps its report once the balance, read again, falls below 1 QNC (as on Node balance).
  assert.match(home, /<Move\s+qnet=\{choice\.qnet\}\s+movable=\{movable\}\s+onAnswer=\{\(\) => \{\s+setMoved\(true\);\s+reread\(\);\s+\}\}\s+\/>/);
  // The balance moves with the Node balance page's own component, never a copy of its logic.
  assert.match(home, /import \{ Move \} from '\.\/NodeClaim';/);
  assert.match(code('components/cabinet/NodeClaim.tsx'), /export function Move\(/);
  assert.equal(TEXTS.epoch_note, 'The network checks each node once per epoch, a period of about 4 hours.');
});

test('one connect logic: the header connects the extension or leads to My node, and shows the wallet My node remembers', () => {
  const header = code('components/Header.tsx');
  assert.match(header, /\{ href: '\/node', label: 'My node' \}/);
  assert.doesNotMatch(read('components/Header.tsx'), /label: 'Node'/);
  const button = code('components/wallet/connect-wallet-button.tsx');
  assert.match(button, /const held = useHeldWallet\(\);/);
  assert.match(button, /<Link href="\/node" className="qnet-button wallet-button wallet-held" title=\{held\}>\s*\{shortAddress\(held\)\}\s*<\/Link>/);
  // Owner, 29.09: a computer with the QNet extension connects from the header at once (the connect card's call), and
  // My node keeps that wallet as one connected with a tap, then opens; a phone, or no extension, goes to the card.
  assert.match(button, /const direct = fullView && providerStatus === 'available' && providerChannel === 'extension' && device !== null && !device\.phone;/);
  assert.match(button, /const connectExtension = \(\) => \{\s*setAsked\(true\);\s*if \(!accounts\) void connect\(\);\s*\};/);
  assert.match(button, /chooseWallet\(\{ qnet: accounts\.qnet, source: 'extension', solana: accounts\.solana \}\);\s*if \(!isNodePath\(pathname\)\) router\.push\('\/node'\);/);
  assert.match(button, /\) : direct \? \(\s*<button type="button" className="qnet-button wallet-button" onClick=\{connectExtension\} disabled=\{connecting\} aria-busy=\{connecting\}>/);
  assert.match(button, /<Link href=\{`\/node#\$\{CONNECT_ID\}`\} className="qnet-button wallet-button" onClick=\{toConnect\}>/);
  // On a page with the card, the card is brought into view, focused and marked for a moment.
  assert.match(button, /const card = document\.getElementById\(CONNECT_ID\);\s*if \(!card\) return;\s*event\.preventDefault\(\);\s*showConnectCard\(card, true\);/);
  const flash = code('lib/cabinet/connect-card.ts');
  assert.match(flash, /card\.focus\(\{ preventScroll: true \}\);/);
  assert.match(flash, /card\.classList\.add\(FLASH_CLASS\);/);
  assert.match(CSS, /\.cabinet-connect-card\.cabinet-flash \{\n {2}animation: cabinet-flash 1\.6s ease-out;/);
  // The header reads the one remembered wallet and Disconnect mark, through My node's provider, and hears their changes.
  const provider = code('components/cabinet/CabinetProvider.tsx');
  assert.match(provider, /export function useHeldWallet\(\): string \| null \{/);
  assert.match(provider, /const read = \(\) => \{\s*const storage = localStore\(\);\s*setKept\(heldHere \?\? \{ choice: loadChoice\(storage\), disconnected: loadDisconnected\(storage\) \}\);\s*\};/);
  // Choosing, Disconnect, the header's wallet and the extension's wallet taken up all write through one step that tells
  // the page; My node's pages hear it too.
  assert.equal(provider.match(/window\.dispatchEvent\(new Event\(HELD_EVENT\)\);/g)?.length, 1);
  assert.match(provider, /export function chooseWallet\(next: WalletChoice\): void \{\s*hold\(next, next\.source !== 'entered' \? false : undefined\);\s*\}/);
  assert.match(provider, /window\.addEventListener\(HELD_EVENT, onHeld\);/);
  const screen = code('components/cabinet/ConnectScreen.tsx');
  assert.match(screen, /if \(!shown \|\| window\.location\.hash !== `#\$\{CONNECT_ID\}`\) return;\s*if \(card\.current\) showConnectCard\(card\.current, false\);/);
  // A tap on a link in the phone's menu closes it, a link that stays on the page included.
  assert.match(code('components/Header.tsx'), /if \(\(e\.target as HTMLElement\)\.closest\('a'\)\) setIsMenuOpen\(false\);/);
  // The sitemap names the guide; the guide is readable without a wallet and indexed like /node.
  assert.match(read('app/sitemap.ts'), /'\/node', '\/docs', '\/docs\/how-it-works',/);
  assert.doesNotMatch(read('app/docs/how-it-works/page.tsx'), /robots/);
});

// Owner, 04.10: the matrix rain runs behind My node too, as on every other page; the cards, the way, the sections and
// any line outside a card are drawn over it on opaque, blurred panels.
test('My node keeps the site\'s rain, with its panels drawn opaque over it', () => {
  for (const path of ['/node', '/node/activate', '/node/device']) assert.equal(isNodePath(path), true, path);
  for (const path of ['/', '/explorer', '/nodes', '/nodeX', null]) assert.equal(isNodePath(path), false, String(path));
  const rain = code('components/MatrixRain.tsx');
  assert.doesNotMatch(rain, /still|isNodePath|usePathname/);
  assert.match(rain, /if \(!canvas\) return;/);
  assert.doesNotMatch(CSS, /\.still-backdrop/);
  assert.match(code('components/SiteShell.tsx'), /<MatrixRain \/>/);
  const card = block('.activate-card');
  assert.match(card, /background: rgba\(0, 8, 16, 0\.92\);/);
  assert.match(card, /backdrop-filter: blur\(15px\);/);
  assert.match(block('.guide-step'), /background: rgba\(0, 8, 16, 0\.92\);\n {2}-webkit-backdrop-filter: blur\(15px\);\n {2}backdrop-filter: blur\(15px\);/);
  assert.match(CSS, /\.cabinet \.cabinet-progress,\n\.cabinet \.cabinet-nav,\n\.cabinet > p,\n\.cabinet > div\[role='alert'\] \{\n {2}border-radius: 12px;\n {2}background: rgba\(0, 8, 16, 0\.9\);\n {2}-webkit-backdrop-filter: blur\(15px\);\n {2}backdrop-filter: blur\(15px\);/);
});

// The rules of one selector block, in `within` (a media query's text, or the whole sheet).
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function block(selector, within = CSS) {
  const m = new RegExp(`^[ \\t]*${escape(selector)} \\{`, 'm').exec(within);
  assert.ok(m, selector);
  return within.slice(m.index, within.indexOf('}', m.index));
}
function lastMedia(query) {
  const at = CSS.lastIndexOf(`@media (${query}) {`);
  assert.ok(at >= 0, query);
  let depth = 0;
  for (let i = CSS.indexOf('{', at); i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(at, i + 1);
  }
  assert.fail(query);
}

test('phones: the way fits four across, the guide stacks its picture under its words, buttons take the row', () => {
  assert.match(block('.cabinet-progress'), /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(block('.guide-step'), /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 360px\);/);
  assert.match(block('.guide-art'), /max-width: 360px;\n {2}height: auto;/);
  assert.match(block('.guide-art-phone'), /max-width: 250px;/);
  assert.match(block('.guide-switch-option'), /min-height: 48px;/);
  const phone = lastMedia('max-width: 640px');
  assert.match(block('.guide-step', phone), /grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(phone, /\.cabinet-wallet-foot \.qnet-button,\n {2}\.cabinet \.cabinet-option > \.qnet-button,\n {2}\.guide-connect > \.qnet-button \{\n {4}align-self: stretch;\n {4}width: 100%;/);
  // The base rules come before the phone rules that change them.
  for (const selector of ['.cabinet-progress-dot', '.guide-step', '.guide-art', '.cabinet-address']) {
    assert.ok(CSS.indexOf(`${selector} {`) < CSS.lastIndexOf('@media (max-width: 640px) {'), selector);
  }
  // Two columns (connect, How it works) only where they fit.
  assert.match(CSS, /@media \(min-width: 900px\) \{\n {2}\.cabinet-connect \{\n {4}grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);/);
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
  assert.match(block('.guide-art-narrow'), /display: none;/);
  assert.ok(CSS.indexOf('.guide-art-narrow {') > CSS.indexOf('.guide-art {'));
  const phone = lastMedia('max-width: 640px');
  assert.match(block('.guide-art-wide', phone), /display: none;/);
  assert.match(block('.guide-art-narrow', phone), /display: block;\n {4}max-width: 360px;/);
});

// Review, 28.09: a phone without QNet Wallet had no way to it on the connect screen (a computer is offered the
// extension); a node read that lands between a component's render and its subscription is still shown.
test('a phone without QNet Wallet is told where to get it, and a node read is never missed', () => {
  const choice = code('components/cabinet/WalletChoice.tsx');
  assert.match(choice, /\) : device\.phone && \(\s*<div className="cabinet-option">\s*<p className="activate-note">\{t\('connect_get_app'\)\}<\/p>\s*<Link className="qnet-button secondary" href="\/wallet">\{t\('connect_get_app_link'\)\}<\/Link>/);
  assert.match(TEXTS.connect_get_app, /^No QNet Wallet on this phone yet\?/);
  assert.equal(TEXTS.connect_get_app_link, 'Get QNet Wallet');
  const hook = code('hooks/useNodeStatus.ts');
  assert.match(hook, /const state = useSyncExternalStore\(subscribe, snapshot, \(\) => LOADING\) as Loaded<T>;/);
  assert.doesNotMatch(hook, /useReducer/);
  assert.match(code('components/Header.tsx'), /aria-label="Toggle menu" aria-expanded=\{isMenuOpen\}/);
});

// Owner, 29.09: real epochs everywhere, no placeholders; a wallet without a node is told so, with the way on.
test('the epochs: every one on History with the ones still in the node balance, the newest on the Overview', () => {
  const history = code('components/cabinet/NodeHistory.tsx');
  for (const key of ['history_col_epoch', 'history_col_ended', 'history_col_result', 'history_col_amount', 'history_col_moved']) assert.ok(history.includes(`t('${key}')`), key);
  for (const result of ['counted', 'moved', 'missed', 'joined', 'unchecked', 'unknown']) assert.ok(TEXTS[`history_${result}`], result);
  assert.match(history, /<Link href=\{`\/explorer\/tx\/\$\{row\.claimTx\}`\} className="activate-mono">/);
  assert.match(history, /const waiting = view\.rows\.filter\(\(r\) => r\.result === 'counted'\);/);
  // Without the registration's epoch, epochs from before the node may be listed: one not counted is not called missed.
  assert.match(history, /const startKnown = view\.registeredEpoch !== null;/);
  assert.match(history, /\{t\(row\.result === 'missed' && !startKnown \? 'history_not_counted' : RESULT_TEXT\[row\.result\]\)\}/);
  assert.equal(history.match(/<Table rows=\{[^}]+\} startKnown=\{startKnown\} \/>/g)?.length, 4);
  assert.equal(TEXTS.history_not_counted, 'Not counted');
  assert.match(history, /\{!startKnown && <p className="activate-note">\{t\('history_no_start'\)\}<\/p>\}/);
  assert.match(history, /\{!view\.archived && <p className="activate-note">\{t\('history_no_archive'\)\}<\/p>\}/);
  assert.match(code('components/cabinet/NodeHome.tsx'), /<Epochs nodeId=\{nodeId\} show="recent" \/>/);
  assert.match(history, /<h3 className="activate-step">\{t\('claim_epochs_title'\)\}<\/h3>\s*<Epochs nodeId=\{nodeId\} show="balance" \/>/);
  assert.match(history, /<Epochs nodeId=\{nodeId\} show="all" \/>/);
  assert.match(history, /<Link href=\{TAB_HREF\.history\} className="qnet-button secondary">\{t\('history_see_all'\)\}<\/Link>/);
  // No text speaks of earnings here either.
  for (const key of Object.keys(TEXTS).filter((k) => /^(history|claim_epochs|next)_/.test(k))) assert.doesNotMatch(TEXTS[key], /reward|\bearn/i, key);
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
  assert.match(rows, /\{full && named && deviceName\(named\) && <p>\{deviceName\(named\)\}<\/p>\}/);
  assert.match(rows, /\{full && !viewOnly && device\?\.linkedSince != null && <p>\{t\('device_linked_since', \{ day: DAY\.format\(device\.linkedSince \* 1000\) \}\)\}<\/p>\}/);
  assert.match(rows, /\? <p>\{last === null \? t\('device_no_answer'\) : t\('device_last_answer', \{ epoch: number\(last\) \}\)\}<\/p>/);
  assert.match(rows, /const DAY = new Intl\.DateTimeFormat\('en', \{ year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' \}\);/);
  for (const [key, words] of [['device_platform_android', 'Android'], ['device_platform_ios', 'iPhone or iPad'], ['device_platform_unknown', 'Unknown device'],
    ['device_no_answer', 'No answer yet'], ['badge_waiting', 'Waiting'], ['unlink_title_wallet', 'Unlink the device'], ['device_wake_overview', 'Wake it from Overview']]) {
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
  assert.match(unlink, /<p className="activate-note">\{t\(wallet \? 'unlink_lost_wallet' : 'unlink_lost'\)\}<\/p>/);
  assert.doesNotMatch(unlink, /fetch\(|\/api\/cabinet/);
  const link = code('components/cabinet/LinkDevice.tsx');
  assert.match(link, /const title: MessageKey = move \? 'devices_move_title' : 'action_link_device';/);
  assert.match(link, /\{t\(move \? 'devices_move_lead' : 'devices_link_lead'\)\}/);
  for (const key of ['unlink_title', 'unlink_lead', 'unlink_button', 'unlink_lost', 'unlink_closed', 'unlink_answer_ok', 'unlink_answer_unconfirmed',
    'link_error_NOT_LINKED', 'link_error_UNLINK_REFUSED', 'unlink_error_NOT_LINKED', 'unlink_error_NETWORK', 'unlink_error_UNLINK_REFUSED',
    'devices_move_title', 'devices_move_lead', 'devices_last_counted', 'devices_not_counted']) {
    assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, key), key);
  }
  assert.deepEqual(TEXTS.devices_last_counted.match(/\{\w+\}/g), ['{epoch}']);
});
