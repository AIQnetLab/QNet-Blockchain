// How it works (/docs/how-it-works, src/lib/cabinet/guide.ts): the three guides name every button, tab and screen in the
// words QNet Wallet, the QNet extension and this site show; a picture draws only the labels of the screen it shows, and
// at most one thing to press; the steps follow the release's network and the site's phone flows; the numbers the steps
// give are the apps' own; no step asks to keep the app running or names a phone setting, and no answer sends the reader
// to write to anyone or to a button only the phone flows show; the words stay plain. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { TEXTS } from '../texts.ts';
import { RUNNING_A_NODE, SHORT_COMPUTER, SHORT_PHONE, SHORT_SUPER, computerGuide, partLabels, phoneGuide, sceneLabels, superGuide } from '../cabinet/guide.ts';
import { TABS } from '../cabinet/tabs.ts';

const REPO = new URL('../../../../../../', import.meta.url);
const repo = (path) => readFileSync(new URL(path, REPO), 'utf8');
const APP = (await import(new URL('applications/qnet-mobile/src/i18n/locales/en.js', REPO).href)).default;
const EXT = (await import(new URL('applications/qnet-wallet/dist/ui/i18n/en.js', REPO).href)).default;
// Typography that is not wording: curly or straight apostrophes, case.
const norm = (s) => s.replace(/[’']/g, "'").toLowerCase();

const ALL = [
  { network: 'testnet', phoneFlows: true },
  { network: 'mainnet', phoneFlows: true },
  { network: 'testnet', phoneFlows: false },
  { network: 'mainnet', phoneFlows: false },
];
const guides = (o) => [...(phoneGuide(o) ?? []), ...computerGuide(o), ...superGuide(o)];

// The labels of QNet Wallet's screens and of the extension's window and setup tab, each the app's or the extension's own
// text of that label.
const UI_APP = {
  ui_app_name: APP.qnet_wallet,
  ui_app_welcome: APP.welcome_subtitle,
  ui_app_create_new: APP.create_new_wallet,
  ui_app_import: APP.import_wallet,
  ui_app_create: APP.create_wallet,
  ui_app_terms: APP.terms_accept_template.replace('{terms}', APP.terms_of_service),
  ui_app_seed_title: APP.seed_save_title,
  ui_app_wrote: APP.seed_wrote_it,
  ui_app_confirm_title: APP.seed_confirm_title,
  ui_app_select_word: APP.seed_select_word_label,
  ui_app_confirm_create: APP.seed_confirm_create,
  ui_app_import_title: APP.import_title,
  ui_app_phrase: APP.import_placeholder,
  ui_app_share_title: APP.link_title_connect,
  ui_app_link_title: APP.link_title_link,
  ui_app_reserve_title: APP.link_title_reserve,
  ui_app_origin: APP.link_origin,
  ui_app_qnet_address: APP.link_qnet_address,
  ui_app_solana_address: APP.link_solana_address,
  ui_app_link_node: APP.link_node,
  ui_app_link_wallet: APP.link_wallet,
  ui_app_reject: APP.link_reject,
  ui_app_confirm: APP.link_confirm,
  ui_app_node_tab: APP.tab_node,
  ui_app_node_balance: APP.node_balance,
  ui_app_use: APP.node_use,
  copy: APP.seed_copy,
  no_device: APP.node_no_device,
  action_move: APP.node_move,
};
const UI_EXT = {
  // The name over the extension's window in every picture (GuideArt.tsx).
  ui_ext_name: EXT.appName,
  ui_ext_setup_page: EXT.setupPageTitle,
  ui_ext_welcome_lead: EXT.welcomeLead,
  ui_ext_welcome_setup: EXT.welcomeSetup,
  ui_ext_setup_welcome: EXT.setupWelcomeTitle,
  ui_ext_setup_title: EXT.setupCreateTitle,
  ui_ext_create: EXT.setupCreateChoice,
  ui_ext_import: EXT.setupImportChoice,
  ui_ext_written: EXT.setupWrittenAck,
  ui_ext_continue: EXT.continue,
  ui_ext_verify_title: EXT.setupVerifyTitle,
  ui_ext_word: EXT.setupWordN.replace('$1', '{n}'),
  ui_ext_check: EXT.setupVerifyButton,
  ui_ext_password_title: EXT.setupPasswordTitle,
  ui_ext_new_password: EXT.passwordNew,
  ui_ext_repeat_password: EXT.passwordConfirm,
  ui_ext_create_wallet: EXT.setupCreateButton,
  ui_ext_qnet: EXT.networkQnet,
  ui_ext_solana: EXT.networkSolana,
  ui_ext_assets: EXT.tab_assets,
  ui_ext_send: EXT.tab_send,
  ui_ext_receive: EXT.tab_receive,
  ui_ext_history: EXT.tab_history,
  ui_ext_settings: EXT.tab_settings,
  ui_ext_activate: EXT.tab_activate,
  ui_ext_copy_address: EXT.receiveCopy,
  ui_ext_connect_title: EXT.apTitle_connect,
  ui_ext_connect: EXT.apConfirm_connect,
  ui_ext_reject: EXT.apReject,
  ui_ext_activate_title: EXT.apTitle_activate_light,
  ui_ext_activate_super_title: EXT.apTitle_activate_super,
  ui_ext_ack: EXT.activateAck.replace('$1', '{amount}'),
  ui_ext_burn: EXT.activateBurnButton.replace('$1', '{amount}'),
  ui_ext_claim_title: EXT.apTitle_claimNodeBalance,
  ui_ext_move: EXT.apConfirm_claimNodeBalance,
};

// This site's pages and components, without the guide's own drawing and page.
function siteSources() {
  const root = new URL('../../', import.meta.url);
  const skip = new Set(['components/cabinet/GuideArt.tsx', 'components/cabinet/NodeGuide.tsx', 'components/cabinet/GuideSummary.tsx']);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(new URL(dir, root))) {
      const path = `${dir}${name}`;
      if (statSync(new URL(path, root)).isDirectory()) walk(`${path}/`);
      else if (/\.tsx?$/.test(name) && !skip.has(path)) out.push(readFileSync(new URL(path, root), 'utf8'));
    }
  };
  walk('app/');
  walk('components/');
  return out.join('\n');
}

