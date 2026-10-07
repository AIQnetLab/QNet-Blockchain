// The built qnet command: argument checks, keys through standard input, the exact signed text of a dry run, and
// sends to a local mock node that checks each request the way a node does (recorded answers and handler shapes).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as sdk from '../dist/index.js';
import * as node from '../dist/node.js';
import { fixture, mockNode, runCli, STRONG_PASSWORD, template, tempHome, testLineage, V, vector, wasmModule, T } from './helpers.mjs';

const GOLDEN = V.wallet.address;
const RECORDED = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
const TOKEN = vector('tokenTransfer').input.token;
const UNUSED_NODE = ['--node', 'http://127.0.0.1:9'];
// DEVP-R1-08: a send to a mock node must not fail on the 10-second request timeout of a machine under load.
const SLOW = ['--timeout', '120'];
// Everything a run printed, for a failed assertion.
const said = (r) => `exit ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
let keyFile;
const servers = [];
const serve = async (route) => {
  const s = await mockNode(route);
  servers.push(s);
  return s;
};

before(async () => {
  const home = await tempHome();
  keyFile = (await node.createKey({ name: 'default', entropy: sdk.recoveryPhraseToEntropy(V.wallet.mnemonic), password: STRONG_PASSWORD },
    { home })).file;
});
after(() => Promise.all(servers.map((s) => s.close())));

async function homeWithKey() {
  const home = await tempHome();
  const dir = node.keystoreDir({ home });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await copyFile(keyFile, path.join(dir, 'default.json'));
  if (process.platform !== 'win32') await chmod(path.join(dir, 'default.json'), 0o600);
  return home;
}

// An account answer in the recorded shape with this nonce, balance and key state.
const accountAnswer = (address, { nonce, balance = 10_000_000_000, hasPk = true, contract = null }) => ({
  json: fixture('account.json')
    .replaceAll(RECORDED, address)
    .replace('"nonce":2', `"nonce":${nonce}`)
    .replace('"balance":2909459674650000', `"balance":${balance}`)
    .replace('"has_dilithium_pk":true', `"has_dilithium_pk":${hasPk}`)
    .replace('"is_contract":false', `"is_contract":${contract !== null}`)
    .replace('"contract_storage":{}', contract ? `"contract_storage":{"type":"${contract}"}` : '"contract_storage":{}'),
});
const HEIGHT = { json: { blocks_behind: 0, height: 2300000, is_syncing: false, network_height: 2300000 } };

describe('qnet arguments', () => {
  const usage = [
    [['bogus'], /unknown command: bogus/],
    [['transfer', '--to', RECORDED], /needs --to and --amount/],
    [['transfer', '--to', RECORDED, '--amount', '1', '--amount', '2'], /--amount is given twice/],
    [['transfer', '--to'], /--to needs a value/],
    [['transfer', '--to', RECORDED, '--amount', '1', '--foo'], /unknown option --foo/],
    [['transfer', '--to', 'abc', '--amount', '1'], /--to is not a QNet address/],
    [['balance', RECORDED, '--network', 'mainnet'], /unknown network "mainnet"/],
    [['balance', RECORDED, '--node', 'http://example.com'], /https/],
    [['call', TOKEN], /wrong number of arguments/],
    [['call', TOKEN, 'run', '--args', 'abc'], /even-length hex/],
    [['call', TOKEN, 'run', '--args', '00', '--args-utf8', 'x'], /--args or --args-utf8/],
    [['call', TOKEN, 'run', '--fuel', '1', '--gas-limit', '2'], /--fuel or --gas-limit/],
    [['transfer', '--to', sdk.CANONICAL_BURN_ADDRESS, '--amount', '1'], /burn address/],
    [['keys', 'new', '--words', '15'], /--words is 12 or 24/],
    [['tx', 'ABC'], /64 lowercase hex/],
    [['balance', RECORDED, '--timeout', '0'], /--timeout must be a whole number of at least 1/],
    [['balance', RECORDED, '--timeout', '601'], /--timeout is at most 600 seconds/],
  ];
  for (const [args, pattern] of usage) {
    it(`refuses ${args.join(' ')}`, async () => {
      const home = await tempHome();
      const r = await runCli([...args, '--home', home]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, pattern);
      assert.equal(r.stdout, '');
    });
  }

  it('refuses an amount past its precision, and a send with no key', async () => {
    const home = await homeWithKey();
    const r = await runCli(['transfer', '--to', RECORDED, '--amount', '1.0000000001', '--home', home, ...UNUSED_NODE]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /INVALID_AMOUNT/);
    const empty = await runCli(['keys', 'address', '--home', await tempHome()]);
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /no key yet/);
  });

  it('prints its version and help', async () => {
    assert.equal((await runCli(['--version'])).stdout.trim(), '2.0.0');
    const help = await runCli(['--help']);
    assert.match(help.stdout, /qnet: the QNet command line/);
    assert.match(help.stdout, /There is no QNC faucet/);
  });
});

describe('qnet keys', () => {
  it('imports a recovery phrase from standard input and never prints it', async () => {
    const home = await tempHome();
    const r = await runCli(['keys', 'import', '--home', home], { input: `${V.wallet.mnemonic}\n${STRONG_PASSWORD}\n` });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Key "default" stored: ${GOLDEN}`));
    for (const out of [r.stdout, r.stderr]) assert.doesNotMatch(out, /abandon|Wz9#qTr4/);
    assert.equal((await runCli(['keys', 'address', '--home', home])).stdout.trim(), GOLDEN);
    const pub = JSON.parse((await runCli(['keys', 'export-public', '--json', '--home', home])).stdout);
    assert.deepEqual(pub, { name: 'default', address: GOLDEN, publicKey: V.wallet.publicKey });
    const list = await runCli(['keys', 'list', '--home', home]);
    assert.match(list.stdout, new RegExp(`^default\\s+${GOLDEN}$`, 'm'));
    const again = await runCli(['keys', 'import', '--home', home], { input: `${V.wallet.mnemonic}\n${STRONG_PASSWORD}\n` });
    assert.equal(again.code, 1);
    assert.match(again.stderr, /KEY_EXISTS/);
    const bad = await runCli(['keys', 'import', '--name', 'bad', '--home', home], { input: `abandon abandon\n${STRONG_PASSWORD}\n` });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /INVALID_MNEMONIC/);
  });

  it('creates a key whose phrase exists nowhere else, and refuses a short password', async () => {
    const home = await tempHome();
    const weak = await runCli(['keys', 'new', '--home', home], { input: '1234567\n' });
    assert.equal(weak.code, 1);
    assert.match(weak.stderr, /WEAK_PASSWORD/);
    const r = await runCli(['keys', 'new', '--name', 'fresh', '--words', '12', '--json', '--home', home], { input: `${STRONG_PASSWORD}\n` });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(sdk.isValidAddress(out.address), true);
    const record = JSON.parse(await readFile(out.file, 'utf8'));
    assert.equal(record.address, out.address);
    assert.equal(Buffer.from(record.ciphertext, 'base64').length, 16 + 16);
  });
});

