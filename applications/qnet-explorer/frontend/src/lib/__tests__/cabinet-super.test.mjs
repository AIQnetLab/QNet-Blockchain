// A super node in the cabinet (owner, 11.10): the server's steps as the node and its image take them today (the
// public image, no build on the server; the provider's firewall; the phrase in a root-only file typed with no shell
// history; the server's public IPv4, which the node writes on the network at registration; absolute paths; the check,
// the failures it names, a new release and the timeline), and its status: registered, online and outside the network's
// admission (as the node names it, else outside the eligible set) reads "Registered, not admitted to consensus yet", not
// Offline (a silent one reads Offline); the eligible set as the newest certified macroblock's proof carries it; the pace
// this epoch and the heights. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEXTS } from '../texts.ts';
import { SERVER_SYNC_BLOCKS } from '../cabinet/node-view.ts';
import { ELIGIBLE_CACHE_MS, ELIGIBLE_RETRY_MS, ELIGIBLE_STALE_MS, certifiedIndex, createEligibleSet, eligibleOf } from '../../server/cabinet/eligible-set.ts';

const SRC = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// A bincode Vec<EligibleProducer{node_id: String, reputation: u32}>, as a macroblock proof's `eligible_raw` carries it.
function eligibleRaw(ids) {
  const parts = [];
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  parts.push(u64(ids.length));
  for (const id of ids) {
    const bytes = Buffer.from(id, 'utf8');
    const rep = Buffer.alloc(4);
    rep.writeUInt32LE(7000);
    parts.push(u64(bytes.length), bytes, rep);
  }
  return Buffer.concat(parts).toString('hex');
}