test('the pictures\' labels are the app\'s and the extension\'s own words', () => {
  for (const [key, words] of Object.entries({ ...UI_APP, ...UI_EXT })) {
    assert.equal(typeof words, 'string', key);
    assert.equal(norm(TEXTS[key]), norm(words), key);
  }
  // Every app and extension label key of the texts is checked here.
  for (const key of Object.keys(TEXTS).filter((k) => /^ui_(app|ext)_/.test(k))) assert.ok(key in UI_APP || key in UI_EXT, key);
  // The faucet page's own heading and button (the site writes its buttons in capitals).
  const testnet = readFileSync(new URL('../../app/testnet/page.tsx', import.meta.url), 'utf8');
  assert.ok(testnet.includes(`>${TEXTS.ui_faucet_title}<`));
  assert.ok(testnet.includes(`'${TEXTS.ui_faucet_button.toUpperCase()}'`));
});

// Owner, 06.10: a picture draws only what the user sees on that screen. On QNet Wallet's screens every label is the
// app's own, in the extension's window and its setup tab the extension's, and on this site's pages a text one of its
// pages shows.
test('every label a picture draws is one the screen it draws shows', () => {
  const site = siteSources();
  const lower = site.toLowerCase();
  const onSite = (key) => site.includes(`'${key}'`) || lower.includes(`>${TEXTS[key].toLowerCase()}<`) || site.includes(`'${TEXTS[key].toUpperCase()}'`);
  let drawn = 0;
  const used = new Set();
  for (const o of ALL) {
    for (const step of guides(o)) {
      const scene = step.scene;
      const groups = scene.frame === 'phone' ? [[scene.screen === 'app' ? 'app' : 'site', scene.parts]]
        : scene.frame === 'scan' ? [['site', scene.parts], ['app', scene.phone]]
          : [[scene.tab ? 'ext' : 'site', scene.parts], ['ext', scene.popup ?? []]];
      if (scene.frame === 'browser' && scene.tab) {
        assert.ok(scene.tab in UI_EXT, `${step.id}: the extension's tab`);
        used.add(scene.tab);
      }
      for (const [where, parts] of groups) {
        for (const label of partLabels(parts)) {
          if (typeof label !== 'string' && 'raw' in label) continue;
          const key = typeof label === 'string' ? label : label.key;
          drawn++;
          used.add(key);
          if (where === 'app') assert.ok(key in UI_APP, `${step.id}: ${key} on QNet Wallet's screen`);
          else if (where === 'ext') assert.ok(key in UI_EXT, `${step.id}: ${key} in the extension`);
          else assert.ok(onSite(key), `${step.id}: ${key} on this site's page`);
        }
      }
    }
  }
  assert.ok(drawn > 200, `${drawn} labels drawn`);
  // The drawing adds one label of its own: the extension's name over its window.
  const art = readFileSync(new URL('../../components/cabinet/GuideArt.tsx', import.meta.url), 'utf8');
  assert.deepEqual([...art.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]), ['ui_ext_name']);
  used.add('ui_ext_name');
  // No picture label is kept that no picture draws.
  for (const key of Object.keys(TEXTS).filter((k) => /^ui_/.test(k))) assert.ok(used.has(key), `${key}: no picture draws it`);
  // The screens the pictures draw, as the app and the extension build them: a phone with a screen lock shows no
  // password fields; the reservation sheet's rows are Node and Wallet; the words check offers word buttons (3 wrong
  // words and the right one); the Node tab's balance row and its move; the extension's window with no wallet and the
  // setup tab's two choices.
  const wallet = repo('applications/qnet-mobile/src/screens/WalletScreen.js');
  assert.match(wallet, /\{deviceAuth \? t\('create_protected'\) : t\('create_password_hint', \{ min: MIN_PASSWORD \}\)\}\s*<\/Text>\s*\{!deviceAuth && \(<>/);
  assert.match(APP.create_protected, /screen lock/);
  assert.match(wallet, /while \(randomWords\.length < 3\) \{/);
  assert.match(wallet, /\{wordChoices\[pos\]\?\.map\(\(word, idx\) => \(/);
  const sheet = repo('applications/qnet-mobile/src/screens/QNetLinkScreen.js');
  assert.match(sheet, /if \(o\.kind === 'reserve'\) \{\s*return \(\s*<>\s*<Text style=\{s\.text\}>\{t\('link_reserve_body'\)\}<\/Text>\s*\{row\(t\('link_node'\), o\.nodeId\)\}\s*\{addressRow\(t\('link_wallet'\), o\.qnet\)\}/);
  assert.match(sheet, /\{addressRow\(t\('link_qnet_address'\), o\.addresses\.qnet\)\}\s*\{addressRow\(t\('link_solana_address'\), o\.addresses\.solana\)\}/);
  assert.match(repo('applications/qnet-mobile/src/crypto/NodePreimages.js'), /return `light_mobile_\$\{bytesToHex\(blake3\(utf8ToBytes\(`LIGHT_NODE_PRIVACY_\$\{walletOf\(wallet\)\}`\)\)\)\.slice\(0, 16\)\}`;/);
  const node = repo('applications/qnet-mobile/src/screens/NodeTab.js');
  assert.match(node, /<Row label=\{t\('node_balance'\)\} value=\{balanceText\(balanceNano, hidden\)\} ltr \/>\s*<Button label=\{moving \? t\('claiming'\) : t\('node_move'\)\}/);
  const popup = repo('applications/qnet-wallet/dist/ui/popup.js');
  // With no wallet of this version and none the store's 2.1.x left (earlier.js), the window the picture draws; with one
  // of 2.1.x it offers to move that wallet instead.
  assert.match(popup, /const earlier = state\.status\?\.earlier === true;/);
  assert.match(popup, /el\('p', \{ className: 'lead', text: t\(earlier \? 'setupEarlierLead' : 'welcomeLead'\) \}\),\s*button\(t\(earlier \? 'setupEarlierUnlock' : 'welcomeSetup'\),/);
  const setup = repo('applications/qnet-wallet/dist/ui/setup.js');
  assert.match(setup, /heading\(t\('setupWelcomeTitle'\)\),[\s\S]{0,400}button\(t\('setupCreateChoice'\)[\s\S]{0,300}button\(t\('setupImportChoice'\)/);
  // The Activate tab's two node type cards, each with its price (ExtensionActivate.tsx).
  const activate = readFileSync(new URL('../../components/cabinet/ExtensionActivate.tsx', import.meta.url), 'utf8');
  assert.match(activate, /\{NODE_TYPES\.map\(\(type\) => \(/);
  assert.match(activate, /<span className="activate-type-price"><PriceLabel price=\{prices\[type\]\} \/><\/span>/);
  for (const o of ALL) {
    for (const step of guides(o).filter((s) => s.id === 'activate')) {
      const choice = step.scene.parts.find((p) => p.kind === 'choice');
      assert.deepEqual(choice.items.map((i) => [i.label, i.note, i.price.key]), [['ext_type_light', 'ext_type_light_where', 'ext_price'], ['ext_type_super', 'ext_type_super_where', 'ext_price']]);
    }
  }
  // My node's tab row: Overview, Activate, Device, History, without Activate once the node exists (tabs.ts).
  const row = TABS.map((tab) => `nav_${tab}`);
  for (const o of ALL) {
    for (const step of guides(o)) {
      for (const p of [...step.scene.parts, ...(step.scene.popup ?? [])].filter((x) => x.kind === 'tabs' && x.items.includes('nav_overview'))) {
        assert.ok([row, row.filter((k) => k !== 'nav_activate')].some((r) => JSON.stringify(r) === JSON.stringify(p.items)), `${step.id}: ${p.items}`);
      }
    }
  }
});

// Owner, 06.10: the guide has no step about keeping the app running or phone settings, short version included (the
// Node tab carries the background row itself); Support keeps the settings for a phone that misses epochs. Owner, 05.10:
// no "write to support": the guide and the cabinet say what the user can do himself.
test('no guide step about keeping the app running or phone settings, and no text sends the reader to write to anyone', () => {
  // The network wakes the app with a push of high priority on Android and a background push on iOS, and the app answers
  // from the background.
  const push = repo('development/qnet-integration/src/rpc/light_push.rs');
  assert.match(push, /"priority": "high"/);
  assert.match(push, /"apns-push-type": "background"/);
  assert.match(repo('applications/qnet-mobile/index.js'), /messaging\(\)\.setBackgroundMessageHandler\(/);
  // The app asks for no battery permission.
  assert.doesNotMatch(repo('applications/qnet-mobile/android/app/src/main/AndroidManifest.xml'), /IGNORE_BATTERY_OPTIMIZATIONS/);
  assert.ok(!('guide_background' in TEXTS));
  const guideKeys = Object.keys(TEXTS).filter((k) => /^guide_/.test(k));
  assert.ok(guideKeys.some((k) => /^guide_short_/.test(k)));
  for (const key of guideKeys) {
    assert.doesNotMatch(TEXTS[key], /keep the app running|in the background|swipe|Background App Refresh|Unrestricted|battery|(?:phone|device)(?:'s)? settings|Settings →/i, key);
  }
  for (const o of ALL) assert.ok(!guides(o).some((s) => s.id === 'background' || s.id === 'settings'), 'no background or settings step');
  // No update instructions: updates come from the stores.
  for (const key of guideKeys) assert.doesNotMatch(TEXTS[key], /\bupdate\b/i, key);
  // The first steps name both of the app's start buttons and the extension's create or import.
  assert.match(TEXTS.guide_phone_install, /tap "Create New Wallet" or "Import Existing Wallet"/);
  assert.match(TEXTS.guide_pc_setup, /^Click the QNet icon, then "Create or import a wallet": a setup tab opens\. Choose "Create a new wallet", or "Import a wallet"/);
  assert.match(TEXTS.support_epochs_apple, /Background App Refresh has to be on\./);
  assert.match(TEXTS.support_epochs_android, /the usual battery setting is enough on most phones\. If /);
  // Support names the settings, and promises no per-app way around a battery-saving mode.
  assert.match(TEXTS.support_epochs_apple, /the switch next to QNet Wallet must be on/);
  assert.match(TEXTS.support_epochs_android, /set its battery use to Unrestricted \(on some phones: No restrictions\)/);
  assert.match(TEXTS.support_epochs_battery, /^Battery restrictions for the app: allow QNet Wallet to run in the background in the device's settings\. A battery-saving mode can also hold/);
  // No answer and no text outside the Support page sends the reader to write to anyone.
  for (const key of Object.keys(TEXTS).filter((k) => !/^support_/.test(k))) assert.doesNotMatch(TEXTS[key], /write to|support@/i, key);
  for (const key of ['faq_help_q', 'faq_help_a', 'faq_support_link']) assert.ok(!(key in TEXTS), key);
  // A burn no code comes from: the cabinet says what the user can do himself; the running node's line tells nothing to
  // keep doing on the phone.
  assert.match(TEXTS.state_unusable, /To activate a node, press Disconnect and connect another wallet\.$/);
  assert.match(TEXTS.ext_error_BURN_UNUSABLE, /Do not start another activation of this wallet\.$/);
  assert.doesNotMatch(TEXTS.next_running, /swipe/i);
  const page = readFileSync(new URL('../../components/cabinet/NodeGuide.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /mailto:|support@|faq_help|\/support/);
  // The answers are the same with the site's phone flows on or off, so they name no button of My node that only the
  // phone flows show ("Move the node to another device" is a link request, NodeDevices.tsx / LinkDevice.tsx).
  assert.match(readFileSync(new URL('../../components/cabinet/LinkDevice.tsx', import.meta.url), 'utf8'), /if \(!phoneFlows\) \{\s*return \(/);
  for (const key of Object.keys(TEXTS).filter((k) => /^faq_/.test(k))) {
    assert.doesNotMatch(TEXTS[key], new RegExp(`${TEXTS.devices_move_title}|${TEXTS.claim_with_app}|${TEXTS.action_link_device}`), key);
  }
});

// A "quoted" label in a step is a label the user sees: the app's, the extension's or this site's, whole. A placeholder
// of that label ({name}, $1) stands for any value, and so does … in the step.
test('every quoted label in a step is one the app, the extension or this site shows', () => {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [...Object.values(APP), ...Object.values(EXT), ...Object.values(TEXTS)]
    .filter((v) => typeof v === 'string' && v.length < 120)
    .map((v) => new RegExp(`^${escape(norm(v)).replace(/\\\{\w+\\\}|\\\$\d/g, '.+')}$`));
  const stepKeys = Object.keys(TEXTS).filter((k) => /^(guide|faq)_/.test(k));
  let quoted = 0;
  for (const key of stepKeys) {
    for (const m of TEXTS[key].matchAll(/"([^"]+)"/g)) {
      quoted++;
      const label = norm(m[1]).replace(/…/g, 'x');
      assert.ok(patterns.some((p) => p.test(label)), `${key}: "${m[1]}"`);
    }
  }
  assert.ok(quoted >= 40, `${quoted} quoted labels`);
});

test('a picture shows only the site\'s texts, and at most one thing to press', () => {
  for (const o of ALL) {
    for (const step of guides(o)) {
      assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, step.text), step.text);
      if (step.also) assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, step.also), step.also);
      for (const label of sceneLabels(step.scene)) {
        if (typeof label === 'string') assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, label), `${step.id}: ${label}`);
        else if ('key' in label) assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, label.key), `${step.id}: ${label.key}`);
        // Example values only: an address, a code, a light node ID, a node balance, a token's or a host's name.
        else assert.match(label.raw, /^(?:[0-9A-Za-z]{6}…[0-9A-Za-z]{6}|QNET-[0-9A-Z]{6}-\d{6}-\d{6}|light_mobile_[0-9a-f]{16}|\d+(?:\.\d+)? QNC|1DEV|SOL|aiqnet\.io)$/, label.raw);
      }
      const scene = step.scene;
      const parts = [...scene.parts, ...(scene.popup ?? []), ...(scene.phone ?? [])];
      const hot = parts.filter((p) => p.hot).length + parts.filter((p) => p.kind === 'pair' && (p.left.hot || p.right.hot)).length
        + (scene.urlHot ? 1 : 0) + (scene.pin ? 1 : 0);
      assert.ok(hot <= 1, `${step.id}: ${hot} highlighted`);
    }
  }
});

test('the steps follow the release\'s network and the site\'s phone flows', () => {
  const ids = (steps) => steps.map((s) => s.id);
  const texts = (steps) => steps.map((s) => s.text);
  const strings = (scene) => sceneLabels(scene).filter((l) => typeof l === 'string');
  // Phone only exists while this site pays from a phone and sends QNet Wallet its requests.
  assert.equal(phoneGuide({ network: 'testnet', phoneFlows: false }), null);
  const phone = phoneGuide({ network: 'testnet', phoneFlows: true });
  assert.deepEqual(ids(phone), ['install', 'protect', 'words', 'words-check', 'open-site', 'connect', 'share', 'start', 'reserve', 'fund', 'burn', 'link', 'done', 'move']);
  // An import goes on at step 5, the first step after the wallet's own.
  assert.equal(phone[4].id, 'open-site');
  assert.match(TEXTS.guide_phone_install, /tap "Import Wallet" and go on at step 5\.$/);
  // A phone with a screen lock: no password fields.
  const step = (steps, id) => steps.find((s) => s.id === id);
  assert.ok(!step(phone, 'protect').scene.parts.some((p) => p.kind === 'field'));
  assert.deepEqual(strings(step(phone, 'protect').scene), ['ui_app_create', 'ui_app_terms', 'ui_app_create']);
  assert.match(TEXTS.guide_phone_protect, /^Tick "I accept the Terms of Service" and tap "Create Wallet"\. The app locks the wallet with your phone's screen lock; only a phone without one first asks for a password/);
  assert.deepEqual(step(phone, 'words-check').scene.parts.filter((p) => p.kind === 'picks').map((p) => p.count), [4, 4, 4]);
  assert.deepEqual(strings(step(phone, 'share').scene), ['ui_app_origin', 'ui_app_share_title', 'ui_app_qnet_address', 'ui_app_solana_address', 'ui_app_reject', 'ui_app_confirm']);
  // A1: QNet Wallet confirms the wallet the light node is for before the page shows a payment address.
  const reserve = step(phone, 'reserve');
  assert.equal(reserve.text, 'guide_phone_reserve');
  assert.deepEqual(strings(reserve.scene), ['ui_app_origin', 'ui_app_reserve_title', 'ui_app_link_node', 'ui_app_link_wallet', 'ui_app_reject', 'ui_app_confirm']);
  assert.match(TEXTS.guide_phone_start, /Tap "Make a payment address", then "Open QNet Wallet"\.$/);
  assert.equal(TEXTS.guide_phone_reserve, 'QNet Wallet shows "Set up a light node for this wallet", a request through aiqnet.io. Tap "Confirm", then switch back to the browser: the page shows the payment address and what to send to it.');
  // The testnet step taps Copy, and its picture rings it.
  assert.ok(step(phone, 'fund').scene.parts.some((p) => p.kind === 'button' && p.label === 'copy' && p.hot));
  assert.doesNotMatch(TEXTS.guide_phone_fund_mainnet, /scan|another screen/);
  // The burn shows its code in the Receipt card, then the Registered card opens My node.
  assert.match(TEXTS.guide_phone_burn, /the page shows your activation code, a receipt you never need to type\.$/);
  assert.equal(TEXTS.guide_phone_done, 'Wait one to three minutes until the page says "Registered on the QNet network.", then tap "Open My node".');
  assert.deepEqual(strings(step(phone, 'done').scene), ['act_receipt_title', 'act_code', 'act_done', 'act_go_cabinet']);
  const steps = readFileSync(new URL('../../components/cabinet/ActivateSteps.tsx', import.meta.url), 'utf8');
  const receipt = steps.slice(steps.indexOf('export function Receipt('), steps.indexOf('function ConfirmLoss('));
  for (const key of ['act_receipt_title', 'act_code']) assert.ok(receipt.includes(`t('${key}')`), key);
  const registered = steps.slice(steps.indexOf('export function Registered('));
  for (const key of ['act_done', 'act_go_cabinet']) assert.ok(registered.includes(`t('${key}')`), key);
  assert.doesNotMatch(TEXTS.guide_phone_link, /device check/);
  // The balance moves on QNet Wallet's Node tab, the app in the user's hand; My node's button is the other way.
  const move = step(phone, 'move');
  assert.equal(move.also, 'guide_or_move_site');
  assert.deepEqual(strings(move.scene), ['ui_app_node_tab', 'ui_app_node_balance', 'action_move']);
  assert.match(TEXTS.guide_phone_move, /From 1 QNC, open the "Node" tab in QNet Wallet and tap "Move to wallet"\.$/);
  assert.ok(texts(phone).includes('guide_phone_fund_testnet'));
  assert.ok(texts(phoneGuide({ network: 'mainnet', phoneFlows: true })).includes('guide_phone_fund_mainnet'));
  const computer = computerGuide({ network: 'testnet', phoneFlows: true });
  assert.deepEqual(ids(computer), ['install', 'setup', 'words', 'check', 'password', 'solana', 'tokens', 'connect', 'activate', 'burn', 'phone', 'link', 'move']);
  // The extension's window opens the setup tab, which offers create or import; an import goes on at the password.
  assert.deepEqual(strings(step(computer, 'setup').scene), ['ui_ext_setup_welcome', 'ui_ext_create', 'ui_ext_import', 'ui_ext_setup_page', 'ui_ext_welcome_lead', 'ui_ext_welcome_setup']);
  assert.equal(computer[4].id, 'password');
  assert.match(TEXTS.guide_pc_setup, /click "Continue" and go on at step 5\.$/);
  assert.match(TEXTS.guide_pc_password, /click "Create wallet" \("Import wallet" after an import\), then "Done"\.$/);
  // The setup tab closes on Done: the Solana step opens the extension again, before any page of this site.
  assert.match(TEXTS.guide_pc_solana, /^Click the QNet icon again/);
  for (const id of ['solana', 'tokens']) assert.equal(step(computerGuide({ network: 'mainnet', phoneFlows: true }), id).scene.url, undefined, id);
  assert.equal(step(computer, 'solana').scene.url, undefined);
  assert.match(TEXTS.guide_pc_link, /^Back on the computer, click "Link a device" on My node's Overview: a QR code appears\./);
  assert.ok(texts(computer).includes('guide_pc_tokens_testnet'));
  assert.ok(texts(computer).includes('guide_pc_link'));
  assert.ok(texts(computerGuide({ network: 'mainnet', phoneFlows: true })).includes('guide_pc_tokens_mainnet'));
  // Without the phone flows the phone takes the node from its own Node tab.
  assert.ok(texts(computerGuide({ network: 'testnet', phoneFlows: false })).includes('guide_pc_link_app'));
  assert.ok(!texts(computerGuide({ network: 'testnet', phoneFlows: false })).includes('guide_pc_link'));
  // The page picks by the release's network and the provider's flag, never by a setting of its own.
  const page = readFileSync(new URL('../../components/cabinet/NodeGuide.tsx', import.meta.url), 'utf8');
  assert.match(page, /const options = \{ network: ACTIVATION_NETWORK, phoneFlows \};/);
  assert.match(page, /function Guide\(\{ phoneFlows \}: \{ phoneFlows: boolean \}\) \{/);
  assert.match(readFileSync(new URL('../../app/docs/how-it-works/page.tsx', import.meta.url), 'utf8'), /return <NodeGuide phoneFlows=\{phoneFlowsEnabled\(\)\} \/>;/);
  // The short version: three steps from a phone, four from a computer and for a super node; the first steps say
  // create or import, and the computer's last one works with the phone flows on or off.
  assert.deepEqual(SHORT_PHONE, ['guide_short_phone_1', 'guide_short_phone_2', 'guide_short_phone_3']);
  assert.ok(!('guide_short_phone_4' in TEXTS));
  assert.equal(SHORT_COMPUTER.length, 4);
  assert.equal(SHORT_SUPER.length, 4);
  assert.equal(TEXTS.guide_short_phone_3, 'Activate: confirm in QNet Wallet, pay once, confirm again.');
  for (const key of ['guide_short_pc_1', 'guide_short_super_1']) {
    assert.equal(TEXTS[key], 'Create or import a wallet in the QNet extension and put 1DEV and a little SOL on it.', key);
  }
  assert.equal(TEXTS.guide_short_pc_4, 'In QNet Wallet on your phone, open the "Node" tab and tap "Use this device".');
  // How it works in short: three ways, the super node only with the extension; without the phone flows the phone way
  // says so instead of its steps.
  const summary = readFileSync(new URL('../../components/cabinet/GuideSummary.tsx', import.meta.url), 'utf8');
  assert.match(summary, /<Way title="guide_path_phone" steps=\{SHORT_PHONE\} closed=\{phoneFlows \? undefined : 'guide_phone_closed'\} \/>\s*<Way title="guide_path_computer" steps=\{SHORT_COMPUTER\} \/>\s*<Way title="guide_path_super" steps=\{SHORT_SUPER\} \/>/);
  assert.match(readFileSync(new URL('../../components/cabinet/ConnectScreen.tsx', import.meta.url), 'utf8'), /<GuideSummary phoneFlows=\{phoneFlows\} \/>/);
  assert.match(TEXTS.guide_short_super_2, /^Connect the extension here and activate a super node\.$/);
});

// R5 (owner, 29.09): the guide covers both node types. A light node: the burn, its code, QNet Wallet links the device,
// then My node follows it. A super node: the burn in the QNet extension, its code and the server steps on the page and
// later on the Overview in any browser, the server with the node software, then My node follows it, and QNet Wallet's
// Node tab moves its balance. No burn window asks for a password (SITE-F2, XC-01: a locked extension asks once to
// unlock), and the extension's window shows its six tabs.
test('the guide covers a light and a super node, and no burn window asks for a password', () => {
  const ids = (steps) => steps.map((s) => s.id);
  const sup = superGuide({ network: 'testnet', phoneFlows: true });
  assert.deepEqual(ids(sup), ['install', 'setup', 'words', 'check', 'password', 'solana', 'tokens', 'connect', 'activate', 'burn', 'code', 'server', 'watch', 'move']);
  const step = (id) => sup.find((x) => x.id === id);
  // Both type cards, Super selected (Light on the computer's light guide).
  assert.equal(step('activate').scene.parts.find((p) => p.kind === 'choice').current, 1);
  assert.equal(computerGuide({ network: 'testnet', phoneFlows: true }).find((x) => x.id === 'activate').scene.parts.find((p) => p.kind === 'choice').current, 0);
  assert.equal(step('burn').scene.popup[0].label, 'ui_ext_activate_super_title');
  assert.deepEqual(step('server').link, { href: RUNNING_A_NODE, label: 'ext_super_running' });
  // The page shows the code and every server step after the burn, and the Overview later, which the step links; the
  // extension's Activate tab keeps only the code, so the step promises nothing of it.
  assert.deepEqual(step('code').link, { href: '/node?tab=overview', label: 'next_open_overview' });
  assert.equal(TEXTS.guide_super_code, 'The page shows your activation code and every server step right away; later the Overview shows them in any browser where this wallet is connected.');
  assert.doesNotMatch(TEXTS.guide_super_code, /extension|Recover/);
  // The server scene shows the labels the page shows over its steps (NextSteps.tsx SuperNext, its Copy buttons).
  const next = readFileSync(new URL('../../components/cabinet/NextSteps.tsx', import.meta.url), 'utf8')
    + readFileSync(new URL('../../components/cabinet/CopyButton.tsx', import.meta.url), 'utf8');
  for (const label of sceneLabels(step('server').scene).filter((l) => typeof l === 'string')) {
    assert.ok(next.includes(`t('${label}')`), `the page shows ${label}`);
  }
  assert.deepEqual(sceneLabels(step('server').scene).filter((l) => typeof l === 'string').slice(0, 2), ['super_steps_title', 'super_step_start']);
  // A super node's balance moves only in QNet Wallet's Node tab (the site moves a light node's; the Overview says so).
  assert.deepEqual(sceneLabels(step('move').scene).filter((l) => typeof l === 'string'), ['ui_app_node_tab', 'ui_app_node_balance', 'action_move']);
  // From 1 QNC, as the app's button takes it (NodeTab.js BalanceBlock), and as the light guides say.
  assert.match(TEXTS.guide_super_move, /From 1 QNC, move it into the wallet: install QNet Wallet on a phone, tap "Import Existing Wallet" and type the same 12 words, then tap "Move to wallet" on its "Node" tab\.$/);
  assert.match(repo('applications/qnet-mobile/src/screens/NodeTab.js'), /const movable = known && balanceNano >= ONE_QNC_NANO;/);
  for (const key of ['guide_phone_move', 'guide_pc_move']) assert.match(TEXTS[key], /From 1 QNC, /, key);
  assert.equal(TEXTS.super_move, 'Move it to the wallet in QNet Wallet\'s Node tab.');
  // A4 (owner, 29.09): a super node only with the QNet extension on a computer, on the user's server; one node per
  // wallet.
  assert.match(TEXTS.guide_lead, /a super node, which is activated only in the QNet extension on a computer and runs on your server\. One wallet has one node\./);
  assert.match(TEXTS.guide_super_intro, /^A super node is activated only in the QNet extension on a computer, never from a phone or with a payment address\./);
  assert.match(TEXTS.guide_super_server, /^On a Linux server with a public IP address and Docker: open the ports, build the QNet node software, put this wallet's recovery phrase in a file and start the node with the code, the burn and its amount\. The Overview lists every command; Running a node explains each setting\.$/);
  assert.match(TEXTS.faq_one_a, /^One node per wallet: a light node or a super node, chosen once, and the QNet network refuses a second node of either type\./);
  assert.match(TEXTS.faq_one_a, /A super node runs on a server and is activated only in the QNet extension\.$/);
  assert.match(TEXTS.guide_super_watch, /online or not, when it was last seen, its heartbeats this epoch/);
  // The intro is the last line before step 1: no summary lines repeat it.
  for (const key of ['guide_light_summary', 'guide_super_summary']) assert.ok(!(key in TEXTS), key);
  const page = readFileSync(new URL('../../components/cabinet/NodeGuide.tsx', import.meta.url), 'utf8');
  assert.match(page, /<p className="activate-note">\{t\(WAY_INTRO\[way\]\)\}<\/p>\s*<\/div>/);
  // No password field in any burn window; the unlock is named in the step.
  for (const o of ALL) {
    for (const s of guides(o).filter((x) => x.id === 'burn' && x.scene.popup)) {
      assert.ok(!s.scene.popup.some((p) => p.kind === 'field'), `${s.text}: no password in the burn window`);
    }
  }
  for (const key of ['guide_pc_burn', 'guide_super_burn']) {
    assert.doesNotMatch(TEXTS[key], /type your wallet password/, key);
    assert.match(TEXTS[key], /\(a locked extension first asks for its password to unlock\)/, key);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, 'ui_ext_password'), false);
  for (const s of computerGuide({ network: 'testnet', phoneFlows: true }).filter((x) => x.scene.popup)) {
    const tabs = s.scene.popup.filter((p) => p.kind === 'tabs' && p.items.length > 2);
    for (const t of tabs) assert.deepEqual(t.items, ['ui_ext_assets', 'ui_ext_send', 'ui_ext_receive', 'ui_ext_history', 'ui_ext_activate', 'ui_ext_settings'], s.id);
  }
  // The page offers the three ways and keeps the pick in ?way=.
  assert.match(page, /const WAYS: Way\[\] = \['phone', 'computer', 'super'\];/);
  assert.match(page, /if \(way === 'phone' \|\| way === 'computer' \|\| way === 'super'\) setPicked\(way\);/);
  assert.match(page, /const steps = way === 'phone' \? phoneGuide\(options\) : way === 'super' \? superGuide\(options\) : computerGuide\(options\);/);
});

test('the numbers the steps give are the apps\' own: 12 words, 3 checked, a password of 8 characters', () => {
  assert.match(repo('applications/qnet-mobile/src/crypto/PasswordStrength.js'), /export const PASSWORD_MIN_LENGTH = 8;/);
  assert.match(repo('applications/qnet-mobile/src/screens/WalletScreen.js'), /while \(verifyPositions\.length < 3\) \{/);
  assert.match(repo('applications/qnet-mobile/src/screens/WalletScreen.js'), /const allPositions = \[\.\.\.Array\(12\)\.keys\(\)\];/);
  assert.match(repo('applications/qnet-wallet/dist/ui/setup.js'), /const WORDS_TO_VERIFY = 3;/);
  assert.equal(EXT.err_WEAK_PASSWORD, 'The password needs at least 8 characters.');
  for (const key of ['guide_phone_protect', 'guide_pc_password']) assert.match(TEXTS[key], /at least 8 characters/, key);
  for (const key of ['guide_phone_words_check', 'guide_pc_check']) assert.match(TEXTS[key], /\b3\b/, key);
  for (const key of ['guide_phone_words', 'guide_pc_words']) assert.match(TEXTS[key], /12 words/, key);
  // The faucet's amounts and the burn's wait, as the site states them.
  assert.match(TEXTS.act_burning, /up to 90 s/);
  assert.match(TEXTS.guide_phone_burn, /up to 90 seconds/);
  assert.match(TEXTS.registration_pending, /one to three minutes/);
  assert.match(TEXTS.guide_phone_done, /one to three minutes/);
});

// Owner, 28.09: "so that old and young can manage it". The cabinet's own new words carry no network jargon, and
// "epoch" always comes with what it is.
test('the words stay plain: no jargon, and an epoch is always said to be about 4 hours', () => {
  const plain = Object.keys(TEXTS).filter((k) => /^(guide|faq|connect|progress|wallet_source|wallet_label|wallet_copy|wallet_disconnect|overview|epoch_note|nav_)/.test(k));
  assert.ok(plain.length > 80);
  for (const key of plain) {
    assert.doesNotMatch(TEXTS[key], /\b(relay|attestation|attest|quorum|consensus|genesis|validator|macroblock|shard|nonce|ML-DSA)\b/i, key);
    if (/\bepoch/i.test(TEXTS[key])) assert.match(TEXTS[key], /about 4 hours/, key);
  }
  // Each step says what to do in a few sentences.
  for (const key of plain.filter((k) => /^guide_(phone|pc|super)_/.test(k))) {
    assert.ok(TEXTS[key].split(/(?<=[.!?:])\s+(?=[A-Z])/).length <= 4, key);
  }
});

// Review, 28.09: a step that sends the reader to another page of this site links it.
test('the steps that send to the Wallet page or the faucet link them', () => {
  const link = (steps, id) => steps.find((s) => s.id === id).link;
  const wallet = { href: '/wallet', label: 'guide_link_wallet' };
  assert.deepEqual(link(phoneGuide({ network: 'testnet', phoneFlows: true }), 'install'), wallet);
  assert.deepEqual(link(computerGuide({ network: 'testnet', phoneFlows: true }), 'install'), wallet);
  assert.deepEqual(link(computerGuide({ network: 'testnet', phoneFlows: false }), 'tokens'), { href: '/testnet', label: 'guide_link_faucet' });
  assert.equal(link(computerGuide({ network: 'mainnet', phoneFlows: true }), 'tokens'), undefined);
  for (const o of ALL) for (const step of guides(o)) if (step.link) assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, step.link.label), step.id);
  const page = readFileSync(new URL('../../components/cabinet/NodeGuide.tsx', import.meta.url), 'utf8');
  assert.match(page, /\{step\.link && <Link href=\{step\.link\.href\} className="guide-step-link">\{t\(step\.link\.label\)\}<\/Link>\}/);
  assert.match(readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8'), /\.guide-step-link \{[^}]*min-height: 44px;/);
});
