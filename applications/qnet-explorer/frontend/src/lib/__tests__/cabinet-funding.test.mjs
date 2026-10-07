// The payment address funded as on mainnet (owner, 29.09): the user sends the exact amounts from their own wallet. The
// card names the QNet wallet the node is for, the 1DEV and the SOL the burn needs; a QR code of a standard payment
// request fills in the address, 1DEV and the amount, and the SOL has a small code of its own; the site's funding
// button and its route are gone (one faucet, on the Testnet page). On testnet a link takes the wallet's Solana address
// to the Testnet page's faucet without a URL, read there once. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { BURN_FEE_LAMPORTS, BURN_SOL_LAMPORTS, FUNDING_SOL_LAMPORTS, SYSTEM_ACCOUNT_RENT_LAMPORTS } from '../cabinet/burn-tx.ts';
import { REQUEST_LABEL, decimalAmount, fundingSol, oneDevRequest, paymentRequest, solRequest } from '../cabinet/payment-request.ts';
import { fundedFor } from '../cabinet/activation.ts';
import { HANDOVER_KEY, handOver, takeHandedOver } from '../faucet-handover.ts';
import { ONE_DEV_MINT, ONE_DEV_UNIT } from '../one-dev.ts';
import { qrMatrix } from '../qr.ts';
import { TEXTS } from '../texts.ts';

const SRC = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const PAYMENT = '9z1QsPH2k9xpYY9EQYh8EdPjhnt9CXnsxZZkYgT5Km96';
const SOLANA = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

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

test('the payment requests: the address, the amount in whole tokens, the cluster\'s 1DEV mint for 1DEV, the label', () => {
  assert.equal(REQUEST_LABEL, 'QNet activation');
  assert.equal(oneDevRequest(PAYMENT, 1500), `solana:${PAYMENT}?amount=1500&spl-token=${ONE_DEV_MINT}&label=QNet%20activation`);
  assert.equal(solRequest(PAYMENT), `solana:${PAYMENT}?amount=0.001&label=QNet%20activation`);
  assert.equal(paymentRequest(PAYMENT, '2'), `solana:${PAYMENT}?amount=2&label=QNet%20activation`);
  // Plain decimals: no grouping, no trailing zeros, no exponent.
  assert.equal(decimalAmount(1_000_000n, 9), '0.001');
  assert.equal(decimalAmount(1_234_500_000_000n, 9), '1234.5');
  assert.equal(decimalAmount(5n, 9), '0.000000005');
  assert.equal(decimalAmount(2_000_000_000n, 9), '2');
  // Both fit the page's own QR encoder.
  assert.ok(qrMatrix(oneDevRequest(PAYMENT, 1500)).size > 0);
  assert.ok(qrMatrix(solRequest(PAYMENT)).size > 0);
});