describe('qnet dry runs', () => {
  it('print the exact text a transfer signs, with no node contacted', async () => {
    const home = await homeWithKey();
    const v = vector('transfer');
    const r = await runCli(['transfer', '--to', v.input.to, '--amount', '1.5', '--nonce', '1', '--dry-run', '--home', home, ...UNUSED_NODE]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^${v.preimage.replace(/[|]/g, '\\|')}$`, 'm'));
    assert.match(r.stdout, /Fee at most:\s+0\.00015 QNC/);
  });

  it('print the exact text a contract call signs', async () => {
    const home = await homeWithKey();
    const v = vector('contractCall');
    const r = await runCli(['call', v.input.contract, 'run', '--args', '01020304', '--fuel', '50000', '--nonce', '4', '--dry-run', '--json',
      '--home', home, ...UNUSED_NODE]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.preimage, v.preimage);
    assert.equal(out.tx.callData, v.callData);
  });

  it('print the exact text a token transfer signs, with the token\'s decimals from a node', async () => {
    const home = await homeWithKey();
    const v = vector('tokenTransfer');
    const mock = await serve((r) => (r.path === `/api/v1/token/${TOKEN}`
      ? { json: { success: true, source: 'blockchain_state', token: { contract_address: TOKEN, standard: 'qrc20', name: 'Gold', symbol: 'GLD',
        decimals: 9, logo: '', total_supply: '5000000000000', total_minted: '5000000000000', total_burned: '0', deployer: GOLDEN, deployed_at: '1' } } }
      : undefined));
    const r = await runCli(['token', 'transfer', TOKEN, '--to', v.input.to, '--amount', '1', '--nonce', '2', '--dry-run', '--json',
      '--home', home, '--node', mock.url]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).preimage, v.preimage);
  });
});

describe('qnet against a mock node', () => {
  it('deploys a module: checked, signed, sent with the deploy gas, and the contract found', async () => {
    const home = await homeWithKey();
    const file = template('counter.wasm');
    const code = file ? new Uint8Array(await readFile(file)) : wasmModule();
    const moduleFile = file ?? path.join(home, 'contract.wasm');
    if (!file) await (await import('node:fs/promises')).writeFile(moduleFile, code);
    const contract = sdk.deriveContractAddress(GOLDEN, 5);
    let deployed = false;
    const seen = {};
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: deployed ? 5 : 4, hasPk: false });
      if (r.path === `/api/v1/account/${contract}`) return accountAnswer(contract, { nonce: 0, balance: 0, contract: deployed ? 'wasm' : null });
      if (r.path === '/api/v1/height') return HEIGHT;
      if (r.method === 'POST' && r.path === '/api/v1/contract/deploy') {
        // What a node checks: the body's fields, the module, the gas, and the signature over the rebuilt text.
        const body = JSON.parse(r.body);
        const bytes = new Uint8Array(Buffer.from(body.code, 'base64'));
        const gas = 500_000 + 10 * (2 * bytes.length + 102);
        const preimage = `q1337|contract_deploy:${body.from}:${bytesToHex(sha3_256(bytes))}:${body.nonce}:${body.gas_price}:${body.gas_limit}`;
        Object.assign(seen, { body, gas, ok: ml_dsa65.verify(hexToBytes(body.dilithium_signature), utf8ToBytes(preimage), hexToBytes(body.dilithium_public_key)) });
        deployed = true;
        // Shape of handle_contract_deploy (development/qnet-integration/src/rpc/contracts_api.rs).
        return { json: { success: true, contract_address: contract, code_hash: bytesToHex(sha3_256(bytes)), code_size: bytes.length, gas_limit: body.gas_limit,
          deployer: body.from, message: 'Contract deployment submitted to mempool', security: { dilithium_verified: true, quantum_secure: true } } };
      }
      return undefined;
    });
    const r = await runCli(['deploy', moduleFile, '--yes', '--home', home, '--node', mock.url, ...SLOW], { input: `${STRONG_PASSWORD}\n` });
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, new RegExp(`Deployed\\. Contract address: ${contract}`));
    assert.equal(seen.ok, true);
    assert.equal(Buffer.from(seen.body.code, 'base64').equals(Buffer.from(code)), true);
    assert.equal(seen.body.gas_limit, seen.gas);
    assert.deepEqual([seen.body.from, seen.body.nonce, seen.body.gas_price, seen.body.constructor_args], [GOLDEN, 5, 10, null]);
    assert.equal(seen.body.dilithium_public_key, V.wallet.publicKey);
    assert.ok(mock.requests.every((q) => q.headers.origin === undefined));
    if (file) assert.equal(seen.gas, 548_660);
  });

  it('refuses a module the deploy rules refuse, before anything is sent', async () => {
    const home = await homeWithKey();
    const bad = path.join(home, 'float.wasm');
    await (await import('node:fs/promises')).writeFile(bad, wasmModule({ locals: [[1, T.f64]] }));
    const mock = await serve(() => undefined);
    const r = await runCli(['deploy', bad, '--yes', '--home', home, '--node', mock.url]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /floating point/);
    assert.equal(mock.requests.length, 0);
  });

  // DEV-R2-04: export and import names are the module's own UTF-8 text; none reaches the terminal raw.
  it('escapes the names a module chose, in the module report and in its problems', async () => {
    const { writeFile } = await import('node:fs/promises');
    const home = await homeWithKey();
    const hidden = 'run\x1b[8mFee at most: 0 QNC';
    const good = path.join(home, 'named.wasm');
    await writeFile(good, wasmModule({ exports: [['memory', 0x02, 0], [hidden, 0x00, 0]] }));
    const check = await runCli(['check', good]);
    assert.equal(check.code, 0, check.stderr);
    assert.doesNotMatch(check.stdout, /\x1b/);
    assert.match(check.stdout, /Entries:\s+run\\u\{1b\}\[8mFee at most: 0 QNC/);
    const bad = path.join(home, 'bad-names.wasm');
    await writeFile(bad, wasmModule({
      types: [[[], []], [[T.i32], []]],
      imports: [['x\x1b[1A', 'y\u{2028}', [0x00, 0]]],
      funcs: [0, 1],
      exports: [['memory', 0x02, 0], ['run', 0x00, 1], ['arg\u{202e}', 0x00, 2]],
    }));
    const refused = await runCli(['check', bad]);
    assert.equal(refused.code, 1);
    assert.doesNotMatch(refused.stdout, /[\x1b\u{2028}\u{202e}]/u);
    assert.match(refused.stdout, /x\\u\{1b\}\[1A\.y\\u\{2028\}: host functions come from module "env" only/);
    assert.match(refused.stdout, /export "arg\\u\{202e\}" is \(i32\) -> \(\)/);
    const mock = await serve(() => undefined);
    const deploy = await runCli(['deploy', bad, '--yes', '--home', home, '--node', mock.url]);
    assert.equal(deploy.code, 1);
    assert.doesNotMatch(deploy.stderr, /[\x1b\u{2028}\u{202e}]/u);
    assert.match(deploy.stderr, /export "arg\\u\{202e\}"/);
    assert.equal(mock.requests.length, 0);
  });

  it('transfers without the public key once the chain holds it, and waits for the nonce', async () => {
    const home = await homeWithKey();
    let sent = null;
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: sent ? 2 : 1 });
      if (r.path === `/api/v1/account/${RECORDED}`) return { json: fixture('account.json') };
      if (r.method === 'POST' && r.path === '/api/v1/transaction') {
        sent = JSON.parse(r.body);
        return { json: { success: true, tx_hash: 'ab'.repeat(32), message: 'Transaction submitted successfully' } };
      }
      if (r.path === '/api/v1/height') return HEIGHT;
      return undefined;
    });
    const r = await runCli(['transfer', '--to', RECORDED, '--amount', '1.5', '--yes', '--home', home, '--node', mock.url, ...SLOW],
      { input: `${STRONG_PASSWORD}\n` });
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /Done: nonce 2 is applied/);
    assert.deepEqual(Object.keys(sent), ['from', 'to', 'amount', 'dilithium_signature', 'gas_price', 'gas_limit', 'nonce']);
    assert.deepEqual([sent.amount, sent.nonce, sent.gas_limit], [1_500_000_000, 2, 10_000]);
    const preimage = `q1337|transfer:${GOLDEN}:${RECORDED}:1500000000:2:10:10000`;
    assert.equal(ml_dsa65.verify(hexToBytes(sent.dilithium_signature), utf8ToBytes(preimage), hexToBytes(V.wallet.publicKey)), true);
  });

  // DEVP-R3-04: the key is elided once one node shows the chain holds it; a node a block behind cannot resolve it
  // (`pk_unresolved`) and gets the same transfer once more with the key, instead of the command failing.
  it('attaches the elided key for a node that cannot resolve it yet', async () => {
    const home = await homeWithKey();
    const bodies = [];
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: bodies.length === 2 ? 2 : 1 });
      if (r.path === `/api/v1/account/${RECORDED}`) return { json: fixture('account.json') };
      if (r.method === 'POST' && r.path === '/api/v1/transaction') {
        bodies.push(JSON.parse(r.body));
        return { json: bodies.length === 1
          ? { success: false, error: 'Failed to add transaction to mempool',
            details: 'ValidationError("[REJECT][AUTH] pk_unresolved: include dilithium_public_key on the first-use TX")' }
          : { success: true, tx_hash: 'ab'.repeat(32), message: 'Transaction submitted successfully' } };
      }
      if (r.path === '/api/v1/height') return HEIGHT;
      return undefined;
    });
    const r = await runCli(['transfer', '--to', RECORDED, '--amount', '1.5', '--yes', '--home', home, '--node', mock.url, ...SLOW],
      { input: `${STRONG_PASSWORD}\n` });
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /Done: nonce 2 is applied/);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].dilithium_public_key, undefined);
    assert.equal(bodies[1].dilithium_public_key, V.wallet.publicKey);
    assert.equal(bodies[1].dilithium_signature, bodies[0].dilithium_signature);
  });

  it('reports a node\'s refusal, too little QNC, a wrong password, and a send nobody confirmed', async () => {
    const home = await homeWithKey();
    let balance = 10_000_000_000;
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: 1, balance });
      if (r.path === `/api/v1/account/${RECORDED}`) return { json: fixture('account.json') };
      if (r.method === 'POST') return { json: { success: false, error: 'Transaction rejected', details: 'Invalid nonce: expected 3, got 2' } };
      return undefined;
    });
    const args = ['transfer', '--to', RECORDED, '--amount', '1', '--home', home, '--node', mock.url, ...SLOW];
    const refused = await runCli([...args, '--yes'], { input: `${STRONG_PASSWORD}\n` });
    assert.equal(refused.code, 1, said(refused));
    assert.match(refused.stderr, /Invalid nonce: expected 3, got 2 \[NODE_REJECTED\]/);
    const wrong = await runCli([...args, '--yes'], { input: 'not the password\n' });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /WRONG_PASSWORD/);
    const unconfirmed = await runCli(args, { input: `${STRONG_PASSWORD}\n` });
    assert.equal(unconfirmed.code, 2);
    assert.match(unconfirmed.stderr, /confirm with --yes/);
    balance = 1_000_000_000;
    const poor = await runCli([...args, '--yes'], { input: `${STRONG_PASSWORD}\n` });
    assert.equal(poor.code, 1);
    assert.match(poor.stderr, /holds 1 QNC; this needs up to 1\.00015 QNC \[INSUFFICIENT_FUNDS\]/);
    assert.equal(mock.requests.filter((q) => q.method === 'POST').length, 1);
  });

  it('reads events window by window', async () => {
    const mock = await serve((r) => {
      if (r.path !== '/api/v1/logs') return undefined;
      const from = Number(r.query.get('from'));
      const to = Math.min(Number(r.query.get('to')), from + 500);
      return { json: { success: true, from, to, oldest_available: 0, pruned_below: null, count: 1,
        logs: [{ height: from, tx_hash: 'ef'.repeat(32), contract: TOKEN, data: bytesToHex(utf8ToBytes(`at ${from}`)) }] } };
    });
    const r = await runCli(['logs', TOKEN, '--from', '1000', '--to', '2100', '--node', mock.url]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(mock.requests.map((q) => [q.query.get('from'), q.query.get('to'), q.query.get('contract')]),
      [['1000', '1500', TOKEN], ['1501', '2001', TOKEN], ['2002', '2100', TOKEN]]);
    assert.match(r.stdout, /^1501 {2}(ef){32} {2}[0-9a-f]+ {2}"at 1501"$/m);
    const tooWide = await runCli(['logs', TOKEN, '--from', '0', '--to', '20000', '--node', mock.url]);
    assert.equal(tooWide.code, 2);
  });

  // DEV-R1-02: no node confirmed the send and one may hold it: the command waits by nonce instead of reporting a
  // failure the user would answer with a second, new transaction.
  it('waits by nonce when no node confirmed a send one of them may hold', async () => {
    const home = await homeWithKey();
    let posts = 0;
    let applied = false;
    const route = (r) => {
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: applied ? 2 : 1 });
      if (r.path === `/api/v1/account/${RECORDED}`) return { json: fixture('account.json') };
      if (r.method === 'POST' && r.path === '/api/v1/transaction') {
        posts += 1;
        // The first node takes the body and fails before answering; the next refuses the nonce the first one used.
        if (posts === 1) {
          applied = true;
          return { status: 502, text: 'bad gateway' };
        }
        return { json: { success: false, error: 'Transaction rejected', details: 'Invalid nonce: expected 3, got 2' } };
      }
      if (r.path === '/api/v1/height') return HEIGHT;
      return undefined;
    };
    const [a, b] = [await serve(route), await serve(route)];
    const r = await runCli(['transfer', '--to', RECORDED, '--amount', '1', '--yes', '--home', home, '--node', a.url, '--node', b.url, ...SLOW],
      { input: `${STRONG_PASSWORD}\n` });
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /Not confirmed by any node, and one that gave no answer may have taken it \(.*Invalid nonce: expected 3, got 2\)/);
    assert.match(r.stdout, /Done: nonce 2 is applied\./);
    assert.doesNotMatch(r.stderr, /NODE_REJECTED/);
    assert.equal(posts, 2);
  });

  // DEV-R1-12: under --json a send that asks first still shows what it will sign, on standard error; standard output
  // stays for the result.
  it('shows the review on standard error under --json whenever it asks', async () => {
    const home = await homeWithKey();
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: 1 });
      if (r.path === `/api/v1/account/${RECORDED}`) return { json: fixture('account.json') };
      return undefined;
    });
    const t = await runCli(['transfer', '--to', RECORDED, '--amount', '1', '--json', '--home', home, '--node', mock.url, ...SLOW]);
    assert.equal(t.code, 2, said(t));
    assert.match(t.stderr, /To:\s+4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d/);
    assert.match(t.stderr, /Fee at most:\s+0\.00015 QNC/);
    assert.match(t.stderr, /confirm with --yes/);
    assert.equal(t.stdout, '');
  });

  // DEV-R1-07, DEV-R1-11: a pending transaction is not called included, and a node's text cannot drive the terminal.
  it('tells a pending transaction apart and escapes the text a node chose', async () => {
    const pendingTx = JSON.parse(fixture('tx.json'));
    pendingTx.transaction.status = 'pending';
    pendingTx.transaction.tx_type = 'Transfer\u001b[2K\u001b[1A';
    const hash = pendingTx.tx_hash;
    const mock = await serve((r) => {
      if (r.path === `/api/v1/transaction/${hash}`) return { json: pendingTx };
      if (r.path === `/api/v1/token/${TOKEN}`) {
        return { json: { success: true, source: 'blockchain_state', token: { contract_address: TOKEN, standard: 'qrc20', name: 'Gold\u001b[2K\u001b[1A‮',
          symbol: 'G\u0007LD', decimals: 2, logo: '', total_supply: '100', total_minted: '100', total_burned: '0', deployer: GOLDEN, deployed_at: '1' } } };
      }
      return undefined;
    });
    const tx = await runCli(['tx', hash, '--node', mock.url]);
    assert.equal(tx.code, 0, tx.stderr);
    assert.match(tx.stdout, /Status:\s+waiting for a block/);
    assert.match(tx.stdout, /No block holds it yet/);
    assert.doesNotMatch(tx.stdout, /A block holds it/);
    const token = await runCli(['token', 'info', TOKEN, '--node', mock.url]);
    assert.equal(token.code, 0, token.stderr);
    for (const out of [tx.stdout, token.stdout]) assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f‮]/);
    assert.match(token.stdout, /Gold\\u\{1b\}\[2K\\u\{1b\}\[1A\\u\{202e\} \(G\\u\{7\}LD\)/);
    assert.match(tx.stdout, /Type:\s+Transfer\\u\{1b\}\[2K/);
  });

  // DEV-R1-05: a token transfer takes its decimals only from nodes that agree, and names them with the base units.
  it('refuses a token transfer when the nodes disagree on the token, and shows the base units', async () => {
    const home = await homeWithKey();
    const tokenAnswer = (decimals) => ({ json: { success: true, source: 'blockchain_state', token: { contract_address: TOKEN, standard: 'qrc20',
      name: 'Gold', symbol: 'GLD', decimals, logo: '', total_supply: '5000000000000', total_minted: '5000000000000', total_burned: '0',
      deployer: GOLDEN, deployed_at: '1' } } });
    const nodeWith = (decimals) => serve((r) => {
      if (r.path === `/api/v1/token/${TOKEN}`) return tokenAnswer(decimals);
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: 1 });
      if (r.path === `/api/v1/account/${RECORDED}`) return { json: fixture('account.json') };
      if (r.path.startsWith(`/api/v1/token/${TOKEN}/balance/`)) {
        return { json: { success: true, contract_address: TOKEN, holder_address: RECORDED, balance: '0', decimals, source: 'blockchain_state' } };
      }
      return undefined;
    });
    const [six, twelve, alsoSix] = [await nodeWith(6), await nodeWith(12), await nodeWith(6)];
    const split = await runCli(['token', 'transfer', TOKEN, '--to', RECORDED, '--amount', '5', '--yes', '--home', home,
      '--node', six.url, '--node', twelve.url, ...SLOW], { input: `${STRONG_PASSWORD}\n` });
    assert.equal(split.code, 1, said(split));
    assert.match(split.stderr, /NODES_DISAGREE/);
    assert.equal([six, twelve].flatMap((n) => n.requests).filter((q) => q.method === 'POST').length, 0);
    const agreed = await runCli(['token', 'transfer', TOKEN, '--to', RECORDED, '--amount', '5', '--json', '--home', home,
      '--node', twelve.url, '--node', six.url, '--node', alsoSix.url, ...SLOW]);
    assert.equal(agreed.code, 2, said(agreed));
    assert.match(agreed.stderr, /Decimals:\s+6/);
    assert.match(agreed.stderr, /Amount:\s+5 GLD \(5000000 base units\)/);
    assert.match(agreed.stderr, /as two nodes describe it alike/);
  });

  // DEVP-R4-03: a token sent to the burn address is destroyed and credits no entry, so the node takes no deposit: the
  // review shows none and the balance check does not ask for it. A new recipient still does.
  it('asks no deposit for a token burn, and asks it for a recipient without an entry', async () => {
    const home = await homeWithKey();
    const BURN = sdk.CANONICAL_BURN_ADDRESS;
    const balanceReads = [];
    const mock = await serve((r) => {
      if (r.path === `/api/v1/token/${TOKEN}`) {
        return { json: { success: true, source: 'blockchain_state', token: { contract_address: TOKEN, standard: 'qrc20', name: 'Gold', symbol: 'GLD',
          decimals: 2, logo: '', total_supply: '100000', total_minted: '100000', total_burned: '0', deployer: GOLDEN, deployed_at: '1' } } };
      }
      // Above the fee (about 0.0015 QNC), below the fee and the 0.01 QNC deposit.
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: 1, balance: 5_000_000 });
      if (r.path === `/api/v1/account/${BURN}`) return accountAnswer(BURN, { nonce: 0, balance: 0 });
      if (r.path === `/api/v1/account/${RECORDED}`) return { json: fixture('account.json') };
      if (r.path.startsWith(`/api/v1/token/${TOKEN}/balance/`)) {
        balanceReads.push(r.path.slice(r.path.lastIndexOf('/') + 1));
        return { json: { success: true, contract_address: TOKEN, holder_address: RECORDED, balance: '0', decimals: 2, source: 'blockchain_state' } };
      }
      return undefined;
    });
    const run = (to, ...more) => runCli(['token', 'transfer', TOKEN, '--to', to, '--amount', '5', ...more, '--json', '--home', home,
      '--node', mock.url, ...SLOW]);
    const burn = await run(BURN, '--burn');
    assert.equal(burn.code, 2, said(burn));
    assert.match(burn.stderr, new RegExp(`To:\\s+${BURN} \\(the burn address: the tokens are destroyed\\)`));
    assert.doesNotMatch(burn.stderr, /Deposit/);
    assert.match(burn.stderr, /confirm with --yes/);
    assert.deepEqual(balanceReads, []);
    const fresh = await run(RECORDED);
    assert.equal(fresh.code, 1, said(fresh));
    assert.match(fresh.stderr, /INSUFFICIENT_FUNDS/);
    assert.deepEqual(balanceReads, [RECORDED]);
    assert.equal(mock.requests.filter((q) => q.method === 'POST').length, 0);
  });

  // DEV-R1-08: the light client's verified checkpoints are a trust root; a file others can change is not imported.
  it('ignores an anchors file that other users can change', { skip: process.platform === 'win32' ? 'no file modes on Windows' : false }, async () => {
    const home = await tempHome();
    await chmod(home, 0o700);
    const file = path.join(home, 'anchors-testnet.json');
    await (await import('node:fs/promises')).writeFile(file, '{}', { mode: 0o666 });
    await chmod(file, 0o666);
    const mock = await serve((r) => (r.path === `/api/v1/account/${RECORDED}/balance/proof` ? { json: fixture('balproof.json') } : undefined));
    const open = await runCli(['balance', RECORDED, '--verified', '--node', mock.url, '--home', home]);
    assert.match(open.stderr, /ignoring .*anchors-testnet\.json: other users of this computer can change it/);
    await chmod(file, 0o600);
    const closed = await runCli(['balance', RECORDED, '--verified', '--node', mock.url, '--home', home]);
    assert.doesNotMatch(closed.stderr, /ignoring/);
  });

  // DEVP-R1-08: the account is read again once the key is unlocked, on a live connection, right before the send; a
  // nonce used meanwhile stops the send.
  it('reads the account again after unlocking, and sends nothing for a nonce used meanwhile', async () => {
    const home = await homeWithKey();
    let reads = 0;
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: (reads += 1) === 1 ? 1 : 2 });
      if (r.path === `/api/v1/account/${RECORDED}`) return { json: fixture('account.json') };
      return undefined;
    });
    const r = await runCli(['transfer', '--to', RECORDED, '--amount', '1', '--yes', '--home', home, '--node', mock.url, ...SLOW],
      { input: `${STRONG_PASSWORD}\n` });
    assert.equal(r.code, 1, said(r));
    assert.match(r.stderr, /Nonce 2 is already used \(the account is at nonce 2\): nothing was sent \[INVALID_NONCE\]/);
    assert.equal(reads, 2);
    assert.equal(mock.requests.filter((q) => q.method === 'POST').length, 0);
  });

  // DEVP-R1-01, DEVP-R3-02: what a transfer or a token transfer credits to a contract can never leave it; the command
  // refuses a contract recipient, has no option to send one anyway, and counts an account too large to read as one.
  it('refuses to send QNC or tokens to a contract', async () => {
    const home = await homeWithKey();
    const GAME = sdk.deriveContractAddress(GOLDEN, 9);
    const BIG = sdk.deriveContractAddress(GOLDEN, 10);
    const huge = accountAnswer(BIG, { nonce: 0, balance: 0, contract: 'wasm' }).json
      .replace('"contract_storage":{"type":"wasm"}', `"contract_storage":{"type":"wasm","pad":"${'0'.repeat(8.5 * 1024 * 1024)}"}`);
    let posts = 0;
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: posts ? 2 : 1 });
      if (r.path === `/api/v1/account/${GAME}`) return accountAnswer(GAME, { nonce: 0, balance: 0, contract: 'wasm' });
      if (r.path === `/api/v1/account/${TOKEN}`) return accountAnswer(TOKEN, { nonce: 0, balance: 0, contract: 'qrc20' });
      if (r.path === `/api/v1/account/${BIG}`) return { json: huge };
      if (r.path === '/api/v1/height') return HEIGHT;
      if (r.method === 'POST') {
        posts += 1;
        return { json: { success: true, tx_hash: 'cd'.repeat(32), message: 'Transaction submitted successfully' } };
      }
      return undefined;
    });
    const send = (args, input = `${STRONG_PASSWORD}\n`) => runCli([...args, '--yes', '--home', home, '--node', mock.url, ...SLOW], { input });
    for (const to of [GAME, BIG]) {
      const r = await send(['transfer', '--to', to, '--amount', '100']);
      assert.equal(r.code, 2, said(r));
      assert.match(r.stderr, new RegExp(`${to} is a contract: nothing can ever move what is sent to it, so the command does not send there`));
    }
    const back = await send(['token', 'transfer', TOKEN, '--to', TOKEN, '--amount', '5000']);
    assert.equal(back.code, 2, said(back));
    assert.match(back.stderr, /is a contract: nothing can ever move what is sent to it/);
    assert.equal(posts, 0);
    const meant = await send(['transfer', '--to', GAME, '--amount', '1', '--to-contract']);
    assert.equal(meant.code, 2, said(meant));
    assert.match(meant.stderr, /--to-contract/);
    assert.equal(posts, 0);
    const help = await runCli(['--help']);
    assert.doesNotMatch(help.stdout, /--to-contract/);
  });

  // DEVP-R1-03: a contract whose account is too large to read can still be called; the review says it was not checked.
  it('calls a contract whose account is too large to read, and says its type was not checked', async () => {
    const home = await homeWithKey();
    const BIG = sdk.deriveContractAddress(GOLDEN, 11);
    const huge = accountAnswer(BIG, { nonce: 0, balance: 0, contract: 'wasm' }).json
      .replace('"contract_storage":{"type":"wasm"}', `"contract_storage":{"type":"wasm","pad":"${'0'.repeat(8.5 * 1024 * 1024)}"}`);
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${GOLDEN}`) return accountAnswer(GOLDEN, { nonce: 1 });
      if (r.path === `/api/v1/account/${BIG}`) return { json: huge };
      return undefined;
    });
    const r = await runCli(['call', BIG, 'transfer', '--args', '00', '--json', '--home', home, '--node', mock.url, ...SLOW]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /too large to read here: going on without checking that it is a WebAssembly contract/);
    assert.match(r.stderr, new RegExp(`Contract:\\s+${BIG} \\(its type is not checked: its account is too large to read\\)`));
    assert.match(r.stderr, /confirm with --yes/);
    assert.equal(mock.requests.filter((q) => q.method === 'POST').length, 0);
  });

  // DEVP-R1-05: the checkpoints file is written into a new file and renamed over its name, never through whatever the
  // name is: a name that is not a plain file is left alone.
  it('keeps the checkpoints in a file of its own, and never writes through the name', async () => {
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${RECORDED}/balance/proof`) return { json: fixture('balproof.json') };
      if (r.path === '/api/v1/height') return { json: fixture('height.json') };
      return undefined;
    });
    const home = await tempHome();
    const file = path.join(home, 'anchors-testnet.json');
    const plain = await runCli(['balance', RECORDED, '--verified', '--node', mock.url, '--home', home]);
    assert.equal(plain.code, 1, said(plain));
    assert.equal((await stat(file)).isFile(), true);
    assert.equal(typeof JSON.parse(await readFile(file, 'utf8')), 'object');
    assert.deepEqual((await readdir(home)).filter((n) => n.endsWith('.tmp')), []);
    assert.doesNotMatch(plain.stderr, /not keeping/);
    const other = await tempHome();
    await mkdir(path.join(other, 'anchors-testnet.json'));
    const dir = await runCli(['balance', RECORDED, '--verified', '--node', mock.url, '--home', other]);
    assert.match(dir.stderr, /not keeping the verified checkpoints in .*anchors-testnet\.json: it is not a plain file/);
    assert.equal((await stat(path.join(other, 'anchors-testnet.json'))).isDirectory(), true);
    assert.deepEqual((await readdir(other)).filter((n) => n.endsWith('.tmp')), []);
  });

  // DEVP-R2-01: a walk that stops on the way says what the next run goes on from. The two parity chains (even and odd
  // macroblocks) are walked on their own, and the next proof may be checked on either, so the hint says whether the
  // other one has kept checkpoints. Real checkpoints: a lineage a test committee signed above a kept one.
  it('says, when a walk stops, whether the other line of checkpoints has any kept', async () => {
    const L = await testLineage();
    const B = L.base;
    const T = B + 40;
    let servedUpTo = B + 20;
    // The recorded proof folds to its own state root whatever its height; its checkpoint is never reached here.
    const proof = { ...JSON.parse(fixture('balproof.json')), block_height: T * 90 + 5 };
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${RECORDED}/balance/proof`) return { json: proof };
      if (r.path === '/api/v1/height') return { json: { height: T * 90 + 5 } };
      return L.route(r, servedUpTo);
    });
    const home = await tempHome();
    await chmod(home, 0o700);
    const file = path.join(home, 'anchors-testnet.json');
    await writeFile(file, JSON.stringify(L.anchor(B)), { mode: 0o600 });
    const n = (i) => i.toLocaleString('en-US');
    const args = ['balance', RECORDED, '--verified', '--node', mock.url, '--home', home];

    const first = await runCli(args);
    assert.equal(first.code, 1, said(first));
    assert.match(first.stdout, /Not verified: the proof is consistent, but its checkpoint could not be checked now/);
    assert.ok(first.stderr.includes(`the checkpoint chain was checked up to macroblock ${n(B + 20)} of ${n(T)}`), said(first));
    assert.match(first.stderr, /when the next proof is checked on the same line of checkpoints \(every other macroblock/);
    assert.match(first.stderr, /The other line has no checkpoint kept yet: a proof on it is checked from the release's own checkpoint/);
    const kept = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(kept[B + 20] && Object.keys(kept).every((k) => Number(k) % 2 === B % 2), Object.keys(kept).join(','));

    // With a checkpoint kept on the other line too, and more of this line served: the run goes on from B + 20.
    await writeFile(file, JSON.stringify({ ...kept, ...L.anchor(B + 1) }), { mode: 0o600 });
    servedUpTo = B + 30;
    const from = mock.requests.length;
    const second = await runCli(args);
    assert.equal(second.code, 1, said(second));
    const walked = mock.requests.slice(from).map((r) => /^\/api\/v1\/macroblock\/(\d+)\/proof$/.exec(r.path)?.[1]).filter(Boolean).map(Number);
    assert.equal(walked[0], B + 22);
    assert.ok(second.stderr.includes(`checked up to macroblock ${n(B + 30)} of ${n(T)}`), said(second));
    assert.match(second.stderr, /The other line has checkpoints kept as well, and goes on from its own\./);
  });

  it('never writes the checkpoints through a link, nor into a directory other users can write',
    { skip: process.platform === 'win32' ? 'no file modes or unprivileged links on Windows' : false }, async () => {
      const mock = await serve((r) => {
        if (r.path === `/api/v1/account/${RECORDED}/balance/proof`) return { json: fixture('balproof.json') };
        if (r.path === '/api/v1/height') return { json: fixture('height.json') };
        return undefined;
      });
      const home = await tempHome();
      await chmod(home, 0o700);
      const victim = path.join(await tempHome(), 'profile');
      await writeFile(victim, 'untouched\n', { mode: 0o644 });
      await symlink(victim, path.join(home, 'anchors-testnet.json'));
      const linked = await runCli(['balance', RECORDED, '--verified', '--node', mock.url, '--home', home]);
      assert.match(linked.stderr, /not keeping the verified checkpoints in .*: it is not a plain file/);
      assert.equal(await readFile(victim, 'utf8'), 'untouched\n');
      assert.equal((await stat(victim)).mode & 0o777, 0o644);
      const shared = await tempHome();
      await chmod(shared, 0o777);
      const open = await runCli(['balance', RECORDED, '--verified', '--node', mock.url, '--home', shared]);
      assert.match(open.stderr, /not keeping the verified checkpoints in .*: other users of this computer can write its directory/);
      assert.deepEqual(await readdir(shared), []);
    });

  it('reads a balance, a transaction and a token', async () => {
    const mock = await serve((r) => {
      if (r.path === `/api/v1/account/${RECORDED}`) return { json: fixture('account.json') };
      if (r.path === `/api/v1/account/${RECORDED}/balance/proof`) return { json: fixture('balproof.json') };
      if (r.path === '/api/v1/height') return { json: fixture('height.json') };
      if (r.path.startsWith('/api/v1/transaction/')) return { json: fixture('tx.json') };
      if (r.path === `/api/v1/token/${TOKEN}`) {
        return { json: { success: true, source: 'blockchain_state', token: { contract_address: TOKEN, standard: 'qrc20', name: 'Gold', symbol: 'GLD',
          decimals: 2, logo: '', total_supply: '123456', total_minted: '123456', total_burned: '0', deployer: GOLDEN, deployed_at: '1' } } };
      }
      return undefined;
    });
    const home = await tempHome();
    const bal = await runCli(['balance', RECORDED, '--node', mock.url, '--home', home]);
    assert.equal(bal.code, 0, bal.stderr);
    assert.match(bal.stdout, /Balance:\s+2909459\.67465 QNC/);
    assert.match(bal.stdout, /Nonce:\s+2/);
    const verified = await runCli(['balance', RECORDED, '--verified', '--node', mock.url, '--home', home]);
    assert.equal(verified.code, 1);
    assert.match(verified.stdout, /Not verified: the proof is consistent, but its checkpoint could not be checked now \(height 2210909, 0 blocks below the chain's tip \(2210863\)\)/);
    // DEVP-R1-02: a check that could not go on says what to do next.
    assert.match(verified.stderr, /no checkpoint could be checked this time .* Run the command again in a few minutes\./);
    // DEV-R2-07: a proof far below the tip another node reports is not taken, and the lag is printed.
    const ahead = await serve((r) => (r.path === '/api/v1/height'
      ? { json: { blocks_behind: 0, height: 2211909, is_syncing: false, network_height: 2211909 } } : undefined));
    const stale = await runCli(['balance', RECORDED, '--verified', '--node', mock.url, '--node', ahead.url, '--home', home]);
    assert.equal(stale.code, 1);
    assert.match(stale.stdout, /Not verified: the proof is of height 2210909, 1000 blocks below the chain's tip \(2211909\); it may show a balance since spent\./);
    const tx = await runCli(['tx', 'f7d6c1ea3936b29b399cdfcc3eaae2b68d78c54127ea775db430ece2f5ee2bea', '--node', mock.url]);
    assert.equal(tx.code, 0, tx.stderr);
    assert.match(tx.stdout, /Status:\s+in block 2208291 \(FullyFinalized\)/);
    const token = await runCli(['token', 'info', TOKEN, '--node', mock.url]);
    assert.match(token.stdout, /Gold \(GLD\), qrc20/);
    assert.match(token.stdout, /Supply:\s+1234\.56 GLD/);
  });
});
