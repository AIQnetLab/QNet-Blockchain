// The node client against a local mock node serving recorded answers (fixtures/) and the node handlers' shapes.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as sdk from '../dist/index.js';
import { DEFAULT_WALK_TIME_MS, LADDER_BAND, NodeClient, logLeaf } from '../dist/node.js';
import { fixture, mockNode, tempHome, testLineage, V, vector } from './helpers.mjs';

const RECORDED = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
const CONTRACT = vector('tokenTransfer').input.token;
const servers = [];
const serve = async (route) => {
  const s = await mockNode(route);
  servers.push(s);
  return s;
};
after(() => Promise.all(servers.map((s) => s.close())));

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error instanceof sdk.QNetError ? error.code : `not a QNetError: ${error}`;
  }
  return 'no error';
}

async function closedPort() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${s.address().port}`;
  await new Promise((resolve) => s.close(resolve));
  return url;
}

const signed = (name) => {
  const v = vector(name);
  const tx = name === 'contractDeploy'
    ? sdk.buildContractDeploy({ ...v.input, code: hexToBytes(v.input.codeHex) })
    : name === 'transfer' ? sdk.buildTransfer(v.input) : sdk.buildContractCall(v.input);
  return { v, tx, signature: hexToBytes(v.signature), publicKey: hexToBytes(V.wallet.publicKey) };
};

describe('node client', () => {
  it('takes https nodes, and plain http only on this machine', () => {
    assert.throws(() => new NodeClient({ nodes: ['http://example.com'] }), /https/);
    assert.throws(() => new NodeClient({ nodes: ['https://node1.aiqnet.io/api'] }), /scheme, host and port/);
    assert.deepEqual(new NodeClient().nodes, ['https://node1.aiqnet.io', 'https://node2.aiqnet.io', 'https://node3.aiqnet.io',
      'https://node4.aiqnet.io', 'https://node5.aiqnet.io']);
    assert.equal(new NodeClient({ nodes: ['http://127.0.0.1:8001/'] }).nodes[0], 'http://127.0.0.1:8001');
  });

  it('reads an account exactly, sending no Origin', async () => {
    const node = await serve((r) => (r.path === `/api/v1/account/${RECORDED}` ? { json: fixture('account.json') } : undefined));
    const client = new NodeClient({ nodes: [node.url] });
    assert.deepEqual(await client.getAccount(RECORDED), {
      address: RECORDED, balanceNano: '2909459674650000', nonce: '2', hasPublicKey: true, isContract: false, contractType: null,
    });
    assert.equal(await client.nextNonce(RECORDED), '3');
    assert.equal(node.requests[0].headers.origin, undefined);
  });

  it('keeps a balance above 2^53 exact and refuses a repeated key', async () => {
    const big = fixture('account.json').replace('"balance":2909459674650000', '"balance":18446744073709551615');
    const node = await serve(() => ({ json: big }));
    assert.equal((await new NodeClient({ nodes: [node.url] }).getAccount(RECORDED)).balanceNano, '18446744073709551615');
    const twice = await serve(() => ({ json: fixture('account.json').replace('"nonce":2', '"nonce":2,"nonce":9') }));
    assert.equal(await refusal(new NodeClient({ nodes: [twice.url] }).getAccount(RECORDED)), 'INVALID_RESPONSE');
  });

  it('moves to the next node when one is rate-limited or down', async () => {
    const limited = await serve(() => ({ json: { success: false, error: 'Rate limit exceeded', retry_after_seconds: 30, message: 'x' } }));
    const good = await serve(() => ({ json: fixture('account.json') }));
    const client = new NodeClient({ nodes: [await closedPort(), limited.url, good.url] });
    assert.equal((await client.getAccount(RECORDED)).nonce, '2');
    assert.equal(limited.requests.length, 1);
    const onlyLimited = new NodeClient({ nodes: [limited.url] });
    const error = await onlyLimited.getAccount(RECORDED).catch((e) => e);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryAfterSeconds, 30);
  });

  it('folds a recorded balance proof and then asks the committee lineage for its checkpoint', async () => {
    const node = await serve((r) => {
      if (r.path.endsWith('/balance/proof')) return { json: fixture('balproof.json') };
      if (r.path === '/api/v1/height') return { json: fixture('height.json') };
      return undefined;
    });
    const client = new NodeClient({ nodes: [node.url] });
    const v = await client.getVerifiedAccount(RECORDED);
    assert.equal(v.balanceNano, '2909459674650000');
    assert.equal(v.nonce, '2');
    assert.equal(v.blockHeight, 2210909);
    // The recorded tip is below the proof's height (recorded a moment earlier): not behind at all.
    assert.deepEqual([v.tipHeight, v.behindBlocks], [2210863, 0]);
    assert.equal(v.proofFolds, true);
    // The mock serves no macroblock proofs, so the checkpoint cannot be verified.
    assert.equal(v.verified, false);
    assert.ok(node.requests.some((r) => /^\/api\/v1\/macroblock\/\d+\/proof$/.test(r.path)));

    const forged = await serve(() => ({ json: fixture('balproof.json').replace('"balance":2909459674650000', '"balance":2909459674650001') }));
    const f = await new NodeClient({ nodes: [forged.url] }).getVerifiedAccount(RECORDED);
    assert.equal(f.proofFolds, false);
    assert.equal(f.verified, false);
    assert.ok(!forged.requests.some((r) => r.path.includes('macroblock')));
  });

  // DEV-R2-07: a verified balance is the account's as of the proof's height. A node that kept an old state can prove
  // a balance since spent, so a proof far below the tip the other nodes report is never verified.
  it('never verifies a proof far below the chain\'s tip, nor one whose age no node can tell', async () => {
    const PROVED = 2210909;
    const prover = await serve((r) => {
      if (r.path.endsWith('/balance/proof')) return { json: fixture('balproof.json') };
      if (r.path === '/api/v1/height') return { json: { blocks_behind: 0, height: PROVED, is_syncing: false, network_height: PROVED } };
      return undefined;
    });
    const tipAt = (height) => serve((r) => (r.path === '/api/v1/height'
      ? { json: { blocks_behind: 0, height, is_syncing: false, network_height: height } } : undefined));
    const walked = (...nodes) => nodes.some((n) => n.requests.some((r) => r.path.includes('macroblock')));

    // Three other nodes at the tip, one lying low: the upper median says the proof is 1,000 blocks old.
    const ahead = [await tipAt(PROVED + 1000), await tipAt(PROVED + 1000), await tipAt(PROVED + 1001), await tipAt(PROVED)];
    const stale = await new NodeClient({ nodes: [prover.url, ...ahead.map((n) => n.url)], archive: null }).getVerifiedAccount(RECORDED);
    assert.deepEqual([stale.proofFolds, stale.tipHeight, stale.behindBlocks, stale.verified], [true, PROVED + 1000, 1000, false]);
    assert.equal(walked(prover, ...ahead), false);
    // The prover's own tip does not count while other nodes answer.
    assert.equal(prover.requests.filter((r) => r.path === '/api/v1/height').length, 0);

    // Within the allowance the light client is asked; a caller may narrow the allowance.
    const near = await tipAt(PROVED + 100);
    const fresh = await new NodeClient({ nodes: [prover.url, near.url], archive: null }).getVerifiedAccount(RECORDED);
    assert.deepEqual([fresh.tipHeight, fresh.behindBlocks], [PROVED + 100, 100]);
    assert.equal(walked(prover, near), true);
    const strict = await new NodeClient({ nodes: [prover.url, (await tipAt(PROVED + 100)).url], archive: null })
      .getVerifiedAccount(RECORDED, { maxAgeBlocks: 50 });
    assert.equal(strict.verified, false);

    // No node tells the tip: the age is unknown and nothing is verified.
    const mute = await serve((r) => (r.path.endsWith('/balance/proof') ? { json: fixture('balproof.json') } : undefined));
    const unknown = await new NodeClient({ nodes: [mute.url], archive: null }).getVerifiedAccount(RECORDED);
    assert.deepEqual([unknown.tipHeight, unknown.behindBlocks, unknown.verified], [null, null, false]);
    assert.equal(walked(mute), false);
  });

  it('reads a token and a holder balance in the node handlers\' shape', async () => {
    // Shape of development/qnet-integration/src/rpc/misc_api.rs handle_token_info / handle_token_balance.
    const node = await serve((r) => {
      if (r.path === `/api/v1/token/${CONTRACT}`) {
        return { json: { success: true, source: 'blockchain_state', token: { contract_address: CONTRACT, standard: 'qrc20', name: 'Gold', symbol: 'GLD',
          decimals: 6, logo: '', total_supply: '340282366920938463463374607431768211455', total_minted: '1', total_burned: '0',
          deployer: V.wallet.address, deployed_at: '1790000000' } } };
      }
      if (r.path === `/api/v1/token/${CONTRACT}/balance/${RECORDED}`) {
        return { json: { success: true, contract_address: CONTRACT, holder_address: RECORDED, balance: '1500000', token_name: 'Gold',
          token_symbol: 'GLD', decimals: 6, source: 'blockchain_state' } };
      }
      return { json: { success: false, error: 'Token not found', contract_address: RECORDED } };
    });
    const client = new NodeClient({ nodes: [node.url] });
    const t = await client.getTokenInfo(CONTRACT);
    assert.equal(t.symbol, 'GLD');
    assert.equal(t.decimals, 6);
    assert.equal(t.totalSupply, '340282366920938463463374607431768211455');
    assert.equal(t.deployedAt, 1790000000);
    assert.equal(await client.getTokenBalance(CONTRACT, RECORDED), '1500000');
    assert.equal(await refusal(client.getTokenInfo(RECORDED)), 'NOT_FOUND');
  });

  it('asks for one log window at a time and reads its rows', async () => {
    const node = await serve((r) => {
      const from = Number(r.query.get('from'));
      const to = Math.min(Number(r.query.get('to') ?? from + 500), from + 500);
      return { json: { success: true, from, to, oldest_available: 2116800, pruned_below: from < 2116800 ? 2116800 : null, count: 1,
        logs: [{ height: from, tx_hash: 'ab'.repeat(32), contract: CONTRACT, data: '6869' }] } };
    });
    const page = await new NodeClient({ nodes: [node.url] }).getLogs({ contract: CONTRACT, from: 2200000, to: 2300000 });
    assert.equal(node.requests[0].query.get('to'), '2200500');
    assert.equal(page.to, 2200500);
    // One contract's page from a node that gives no index: the position in the block is not known from it.
    assert.deepEqual(page.logs, [{ height: 2200000, logIndex: null, txHash: 'ab'.repeat(32), contract: CONTRACT, data: '6869' }]);
    assert.equal(page.prunedBelow, null);
  });

  it('checks an event proof: bound to the event, folded to the window root', async () => {
    const txHash = 'cd'.repeat(32);
    const data = bytesToHex(utf8ToBytes('minted 7'));
    const leaf = logLeaf(txHash, 0, CONTRACT, hexToBytes(data));
    const blockRoot = bytesToHex(sha3_256(concatBytes(utf8ToBytes('log-leaf'), hexToBytes(leaf))));
    const logsRoot = bytesToHex(sha3_256(concatBytes(utf8ToBytes('logw-leaf'), hexToBytes(blockRoot))));
    const node = await serve(() => ({ json: { tx_hash: txHash, log_index: 0, window_start: 811, window_end: 900, block_index: 0, leaf,
      proof: [], block_root: blockRoot, window_proof: [], logs_root: logsRoot } }));
    const client = new NodeClient({ nodes: [node.url] });
    // Window 900 is below the release's trust anchor: consistent, not verifiable.
    assert.equal(await client.verifyLog({ txHash, logIndex: 0, contract: CONTRACT, data }), 'consistent');
    assert.equal(await client.verifyLog({ txHash, logIndex: 0, contract: CONTRACT, data: '00' }), 'rejected');
    assert.equal(await client.verifyLog({ txHash, logIndex: 1, contract: CONTRACT, data }), 'rejected');
    const none = await serve(() => ({ json: { error: 'window_not_finalized' } }));
    assert.equal(await new NodeClient({ nodes: [none.url] }).verifyLog({ txHash, logIndex: 0, contract: CONTRACT, data }), 'pending');
  });

  it('looks a transaction up on a node, then in the site archive', async () => {
    const hash = 'f7d6c1ea3936b29b399cdfcc3eaae2b68d78c54127ea775db430ece2f5ee2bea';
    const old = '78c7cfcee135653043853998ba5dac731b95fa0eab5d44edcacc46ebfa64bad9';
    const notFound = (h) => ({ json: { message: 'Transaction not found in blockchain or mempool', status: 'not_found', transaction: null, tx_hash: h } });
    const node = await serve((r) => (r.path === `/api/v1/transaction/${hash}` ? { json: fixture('tx.json') } : notFound(r.path.slice(-64))));
    // Shape of applications/qnet-explorer/frontend/src/app/api/tx/[hash]/route.ts: heights and nonces as text.
    const archive = await serve((r) => (r.path === `/api/tx/${old}`
      ? { json: { success: true, source: 'postgresql', data: { hash: old, type: 'Transfer', tx_type: 'Transfer', status: 'confirmed',
        block: '2068632', from: RECORDED, to: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', amount_raw: '100000000000000', nonce: '1' } } }
      : { json: { success: false } }));
    const client = new NodeClient({ nodes: [node.url], archive: archive.url });
    const t = await client.getTransaction(hash);
    assert.equal(t.status, 'in_block');
    assert.equal(t.blockHeight, 2208291);
    assert.equal(t.finality, 'FullyFinalized');
    assert.equal(t.txType, 'RewardDistribution');
    const a = await client.getTransaction(old);
    assert.deepEqual([a.status, a.blockHeight, a.source, a.nonce], ['in_block', 2068632, 'archive', '1']);
    assert.equal((await client.getTransaction('00'.repeat(32))).status, 'not_found');
  });

  it('submits the exact body and reads each route\'s answer', async () => {
    const t = signed('transfer');
    const d = signed('contractDeploy');
    const c = signed('contractCall');
    const node = await serve((r) => {
      if (r.path === '/api/v1/transaction') return { json: { success: true, tx_hash: '11'.repeat(32), message: 'Transaction submitted successfully' } };
      if (r.path === '/api/v1/contract/call') return { json: { success: true, tx_hash: '22'.repeat(32), contract_address: c.tx.contract, method: 'run', gas_limit: 150465 } };
      // Shape of handle_contract_deploy: no tx_hash.
      if (r.path === '/api/v1/contract/deploy') return { json: { success: true, contract_address: d.v.contractAddress, code_hash: d.v.codeHash, code_size: 8,
        gas_limit: 501180, deployer: V.wallet.address, message: 'Contract deployment submitted to mempool', security: { dilithium_verified: true } } };
      return undefined;
    });
    const client = new NodeClient({ nodes: [node.url] });
    assert.equal((await client.submit(t.tx, t.signature, t.publicKey)).txHash, '11'.repeat(32));
    assert.equal(node.requests.at(-1).body, t.v.requestJson);
    assert.equal(node.requests.at(-1).headers['content-type'], 'application/json');
    assert.equal((await client.submit(c.tx, c.signature, null)).txHash, '22'.repeat(32));
    assert.equal(node.requests.at(-1).body, c.v.requestJson);
    const dep = await client.submit(d.tx, d.signature, d.publicKey);
    assert.deepEqual([dep.txHash, dep.contractAddress], [null, d.v.contractAddress]);
    assert.equal(node.requests.at(-1).body, d.v.requestJson);
  });

  it('reports a node\'s refusal, its plain-text rejection, and a wrong contract address', async () => {
    const t = signed('transfer');
    const d = signed('contractDeploy');
    const refusing = await serve((r) => (r.path === '/api/v1/transaction'
      ? { json: { success: false, error: 'Transaction rejected', details: 'Invalid nonce: expected 3, got 1' } }
      : { json: { success: true, contract_address: RECORDED } }));
    const client = new NodeClient({ nodes: [refusing.url] });
    const e = await client.submit(t.tx, t.signature, t.publicKey).catch((x) => x);
    assert.equal(e.code, 'NODE_REJECTED');
    assert.match(e.reason, /Invalid nonce: expected 3, got 1/);
    // The node took the deploy but named another address: the deploy may still apply, so it is not a plain failure.
    assert.equal(await refusal(client.submit(d.tx, d.signature, d.publicKey)), 'SUBMIT_UNCERTAIN');
    const plain = await serve(() => ({ status: 400, text: 'Request body deserialize error: missing field `nonce`' }));
    const p = await new NodeClient({ nodes: [plain.url] }).submit(t.tx, t.signature, t.publicKey).catch((x) => x);
    assert.equal(p.code, 'NODE_REJECTED');
    assert.match(p.reason, /HTTP 400: Request body deserialize error/);
  });

  it('sends the same body to the next node when one cannot be reached', async () => {
    const t = signed('transfer');
    const good = await serve(() => ({ json: { success: true, tx_hash: '33'.repeat(32) } }));
    const r = await new NodeClient({ nodes: [await closedPort(), good.url] }).submit(t.tx, t.signature, t.publicKey);
    assert.equal(r.node, good.url);
    assert.equal(good.requests[0].body, t.v.requestJson);
  });

  // DEVP-R1-08: a kept-alive connection the node closed while the process was busy (the key file's Argon2) fails the
  // request that reuses it with a reset. The same body goes once more to the same node on a new connection; the first
  // attempt counts as one that may have arrived, so a refusal after it is not final.
  it('asks a node once more on a new connection when it reset the first one', async () => {
    const t = signed('transfer');
    const resetting = async (second) => {
      let posts = 0;
      let gets = 0;
      const bodies = [];
      const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (req.method === 'GET' && (gets += 1) === 1) return req.socket.destroy();
        if (req.method === 'POST') {
          posts += 1;
          bodies.push(Buffer.concat(chunks).toString('utf8'));
          if (posts === 1) return req.socket.destroy();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.method === 'POST' ? second : JSON.parse(fixture('account.json'))));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push({ close: () => new Promise((resolve) => server.close(resolve)) });
      return { url: `http://127.0.0.1:${server.address().port}`, posts: () => posts, gets: () => gets, bodies };
    };
    const taking = await resetting({ success: true, tx_hash: '55'.repeat(32) });
    const r = await new NodeClient({ nodes: [taking.url] }).submit(t.tx, t.signature, t.publicKey);
    assert.deepEqual([r.txHash, r.node, taking.posts()], ['55'.repeat(32), taking.url, 2]);
    assert.deepEqual(taking.bodies, [t.v.requestJson, t.v.requestJson]);
    // A read is repeated on a new connection too.
    assert.equal((await new NodeClient({ nodes: [taking.url] }).getAccount(RECORDED)).nonce, '2');
    assert.equal(taking.gets(), 2);
    const refusing = await resetting({ success: false, error: 'Transaction rejected', details: 'Invalid nonce: expected 3, got 2' });
    const unsure = await new NodeClient({ nodes: [refusing.url] }).submit(t.tx, t.signature, t.publicKey).catch((x) => x);
    assert.equal(unsure.code, 'SUBMIT_UNCERTAIN');
    assert.equal(refusing.posts(), 2);
  });

  // DEV-R1-02: a node that timed out may have taken the body, so a later node's refusal of the same nonce is not a
  // final failure: the first copy can still apply, and a caller that sends a new transaction would pay twice.
  it('does not call a refusal final once an earlier node may hold the body', async () => {
    const t = signed('transfer');
    const slow = await serve(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { json: { success: true, tx_hash: '44'.repeat(32) } };
    });
    const refusing = await serve(() => ({ json: { success: false, error: 'Transaction rejected', details: 'Invalid nonce: expected 3, got 2' } }));
    const unsure = await new NodeClient({ nodes: [slow.url, refusing.url], timeoutMs: 200 }).submit(t.tx, t.signature, t.publicKey).catch((x) => x);
    assert.equal(unsure.code, 'SUBMIT_UNCERTAIN');
    assert.match(unsure.reason, /Invalid nonce: expected 3, got 2/);
    assert.equal(slow.requests[0].body, t.v.requestJson);
    // Every node silent after taking the request: also open, not "no node answered".
    const silent = await new NodeClient({ nodes: [slow.url], timeoutMs: 200 }).submit(t.tx, t.signature, t.publicKey).catch((x) => x);
    assert.equal(silent.code, 'SUBMIT_UNCERTAIN');
    // A node answering 5xx may have taken it too.
    const failing = await serve(() => ({ status: 502, text: 'bad gateway' }));
    assert.equal(await refusal(new NodeClient({ nodes: [failing.url, refusing.url] }).submit(t.tx, t.signature, t.publicKey)), 'SUBMIT_UNCERTAIN');
    // A node never reached, or one that refused on its rate limit, holds nothing: the refusal is final.
    const limited = await serve(() => ({ json: { success: false, error: 'Rate limit exceeded', retry_after_seconds: 5 } }));
    assert.equal(await refusal(new NodeClient({ nodes: [await closedPort(), limited.url, refusing.url] }).submit(t.tx, t.signature, t.publicKey)),
      'NODE_REJECTED');
    // A node that took the body but gave no hash: sent, with no hash to name it by.
    const hashless = await serve(() => ({ json: { success: true, message: 'Transaction submitted successfully' } }));
    const r = await new NodeClient({ nodes: [hashless.url] }).submit(t.tx, t.signature, t.publicKey);
    assert.deepEqual([r.txHash, r.node], [null, hashless.url]);
  });

  // DEVP-R3-04: a refusal about the answering node (busy, behind, the recipient unreadable, its own gas floor, an elided
  // key it cannot resolve yet) comes before its pool takes the body: the next node is asked, and a node that cannot
  // resolve the elided key gets the same transaction once more with the key. A refusal of the transaction stays final.
  it('asks the next node when one refuses for a reason of its own, and attaches the key on pk_unresolved', async () => {
    const t = signed('transfer'); // nonce 1, the key attached
    const c = signed('contractCall'); // nonce 4, the key elided
    const elided = sdk.requestBody(c.tx, c.signature, null);
    const withKey = sdk.requestBody(c.tx, c.signature, c.publicKey);
    assert.equal(elided, c.v.requestJson);
    const taking = () => serve(() => ({ json: { success: true, tx_hash: '66'.repeat(32) } }));
    const door = (answer) => serve(() => ({ json: { success: false, ...answer } }));
    const mempool = (text, error = 'Failed to submit contract call') => ({ error, details: `ValidationError("${text}")` });
    const PK = mempool('[REJECT][AUTH] pk_unresolved: include dilithium_public_key on the first-use TX');

    // The elided key, unresolved by a node a block behind: the same call again, to that node, with the key.
    let calls = 0;
    const behindOnKey = await serve((r) => {
      calls += 1;
      return { json: JSON.parse(r.body).dilithium_public_key ? { success: true, tx_hash: '77'.repeat(32) } : { success: false, ...PK } };
    });
    const again = await new NodeClient({ nodes: [behindOnKey.url] }).submit(c.tx, c.signature, null, { publicKeyIfUnresolved: c.publicKey });
    assert.deepEqual([again.txHash, calls], ['77'.repeat(32), 2]);
    assert.deepEqual(behindOnKey.requests.map((r) => r.body), [elided, withKey]);
    // Without the key on hand, the next node, which holds it, takes the elided body.
    const holder = await taking();
    const next = await new NodeClient({ nodes: [(await door(PK)).url, holder.url] }).submit(c.tx, c.signature, null);
    assert.equal(next.node, holder.url);
    assert.equal(holder.requests[0].body, elided);
    // A node that answers pk_unresolved to the body with the key too: the next node gets the key as well.
    const stubborn = await door(PK);
    const after = await taking();
    await new NodeClient({ nodes: [stubborn.url, after.url] }).submit(c.tx, c.signature, null, { publicKeyIfUnresolved: c.publicKey });
    assert.deepEqual([stubborn.requests.length, after.requests[0].body], [2, withKey]);

    // Busy, the recipient unreadable, its own pool's gas floor, its state behind the nonce: the next node.
    for (const [tx, answer] of [
      [t, { error: 'Server busy: too many concurrent signature verifications', details: 'verify capacity reached; retry shortly' }],
      [c, mempool('verify_overloaded')],
      [t, { error: 'Recipient account could not be read', code: 'recipient_unreadable', details: `this node could not read the account ${t.tx.to}; ask again or ask another node`, recipient: t.tx.to }],
      [c, mempool('gas_price 10 below current floor 20 (rises with mempool backlog)')],
      [c, mempool('Invalid nonce: expected 3, got 4 (anti-replay protection)')],
      [c, mempool('Invalid nonce for new account: expected 1, got 4')],
    ]) {
      const good = await taking();
      const r = await new NodeClient({ nodes: [(await door(answer)).url, good.url] }).submit(tx.tx, tx.signature, tx === t ? t.publicKey : null);
      assert.equal(r.node, good.url, JSON.stringify(answer));
    }
    // Every node refusing for its own reasons: NODE_REJECTED with the last reason, SUBMIT_UNCERTAIN once one may hold it.
    const busy = await door({ error: 'Server busy: too many concurrent signature verifications', details: 'verify capacity reached; retry shortly' });
    const all = await new NodeClient({ nodes: [busy.url, busy.url] }).submit(t.tx, t.signature, t.publicKey).catch((x) => x);
    assert.equal(all.code, 'NODE_REJECTED');
    assert.match(all.reason, /^Server busy/);
    const slow = await serve(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { json: { success: true, tx_hash: '44'.repeat(32) } };
    });
    assert.equal(await refusal(new NodeClient({ nodes: [slow.url, busy.url], timeoutMs: 200 }).submit(t.tx, t.signature, t.publicKey)),
      'SUBMIT_UNCERTAIN');

    // Refusals of the transaction itself are final: a used nonce, a nonce not the one sent, the balance, a contract
    // recipient (whose code the reason names), a bad signature.
    for (const [tx, answer, shown] of [
      [c, mempool('Invalid nonce: expected 5, got 4 (anti-replay protection)'), /expected 5, got 4/],
      [c, mempool('Invalid nonce: expected 3, got 2 (anti-replay protection)'), /expected 3, got 2/],
      [c, mempool('Insufficient balance: have 1, need 2'), /Insufficient balance/],
      [t, { error: 'Recipient is a contract account', code: 'recipient_is_contract', details: `${t.tx.to} is a contract account: a contract holds no key and cannot send QNC or a built-in token, so value sent to it can never move again`, recipient: t.tx.to }, /can never move again \(recipient_is_contract\)$/],
      [t, { error: 'Dilithium signature verification failed', details: 'ML-DSA-65 signature does not match the transaction data or the bound key' }, /verification failed/],
    ]) {
      const unused = await taking();
      const e = await new NodeClient({ nodes: [(await door(answer)).url, unused.url] }).submit(tx.tx, tx.signature, tx === t ? t.publicKey : null)
        .catch((x) => x);
      assert.equal(e.code, 'NODE_REJECTED', JSON.stringify(answer));
      assert.match(e.reason, shown);
      assert.equal(unused.requests.length, 0);
    }
  });

  it('waits for the nonce, and tells a transaction a block refused', async () => {
    let nonce = 2;
    const account = () => fixture('account.json').replace('"nonce":2', `"nonce":${nonce}`);
    const node = await serve((r) => {
      if (r.path.startsWith('/api/v1/account/')) return { json: account() };
      if (r.path === '/api/v1/height') return { json: { blocks_behind: 0, height: 2208300, is_syncing: false, network_height: 2208300 } };
      if (r.path.startsWith('/api/v1/transaction/')) return { json: fixture('tx.json') };
      return undefined;
    });
    const client = new NodeClient({ nodes: [node.url] });
    setTimeout(() => { nonce = 3; }, 150);
    assert.equal((await client.waitForTransaction({ from: RECORDED, nonce: '3' }, { intervalMs: 50, timeoutMs: 5000 })).state, 'applied');
    const refused = await client.waitForTransaction({ from: RECORDED, nonce: '4', txHash: 'f7'.repeat(32) }, { intervalMs: 50, timeoutMs: 5000 });
    assert.deepEqual([refused.state, refused.blockHeight], ['not_applied', 2208291]);
    const late = await client.waitForTransaction({ from: RECORDED, nonce: '9' }, { intervalMs: 50, timeoutMs: 200 });
    assert.equal(late.state, 'timeout');
  });

  // DEV-R1-03: 'not_applied' tells the user nothing was charged, so it rests on one node's own three facts (the block,
  // a tip above it, the nonce one below), on two nodes; a node that answers a default account never decides it.
  it('says not applied only when two nodes each see the block settled and the nonce one below', async () => {
    const txHash = 'f7'.repeat(32);
    // A node's view: its account nonce, its tip, and whether it holds the transaction in block 2208291.
    const nodeView = ({ nonce, tip = 2208300, holds = true }) => serve((r) => {
      if (r.path.startsWith('/api/v1/account/')) return { json: fixture('account.json').replace('"nonce":2', `"nonce":${nonce}`) };
      if (r.path === '/api/v1/height') return { json: { blocks_behind: 0, height: tip, is_syncing: false, network_height: tip } };
      if (r.path === `/api/v1/transaction/${txHash}`) {
        return holds ? { json: fixture('tx.json') }
          : { json: { message: 'Transaction not found in blockchain or mempool', status: 'not_found', transaction: null, tx_hash: txHash } };
      }
      return undefined;
    });
    // Applied at nonce 3 on the up-to-date node; the other two answer a default account (nonce 0) for the sender.
    const good = await nodeView({ nonce: 3 });
    const broken = [await nodeView({ nonce: 0 }), await nodeView({ nonce: 0 })];
    const mixed = new NodeClient({ nodes: [broken[0].url, good.url, broken[1].url], archive: null });
    const applied = await mixed.waitForTransaction({ from: RECORDED, nonce: '3', txHash }, { intervalMs: 20, timeoutMs: 3000 });
    assert.equal(applied.state, 'applied');
    // Only default accounts and one node behind the block: never 'not_applied'.
    const behind = await nodeView({ nonce: 2, tip: 2208292 });
    const unsure = new NodeClient({ nodes: [broken[0].url, behind.url, broken[1].url], archive: null });
    assert.equal((await unsure.waitForTransaction({ from: RECORDED, nonce: '3', txHash }, { intervalMs: 20, timeoutMs: 400 })).state, 'timeout');
    // One node with the nonce one below is not enough while two are configured ...
    const stale = await nodeView({ nonce: 2 });
    const one = new NodeClient({ nodes: [stale.url, broken[0].url], archive: null });
    assert.equal((await one.waitForTransaction({ from: RECORDED, nonce: '3', txHash }, { intervalMs: 20, timeoutMs: 400 })).state, 'timeout');
    // ... two are.
    const two = new NodeClient({ nodes: [stale.url, broken[0].url, (await nodeView({ nonce: 2 })).url], archive: null });
    const refused = await two.waitForTransaction({ from: RECORDED, nonce: '3', txHash }, { intervalMs: 20, timeoutMs: 3000 });
    assert.deepEqual([refused.state, refused.blockHeight], ['not_applied', 2208291]);
  });

  // DEV-R2-05: a node answers the same default account for a missing row and a failed storage read (handle_account_info),
  // so nonce 0 cannot say that an account's first transaction did not apply.
  it('never says not applied for a first transaction, whose unused nonce reads like a failed read', async () => {
    const txHash = 'f7'.repeat(32);
    const defaultAccount = { address: RECORDED, balance: 0, nonce: 0, is_node: false, node_type: null, has_dilithium_pk: false, reputation: 0.0 };
    const view = (account) => serve((r) => {
      if (r.path.startsWith('/api/v1/account/')) return { json: account };
      if (r.path === '/api/v1/height') return { json: { blocks_behind: 0, height: 2208300, is_syncing: false, network_height: 2208300 } };
      if (r.path === `/api/v1/transaction/${txHash}`) return { json: fixture('tx.json') };
      return undefined;
    });
    const failing = [await view(defaultAccount), await view(defaultAccount)];
    const first = new NodeClient({ nodes: failing.map((n) => n.url), archive: null });
    const r = await first.waitForTransaction({ from: RECORDED, nonce: '1', txHash }, { intervalMs: 20, timeoutMs: 400 });
    assert.deepEqual([r.state, r.blockHeight], ['timeout', 2208291]);
    // A real row with nonce 0 gets the same answer, and a first transaction that applied still reads as applied.
    const stored = await view(JSON.parse(fixture('account.json').replace('"nonce":2', '"nonce":0')));
    const single = new NodeClient({ nodes: [stored.url], archive: null });
    assert.equal((await single.waitForTransaction({ from: RECORDED, nonce: '1', txHash }, { intervalMs: 20, timeoutMs: 300 })).state, 'timeout');
    const applied = await view(JSON.parse(fixture('account.json').replace('"nonce":2', '"nonce":1')));
    assert.equal((await new NodeClient({ nodes: [applied.url, failing[0].url], archive: null })
      .waitForTransaction({ from: RECORDED, nonce: '1', txHash }, { intervalMs: 20, timeoutMs: 3000 })).state, 'applied');
  });

  // DEV-R1-05: a token's decimals scale a send, so they come from two nodes that agree.
  it('takes a token description for a send only when two nodes agree', async () => {
    const answer = (decimals, symbol = 'GLD') => ({ json: { success: true, source: 'blockchain_state', token: { contract_address: CONTRACT,
      standard: 'qrc20', name: 'Gold', symbol, decimals, logo: '', total_supply: '1000', total_minted: '1000', total_burned: '0',
      deployer: V.wallet.address, deployed_at: '1' } } });
    const six = [await serve(() => answer(6)), await serve(() => answer(6))];
    const liar = await serve(() => answer(12));
    const agreed = await new NodeClient({ nodes: [liar.url, six[0].url, six[1].url] }).getAgreedTokenInfo(CONTRACT);
    assert.equal(agreed.decimals, 6);
    assert.equal(await refusal(new NodeClient({ nodes: [liar.url, six[0].url] }).getAgreedTokenInfo(CONTRACT)), 'NODES_DISAGREE');
    const renamed = await serve(() => answer(6, 'GOLD'));
    assert.equal(await refusal(new NodeClient({ nodes: [renamed.url, six[0].url] }).getAgreedTokenInfo(CONTRACT)), 'NODES_DISAGREE');
    assert.equal((await new NodeClient({ nodes: [liar.url] }).getAgreedTokenInfo(CONTRACT)).decimals, 12, 'the only node configured');
    const none = await serve(() => ({ json: { success: false, error: 'Token not found', contract_address: CONTRACT } }));
    assert.equal(await refusal(new NodeClient({ nodes: [none.url, none.url] }).getAgreedTokenInfo(CONTRACT)), 'NOT_FOUND');
    assert.equal(await refusal(new NodeClient({ nodes: [await closedPort(), six[0].url] }).getAgreedTokenInfo(CONTRACT)), 'NODE_UNAVAILABLE');
  });

  // DEV-R1-06: a log proof names the event's position among all events of its block; getLogs gives it where it can,
  // and verifyLog finds it from the height where the page could not.
  it('gives each event its position in the block, and finds it from the height when a filtered page lacks it', async () => {
    const txHash = 'cd'.repeat(32);
    const otherTx = 'ab'.repeat(32);
    const other = sdk.deriveContractAddress(V.wallet.address, 99);
    const data = bytesToHex(utf8ToBytes('minted 7'));
    // Block 900 holds another contract's event first, then this one's: its index in the block is 1.
    const rows = [{ height: 900, tx_hash: otherTx, contract: other, data: '00' }, { height: 900, tx_hash: txHash, contract: CONTRACT, data }];
    const leaf = logLeaf(txHash, 1, CONTRACT, hexToBytes(data));
    const blockRoot = bytesToHex(sha3_256(concatBytes(utf8ToBytes('log-leaf'), hexToBytes(leaf))));
    const logsRoot = bytesToHex(sha3_256(concatBytes(utf8ToBytes('logw-leaf'), hexToBytes(blockRoot))));
    const node = await serve((r) => {
      if (r.path === '/api/v1/logs') {
        const filter = r.query.get('contract');
        const logs = rows.filter((x) => !filter || x.contract === filter);
        return { json: { success: true, from: 900, to: 900, oldest_available: 0, pruned_below: null, count: logs.length, logs } };
      }
      if (r.path === '/api/v1/logs/proof') {
        if (r.query.get('log_index') !== '1') return { json: { error: 'Log not found in window', window_start: 811, window_end: 900 } };
        return { json: { tx_hash: txHash, log_index: 1, window_start: 811, window_end: 900, block_index: 89, leaf, proof: [], block_root: blockRoot,
          window_proof: [], logs_root: logsRoot } };
      }
      return undefined;
    });
    const client = new NodeClient({ nodes: [node.url] });
    const all = await client.getLogs({ from: 900, to: 900 });
    assert.deepEqual(all.logs.map((l) => l.logIndex), [0, 1]);
    const mine = await client.getLogs({ contract: CONTRACT, from: 900, to: 900 });
    assert.deepEqual(mine.logs.map((l) => [l.txHash, l.logIndex]), [[txHash, null]]);
    // Index 0 (the position within the transaction) is another event's leaf: never a match.
    assert.equal(await client.verifyLog({ txHash, logIndex: 0, contract: CONTRACT, data }), 'pending');
    assert.equal(await client.verifyLog({ txHash, logIndex: 1, contract: CONTRACT, data }), 'consistent');
    assert.equal(await client.verifyLog({ ...mine.logs[0], height: 900 }), 'consistent');
    assert.equal(await refusal(client.verifyLog({ txHash, contract: CONTRACT, data })), 'INVALID_CALL');
    // A node that gives the index itself is taken at its word for the position (the proof still has to match).
    const indexed = await serve(() => ({ json: { success: true, from: 900, to: 900, oldest_available: 0, pruned_below: null, count: 1,
      logs: [{ ...rows[1], log_index: 1 }] } }));
    assert.equal((await new NodeClient({ nodes: [indexed.url] }).getLogs({ contract: CONTRACT, from: 900, to: 900 })).logs[0].logIndex, 1);
  });
});