test('the payment card: who the node is for, the exact amounts, the two codes, no funding button, the testnet faucet link', () => {
  const steps = code('components/cabinet/ActivateSteps.tsx');
  const card = steps.slice(steps.indexOf('export function Funding('), steps.indexOf('export function Receipt('));
  // Who the node belongs to: the QNet wallet that confirmed it in QNet Wallet, never the payment address.
  assert.match(card, /\{wallet && <p>\{t\('act_owner', \{ wallet: shortAddress\(wallet\) \}\)\}<\/p>\}/);
  assert.equal(TEXTS.act_owner, 'The node is registered to your QNet wallet {wallet}; this one-time address only burns the 1DEV. Its key stays in this browser until what is left has gone back.');
  assert.equal(Object.prototype.hasOwnProperty.call(TEXTS, 'act_owner_later'), false);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /<Funding record=\{record\} price=\{price\} balance=\{balance\} wallet=\{named\} walletSolana=\{choice\?\.solana \?\? null\} phone=\{device\?\.phone === true\} \/>/);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /const pinned = record \? pinnedWallet\(record\) : null;/);
  assert.match(code('components/cabinet/NodeActivate.tsx'), /const named = pinned \?\? choice\?\.qnet \?\? null;/);
  // The amounts, then the 1DEV request's code, the address with Copy, and the SOL's own code; each request can be
  // copied as it is (XC-11).
  assert.match(card, /const oneDev = oneDevRequest\(record\.pub, price\);\s*const solOnly = solRequest\(record\.pub\);/);
  assert.match(card, /<QrCode text=\{oneDev\} label=\{t\('act_request_qr', \{ price: number\(price\) \}\)\} \/>/);
  assert.match(card, /<CopyButton value=\{record\.pub\} \/>/);
  assert.match(card, /<CopyButton value=\{oneDev\} label=\{t\('act_copy_request'\)\} \/>/);
  assert.match(card, /<QrCode text=\{solOnly\} label=\{t\('act_sol_qr', \{ sol \}\)\} small \/>/);
  assert.match(card, /<CopyButton value=\{solOnly\} label=\{t\('act_copy_request'\)\} \/>/);
  assert.equal(TEXTS.act_copy_request, 'Copy payment request');
  // On a phone, QNet Wallet on the same phone cannot scan the page: the address is copied instead (SITE-F8), as the
  // phone guide says.
  assert.match(card, /\{phone \? t\('act_request_note_phone', \{ price: number\(price\), sol \}\) : t\('act_request_note'\)\}/);
  assert.match(TEXTS.act_request_note_phone, /^On this phone, copy the address, then in QNet Wallet send \{price\} 1DEV and, separately, \{sol\} SOL to it\./);
  assert.match(TEXTS.guide_phone_fund_testnet, /tap "Copy" under the payment address, and in QNet Wallet send it the 1DEV amount, then the SOL amount/);
  assert.match(TEXTS.act_mainnet_send, /^Send \{price\} 1DEV and \{sol\} SOL to this address from your wallet\.$/);
  assert.match(TEXTS.act_sol_line, /^The \{sol\} SOL pays the burn's network fee and the address's rent: scan this second code for it/);
  // No funding by the site from the card; on testnet the faucet link, handing the wallet's Solana address over, and the
  // faucet pass for the wallet when the site gave one (SITE M-13).
  assert.doesNotMatch(card, /act_faucet|onFaucet|faucetBusy/);
  assert.match(card, /<Link href="\/testnet#faucet" onClick=\{toFaucet\}>\{t\('act_no_tokens_link'\)\}<\/Link>/);
  assert.match(card, /const toFaucet = \(\) => \{\s*if \(walletSolana\) handOver\(walletSolana\);\s*if \(pass\) handOverPass\(pass\);\s*\};/);
  assert.equal(TEXTS.act_no_tokens, 'No test tokens yet? {link}');
  assert.equal(TEXTS.act_no_tokens_link, 'Get them to your wallet');
  // The safety sentences stay on the card.
  for (const key of ['act_address_note', 'act_keep_browser']) assert.ok(card.includes(`t('${key}')`), key);
  assert.match(TEXTS.act_address_note, /^Send only to this address\. The page burns exactly the activation amount from it, nothing else;/);
  // The QR code's labels are the cabinet's own words, and the small code has its own size.
  assert.match(code('components/cabinet/LinkWaiting.tsx'), /className=\{small \? 'activate-qr activate-qr-small' : 'activate-qr'\}/);
  assert.match(read('app/globals.css'), /\.activate-qr-small \{\n {2}width: min\(140px, 45%\);/);
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
  assert.match(steps, /<p className="cabinet-lead">\{t\(ACTIVATION_NETWORK === 'mainnet' \? 'act_mainnet_send' : 'act_testnet_send', \{ price: number\(price\), sol \}\)\}<\/p>/);
  assert.equal(steps.match(/act_mainnet_send/g).length, 1);
  assert.match(steps, /\{ACTIVATION_NETWORK === 'testnet' && \(\s*<p>\s*\{rich\('act_no_tokens', \{/);
  // The page asks the site for no funding.
  assert.doesNotMatch(steps + page + read('lib/cabinet/activation.ts'), /onFaucet|claimFaucet|readFaucet|\/api\/cabinet\/faucet/);
  assert.match(TEXTS.act_testnet_send, /\{price\} test 1DEV and \{sol\} test SOL \(Solana devnet\) to this address from your wallet\.$/);
  assert.doesNotMatch(TEXTS.act_testnet_send, /exchange/);
  assert.doesNotMatch(TEXTS.act_mainnet_send, /\btest\b|exchange/);
});
