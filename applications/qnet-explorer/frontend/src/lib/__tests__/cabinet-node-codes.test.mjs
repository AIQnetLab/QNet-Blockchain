// The node's submit answers (development/qnet-integration/src/rpc/registration_door.rs: SubmitCode, its retry set and
// the one-node refusal's text, which the legacy light register route answers too) against what the site's register
// route and the QNet extension make of them (src/lib/cabinet/registration.ts submitOutcome, and the codes and texts of
// applications/qnet-wallet/dist/background/nodes.js, evaluated from its shipped source): a code, the retry set or the
// `wallet_has_node` text changed on one side fails here (shared contracts C6, C7). Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RETRY_CODES, submitOutcome } from '../cabinet/registration.ts';

const REPO = new URL('../../../../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, REPO), 'utf8').replace(/\r\n/g, '\n');

const door = read('development/qnet-integration/src/rpc/registration_door.rs');
const between = (text, from, to) => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} … ${to}`);
  return text.slice(start, end);
};
// SubmitCode variant -> its contract value.
const NODE_CODES = new Map([...between(door, 'fn as_str', '/// A client sends').matchAll(/SubmitCode::(\w+) => "([a-z0-9_]+)"/g)].map((m) => [m[1], m[2]]));
const retryVariants = [...between(door, 'fn retryable', 'WALLET_HAS_NODE_TEXT').matchAll(/SubmitCode::(\w+)/g)].map((m) => m[1]);
const NODE_RETRY = [...NODE_CODES].filter(([variant]) => retryVariants.includes(variant)).map(([, code]) => code);
const WALLET_HAS_NODE_TEXT = door.match(/pub\(crate\) const WALLET_HAS_NODE_TEXT: &str = "([^"]+)";/)?.[1];

const nodesJs = read('applications/qnet-wallet/dist/background/nodes.js');
const EXT = new Function(`${between(nodesJs, 'const RETRY_CODES', 'const TX_HASH_RE')}\nreturn { RETRY_CODES, SUBMIT_CODES, SUBMIT_TEXTS };`)();
const extCode = (body) => (typeof body.code === 'string' && EXT.SUBMIT_CODES.has(body.code) ? body.code
  : EXT.SUBMIT_TEXTS.find(([re]) => re.test(typeof body.error === 'string' ? body.error : ''))?.[1] ?? null);

test('C7: every code the node answers is one the site and the extension know, with the same retry set', () => {
  assert.equal(NODE_CODES.size, 10);
  assert.equal(NODE_CODES.get('WalletHasNode'), 'wallet_has_node');
  // H-4: a v2 owner bind the network does not take yet is a retry, never a refusal of the burn.
  assert.equal(NODE_CODES.get('BindV2Pending'), 'bind_v2_pending');
  assert.ok(NODE_RETRY.includes('bind_v2_pending'));
  assert.deepEqual([...EXT.SUBMIT_CODES].sort(), [...NODE_CODES.values()].sort());
  assert.deepEqual([...RETRY_CODES].sort(), [...NODE_RETRY].sort());
  assert.deepEqual([...EXT.RETRY_CODES].sort(), [...NODE_RETRY].sort());
  for (const code of NODE_CODES.values()) {
    const got = submitOutcome(200, { success: false, code, error: '' });
    if (code === 'already_registered') assert.deepEqual(got, { result: 'registered' });
    else if (code === 'timestamp_window') assert.deepEqual(got, { result: 'stale' });
    else if (NODE_RETRY.includes(code)) assert.deepEqual(got, { result: 'retry', code });
    else assert.deepEqual(got, { result: 'refused', code });
    assert.equal(extCode({ success: false, code, error: '' }), code);
  }
});

test('C6, C7: the one-node refusal reads as wallet_has_node on both clients, with its code or by its text alone', () => {
  assert.ok(WALLET_HAS_NODE_TEXT, 'registration_door.rs WALLET_HAS_NODE_TEXT');
  // Never read as the node's own registration being on chain already.
  assert.doesNotMatch(WALLET_HAS_NODE_TEXT, /node already registered/i);
  const withCode = { success: false, code: 'wallet_has_node', error: WALLET_HAS_NODE_TEXT, node_id: 'super_node_0123456789abcdef' };
  const textOnly = { success: false, error: WALLET_HAS_NODE_TEXT };
  for (const body of [withCode, textOnly]) {
    assert.deepEqual(submitOutcome(200, body), { result: 'refused', code: 'wallet_has_node' });
    assert.equal(extCode(body), 'wallet_has_node');
  }
  // The attestor's refusal (rpc/mod.rs attest_burn) reads the same by its text.
  const rpc = read('development/qnet-integration/src/rpc/mod.rs');
  assert.ok(rpc.includes('message: "wallet already has a node".to_string()'));
  assert.equal(extCode({ success: false, error: 'wallet already has a node' }), 'wallet_has_node');
  assert.deepEqual(submitOutcome(200, { success: false, error: 'wallet already has a node' }), { result: 'refused', code: 'wallet_has_node' });
  // The submit door and the legacy light register route answer the same code and text.
  const register = read('development/qnet-integration/src/rpc/registration_api.rs');
  assert.ok(register.includes('SubmitRefusal::new(SubmitCode::WalletHasNode, "wallet_has_node", WALLET_HAS_NODE_TEXT)'));
  const legacy = read('development/qnet-integration/src/rpc/light_nodes.rs');
  assert.ok(legacy.includes('"code": "wallet_has_node",') && legacy.includes('"error": WALLET_HAS_NODE_TEXT,'));
});
