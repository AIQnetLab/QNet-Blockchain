/**
 * The transaction formats of src/crypto/WalletIdentity.js and TxBuilders.js read against the node's own source: the
 * format! strings of build_canonical_verify_message, the chain tag, the calldata and deploy payload the RPC builds, the
 * key order serde_json writes, the intrinsic gas, the contract address and the request structs. A change on either
 * side fails here, before a wallet signs bytes the node no longer rebuilds. Source text is compared without its
 * whitespace, so reformatting the Rust changes nothing.
 */
const fs = require('fs');
const path = require('path');
const { sha3_256 } = require('js-sha3');
const { QNET_CHAIN_TAG, transferPreimage, contractCallPreimage, contractDeployPreimage } = require('../src/crypto/WalletIdentity');
const T = require('../src/crypto/TxBuilders');
const fees = require('../src/config/fees');

const ROOT = path.join(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const squash = (s) => s.replace(/\s+/g, '');
const NODE_TX = read('development/qnet-integration/src/node/transactions.rs');
const RPC = read('development/qnet-integration/src/rpc/mod.rs');
const CONTRACTS_API = read('development/qnet-integration/src/rpc/contracts_api.rs');
const STATE_TX = read('core/qnet-state/src/transaction.rs');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (source, snippet) => expect(squash(source)).toContain(squash(snippet));
// From `start` to the next line that closes a top-level item.
const itemAt = (source, start) => {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`not found: ${start}`);
  return source.slice(at, source.indexOf('\n}\n', at) + 2);
};

// The body of build_canonical_verify_message, up to the chain tag it is bound with.
const VERIFY = (() => {
  const start = NODE_TX.indexOf('pub fn build_canonical_verify_message(');
  const end = NODE_TX.indexOf('Self::chain_bind(&body)', start);
  if (start < 0 || end < 0) throw new Error('build_canonical_verify_message not found in node/transactions.rs');
  return NODE_TX.slice(start, end);
})();

// format!("<prefix>...", a, b, ...) of one arm, as { fmt, args }.
function nodeFormat(prefix) {
  const m = new RegExp(`format!\\(\\s*"(${esc(prefix)}[^"]*)"\\s*,([^)]*)\\)`).exec(VERIFY);
  if (!m) throw new Error(`no format! for ${prefix} in build_canonical_verify_message`);
  return { fmt: m[1], args: m[2].split(',').map((a) => a.trim()).filter(Boolean) };
}

// The node's string for these field values: every {} filled in the order of the format's arguments.
function render({ fmt, args }, values) {
  expect(fmt.match(/\{[^}]*\}/g).every((p) => p === '{}')).toBe(true);
  expect(fmt.split('{}').length - 1).toBe(args.length);
  let i = 0;
  return QNET_CHAIN_TAG + fmt.replace(/\{\}/g, () => {
    const arg = args[i++];
    if (!(arg in values)) throw new Error(`unpinned argument ${arg}`);
    return values[arg];
  });
}

const FROM = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const TO = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
const MODULE = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

describe('the signed bytes', () => {
  it('carry the chain tag the node binds every preimage with', () => {
    has(itemAt(NODE_TX, 'pub fn chain_bind('), 'format!("{}{}", qnet_state::transaction::chain_tag(), body)');
    const id = /pub const QNET_CHAIN_ID: u64 = (\d+);/.exec(STATE_TX)[1];
    has(itemAt(STATE_TX, 'pub fn chain_tag()'), 'format!("q{}|", QNET_CHAIN_ID)');
    expect(QNET_CHAIN_TAG).toBe(`q${id}|`);
  });

  it('transfer: the node\'s fields, order and separators', () => {
    const f = nodeFormat('transfer:');
    has(VERIFY, 'let to_str = tx.to.as_ref().map(|s| s.as_str()).unwrap_or("");');
    const values = { 'tx.from': FROM, to_str: TO, 'tx.amount': '1500000000', 'tx.nonce': '7', 'tx.gas_price': '10', 'tx.gas_limit': '10000' };
    expect(transferPreimage(FROM, TO, '1500000000', '7', '10', '10000')).toBe(render(f, values));
    expect(T.buildTransfer({ from: FROM, to: TO, amountNano: 1500000000, nonce: 7 }).preimage).toBe(render(f, values));
  });

  it('contract call: the SHA3-256 of the raw calldata in lower-case hex, then nonce and gas', () => {
    const f = nodeFormat('contract_call:');
    has(VERIFY, 'let data_bytes = tx.data.as_deref().unwrap_or("").as_bytes();');
    has(VERIFY, 'let data_hash = format!("{:x}", Sha3_256::digest(data_bytes));');
    const callData = T.contractCallData(TO, 'transfer', [FROM, '5']);
    const values = { 'tx.from': FROM, data_hash: sha3_256(callData), 'tx.nonce': '3', 'tx.gas_price': '10', 'tx.gas_limit': '100750' };
    expect(contractCallPreimage(FROM, callData, '3', '10', '100750')).toBe(render(f, values));
  });

  it('contract deploy: the code_hash the payload carries, then nonce and gas', () => {
    const f = nodeFormat('contract_deploy:');
    has(VERIFY, 'v.get("code_hash").and_then(|h| h.as_str().map(String::from))');
    const tx = T.buildContractDeploy({ from: FROM, code: MODULE, nonce: 5 });
    expect(JSON.parse(tx.deployData).code_hash).toBe(tx.codeHash);
    const values = { 'tx.from': FROM, code_hash: tx.codeHash, 'tx.nonce': '5', 'tx.gas_price': '10', 'tx.gas_limit': tx.gasLimit };
    expect(contractDeployPreimage(FROM, tx.codeHash, '5', '10', tx.gasLimit)).toBe(render(f, values));
    expect(tx.preimage).toBe(render(f, values));
  });
});

