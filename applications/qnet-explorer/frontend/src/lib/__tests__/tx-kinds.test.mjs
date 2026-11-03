// The kinds of transaction the explorer names: each has a colour of its own, the same mark on every page that lists a
// transaction, readable on the dark ground and far enough from every other kind's, and from Signal, that no two look alike.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapTxType, tokenCallType } from '../tx-mapping.ts';
import { txTypeLabel } from '../tx-labels.ts';
import { EN } from './texts-helper.mjs';
import { allSheets, code, cssRules, read } from './source.mjs';

// The kind of every type the chain writes, as the archive stores it and as a node sends it.
const RAW_TYPES = [
  'Transfer', 'BatchTransfers', 'RewardDistribution', 'NodeRegistration', 'NodeActivation', 'BatchNodeActivations', 'HeartbeatCommitment',
  'Heartbeat', 'LightNodeEligibilityBitmap', 'BitmapCommitment', 'PingAttestation', 'PingCommitmentWithSampling', 'ContractDeploy',
  'ContractCall', 'Swap', 'CreateAccount', 'NodeReactivation', 'KeyRotation', 'EquivocationProof',
];
const KINDS = [...new Set([
  ...RAW_TYPES.map((type) => mapTxType(type, 'eon_sender')),
  ...RAW_TYPES.map((type) => mapTxType({ [type]: {} }, 'eon_sender')),
  mapTxType('RewardDistribution', 'system_rewards_pool'),
  mapTxType('ContractCall', 'eon_sender', '{"method":"transfer","args":[]}'),
])];

