// The page's requests to the site's own routes end after their budget (site-request.ts): a connection that stops
// answering, before the headers or inside the body, fails into the caller's retry instead of holding the page. A request
// whose route waits longer on the network gets that wait and more. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { SITE_REQUEST_MS, siteRequest } from '../site-request.ts';
import { POLL_INTERVAL_MS } from '../qnet-link.ts';
import { pollAnswer, releaseLinkSession, startLinkSession } from '../link-client.ts';
import { RESERVE_REQUEST_MS, readPrice, reserveWallet } from '../cabinet/activation.ts';
import { REGISTER_REQUEST_MS, postConsent } from '../cabinet/consent-submit.ts';
import { SUBMIT_TIMEOUT_MS } from '../cabinet/registration.ts';
import { FAUCET_CLAIM_MS, FAUCET_CLAIM_REQUEST_MS, requestFaucetPass } from '../faucet-handover.ts';
import { RPC_CALL_MS } from '../../server/solana-endpoint.ts';
import { code, sourceFiles } from './source.mjs';

// A server that takes the request and then sends nothing more; with `head`, the headers and part of the body first.
async function silent(head) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('data', () => {
      if (head) socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a":');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/cabinet/price`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) server.close();
    },
  };
}

test('a request ends after its budget, waiting for the headers or inside the body', { timeout: 10_000 }, async () => {
  assert.equal(SITE_REQUEST_MS, 20_000);
  const init = siteRequest({ method: 'DELETE' });
  assert.deepEqual([init.cache, init.credentials, init.redirect, init.method], ['no-store', 'omit', 'error', 'DELETE']);
  for (const head of [false, true]) {
    const server = await silent(head);
    const started = Date.now();
    // A request without a budget is ended by the server's close instead, which is not a timeout.
    const guard = setTimeout(server.close, 3_000);
    try {
      await assert.rejects(async () => (await fetch(server.url, siteRequest({}, 300))).text(), { name: 'TimeoutError' });
      assert.ok(Date.now() - started < 3_000, 'ended near its budget');
    } finally {
      clearTimeout(guard);
      server.close();
    }
  }
});

// A search typed further, a list page left: the caller's own signal ends the request at once, and without it the budget
// still does, where the browser has AbortSignal.any and where it does not.
test('a caller\'s own signal still ends a request first, and the budget ends it otherwise', { timeout: 10_000 }, async () => {
  const any = AbortSignal.any;
  const server = await silent(false);
  try {
    for (const native of [true, false]) {
      AbortSignal.any = native ? any : undefined;
      const caller = new AbortController();
      const left = fetch(server.url, siteRequest({ signal: caller.signal }, 5_000));
      caller.abort();
      await assert.rejects(left, { name: 'AbortError' }, `native=${native}`);
      const started = Date.now();
      await assert.rejects(fetch(server.url, siteRequest({ signal: new AbortController().signal }, 300)), { name: 'TimeoutError' }, `native=${native}`);
      assert.ok(Date.now() - started < 3_000, 'ended near its budget');
    }
  } finally {
    AbortSignal.any = any;
    server.close();
  }
});

// A browser's fetch on a connection that stopped answering: it ends only when the request's signal ends it, here at
// once (the budget itself is the test above); a request sent without one never ends.
const stuck = async (_url, init = {}) => {
  if (!(init.signal instanceof AbortSignal)) return new Promise(() => {});
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};

// The budgets the requests `call` makes were given, in order.
async function budgetsOf(call) {
  const timeout = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => {
    seen.push(ms);
    return timeout.call(AbortSignal, ms);
  };
  try {
    return { value: await call(), budgets: seen };
  } finally {
    AbortSignal.timeout = timeout;
  }
}

