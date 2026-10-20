// The payment address funded from the user's own wallet (owner, 29.09 and 19.10). The card says in one sentence what to
// send, then offers two ways: "Send from your wallet", a button per transfer for what the address still lacks of it,
// opening a wallet with it filled in (the QNet extension's qnet_sendSolanaTransfer once it takes it, on any device; else
// on a phone the link the release constant PHONE_LINK names), each done from the address's
// balance read; and "Or
// send it yourself", the address with Copy and one QR code of the plain address. The site's funding button and its route are gone (one faucet, on the Testnet page). On testnet a link takes
// the wallet's Solana address to the Testnet page's faucet without a URL, read there once. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { BURN_FEE_LAMPORTS, BURN_SOL_LAMPORTS, FUNDING_SOL_LAMPORTS, SYSTEM_ACCOUNT_RENT_LAMPORTS } from '../cabinet/burn-tx.ts';
import {
  FUNDING_DECIMALS, PHONE_LINK, REQUEST_LABEL, decimalAmount, fundingButtons, fundingLeft, fundingReceived, fundingSol,
  fundingTransfer, requestLink,
} from '../cabinet/payment-request.ts';
import * as paymentRequests from '../cabinet/payment-request.ts';
import { fundedFor } from '../cabinet/activation.ts';
import { transferKey, transferMayArrive } from '../cabinet/extension-view.ts';
import { HANDOVER_KEY, handOver, takeHandedOver } from '../faucet-handover.ts';
import { ACTIVATION_NETWORK, ONE_DEV_DECIMALS, ONE_DEV_MINT, ONE_DEV_MINTS, ONE_DEV_UNIT, SOL_DECIMALS } from '../one-dev.ts';
import { BURN_CLUSTER, TRANSFER_LINK_PREFIX, TRANSFER_LINK_RE, isTransferLink } from '../qnet-link.ts';
import { isSolanaTransfer } from '../qnet-provider.ts';
import { qrMatrix } from '../qr.ts';
import { decodeKey } from '../solana-message.ts';
import { TEXTS } from '../texts.ts';

const SRC = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const PAYMENT = '9z1QsPH2k9xpYY9EQYh8EdPjhnt9CXnsxZZkYgT5Km96';
const SOLANA = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const MOBILE = new URL('../../../../../qnet-mobile/', import.meta.url);
const appLink = (transfer) => requestLink(transfer, 'transfer');
const mainnetLink = (transfer) => requestLink(transfer, 'request');

// QNet Wallet's own reader of the transfer link (applications/qnet-mobile/src/services/transferLink.js), run as shipped
// with its imports stood in for: decodeKey is the site's check of a 32-byte base58 key.
function appTransferLink() {
  const source = readFileSync(new URL('src/services/transferLink.js', MOBILE), 'utf8');
  const body = source.replace(/^import [^;]+;$/gm, '').replace(/^export /gm, '');
  return new Function('decodeKey', 'SOLANA_CLUSTER', 'isSolanaRequestUrl', 'solanaScanToForm', 'SOLANA_TOKENS',
    `${body}\nreturn { isTransferLink, parseTransferLink };`)(decodeKey, 'devnet', () => false, () => null, []);
}

test('the SOL asked is the burn\'s fee and the rent-exempt minimum, rounded up to 0.001 SOL, and it funds the burn', () => {
  assert.equal(SYSTEM_ACCOUNT_RENT_LAMPORTS, 890_880n);
  assert.equal(BURN_SOL_LAMPORTS, BURN_FEE_LAMPORTS + SYSTEM_ACCOUNT_RENT_LAMPORTS);
  assert.equal(FUNDING_SOL_LAMPORTS, 1_000_000n);
  assert.ok(FUNDING_SOL_LAMPORTS >= BURN_SOL_LAMPORTS && FUNDING_SOL_LAMPORTS - BURN_SOL_LAMPORTS < 1_000_000n);
  assert.equal(fundingSol(), '0.001');
  // Exactly what the card asks is funded; a lamport under the burn's need is not.
  const price = 1500;
  assert.equal(fundedFor({ sol: FUNDING_SOL_LAMPORTS, oneDev: BigInt(price) * ONE_DEV_UNIT, accountExists: true }, price), true);
  assert.equal(fundedFor({ sol: BURN_SOL_LAMPORTS - 1n, oneDev: BigInt(price) * ONE_DEV_UNIT, accountExists: true }, price), false);
  assert.equal(fundedFor({ sol: FUNDING_SOL_LAMPORTS, oneDev: BigInt(price) * ONE_DEV_UNIT - 1n, accountExists: true }, price), false);
});

