// docs/developers checked against the code it describes: no other project's names, only routes the node serves
// (and the flag on the ones that cannot work), signed texts and calldata from the shared vectors, provider methods
// the wallets offer, qnet commands that exist, and links that resolve. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

const REPO = new URL('../../../../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, REPO), 'utf8').replace(/\r\n/g, '\n');
const DOCS_DIR = 'docs/developers/';
const DOCS = readdirSync(new URL(DOCS_DIR, REPO)).filter((f) => f.endsWith('.md')).sort()
  .map((name) => ({ name, path: `${DOCS_DIR}${name}`, text: read(`${DOCS_DIR}${name}`) }));

// Paragraphs and table rows: the unit a statement about a route lives in.
const blocksOf = (text) => text.split(/\n\s*\n/).flatMap((b) => (/^\s*\|/m.test(b) ? b.split('\n') : [b]));

// ---------------------------------------------------------------- the node's routes

function servedRoutes() {
  const src = read('development/qnet-integration/src/rpc/mod.rs');
  const body = src.slice(src.indexOf('pub async fn start_rpc_server'), src.indexOf('warp::serve(routes)'));
  const routes = [];
  for (const m of body.matchAll(/let ([a-z_0-9]+) = (api_v1|warp::path\("[^"]+"\)|warp::path::end\(\))([\s\S]*?);\n/g)) {
    const [, name, head, rest] = m;
    const chain = head + rest;
    const cut = chain.search(/\.(and_then|map)\(/);
    const filters = cut < 0 ? chain : chain.slice(0, cut);
    const segments = head === 'api_v1' ? ['api', 'v1'] : [];
    for (const s of filters.matchAll(/warp::path(?:::param::<[^>]+>\(\)|\("([^"]+)"\))/g)) segments.push(s[1] ?? null);
    const methods = /warp::ws\(\)/.test(filters) ? ['WS'] : [...filters.matchAll(/warp::(get|post|delete|put)\(\)/g)].map((x) => x[1].toUpperCase());
    if (methods.length === 0) continue;
    // Served: the name is used again after its own definition (a route group or the final chain).
    const served = new RegExp(`(?:\\.or\\(|= )${name}\\b(?!\\s*=)`).test(body.replace(`let ${name} = `, ''));
    routes.push({ name, segments, methods, served });
  }
  return routes;
}

function siteRoutes() {
  const root = 'applications/qnet-explorer/frontend/src/app/api/';
  const out = [];
  const walk = (dir, segments) => {
    for (const entry of readdirSync(new URL(dir, REPO))) {
      const path = `${dir}${entry}`;
      if (statSync(new URL(path, REPO)).isDirectory()) walk(`${path}/`, [...segments, /^\[.+\]$/.test(entry) ? null : entry]);
      else if (entry === 'route.ts') out.push({ name: path, segments: ['api', ...segments], methods: null, served: true });
    }
  };
  walk(root, []);
  return out;
}

const ROUTES = servedRoutes();
const SITE = siteRoutes();
const PLACEHOLDER = /^(\{[^}]*\}|<[^>]*>)$/;
// A literal segment that is a value (a height, a hash, an address, a shortened one) may stand for a parameter.
const VALUE = /^(\d+|[0-9a-f]{8,}|[0-9a-f]{19}eon[0-9a-f]{23}|.*….*)$/;

function matches(route, segments) {
  if (route.segments.length !== segments.length) return false;
  return route.segments.every((want, i) => {
    const got = segments[i];
    if (want === null) return PLACEHOLDER.test(got) || VALUE.test(got) || /^\[.+\]$/.test(got);
    return got === want;
  });
}

// Every route a doc names: `GET /api/v1/...`, a table row `| POST | `/api/v1/...` |`, or a bare path.
function mentions(text) {
  const out = [];
  for (const block of blocksOf(text)) {
    const row = /^\s*\|\s*([A-Z, ]+?)\s*\|\s*`(\/(?:api|ws)\/[^`]*)`/.exec(block);
    for (const m of block.matchAll(/(?:\b(GET|POST|DELETE|PUT|WS)\s+`?)?(\/(?:api|ws)\/[A-Za-z0-9_{}<>.:…\-/[\]*]*)/g)) {
      let path = m[2].replace(/[.,:)]+$/, '').replace(/\/+$/, '');
      if (path.includes('*') || path === '/api/v1' || path === '/api') continue;
      let methods = m[1] ? [m[1]] : [];
      if (!m[1] && row && row[2].startsWith(m[2])) methods = row[1].split(',').map((s) => s.trim()).filter((s) => /^(GET|POST|DELETE|PUT|WS)$/.test(s));
      out.push({ block, path, segments: path.slice(1).split('/'), methods });
    }
  }
  return out;
}

