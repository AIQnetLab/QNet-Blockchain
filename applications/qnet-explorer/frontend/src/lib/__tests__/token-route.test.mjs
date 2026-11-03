// The token routes against stand-ins: the token route (src/app/api/token/[contract]/route.ts) against stub nodes, the
// token's record when a node gives it, 404 only for the node's own not-found, and 503 with no-store when no node answered
// or a node failed, so the token page says it could not read the token instead of saying there is none; the holders route
// (its holders/route.ts) against a stand-in index, one replay per contract a minute for every reader.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { register } from 'node:module';

// The routes' imports as the site's build resolves them: '@/' is src/, next/server is its file, and the explorer's index
// is a stand-in that holds no transfers and gives the holders route the deploy and pages `globalThis.holdersIndex` holds.
const SRC = new URL('../../', import.meta.url).href;
const INDEX = `export async function getContractTokenTransfers() { return []; }
export async function getContractDeployByAddress(contract) { return globalThis.holdersIndex.deploy(contract); }
export async function getTransactionsByAddress(contract, page, perPage) { return globalThis.holdersIndex.page(contract, page, perPage); }`;
register(`data:text/javascript,${encodeURIComponent(`
const SRC = ${JSON.stringify(SRC)};
const INDEX = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(INDEX)}`)};
export async function resolve(specifier, context, next) {
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier.endsWith('/lib/db')) return { url: INDEX, shortCircuit: true };
  if (specifier.startsWith('@/')) return next(SRC + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
}`)}`);

const TOKEN = { contract_address: 'c', standard: 'qrc20', name: 'Test token', symbol: 'TKN', decimals: 2, total_supply: '123456', total_minted: '200000', total_burned: '76544', deployer: 'd', deployed_at: '1' };
// What each stub node answers for a contract: its status and body, by the contract's name.
const ANSWERS = {
  found: [200, { success: true, token: TOKEN }],
  none: [200, { success: false, error: 'Token not found', contract_address: 'none' }],
  notToken: [200, { success: false, error: 'Contract exists but is not a QRC-20/QRC-721 token' }],
  gone: [404, { error: 'not found' }],
  failing: [200, { success: false, error: 'Failed to query token', details: 'io' }],
  garbled: [200, 'not json'],
  limited: [429, { error: 'Rate limit exceeded' }],
  down: [503, { error: 'unavailable' }],
};

test('the token route: the record from a node, 404 only on the node\'s not-found, 503 with no-store when the nodes cannot be read', async (t) => {
  const nodes = [0, 1].map(() => createServer((req, res) => {
    const contract = decodeURIComponent(req.url.split('/').pop());
    const [status, body] = ANSWERS[contract] ?? [500, {}];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }));
  await Promise.all(nodes.map((n) => new Promise((resolve) => n.listen(0, '127.0.0.1', resolve))));
  // A third node that is not there: its reads fail and the next node is asked.
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const gone = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));
  process.env.QNET_API_URLS = [gone, ...nodes.map((n) => `http://127.0.0.1:${n.address().port}`)].join(',');
  t.after(() => {
    delete process.env.QNET_API_URLS;
    for (const n of nodes) { n.closeAllConnections(); n.close(); }
  });
  const { GET } = await import(new URL('../../app/api/token/[contract]/route.ts', import.meta.url).href);
  const ask = async (contract) => {
    const res = await GET(new Request(`http://localhost/api/token/${contract}?tx=5`), { params: Promise.resolve({ contract }) });
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
  };

  const found = await ask('found');
  assert.equal(found.status, 200);
  assert.equal(found.body.success, true);
  assert.deepEqual([found.body.data.symbol, found.body.data.total_supply, found.body.data.transfers], ['TKN', '1,234.56', []]);
  // The node's own not-found: no token at that contract.
  for (const contract of ['none', 'notToken', 'gone']) {
    const r = await ask(contract);
    assert.deepEqual([r.status, r.body], [404, { success: false, error: 'Token not found or not a QRC-20 contract' }], contract);
  }
  // Not read: a node that failed to read its state, an answer that is not one, a node limiting the site, and every node
  // failing (no answer at all).
  for (const contract of ['failing', 'garbled', 'limited', 'down']) {
    const r = await ask(contract);
    assert.deepEqual([r.status, r.cache, r.body], [503, 'no-store', { success: false, error: 'unavailable' }], contract);
  }
});

// A replay of the index costs up to 40 pages; the token page and QNet Wallet's token screen read it on every open, so a
// contract's replay is kept a minute and made once at a time, whatever list length a reader asks for.
test('the holders route: one replay of the index per contract a minute, shared by every reader; a failed one is not kept', async (t) => {
  const pages = [];
  let fail = false;
  globalThis.holdersIndex = {
    deploy: async () => ({ from_address: 'alice', data: JSON.stringify({ qrc20: true, decimals: 0, initial_supply: '100' }) }),
    page: async (contract, page) => {
      pages.push([contract, page]);
      if (fail) throw new Error('index down');
      return { total: 1, transactions: [{ hash: 'h1', from_address: 'alice', block: 2, timestamp: 2, data: JSON.stringify({ method: 'transfer', args: ['bob', '40'] }) }] };
    },
  };
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  t.after(() => { Date.now = real; delete globalThis.holdersIndex; });
  const { GET } = await import(new URL('../../app/api/token/[contract]/holders/route.ts', import.meta.url).href);
  const ask = async (contract, limit) => {
    const res = await GET(new Request(`http://localhost/api/token/${contract}/holders?limit=${limit}`), { params: Promise.resolve({ contract }) });
    return { status: res.status, body: await res.json() };
  };
  // Two readers at once and a third later in the minute, each with its own length of list: one replay.
  const [ten, one] = await Promise.all([ask('tok', 10), ask('tok', 1)]);
  const all = await ask('tok', 500);
  assert.deepEqual(pages, [['tok', 1]]);
  assert.deepEqual(ten.body.data.holders.map((h) => [h.address, h.balance_raw]), [['alice', '60'], ['bob', '40']]);
  assert.deepEqual(one.body.data.holders.map((h) => h.address), ['alice']);
  assert.deepEqual([all.body.data.holder_count, all.body.data.circulating_raw, all.body.data.truncated], [2, '100', false]);
  // Another contract is a replay of its own; past the minute the contract is replayed again.
  await ask('other', 10);
  offset = 60_000;
  await ask('tok', 10);
  assert.deepEqual(pages, [['tok', 1], ['other', 1], ['tok', 1]]);
  // A replay that failed answers 503 and is not kept: the next reader asks the index again.
  offset = 120_000;
  fail = true;
  assert.equal((await ask('tok', 10)).status, 503);
  fail = false;
  assert.equal((await ask('tok', 10)).status, 200);
  assert.deepEqual(pages.slice(3), [['tok', 1], ['tok', 1]]);
});