// DEVP-R1-02: one light-client call walks at most 64 checkpoints. The client calls again while each call makes
// progress, bounded by time (not by a count of calls a pin a few days old already exceeds), keeps what was verified
// after every call, and reports how far the walk got. `anchored` is the client's private loop around the light client:
// the fake check below stands in for it, since real checkpoints need the committee's keys.
describe('walking the checkpoint lineage', () => {
  // A check that verifies up to 64 steps (every other macroblock) from `from` per call, true once it reaches `target`.
  const walker = (from, target, { onCall = () => {}, parity = target % 2 } = {}) => {
    let at = from - 2;
    let calls = 0;
    const check = async (hooks) => {
      calls += 1;
      onCall();
      for (let n = 0; n < 64 && at < target; n += 1) {
        at += 2;
        hooks.onProgress(at);
        hooks.onProgress(at + 1 - 2 * parity); // the other lineage's steps are not reported
      }
      return at >= target;
    };
    return { check, calls: () => calls };
  };

  it('keeps walking while each call makes progress, past the old limit of 16 calls', async () => {
    const saved = [];
    const seen = [];
    const client = new NodeClient({ nodes: ['http://127.0.0.1:9'], anchors: { load: () => null, save: (a) => saved.push(a) },
      onWalkProgress: (p) => seen.push(p) });
    const target = 24562 + 2 * (64 * 40 - 1); // a pin about 5 days old: 2,560 steps, 40 calls of 64
    const w = walker(24562, target);
    assert.equal(await client['anchored'](target, w.check), true);
    assert.equal(w.calls(), 40);
    assert.equal(saved.length, 40);
    assert.deepEqual(seen.at(-1), { verified: target, target });
    assert.ok(seen.every((p, i) => p.verified % 2 === target % 2 && (i === 0 || p.verified > seen[i - 1].verified)));
    assert.equal(DEFAULT_WALK_TIME_MS, 300_000);
  });

  it('stops when the walk time is spent or a call makes no progress, and keeps what it verified', async () => {
    const saved = [];
    const client = new NodeClient({ nodes: ['http://127.0.0.1:9'], walkTimeMs: 120, anchors: { load: () => null, save: (a) => saved.push(a) } });
    const target = 30001;
    // Each call takes 50 ms of a clock the test turns: the calls at 0, 50 and 100 ms start inside 120 ms, none after.
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      const slow = walker(24563, target, { onCall: () => { clock += 50; } });
      assert.equal(await client['anchored'](target, slow.check), false);
      assert.equal(slow.calls(), 3);
      assert.equal(saved.length, 3);
    } finally {
      Date.now = realNow;
    }
    let calls = 0;
    const stuck = async () => {
      calls += 1;
      return false;
    };
    assert.equal(await new NodeClient({ nodes: ['http://127.0.0.1:9'] })['anchored'](100, stuck), false);
    assert.equal(calls, 1);
    const once = walker(24562, 40000);
    assert.equal(await new NodeClient({ nodes: ['http://127.0.0.1:9'], walkTimeMs: 0 })['anchored'](40000, once.check), false);
    assert.equal(once.calls(), 1);
    // A proven forgery is final: no second call.
    let mismatches = 0;
    const forged = async (hooks) => {
      mismatches += 1;
      hooks.onProgress(24564);
      return 'mismatch';
    };
    assert.equal(await new NodeClient({ nodes: ['http://127.0.0.1:9'] })['anchored'](24564, forged), 'mismatch');
    assert.equal(mismatches, 1);
    for (const bad of [-1, Number.NaN, '5']) {
      assert.equal(await refusal((async () => new NodeClient({ nodes: ['http://127.0.0.1:9'], walkTimeMs: bad }))()), 'INVALID_INTEGER');
    }
  });
});