describe('what the node rebuilds from a request', () => {
  it('calldata: json!({contract, method, args}) from the request fields, written with sorted keys', () => {
    // built in the handler, or in the one helper it builds the transaction with
    const handler = itemAt(CONTRACTS_API, 'pub(super) async fn handle_contract_call(');
    const call = handler.includes('TransactionType::ContractCall') ? handler
      : (has(handler, 'let mut tx = contract_call_tx(&request,'), itemAt(CONTRACTS_API, 'pub(super) fn contract_call_tx('));
    const at = call.indexOf('TransactionType::ContractCall');
    expect(at).toBeGreaterThan(0);
    const block = /json!\(\{([^}]*)\}\)/.exec(call.slice(at))[1];
    const fields = [...block.matchAll(/"(\w+)":\s*([\w.]+)/g)].map((m) => [m[1], m[2]]);
    expect(fields.sort()).toEqual([['args', 'request.args'], ['contract', 'request.contract_address'], ['method', 'request.method']]);
    expect(Object.keys(JSON.parse(T.contractCallData(TO, 'run', null)))).toEqual(['args', 'contract', 'method']);
  });

  it('deploy payload: {wasm, code (hex), code_hash = SHA3-256 of the module}, written with sorted keys', () => {
    const deploy = itemAt(CONTRACTS_API, 'pub(super) async fn handle_contract_deploy(');
    if (squash(deploy).includes(squash('let mut deploy_data = json!('))) {
      has(deploy, 'let mut deploy_data = json!({ "wasm": true, "code": hex::encode(&wasm_code), });');
      has(deploy, 'deploy_data["code_hash"] = json!(code_hash);');
    } else {
      // the node's canonical-payload helper: the same three keys in a sorted map
      has(deploy, 'deploy_payload(qnet_state::transaction::DeployKind::Wasm, &json!({ "wasm": true, "code": hex::encode(&wasm_code) }))');
      has(deploy, 'Some(payload),');
      has(itemAt(CONTRACTS_API, 'pub(super) fn deploy_payload('), 'qnet_state::transaction::canonical_deploy_data(kind, input)?');
      const canonical = itemAt(STATE_TX, 'pub fn canonical_deploy_data(');
      has(canonical, 'let mut m: std::collections::BTreeMap<&str, V> = std::collections::BTreeMap::new();');
      const wasm = squash(canonical.slice(canonical.indexOf('DeployKind::Wasm =>'), canonical.indexOf('DeployKind::Qrc20 =>')));
      expect(wasm).toContain(squash('m.insert("wasm", V::Bool(true));'));
      expect(wasm).toContain(squash('m.insert("code", V::String(hex::encode(code)));'));
      has(canonical, 'm.insert("code_hash", V::String(deploy_code_hash(kind, parsed)?));');
      has(canonical, 'serde_json::to_string(&m)');
    }
    has(deploy, 'base64::engine::general_purpose::STANDARD.decode(&request.code)');
    const digest = itemAt(STATE_TX, 'pub fn deploy_code_hash(');
    const wasmArm = squash(digest.slice(digest.indexOf('DeployKind::Wasm =>'), digest.indexOf('DeployKind::Qrc20 =>')));
    expect(wasmArm).toContain(squash('let code = hex::decode(code_hex)'));
    expect(wasmArm).toContain(squash('Digest::update(&mut h, &code);'));
    expect(Object.keys(JSON.parse(T.contractDeployData(MODULE)))).toEqual(['code', 'code_hash', 'wasm']);
  });

  it('serde_json keeps no insertion order anywhere in the build (its objects are sorted maps)', () => {
    for (const lock of ['Cargo.lock', 'development/qnet-integration/Cargo.lock']) {
      if (!fs.existsSync(path.join(ROOT, lock))) continue;
      const blocks = read(lock).split('[[package]]').filter((b) => /\nname = "serde_json"\n/.test(b));
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) expect(b).not.toMatch(/"indexmap/);
    }
    for (const manifest of ['Cargo.toml', 'development/qnet-integration/Cargo.toml', 'core/qnet-state/Cargo.toml']) {
      expect(read(manifest)).not.toMatch(/preserve_order|arbitrary_precision/);
    }
  });

  it('the contract address: SHA3-256("qnet_contract_v1" || from || nonce as u64 LE), cut 19 / 15 and checksummed', () => {
    const fn = itemAt(STATE_TX, 'pub fn derive_contract_address(');
    for (const line of ['hasher.update(b"qnet_contract_v1");', 'hasher.update(from.as_bytes());', 'hasher.update(nonce.to_le_bytes());',
      'let part1 = &hash[0..19];', 'let part2 = &hash[19..34];',
      'let checksum = hex::encode(&Sha3_256::digest(format!("{}eon{}", part1, part2).as_bytes())[..4]);',
      'format!("{}eon{}{}", part1, part2, checksum)']) {
      has(fn, line);
    }
    // the same derivation apart from the builder: nonce 1 of the golden wallet
    const n = Buffer.alloc(8);
    n.writeBigUInt64LE(1n);
    const h = sha3_256(Buffer.concat([Buffer.from('qnet_contract_v1'), Buffer.from(FROM), n]));
    const body = `${h.slice(0, 19)}eon${h.slice(19, 34)}`;
    expect(T.deriveContractAddress(FROM, 1)).toBe(body + sha3_256(body).slice(0, 8));
  });
});

