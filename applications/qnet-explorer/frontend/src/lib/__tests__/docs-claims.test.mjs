// What the repository's README, the operator guide, the mobile wallet doc and the QNet Link protocol say
// about who burns and in which order, checked against what the site implements. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, parseLink, validateActivation } from '../qnet-link.ts';
import { REPO, read as site, repo as read } from './source.mjs';
import { TEXTS } from './texts-helper.mjs';
const flat = (text) => text.replace(/\s+/g, ' ');

// Wording of a phone that burns for a request of aiqnet.io/activate, which no document may say.
const APP_BURNS = [
  /the mobile app, only for an activation request from aiqnet\.io\/activate/i, /by the app for a confirmed aiqnet\.io\/activate request/i,
  /\| Light \| Mobile app only \| Activation code of the wallet's burn/,
];

// The cabinet's one-time payment key burns a Light activation (src/lib/cabinet/payment-key.ts)
// and the extension burns with the wallet's own key; QNet Wallet makes no burn and takes no code (revision 2 links carry
// connect, link, claim, reserve and unlink only, src/lib/qnet-link.ts).
test('the README and the operator guide name the two places that burn, and what the app does', () => {
  const readme = flat(read('README.md'));
  const section = readme.slice(readme.indexOf('## Node activation'), readme.indexOf('## Repository layout'));
  assert.match(section, /The Phase 1 burn is made in one of two places, with one activation per wallet: the QNet Wallet browser extension burns with the wallet's own key, from its Activate tab or when the node cabinet at aiqnet\.io\/node asks it \(`qnet_activateNode`\); and the node cabinet itself, in a phone's or a computer's browser, burns with a one-time payment key it creates in the page, whose activation code names the wallet the burn is for/);
  assert.match(section, /QNet Wallet on a phone or tablet signs the wallet's consent to the registration and links the node to its device/);
  const guide = flat(read('docs/operators/running-a-node.md'));
  assert.match(guide, /\| Light \| QNet Wallet on a phone or tablet only, one device per node \| Registered on aiqnet\.io\/node \(the cabinet's one-time payment key burns and QNet Wallet signs the wallet's consent\) or by the QNet Wallet browser extension \| No \| No \|/);
  assert.match(guide, /The app links the node to its device \("Use this device"\) and moves the node balance\./);
  for (const [name, text] of [['README.md', readme], ['running-a-node.md', guide], ['mobile-wallet.md', flat(read('docs/applications/mobile-wallet.md'))]]) {
    for (const pattern of APP_BURNS) assert.doesNotMatch(text, pattern, `${name}: ${pattern}`);
  }
  // What the site does: the payment key signs the burn; the code names the wallet (flow.ts receiptCode).
  assert.match(site('lib/cabinet/payment-key.ts'), /export async function signBurn\(/);
  assert.match(site('lib/cabinet/flow.ts'), /activationCode\('light', wallet, record\.burn\.tx, record\.burn\.amount\)/);
});

test('the protocol: HISTORY_TOO_LONG and the site\'s codes agree; pending covers another device\'s burn; the hold rule', () => {
  const protocol = read('docs/protocols/qnet-link-v1.md');
  const table = protocol.slice(protocol.indexOf('| `error` | Meaning'), protocol.indexOf('Once a burn has been sent'));
  const codes = [...table.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(codes, [...ERROR_CODES]);
  const text = flat(protocol);
  assert.match(text, /\| `HISTORY_TOO_LONG` \| Solana was read, but this wallet's burn history could not be searched back to its start in one attempt/);
  // The burn no code derives from, in the table and in the app's order of checks.
  assert.match(text, /\| `BURN_UNUSABLE` \| the wallet already made a 1DEV burn of its own that yields no Light or Super code: a successful Token-program burn of the cluster's 1DEV mint that the wallet paid for, signed and authorized, with another memo \(such as `QNET_NODE_TYPE:FULL`\) or from a 1DEV token account other than the associated one/);
  assert.match(text, /a burn of the wallet's own that yields no code \(section 7, `BURN_UNUSABLE`\), finalized or confirmed, among the candidates of that search or burned from any other of the wallet's 1DEV token accounts \(every such burn is a transaction the wallet signed, so it lists in the history of the wallet's own address, a closed account's included\) → `BURN_UNUSABLE`; a search for such burns that has not reached the start of that history fails closed as above; the QNet Blockchain wallet already has a node → `NODE_EXISTS`/);
  assert.match(text, /A burn of the wallet's own that yields no code, found as in section 8, is answered `BURN_UNUSABLE` without burning\./);
  assert.match(text, /`pending`: a valid burn of this wallet is on its way and not final yet: one this wallet sent \(now, or earlier and still recorded\), or one Solana reports as confirmed but not finalized, which another device of the same wallet sent/);
  assert.match(text, /\| `BURN_IN_PROGRESS` \| another activation request is running in this wallet \(its own one-at-a-time lock\); a burn of this wallet seen on Solana and not final is `pending`, never this code \|/);
  assert.doesNotMatch(text, /Neither wallet sees the other's burn before Solana finalizes it/);
  // The page's hold after an answer that leaves a burn possible: only the extension answers `activate` now.
  assert.match(text, /So once a burn may be on its way \(a `pending` answer, an `error` answer `BURN_IN_PROGRESS` or `INTERNAL`, or a call that timed out, failed, was disconnected or answered unverifiably\), the page says for the rest of its life not to start another activation of this wallet until the burn is final, and to use Recover in the extension/);
  const view = read('applications/qnet-explorer/frontend/src/lib/cabinet/extension-view.ts');
  assert.match(view, /return answer\.status === 'error' && \(answer\.error === 'BURN_IN_PROGRESS' \|\| answer\.error === 'INTERNAL'\);/);
  assert.match(view, /const unknown: ExtensionFailure\[\] = \['timeout', 'failed', 'unverifiable', 'disconnected'\];/);
  assert.doesNotMatch(text, /While a phone `activate` request is being made or shown/);
  assert.match(text, /answered before any search, so an unreadable Solana still gets `pending` for it/);
  // Not an open item: section 7.1 names the burn that lost.
  assert.doesNotMatch(text, /Open item: two devices of one wallet/);
  assert.match(text, /### 7\.1 A burn another device's older burn beat: `supersededBurnTx` Two devices of one wallet can each send a burn before either burn is visible to the other/);
  // The site's own comment no longer carries the old premise.
  assert.doesNotMatch(read('applications/qnet-explorer/frontend/src/lib/activate-view.ts'), /before Solana finalizes it/);
});

// The normative protocol and the wallet docs follow the code (the drop rule, HISTORY_TOO_LONG, the in-flight
// check, Confirm timing, the in-app browser's link pages, the extension's rejection rule): each statement is
// pinned here next to the code it describes. The app no longer burns (revision 2, section 14), so
// only the extension's burn code is read.
test('the protocol and the wallet docs describe the rules the wallets run', async () => {
  const protocol = flat(read('docs/protocols/qnet-link-v1.md'));
  const browserDoc = flat(read('docs/applications/browser-wallet.md'));
  const screen = read('applications/qnet-mobile/src/screens/QNetLinkScreen.js');
  const urlPolicy = read('applications/qnet-mobile/src/browser/url.js');
  const extActivation = read('applications/qnet-wallet/dist/background/activation.js');
  const provider = read('applications/qnet-wallet/dist/background/provider.js');
  const config = read('applications/qnet-wallet/dist/background/config.js');

  // A recorded burn is dropped once it can no longer land (lastValidBlockHeight; one hour for old records).
  assert.doesNotMatch(protocol, /five minutes after it was sent/);
  assert.match(protocol, /finalized block height has passed the `lastValidBlockHeight` of the blockhash it was built on/);
  assert.match(protocol, /one hour after it was sent/);
  assert.match(extActivation, /const PENDING_BURN_LEGACY_EXPIRY_MS = 60 \* 60 \* 1000;/);
  assert.match(extActivation, /return \(await solana\.blockHeight\('finalized'\)\) > pending\.lastValidBlockHeight;/);

  // The in-flight check pages the confirmed history, at most 20 pages in 30 s, and fails closed.
  assert.match(protocol, /at most 20 pages in 30 s \(a check that cannot get that far fails closed: `SOLANA_UNAVAILABLE`, or `HISTORY_TOO_LONG` when its time ran out\)/);

  // Two devices' burns: "nothing was burned" is never said after a device's own burn went through. The protocol
  // names that burn on the wire (section 7.1, supersededBurnTx), whatever the older burn's node type.
  assert.doesNotMatch(protocol, /today the app answers `ok` with its own burn and code/);
  assert.doesNotMatch(protocol, /its screen says the wallet already had its activation and nothing was burned/);
  assert.doesNotMatch(protocol, /the app keeps no record of its own later burn/);
  assert.doesNotMatch(protocol, /the answer does not carry the app's own burn|which breaks the rule above/);
  assert.match(protocol, /A device whose own burn is final but is not the oldest answers `exists` with the oldest burn \(`nodeType`, `burnTx`, `burnAmount`, `code`\), whatever that burn's node type, and names its own burn/);
  assert.match(protocol, /`supersededBurnTx`: the signature \(base58 of 64 bytes, not equal to `burnTx`\) of a burn this device sent from the wallet's Solana address \(`solana`\) that is final and is not the wallet's activation/);
  // The app burns nothing (revision 2); only the extension keeps a burn another device's older burn beat.
  assert.match(protocol, /The extension keeps the oldest burn as the wallet's one activation record and its own burn apart, as the vault's `supersededBurn`, and its own screen names both burns/);
  assert.doesNotMatch(protocol, /qnet_link_burn_superseded/);
  assert.match(protocol, /record → `ok` when that burn is this one; when another device's burn is older, `exists` with that burn and its code, and this burn in `supersededBurnTx` \(section 7\.1\)/);
  assert.match(protocol, /A burn this request sent that another device's older burn beat is answered `exists` with that older burn, whatever its node type, and names the burn sent in `supersededBurnTx` \(section 7\.1\)/);
  // The site: an `exists` with a superseded burn is the older activation, never "nothing was burned" (only the
  // extension answers `activate`; no relay carries it).
  assert.match(protocol, /The site shows such an answer as the older activation, with its code, and the burn of `supersededBurnTx` as one that went through and gives no code; it never states that nothing was burned/);
  assert.match(read('applications/qnet-explorer/frontend/src/lib/cabinet/extension-view.ts'), /export function leadKey\(answer: Pick<ActivationAnswer, 'status' \| 'supersededBurnTx'>\): MessageKey \{/);
  // Revision 2: the site takes no relayed activation answer at all; its links carry connect, link, claim, reserve and
  // unlink only (the wallet's signed reservation of a light node is no activation).
  assert.match(read('applications/qnet-explorer/frontend/src/lib/qnet-link.ts'), /\\\.\(connect\|link\|claim\|reserve\|unlink\)\(\?:\\\.\(\[A-Za-z0-9_-\]\{43\}\)\)\?\$\/;/);
  assert.match(provider, /\(outcome\?\.status === 'ok' && a\?\.nodeType === requestedType\)/);
  assert.match(extActivation, /return \{ status: 'exists', activation, superseded: publicSuperseded\(pending\) \};/);

  // Confirm arming on the app's QNet Link screen.
  assert.match(screen, /export const ARM_MS = 1000;/);

  // The in-app browser refuses the link host and the site's cabinet, activation, wallet and link pages (section
  // 14.8 step 9).
  assert.match(urlPolicy, /if \(p\.host === 'link\.aiqnet\.io'\) return true;/);
  // The path as the site's router reads it (escapes decoded, dot segments resolved), so `/%6Eode` is `/node`. The app
  // refuses every page the site keeps out of the app's view (IN_APP_EXCLUDED_PAGES), and the link page /l.
  assert.match(urlPolicy, /const path = routedPath\(p\.path\);\s*return path === '\/' \|\| WALLET_ONLY_RE\.test\(path\);/);
  const walletOnly = JSON.parse(/export const WALLET_ONLY_PATHS = Object\.freeze\((\[[^\]]*\])\);/.exec(urlPolicy)[1].replace(/'/g, '"'));
  const { IN_APP_EXCLUDED_PAGES } = await import('../activate-view.ts');
  for (const page of IN_APP_EXCLUDED_PAGES.filter((p) => p !== '/')) assert.ok(walletOnly.includes(page.slice(1)), page);
  assert.ok(walletOnly.includes('l'));
  assert.doesNotMatch(protocol, /it loads it as a page/);
  assert.match(protocol, /The in-app browser refuses the pages of `link\.aiqnet\.io` and the site's `\/node`, `\/activate`, `\/wallet` and `\/l` pages, and opens no `intent:` URL/);

  // The extension's rule for windows that could not offer the action, and the per-origin budget.
  assert.doesNotMatch(protocol, /neither that button nor closing such a window counts as a rejection/);
  assert.doesNotMatch(browserDoc, /closing such a window does not count as a rejection/);
  assert.match(provider, /const repeated = \(origin\) => windowsWithin\(origin, TIMINGS\.APPROVAL_BUDGET_SHORT_MS\) >= 2;/);
  for (const [name, value] of [['APPROVAL_BUDGET_SHORT', '5'], ['APPROVAL_BUDGET_LONG', '20'], ['APPROVAL_BUDGET_SHORT_MS', '60000'], ['APPROVAL_COOLDOWN_WINDOW_MS', '600000']]) {
    assert.match(config, new RegExp(`\\b${name}: ${value},`), name);
  }
  for (const text of [protocol, browserDoc]) assert.match(text, /at most 5 within a minute and 20 within 10 minutes/);
  // The cooldown the site names, as the site's own text has it in English (the bar can last several minutes).
  assert.ok(protocol.includes(`the site says "${TEXTS.ext_failure_cooldown}"`), `the protocol quotes the site's text: ${TEXTS.ext_failure_cooldown}`);

  // The extension's answer names the wallet's own Solana address as the burner, the only one it burns from.
  assert.match(provider, /&& b\.solanaAddress === current\.solanaAddress;/);
  assert.doesNotMatch(provider, /legacy/);
});

// The extension doc describes the search, the confirm's arming and NO_WALLET as the code does them.
test('the extension doc and the protocol describe its burn search, NO_WALLET and the approval window as the code has them', () => {
  const protocol = flat(read('docs/protocols/qnet-link-v1.md'));
  const browserDoc = flat(read('docs/applications/browser-wallet.md'));
  const config = read('applications/qnet-wallet/dist/background/config.js');
  const solana = read('applications/qnet-wallet/dist/background/solana.js');
  const approve = read('applications/qnet-wallet/dist/ui/approve.js');
  const provider = read('applications/qnet-wallet/dist/background/provider.js');
  const extActivation = read('applications/qnet-wallet/dist/background/activation.js');

  // The search: the kept, resumable search of the 1DEV token account, HISTORY_TOO_LONG, the wallet's own address only.
  assert.doesNotMatch(browserDoc, /up to 20 pages of 1000|\(up to 50\)|scans this Solana address's full history/);
  assert.match(browserDoc, /lists the history of the wallet's 1DEV associated token account/);
  assert.match(solana, /const ata = core\.associatedTokenAddress\(owner, mint\);/);
  // The code search lists the associated account; only the search of the signed transactions lists the owner.
  assert.match(solana, /const listedAddress = signed === true \? owner : ata;/);
  assert.match(solana, /call\('getSignaturesForAddress', \[listedAddress, \{ limit: pageSize, commitment: 'finalized'/);
  assert.match(browserDoc, /One search has a budget of 400 pages and 90 seconds, and its listing pauses, never skips, while 4,000 candidates wait to be checked/);
  for (const [name, value] of [['BURN_SCAN_PAGE_SIZE', '1000'], ['BURN_SCAN_MAX_PAGES', '400'], ['BURN_SCAN_MAX_UNCHECKED', '4000'], ['BURN_SCAN_DEADLINE_MS', '90000']]) {
    assert.match(config, new RegExp(`\\b${name}: ${value},`), name);
  }
  assert.match(browserDoc, /at most 20 pages and 30 seconds/);
  assert.match(solana, /const IN_FLIGHT_MAX_PAGES = 20;\nconst IN_FLIGHT_DEADLINE_MS = 30000;/);
  assert.match(browserDoc, /A history not searched to its start within the budget answers `HISTORY_TOO_LONG` \(starting again continues\)/);
  assert.match(extActivation, /const undecided = \(scan\) => new WalletError\(scan\.exhausted \? 'HISTORY_TOO_LONG' : 'SOLANA_UNAVAILABLE'\);/);
  assert.match(browserDoc, /\*\*Recover\*\* runs the search for the wallet's Solana address; the oldest valid burn it finds is stored/);
  assert.match(extActivation, /const burners = \(wallet\) => \[wallet\.solanaAddress\];/);
  assert.match(extActivation, /for \(const owner of burners\(wallet\)\) \{\s*const scan = await scanBurns\(owner\);/);
  assert.match(extActivation, /if \(!found && exhausted\) throw new WalletError\('HISTORY_TOO_LONG'\);/);

  // NO_WALLET comes from either wallet (the site already names the one that answered).
  assert.match(protocol, /\| `NO_WALLET` \| the wallet that answers \(the app or the extension\) holds no wallet yet \|/);
  assert.match(provider, /if \(!\(await d\.vault\.vaultExists\(\)\)\) return siteError\('NO_WALLET'\);/);

  // The approval window: 1 s (1.5 s for transactions and activations), restarted by any press or key, pointer
  // clicks only, Sign after the whole message, placement under the toolbar icon.
  assert.doesNotMatch(browserDoc, /The confirm button arms after 1 second and reacts only to trusted clicks/);
  assert.doesNotMatch(browserDoc, /confirm armed after 1 second/);
  assert.match(config, /CONFIRM_ARM_MS: 1000,/);
  assert.match(config, /CONFIRM_ARM_VALUE_MS: 1500,/);
  assert.match(approve, /const TX_KINDS = new Set\(\['sendTransaction', 'tokenTransfer', 'contractCall'\]\);/);
  assert.match(approve, /const delay = TX_KINDS\.has\(next\.kind\) \? TIMINGS\.CONFIRM_ARM_VALUE_MS : TIMINGS\.CONFIRM_ARM_MS;/);
  // No password in an approval window while the wallet is unlocked: the armed press, and the burn's checkbox.
  assert.match(approve, /armConfirm\(confirm, \(\) => runActivation\(next, mode\), \(\) => ack === null \|\| ack\.checked,\s+TIMINGS\.CONFIRM_ARM_VALUE_MS\);/);
  assert.match(approve, /for \(const type of \['pointerdown', 'pointerup', 'keydown'\]\) window\.addEventListener\(type, restart/);
  assert.match(approve, /return event\.isTrusted === true && Number\.isInteger\(event\.detail\) && event\.detail >= 1/);
  assert.match(approve, /ready = message\.seen;/);
  assert.match(provider, /await api\.windows\.getAll\(\{ windowTypes: \['normal'\] \}\)/);
  // Under the extension's toolbar icon: the top-right corner of that window.
  assert.match(provider, /left: area\.left \+ Math\.max\(0, area\.width - APPROVAL_WINDOW\.width - APPROVAL_EDGE\.right\)/);
  assert.match(browserDoc, /The confirm button arms 1 second after the window was last left alone, 1\.5 seconds for every transaction and every node activation window: any press, release or key anywhere in the window before it armed starts the wait again/);
  assert.match(browserDoc, /Enter or Space on the focused button never confirms/);
  assert.match(browserDoc, /Sign stays off until the whole message has been scrolled into view/);
  assert.match(browserDoc, /It opens under the extension's toolbar icon: the top-right corner of one of the user's normal browser windows \(the focused one, otherwise one of them at random\)/);

  // A wallet's activation is the oldest valid burn of its own Solana address. The store's 2.1.x wallet moves into this
  // version (earlier.js) by its recovery phrase alone, so no earlier address takes part in an activation: the
  // protocol never names 2.1.x, and the browser document names it only where it describes that move.
  assert.match(protocol, /the extension elects it so, and every client that looks up a wallet's activation MUST elect the same one\. Vector: `burnOrder` \(section 13\)/);
  for (const text of [protocol, browserDoc]) assert.doesNotMatch(text, /previousAddress|previous Solana address/);
  assert.doesNotMatch(protocol, /2\.1\.x|earlier version/);
  const activateSection = browserDoc.slice(browserDoc.indexOf('## Activate'), browserDoc.indexOf('## Page provider'));
  assert.ok(activateSection.length > 1000, 'the Activate section');
  assert.doesNotMatch(activateSection, /2\.1|earlier version|earlier wallet/);
  const moveParagraph = browserDoc.slice(browserDoc.indexOf('- **A wallet of the earlier version.**'), browserDoc.indexOf('- **Reveal** of the phrase'));
  const releaseNotes = browserDoc.slice(browserDoc.indexOf('## Store release notes'), browserDoc.indexOf('## Languages'));
  assert.match(moveParagraph, /^- \*\*A wallet of the earlier version\.\*\* The store's 2\.1\.x kept its wallet/);
  assert.match(moveParagraph, /the worker takes only the wallet's recovery phrase, never the keys stored beside it/);
  assert.match(releaseNotes, /^## Store release notes 3\.1\.7: [\s\S]* 3\.1\.6: a copied recovery phrase, private key or activation code leaves the clipboard on time also after the popup closes[\s\S]* Deleting or resetting the wallet keeps a wallet of version 2\.1 that is still in the browser[\s\S]* 3\.1\.2: the first screen offers \*\*Create a new wallet\*\*[\s\S]* 3\.1\.0: a wallet created in version 2\.1 moves into this version\./);
  assert.doesNotMatch(browserDoc.replace(moveParagraph, '').replace(releaseNotes, ''), /2\.1\.x|version 2\.1\b/);
  assert.doesNotMatch(extActivation, /earlier\.js|previousAddress|readEarlierWallet/);
  assert.match(extActivation, /if \(scan\.canonical\) return \{ status: 'exists', activation: await storeCanonical\(scan\.canonical, owner\) \};/);
});

// The same phrase is the same wallet everywhere only in its canonical spelling. The extension and the app
// canonicalize an imported phrase alike, and the node derives from the text as written.
test('the docs and the site say that a node takes the phrase only in its canonical spelling', () => {
  const browserDoc = flat(read('docs/applications/browser-wallet.md'));
  assert.doesNotMatch(browserDoc, /The mobile wallet and the node derive the same values\. /);
  assert.match(browserDoc, /derive the same values from the canonical text only/);
  assert.match(read('development/qnet-integration/src/node/mod.rs'), /let seed = s\.trim\(\)\.to_string\(\);/);
  const wm = read('applications/qnet-mobile/src/components/WalletManager.js');
  assert.match(wm, /static canonicalMnemonic\(input\) \{\s*return String\(input == null \? '' : input\)\.normalize\('NFKD'\)\.toLowerCase\(\)\.trim\(\)\.split\(\/\\s\+\/\)\.join\(' '\);/);
  assert.match(wm, /const trimmedMnemonic = WalletManager\.canonicalMnemonic\(mnemonic\);\s*if \(!bip39\.validateMnemonic\(trimmedMnemonic\)\) \{/);
  assert.match(read('applications/qnet-wallet/tools/crypto-bundle/src/mnemonic.js'), /return input\.normalize\('NFKD'\)\.toLowerCase\(\)\.trim\(\)\.split\(\/\\s\+\/\)\.join\(' '\);/);
  assert.doesNotMatch(browserDoc, /refuses a phrase in any other spelling|instead of canonicalizing it|\(the mobile wallet does not/);
  assert.match(browserDoc, /The mobile wallet canonicalizes an imported phrase exactly as the extension does/);
  assert.match(flat(read('docs/operators/running-a-node.md')), /Write the mnemonic exactly in its canonical form: the 12 or 24 words in lowercase, on one line, separated by single spaces/);
  // The cabinet's super-node next step (components/cabinet/NextSteps.tsx SuperNext, text in src/i18n/locales/en.ts).
  assert.match(TEXTS.ext_super_spelling, /Write the phrase as its words in lowercase, on one line, separated by single spaces\. The node uses the text as written and does not check it/);
  assert.match(read('applications/qnet-explorer/frontend/src/components/cabinet/NextSteps.tsx'), /<p className="note">\{t\('ext_super_spelling'\)\}<\/p>/);
});

// The extension's public document says what the shipped code does: where content scripts run, the prefix list,
// what an upgrade keeps, BURN_UNUSABLE and the other 1DEV token accounts. The hosts and the prefixes are compared
// with manifest.json and message.js; the other statements are pinned next to the code.
test('the extension doc names the manifest\'s hosts, the signing prefixes and BURN_UNUSABLE as the code has them', () => {
  const raw = read('docs/applications/browser-wallet.md');
  const doc = flat(raw);
  const manifest = JSON.parse(read('applications/qnet-wallet/dist/manifest.json'));

  // Content-script hosts: exactly the manifest's, in the Manifest section and the Page provider section.
  const hosts = [...new Set(manifest.content_scripts.flatMap((c) => c.matches))];
  assert.deepEqual(hosts, ['https://aiqnet.io/*', 'https://games.aiqnet.io/*']);
  const manifestSection = doc.slice(doc.indexOf('## Manifest'), doc.indexOf('## Identity and derivation'));
  const scripts = /Two content scripts, top frame only, at `document_start`, on ((?:`[^`]+`(?:, | and )?)+) and on no other site/.exec(manifestSection);
  assert.ok(scripts, 'the content-script sentence');
  assert.deepEqual([...scripts[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]), hosts);
  const providerSection = doc.slice(doc.indexOf('## Page provider'), doc.indexOf('| Method | Params | Result |'));
  assert.match(providerSection, /^## Page provider On `https:\/\/aiqnet\.io` and `https:\/\/games\.aiqnet\.io`, and on no other site, the extension gives pages a provider object/);
  assert.doesNotMatch(doc, /`https:\/\/(www|explorer)\.aiqnet\.io(\/\*)?`/);

  // The refused signing prefixes: exactly PROTOCOL_PREFIXES, in order.
  const message = read('applications/qnet-wallet/tools/crypto-bundle/src/message.js');
  const prefixes = [.../export const PROTOCOL_PREFIXES = \[([\s\S]*?)\];/.exec(message)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(prefixes.includes('register:') && prefixes.includes('migrate:'), prefixes.join());
  const listed = /It refuses text that starts with a protocol prefix \(((?:`[^`]+`(?:, )?)+)\)/.exec(doc);
  assert.ok(listed, 'the prefix list');
  assert.deepEqual([...listed[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]), prefixes);
  assert.match(message, /const head = message\.replace\(PREFIX_NOISE, ''\)\.normalize\('NFKC'\)\.toLowerCase\(\);/);
  assert.match(doc, /checked after every whitespace and invisible character anywhere in the text is removed and the rest folded \(NFKC, lowercase\)/);

  // The store's 2.1.x wallet moves into this version (earlier.js): both documents describe what the move
  // reads and takes as the code has it, and neither names a previous-address code or a list of previous addresses,
  // which 2.x had and this version does not.
  const contracts = flat(read('applications/qnet-wallet/CONTRACTS.md'));
  for (const text of [doc, contracts]) assert.doesNotMatch(text, /previous-address code|Previous addresses/);
  const earlier = read('applications/qnet-wallet/dist/background/earlier.js');
  const earlierKeys = [.../export const EARLIER_KEYS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(earlier)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const tableRow = /\| `chrome\.storage\.local` \| `earlier\.EARLIER_KEYS` \(((?:`[^`]+`(?:, )?)+)\) \|/.exec(contracts);
  assert.ok(tableRow, 'the storage table row of the earlier keys');
  assert.deepEqual([...tableRow[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]), earlierKeys);
  assert.match(earlier, /export const EARLIER_DB = Object\.freeze\(\{ NAME: 'QNetWallet', STORE: 'vault', KEY: 'main' \}\);/);
  assert.match(contracts, /IndexedDB `QNetWallet` \/ `vault` \/ `main` \(`earlier\.EARLIER_DB`/);
  assert.match(earlier, /Only the recovery phrase is taken; the keys both also hold are never decoded\./);
  assert.match(doc, /the worker takes only the wallet's recovery phrase, never the keys stored beside it/);
  // The earlier copies go only after the new vault was written and read back; a wrong password removes nothing.
  const vaultJs = read('applications/qnet-wallet/dist/background/vault.js');
  assert.match(vaultJs, /const result = await writeNewVault\(entropy, newPassword\);\s*\/\/ writeNewVault read the new vault back before it answered\s*await earlier\.removeEarlierData\(\)/);
  assert.match(vaultJs, /if \(entropy === null\) \{\s*await session\.recordPasswordFailure\(\);\s*throw new WalletError\('BAD_PASSWORD'\);/);
  assert.match(doc, /The earlier copies are removed only after the new vault has been written and read back\./);
  assert.match(doc, /a wrong password removes nothing/);

  // BURN_UNUSABLE and the burns from other 1DEV token accounts (the search of the transactions the wallet
  // signed), in Get code, Recover and the site's answer.
  const activation = read('applications/qnet-wallet/dist/background/activation.js');
  const solana = read('applications/qnet-wallet/dist/background/solana.js');
  assert.match(activation, /throw new WalletError\('BURN_UNUSABLE'\)/);
  assert.match(activation, /if \(!found && unusable && current === null\) throw new WalletError\('BURN_UNUSABLE'\);/);
  assert.match(activation, /const signed = await solana\.findSignedBurns\(owner, /);
  assert.match(activation, /if \(!signed\.complete\) throw undecided\(signed\);/);
  assert.match(solana, /const listedAddress = signed === true \? owner : ata;/);
  assert.match(doc, /a 1DEV burn of the wallet's own that yields no Light or Super code refuses with `BURN_UNUSABLE`/);
  assert.match(doc, /Every burn of the wallet's own is a transaction the wallet signed, so it lists in the history of the wallet's own Solana address, whichever token account it burned from/);
  assert.match(doc, /a new burn is refused until that search has reached the start of the history \(`HISTORY_TOO_LONG` resumes it, `SOLANA_UNAVAILABLE`\), never on "no burn"/);
  assert.match(doc, /When it finds only burns no code derives from, it answers `BURN_UNUSABLE` rather than "no burn"/);
  const provider = read('applications/qnet-wallet/dist/background/provider.js');
  const siteErrors = /const SITE_ERRORS = new Set\(\[([\s\S]*?)\]\);/.exec(provider)[1];
  if (!siteErrors.includes("'BURN_UNUSABLE'")) {
    assert.match(doc, /and so does any wallet code outside the protocol's list, `BURN_UNUSABLE` among them/);
  } else {
    assert.doesNotMatch(doc, /`BURN_UNUSABLE` among them/);
    assert.match(doc, /\(`PRICE_UNAVAILABLE`, `TX_FAILED`, `BURN_UNUSABLE`, \.\.\.\), and any other wallet code as `INTERNAL`/);
  }
});

// The extension's behaviour in its public document, each statement next to the code:
// the result guard's full exception list, the message rules for a lone carriage return and the typographic spaces,
// the qnet_sendTransaction result and the (from, nonce) identity, the approval window's one-window placement,
// "In a block", refused and resent transfers, the search of the transactions the wallet signed, and the superseded
// burn.
test('the extension doc states the round-5 behaviour as the code has it', () => {
  const raw = read('docs/applications/browser-wallet.md');
  const doc = flat(raw);
  const ext = (file) => read(`applications/qnet-wallet/dist/${file}`);
  const router = ext('background/router.js');
  const provider = ext('background/provider.js');
  const qnet = ext('background/qnet.js');
  const config = ext('background/config.js');
  const en = ext('ui/i18n/en.js');

  // The result guard: every exception the router makes is in the doc's list, and the list names no other.
  const table = (name) => [...new RegExp(`export const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`).exec(router)[1]
    .matchAll(/^\s*'?([\w.]+)'?: Object\.freeze/gm)].map((m) => m[1]);
  const exceptions = [...table('RESULT_KEY_EXCEPTIONS'), ...table('PROVIDER_RESULT_KEY_EXCEPTIONS')];
  assert.ok(exceptions.includes('qnet_activateNode') && !exceptions.some((name) => name.startsWith('legacy.')), exceptions.join());
  const guard = raw.slice(raw.indexOf('The only exceptions (`RESULT_KEY_EXCEPTIONS`'), raw.indexOf('Errors carry a fixed code and message'));
  const listed = [...guard.matchAll(/^- (?:for a page, )?`([\w.]+)`(?: and `([\w.]+)`)?:/gm)].flatMap((m) => m.slice(1).filter(Boolean));
  assert.deepEqual(listed, exceptions);

  // Messages: a lone carriage return and the typographic spaces are refused.
  const message = read('applications/qnet-wallet/tools/crypto-bundle/src/message.js');
  assert.match(message, /const LONE_CARRIAGE_RETURN = \/\\r\(\?!\\n\)\/;/);
  assert.match(message, /\\\\u2000-\\\\u200A\\\\u202F\\\\u205F/);
  assert.match(doc, /It also refuses a carriage return not followed by a line feed/);
  assert.match(doc, /the typographic spaces U\+2000 to U\+200A, U\+202F and U\+205F/);

  // qnet_sendTransaction: the result's keys, in the code's order (the last object submitTransfer returns), and the
  // transfer's identity.
  const submit = provider.slice(provider.indexOf('async function submitTransfer('));
  const body = submit.slice(0, submit.indexOf('\n  }\n'));
  const result = [...body.matchAll(/return \{\n([\s\S]*?)\n\s*\};/g)].at(-1);
  assert.ok(result, 'submitTransfer result');
  const keys = [...result[1].matchAll(/^\s*(\w+)[,:]/gm)].map((m) => m[1]);
  assert.ok(keys.includes('from') && keys.includes('nonce') && keys.includes('txHash'), keys.join());
  const row = /\| `qnet_sendTransaction` \| [^|]+ \| `\{([^}]+)\}`/.exec(doc);
  assert.ok(row, 'the method row');
  assert.deepEqual(row[1].split(',').map((k) => k.trim().split(':')[0]), keys);
  assert.doesNotMatch(doc, /`\{txHash, status: 'submitted'\\\|'unknown'\}`/);
  assert.match(doc, /A transfer is `\(from, nonce\)`: at most one transaction of an address applies at a nonce/);
  assert.match(doc, /A page matches the payment by `from` and `nonce`, the transfer's identity/);

  // The approval window: inside one normal window, the focused one or else one at random; the browser's own place once.
  assert.match(provider, /const chosen = normal\.find\(\(w\) => w\.focused === true\) \?\? normal\[randomBelow\(normal\.length\)\];/);
  assert.match(provider, /created = await api\.windows\.create\(\{ url, \.\.\.APPROVAL_WINDOW \}\);/);
  assert.match(doc, /when Chrome refuses the position it opens once more where Chrome places it by default/);

  // History and pending transfers: Pending / Confirmed / Failed, Not found / Unverified (a row resolves), a token row
  // this wallet sent confirmed by its call, refused transfers, the resend intervals, the per-nonce
  // reserve.
  assert.match(en, /historyConfirmed: 'Confirmed',/);
  assert.match(en, /historyNotFound: 'Not found',/);
  assert.match(doc, /Confirmed when two pinned nodes list it alike \(a token row: its call, when this wallet sent it, or its logs proof verifies\), Failed when another transaction took its nonce, Not found for a dropped transfer, Unverified for an archive row no two pinned nodes list/);
  assert.match(qnet, /const agreed = \(item\) => confirmed\.has\(identityOf\(item\)\) \|\| lookedUp\(item\);/);
  assert.match(qnet, /return verdict === 'verified' \|\| \(verdict !== 'rejected' && item\.direction !== 'in' && agreed\(item\)\);/);
  assert.match(doc, /Two nodes listing a row says it is in a block, not that it applied/);
  assert.match(qnet, /const RESUBMIT_INTERVAL_MS = 30000;/);
  assert.match(qnet, /const RESEND_ACCEPTED_MS = 10 \* 60 \* 1000;/);
  assert.match(qnet, /const PENDING_TRANSFER_TTL_MS = 60 \* 60 \* 1000;/);
  assert.match(config, /PENDING_TRANSFERS_MAX: 16,/);
  assert.match(qnet, /outcome: 'refused'/);
  assert.match(qnet, /if \(replaceNonce === null\) replaceNonce = defaultReplaceNonce\(outstanding, confirmed, Date\.now\(\), address\);/);
  assert.doesNotMatch(doc, /leaves the list when a verified read shows its nonce confirmed, or after one hour/);
  for (const phrase of [
    /up to 16 can be pending at once, one place kept free for a replace/,
    /at each nonce the largest amount plus fee, since only one transaction can apply there/,
    /at most every 30 seconds while no node has accepted the body, every 10 minutes once one has/,
    /A transfer that the only node it was sent to refused stays listed and reserved as refused/,
    /the next transfer takes its nonce by default, so the two can never both be paid/,
  ]) assert.match(doc, phrase);

  // No 2.x address to empty: its sweep and its unread cluster are gone.
  assert.doesNotMatch(config, /LEGACY_/);
  assert.doesNotMatch(doc, /LEGACY_UNCHECKED/);

  // The superseded burn: kept apart in the vault, named by the Activate tab and the approval window; the site's
  // answer is `exists` with the older activation and the key of section 7.1.
  assert.match(ext('background/vault.js'), /@property \{SupersededBurn\|null\} supersededBurn/);
  assert.match(en, /activateSuperseded: /);
  assert.match(en, /apOutcomeSuperseded: /);
  assert.match(doc, /this device's burn went through and gives no code, and the vault keeps it apart \(`supersededBurn`\)/);
  assert.match(provider, /return superseded \? \{ \.\.\.result, supersededBurnTx: own\.burnTx \} : result;/);
  assert.doesNotMatch(doc, /does not carry yet/);
});

// The protocol's optional answer key, its rows and its order of checks, the vectors and the site's
// validator agree.
test('the protocol, the vectors and the site agree on supersededBurnTx', async () => {
  const protocol = flat(read('docs/protocols/qnet-link-v1.md'));
  assert.match(protocol, /\| `activate` \| `exists` \| `qnet`, `solana`, `nodeType`, `burnTx`, `burnAmount`, `code`; plus `supersededBurnTx` \(7\.1\) when it applies \|/);
  assert.match(protocol, /\| `activate` \| `pending` \| `qnet`, `solana`, `nodeType`, `burnTx`, `burnAmount` \|/);
  assert.match(protocol, /`code` matching the pattern and equal to `generateActivationCode\(nodeType, solana, burnTx, burnAmount\)`, or for `light` to the same function of `qnet` \(section 3\); `supersededBurnTx` a 64-byte signature other than `burnTx`\./);
  assert.match(protocol, /\| Result `exists` \| the same, plus `supersededBurnTx` \(section 7\.1\) when it applies \|/);
  assert.doesNotMatch(protocol, /previousAddress/);

  const vectors = JSON.parse(read('docs/protocols/qnet-link-v1.vectors.json'));
  assert.equal('previousWallet' in vectors || 'extensionAnswers' in vectors, false);
  const superseded = vectors.cases.find((c) => c.name === 'activate-super-exists-superseded');
  assert.equal(validateActivation(superseded.plaintext, 'super').ok, true);
  // An activation answer reaches the site only from the extension: revision 2 has no activate link.
  for (const c of vectors.cases.filter((x) => x.intent === 'activate')) assert.equal(parseLink(c.link), null, c.name);
  const reasons = new Set(vectors.invalidPlaintexts.map((p) => p.reason));
  assert.ok(reasons.has('supersededBurnTx'));
});

// The order of two burns in one slot is part of the protocol, with a vector, and the extension, the
// wallet that burns, uses it (the vector is recomputed here with the reference and with its comparator).
test('the burn order: protocol section 3, the vector, and the extension\'s rule', async () => {
  const protocol = flat(read('docs/protocols/qnet-link-v1.md'));
  assert.match(protocol, /\*\*Burn order\*\*: a wallet's burns are ordered oldest first by slot; two burns in one slot by their place in `getSignaturesForAddress`/);
  const vectors = JSON.parse(read('docs/protocols/qnet-link-v1.vectors.json'));
  const { burnsOldestFirst } = await import(new URL('docs/protocols/tools/qnet-link-vectors.mjs', REPO).href);
  const RULE = '(a.slot - b.slot) || (b.seq - a.seq)';
  assert.ok(read('applications/qnet-wallet/dist/background/solana.js').includes(`const oldestFirst = (a, b) => ${RULE};`));
  const extensionComparator = (a, b) => (a.slot - b.slot) || (b.seq - a.seq);
  const cases = vectors.burnOrder.cases;
  assert.ok(cases.some((c) => c.name === 'same-slot') && cases.some((c) => c.pages.length > 1));
  for (const c of cases) {
    assert.deepEqual(burnsOldestFirst(c.pages), c.oldestFirst, c.name);
    const listed = c.pages.flat().map((e, i) => ({ ...e, seq: i + 1 }));
    assert.deepEqual(listed.sort(extensionComparator).map((e) => e.signature), c.oldestFirst, `${c.name}: the extension's comparator`);
  }
});

// explorer.md's /api/cabinet rows state each route's limits: each row's numbers are read from CABINET_LIMITS and
// KEYED_LIMITS.
test('explorer.md states the cabinet routes\' limits as limits.ts has them', async () => {
  const { CABINET_LIMITS: C, KEYED_LIMITS: K } = await import('../../server/cabinet/limits.ts');
  const { ADMIT_HOLD_MS } = await import('../cabinet/registration.ts');
  const { SENT_KEPT } = await import('../../server/cabinet/register.ts');
  const doc = flat(read('docs/applications/explorer.md'));
  const perMinute = (l) => { assert.equal(l.windowMs, 60_000); return l.max; };
  const perTen = (l) => { assert.equal(l.windowMs, 600_000); return l.max; };
  for (const claim of [
    `then ${perMinute(C.node)} requests per minute per client with a limiter store of the cabinet's own`,
    `Per client ${perMinute(C.price)}, ${perMinute(C.payment)}, ${perMinute(C.blockhash)}, ${perMinute(C.tx)} and ${perMinute(C.send)} per minute; \`send\` also ${perTen(K.send)} per payment address per 10 min`,
    `one submit in flight per node; ${perTen(C.register)} per client per 10 min and ${perTen(K.register)} per node`,
    `or for ${ADMIT_HOLD_MS / 60_000} minutes after a node admitted it (\`ADMIT_HOLD_MS\``,
    `up to ${SENT_KEPT.toLocaleString('en-US')} are kept`,
    `(30 s cache, ${perMinute(C.registration)} per client per minute)`,
  ]) assert.ok(doc.includes(claim), claim);
  // The site has no "I'm back", so no wake route and no wake limit.
  assert.ok(!('wake' in C) && !('wake' in K));
  assert.doesNotMatch(doc, /\/api\/cabinet\/wake|I'm back/);
});

// The page's request budgets (site-request.ts, the reservation's, the registration's, the faucet claim's) as explorer.md and the protocol's
// site behaviour state them.
test('explorer.md and the protocol state the page\'s request budgets as the code has them', async () => {
  const { SITE_REQUEST_MS } = await import('../site-request.ts');
  const { RESERVE_REQUEST_MS } = await import('../cabinet/activation.ts');
  const { REGISTER_REQUEST_MS } = await import('../cabinet/consent-submit.ts');
  const { SUBMIT_TIMEOUT_MS } = await import('../cabinet/registration.ts');
  const { FAUCET_CLAIM_MS, FAUCET_CLAIM_REQUEST_MS } = await import('../faucet-handover.ts');
  const { CONFIRM_POLL_MS } = await import('../../server/solana-rpc.ts');
  const { RPC_CALL_MS } = await import('../../server/solana-endpoint.ts');
  const s = (ms) => `${ms / 1000} s`;
  const explorer = flat(read('docs/applications/explorer.md'));
  for (const claim of [
    `ends after ${s(SITE_REQUEST_MS)} without its answer (\`src/lib/site-request.ts\` \`SITE_REQUEST_MS\`), a reservation after ${s(RESERVE_REQUEST_MS)}`,
    `registration after ${s(REGISTER_REQUEST_MS)} (\`REGISTER_REQUEST_MS\`: the site's ${s(SUBMIT_TIMEOUT_MS)} wait for the node, \`SUBMIT_TIMEOUT_MS\`, and ${s(REGISTER_REQUEST_MS - SUBMIT_TIMEOUT_MS)} more)`,
    `the balance check) ends after ${s(SITE_REQUEST_MS)} without its answer (\`src/lib/site-request.ts\` \`SITE_REQUEST_MS\`), and a search typed further`,
    `A claim answers once its transfer landed, and at most ${s(FAUCET_CLAIM_MS)} after the route took it (\`FAUCET_CLAIM_MS\` in \`src/lib/faucet-handover.ts\`): the blockhash and the send, each Solana call at most ${s(RPC_CALL_MS)} (\`RPC_CALL_MS\`), then a confirmation read every ${s(CONFIRM_POLL_MS)} (\`CONFIRM_POLL_MS\`) until the transfer lands, fails or its blockhash expires`,
    `the page waits ${s(FAUCET_CLAIM_REQUEST_MS)} for the pair (\`FAUCET_CLAIM_REQUEST_MS\`, a read more)`,
  ]) assert.ok(explorer.includes(claim), claim);
  const claim = `ends after ${s(SITE_REQUEST_MS)} without its answer (\`SITE_REQUEST_MS\``;
  assert.ok(flat(read('docs/protocols/qnet-link-v1.md')).includes(claim), claim);
});

// explorer.md states the Latest blocks strip, an address page's title with the whole address under it, a list's From / To
// on one line and the Overview opening after an activation as the pages have them, and none of the layouts they replaced.
test('explorer.md states the Latest blocks strip, an address\'s title, From / To and a finished activation as the pages have them', () => {
  const doc = flat(read('docs/applications/explorer.md'));
  for (const stale of ['Latest blocks beside All transactions', '12 rows (6 on a phone)', 'Beside All transactions from 1,281 px wide', 'the short address as the title', 'From / To is two lines']) {
    assert.ok(!doc.includes(stale), stale);
  }
  // The strip: its place, its count, its cards, Hide and the cookie that keeps it folded.
  assert.ok(doc.includes('then the Latest blocks strip with All transactions below it'));
  assert.ok(doc.includes('of the 14 newest blocks (`RECENT_BLOCKS` in `src/lib/explorer-view.ts`), each a card of 184 by 100 px (164 px wide under 720 px)'));
  assert.match(site('lib/explorer-view.ts'), /export const RECENT_BLOCKS = 14;/);
  const css = site('styles/explorer.css');
  assert.match(css, /\.ex-chain \{ --card-h: 100px; --card-w: 184px; min-width: 0; \}/);
  assert.match(css, /@media \(max-width: 720px\) \{\n(?: {2}[^\n]*\n)*? {2}\.ex-chain \{ --card-w: 164px; \}/);
  assert.ok(doc.includes('the `qnet.blocks` cookie, written by Hide for a year on the explorer\'s path in the page\'s language'));
  assert.match(site('lib/strip-pref.ts'), /export const STRIP_COOKIE = 'qnet\.blocks';\n[\s\S]*const KEEP_S = 365 \* 24 \* 60 \* 60;/);
  assert.match(site('components/explorer/LatestBlocks.tsx'), /<Action kind="act" href="\/explorer\/blocks" className="ex-chain-all">/);
  // An address's title, From / To, and the Overview after a finished activation.
  assert.ok(doc.includes('the word Address as the title with the whole address under it, spaced at its structure, and Copy under that'));
  assert.match(site('app/explorer/address/[address]/AddressClient.tsx'), /<>\{t\('sugg_address'\)\}<span className="ex-title-addr" translate="no"><AddressParts value=\{address\} \/><\/span><\/>/);
  assert.ok(doc.includes('A list\'s From / To is one line, the sender, "to" in Fog and the recipient (`cells.tsx` `FromTo`)'));
  assert.match(site('components/explorer/cells.tsx'), /\{!noTo && <span className="ex-ft-to">\{t\('party_to'\)\}<\/span>\}/);
  assert.ok(doc.includes('A finished activation with nothing left to send back opens My node\'s Overview by itself (`NodeActivate.tsx`).'));
  assert.match(site('components/cabinet/NodeActivate.tsx'), /const finished = record\?\.stage === 'done' && registered !== null && !mayReturnLeftovers\(record\);\n\s*useEffect\(\(\) => \{\n\s*if \(finished\) router\.replace\('\/node\?tab=overview'\);/);
});

// The layout of every page in every language as explorer.md states it: the home page's live row and column, a value's
// character and icon, an Arabic letter's width, a detail row's Copy, the token methods' column, the payment code on a
// tablet, and My node's bar and journey.
test('explorer.md states the live blocks, a value\'s length, an Arabic letter, the payment code on a tablet and My node\'s bar as the site has them', () => {
  const doc = flat(read('docs/applications/explorer.md'));
  assert.ok(doc.includes('each a height, a link to its block, with its transaction count, under them the node that made it and its age, whose box holds the language\'s longest; three of the hero\'s twelve columns, four from 861 to 1,099 px'));
  assert.match(site('styles/home.css'), /@media \(min-width: 861px\) and \(max-width: 1099px\) \{ \.stream \{ grid-column: 9 \/ span 4; \} \}/);
  assert.doesNotMatch(site('app/HomeClient.tsx'), /blk-hash|short\('hash'/);
  assert.ok(doc.includes('each character counts `--ro-ch` em (0.6 against the face\'s 0.57 em advance, 0.63 on Arabic, Chinese, Japanese and Korean pages, which drop the face\'s -0.03 em spacing), and the icon inside such a value stays 1.25 times its text at every size'));
  assert.match(site('styles/tokens.css'), /\n {2}--ro-ch: \.6;\n/);
  assert.match(site('styles/i18n.css'), /\n:root:is\(:lang\(ar\), :lang\(zh-CN\), :lang\(ja\), :lang\(ko\)\) \{ --ro-ch: \.63; \}\n/);
  assert.ok(doc.includes('a value set smaller by its length (a readout\'s, a section\'s datum) an Arabic letter as 0.72 em (`ARABIC_VALUE_EM`'));
  assert.match(site('lib/geometry.ts'), /\nexport const ARABIC_VALUE_EM = 0\.72;\n/);
  assert.match(site('lib/geometry.ts'), /return textLength\(value, 0\.6, ARABIC_VALUE_EM\) \+/);
  assert.ok(doc.includes('Where a detail row\'s Copy wraps under its value (a longer language\'s word), the two lines keep 10 px apart'));
  assert.match(site('styles/explorer.css'), /\n\.ex \.kv :is\(\.ent-copy, \.ex-val\) \{ row-gap: 10px; \}\n/);
  assert.ok(doc.includes('(Contract: the standard\'s methods, what each does on one line, the column as wide as the longest of them in the page\'s language)'));
  assert.ok(doc.includes('a tablet\'s code in the second of its two columns; a test token\'s name longer than its line breaks between its words'));
  assert.match(site('styles/cabinet.css'), /html\[data-device='ios'\] \.cab-manual, html\[data-device='android'\] \.cab-manual \{ grid-template-columns: minmax\(0, 1fr\) 196px; \}/);
  assert.ok(doc.includes('On the bar a section\'s name is set smaller by its longest word where the section is narrower than that word (`--n-len`, four sections on a 320 px screen).'));
  assert.ok(doc.includes('(`showJourney`), four steps across, two rows of two under 380 px.'));
  assert.match(site('styles/cabinet.css'), /@media \(max-width: 379px\) \{\n {2}\.cab-journey \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); row-gap: 12px; \}\n\}/);
});