test('the two transfers: the address, what it still lacks in whole tokens, the 1DEV mint for 1DEV; each one\'s request link', () => {
  const price = 1500;
  const full = fundingLeft(null, price);
  assert.deepEqual(full, { oneDev: 1500n * ONE_DEV_UNIT, sol: FUNDING_SOL_LAMPORTS });
  assert.deepEqual(FUNDING_DECIMALS, { oneDev: ONE_DEV_DECIMALS, sol: SOL_DECIMALS });
  assert.deepEqual(fundingTransfer(PAYMENT, 'oneDev', full.oneDev), { to: PAYMENT, mint: ONE_DEV_MINT, amount: '1500' });
  assert.deepEqual(fundingTransfer(PAYMENT, 'sol', full.sol), { to: PAYMENT, mint: null, amount: '0.001' });
  // Both are what the extension's provider request takes.
  assert.equal(isSolanaTransfer(fundingTransfer(PAYMENT, 'oneDev', full.oneDev)), true);
  assert.equal(isSolanaTransfer(fundingTransfer(PAYMENT, 'sol', full.sol)), true);
  // The phone's link is built from the same transfer: one source for the amount and the mint, one builder. QNet Wallet's
  // transfer link (testnet) or the standard request link (mainnet), as the release constant names it.
  assert.equal(REQUEST_LABEL, 'QNet Blockchain node activation');
  assert.equal(appLink(fundingTransfer(PAYMENT, 'oneDev', full.oneDev)), `https://link.aiqnet.io/send#to=${PAYMENT}&mint=${ONE_DEV_MINT}&amount=1500`);
  assert.equal(appLink(fundingTransfer(PAYMENT, 'sol', full.sol)), `https://link.aiqnet.io/send#to=${PAYMENT}&amount=0.001`);
  assert.equal(mainnetLink(fundingTransfer(PAYMENT, 'oneDev', full.oneDev)), `solana:${PAYMENT}?amount=1500&spl-token=${ONE_DEV_MINT}&label=QNet%20Blockchain%20node%20activation`);
  assert.equal(mainnetLink(fundingTransfer(PAYMENT, 'sol', full.sol)), `solana:${PAYMENT}?amount=0.001&label=QNet%20Blockchain%20node%20activation`);
  for (const name of ['oneDevRequest', 'solRequest', 'paymentRequest', 'oneDevTransfer', 'solTransfer', 'transferLink', 'sendLink']) {
    assert.equal(name in paymentRequests, false, `no second builder of the same link or transfer: ${name}`);
  }
  assert.equal('PHONE_REQUEST_LINKS' in paymentRequests, false, 'one release constant, PHONE_LINK');
  assert.equal(appLink({ to: PAYMENT, mint: null, amount: '2' }), `https://link.aiqnet.io/send#to=${PAYMENT}&amount=2`);
  assert.equal(mainnetLink({ to: PAYMENT, mint: null, amount: '2' }), `solana:${PAYMENT}?amount=2&label=QNet%20Blockchain%20node%20activation`);
  // Plain decimals: no grouping, no trailing zeros, no exponent.
  assert.equal(decimalAmount(1_000_000n, 9), '0.001');
  assert.equal(decimalAmount(1_234_500_000_000n, 9), '1234.5');
  assert.equal(decimalAmount(5n, 9), '0.000000005');
  assert.equal(decimalAmount(2_000_000_000n, 9), '2');
});