test('the server steps: the public image, the provider\'s firewall, the phrase typed with no history, the server\'s address, absolute paths', () => {
  const next = code('components/cabinet/NextSteps.tsx');
  const steps = next.slice(next.indexOf('export function SuperNext('), next.indexOf('function CodeCard('));
  // No clone and no build on the server: the image CI builds and publishes.
  assert.match(next, /const NODE_IMAGE = 'ghcr\.io\/aiqnetlab\/qnet-production:latest';/);
  assert.doesNotMatch(steps, /git clone|docker build|git checkout|ufw/);
  assert.match(steps, /`docker pull \$\{NODE_IMAGE\}`/);
  // The phrase in a root-only file, typed without an echo and kept out of the shell's history.
  assert.match(steps, /`install -d -m 700 \$\{NODE_DIR\}`/);
  assert.match(steps, /`\(umask 077; read -rs -p 'Recovery phrase: ' P; echo; printf %s "\$P" > \$\{NODE_DIR\}\/qnet_seed; unset P\)`/);
  assert.doesNotMatch(steps, /\$\(pwd\)|\.\/qnet_seed|your recovery phrase words/);
  // The server's public IPv4: committed at registration with no later change, so the step lists the server's own
  // addresses and takes only a dotted public IPv4, asked again until it is one; the start refuses to run without it.
  assert.match(steps, /"ip -4 -o addr show scope global \| awk '\{print \$4\}'",/);
  assert.match(steps, /"while read -r -p 'Public IPv4 address of this server: ' QNET_IP; do",/);
  assert.match(steps, /`  \[\[ \$QNET_IP =~ \^\(\$\{OCTET\}\\\\\.\)\{3\}\$\{OCTET\}\$ \]\] && ! \[\[ \$QNET_IP =~ \$\{PRIVATE_IPV4\} \]\] && break`,/);
  assert.match(steps, /"  echo 'Not a public IPv4 address\. Type it again\.'; unset QNET_IP",\s*'done',/);
  assert.match(steps, /'  -e QNET_PUBLIC_IP="\$\{QNET_IP:\?run the address step first\}" \\\\',/);
  // The ranges the step refuses, as bash reads them.
  const OCTET = new RegExp(`^${eval(next.match(/const OCTET = ('[^']*');/)[1])}$`);
  const PRIVATE = new RegExp(eval(next.match(/const PRIVATE_IPV4 = ('[^']*');/)[1]));
  const takes = (ip) => ip.split('.').length === 4 && ip.split('.').every((o) => OCTET.test(o)) && !PRIVATE.test(ip);
  for (const ip of ['8.8.4.4', '154.38.160.39', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '223.255.1.1']) assert.ok(takes(ip), ip);
  for (const ip of ['10.0.0.1', '127.0.0.1', '0.1.2.3', '169.254.1.1', '172.16.0.1', '172.31.255.1', '192.168.1.5', '100.64.1.1', '100.127.0.1', '224.0.0.1', '255.255.255.255', '256.1.1.1', '01.2.3.4', '1.2.3']) {
    assert.ok(!takes(ip), ip);
  }
  // The chain data's limit counts what the chain data already holds with the free space, so a start after an update keeps
  // the first limit; absolute paths, a log of at most 1 GB, the four ports, the code, the burn and its amount.
  assert.match(steps, /`FREE_GB=\$\(df -BG --output=avail \$\{NODE_DIR\} \| tail -n 1 \| tr -dc 0-9\)`,/);
  assert.match(steps, /`DATA_GB=\$\(du -s -BG \$\{NODE_DIR\}\/data 2>\/dev\/null \| cut -f 1 \| tr -dc 0-9\)`,/);
  assert.match(steps, /'QNET_GB=\$\(\( \(FREE_GB \+ \$\{DATA_GB:-0\}\) \* 8 \/ 10 \)\)',/);
  assert.match(steps, /'  -e QNET_MAX_STORAGE_GB="\$QNET_GB" \\\\'/);
  assert.match(steps, /'  --log-opt max-size=100m --log-opt max-file=10 \\\\'/);
  assert.match(steps, /`  -v \$\{NODE_DIR\}\/qnet_seed:\/run\/secrets\/qnet_seed:ro -e QNET_WALLET_SEED_FILE=\/run\/secrets\/qnet_seed \\\\`/);
  // The API on IPv4 only, as the operator guide and the install script publish it (an IPv6 client would reach it through
  // the container runtime's proxy, which hides its address).
  assert.match(steps, /'  -p 0\.0\.0\.0:8001:8001 -p 9876:9876 -p 9877:9877 -p 10876:10876\/udp \\\\'/);
  assert.match(readFileSync(new URL('../../../../../../scripts/install-super-node.sh', import.meta.url), 'utf8'), /^ {2}-p 0\.0\.0\.0:8001:8001$/m);
  assert.match(steps, /`  -v \$\{NODE_DIR\}\/data:\/app\/data \$\{NODE_IMAGE\}`/);
  for (const v of ['QNET_ACTIVATION_CODE="${code}"', 'QNET_BURN_TX_HASH="${burnTx}"', 'QNET_BURN_AMOUNT="${burnAmount}"']) assert.ok(steps.includes(v), v);
  // One settings list: no second block that repeats the environment.
  assert.equal(steps.match(/QNET_ACTIVATION_CODE/g)?.length, 1);
  // The check: the height, the catching up, the activation and registration lines; never node/health, which can
  // freeze (Dockerfile.production).
  assert.match(steps, /'curl -s http:\/\/localhost:8001\/healthz',\s*'curl -s http:\/\/localhost:8001\/api\/v1\/sync\/status',/);
  // The filter also names the untagged lines of a burn the network does not find and of a refused start.
  assert.match(steps, /`docker logs \$\{NODE_CONTAINER\} 2>&1 \| grep -E '\\\\\[ACTIVATION\\\\\]\|\\\\\[REG\\\\\]\|activation_code_save_failed\|blockchain_node_failed\|start_failed'`/);
  const nodeMain = readFileSync(new URL('../../../../../../development/qnet-integration/src/bin/qnet-node.rs', import.meta.url), 'utf8');
  for (const line of ['[WARN][NODE] activation_code_save_failed err=', '[ERROR][NODE] blockchain_node_failed err=', '[ERROR][NODE] start_failed err=']) assert.ok(nodeMain.includes(line), line);
  assert.doesNotMatch(steps, /node\/health/);
  // A new release: pull it, stop and remove the container, then the address and start steps again.
  assert.match(steps, /const update = `docker pull \$\{NODE_IMAGE\}\\ndocker stop -t 60 \$\{NODE_CONTAINER\} && docker rm \$\{NODE_CONTAINER\}`;/);
  for (const key of ['super_step_server', 'super_step_firewall', 'super_step_seed', 'super_step_dedicated', 'super_step_ip', 'super_step_start', 'super_step_check', 'super_step_errors', 'super_step_update', 'super_step_joined']) {
    assert.ok(steps.includes(`t('${key}')`), key);
  }
  assert.ok(!('super_step_build' in TEXTS));
  // The texts say what the node does: the memory it checks at start, the firewall it cannot see, the address it
  // commits, the log lines it writes, the heartbeats an epoch needs.
  assert.match(TEXTS.super_step_server, /x86-64/);
  assert.match(TEXTS.super_step_server, /at least 4,000 MB of memory/);
  assert.match(TEXTS.super_step_firewall, /hosting provider's firewall, allow TCP ports 8001, 9876 and 9877 and UDP port 10876/);
  assert.match(TEXTS.super_step_firewall, /the node cannot tell when they are closed/);
  assert.match(TEXTS.super_step_ip, /the network then takes this node's connections from that address only; it cannot be changed after the node registers\./);
  assert.match(TEXTS.super_step_start, /the free space and what the chain data already holds, so a later start keeps the same limit:$/);
  assert.doesNotMatch(TEXTS.super_step_start, /free now/);
  assert.match(TEXTS.super_step_errors, /After a fix, run the update step's commands, then the address and start steps again\.$/);
  for (const line of ['code_verified', 'burn_verified_onchain', 'convergence_done', 'registration=onchain']) assert.ok(TEXTS.super_step_check.includes(line), line);
  for (const line of ['mnemonic_mismatch', 'burn_not_found_on_solana', 'missing_burn_env_vars', 'Insufficient RAM']) assert.ok(TEXTS.super_step_errors.includes(line), line);
  assert.match(TEXTS.super_step_joined, /at least 9 of its 10 heartbeats, one about every 24 minutes/);
  assert.doesNotMatch(TEXTS.super_step_joined, /joins the network/);
  // The log lines and limits named are the node's own.
  const repo = (path) => readFileSync(new URL(`../../../../../../${path}`, import.meta.url), 'utf8');
  const activation = repo('development/qnet-integration/src/node/activation.rs');
  for (const line of ['code_verified', 'burn_verified_onchain', 'burn_not_found_on_solana', 'mnemonic_mismatch', 'missing_burn_env_vars', 'convergence_done id={} registration=onchain']) {
    assert.ok(activation.includes(line), line);
  }
  assert.match(repo('development/qnet-integration/src/node/lifecycle.rs'), /const MIN_RAM_SERVER_MB: u64 = 4_000;/);
  // The node id the log names, shown with the steps once known.
  assert.match(steps, /\{nodeId && <p className="note">\{t\('super_step_node_id', \{ id: nodeId \}\)\}<\/p>\}/);
  assert.match(code('components/cabinet/NodeDetails.tsx'), /<SuperNext code=\{facts\.code\} burnTx=\{facts\.burnTx\} burnAmount=\{facts\.amount\} nodeId=\{nodeId\} \/>/);
});

test('the eligible set: the newest certified macroblock\'s, from its proof, kept for every reader, the next node when one fails', async () => {
  assert.equal(certifiedIndex({ proof_format: 2, newest_certified_index: 38_948 }), 38_948);
  for (const bad of [{ proof_format: 1, newest_certified_index: 5 }, { proof_format: 2 }, { proof_format: 2, newest_certified_index: -1 }, null, 'x']) {
    assert.equal(certifiedIndex(bad), null, JSON.stringify(bad));
  }
  const ids = ['genesis_node_001', 'super_node_22020ba893c62e34'];
  assert.deepEqual([...eligibleOf({ index: 7, eligible_raw: eligibleRaw(ids) }, 7)], ids);
  for (const bad of [{ index: 8, eligible_raw: eligibleRaw(ids) }, { index: 7 }, { index: 7, eligible_raw: 'zz' }, { index: 7, eligible_raw: '' }, { index: 7, eligible_raw: '0100' }]) {
    assert.equal(eligibleOf(bad, 7), null, JSON.stringify(bad));
  }
  let t = 1_000_000;
  const calls = [];
  const answers = {
    'https://a.test': { head: { proof_format: 2, newest_certified_index: 7 }, proof: null },
    'https://b.test': { head: { proof_format: 2, newest_certified_index: 7 }, proof: { index: 7, eligible_raw: eligibleRaw(ids) } },
  };
  const fetchFn = async (url) => {
    calls.push(url);
    const base = new URL(url).origin;
    const a = answers[base];
    const body = url.endsWith('/api/v1/state/certified') ? a.head : url.endsWith('/api/v1/macroblock/7/proof') ? a.proof : null;
    return body === null ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  };
  const set = createEligibleSet({ fetchFn, nodes: ['https://a.test', 'https://b.test'], random: () => 0.999, now: () => t });
  assert.deepEqual([...(await set())], ids);
  // The first node's proof failed, the second answered; the set is then kept for every reader.
  assert.deepEqual(calls, ['https://a.test/api/v1/state/certified', 'https://a.test/api/v1/macroblock/7/proof', 'https://b.test/api/v1/state/certified', 'https://b.test/api/v1/macroblock/7/proof']);
  await set();
  assert.equal(calls.length, 4);
  // The refresh behind runs on its own: wait for its reads, then for it to settle.
  const settle = async (n) => {
    for (let i = 0; i < 500 && calls.length < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  t += ELIGIBLE_CACHE_MS + 1;
  // Kept long enough: served at once while one read refreshes it behind, the failing node first in this order.
  assert.deepEqual([...(await set())], ids);
  await settle(8);
  assert.equal(calls.length, 8, 'read again once kept long enough');
  // A refresh that fails keeps the last set in use, read again after ELIGIBLE_RETRY_MS, until ELIGIBLE_STALE_MS.
  answers['https://b.test'].proof = null;
  t += ELIGIBLE_CACHE_MS + 1;
  assert.deepEqual([...(await set())], ids);
  await settle(12);
  assert.equal(calls.length, 12);
  assert.deepEqual([...(await set())], ids);
  assert.equal(calls.length, 12, 'no new read before ELIGIBLE_RETRY_MS');
  t += ELIGIBLE_STALE_MS;
  assert.equal(await set(), null, 'too old to serve, and the read fails');
  // No node answers: unknown, asked again after a short while.
  let tries = 0;
  const none = createEligibleSet({ fetchFn: async () => { tries += 1; return new Response('', { status: 503 }); }, nodes: ['https://a.test'], now: () => t });
  assert.equal(await none(), null);
  assert.equal(await none(), null);
  assert.equal(tries, 1);
  t += ELIGIBLE_RETRY_MS;
  assert.equal(await none(), null);
  assert.equal(tries, 2);
  assert.ok(ELIGIBLE_RETRY_MS < ELIGIBLE_CACHE_MS && ELIGIBLE_CACHE_MS < ELIGIBLE_STALE_MS);
  // The reads share the read budget of ids seen registered, and nothing of a visitor goes with them.
  const src = code('server/cabinet/eligible-set.ts');
  assert.match(src, /`\$\{base\}\/api\/v1\/state\/certified`/);
  assert.match(src, /`\$\{base\}\/api\/v1\/macroblock\/\$\{index\}\/proof`/);
  assert.match(src, /if \(!budget\('readKnown', url\)\) return null;/);
});

test('the status rows: not admitted to consensus yet instead of Offline, the pace this epoch, the heights', async () => {
  const rows = code('components/cabinet/NodeStatus.tsx');
  const sup = rows.slice(rows.indexOf('export function SuperRows('));
  assert.match(rows, /export function superBadge\(status: SuperStatusView\): Badge \{\s*const state = superState\(status\);\s*if \(state === 'waiting'\) return \{ tone: 'quiet', word: 'badge_waiting', text: 'super_waiting' \};/);
  assert.match(sup, /const state = superState\(status\);/);
  // The note says why: the node's own admission (its epochs add nothing until it is admitted), else the eligible set.
  assert.match(sup, /\{state === 'waiting' && <p className="note">\{t\(status\.admission === 'waiting' \? 'super_waiting_note' : 'super_waiting_set_note'\)\}<\/p>\}/);
  assert.match(sup, /\{status\.onPace !== null && <Fact label=\{t\('super_pace_label'\)\}>\{t\(status\.onPace \? 'super_on_pace' : 'super_behind'\)\}<\/Fact>\}/);
  // Each height is a link to its block.
  assert.match(sup, /behind <= SERVER_SYNC_BLOCKS \? rich\('super_height_synced', \{ height \}\)/);
  assert.match(sup, /return network === null \? null : <Fact label=\{t\('super_height_label'\)\}>\{rich\('super_height_network', \{ height: <EntityLink kind="block" value=\{network\} \/> \}\)\}<\/Fact>;/);
  // A last-seen time older than half a day names its day (format.ts clockAgo, the site's one clock).
  assert.match(sup, /\{status\.lastSeenAt === null \? t\('super_not_known'\) : clockAgo\(status\.lastSeenAt, Date\.now\(\)\)\}/);
  const { clockAgo } = await import('../format.ts');
  const now = Date.UTC(2026, 9, 19, 12, 0);
  assert.match(clockAgo(now - 3_600_000, now), /^\d\d:\d\d$/);
  assert.match(clockAgo(now - 13 * 3_600_000, now), /^[A-Z][a-z]{2} \d{1,2}, \d\d:\d\d$/);
  assert.equal(SERVER_SYNC_BLOCKS, 5);
  assert.equal(TEXTS.super_waiting, 'Registered, not admitted to consensus yet');
  assert.match(TEXTS.super_waiting_note, /has not admitted it to consensus yet: until it does, its epochs add nothing to the node balance and show as not admitted\./);
  assert.match(TEXTS.super_waiting_set_note, /does not have it among the nodes that confirm its blocks yet\./);
  for (const key of ['super_waiting_note', 'super_waiting_set_note']) assert.match(TEXTS[key], /Its node balance stays this wallet's to move\.$/);
  // Not registered yet: said so on the Overview and the Device tab, and that the network sees the server when it does;
  // the burned super node's steps say it too.
  assert.match(code('components/cabinet/NodeHome.tsx'), /\{status\.registered \? <SuperFacts status=\{status\} \/> : <p>\{t\(status\.connected \? 'super_connected' : 'super_not_yet'\)\}<\/p>\}/);
  assert.match(code('components/cabinet/NodeDevices.tsx'), /\(state\.value\.registered \? <SuperRows status=\{state\.value\} \/> : <p>\{t\(state\.value\.connected \? 'super_connected' : 'super_not_yet'\)\}<\/p>\)/);
  assert.match(code('components/cabinet/NextSteps.tsx'), /\{view\.superConnected && <Answered>\{t\('super_connected'\)\}<\/Answered>\}/);
  // The node balance stays on the Overview for every registered super node, waiting or not, with Move to wallet for the
  // wallet's own super node (owner, 12.10).
  const home = code('components/cabinet/NodeHome.tsx');
  const overview = home.slice(home.indexOf('function SuperOverview('), home.indexOf('function Overview('));
  assert.match(overview, /<Balance nodeId=\{nodeId\} balanceNano=\{status\.balanceNano\}>/);
  assert.match(overview, /<Move\s+qnet=\{choice\.qnet\}\s+nodeId=\{nodeId\}/);
});
