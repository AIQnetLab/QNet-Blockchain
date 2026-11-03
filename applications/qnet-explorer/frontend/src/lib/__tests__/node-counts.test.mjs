// The explorer's Server nodes: the super nodes the network admits that sent a heartbeat in the last settled epoch, the
// admitted ones as the network's eligible set lists them, so a node the network does not admit is counted nowhere; not
// known while that set cannot be read, never counted without it. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMITTED_SUPERS_SQL, EPOCH_BLOCKS, LIGHT_NODES_SQL, NODE_COUNT_TTL_MS, UNKNOWN_COUNT_TTL_MS, createNodeCounts } from '../../server/node-counts.ts';
import { code } from './source.mjs';

const ADMITTED = ['genesis_node_001', 'genesis_node_002', 'genesis_node_003', 'genesis_node_004', 'genesis_node_005', 'super_node_c78c3017a4f93464'];
// Every server that sent heartbeats last epoch: the six the network admits, and one it does not.
const SENDERS = [...ADMITTED, 'super_node_d0590f220be03d34'];

function archive() {
  const asked = [];
  const query = async (text, params) => {
    asked.push([text, params]);
    if (text === ADMITTED_SUPERS_SQL) return { rows: [{ c: String(SENDERS.filter((s) => params[2].includes(s)).length) }] };
    if (text === LIGHT_NODES_SQL) return { rows: [{ c: '1234' }] };
    throw new Error(`unexpected ${text}`);
  };
  return { query, asked };
}

test('Server nodes counts only the super nodes the network admits, from the eligible set; not known without it', async () => {
  // Over the heartbeats of the last settled epoch, within the admitted ids.
  assert.match(ADMITTED_SUPERS_SQL, /WHERE tx_type = 'Heartbeat' AND block >= \$1 AND block < \$2 AND from_address = ANY\(\$3::text\[\]\)/);
  let t = 1_000_000;
  const { query, asked } = archive();
  let set = new Set(ADMITTED);
  const counts = createNodeCounts(query, async () => set, () => t);
  const height = 365 * EPOCH_BLOCKS + 777;
  assert.deepEqual(await counts(height), { superNodes: 6, lightNodes: 1234 });
  const [, params] = asked.find(([text]) => text === ADMITTED_SUPERS_SQL);
  assert.deepEqual(params, [364 * EPOCH_BLOCKS, 365 * EPOCH_BLOCKS, ADMITTED]);
  assert.ok(!params[2].includes('super_node_d0590f220be03d34'), 'the outside node is not among the counted');
  // Kept a minute within the epoch; a new epoch reads again.
  asked.length = 0;
  t += NODE_COUNT_TTL_MS - 1;
  await counts(height + 10);
  assert.equal(asked.length, 0);
  await counts(height + EPOCH_BLOCKS);
  assert.equal(asked.length, 2);
  // No eligible set (no node answered it): the super nodes are not known, the light nodes still are, and the set is asked
  // again soon, not a minute later.
  const unknown = createNodeCounts(archive().query, async () => null, () => t);
  assert.deepEqual(await unknown(height), { superNodes: null, lightNodes: 1234 });
  const failing = createNodeCounts(archive().query, async () => { throw new Error('down'); }, () => t);
  assert.deepEqual(await failing(height), { superNodes: null, lightNodes: 1234 });
  const later = archive();
  let calls = 0;
  const flaky = createNodeCounts(later.query, async () => (calls++ === 0 ? null : set), () => t);
  assert.equal((await flaky(height)).superNodes, null);
  t += UNKNOWN_COUNT_TTL_MS + 1;
  assert.equal((await flaky(height)).superNodes, 6);
  // An admitted node more, an outside node never.
  set = new Set([...ADMITTED, 'super_node_aaaaaaaaaaaaaaaa']);
  assert.equal((await createNodeCounts(archive().query, async () => set, () => t)(height)).superNodes, 6);
});

test('the stats route, the cabinet and the readouts share the one eligible set, and an unknown count reads as not known', () => {
  const route = code('app/api/network/stats/route.ts');
  assert.match(route, /const activeNodeCounts = createNodeCounts\(\(text, params\) => query<\{ c: string \}>\(text, params\), sharedEligibleSet\(\)\);/);
  assert.match(route, /activeNodes: nodes\.superNodes,/);
  assert.doesNotMatch(route, /count\(DISTINCT from_address\)/, 'no count of every heartbeat sender');
  assert.match(code('server/cabinet/node-proxy.ts'), /eligible: sharedEligibleSet\(\)/);
  const hook = code('hooks/useNodeCounts.ts');
  assert.match(hook, /setCounts\(\{ superNodes: count\(body\.data\.activeNodes\), lightNodes: count\(body\.data\.activeLightNodes\) \?\? 0 \}\)/);
  assert.match(code('components/explorer/ChainReadouts.tsx'), /value=\{nodes && nodes\.superNodes !== null \? int\(nodes\.superNodes\) : null\}/);
});