// A button asked for the full price whatever had arrived: 1,000 of 1,500 1DEV sent by hand, and it sent 1,500 more.
test('a part already on the address: each transfer asks only for what is still missing, and nothing once all is there', () => {
  const price = 1500;
  const part = { oneDev: 1000n * ONE_DEV_UNIT, sol: 300_000n };
  const left = fundingLeft(part, price);
  assert.deepEqual(left, { oneDev: 500n * ONE_DEV_UNIT, sol: 700_000n });
  assert.deepEqual(fundingTransfer(PAYMENT, 'oneDev', left.oneDev), { to: PAYMENT, mint: ONE_DEV_MINT, amount: '500' });
  assert.deepEqual(fundingTransfer(PAYMENT, 'sol', left.sol), { to: PAYMENT, mint: null, amount: '0.0007' });
  assert.equal(appLink(fundingTransfer(PAYMENT, 'oneDev', left.oneDev)), `https://link.aiqnet.io/send#to=${PAYMENT}&mint=${ONE_DEV_MINT}&amount=500`);
  assert.equal(appLink(fundingTransfer(PAYMENT, 'sol', left.sol)), `https://link.aiqnet.io/send#to=${PAYMENT}&amount=0.0007`);
  assert.equal(mainnetLink(fundingTransfer(PAYMENT, 'oneDev', left.oneDev)), `solana:${PAYMENT}?amount=500&spl-token=${ONE_DEV_MINT}&label=QNet%20Blockchain%20node%20activation`);
  assert.equal(mainnetLink(fundingTransfer(PAYMENT, 'sol', left.sol)), `solana:${PAYMENT}?amount=0.0007&label=QNet%20Blockchain%20node%20activation`);
  // A fraction of a token left is asked exactly.
  assert.equal(fundingTransfer(PAYMENT, 'oneDev', fundingLeft({ oneDev: 1499n * ONE_DEV_UNIT + 500_000n, sol: 0n }, price).oneDev).amount, '0.5');
  // More than enough, or exactly enough: nothing is asked.
  assert.deepEqual(fundingLeft({ oneDev: 2000n * ONE_DEV_UNIT, sol: 2n * FUNDING_SOL_LAMPORTS }, price), { oneDev: 0n, sol: 0n });
  assert.equal(fundingTransfer(PAYMENT, 'oneDev', 0n), null);
  assert.equal(fundingTransfer(PAYMENT, 'sol', 0n), null);
  // The card's buttons take the amount and its label from the same read.
  const steps = code('components/cabinet/ActivateSteps.tsx');
  assert.match(steps, /const left = fundingLeft\(balance, price\);/);
  assert.match(steps, /const transfer = fundingTransfer\(record\.pub, token, left\[token\]\);\s*if \(!transfer\) \{/);
  assert.match(steps, /const amount = formatUnits\(left\[token\], FUNDING_DECIMALS\[token\]\);\s*const label = t\('act_fund_send', \{ amount, token: tokenName\(token\) \}\);/);
  assert.match(steps, /return <a key=\{token\} href=\{openHref\(requestLink\(transfer\), android\)\}/);
  assert.match(steps, /onClick=\{\(\) => void send\(token, transfer, amount\)\}/);
});

test('each button is done once the payment address holds at least its amount', () => {
  const price = 1500;
  const full = BigInt(price) * ONE_DEV_UNIT;
  assert.deepEqual(fundingReceived(null, price), { oneDev: false, sol: false });
  assert.deepEqual(fundingReceived({ oneDev: 0n, sol: 0n }, price), { oneDev: false, sol: false });
  assert.deepEqual(fundingReceived({ oneDev: full - 1n, sol: FUNDING_SOL_LAMPORTS - 1n }, price), { oneDev: false, sol: false });
  assert.deepEqual(fundingReceived({ oneDev: full, sol: 0n }, price), { oneDev: true, sol: false });
  assert.deepEqual(fundingReceived({ oneDev: 0n, sol: FUNDING_SOL_LAMPORTS }, price), { oneDev: false, sol: true });
  assert.deepEqual(fundingReceived({ oneDev: full + 1n, sol: FUNDING_SOL_LAMPORTS + 1n }, price), { oneDev: true, sol: true });
});

test('the payment card: who the node is for, one sentence, one QR code of the plain address, no payment request anywhere', () => {
  const steps = code('components/cabinet/ActivateSteps.tsx');
  const card = steps.slice(steps.indexOf('export function Funding('), steps.indexOf('export function Receipt('));
  // Who the node belongs to: the QNet wallet that confirmed it in QNet Wallet, never the payment address.
  // The wallet named is a link to its address page.
  assert.match(card, /\{wallet && <p className="cab-step-s">\{rich\('act_owner', \{ wallet: <EntityLink kind="address" value=\{wallet\} \/> \}\)\}<\/p>\}/);
  assert.equal(TEXTS.act_owner, 'The node is registered to your QNet Blockchain wallet {wallet}; this one-time address only burns the 1DEV.');
  assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, 'act_owner_later'), false);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /<Funding record=\{record\} price=\{price\} balance=\{balance\} wallet=\{named\} walletSolana=\{choice\?\.solana \?\? null\} phone=\{device\?\.phone === true\} \/>/);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /const pinned = record \? pinnedWallet\(record\) : null;/);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /const named = pinned \?\? choice\?\.qnet \?\? null;/);
  // One sentence says what to send; the amounts are the transfers' own.
  assert.match(TEXTS.act_mainnet_send, /^Send \{price\} 1DEV and \{sol\} SOL to this address\.$/);
  assert.match(card, /const full: Record<FundingToken, string> = \{ oneDev: number\(price\), sol \};/);
  // Exactly one QR code, of the plain address, and the address with one Copy.
  assert.deepEqual([...card.matchAll(/<QrCode [^>]*\/>/g)].map((m) => m[0]), ['<QrCode text={record.pub} label={t(\'act_address_qr\')} size={196} />']);
  assert.equal(TEXTS.act_address_qr, 'QR code of the payment address');
  assert.ok(qrMatrix(PAYMENT).size > 0);
  assert.deepEqual([...card.matchAll(/<Copy [^>]*\/>/g)].map((m) => m[0]), ['<Copy value={record.pub} />']);
  assert.match(card, /<span className="ent ent-full">\{record\.pub\}<\/span>\s*<Copy value=\{record\.pub\} \/>/);
  // No request QR code, no second code, no copied request, and no "payment request" in what the card says.
  assert.doesNotMatch(card, /oneDevRequest|solRequest|act_request|act_copy_request|act_sol_|small/);
  for (const key of ['act_request_qr', 'act_request_note', 'act_request_note_phone', 'act_copy_request', 'act_sol_line', 'act_sol_qr', 'act_address_note']) {
    assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, key), false, key);
  }
  for (const key of new Set([...card.matchAll(/\bt\('([a-z0-9_]+)'/g)].map((m) => m[1]))) assert.doesNotMatch(TEXTS[key], /payment request/i, key);
  for (const [key, text] of Object.entries(TEXTS).filter(([k]) => /^(act_fund_|transfer_)/.test(k))) assert.doesNotMatch(text, /payment request/i, key);
  // The QR code has one size; the small one and the SOL's row are gone with their styles.
  assert.match(code('components/cabinet/LinkWaiting.tsx'), /export function QrCode\(\{ text, label, size = 168 \}: \{ text: string; label: string; size\?: number \}\)/);
  assert.match(code('components/cabinet/LinkWaiting.tsx'), /<svg className="cab-qr" width=\{size\} height=\{size\} viewBox=/);
  assert.doesNotMatch(read('app/globals.css') + read('styles/cabinet.css'), /activate-qr-small|cabinet-sol-request/);
  // No funding by the site from the card; on testnet the faucet link, handing the wallet's Solana address over, and the
  // faucet pass for the wallet when the site gave one (SITE M-13).
  assert.doesNotMatch(card, /act_faucet|onFaucet|faucetBusy/);
  assert.match(card, /<Link href="\/testnet#faucet" onClick=\{toFaucet\}>\{t\('act_no_tokens_link'\)\}<\/Link>/);
  assert.match(card, /const toFaucet = \(\) => \{\s*if \(walletSolana\) handOver\(walletSolana\);\s*if \(pass\) handOverPass\(pass\);\s*\};/);
  assert.equal(TEXTS.act_no_tokens, 'No test tokens yet? {link}');
  assert.equal(TEXTS.act_no_tokens_link, 'Get them to your wallet');
  // What stays: what has arrived so far, per amount, a line filling as it comes (dashes before the first read); and
  // keeping this browser until the burn, under the steps while the address waits for the amounts.
  assert.match(card, /<div className="cab-meters" aria-live="polite">\s*\{meter\('oneDev', BigInt\(price\) \* ONE_DEV_UNIT, ONE_DEV_DECIMALS, number\(price\)\)\}\s*\{meter\('sol', FUNDING_SOL_LAMPORTS, SOL_DECIMALS, sol\)\}/);
  assert.match(card, /const share = has === null \? 0 : Number\(need - left\[token\]\) \/ Number\(need\);/);
  assert.equal(TEXTS.act_meter, '{received} of {need}');
  assert.match(code('components/cabinet/NodeActivate.tsx'), /\{\(stage === 'funding' \|\| stage === 'funded'\) && <p className="note cab-keep">\{t\('act_keep_browser'\)\}<\/p>\}/);
  assert.match(TEXTS.guide_phone_fund_testnet, /tap "Copy" under the payment address, and in QNet Wallet send it the 1DEV amount, then the SOL amount/);
});