describe('gas and requests', () => {
  const constant = (name) => Number(new RegExp(`pub const ${name}: u64 = ([\\d_]+);`).exec(STATE_TX)[1].replace(/_/g, ''));

  it('intrinsic gas, the gas price floor and the per-transaction cap are the chain\'s', () => {
    expect(fees.TRANSFER_GAS_LIMIT).toBe(constant('TRANSFER'));
    expect(fees.CONTRACT_CALL_BASE_GAS).toBe(constant('CONTRACT_CALL'));
    expect(T.DEPLOY_BASE_GAS).toBe(constant('CONTRACT_DEPLOY'));
    expect(T.MAX_GAS_LIMIT).toBe(constant('MAX_GAS_LIMIT'));
    const gasUsed = itemAt(STATE_TX, 'pub fn compute_gas_used(');
    has(gasUsed, `gas_limits::CONTRACT_DEPLOY.saturating_add((code_bytes as u64).saturating_mul(${T.DEPLOY_GAS_PER_BYTE}))`);
    has(gasUsed, `gas_limits::CONTRACT_CALL.saturating_add((data_bytes as u64).saturating_mul(${fees.CONTRACT_CALL_GAS_PER_BYTE}))`);
    has(STATE_TX, 'pub const MIN_GAS_PRICE: u64 = BASE_FEE_NANO_QNC / gas_limits::TRANSFER;');
    expect(fees.GAS_PRICE).toBe(constant('BASE_FEE_NANO_QNC') / constant('TRANSFER'));
  });

  it('each body names exactly fields of the node\'s request struct, every required one included', () => {
    const struct = (name) => {
      const m = new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(RPC);
      const fields = [];
      let defaulted = false;
      for (const line of m[1].split('\n').map((l) => l.trim())) {
        if (line.startsWith('#[serde(default')) defaulted = true;
        const f = /^(?:pub\s+)?(\w+):\s/.exec(line);
        if (f) {
          fields.push({ name: f[1], required: !defaulted });
          defaulted = false;
        }
      }
      return fields;
    };
    const check = (name, json) => {
      const keys = Object.keys(JSON.parse(json));
      const fields = struct(name);
      for (const k of keys) expect([name, k, fields.some((f) => f.name === k)]).toEqual([name, k, true]);
      for (const f of fields.filter((x) => x.required)) expect([name, f.name, keys.includes(f.name)]).toEqual([name, f.name, true]);
    };
    const sig = 'ab'.repeat(3309);
    const pk = 'cd'.repeat(1952);
    check('TransactionRequest', T.transferRequestJson(T.buildTransfer({ from: FROM, to: TO, amountNano: 1, nonce: 1 }), sig, pk));
    check('ContractCallRequest', T.contractCallRequestJson(T.buildContractCall({ from: FROM, contract: TO, method: 'run', nonce: 1 }), sig));
    check('ContractDeployRequest', T.contractDeployRequestJson(T.buildContractDeploy({ from: FROM, code: MODULE, nonce: 1 }), sig, pk));
  });

  it('each route and its body limit', () => {
    const limitOf = (segments) => {
      const re = new RegExp(`api_v1${segments.map((s) => `\\s*\\.and\\(warp::path\\("${s}"\\)\\)`).join('')}`
        + '\\s*\\.and\\(warp::path::end\\(\\)\\)\\s*\\.and\\(warp::post\\(\\)\\)\\s*\\.and\\(warp::body::content_length_limit\\(([\\d *]+)\\)\\)');
      const m = re.exec(RPC);
      if (!m) throw new Error(`no route ${segments.join('/')}`);
      return m[1].split('*').reduce((acc, n) => acc * Number(n.trim()), 1);
    };
    const routes = [[T.TX_ROUTES.transfer, ['transaction']], [T.TX_ROUTES.call, ['contract', 'call']], [T.TX_ROUTES.deploy, ['contract', 'deploy']]];
    for (const [route, segments] of routes) {
      expect(route.path).toBe(`/api/v1/${segments.join('/')}`);
      expect([route.path, route.maxBodyBytes]).toEqual([route.path, limitOf(segments)]);
    }
  });
});