const resolve = (mention) => [...ROUTES, ...SITE].filter((r) => matches(r, mention.segments));

test('the developer docs name no other chain, wallet or their standards', () => {
  // Data for the check: names the owner rule keeps out of official docs. Solana, 1DEV, GitHub and library names
  // of real dependencies are allowed.
  const banned = [
    /\bethereum\b/i, /\bether\b/i, /\bETH\b/, /\bbitcoin\b/i, /\bBTC\b/, /\bpolygon\b/i, /\bavalanche\b/i, /\bcardano\b/i,
    /\bpolkadot\b/i, /\bcosmos\b/i, /\baptos\b/i, /\bsui\b/i, /\btron\b/i, /\btezos\b/i, /\balgorand\b/i, /\bbinance\b/i,
    /\bBNB\b/, /\barbitrum\b/i, /\bXRP\b/, /\bripple\b/i, /\blitecoin\b/i, /\bdogecoin\b/i, /\bmonero\b/i,
    /\bmetamask\b/i, /\bphantom\b/i, /\bsolflare\b/i, /\btrust wallet\b/i, /\bcoinbase\b/i, /\btrezor\b/i, /\bwalletconnect\b/i,
    /\bEVM\b/, /\bEIP-?\d+/i, /\bERC-?\d+/i, /\bBIP-?\d+/i, /\bSLIP-?\d+/i, /\bsolidity\b/i, /\bvyper\b/i, /\bhardhat\b/i,
    /\bfoundry\b/i, /\btruffle\b/i, /\bganache\b/i, /\bremix\b/i, /\bethers(\.js)?\b/i, /(?<![/@\w])web3\b(?!\.js)/i, /\bwagmi\b/i,
    /\bviem\b/i, /\binfura\b/i, /\balchemy\b/i, /\betherscan\b/i, /\bopenzeppelin\b/i, /\bchainlink\b/i, /\buniswap\b/i,
    /\bSIWE\b/, /\bcosmwasm\b/i, /\bgetStorageAt\b/, /\beth_[a-z]/i, /\bwat2wasm\b/i, /\bwabt\b/i, /\bgwei\b/i,
    /\bwei\b/i, /\bsatoshis?\b/i, /\bcaddy\b/i, /\bprometheus\b/i, /\bcapacitor\b/i, /\bionic\b/i,
  ];
  for (const doc of DOCS) {
    for (const pattern of banned) {
      const hit = pattern.exec(doc.text);
      assert.equal(hit, null, `${doc.name}: "${hit?.[0]}" (${pattern})`);
    }
  }
});

test('every route the developer docs name is served by the node, or is a site route, with the method it serves', () => {
  assert.ok(ROUTES.length > 100, 'the route table was read');
  for (const r of ROUTES) assert.equal(r.served, true, `${r.name} is defined but not served`);
  let checked = 0;
  for (const doc of DOCS) {
    for (const m of mentions(doc.text)) {
      const found = resolve(m);
      assert.ok(found.length > 0, `${doc.name}: ${m.path} is not a route the node or the site serves`);
      // A WebSocket upgrade is a GET.
      const serves = (r, method) => r.methods === null || r.methods.includes(method) || (method === 'GET' && r.methods.includes('WS'));
      for (const method of m.methods) {
        assert.ok(found.some((r) => serves(r, method)), `${doc.name}: ${method} ${m.path} is not served`);
      }
      checked++;
    }
  }
  assert.ok(checked > 150, `the docs name routes (${checked} checked)`);
});