test('the two ways: the extension\'s buttons on any device once it takes the transfer, a phone\'s links when the release gives one, and the address to send to by hand', () => {
  const steps = code('components/cabinet/ActivateSteps.tsx');
  const card = steps.slice(steps.indexOf('export function Funding('), steps.indexOf('export function Receipt('));
  // The extension is asked on any device: a tablet or a touch-screen computer with the extension gets its buttons.
  assert.match(card, /const extension = providerStatus === 'available' && providerChannel === 'extension';/);
  assert.doesNotMatch(card, /!phone/);
  assert.match(card, /void takesSolanaTransfer\(\)\.then\(\(takes\) => \{\s*if \(live\) setExtensionSends\(takes\);\s*\}\);/);
  assert.match(code('contexts/AppContext.tsx'), /provider && providerChannel === 'extension' \? supportsSolanaTransfer\(provider\) : false/);
  assert.match(card, /const buttons = fundingButtons\(phone, extensionSends\);/);
  assert.equal(fundingButtons(false, true), 'extension');
  assert.equal(fundingButtons(true, true), 'extension');
  assert.equal(fundingButtons(false, false), null, 'a computer without the extension: by hand only');
  // Owner 20.10: a phone always gets both buttons. A testnet phone opens QNet Wallet's Solana Send with the transfer
  // link, never the solana: link, which another cluster's wallet app could take; a mainnet one gets the solana: link.
  assert.equal(ACTIVATION_NETWORK, 'testnet');
  assert.equal(PHONE_LINK, 'transfer');
  assert.equal(fundingButtons(true, false), 'links', 'a phone without the extension: both links');
  assert.equal(requestLink({ to: PAYMENT, mint: ONE_DEV_MINT, amount: '1500' }), `${TRANSFER_LINK_PREFIX}to=${PAYMENT}&mint=${ONE_DEV_MINT}&amount=1500`);
  assert.ok(appLink({ to: PAYMENT, mint: ONE_DEV_MINT, amount: '1500' }).startsWith(TRANSFER_LINK_PREFIX));
  assert.match(read('lib/cabinet/payment-request.ts'), /export const PHONE_LINK: PhoneLink = ACTIVATION_NETWORK === 'mainnet' \? 'request' : 'transfer';/);
  assert.match(read('lib/cabinet/payment-request.ts'), /export type PhoneLink = 'transfer' \| 'request';/);
  const doc = readFileSync(new URL('../../../../../../docs/applications/explorer.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.ok(doc.includes(`of the kind the release constant \`PHONE_LINK\` names`));
  assert.ok(doc.includes(`testnet is \`'${PHONE_LINK}'\``), 'explorer.md names the release constant\'s value');
  // On Android the button names QNet Wallet with the intent: URL, falling back to the link itself (LinkWaiting openHref),
  // which is a page of the link host (src/app/send).
  assert.match(card, /const android = useDeviceKind\(\)\?\.android === true;/);
  assert.match(card, /if \(buttons === 'links'\) \{\s*return <a key=\{token\} href=\{openHref\(requestLink\(transfer\), android\)\} className=\{className\}>\{label\}<\/a>;\s*\}/);
  assert.equal([...card.matchAll(/requestLink\(/g)].length, 1);
  assert.match(code('components/cabinet/LinkWaiting.tsx'), /export function openHref\(link: string, android: boolean\): string \{\s*return \(android && androidIntentUrl\(link, link\)\) \|\| link;\s*\}/);
  // The extension's button sends exactly what its label says.
  assert.match(card, /onClick=\{\(\) => void send\(token, transfer, amount\)\} disabled=\{sending !== null\}>\{label\}<\/button>/);
  assert.match(card, /const result = await sendSolanaTransfer\(transfer\);/);
  // An extension that answers 4200 after all takes its buttons away.
  assert.match(card, /if \(!result\.ok && result\.failure === 'unsupported'\) setExtensionSends\(false\);/);
  // Test tokens are named as such on the buttons too.
  assert.match(card, /const tokenName = \(token: FundingToken\) => \(ACTIVATION_NETWORK === 'testnet' \? t\('act_test_token', \{ token: tokens\[token\] \}\) : tokens\[token\]\);/);
  assert.equal(TEXTS.act_test_token, 'test {token}');
  // Each button is done from the balance read, with the full amount; the SOL is the primary one once the 1DEV is in or on
  // its way.
  assert.match(card, /const received = fundingReceived\(balance, price\);/);
  assert.match(card, /if \(!transfer\) \{\s*return <span key=\{token\} className="cab-send-st">\{t\('act_fund_done'\)\}<\/span>;/);
  assert.match(card, /const className = token === 'oneDev' \|\| received\.oneDev \|\| arriving\.oneDev !== undefined \? 'btn btn-solid btn-sm' : 'btn btn-text';/);
  // One row per transfer: what it is, its full amount, and its state or its button.
  assert.match(card, /<span className="cab-send-k">\{tokens\[token\]\}<\/span>\s*<span className="cab-send-amt">\{full\[token\]\} \{tokenName\(token\)\}<\/span>\s*\{fundButton\(token\)\}/);
  assert.match(card, /\{row\('oneDev'\)\}\s*\{row\('sol'\)\}/);
  assert.equal(TEXTS.act_fund_send, 'Send {amount} {token}');
  assert.equal(TEXTS.act_fund_done, 'Received');
  // The two ways are tabs only when both show (sending from the wallet first); by hand there is the QR code, the
  // address with its Copy and the amounts. The note says what the button opens: the extension, QNet Wallet (the transfer
  // link), or the phone's wallet app.
  assert.match(card, /\{fromWallet \? \(\s*<ViewTabs\s+className="cab-modes"\s+items=\{\[\{ key: 'wallet', label: t\('act_fund_auto_title'\) \}, \{ key: 'manual', label: t\('act_fund_manual_title'\) \}\]\}/);
  assert.match(card, /\{mode === 'wallet' \? fromWallet : yourself\}\s*<\/ViewTabs>\s*\) : yourself\}/);
  assert.match(card, /const fromWallet = buttons && \(/);
  assert.match(card, /\{t\(buttons === 'extension' \? 'act_fund_auto_extension' : PHONE_LINK === 'transfer' \? 'act_fund_auto_phone_transfer' : 'act_fund_auto_phone'\)\}/);
  assert.match(card, /<figure className="cab-pay-qr">\s*<QrCode text=\{record\.pub\}/);
  assert.equal(TEXTS.act_fund_auto_title, 'Send from your wallet');
  assert.equal(TEXTS.act_fund_manual_title, 'Send it yourself');
  assert.match(TEXTS.act_fund_auto_phone, /^Each button opens your wallet app with this address and the amount filled in\. Confirm there: first the 1DEV, then the SOL\.$/);
  assert.match(TEXTS.act_fund_auto_phone_transfer, /^Each button opens QNet Wallet on this device with this address and the amount filled in\. Confirm there: first the 1DEV, then the SOL\. Without QNet Wallet, choose "Send it yourself"\.$/);  assert.match(TEXTS.act_fund_auto_extension, /^Each button opens the QNet Wallet extension with this address and the amount filled in\./);
  // What became of the extension's transfer, until the balance shows it.
  assert.match(card, /\{outcome && !received\[outcome\.token\] && \(/);
  assert.equal(transferKey({ ok: true, signature: 'x' }), 'transfer_sent');
  assert.equal(transferKey({ ok: false, failure: 'short' }), 'transfer_failure_short');
  assert.equal(transferKey({ ok: false, failure: 'rejected' }), 'ext_failure_rejected');
  assert.equal(transferKey({ ok: false, failure: 'cooldown' }), 'ext_failure_cooldown');
  for (const failure of ['timeout', 'failed', 'unverifiable']) assert.equal(transferKey({ ok: false, failure }), `transfer_failure_${failure}`);
  for (const failure of ['short', 'timeout', 'failed', 'unverifiable']) assert.ok(TEXTS[`transfer_failure_${failure}`], failure);
});

// The testnet phone had no buttons (owner, 19.10: "make them buttons"): its link is QNet Wallet's transfer link, read by
// the app's own parser into the transfer the button names, with the 1DEV mint of the release's cluster; what the app
// refuses, the site's check refuses too.
test('a testnet phone\'s link is QNet Wallet\'s transfer link: the app reads it as the same transfer, the mint of the release\'s cluster', () => {
  const app = appTransferLink();
  const price = 1500;
  const transfers = [
    fundingTransfer(PAYMENT, 'oneDev', fundingLeft(null, price).oneDev),
    fundingTransfer(PAYMENT, 'sol', fundingLeft(null, price).sol),
    fundingTransfer(PAYMENT, 'oneDev', 500n * ONE_DEV_UNIT),
    fundingTransfer(PAYMENT, 'sol', 700_000n),
    fundingTransfer(PAYMENT, 'oneDev', 1n),
    fundingTransfer(PAYMENT, 'sol', 1n),
    fundingTransfer(PAYMENT, 'oneDev', 1_000_000_000n * ONE_DEV_UNIT - 1n),
  ];
  for (const transfer of transfers) {
    const link = appLink(transfer);
    assert.match(link, TRANSFER_LINK_RE, link);
    assert.equal(isTransferLink(link), true, link);
    assert.ok(link.length <= 172, link);
    assert.equal(app.isTransferLink(link), true, link);
    assert.deepEqual(app.parseTransferLink(link), transfer, link);
    // A mainnet release's request link is no transfer link.
    assert.equal(app.isTransferLink(mainnetLink(transfer)), false);
  }
  // What the site's form refuses, the app refuses too.
  for (const bad of [
    `https://link.aiqnet.io/send#to=${PAYMENT}&amount=0`, `https://link.aiqnet.io/send#to=${PAYMENT}&amount=1.50`,
    `https://link.aiqnet.io/send#amount=1&to=${PAYMENT}`, `https://link.aiqnet.io/send#to=${PAYMENT}&amount=1&x=1`,
    `https://link.aiqnet.io/send?to=${PAYMENT}&amount=1`, `https://link.aiqnet.io/send#to=${PAYMENT}&mint=x&amount=1`,
    `https://link.aiqnet.io/l#to=${PAYMENT}&amount=1`, `https://aiqnet.io/send#to=${PAYMENT}&amount=1`,
  ]) {
    assert.equal(TRANSFER_LINK_RE.test(bad), false, bad);
    assert.equal(isTransferLink(bad), false, bad);
    assert.equal(app.parseTransferLink(bad), null, bad);
  }
  // An address of the right letters and length that is not 32 bytes: the app refuses it, and so does the site.
  for (const key of ['2'.repeat(32), 'z'.repeat(44)]) {
    for (const bad of [`https://link.aiqnet.io/send#to=${key}&amount=1`, `https://link.aiqnet.io/send#to=${PAYMENT}&mint=${key}&amount=1`]) {
      assert.match(bad, TRANSFER_LINK_RE);
      assert.equal(isTransferLink(bad), false, bad);
      assert.equal(app.parseTransferLink(bad), null, bad);
    }
  }
  // One 1DEV mint per cluster, the same literals as the node's network profiles and the extension's; this release asks
  // for the one of BURN_CLUSTER, the one QNet Wallet's devnet build lists.
  assert.equal(ONE_DEV_MINT, ONE_DEV_MINTS[BURN_CLUSTER]);
  assert.match(read('lib/one-dev.ts'), /export const ONE_DEV_MINT: string = ONE_DEV_MINTS\[BURN_CLUSTER\];/);
  const extension = readFileSync(new URL('../../../../../qnet-wallet/dist/background/config.js', import.meta.url), 'utf8');
  const table = /const ONE_DEV_MINTS = Object\.freeze\(\{\s*devnet: '([1-9A-HJ-NP-Za-km-z]+)',\s*mainnet: '([1-9A-HJ-NP-Za-km-z]+)',\s*\}\);/.exec(extension);
  assert.deepEqual({ devnet: table[1], mainnet: table[2] }, { ...ONE_DEV_MINTS });
  const node = readFileSync(new URL('../../../../../../development/qnet-integration/src/network_config.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const nodeMint = (name) => new RegExp(`^pub const ${name}: &str = "([1-9A-HJ-NP-Za-km-z]+)";$`, 'm').exec(node)[1];
  assert.deepEqual({ devnet: nodeMint('DEVNET_1DEV_MINT'), mainnet: nodeMint('MAINNET_1DEV_MINT') }, { ...ONE_DEV_MINTS });
  const nodes = readFileSync(new URL('src/config/nodes.js', MOBILE), 'utf8');
  assert.equal(/export const SOLANA_CLUSTER = '([a-z]+)';/.exec(nodes)[1], BURN_CLUSTER);
  assert.equal(/export const ONE_DEV_MINT = '([1-9A-HJ-NP-Za-km-z]+)';/.exec(nodes)[1], ONE_DEV_MINT);
});

// After "submitted" the button was enabled and primary again until the next balance read, and a second tap opened a
// second approval for the same tokens; so did a tap after the page stopped waiting while the window was still open.
test('a transfer that may still arrive: its button waits for the balance, never asking for the same tokens twice', () => {
  // Sent, or an outcome the page could not learn while the window may still be open: the button waits.
  assert.equal(transferMayArrive({ ok: true, signature: 'x' }), true);
  for (const failure of ['timeout', 'unverifiable', 'disconnected']) assert.equal(transferMayArrive({ ok: false, failure }), true, failure);
  // Nothing was sent: the button stays to try again.
  for (const failure of ['rejected', 'cooldown', 'unauthorized', 'unsupported', 'short', 'failed']) assert.equal(transferMayArrive({ ok: false, failure }), false, failure);
  const steps = code('components/cabinet/ActivateSteps.tsx');
  const card = steps.slice(steps.indexOf('export function Funding('), steps.indexOf('export function Receipt('));
  assert.match(card, /if \(transferMayArrive\(result\)\) setArriving\(\(was\) => \(\{ \.\.\.was, \[token\]: amount \}\)\);/);
  // The waiting button has no action, so the next tap cannot open a second approval; it ends when the balance holds the
  // amount (the done state comes first) or the page is reloaded (the state is the page's own).
  assert.match(card, /const \[arriving, setArriving\] = useState<Partial<Record<FundingToken, string>>>\(\{\}\);/);
  assert.match(card, /if \(!transfer\) \{[\s\S]*?\}\s*const waiting = arriving\[token\];\s*if \(waiting !== undefined\) \{\s*return <span key=\{token\} className="cab-send-st wait">\{t\('act_fund_waiting', \{ amount: waiting, token: tokenName\(token\) \}\)\}<\/span>;\s*\}/);
  assert.equal(TEXTS.act_fund_waiting, 'Waiting for {amount} {token} to arrive');
  // What to do when the user did not confirm after all.
  for (const key of ['transfer_failure_timeout', 'transfer_failure_unverifiable']) assert.match(TEXTS[key], /If you did not, reload this page and try again\.$/, key);
});

test('the hand-over to the faucet: kept in this tab\'s session storage, read once and removed; nothing else is kept', () => {
  const area = new Map();
  const storage = { getItem: (k) => area.get(k) ?? null, setItem: (k, v) => area.set(k, v), removeItem: (k) => area.delete(k) };
  handOver(SOLANA, storage);
  assert.deepEqual([...area.entries()], [[HANDOVER_KEY, SOLANA]]);
  assert.equal(takeHandedOver(storage), SOLANA);
  assert.equal(area.size, 0, 'removed as it is read');
  assert.equal(takeHandedOver(storage), null, 'once');
  // Anything but a Solana address is neither kept nor taken.
  handOver('not an address', storage);
  assert.equal(area.size, 0);
  area.set(HANDOVER_KEY, 'x'.repeat(40));
  assert.equal(takeHandedOver(storage), null);
  assert.equal(area.size, 0);
  // Blocked or missing storage: nothing thrown, nothing handed over.
  const blocked = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
  handOver(SOLANA, blocked);
  assert.equal(takeHandedOver(blocked), null);
  assert.equal(takeHandedOver(null), null);
  // The Testnet page reads it once on load and only fills its field; it sends nothing by itself, and the address never
  // goes into a URL.
  const page = code('app/testnet/page.tsx');
  assert.match(page, /useEffect\(\(\) => \{\s*const handed = takeHandedOver\(\);\s*if \(handed\) \{\s*setFaucetAddress\(handed\);\s*setFromNode\(true\);\s*\}\s*setFaucetPass\(takeHandedPass\(\)\);\s*\}, \[\]\);/);
  assert.match(page, /id="faucet"/);
  assert.doesNotMatch(read('components/cabinet/ActivateSteps.tsx'), /testnet\?|searchParams|URLSearchParams/);
});

test('the faucet sends a wallet enough test SOL to fund a payment address from it', () => {
  const page = code('app/testnet/page.tsx');
  assert.match(page, /const FAUCET_SOL = 0\.005;/);
  assert.match(page, /body: JSON\.stringify\(\{ walletAddress: address, amount: FAUCET_SOL, tokenType: 'SOL', \.\.\.withPass \}\)/);
  // The payment address's SOL, its 1DEV account's rent (the sending wallet opens it) and two network fees.
  const need = Number(FUNDING_SOL_LAMPORTS + 2_039_280n + 2n * 5_000n) / 1e9;
  assert.ok(0.005 > need, `${need}`);
  // Within the faucet route's per-claim cap.
  assert.match(read('app/api/faucet/claim/route.ts'), /const FAUCET_AMOUNTS = \{ '1DEV': 1500, SOL: 0\.01 \} as const;/);
});

// One faucet (owner, 29.09): the Testnet page's, which funds the user's own Solana address. The cabinet's route that
// sent a payment address test tokens is gone with its module, its limits and its setting; nothing calls it.
test('the route does not exist: no cabinet faucet, its limits, its setting or a caller of it', async () => {
  assert.equal(existsSync(new URL('app/api/cabinet/faucet', SRC)), false);
  assert.equal(existsSync(new URL('server/cabinet/faucet.ts', SRC)), false);
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) return name === '__tests__' || name === '__release__' ? [] : walk(new URL(`${name}/`, dir));
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [url] : [];
  });
  const sources = walk(SRC);
  assert.ok(sources.length > 100);
  for (const url of sources) {
    const text = readFileSync(url, 'utf8');
    assert.doesNotMatch(text, /\/api\/cabinet\/faucet|cabinet\/faucet['.]|paymentFundingInstructions|CABINET_FAUCET/, url.pathname);
  }
  const { CABINET_LIMITS } = await import('../../server/cabinet/limits.ts');
  assert.deepEqual(Object.keys(CABINET_LIMITS).filter((k) => /faucet/i.test(k)), []);
  const REPO = new URL('../../../../../../', import.meta.url);
  for (const path of ['applications/qnet-explorer/frontend/ecosystem.config.example.js', 'deployment/deploy-aiqnet.sh', 'deployment/deploy-to-1984.sh', 'docs/applications/explorer.md']) {
    const text = readFileSync(new URL(path, REPO), 'utf8');
    assert.doesNotMatch(text, /CABINET_FAUCET|\/api\/cabinet\/faucet/, path);
  }
});

// SITE-R3-01: the cabinet chose its testnet or mainnet branch from FAUCET_ENV or NEXT_PUBLIC_NETWORK, and nothing set
// was 'mainnet'. The deploy script and the ecosystem template set neither, so a devnet-only site told visitors to send
// real SOL "from any wallet or exchange" to a payment address it reads only on devnet, and the /testnet faucet took its
// mainnet amounts. The network is now the release's, from BURN_CLUSTER, whatever is set.
test('the cabinet\'s network is the release\'s, from BURN_CLUSTER: testnet on devnet whatever the settings say', async () => {
  const { BURN_CLUSTER } = await import('../qnet-link.ts');
  const { ACTIVATION_NETWORK } = await import('../one-dev.ts');
  const { faucetEnvironment } = await import('../../server/faucet-config.ts');
  assert.equal(BURN_CLUSTER, 'devnet');
  assert.equal(ACTIVATION_NETWORK, 'testnet');
  const saved = { FAUCET_ENV: process.env.FAUCET_ENV, NEXT_PUBLIC_NETWORK: process.env.NEXT_PUBLIC_NETWORK };
  try {
    for (const [faucetEnv, network] of [[undefined, undefined], ['mainnet', undefined], [undefined, 'mainnet'], ['production', 'mainnet'], ['testnet', undefined]]) {
      for (const [key, value] of [['FAUCET_ENV', faucetEnv], ['NEXT_PUBLIC_NETWORK', network]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      assert.equal(faucetEnvironment(), 'testnet', `FAUCET_ENV=${faucetEnv} NEXT_PUBLIC_NETWORK=${network}`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // No setting is read for it anywhere in the site.
  assert.doesNotMatch(code('server/faucet-config.ts'), /process\.env\.(FAUCET_ENV|NEXT_PUBLIC_NETWORK)/);
  assert.match(read('lib/one-dev.ts'), /export const ACTIVATION_NETWORK: 'testnet' \| 'mainnet' = BURN_CLUSTER === 'devnet' \? 'testnet' : 'mainnet';/);
  // A payment address is made for the release's network, never the page's choice. The user funds it from their own
  // wallet (owner, 29.09); on testnet the page asks for test tokens on Solana devnet and links the Testnet page's
  // faucet, and never says "any wallet or exchange".
  const { createPaymentKey } = await import('../cabinet/payment-key.ts');
  const records = new Map();
  const area = { all: async () => [...records.values()], update: async (pub, change) => { const next = change(records.get(pub)); if (next) records.set(pub, next); } };
  assert.equal((await createPaymentKey({ wallet: 'd9fa370374e24333242eon847d1d354dcd87fe873823e', area, now: 1 })).network, 'testnet');
  assert.match(read('lib/cabinet/payment-key.ts'), /const network: Network = ACTIVATION_NETWORK;/);
  const page = code('components/cabinet/NodeActivate.tsx');
  // The page names only the wallet the address is for; the network is the release's.
  assert.match(page, /const created = await createPaymentKey\(\{ wallet: choice\.qnet \}\);/);
  assert.doesNotMatch(page, /createPaymentKey\(\{(?! wallet: choice\.qnet \}\))|\? 'testnet' : 'mainnet'/);
  const steps = code('components/cabinet/ActivateSteps.tsx');
  assert.match(steps, /<p className="cab-pay-h">\{t\(ACTIVATION_NETWORK === 'mainnet' \? 'act_mainnet_send' : 'act_testnet_send', \{ price: number\(price\), sol \}\)\}<\/p>/);
  assert.equal(steps.match(/act_mainnet_send/g).length, 1);
  assert.match(steps, /\{ACTIVATION_NETWORK === 'testnet' && \(\s*<p>\s*\{rich\('act_no_tokens', \{/);
  // The page asks the site for no funding.
  assert.doesNotMatch(steps + page + read('lib/cabinet/activation.ts'), /onFaucet|claimFaucet|readFaucet|\/api\/cabinet\/faucet/);
  assert.match(TEXTS.act_testnet_send, /^Send \{price\} test 1DEV and \{sol\} test SOL \(Solana devnet\) to this address\.$/);
  assert.doesNotMatch(TEXTS.act_testnet_send, /exchange/);
  assert.doesNotMatch(TEXTS.act_mainnet_send, /\btest\b|exchange/);
});
