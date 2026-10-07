// Where the node cabinet's payment key can be reached (plan-site sections 4.1 and 8): only the activation page loads
// the module that signs with it; the key is made non-extractable; it signs in one place, through three functions;
// nothing serializes it; only the payment store opens its database; the cabinet writes no HTML and calls only this
// origin. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const SRC = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, SRC), 'utf8');
// Comments may name what the code must not do; only code is checked.
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sources(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) {
      if (name !== '__tests__' && name !== '__release__') sources(new URL(`${name}/`, dir), out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(url.pathname.split('/src/')[1]);
    }
  }
  return out;
}

// Files that import `module` at run time (a type-only import is erased).
const importersOf = (module) => sources().filter((file) => new RegExp(`^import (?!type )[^;]*from '[^']*/${module}(\\.ts)?';`, 'm').test(code(file)));

test('only the activation page loads the payment key', () => {
  assert.deepEqual(importersOf('payment-key').sort(), ['components/cabinet/NodeActivate.tsx', 'lib/cabinet/activation.ts']);
  assert.deepEqual(importersOf('activation'), ['components/cabinet/NodeActivate.tsx']);
  assert.deepEqual(importersOf('NodeActivate'), ['app/node/activate/page.tsx']);
  assert.deepEqual(importersOf('ActivateSteps'), ['components/cabinet/NodeActivate.tsx']);
  // Node details and the pages that ask whether an activation is unfinished read the receipts through the store, never
  // the key's module.
  for (const file of ['components/cabinet/NodeDetails.tsx', 'hooks/usePaymentRecords.ts', 'components/cabinet/NextSteps.tsx', 'components/cabinet/CabinetFrame.tsx', 'lib/cabinet/consent-submit.ts']) {
    assert.doesNotMatch(code(file), /payment-key|cabinet\/activation'|\.\/activation\.ts'/, file);
  }
  // Another browser finishes a payment address's registration with the wallet's consent alone (C4): no key module.
  assert.deepEqual(importersOf('consent-submit').sort(), ['components/cabinet/NextSteps.tsx', 'lib/cabinet/activation.ts']);
  assert.match(code('hooks/usePaymentRecords.ts'), /import \{ listRecords \} from '@\/lib\/cabinet\/payment-store';/);
});

test('the key is non-extractable, signs in one place through three functions, and is never serialized', () => {
  const src = code('lib/cabinet/payment-key.ts');
  const makes = src.match(/generateKey\([^)]*\)/g);
  assert.equal(makes.length, 2);
  for (const m of makes) assert.equal(m, "generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])");
  assert.equal(src.match(/subtle\.sign\(/g).length, 1);
  assert.deepEqual([...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]), ['paymentKeySupported', 'createPaymentKey', 'signBurn', 'signOwnerBindV2', 'signRefund']);
  // Each signer builds its own bytes and checks its stage and the reserved wallet first.
  assert.match(src, /export async function signBurn[^{]*\{\s*if \(record\.stage !== 'funded'\) throw new Error\('stage'\);/);
  assert.match(src, /export async function signOwnerBindV2[^{]*\{\s*const held = record\.reservation;\s*const hold = record\.hold;\s*if \(record\.stage !== 'funded' \|\| !record\.burn \|\| !held \|\| !hold \|\| held\.wallet !== hold\.wallet\) throw new Error\('reservation'\);/);
  // The refund: once recorded (leftovers) or ended unrecorded (closing), never while the activation runs.
  assert.match(src, /export async function signRefund[^{]*\{\s*if \(record\.stage !== 'leftovers' && record\.stage !== 'closing'\) throw new Error\('stage'\);/);
  assert.doesNotMatch(src, /exportKey\('(pkcs8|jwk)'/);
  for (const file of ['lib/cabinet/activation.ts', 'lib/cabinet/payment-key.ts', 'lib/cabinet/payment-store.ts', 'components/cabinet/NodeActivate.tsx']) {
    const text = code(file);
    assert.doesNotMatch(text, /JSON\.stringify\((record|r|current|next)\b/, file);
    assert.doesNotMatch(text, /console\./, file);
  }
  // The activation steps never name the key; the one place a record is given a key value is the receipt, which deletes it
  // (flow.ts asReceipt, SITE-R3-03).
  assert.equal(code('lib/cabinet/activation.ts').match(/\bkey: [^,} ]+/g), null);
  assert.deepEqual(code('lib/cabinet/flow.ts').match(/\bkey: [^,} ]+/g), ['key: CryptoKey', 'key: null']);
});

test('only the payment store opens the cabinet\'s database', () => {
  const users = sources().filter((file) => /indexedDB|qnet-cabinet/.test(code(file)));
  assert.deepEqual(users.sort(), ['lib/cabinet/payment-store.ts', 'lib/link-store.ts']);
  assert.deepEqual(code('lib/cabinet/payment-store.ts').match(/indexedDB\.\w+/g), ['indexedDB.open']);
});

test('the cabinet writes no HTML and its pages call only this origin', () => {
  const files = sources().filter((f) => /^(components\/cabinet|lib\/cabinet|server\/cabinet|app\/node|app\/api\/cabinet)\//.test(f));
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = code(file);
    assert.doesNotMatch(text, /innerHTML|dangerouslySetInnerHTML|\beval\(|new Function|document\.write/, file);
  }
  // Every path the activation and code pages ask is a cabinet route of this origin; no page names another host.
  for (const file of ['lib/cabinet/activation.ts', 'lib/cabinet/code-check.ts', 'components/cabinet/NodeActivate.tsx', 'components/cabinet/ActivateSteps.tsx', 'components/cabinet/NodeDetails.tsx']) {
    const text = code(file);
    for (const m of text.matchAll(/[`'](\/api\/[^`']*)/g)) assert.match(m[1], /^\/api\/cabinet\//, `${file}: ${m[1]}`);
    assert.doesNotMatch(text.replace(/solanaTxUrl/g, ''), /[`']https?:\/\//, file);
    assert.doesNotMatch(text, /XMLHttpRequest|sendBeacon|WebSocket|EventSource|window\.open\(/, file);
  }
  assert.ok([...code('lib/cabinet/activation.ts').matchAll(/[`'](\/api\/cabinet\/[^`']*)/g)].length >= 8);
});