test('a doc that names a route that cannot work says so', () => {
  // Routes that exist but read a store nothing writes, cannot land a deploy, or estimate with other constants.
  const flags = {
    contract_info: /nothing writes/, contract_state: /nothing writes/,
    wasm_deploy: /cannot land/, token_deploy: /cannot land/, nft_deploy: /cannot land/,
    contract_estimate_gas: /do(?:es)? not match/,
  };
  // The facts behind the flags: the deploy routes' fixed gas limits sit below the smallest deploy's intrinsic gas
  // (500,000), and nothing calls the writers of the stores the two contract reads serve.
  const api = read('development/qnet-integration/src/rpc/contracts_api.rs');
  const fixed = [...api.matchAll(/let gas_limit = ([0-9_]+)u64;/g)].map((m) => Number(m[1].replace(/_/g, '')));
  assert.deepEqual(fixed, [200_000, 50_000, 50_000]);
  const writers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, REPO))) {
      const path = `${dir}${entry}`;
      if (statSync(new URL(path, REPO)).isDirectory()) walk(`${path}/`);
      else if (entry.endsWith('.rs')) {
        const text = read(path).replace(/pub fn save_contract_(info|state)\(/g, '');
        if (/\bsave_contract_(info|state)\(/.test(text)) writers.push(path);
      }
    }
  };
  walk('development/qnet-integration/src/');
  assert.deepEqual(writers, []);
  for (const doc of DOCS) {
    const named = new Map();
    for (const m of mentions(doc.text)) {
      for (const r of resolve(m)) if (flags[r.name]) named.set(r.name, [...(named.get(r.name) ?? []), m.block]);
    }
    for (const [name, blocks] of named) {
      assert.ok(blocks.some((b) => flags[name].test(b.replace(/\s+/g, ' '))), `${doc.name} names ${name} without saying it cannot work`);
    }
  }
});