// DEVP-R2-01, DEVP-R2-03: the checkpoints kept between reads, with real checkpoints (a lineage a test committee
// signed, above a kept checkpoint the anchors store hands the client). Each run is a process of its own, as a
// restarted server or the next command is. A walk verifies a checkpoint on every other macroblock (one parity chain).
describe('the checkpoints kept between processes', () => {
  const DIST_NODE = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/node.js')).href;
  const READER = `
    import { readFileSync, writeFileSync } from 'node:fs';
    const [sdk, node, file, reads] = process.argv.slice(2);
    const { NodeClient } = await import(sdk);
    const anchors = {
      load: () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } },
      save: (a) => writeFileSync(file, JSON.stringify(a)),
    };
    const client = new NodeClient({ nodes: [node], archive: null, anchors, walkTimeMs: 600000 });
    const out = [];
    for (const e of JSON.parse(reads)) {
      await fetch(node + '/mark');
      // An array is a group of reads started together (Promise.all), as a server checks two players at once.
      out.push(Array.isArray(e) ? await Promise.all(e.map((one) => client.verifyLog(one))) : await client.verifyLog(e));
    }
    console.log('RESULT ' + JSON.stringify(out));
  `;

  // Runs the reads in a new process; returns each read's result and the macroblock proofs it asked for.
  async function readInNewProcess(node, file, events) {
    const dir = await tempHome();
    const script = path.join(dir, 'reader.mjs');
    writeFileSync(script, READER);
    const from = node.requests.length;
    const strip = ({ txHash, logIndex, contract, data }) => ({ txHash, logIndex, contract, data });
    const reads = JSON.stringify(events.map((e) => (Array.isArray(e) ? e.map(strip) : strip(e))));
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, [script, DIST_NODE, node.url, file, reads], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
        (error, out, err) => (error ? reject(new Error(`${error.message} ${err}`)) : resolve(out)));
    });
    const results = JSON.parse(stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT ')).slice('RESULT '.length));
    const asked = [];
    for (const r of node.requests.slice(from)) {
      if (r.path === '/mark') asked.push([]);
      const m = /^\/api\/v1\/macroblock\/(\d+)\/proof$/.exec(r.path);
      if (m) asked.at(-1).push(Number(m[1]));
    }
    return { results, asked };
  }

  it('goes on from the kept ladder: the same checkpoint in one step, an older one within a band, never from the anchor', async () => {
    const L = await testLineage();
    const B = L.base;
    const node = await serve((r) => (r.path === '/mark' ? { json: {} } : L.route(r)));
    const file = path.join(await tempHome(), 'anchors.json');
    writeFileSync(file, JSON.stringify(L.anchor(B)));
    const T = B + 280; // 140 steps up from the kept checkpoint: more than one light-client call walks (64)
    const older = B + 150;
    const middle = B + 222;

    // First process: the walk to T, then an event of an older window.
    const first = await readInNewProcess(node, file, [L.event(T), L.event(older)]);
    assert.deepEqual(first.results, ['verified', 'verified']);
    assert.equal(first.asked[0].length, 140);
    assert.equal(new Set(first.asked[0]).size, 140, 'no step walked twice, also across the memory trade');
    assert.deepEqual([Math.min(...first.asked[0]), Math.max(...first.asked[0])], [B + 2, T]);
    // DEVP-R2-03: the light client does not keep every checkpoint of the walk (older was one of them): the client traded
    // its memory for the ladder, and the older window is walked again from the rung below it, at most about a band.
    assert.ok(first.asked[1].length >= 1 && first.asked[1].length <= 33, `older window: ${first.asked[1].length} steps`);
    assert.equal(Math.max(...first.asked[1]), older);

    // The ladder: one parity chain, the two newest, one rung per band of 64 macroblocks.
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    const rungs = Object.keys(kept).map(Number);
    assert.ok(rungs.every((j) => j % 2 === B % 2));
    assert.ok(rungs.includes(T) && rungs.includes(T - 2));
    assert.equal(LADDER_BAND, 64);
    assert.ok(rungs.length <= 2 + Math.ceil(280 / LADDER_BAND) + 1, rungs.join(','));

    // Second process, from the file alone: T again (the old export kept only T, so this walked from the release's
    // anchor), then a window between.
    const second = await readInNewProcess(node, file, [L.event(T), L.event(middle)]);
    assert.deepEqual(second.results, ['verified', 'verified']);
    assert.deepEqual(second.asked[0], [T]);
    assert.ok(second.asked[1].length >= 1 && second.asked[1].length <= 33, `middle window: ${second.asked[1].length} steps`);
    assert.ok(Math.min(...second.asked[1]) > B + 2);
    assert.equal(Math.max(...second.asked[1]), middle);
  });

  // DEVP-R3-01: the light client walks one parity chain at a time, and a read that finds a walk running waits for that
  // call only. It went on only when its own hook fired, which never happens while it waits, so it gave up after the
  // other read's first call of 64 steps and answered unverified.
  it('two reads at once on one parity chain, more than one call up: both verified, each step walked once', async () => {
    const L = await testLineage();
    const B = L.base;
    const node = await serve((r) => (r.path === '/mark' ? { json: {} } : L.route(r)));
    const file = path.join(await tempHome(), 'anchors.json');
    writeFileSync(file, JSON.stringify(L.anchor(B)));
    const T = B + 280; // 140 steps up: three light-client calls
    const run = await readInNewProcess(node, file, [[L.event(T), L.event(T - 2)], [L.event(T - 4), L.event(T)]]);
    assert.deepEqual(run.results, [['verified', 'verified'], ['verified', 'verified']]);
    assert.equal(run.asked[0].length, 140);
    assert.equal(new Set(run.asked[0]).size, 140, 'one walk for both reads');
    // After the walk the client traded the light client's memory for the ladder: T-4 again from the rung below it,
    // T from the kept T-2, and nothing twice.
    assert.ok(run.asked[1].length >= 1 && run.asked[1].length <= 34, `second group: ${run.asked[1].length} steps`);
    assert.equal(new Set(run.asked[1]).size, run.asked[1].length);
    assert.ok(Math.max(...run.asked[1]) <= T && Math.min(...run.asked[1]) > B + 2);
  });
});