// TX_KINDS of components/ui/Status.tsx: the explorer's name of each kind and its mark's name.
const kindMarks = () => {
  const body = /export const TX_KINDS: Readonly<Record<string, string>> = \{([^}]*)\};/.exec(code('components/ui/Status.tsx'))[1];
  return Object.fromEntries([...body.matchAll(/(?:'([^']+)'|(\w+)): '(\w+)'/g)].map((m) => [m[1] ?? m[2], m[3]]));
};

const tokens = () => Object.fromEntries([...read('styles/tokens.css').matchAll(/^\s*(--[\w-]+): ([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
const resolve = (value, all) => {
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? resolve(all[ref[1]], all) : value;
};

// sRGB to OKLab, the distance between two colours as the eye tells them apart (x 100), and WCAG contrast.
const lin = (hex) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(1 + i, 3 + i), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const oklab = (hex) => {
  const [r, g, b] = lin(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const apart = (a, b) => {
  const x = oklab(a);
  const y = oklab(b);
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
const luminance = (hex) => { const [r, g, b] = lin(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// The kinds a page of the feed shows side by side; the rest (a swap, a retired activation, the system's own records) are
// rare and still apart from all.
const COMMON = ['Transfer', 'Token Transfer', 'Move', 'Reward', 'Heartbeat', 'Light Eligibility', 'Registration', 'Contract Call', 'Deploy'];

test('every kind the explorer names has its own colour, readable on Ink and apart from every other kind and from Signal', () => {
  const marks = kindMarks();
  for (const kind of KINDS) assert.ok(Object.hasOwn(marks, kind), `${kind} has a mark`);
  assert.equal(new Set(Object.values(marks)).size, Object.keys(marks).length, 'one mark per kind');
  const all = tokens();
  const base = cssRules(read('styles/base.css'));
  const colour = {};
  for (const [kind, mark] of Object.entries(marks)) {
    const rule = base.find(([sel]) => sel === `.txtype[data-kind='${mark}']`);
    assert.ok(rule, `${kind}: a rule for its mark`);
    const value = /color: (var\(--kind-[\w-]+\));/.exec(rule[1])?.[1];
    assert.ok(value, `${kind}: its colour is a kind token`);
    colour[kind] = resolve(value, all);
    assert.match(colour[kind], /^#[0-9A-Fa-f]{6}$/, kind);
  }
  assert.equal(new Set(Object.values(colour).map((c) => c.toUpperCase())).size, Object.keys(colour).length, 'no two kinds share a colour');
  const ink = resolve('var(--ink)', all);
  const signal = resolve('var(--signal)', all);
  const names = Object.keys(colour);
  for (const kind of names) {
    assert.ok(contrast(colour[kind], ink) >= 6.5, `${kind} reads on Ink: ${contrast(colour[kind], ink).toFixed(1)}:1`);
    assert.ok(apart(colour[kind], signal) >= 15, `${kind} is no action's colour: ${apart(colour[kind], signal).toFixed(1)}`);
  }
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]];
      const floor = COMMON.includes(a) && COMMON.includes(b) ? 15 : 11;
      assert.ok(apart(colour[a], colour[b]) >= floor, `${a} and ${b} look alike: ${apart(colour[a], colour[b]).toFixed(1)}`);
    }
  }
  // One neutral kind, the transfer: every other has a hue (OKLCH chroma near 0.1 or more; Fog's is 0.02), so none reads
  // as a grey beside it, as the heartbeat in Fog did.
  const chroma = (hex) => { const [, a, b] = oklab(hex); return Math.hypot(a, b); };
  for (const kind of names.filter((k) => k !== 'Transfer')) assert.ok(chroma(colour[kind]) >= 0.09, `${kind} has a hue: ${chroma(colour[kind]).toFixed(3)}`);
  assert.ok(chroma(colour.Transfer) < 0.02, 'the transfer is Paper');
});

test('a move of a node balance to its wallet is a kind of its own, named in the page\'s language', () => {
  assert.equal(mapTxType('RewardDistribution', 'system_rewards_pool'), 'Move');
  assert.equal(mapTxType({ RewardDistribution: {} }, 'system_rewards_pool'), 'Move');
  assert.equal(mapTxType('RewardDistribution', 'system_emission'), 'Reward');
  assert.equal(mapTxType('Transfer', 'eon_sender'), 'Transfer');
  assert.equal(txTypeLabel('Move', true, EN), 'Move to wallet');
  assert.equal(txTypeLabel('Move', false, EN), 'Move to wallet', 'no reward wording in the app\'s view');
  // A token contract's call by its method, on every list.
  assert.equal(tokenCallType('transfer'), 'Token Transfer');
  assert.equal(tokenCallType('transferFrom'), 'Token Transfer');
  assert.equal(tokenCallType('mint'), 'Contract Call');
  assert.equal(mapTxType('ContractCall', 'eon_sender', '{"method":"burn","args":[]}'), 'Contract Call');
  assert.equal(mapTxType('ContractDeploy', 'eon_sender'), 'Deploy');
});

test('every page that lists a transaction marks its kind the one way: the shared name and TxType', () => {
  // One mapping of the chain's types: the block route names its transactions as every other route does.
  const block = code('app/api/blocks/[hash]/route.ts');
  assert.doesNotMatch(block, /getTransactionType|typeMap/);
  assert.equal(block.match(/mapTxType\(/g)?.length, 2, 'the archive\'s transactions and a node\'s');
  for (const route of ['app/api/tx/[hash]/route.ts', 'app/api/address/[address]/route.ts', 'lib/enrich-activity.ts']) {
    assert.match(code(route), /mapTxType\(/, route);
  }
  // The type column (home feed, block, address) and the transaction page draw TxType. A token's page lists the token's
  // movements by method from the token index, which names no transaction kind, so it draws none.
  assert.match(code('components/explorer/columns.tsx'), /cell: \(r\) => <TxType type=\{get\(r\)\} label=\{txTypeLabel\(get\(r\), full, t\)\} \/>/);
  for (const page of ['app/explorer/ExplorerClient.tsx', 'app/explorer/block/[hash]/BlockClient.tsx', 'app/explorer/address/[address]/AddressClient.tsx']) {
    assert.match(code(page), /typeCol<\w+>\(t, \(\w\) => \w\.type, full\)/, page);
  }
  assert.match(code('app/explorer/tx/[hash]/TransactionClient.tsx'), /<TxType type=\{tx\.type\} label=\{txTypeLabel\(tx\.type, full, t\)\} \/>/);
  assert.match(code('app/explorer/token/[contract]/TokenClient.tsx'), /textCol<TokenTransfer>\('method', t\('tx_method'\), \(x\) => <span className="ent">\{x\.method\}<\/span>, 104\),/);
  // No sheet colours a kind any other way.
  assert.doesNotMatch(allSheets(), /\.txtype\[data-tone|\.type-badge|\.badge-(?:transfer|heartbeat)/);
});