test('signed texts, calldata and deploy payloads in the docs are the shared vectors', () => {
  const vectors = JSON.parse(read('applications/qnet-mobile/src/crypto/__vectors__/tx-vectors.json')).vectors;
  const preimages = new Set(vectors.map((v) => v.preimage));
  const callData = new Set(vectors.filter((v) => v.callData).map((v) => v.callData));
  const deployData = new Set(vectors.filter((v) => v.deployData).map((v) => v.deployData));
  let seen = 0;
  for (const doc of DOCS) {
    for (const [text] of doc.text.matchAll(/q1337\|[a-z_]+:[^\s`'"]*/g)) {
      if (text.includes('{')) continue;
      assert.ok(preimages.has(text), `${doc.name}: ${text} is not a vector's signed text`);
      seen++;
    }
    for (const [text] of doc.text.matchAll(/\{"args":[^\n`]*?"method":"[^"]*"\}/g)) {
      if (/[<…]/.test(text)) continue;
      assert.ok(callData.has(text), `${doc.name}: ${text} is not a vector's calldata`);
      seen++;
    }
    for (const [text] of doc.text.matchAll(/\{"code":"[0-9a-f]+","code_hash":"[0-9a-f]{64}","wasm":true\}/g)) {
      assert.ok(deployData.has(text), `${doc.name}: ${text} is not a vector's deploy payload`);
      seen++;
    }
  }
  assert.ok(seen >= 8, `the docs quote the vectors (${seen})`);
  // The template the docs give for each kind is the one the builders sign.
  const identity = read('applications/qnet-mobile/src/crypto/WalletIdentity.js');
  const transactions = DOCS.find((d) => d.name === 'transactions.md').text;
  for (const [kind, fields] of [
    ['transfer', '{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}'],
    ['contract_call', '{from}:{sha3_256_hex(calldata)}:{nonce}:{gas_price}:{gas_limit}'],
    ['contract_deploy', '{from}:{code_hash}:{nonce}:{gas_price}:{gas_limit}'],
  ]) {
    assert.ok(transactions.includes(`q1337|${kind}:${fields}`), `transactions.md: the ${kind} template`);
    assert.match(identity, new RegExp(`\\$\\{QNET_CHAIN_TAG\\}${kind}:\\$\\{from\\}:\\$\\{[a-zA-Z]+\\}:\\$\\{[a-zA-Z]+\\}:\\$\\{[a-zA-Z]+\\}:\\$\\{[a-zA-Z]+\\}`));
  }
});

test('the provider methods the docs name are the wallets\' own', () => {
  const router = read('applications/qnet-wallet/dist/background/router.js');
  const extension = [...router.slice(router.indexOf('export const PROVIDER_METHODS')).matchAll(/^\s{2}(qnet_[A-Za-z]+): providerEntry/gm)].map((m) => m[1]);
  const provider = read('applications/qnet-mobile/src/browser/dappProvider.js');
  const block = provider.slice(provider.indexOf('export const METHODS'), provider.indexOf(']);', provider.indexOf('export const METHODS')));
  const mobile = [...block.matchAll(/'(qnet_[A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(extension.length >= 7 && mobile.length >= 6, 'both method lists were read');
  const known = new Set([...extension, ...mobile]);
  for (const doc of DOCS) {
    for (const [, name] of doc.text.matchAll(/`(qnet_[A-Za-z]+)`/g)) assert.ok(known.has(name), `${doc.name}: ${name} is no wallet method`);
  }
  // The method table of dapp-integration.md lists exactly the extension's methods, mobile's being a subset.
  const dapp = DOCS.find((d) => d.name === 'dapp-integration.md').text;
  const table = dapp.slice(dapp.indexOf('| Method | Params |'), dapp.indexOf('"None" means'));
  assert.deepEqual([...table.matchAll(/^\| `(qnet_[A-Za-z]+)` \|/gm)].map((m) => m[1]).sort(), [...extension].sort());
  for (const name of mobile) assert.ok(extension.includes(name), `${name} is in both wallets`);
});

test('every qnet command the docs name exists', () => {
  const cli = read('development/qnet-sdk/src/cli.ts');
  const commands = cli.slice(cli.indexOf('const COMMANDS'), cli.indexOf('// The command is named by'));
  const names = new Set([...commands.matchAll(/^\s{2}(?:'([a-z -]+)'|([a-z]+)): \{/gm)].map((m) => m[1] ?? m[2]));
  assert.ok(names.has('keys import') && names.has('deploy') && names.size >= 15, `the command table was read (${[...names]})`);
  const check = (doc, words) => {
    if (words[0].startsWith('-')) return;
    const two = `${words[0]} ${words[1] ?? ''}`;
    assert.ok(names.has(two) || names.has(words[0]), `${doc.name}: qnet ${words.slice(0, 2).join(' ')} is no command`);
  };
  let seen = 0;
  for (const doc of DOCS) {
    for (const [, rest] of doc.text.matchAll(/^(?:\$ )?qnet ([^\n#]+)/gm)) { check(doc, rest.trim().split(/\s+/)); seen++; }
    for (const [, rest] of doc.text.matchAll(/`qnet ([^`]+)`/g)) { check(doc, rest.trim().split(/\s+/)); seen++; }
  }
  assert.ok(seen > 10, `the docs name commands (${seen})`);
});

test('links in the developer docs and the site\'s documentation page resolve', () => {
  const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const anchorsOf = (path) => new Set([...read(path).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
  for (const doc of DOCS) {
    const text = doc.text.replace(/```[\s\S]*?```/g, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const [file, anchor] = target.split('#');
      const path = file === '' ? doc.path : new URL(file, new URL(doc.path, REPO)).href.slice(REPO.href.length);
      assert.ok(existsSync(new URL(path, REPO)), `${doc.name}: ${target} does not exist`);
      if (anchor) assert.ok(anchorsOf(path).has(anchor), `${doc.name}: ${target} names no heading`);
    }
  }
  const page = read('applications/qnet-explorer/frontend/src/app/docs/page.tsx');
  const listed = [...page.matchAll(/path: '([^']+\.md)'/g)].map((m) => m[1]);
  for (const path of listed) assert.ok(existsSync(new URL(`docs/${path}`, REPO)), `docs page: docs/${path}`);
  for (const doc of DOCS) assert.ok(listed.includes(`developers/${doc.name}`), `docs page lists developers/${doc.name}`);
  const index = read('docs/README.md');
  for (const doc of DOCS) assert.ok(index.includes(`](developers/${doc.name})`), `docs/README.md links developers/${doc.name}`);
});

// SD-R2-14: docs/ is the documentation's one tree (docs consolidation, 19.08): the explorer is described in
// docs/applications/explorer.md, and its folder carries no README of its own, an empty one least of all.
test('the explorer\'s documentation lives in docs/applications/explorer.md, not in a README of its folder', () => {
  assert.equal(existsSync(new URL('applications/qnet-explorer/frontend/README.md', REPO)), false);
  const doc = read('docs/applications/explorer.md');
  assert.match(doc, /npm run check:release/);
  assert.match(doc, /npm run build:indexer/);
});