test('the link, activation and register requests fail into their retry when the connection stops answering', { timeout: 5_000 }, async () => {
  const session = { id: '0'.repeat(32), intent: 'connect' };
  const deps = { fetchFn: stuck };
  const proof = { pk: 'pk', sig: 'sig', time: 1 };
  const cases = [
    [() => startLinkSession('connect', null, deps), { ok: false, failure: 'network' }, SITE_REQUEST_MS],
    [() => pollAnswer(session, deps), { kind: 'retry', afterMs: POLL_INTERVAL_MS }, SITE_REQUEST_MS],
    [() => releaseLinkSession(session.id, deps), undefined, SITE_REQUEST_MS],
    [() => readPrice(deps), null, SITE_REQUEST_MS],
    [() => reserveWallet('wallet', 'burner', 1, 'solana', proof, deps), { ok: false, outcome: 'check_unavailable' }, RESERVE_REQUEST_MS],
    [() => postConsent({}, deps), { result: 'retry', code: 'network' }, REGISTER_REQUEST_MS],
    [() => requestFaucetPass({ wallet: 'wallet', ...proof }, 'burner', stuck, 1), { pass: null, retryAt: null }, SITE_REQUEST_MS],
  ];
  for (const [call, expected, budget] of cases) assert.deepEqual(await budgetsOf(call), { value: expected, budgets: [budget] });
  // A route that waits on the network gets longer: the page outwaits the site's wait for the node (the same registration
  // sent again joins the one on its way, register.ts), and gives a reservation's checks more than a read.
  assert.ok(REGISTER_REQUEST_MS > SUBMIT_TIMEOUT_MS);
  assert.ok(RESERVE_REQUEST_MS > SITE_REQUEST_MS);
  // The faucet's claim route answers within FAUCET_CLAIM_MS of taking a claim, counted before it reads the body; its
  // confirmation gets what the blockhash and the send leave, 90 s or more, past a blockhash's 150 blocks. The page waits
  // a read more.
  assert.equal(FAUCET_CLAIM_REQUEST_MS, FAUCET_CLAIM_MS + SITE_REQUEST_MS);
  assert.ok(FAUCET_CLAIM_MS - 2 * RPC_CALL_MS >= 90_000);
  const route = code('app/api/faucet/claim/route.ts');
  assert.match(route, /export async function POST\(request: NextRequest\) \{\s*const deadline = Date\.now\(\) \+ FAUCET_CLAIM_MS;\s*try \{/);
  assert.match(route, /const conf = await confirmSignature\(rpc, signed\.signature, lastValidBlockHeight, \{ timeoutMs: deadline - Date\.now\(\) \}\);/);
});

// The text of the call that opens at `at`, to its closing parenthesis.
function callAt(src, at) {
  let depth = 0;
  for (let i = src.indexOf('(', at); i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

// Every request the site's pages make, the explorer's and the faucet's with the cabinet's and the link's, takes its
// budget from siteRequest; a wrapper only passes on the init its caller made. The routes' server code is not a page's.
test('every browser request of the site has a budget', () => {
  const paths = sourceFiles().filter((n) => (/^(components|hooks|app)\//.test(n) && !n.startsWith('app/api/'))
    || n.startsWith('lib/cabinet/') || ['lib/link-client.ts', 'lib/faucet-handover.ts'].includes(n));
  const seen = new Set();
  let calls = 0;
  for (const path of paths) {
    const src = code(path);
    for (const m of src.matchAll(/\b(?:fetch|fetchFn)\(/g)) {
      const call = callAt(src, m.index);
      calls += 1;
      seen.add(path);
      assert.ok(/\bsiteRequest\(/.test(call) || call === 'fetch(url, init)', `${path}: ${call.slice(0, 80)}`);
    }
  }
  for (const path of ['hooks/useChainHead.ts', 'hooks/useNodeCounts.ts', 'components/explorer/useRecentBlocks.ts', 'components/explorer/ExplorerSearch.tsx',
    'app/explorer/ExplorerClient.tsx', 'app/explorer/blocks/BlocksClient.tsx', 'app/explorer/tokens/TokensClient.tsx', 'app/testnet/page.tsx']) {
    assert.ok(seen.has(path), `${path} is checked`);
  }
  assert.ok(calls >= 34, `every call site seen (${calls})`);
});
