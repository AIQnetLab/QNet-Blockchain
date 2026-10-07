// What the public documents say about the phone, the node cabinet, the extension and the SDK, pinned to what the
// code does (final audit, 27.09: SITE-12, SD-02 to SD-09, DEV-R1-01, DEV-R1-09, DEV-R1-10, SITE-R1-08, DEVP-R1-01, DEVP-R1-02,
// DEVP-R1-04, DEVP-R1-07; round 2 of the shared lane: EXT-R2A-04, SD-R2-02 to SD-R2-11, DEVP-R2-01, DEVP-R2-02; round 3:
// SD-R3-03 to SD-R3-08, DEVP-R3-01 to DEVP-R3-05; round 4: SITE-R4-02, DEVP-R4-01 to DEVP-R4-04).
// No dependencies.
// Run: node --test docs/tools/docs-claims.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(REPO, file), 'utf8').replace(/\r\n/g, '\n');
const flat = (file) => read(file).replace(/\s+/g, ' ');

// Every official text this lane owns: the documentation set and the README files next to the code.
function markdownUnder(dir) {
  const out = [];
  for (const name of readdirSync(path.join(REPO, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(REPO, rel)).isDirectory()) out.push(...markdownUnder(rel));
    else if (name.endsWith('.md')) out.push(rel);
  }
  return out;
}
const OFFICIAL = [
  ...markdownUnder('docs'),
  'README.md', 'CONTRIBUTING.md', 'contracts/README.md', 'development/qnet-sdk/README.md',
  'development/qnet-contracts/examples/README.md', 'applications/qnet-mobile/README.md',
  'applications/qnet-mobile/store-listing/README.md',
];

// The published protocol material beside the documents: the vectors and the generators that write them.
const PROTOCOL_DATA = readdirSync(path.join(REPO, 'docs/protocols'), { recursive: true })
  .map((f) => path.join('docs/protocols', String(f)))
  .filter((f) => /\.(json|mjs)$/.test(f));

// The names this guard looks for are kept as the first 16 hex digits of the SHA-256 of the lowercased word with its
// hyphens removed, so the test names no other project, chain, wallet or standard itself (SD-R3-06).
const OTHER_NAMES = new Set([
  '875c419dda3fbadd', '23b76c9915cf03ba', '48ab6b4022b4e60b', '9e4168bc57766ef9', 'c47b520df6807249', 'b60d7bdd334cd376',
  '6b88c087247aa2f0', '349ea085e7c763ad', '6d9b0b4b9994e8a6', 'f80f21938e5248ec', '56549e77eb4bb62f', '603871c2ddd41c26',
  '47eeb2eac350e192', 'aa5faecf9acc9ea8', '90ff5a60f8fbcb4b', '265f679dfb100f26', 'c202ee6e86d74873',
]);
const nameTag = (word) => createHash('sha256').update(word.toLowerCase().replace(/-/g, '')).digest('hex').slice(0, 16);
// Words of a text that are such a name. A dependency is named by its scoped package (in a list of libraries), which is
// left out; prose names none.
const otherNames = (text) => [...new Set(text.replace(/@[a-z0-9-]+\/[a-z0-9.-]+/gi, ' ').match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) ?? [])]
  .filter((w) => OTHER_NAMES.has(nameTag(w)));

test('SD-09, SD-R2-08, SD-R3-06: no other project or standard is named in the official texts, the vectors or this test', () => {
  assert.ok(PROTOCOL_DATA.length >= 4, PROTOCOL_DATA.join(', '));
  for (const file of [...OFFICIAL, ...PROTOCOL_DATA, 'docs/tools/docs-claims.test.mjs']) {
    assert.deepEqual(otherNames(read(file)), [], file);
  }
  // A scoped package in a list of libraries passes; the same word in prose does not.
  const pkg = '@scure/bip39';
  assert.deepEqual(otherNames(`the \`${pkg}\` package`), []);
  assert.equal(otherNames(`the word list of \`${pkg}\`, called ${pkg.split('/')[1]}`).length, 1);
  const wallets = JSON.parse(read('docs/protocols/light-node.vectors.json')).wallets;
  assert.ok(wallets.length > 0 && wallets.every((w) => /^[0-9a-f]{128}$/.test(w.phraseSeedHex)));
  assert.match(flat('applications/qnet-mobile/store-listing/README.md'), /the push channel \(the FCM push token\)/);
  assert.match(flat('docs/protocols/light-node-messages.md'),
    /hex of the 64-byte seed of the recovery phrase \(PBKDF2-HMAC-SHA512 of the phrase's NFKD text, salt `mnemonic`, 2048 rounds/);
});

test('DEV-R1-01: the SDK is @aiqnet/sdk, installed from a file built here, never by name from the registry', () => {
  const pkg = JSON.parse(read('development/qnet-sdk/package.json'));
  assert.equal(pkg.name, '@aiqnet/sdk');
  assert.equal(pkg.scripts.prepack, 'node scripts/pin-check.mjs && node build.mjs');
  for (const file of [...OFFICIAL, 'development/qnet-sdk/src/index.ts', 'development/qnet-sdk/src/node.ts']) {
    assert.doesNotMatch(read(file), /@qnet\//, file);
  }
  for (const file of ['docs/developers/sdk.md', 'development/qnet-sdk/README.md']) {
    const text = flat(file);
    assert.match(text, /not published to the npm registry/, file);
    assert.match(text, /npm install \/path\/to\/aiqnet-sdk-2\.0\.0\.tgz/, file);
  }
});

test('SITE-12: the protocol states when the page takes a wallet without the check number, and why', () => {
  const p = flat('docs/protocols/qnet-link-v1.md');
  assert.match(p, /`false` for a request the page opened with its button on the same device, whether or not it knows a wallet/);
  assert.match(p, /the request was opened by the page's button on the same device \(never shown as a QR\), so only QNet Wallet on this device could answer it/);
  assert.match(p, /An answer to a request that was shown as a QR, from a wallet the page did not hold, is never taken without the check number/);
  // The finishing request of a kept payment burn, from any browser: the wallet named, its answer only (NextSteps.tsx FinishLight).
  assert.match(p, /The request that finishes, in any other browser, the registration of a burn whose owner bind aiqnet\.io keeps names the wallet with `check: false` and takes that wallet's answer only, by its full address/);
  const steps = read('applications/qnet-explorer/frontend/src/components/cabinet/NextSteps.tsx');
  assert.match(steps, /const named: LinkDeviceRequest = \{ burnTx: burn\.burnTx, walletHash: walletHash\(qnet\), check: false \};/);
  assert.match(steps, /answer\.qnet === qnet && !!answer\.consent && asked\?\.burnTx === burn\.burnTx/);
  // A burn from the wallet's own Solana address, from any browser: the same request with the burner, whose bind the answer carries.
  assert.match(p, /the page names the wallet with `check: false` and the burner, takes that wallet's answer only, by its full address, and only with an `ownerSig` that verifies/);
  assert.match(steps, /const request: LinkDeviceRequest = burner === null \? named : \{ \.\.\.named, burner \};/);
  assert.match(steps, /&& \(asked\.burner \?\? null\) === burner;/);
  assert.match(p, /A request opened by the page's button on the same device needs neither/);
});

test('SD-07: revision 1 keeps only what is implemented: no app burn, one package, activate through the extension only', () => {
  const p = flat('docs/protocols/qnet-link-v1.md');
  assert.doesNotMatch(p, /com\.qnetmobile/);
  assert.doesNotMatch(p, /Recover code|Activate on this phone|## 8\. App behaviour|the app as a sealed record|its Node tab refuses the code/);
  assert.doesNotMatch(p, /"intent": "activate", "nodeType": "light"/);
  assert.match(p, /\| `activate` \| the extension's `qnet_activateNode` only \(section 10\) \|/);
  assert.match(p, /No relay session and no app takes it: the relay refuses an `activate` session \(section 14\.5\)/);
  assert.match(p, /\| Android package \| `io\.aiqnet\.wallet` \(section 14\.2\) \|/);
  const v = JSON.parse(read('docs/protocols/qnet-link-v1.vectors.json'));
  assert.deepEqual(v.constants.androidPackages, ['io.aiqnet.wallet']);
  assert.ok(v.androidIntents.every((a) => a.package === 'io.aiqnet.wallet' && a.browserFallbackUrl === a.link));
});

test('SD-05, SD-06: the README, the operator guide and the economics describe the cabinet, the extension and one device', () => {
  for (const file of ['README.md', 'applications/qnet-mobile/README.md', 'docs/economics/node-activation.md',
    'docs/operators/running-a-node.md', 'docs/economics/tokenomics-1dev.md', 'docs/applications/mobile-wallet.md',
    'QNet_Whitepaper.md']) {
    const text = flat(file);
    for (const gone of [/aiqnet\.io\/activate/, /at most 3 devices|Maximum 3 devices|3 devices per/, /Created client-side by the mobile wallet/,
      /enters or recovers the code/, /Recover code/, /mobile Node tab/, /the mobile app, only for an activation request/,
      /Client-initiated from the mobile wallet/, /\| Up to 3 \|/]) {
      assert.doesNotMatch(text, gone, `${file}: ${gone}`);
    }
  }
  assert.match(flat('README.md'), /one device per Light node/);
  assert.match(flat('README.md'), /QNet Wallet on a phone or tablet signs the wallet's consent to the registration and links the node to its device/);
  assert.match(flat('applications/qnet-mobile/README.md'), /The app gives the wallet's consent to that registration and links the node to this device/);
  const activation = flat('docs/economics/node-activation.md');
  assert.match(activation, /burns in the browser with a one-time payment key it creates there/);
  assert.match(activation, /\*\*One device per Light node\.\*\*/);
  assert.match(activation, /by the node cabinet after its payment key's burn, with the wallet's consent that QNet Wallet signed on its link sheet/);
  assert.doesNotMatch(activation, /stateless XOR code-ownership match/);
  assert.match(flat('docs/operators/running-a-node.md'), /The cabinet's one-time payment key burns for Light nodes only\./);
  assert.match(flat('docs/economics/tokenomics-1dev.md'), /Activation burns are made in two places/);
});

// SD-R3-05: the documents describe what the app does (it signs the wallet's consent, links the node to its device,
// moves the node balance) and deny nothing; the denials a reviewer needs stay in the store notes and in the protocol's
// normative app rules (qnet-link-v1.md section 14.8).
test('SD-R3-05: the documents say what the app does, never what it does not', () => {
  const denial = /makes no burn|performs no burn|takes no code|sells nothing|burns nothing/;
  for (const file of OFFICIAL.filter((f) => f !== 'applications/qnet-mobile/store-listing/README.md'
    && !f.startsWith(path.join('docs', 'protocols')) && !f.startsWith('docs/protocols'))) {
    assert.doesNotMatch(flat(file), denial, file);
  }
  assert.doesNotMatch(flat('THIRD_PARTY_NOTICES.md'), denial);
  assert.match(flat('docs/operators/running-a-node.md'), /The app links the node to its device \("Use this device"\) and moves the node balance\./);
  assert.match(flat('docs/economics/node-activation.md'), /The \[mobile wallet\]\([^)]*\) signs the wallet's consent to a Light registration and runs the node on its device\./);
  // The protocol keeps its normative app rules.
  assert.match(flat('docs/protocols/qnet-link-v1.md'), /9\. The app's screens name no price, burn, payment or activation code\./);
});

test('SD-04: the file from aiqnet.io runs the wallet; the node needs Google Play\'s licence', () => {
  const doc = flat('docs/applications/mobile-wallet.md');
  assert.doesNotMatch(doc, /with the same signature and the same features/);
  assert.doesNotMatch(doc, /Nothing a user sees or can do depends on the store/);
  assert.match(doc, /A copy from aiqnet\.io runs the whole wallet; to run the node it must be licensed too/);
  assert.match(flat('applications/qnet-mobile/store-listing/README.md'), /Running the node needs Google Play's licence for the install/);
  assert.match(flat('docs/protocols/light-node-messages.md'), /On Android a `store` install also needs Google Play's licence \(`device_unlicensed` otherwise\)/);
});

test('SD-02: Data safety declares the app-access-risk verdict, and the release turns it on', () => {
  const readme = flat('applications/qnet-mobile/store-listing/README.md');
  assert.match(readme, /\| App activity → Installed apps \| Collected \*\*only while a node is linked, on Android\*\*: Google Play's app-access-risk verdict/);
  // The node's report of its wake-ups is the one App interactions and Diagnostics entry; nothing else of either is.
  assert.match(readme, /\| App activity → App interactions \| Collected \*\*only while a node is linked\*\*/);
  assert.match(readme, /\| App info and performance → Diagnostics \| Collected \*\*only while a node is linked\*\*/);
  assert.match(readme, /App activity \(other than above\) \/ App info and performance \(other than above\) \| Not collected/);
  assert.match(readme, /turn on the app-access-risk verdict \("environment details"\)/);
});

// SD-R2-01: the Data safety answer follows what the device service keeps. It seals Google's whole decoded verdict
// (environmentDetails with it) into its evidence, 7 days for an accepted case and 90 for a refused, suspect or paused
// one, so the verdict is not processed ephemerally.
test('SD-R2-01: the Data safety answer for the verdict matches the device service\'s evidence', () => {
  const readme = flat('applications/qnet-mobile/store-listing/README.md');
  const service = read('development/qnet-device-oracle/src/service.rs');
  const evidence = read('development/qnet-device-oracle/src/evidence.rs');
  const keepsVerdict = /"verdict":\s*pi\.as_ref\(\)\.and_then\(\|d\| serde_json::from_slice::<Value>\(&jws_payload\(&d\.jws\)\)/.test(service);
  if (keepsVerdict) {
    assert.doesNotMatch(readme, /\*\*Processed ephemerally\*\*|keeps none of (the verdict's|its) labels/);
    assert.match(readme, /\*\*Not processed ephemerally\*\*: the device service decides only on whether the verdict is present, and keeps it with its labels, sealed, 7 days \(up to 90 days for a refused, suspect or paused case\)/);
    assert.match(readme, /It keeps Google's whole decoded answer, the verdict's labels included, in its sealed evidence/);
    assert.match(evidence, /pub const ACCEPTED_KEEP: u64 = 7 \* DAY;/);
    assert.match(evidence, /pub const REVIEW_KEEP: u64 = 90 \* DAY;/);
  } else {
    // The service stopped keeping the decoded verdict: the answer must say what it keeps now.
    assert.doesNotMatch(readme, /keeps it with its labels/, 'the device service no longer keeps the verdict: update Data safety');
  }
});

// SITE-R2-12: an unfinished cabinet activation keeps its payment key 24 hours only before a burn; after one, only to
// send back what is left, while the burn stays the wallet's record (flow.ts KEY_LIFETIME_MS, isExpired, GIVE_BACK,
// mayReturnLeftovers; activation.ts keepsEmptyKey), as the privacy page says.
test('SITE-R2-12: the payment key\'s lifetime is stated as the cabinet keeps it', () => {
  const flow = read('applications/qnet-explorer/frontend/src/lib/cabinet/flow.ts');
  assert.match(flow, /export const KEY_LIFETIME_MS = 24 \* 60 \* 60 \* 1000;/);
  assert.match(flow, /const GIVE_BACK = \{ returnLeftovers: 'closing' \} as const;/);
  assert.match(flow, /burnFinal: \{ linkStarted: 'linkOpen', \.\.\.GIVE_BACK \}/);
  assert.doesNotMatch(flow, /abandon/);
  const activation = flat('docs/economics/node-activation.md');
  assert.doesNotMatch(activation, /keeps it in the same browser for up to 24 hours, after which the cabinet refunds/);
  assert.doesNotMatch(activation, /no clock ends it|gives the burn up/);
  assert.match(activation, /Before a burn the key lives at most 24 hours in the same browser/);
  assert.match(activation, /After a burn the key is kept only to send back what is left, once the network records the node or at once when the user asks: the burn is the wallet's activation for good/);
  assert.match(activation, /burned 1DEV never comes back/);
  assert.match(activation, /On mainnet a payment address with nothing on it keeps its key until the user deletes it/);
  const explorer = flat('docs/applications/explorer.md');
  assert.doesNotMatch(explorer, /lives until the node is recorded, at most 24 hours from the start/);
  assert.doesNotMatch(explorer, /no clock ends it/);
  assert.match(explorer, /Before a burn the payment address's key lives at most 24 hours from the start\. After a burn it is kept only to send back what is left/);
});

// SD-R2-06, SD-R2-07: a refreshed push token goes to genesis nodes only; no environment variable names a node's address.
test('SD-R2-06, SD-R2-07: push tokens reach genesis nodes only, and no document names an unread variable', () => {
  const push = read('applications/qnet-mobile/src/services/PushService.js');
  assert.match(push, /for \(const url of \[\.\.\.owners, \.\.\.GENESIS_NODES\.filter\(\(u\) => !owners\.includes\(u\)\)\]\)/);
  const mobile = flat('docs/applications/mobile-wallet.md');
  assert.doesNotMatch(mobile, /to a random node only if every owner fails/);
  assert.match(mobile, /A refreshed FCM token is sent to the node's shard owners in rank order, then to the other genesis nodes; never to another node/);
  assert.match(mobile, /A push names no address to answer at; the app answers the node's shard owners by name/);
  for (const file of OFFICIAL) assert.doesNotMatch(read(file), /QNET_PUBLIC_RPC_URL|where an earlier roll set it/, file);
});

// SD-R2-09: no store text of an earlier build is left in the Play metadata, and What's new says what this build does.
test('SD-R2-09: the Play changelogs name no update check and describe the unlock as it is', () => {
  const dir = 'fastlane/metadata/android/en-US/changelogs';
  const files = readdirSync(path.join(REPO, dir));
  assert.ok(!files.includes('18.txt'), 'changelog 18 describes an update check no build has');
  for (const f of files) {
    assert.doesNotMatch(read(path.join(dir, f)), /update|GitHub|download|every phone/i, f);
  }
  const code = /versionCode (\d+)/.exec(read('applications/qnet-mobile/android/app/build.gradle'))[1];
  assert.match(read(path.join(dir, `${code}.txt`)), /Unlock with the device's screen lock where it has one, otherwise with a password/);
});

// SD-R2-13: the protocol says what a licensed store install on Android also needs, and the refusal it gets without it.
test('SD-R2-13: the protocol names the app-access-risk verdict a licensed store install needs', () => {
  const play = read('core/qnet-device-attest/src/play.rs');
  assert.match(play, /require_app_access_risk: true,/);
  assert.match(play, /v\.pointer\("\/environmentDetails\/appAccessRiskVerdict"\)\.is_some\(\)/);
  assert.match(play, /return Err\(Refusal::FormFactorUnevaluated\);/);
  const lib = read('core/qnet-device-attest/src/lib.rs');
  assert.match(lib, /PlatformRefused \| DesktopFlags \| FormFactor \| FormFactorUnevaluated => Reason::Desktop,/);
  assert.match(lib, /FormFactorUnevaluated => "form_factor_unevaluated",/);
  const p = flat('docs/protocols/light-node-messages.md');
  assert.match(p, /The verdict of a licensed `store` install must also carry Google's app-access-risk verdict \(`environmentDetails\.appAccessRiskVerdict`\)/);
  assert.match(p, /without it the device is refused with `device_desktop` \(log code `form_factor_unevaluated`\)/);
  assert.match(p, /An install whose licence Google did not evaluate \(`UNEVALUATED`\) passes without it, on the one-day lease/);
  assert.match(flat('applications/qnet-mobile/store-listing/README.md'), /refuses a licensed Android install whose integrity verdict lacks it \(`device_desktop`/);
});

// DEV-R2-01: every rate-limit bucket the node defines has its row, with the node's numbers.
test('DEV-R2-01: the rate-limit table is the node\'s ApiRateLimiter', () => {
  const rpc = read('development/qnet-integration/src/rpc/mod.rs');
  const configs = new Map([...rpc.matchAll(
    /configs\.insert\("([a-z_]+)"\.to_string\(\), RateLimitConfig \{\s*max_requests: (\w+),\s*window_seconds: (\d+),\s*block_duration: (\d+),?\s*\}\);/g,
  )].map((m) => [m[1], { max: m[2], window: m[3], block: m[4] }]));
  // Every bucket the node inserts is read, so a bucket in a shape this pattern misses fails here.
  const inserts = (rpc.match(/configs\.insert\(/g) ?? []).length;
  assert.ok(configs.size > 0 && configs.size === inserts, `${configs.size} of ${inserts} buckets read from mod.rs`);
  const doc = read('docs/developers/rpc-api.md');
  const table = doc.slice(doc.indexOf('| Category | Requests | Window | Block duration | Used by |'), doc.indexOf('`tx_rate` is `QNET_API_RATE_LIMIT`'));
  const rows = new Map([...table.matchAll(/^\| `([a-z_]+)` \| ([^|]+) \| (\d+) s \| (\d+) s \|/gm)]
    .map((m) => [m[1], { max: m[2].trim(), window: m[3], block: m[4] }]));
  assert.deepEqual([...rows.keys()].sort(), [...configs.keys()].sort());
  for (const [name, c] of configs) {
    const row = rows.get(name);
    assert.deepEqual([name, row.window, row.block], [name, c.window, c.block]);
    if (/^\d+$/.test(c.max)) assert.equal(row.max, c.max, name);
  }
  // The buckets that scale with QNET_API_RATE_LIMIT, stated as the node computes them.
  for (const [name, variable, expr, code] of [
    ['transaction', 'tx_rate', '`tx_rate` (default 100)', /\.map\(\|v: u32\| v\.clamp\(1, 10_000\)\)[^\n]*\n\s*\.unwrap_or\(100\);/],
    ['general', 'general_rate', '`max(tx_rate, 100)`', /let general_rate = std::cmp::max\(tx_rate, 100\);/],
    ['read_only', 'read_rate', '`max(tx_rate * 3, 300)`', /let read_rate = std::cmp::max\(tx_rate \* 3, 300\);/],
  ]) {
    assert.match(rpc, code, name);
    assert.deepEqual([name, configs.get(name).max, rows.get(name).max], [name, variable, expr]);
  }
  // The failed-request row: light_bind.rs's FailLimiter, one per route, and the per-node limits a verified request meets.
  const bind = read('development/qnet-integration/src/rpc/light_bind.rs');
  const unbind = read('development/qnet-integration/src/rpc/light_unbind.rs');
  assert.match(bind, /const ROUTE_FAILS_MAX: usize = 60;\nconst ROUTE_FAILS_WINDOW_SECS: u64 = 60;\nconst ROUTE_FAILS_BLOCK_SECS: u64 = 60;/);
  for (const route of ['BIND', 'UNBIND', 'TOKEN_REFRESH']) {
    assert.match(bind, new RegExp(`static ${route}_FAIL_LIMIT: FailLimiter =\\s*FailLimiter::new\\(ROUTE_FAILS_MAX, ROUTE_FAILS_WINDOW_SECS, ROUTE_FAILS_BLOCK_SECS\\);`), route);
  }
  assert.match(bind, /static BIND_NODE_LIMIT: KeyedLimiter = KeyedLimiter::new\(5, 3600\);/);
  assert.match(unbind, /static UNBIND_NODE_LIMIT: KeyedLimiter = KeyedLimiter::new\(5, 3600\);/);
  assert.match(bind, /static TOKEN_REFRESH_NODE_LIMIT: KeyedLimiter = KeyedLimiter::new\(6, 3600\);/);
  assert.match(table, /^\| failed light requests \(`FailLimiter`, one per route\) \| 60 refusals \| 60 s \| 60 s \| [^\n]*\(bind and unbind 5 an hour, the token refresh 6\) \|$/m);
});

// The explorer doc's production host: the deploy and its update script each make CABINET_READ_KEY and FAUCET_PASS_KEY
// once in .env.local, before the site starts, keep a value of exactly 64 lowercase hex digits and replace any other.
test('the deploy script makes both pass keys once and keeps them, as the explorer doc says', () => {
  const script = read('deployment/deploy-aiqnet.sh');
  const provision = script.slice(script.indexOf('chmod 600 .env.local'), script.indexOf('sudo -u $APP_USER -H pm2 start ecosystem.config.js'));
  const update = script.slice(script.indexOf("cat > /root/update-aiqnet.sh << 'EOF'"), script.indexOf('sudo -u $APP_USER -H pm2 restart aiqnet-explorer'));
  const made = (key, file) => `grep -Eq '^${key}=[0-9a-f]{64}\\$' ${file} || { sed -i '/^${key}=/d' ${file}; `
    + `echo ${key}=\\$(openssl rand -hex 32) >> ${file}; }`;
  for (const key of ['CABINET_READ_KEY', 'FAUCET_PASS_KEY']) {
    assert.ok(provision.includes(made(key, '.env.local')), `${key}: provisioning`);
    assert.ok(update.includes(made(key, '$APP_DIR/applications/qnet-explorer/frontend/.env.local')), `${key}: update script`);
  }
  const doc = flat('docs/applications/explorer.md');
  assert.match(doc, /The script and `\/root\/update-aiqnet\.sh` each write `CABINET_READ_KEY` and `FAUCET_PASS_KEY` there \(`openssl rand -hex 32`\) unless the file already holds one of exactly 64 lowercase hex digits, which they keep \(any other value of either is replaced\)/);
  assert.match(doc, /\| `FAUCET_PASS_KEY` \| 32 bytes or more in hex \(`openssl rand -hex 32`, set once in `\.env\.local`; `deploy-aiqnet\.sh` makes it once and keeps it\)/);
});

// DEV-R2-02: every fenced block in the official texts closes on a line of its own.
test('DEV-R2-02: code fences open and close cleanly', () => {
  for (const file of OFFICIAL) {
    let open = null;
    read(file).split('\n').forEach((line, i) => {
      const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m) return;
      const [, run, rest] = m;
      const where = `${file}:${i + 1}`;
      if (open === null) {
        assert.ok(!(run[0] === '`' && rest.includes('`')), `${where}: a fence line with a backtick after it`);
        open = run;
      } else if (run[0] === open[0] && run.length >= open.length) {
        assert.equal(rest.trim(), '', `${where}: text after a closing fence`);
        open = null;
      }
    });
    assert.equal(open, null, `${file}: a code block never closes`);
  }
});

// DEV-R2-03: the burn verification names what the node compares the fee payer with, and the owner bind that names the
// beneficiary (registration_door.rs check_client_submit).
test('DEV-R2-03: the burn contract document describes the fee payer and the owner bind as the node checks them', () => {
  const door = read('development/qnet-integration/src/rpc/registration_door.rs');
  for (const code of ['burn_wallet_or_owner_sig_missing', 'owner_signature_invalid', 'wallet_not_derived']) assert.ok(door.includes(`"${code}"`), code);
  assert.match(door, /burn_owner_bind_message\(/);
  const burn = flat('docs/developers/1dev-burn-contract.md');
  assert.doesNotMatch(burn, /to equal the registering wallet\. A mismatch fails verification, so one burn cannot be presented by a second wallet/);
  assert.match(burn, /Requires `accountKeys\[0\]`, the fee payer that signed the Solana transaction, to equal the burning Solana address the request names: `burn_wallet` of a light-node registration \(the extension's own Solana address, or the cabinet's one-time payment key\)/);
  assert.match(burn, /`burn_owner_bind_message\(node_id, wallet_address, registration_proof, timestamp, wallet key, burn_tx\)`/);
  assert.match(burn, /This bind, not the fee-payer check, is what stops a second wallet from registering with someone else's public burn/);
});

// DEV-R2-05, DEV-R2-06, DEV-R2-07, DEV-R2-08: the SDK and contract documents say what the code does.
test('DEV-R2-05 to DEV-R2-08: first transactions, address checksums, proof age and the anchors file', () => {
  const sdkDoc = flat('docs/developers/sdk.md');
  assert.doesNotMatch(sdkDoc, /A node that is behind, answers a default account or reports another nonce counts for neither/);
  assert.match(sdkDoc, /for an account's first transaction \(nonce 1\) `waitForTransaction` answers `applied` or `timeout`, never `not_applied`/);
  assert.match(read('development/qnet-sdk/src/client.ts'), /const need = target > 1n \? Math\.min\(2, this\.nodes\.length\) : Infinity;/);
  assert.match(sdkDoc, /The balance and nonce are the account's as of `blockHeight`, not now/);
  assert.match(sdkDoc, /does not verify a proof more than `maxAgeBlocks` below it, nor one whose age no node can tell/);
  assert.match(read('development/qnet-sdk/src/client.ts'), /export const MAX_PROOF_AGE_BLOCKS = 270;/);
  const lib = read('contracts/qnet-contract/src/lib.rs');
  assert.match(lib, /if !is_address\(bytes\) \|\| !checksum_holds\(bytes\) \{/);
  for (const file of ['docs/developers/smart-contracts.md', 'contracts/README.md']) {
    const text = flat(file);
    assert.match(text, /reverts with `bad address`/, file);
    assert.match(text, /isValidAddress/, file);
  }
  const readme = flat('development/qnet-sdk/README.md');
  assert.doesNotMatch(readme, /`anchors-testnet\.json` in the same directory/);
  assert.match(readme, /`~\/\.qnet\/anchors-testnet\.json`, or `\$QNET_HOME\/anchors-testnet\.json`, one level above the key files/);
  assert.match(read('development/qnet-sdk/src/cli.ts'), /path\.join\(ctx\.home, `anchors-\$\{ctx\.client\(\)\.network\}\.json`\)/);
});

test('SD-08: the mobile document signs what the app signs and authenticates alike everywhere', () => {
  const doc = flat('docs/applications/mobile-wallet.md');
  assert.match(doc, /\| Ping delegation \| `q\{chain_id\}\\\|delegate_ping:v2:\{ping_pubkey\}:\{node_id\}:\{seq\}` \|/);
  assert.match(doc, /\| Consent to the node's registration \| `q\{chain_id\}\\\|client_node_reg:/);
  assert.doesNotMatch(doc, /\| Ping delegation \| `delegate_ping:\{ping_pubkey\}:\{node_id\}` \|/);
  assert.doesNotMatch(doc, /Node-registration identity proof|light-node\/register/);
  assert.doesNotMatch(doc, /wallet password \(Android, under `FLAG_SECURE`\) or Face ID, Touch ID or the passcode \(iOS\)/);
  assert.doesNotMatch(doc, /no downloads and no file picker/);
  assert.match(doc, /below iOS 18\.4 WebKit gives the app no say over a page's upload sheet/);
});

test('DEV-R1-09, DEV-R1-10: the burn contract and the RPC reference name who burns and the routes the node serves', () => {
  const burn = flat('docs/developers/1dev-burn-contract.md');
  assert.doesNotMatch(burn, /the browser extension and the mobile app, use the Token program's/);
  assert.match(burn, /by the browser extension with the wallet's own key or, on a phone or any browser without the extension, by the aiqnet\.io node cabinet with its one-time payment key/);
  const rpc = flat('docs/developers/rpc-api.md');
  assert.doesNotMatch(rpc, /`\{success, node_id, is_active, registered_at, push_type,/);
  for (const route of ['/api/v1/light-node/bind', '/api/v1/light-node/unbind', '/api/v1/light-node/wake',
    '/api/v1/light-node/device-challenge', '/api/v1/light-node/device-refresh', '/api/v1/light-node/device-rotate']) {
    assert.ok(rpc.includes(`\`${route}`), route);
  }
  assert.doesNotMatch(flat('docs/developers/overview.md'), /\| Every HTTP route a node serves \|/);
});

// SITE-R1-08: in the app's in-app browser the cabinet shows nothing and goes to the explorer (InAppGuard); the protocol
// says so, and never that the page points the user to where activation happens.
test('SITE-R1-08: the protocol describes the cabinet in the app as InAppGuard does it', () => {
  const guard = read('applications/qnet-explorer/frontend/src/components/InAppGuard.tsx');
  assert.match(guard, /if \(inApp\) router\.replace\(keepFromApp\(IN_APP_HOME, fromApp\)\);/);
  assert.match(guard, /if \(inApp\) return null;/);
  assert.match(read('applications/qnet-explorer/frontend/src/lib/activate-view.ts'), /export const IN_APP_HOME = '\/explorer';/);
  const p = flat('docs/protocols/qnet-link-v1.md');
  assert.doesNotMatch(p, /open aiqnet\.io in the device's browser/);
  assert.match(p, /there it renders nothing and replaces the route with `\/explorer` \(keeping the marker\), with no text about where or how to activate/);
  for (const file of OFFICIAL) assert.doesNotMatch(flat(file), /says to open aiqnet\.io/, file);
});

// DEVP-R1-01, DEVP-R3-02: value sent to a contract can never leave it. The node's routes refuse such a transfer
// (rpc/tx_api.rs RecipientRefusal), a block that carries one still applies it, and the command refuses one with no
// option to send it anyway.
test('DEVP-R1-01, DEVP-R3-02: the documents say the routes refuse a transfer to a contract, and qnet refuses one', () => {
  const node = read('development/qnet-integration/src/rpc/tx_api.rs');
  assert.match(node, /RecipientRefusal::Contract => "recipient_is_contract",/);
  assert.match(node, /RecipientRefusal::Unreadable => "recipient_unreadable",/);
  const sc = flat('docs/developers/smart-contracts.md');
  assert.doesNotMatch(sc, /a contract cannot receive or send QNC|is still accepted and credited/);
  assert.match(sc, /A node's submit routes refuse a QNC transfer, a batch transfer, or a built-in token `transfer` or `transferFrom`, whose recipient account is a contract \(`recipient_is_contract`; `recipient_unreadable`/);
  assert.match(sc, /a block that carries such a transfer applies it, and the value stays in the contract account for good/);
  const sec = flat('docs/developers/security.md');
  assert.doesNotMatch(sec, /is accepted too/);
  assert.match(sec, /`qnet transfer` and `qnet token transfer` refuse a contract recipient\./);
  const cliDoc = flat('docs/developers/cli.md');
  assert.doesNotMatch(cliDoc, /the node accepts such a transfer/);
  const rpc = flat('docs/developers/rpc-api.md');
  for (const code of ['recipient_is_contract', 'recipient_unreadable']) {
    assert.match(rpc, new RegExp(`"code": "${code}"`));
    assert.match(flat('docs/developers/transactions.md'), new RegExp(`"code": "${code}"`));
  }
  const cli = read('development/qnet-sdk/src/cli.ts');
  assert.equal((cli.match(/await checkRecipient\(ctx, to\);/g) ?? []).length, 2);
  for (const file of [...OFFICIAL, 'development/qnet-sdk/src/cli.ts']) assert.doesNotMatch(read(file), /--to-contract/, file);
});

// DEVP-R3-03: the RPC reference carries the node's answers: the light account read, the unreadable account, the log
// index of every row, the public status's `authoritative`, and the benchmark routes closed unless the operator opens
// them. Each is pinned to the node code it describes.
test('DEVP-R3-03: the RPC reference describes the account, logs, status and benchmark answers as the node gives them', () => {
  const mod = read('development/qnet-integration/src/rpc/mod.rs');
  assert.match(mod, /"success": false, "error": "fields_unsupported", "message": "fields takes one value: basic"/);
  assert.match(mod, /warp::http::StatusCode::SERVICE_UNAVAILABLE, json!\(\{\s*"success": false,\s*"error": "account_unreadable",/);
  assert.match(read('development/qnet-integration/src/rpc/contracts_api.rs'), /"log_index": log_index,/);
  assert.match(read('development/qnet-integration/src/rpc/light_status.rs'), /"authoritative": s\.authoritative,/);
  const bench = read('development/qnet-integration/src/rpc/benchmark.rs');
  assert.match(bench, /pub\(super\) const BENCH_MIN_SECRET_LEN: usize = 16;/);
  assert.match(bench, /"error": "benchmark_disabled",/);
  const rpc = flat('docs/developers/rpc-api.md');
  assert.match(rpc, /`\?fields=basic` answers exactly `\{address, balance, nonce, has_dilithium_pk, is_contract, contract_type\}`/);
  assert.match(rpc, /Fourteen REST paths set a non-200 status: `\/api\/v1\/account\/\{address\}` \(503 `account_unreadable`, 400 `fields_unsupported`\)/);
  assert.match(rpc, /logs\[\{height, log_index, tx_hash, contract, data\}\]/);
  assert.match(rpc, /`burn_tx`, `features` and `authoritative`; never `device_tag_h`, which only the signed status answers/);
  assert.match(rpc, /Every benchmark route answers `benchmark_disabled` unless `QNET_BENCHMARK_SECRET` \(at least 16 characters\) is set/);
  assert.doesNotMatch(rpc, /guarded by the `benchmark` rate-limit bucket alone|Requires `QNET_BOOTSTRAP_ID` or a configured/);
  assert.match(flat('docs/operators/configuration.md'), /\| `QNET_BENCHMARK_SECRET` \| Shared secret, at least 16 characters, that enables every `\/api\/v1\/benchmark\/\*` route/);
  assert.match(flat('docs/developers/smart-contracts.md'), /logs\[\{height, log_index, tx_hash, contract, data\}\]/);
  assert.doesNotMatch(flat('docs/developers/smart-contracts.md'), /query its height without a contract filter and count/);
  // ND-7: the public status never carries device_tag_h (rpc/light_status.rs answers it in the signed form only).
  const spec = flat('docs/protocols/light-node-messages.md');
  assert.match(spec, /"features": \[\.\.\.\], "authoritative": b\}/);
  assert.match(spec, /The public form never carries `device_tag_h`, whatever the query/);
  const status = read('development/qnet-integration/src/rpc/light_status.rs');
  const pubAt = status.indexOf('pub(crate) fn public_json(');
  const pub = status.slice(pubAt, status.indexOf('\n}\n', pubAt));
  assert.ok(pub.length > 0 && !pub.includes('device_tag_h'), 'public_json answers no device_tag_h');
  assert.match(status.slice(status.indexOf('pub(crate) fn signed_json(')), /v\["device_tag_h"\] = json!\(lb::device_tag_h\(nonce, tag\)\);/);
  for (const file of ['docs/developers/sdk.md', 'docs/developers/cli.md', 'development/qnet-sdk/src/client.ts']) {
    assert.doesNotMatch(flat(file), /A node answers the same default account \(nonce 0, balance 0\) for (an address it has no row for|a missing row) and for/, file);
    assert.match(flat(file), /(of|node of) an earlier release/, file);
  }
});

// DEVP-R3-01, DEVP-R3-04: the SDK document says reads at once share one walk, and which submit refusals go on.
test('DEVP-R3-01, DEVP-R3-04: the SDK document describes the shared walk and the refusals about the node', () => {
  const sdkDoc = flat('docs/developers/sdk.md');
  assert.match(sdkDoc, /verified reads that run at once in one process on the same chain share that walk/);
  assert.match(sdkDoc, /`submit\(tx, signature, publicKey \\\| null, \{publicKeyIfUnresolved\?\}\)`/);
  assert.match(sdkDoc, /A node that refuses a submit for a reason of its own has not taken the body, and the next node is asked/);
  const client = read('development/qnet-sdk/src/client.ts');
  assert.match(client, /kept\.verifiedOn\[j % 2\] \+= 1;/);
  assert.match(client, /function localRefusal\(/);
  assert.match(read('development/qnet-sdk/src/cli.ts'), /\{ publicKeyIfUnresolved: pair\.publicKey \}/);
});

// DEVP-R1-02: the walk is bounded by time and resumable, and the SDK is not packed with an old pin.
test('DEVP-R1-02: the SDK documents describe the time-bounded walk and the pin gate', () => {
  const sdkDoc = flat('docs/developers/sdk.md');
  assert.match(sdkDoc, /for at most `walkTimeMs` \(default `DEFAULT_WALK_TIME_MS`, 5 minutes\)/);
  assert.match(sdkDoc, /`npm pack` refuses an anchor more than 7 days old/);
  assert.match(read('development/qnet-sdk/src/client.ts'), /export const DEFAULT_WALK_TIME_MS = 5 \* 60_000;/);
  assert.match(read('development/qnet-sdk/scripts/pin-check.mjs'), /export const SDK_PIN_MAX_AGE_DAYS = 7;/);
  assert.doesNotMatch(read('development/qnet-sdk/src/client.ts'), /MAX_WALK_ROUNDS/);
  assert.match(flat('docs/developers/cli.md'), /walks for at most 30 minutes/);
  assert.match(read('development/qnet-sdk/src/cli.ts'), /const CLI_WALK_TIME_MS = 30 \* 60_000;/);
});

// DEVP-R1-04: a full nonce store drops its oldest; issuance must still be rate-limited per client.
test('DEVP-R1-04: the sign-in documents say to rate-limit nonce issuance', () => {
  assert.match(flat('docs/developers/sign-in.md'), /rate-limit the route that issues them per client/);
  assert.match(flat('development/qnet-sdk/README.md'), /rate-limit the route that issues them per client/);
  assert.doesNotMatch(read('development/qnet-sdk/src/signin.ts'), /throw new QNetError\('RATE_LIMITED'\)/);
});

// DEVP-R1-07: a WebAssembly call's args are hex or null; anything else is refused, never run with empty input.
test('DEVP-R1-07: the contract examples describe the args the node takes', () => {
  const ex = flat('development/qnet-contracts/examples/README.md');
  assert.doesNotMatch(ex, /leaves the argument bytes empty/);
  assert.match(ex, /`data\.args` is a JSON string of even-length hex, or `null` \(or absent\) for no argument bytes/);
  const state = read('core/qnet-state/src/transaction.rs');
  for (const code of ['wasm_call_args_not_hex_string', 'wasm_call_args_not_hex']) {
    assert.ok(state.includes(`[REJECT][TX] ${code}"`), code);
    assert.ok(ex.includes(`\`${code}\``), code);
  }
  assert.match(read('development/qnet-integration/src/rpc/contracts_api.rs'), /"args for a WASM contract must be a hex-encoded calldata string"/);
});

// SD-R2-04: the whitepaper's participant table says who submits a Light node's registration and how many devices run it.
test('SD-R2-04: the whitepaper names the cabinet and the extension, and one device per Light node', () => {
  const wp = flat('QNet_Whitepaper.md');
  assert.match(wp, /\| Registration \| Server-initiated by the node itself \| Submitted by the aiqnet\.io node cabinet or the browser extension; the wallet signs its consent in QNet Wallet or the extension \|/);
  assert.match(wp, /\| Devices per identity \| One server \| One phone or tablet, which passes the system's device check \|/);
});

// EXT-R2A-04, owner decision 6 (27.09): a claim answer below 1 QNC is valid when the node's quote stopped short of the
// whole balance (stoppedAtEpoch set). The protocol, its vectors and the reference validator say so.
test('EXT-R2A-04: QNet Link 14.2 and 14.7 take a partial claim below 1 QNC, and the vectors hold one', () => {
  const p = flat('docs/protocols/qnet-link-v1.md');
  assert.doesNotMatch(p, /\| Smallest claim \| 1 QNC \(`1000000000` nano\) \|/);
  assert.doesNotMatch(p, /`amountNano` \(decimal string, at least 1 QNC\)/);
  assert.doesNotMatch(p, /`amountNano` a decimal u64 of at least 1 QNC, `txHash`/);
  assert.doesNotMatch(p, /the last epoch of a claim that took part of the balance/);
  assert.match(p, /any amount above zero for a part the node's quote stopped short of the whole \(`stoppedAtEpoch` set, more epochs remain\)/);
  assert.match(p, /`amountNano` \(decimal string\) is at least 1 QNC when `stoppedAtEpoch` is `null`, and above zero when it is set/);
  assert.match(p, /`amountNano` a decimal u64 of at least 1 QNC when `stoppedAtEpoch` is `null` and above zero otherwise/);
  assert.match(p, /it is the first epoch the claim did not take/);
  const link = JSON.parse(read('docs/protocols/light-node.vectors.json')).link;
  const small = link.cases.filter((c) => c.intent === 'claim').map((c) => JSON.parse(c.plaintext))
    .filter((a) => a.status === 'ok' && a.stoppedAtEpoch !== null && BigInt(a.amountNano) < 1_000_000_000n);
  assert.equal(small.length, 1);
  const refused = link.invalidPlaintexts.filter((n) => n.session === 'claim-ok-partial-small').map((n) => n.reason);
  assert.deepEqual(refused, ['amountNano', 'amountNano', 'stoppedAtEpoch']);
  // The count the protocol states is the vectors' own (the revision 2 table, section 14).
  const WORDS = { twenty: 20, 'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23, 'twenty-four': 24, 'twenty-five': 25, 'twenty-six': 26 };
  const stated = /\| `cases` \| (twenty(?:-[a-z]+)?) full exchanges \(`connect`/.exec(p);
  assert.ok(stated && WORDS[stated[1]] !== undefined, 'the protocol states the revision 2 case count');
  assert.equal(link.cases.length, WORDS[stated[1]]);
  assert.ok(link.cases.length >= 21);
});

// SD-R2-02, SD-R3-03: the consent block the protocol quotes is the app's own text, word for word (en.js, pinned by
// the app's StoreListing test), so the two clients cannot disclose different things. The store notes describe the
// app-access-risk verdict as the privacy page does: apps running that could view the screen, show themselves over
// other apps or control the device, and other apps installed.
test('SD-R2-02, SD-R3-03: the protocol quotes the app\'s consent, and the store notes describe the verdict as the privacy page', () => {
  const en = read('applications/qnet-mobile/src/i18n/locales/en.js');
  const title = en.match(/link_device_check_title: '([^']*)'/)[1];
  const body = en.match(/link_device_check_body: "([^"]*)"/)[1];
  const quote = flat('docs/protocols/qnet-link-v1.md').match(/> (\*\*Device check\.\*\*.*?) > \*Privacy policy\*/)[1].replace(/ > /g, ' ');
  assert.equal(quote, `**${title}** ${body}`);
  const verdict = /whether apps are running that could view the screen, show themselves over other apps or control the device, and whether other apps are installed/;
  const store = flat('applications/qnet-mobile/store-listing/README.md');
  assert.match(store, new RegExp(`Google's Play Integrity API collects app activity information to tell ${verdict.source}`));
  assert.match(store, new RegExp(`\\| App activity → Installed apps \\| Collected \\*\\*only while a node is linked, on Android\\*\\*: Google Play's app-access-risk verdict, which says ${verdict.source}`));
  assert.doesNotMatch(store, /control the device are installed or running|capture the screen or control the device are running/);
  assert.match(flat('applications/qnet-explorer/frontend/src/app/privacy/page.tsx'), verdict);
});

// SD-R3-04: the reviewers' steps for the website's sheets name the wallet with a node (the cabinet's Device tab offers
// nothing to link for a wallet without one) and the site's own labels, read from src/lib/texts.ts where the cabinet
// shows them (the tabs Overview · Device · History since 29.09), and the notes name all five sheets the app has
// (connect, reserve, link, claim, unlink), with the activation's steps by the Activate page's own labels. The wallet
// with a node has a device linked by then, so its Device tab reads "Move the node to another device" and offers
// "Unlink this device" (owner, 30.09).
test('SD-R3-04: the review steps for the website sheets use the wallet with a node and the cabinet\'s labels', () => {
  const site = read('applications/qnet-explorer/frontend/src/lib/texts.ts');
  const label = (key) => {
    const m = site.match(new RegExp(`^  ${key}: '((?:[^'\\\\]|\\\\.)*)',$`, 'm'));
    assert.ok(m, key);
    return m[1].replace(/\\'/g, "'");
  };
  const connect = label('connect_app_here');
  const open = label('link_open_app');
  const device = label('nav_device');
  const linkDevice = label('devices_move_title');
  const unlink = label('unlink_title');
  const overview = label('nav_overview');
  const move = label('claim_with_app');
  // Where the cabinet shows each: the connect button on a phone, the button every request opens the app with, the
  // tabs, the Device tab's button (only for a wallet with a node) and the Overview's move.
  const cabinet = (file) => read(`applications/qnet-explorer/frontend/src/components/cabinet/${file}`);
  assert.match(cabinet('WalletChoice.tsx'), /\{t\(device\.phone \? 'connect_app_here' : 'connect_app_qr'\)\}/);
  assert.match(cabinet('LinkWaiting.tsx'), /<a className="qnet-button activate-primary" href=\{href\} onClick=\{opened\}>\{t\('link_open_app'\)\}<\/a>/);
  const frame = cabinet('CabinetFrame.tsx');
  assert.match(frame, /overview: 'nav_overview',/);
  assert.match(frame, /device: 'nav_device',/);
  // The same button reads "Move the node to another device" while a device is linked (owner, 30.09).
  assert.match(cabinet('LinkDevice.tsx'), /const title: MessageKey = move \? 'devices_move_title' : 'action_link_device';/);
  assert.match(cabinet('LinkDevice.tsx'), /onClick=\{ask\} disabled=\{!device\}>\{t\(title\)\}<\/button>/);
  const devices = cabinet('NodeDevices.tsx');
  assert.match(devices, /if \(s === 'none' \|\| s === 'pending'\) return <NoNode pending=\{s === 'pending'\} \/>;/);
  assert.match(devices, /<LinkDevice onLinked=/);
  assert.match(cabinet('NodeClaim.tsx'), /\{t\('claim_with_app'\)\}/);
  assert.match(cabinet('NodeHome.tsx'), /import \{ Move \} from '\.\/NodeClaim';/);
  const app = read('applications/qnet-mobile/src/i18n/locales/en.js');
  const sheet = (key) => app.match(new RegExp(`${key}: (?:'((?:[^'\\\\]|\\\\.)*)'|"([^"]*)")`)).slice(1).find((x) => x !== undefined).replace(/\\'/g, "'");
  const listing = read('applications/qnet-mobile/store-listing/app-store-listing.txt');
  const notes = listing.slice(listing.indexOf('APP REVIEW INFORMATION'), listing.indexOf('EXPORT COMPLIANCE'));
  assert.match(notes, /Five sheets no button or menu inside the app opens/);
  for (const key of ['link_title_connect', 'link_title_reserve', 'link_title_link', 'link_title_claim', 'link_title_unlink']) assert.ok(notes.includes(`"${sheet(key)}"`), key);
  // Today's card (the device's own unbind) reads "Unlink this device"; once the network takes the wallet's own unbind,
  // "Unlink the device" (contract of 04.10).
  assert.match(cabinet('UnlinkDevice.tsx'), /onClick=\{ask\} disabled=\{!device\}>\s*\{t\(wallet \? 'unlink_title_wallet' : 'unlink_button'\)\}\s*<\/button>/);
  assert.equal(label('unlink_title_wallet'), 'Unlink the device');
  assert.equal(label('unlink_button'), unlink);
  const demo = notes.match(/DEMO\. (.*)/)[1];
  assert.ok(demo.includes(`then with A open https://aiqnet.io/node in Safari: "${connect}" > "${open}" (sheet 1), ${device} > "${linkDevice}" > "${open}" (sheet 3), "${unlink}" (sheet 5)`), demo);
  assert.ok(demo.includes(`"${label('act_start')}" > "${open}" (sheet 2), send the amounts, "${label('act_burn')}", "${label('act_link_open')}" > "${open}" (sheet 3 with consent)`), demo);
  const activate = cabinet('NodeActivate.tsx');
  for (const key of ['act_start', 'act_burn']) assert.ok(activate.includes(`{t('${key}')}`), key);
  assert.ok(activate.includes("{t(device?.phone ? 'act_link_open' : 'act_link_show_qr')}"), 'act_link_open');
  assert.doesNotMatch(demo, /Wallet B: no node\. Link sheet|connect QNet Wallet|Ask QNet Wallet|Devices >/);
  const play = flat('applications/qnet-mobile/store-listing/README.md').match(/3\. \*Website request sheets\*: "(.*?)"/)[1];
  assert.match(play, /^With the wallet of set 1 \(the one with a node\)/);
  for (const step of [
    `Tap '${connect}', then '${open}'`,
    `open the ${device} tab, tap '${linkDevice}', then '${open}'`,
    `on the ${device} tab, '${unlink}', then '${open}'`,
    `On the ${overview}, with a node balance of 1 QNC or more, '${move}', then '${open}'`,
  ]) assert.ok(play.includes(step), step);
  assert.doesNotMatch(play, /Ask QNet Wallet|Devices > /);
});

// SD-R3-08: the mobile document names the legal links each screen shows (WalletScreen.js LEGAL_LINKS): the terms screen
// its first two, Settings all three.
test('SD-R3-08: the mobile document lists the legal links each screen shows', () => {
  const screen = read('applications/qnet-mobile/src/screens/WalletScreen.js');
  assert.match(screen, /const LEGAL_LINKS = \[\n\s+\['legal_privacy', [^\n]*\n\s+\['legal_terms', [^\n]*\n\s+\['legal_support', /);
  const doc = flat('docs/applications/mobile-wallet.md');
  if (/\{LEGAL_LINKS\.slice\(0, 2\)\.map\(/.test(screen)) {
    assert.match(doc, /Settings and the terms screen also to the terms of use, and Settings to the support page on aiqnet\.io/);
  } else {
    assert.equal((screen.match(/\{LEGAL_LINKS\.map\(/g) ?? []).length, 2);
    assert.match(doc, /Settings and the terms screen also to the terms of use and the support page on aiqnet\.io/);
  }
  assert.doesNotMatch(doc, /screen also to the terms and the support page/);
});

// SD-R2-05: the mobile licence table is the app's package.json: every direct dependency, nothing it no longer has.
test('SD-R2-05: the mobile licence table lists exactly what the app depends on', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  const table = notices.slice(notices.indexOf('## Mobile application (`applications/qnet-mobile`)'), notices.indexOf('## Browser extension wallet'));
  const pkg = JSON.parse(read('applications/qnet-mobile/package.json'));
  for (const dep of Object.keys(pkg.dependencies)) {
    assert.ok(table.includes(`\`${dep}\``), `${dep} is missing from the mobile licence table`);
  }
  for (const gone of ['@solana/spl-token', 'crypto-js', 'react-native-crypto-js', 'create-hmac', 'crypto-browserify', 'react-native-crypto',
    '@zxcvbn-ts/core']) {
    assert.ok(!table.includes(`\`${gone}\``), `${gone} is no dependency of the app`);
    assert.ok(!(gone in pkg.dependencies), `${gone} is a dependency again: list it`);
  }
  assert.doesNotMatch(table, /@zxcvbn-ts/);
  // The Android libraries the app's build.gradle adds itself, by group and artifact.
  const gradle = read('applications/qnet-mobile/android/app/build.gradle');
  const libraries = [...gradle.matchAll(/^\s*implementation\("([a-z0-9.]+:[a-z0-9.-]+):[^"]+"\)/gm)].map((m) => m[1]);
  assert.ok(libraries.length >= 2, libraries.join(', '));
  for (const lib of libraries) assert.ok(table.includes(`\`${lib}\``), `${lib} is missing from the mobile licence table`);
  assert.doesNotMatch(table, /Phase 1 burn|1DEV burn|SPL token instructions/);
  assert.match(table, /\| `@solana\/web3\.js` \| MIT \| Solana key derivation \(the key pair of the wallet's Solana address\) \|/);
  assert.doesNotMatch(table, /Push notifications/);
  assert.match(table, /Silent data messages that wake a linked light node; the app shows no notification/);
});

// M24: the extension, explorer and SDK licence tables are their manifests: every direct dependency is named, and every
// package a table names is one (or a package another listed one includes, as the table says).
test('M24: the extension, explorer and SDK licence tables list exactly what their manifests declare', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  const section = (start, end) => {
    const a = notices.indexOf(start);
    const b = notices.indexOf(end, a);
    assert.ok(a >= 0 && b > a, start);
    return notices.slice(a, b);
  };
  const cases = [
    ['## Browser extension wallet (`applications/qnet-wallet`)', '## Explorer', 'applications/qnet-wallet/tools/crypto-bundle/package.json', ['base64-js', 'ieee754']],
    ['## Explorer (`applications/qnet-explorer`)', '## CLI', 'applications/qnet-explorer/frontend/package.json', []],
    ['## Developer SDK (`development/qnet-sdk`)', '## Device oracle', 'development/qnet-sdk/package.json', []],
  ];
  for (const [start, end, manifest, included] of cases) {
    const table = section(start, end);
    const pkg = JSON.parse(read(manifest));
    const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    for (const dep of deps) {
      const named = table.includes(`\`${dep}\``) || (dep.startsWith('@types/') && table.includes('`@types/*`'));
      assert.ok(named, `${dep} (${manifest}) is missing from its licence table`);
    }
    const listed = [...table.matchAll(/`((?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9.-]*)`/g)].map((m) => m[1]);
    for (const name of listed) {
      assert.ok(deps.includes(name) || included.includes(name), `${name} is listed under ${start} but ${manifest} does not declare it`);
    }
  }
  assert.doesNotMatch(section('## Browser extension wallet', '## Explorer'), /Dilithium|typescript/);
  assert.doesNotMatch(section('## Explorer', '## CLI'), /@solana\/|react-simple-maps/);
  assert.doesNotMatch(section('## Developer SDK', '## Device oracle'), /zxcvbn|password-strength/);
});

// SD-R2-06: which surface compiles which 1DEV mint, as the code has it.
test('SD-R2-06: the mint documents say the app and the cabinet compile the devnet mint only', () => {
  const MAINNET = '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump';
  const DEVNET = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
  const mobile = read('applications/qnet-mobile/src/config/nodes.js');
  const cabinet = read('applications/qnet-explorer/frontend/src/lib/one-dev.ts');
  assert.ok(mobile.includes(DEVNET) && !mobile.includes(MAINNET), 'the app compiles a mainnet mint now: update the mint documents');
  assert.ok(cabinet.includes(DEVNET) && !cabinet.includes(MAINNET), 'the cabinet compiles a mainnet mint now: update the mint documents');
  const extension = read('applications/qnet-wallet/dist/background/config.js');
  assert.ok(extension.includes(DEVNET) && extension.includes(MAINNET));
  const tokenomics = flat('docs/economics/tokenomics-1dev.md');
  assert.doesNotMatch(tokenomics, /the same literal the mobile and browser wallets compile in/);
  assert.match(tokenomics, /The mobile app and the aiqnet\.io node cabinet compile the devnet mint only/);
  const activation = flat('docs/economics/node-activation.md');
  assert.doesNotMatch(activation, /matching the literal both wallets compile in/);
  assert.match(activation, /the node cabinet and the mobile app compile the devnet mint only/);
});

// SD-R2-07: the README's activation paragraph says a Light node needs no code, as the rest of the page does.
test('SD-R2-07: the README does not say every node needs an activation code', () => {
  const readme = flat('README.md');
  assert.doesNotMatch(readme, /Running a node requires an activation code/);
  assert.match(readme, /a Light node needs no code of its own: its registration carries the burn, the wallet's consent and the owner bind, and its code is only a receipt/);
});

// SD-R2-09: every page the in-app browser refuses (url.js WALLET_ONLY_PATHS, the site's home and link.aiqnet.io) is
// named wherever the documents list them.
test('SD-R2-09: the refused in-app pages are listed in full', () => {
  const url = read('applications/qnet-mobile/src/browser/url.js');
  const paths = JSON.parse(url.match(/export const WALLET_ONLY_PATHS = Object\.freeze\((\[[^\]]*\])\)/)[1].replace(/'/g, '"'));
  assert.ok(paths.length >= 8, paths.join(','));
  assert.match(url, /return path === '\/' \|\| WALLET_ONLY_RE\.test\(path\);/);
  const places = {
    'docs/developers/dapp-integration.md': flat('docs/developers/dapp-integration.md').match(/\| QNet app, in-app browser \|[^|]*\|/)[0],
    // DEVP-R3-05: the developers' starting page too.
    'docs/developers/overview.md': flat('docs/developers/overview.md').match(/Where a page finds a wallet:.*?instead \(/)[0],
    'docs/protocols/qnet-link-v1.md': flat('docs/protocols/qnet-link-v1.md').match(/9\. The app's screens name no price.*?in place of any page it refuses\./)[0],
    'applications/qnet-mobile/store-listing/README.md': flat('applications/qnet-mobile/store-listing/README.md').match(/\*\*In-app browser\.\*\*.*?\(it shows the explorer instead\)/)[0],
  };
  for (const [file, text] of Object.entries(places)) {
    for (const p of paths) assert.ok(text.includes(`/${p}`), `${file}: /${p}`);
    assert.match(text, /home page/, file);
    assert.match(text, /link\.aiqnet\.io/, file);
  }
});

// SD-R2-11: no built app package is ever added to the repository by a blanket add.
test('SD-R2-11: built APK and AAB files are ignored', () => {
  const ignore = read('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('*.apk') && ignore.includes('*.aab'));
});

// DEVP-R2-01, DEVP-R2-02: the SDK documents describe the kept-checkpoint ladder and the bounded nonce sweep.
test('DEVP-R2-01, DEVP-R2-02: the ladder of kept checkpoints and the nonce store as the SDK has them', () => {
  const client = read('development/qnet-sdk/src/client.ts');
  assert.match(client, /export const LADDER_BAND = 64;/);
  assert.match(client, /const LADDER_BANDS = 128;/);
  assert.match(client, /const VERIFIED_CACHE_SOFT = 128;/);
  const sdkDoc = flat('docs/developers/sdk.md');
  assert.match(sdkDoc, /the highest of each band of `LADDER_BAND` \(64\) macroblocks for the newest 128 bands/);
  assert.match(sdkDoc, /cleared and rooted on the ladder again after 128 new ones/);
  assert.doesNotMatch(flat('development/qnet-sdk/README.md'), /a run that stops early is continued by the next\./);
  assert.match(flat('docs/developers/cli.md'), /the message says whether the other chain has any kept yet/);
  const signin = read('development/qnet-sdk/src/signin.ts');
  assert.match(signin, /if \(entry\.until > t\) break;/);
  for (const file of ['docs/developers/sign-in.md', 'development/qnet-sdk/README.md']) {
    assert.doesNotMatch(flat(file), /a flood (of requests )?cannot stop sign-in/, file);
  }
});

// DEVP-R4-01: every internal route the node serves (rpc/mod.rs) is in the RPC reference's genesis allowlist row, its
// route table and its non-200 list, and the reference says what is_genesis_peer_ip does: the five genesis addresses,
// never loopback.
test('DEVP-R4-01: the RPC reference lists every internal route, genesis addresses only', () => {
  const mod = read('development/qnet-integration/src/rpc/mod.rs');
  const routes = [...mod.matchAll(/\.and\(warp::path\("internal"\)\)\s*\.and\(warp::path\("([a-z0-9-]+)"\)\)/g)].map((m) => m[1]);
  assert.ok(routes.length >= 7, routes.join(', '));
  const misc = read('development/qnet-integration/src/rpc/misc_api.rs');
  const at = misc.indexOf('pub(super) fn is_genesis_peer_ip');
  assert.ok(at >= 0);
  const peer = misc.slice(at, misc.indexOf('\n}\n', at));
  assert.match(peer, /GENESIS_NODE_IPS\.iter\(\)\.any\(\|\(ip, _\)\| \*ip == caller_ip\)/);
  assert.doesNotMatch(peer, /127\.0\.0\.1|is_loopback|::1|localhost/);
  const doc = read('docs/developers/rpc-api.md');
  const row = doc.split('\n').find((l) => l.startsWith('| Genesis-IP allowlist |'));
  const rpc = flat('docs/developers/rpc-api.md');
  const nonOk = rpc.match(/Fourteen REST paths set a non-200 status: .*?\)\./)[0];
  for (const r of routes) {
    assert.ok(row.includes(`/api/v1/internal/${r}\``), `allowlist row: ${r}`);
    assert.match(doc, new RegExp(`^\\| (GET|POST) \\| \`/api/v1/internal/${r}[?\`]`, 'm'), `route table: ${r}`);
    assert.ok(nonOk.includes(`/api/v1/internal/${r}\``), `non-200 list: ${r}`);
  }
  assert.match(row, /The five genesis addresses only \(`GENESIS_NODE_IPS`, `is_genesis_peer_ip`\); every other caller, loopback included, receives HTTP 403/);
  for (const file of ['docs/developers/rpc-api.md', 'docs/architecture/networking.md']) {
    assert.doesNotMatch(flat(file), /[Gg]enesis IPs (plus|or|and) loopback/, file);
  }
  assert.doesNotMatch(flat('docs/architecture/networking.md'), /merged through the node's own loopback/);
  assert.match(flat('docs/operators/genesis-host-checks.md'), /they answer the genesis addresses only and refuse loopback/);
});

// DEVP-R4-02: the chain tag is q1337| (q and the node's QNET_CHAIN_ID 1337); the examples write it literally.
test('DEVP-R4-02: the contract examples sign under the chain tag q1337|', () => {
  assert.match(read('core/qnet-state/src/transaction.rs'), /QNET_CHAIN_ID: u64 = 1337;/);
  const ex = flat('development/qnet-contracts/examples/README.md');
  assert.match(ex, /`q1337\|contract_deploy:\{from\}:\{code_hash\}:\{nonce\}:\{gas_price\}:\{gas_limit\}`/);
  assert.match(ex, /`q1337\|contract_call:\{from\}:\{sha3_256\(calldata bytes\)\}:\{nonce\}:\{gas_price\}:\{gas_limit\}`/);
  assert.doesNotMatch(ex, /`q1337` on testnet|q\{chain_id\}\|contract_/);
  for (const file of OFFICIAL) assert.doesNotMatch(read(file), /qq1337/, file);
});

// DEVP-R4-03: a token burn creates no entry and takes no deposit; the command and its document say so.
test('DEVP-R4-03: qnet token transfer asks no deposit for a burn', () => {
  const cli = read('development/qnet-sdk/src/cli.ts');
  assert.match(cli, /const burn = to === CANONICAL_BURN_ADDRESS;\s*const deposit = ctx\.flags\['dry-run'\] \|\| burn \? 0n/);
  assert.match(flat('docs/developers/cli.md'), /A send to the burn address \(with `--burn`\) destroys the tokens and creates no entry, so it takes no deposit/);
});

// DEVP-R4-04: a sign-in nonce belongs to the session that asked for it; the documents show the binding and the rules
// for the verify request.
test('DEVP-R4-04: sign-in nonces are bound to the requesting session in the SDK and every example', () => {
  const signin = read('development/qnet-sdk/src/signin.ts');
  assert.match(signin, /issue\(binding: string\): string;/);
  assert.match(signin, /consume\(nonce: string, binding: string\): boolean;/);
  assert.match(signin, /if \(entry === undefined \|\| !isBinding\(binding\) \|\| entry\.binding !== binding\) return false;/);
  for (const file of ['docs/developers/sign-in.md', 'docs/developers/sdk.md', 'development/qnet-sdk/README.md']) {
    const text = read(file);
    assert.match(text, /nonces\.issue\(sessionId\)/, file);
    assert.match(text, /consumeNonce: \(n\) => nonces\.consume\(n, sessionId\)/, file);
    assert.doesNotMatch(text, /nonces\.issue\(\)|nonces\.consume\(n\)/, file);
  }
  const doc = flat('docs/developers/sign-in.md');
  assert.match(doc, /\*\*Tie each nonce to the session that asked for it\*\*, and accept it only from that session/);
  assert.match(doc, /\*\*Accept the verify request only as `application\/json`, with an `Origin` header equal to your origin\.\*\*/);
  const sec = flat('docs/developers/security.md');
  assert.match(sec, /to the session that asked for it, and accept it once, from that session only\*\* \(`issue\(sessionId\)`, `consume\(nonce, sessionId\)`\)/);
  assert.match(sec, /\*\*Accept the verify request only as `application\/json`, with an `Origin` header equal to your origin\*\*/);
});

// SITE-R4-02: the protocol describes the relay the site runs (applications/qnet-explorer/frontend/src/server/
// link-relay.ts): the release route and its limit, the grace after the creator's first read, and the link caps.
test('SITE-R4-02: the link protocol describes the release route, the read grace and the link caps', () => {
  const relay = read('applications/qnet-explorer/frontend/src/server/link-relay.ts');
  assert.match(relay, /export const READ_GRACE_S = 120;/);
  assert.match(relay, /export const MAX_LINK_SESSIONS = 5_000;/);
  assert.match(relay, /export const MAX_LINK_PER_IP = 10;/);
  assert.match(relay, /release: \{ max: 120, windowMs: 60_000 \},/);
  assert.match(relay, /if \(!s \|\| s\.owner !== gated\.key\) return fail\(404, 'not_found'\);/);
  assert.match(relay, /if \(gated\.key === s\.owner && s\.readAt === null\) \{/);
  assert.match(read('applications/qnet-explorer/frontend/src/app/api/link/sessions/[id]/route.ts'), /export async function DELETE\(/);
  const p = flat('docs/protocols/qnet-link-v1.md');
  assert.match(p, /\| `DELETE \/api\/link\/sessions\/:id` \| 120 per min \|/);
  assert.match(p, /### 5\.5 `DELETE \/api\/link\/sessions\/:id` \(site\)/);
  assert.match(p, /\*\*A session ends\*\* at the first of: its TTL \(600 s after creation\); 120 s after its creating IP first read the answer/);
  assert.match(p, /until the session ends: its TTL, or 120 s after the creating IP's first read of the answer, whichever comes first/);
  assert.doesNotMatch(p, /once answered \(until the session expires\)/);
  assert.match(p, /at most 5,000 live `link` sessions in the store, and at most 10 live `link` sessions created by one IP/);
  assert.match(relay, /const LARGE: ReadonlySet<LinkIntent> = new Set<LinkIntent>\(\['link', 'reserve'\]\);/);
  assert.match(p, /A `reserve` session carries an answer of that size too and counts toward the same caps\./);
});

// A1 (30.09): a payment address exists for one wallet, which signs its reservation first. QNet Link's `reserve` intent
// is stated as the site (qnet-link.ts), QNet Wallet (QNetLink.js) and the vectors have it, with the beneficiary rule
// and its owner bind v2.
test('A1: QNet Link states the reserve intent and the beneficiary rule as the site, the app and the vectors have them', () => {
  const pattern = '(connect|link|claim|reserve|unlink)';
  assert.ok(read('applications/qnet-explorer/frontend/src/lib/qnet-link.ts').includes(pattern), 'site');
  assert.ok(read('applications/qnet-mobile/src/services/QNetLink.js').includes(pattern), 'app');
  const p = flat('docs/protocols/qnet-link-v1.md');
  assert.ok(p.includes(`\\.${pattern}(?:\\.([A-Za-z0-9_-]{43}))?$`), 'the section 14.3 pattern');
  assert.match(p, /\| `reserve` \| sign this wallet's reservation of a light node paid from the page's one-time payment address, before the page shows that address \|/);
  assert.match(p, /\| `reserve` \| `\{"walletHash": <16 lowercase hex>, "burner": <base58 Solana address of 32 bytes>\}` \|/);
  assert.match(p, /\| `reserve` \| `ok` \| `qnet`, `time`, `pk`, `sig` \|/);
  assert.match(p, /QNet node reservation v1 wallet: \{qnet\} node: light way: payment burner: \{burner\} time: \{T\} cluster: devnet/);
  assert.match(p, /\| Reservation window \| the site takes a `reserve` answer with `now − 900 ≤ T ≤ now \+ 300`/);
  assert.match(p, /the payment key signs the owner bind v2 of that wallet's light node \(`qnet_burn_owner_v2`, with no time;/);
  assert.match(p, /Before it submits, the page reads the network and submits nothing for a wallet that has a node of either type\./);
  assert.doesNotMatch(p, /The cabinet's payment key signs the owner bind for a `link` `ok` answer/);
  const link = JSON.parse(read('docs/protocols/light-node.vectors.json')).link;
  assert.deepEqual(link.cases.filter((c) => c.intent === 'reserve').map((c) => c.name), ['reserve-ok', 'reserve-rejected', 'reserve-error']);
});

// R1, R3, R6 (29.09): the documents state one wallet, one code as the site's activation registry keeps it: the
// reservation and its timers, the record's proof and Solana check, the routes that exist, the migration and its grant,
// the deploy order, and plainly that Solana cannot refuse a burn made by hand; the super code in any browser.
test('R1, R6: the documents state the activation registry as the site runs it', () => {
  const site = (file) => read(`applications/qnet-explorer/frontend/${file}`);
  const record = site('src/lib/cabinet/burn-record.ts');
  assert.match(record, /export const RESERVATION_TTL_MS = 600_000;/);
  assert.match(record, /export const SIGN_MARGIN_MS = 120_000;/);
  assert.match(record, /export const SETTLE_AFTER_MS = 600_000;/);
  assert.doesNotMatch(record, /PAYMENT_HOLD_MS/);
  assert.match(record, /export const RESERVE_PROOF_PAST_S = \{ extension: 600, payment: 87_000 \} as const;/);
  assert.match(record, /export const RESERVE_PROOF_FUTURE_S = 300;/);
  assert.match(record, /export const SCAN_CACHE_MS = 300_000;/);
  assert.match(record, /export const OFFCHAIN_CONTEXT = 'QNET_OFFCHAIN_MSG_v1';/);
  const registry = site('src/server/cabinet/activation-registry.ts');
  assert.match(registry, /ON CONFLICT \(wallet\) DO UPDATE SET/);
  assert.match(registry, /export const SWEEP_EVERY_MS = 600_000;/);
  const migration = site('migrations/005_cabinet_activations.sql');
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON cabinet_activations TO explorer_reader;/);
  for (const route of ['activation/[wallet]', 'activation/reserve', 'activation/announce', 'activation/release', 'activation/record', 'wallet-node/[wallet]', 'super/[id]']) {
    assert.ok(site(`src/app/api/cabinet/${route}/route.ts`).includes('export async function'), route);
  }
  const activation = flat('docs/economics/node-activation.md');
  assert.match(activation, /### One wallet, one code/);
  assert.match(activation, /A wallet gets one activation: one burn and one code, for a Light node or a Super node, chosen once\./);
  assert.match(activation, /It lasts 10 minutes, and a client signs only while at least 2 minutes of it are left\./);
  assert.match(activation, /An announced burn that Solana still does not know 10 minutes later can no longer land and frees the wallet\./);
  // A reservation only the wallet itself makes, and a payment address's burn the wallet's record for good.
  assert.match(activation, /and only the wallet itself can make one: the reservation carries the wallet's ML-DSA-65 signature/);
  assert.match(activation, /The extension signs it with the wallet's own keys right before it burns, and the site takes it up to 10 minutes old; QNet Wallet signs a payment address's reservation before the address exists, and the site takes it up to 24 hours and 10 minutes old/);
  assert.doesNotMatch(activation, /holds the wallet for 24 hours from its block time and is never its record/);
  assert.match(activation, /A payment address's burn is the wallet's record as soon as it is final, exactly like an extension burn: nothing releases it and no second burn is possible\./);
  assert.match(activation, /Solana itself cannot refuse a burn that someone makes by hand, outside these clients\./);
  // Across the two types: the network's one-node rule (the node's `wallet_one_node` gate) refuses a second node of
  // either type for one wallet, and before that rule the clients and the record keep out a burn of the other type made
  // before any node registers.
  assert.match(activation, /and from its one-node rule \(the `wallet_one_node` gate, \[consensus\]\(\.\.\/architecture\/consensus\.md\)\) a second node of either type for one wallet/);
  assert.match(activation, /Before the rule, a burn of the other type made before any node of the wallet registers is kept out by the cabinet, the extension and the record\./);
  assert.doesNotMatch(activation, /code generator \(below\) refuses|It does not know the site's record|generate-activation-code/);
  assert.match(flat('docs/architecture/consensus.md'), /\| `wallet_one_node` \| one wallet, one node of either type/);
  assert.match(read('core/qnet-state/src/feature_gates.rs'), /pub const WALLET_ONE_NODE_GATE_HEIGHT: u64 = /);
  assert.match(flat('docs/operators/running-a-node.md'), /From the network's one-node rule \(gate `wallet_one_node`\) the network itself refuses a second node of either type for one wallet/);
  assert.match(activation, /a Super node's only by the extension that holds the wallet/);
  assert.match(activation, /The cabinet's one-time payment key burns for Light nodes only\./);
  const explorer = flat('docs/applications/explorer.md');
  assert.match(explorer, /### Activation registry/);
  assert.match(explorer, /until the table exists \(or while the database cannot be reached\) every activation route answers 503 `unavailable`/);
  assert.match(explorer, /`004_address_history\.sql`, `005_cabinet_activations\.sql`/);
  assert.doesNotMatch(explorer, /The site's server keeps no record of which wallet a payment address is for|"Check another code"|`QNET_NODE_URL`/);
  assert.match(explorer, /\| `SOLANA_RPC_URL` \|/);
  assert.match(explorer, /\| `DAO_ENABLED` \| `1` opens `POST \/api\/dao\/vote`/);
  assert.match(site('src/server/solana-endpoint.ts'), /env\.SOLANA_RPC_URL/);
  assert.match(read('applications/qnet-explorer/frontend/src/app/api/dao/vote/route.ts'), /process\.env\.DAO_ENABLED !== '1'/);
  // The super code and its settings on the Overview in any browser, and the server's status there.
  const operators = flat('docs/operators/running-a-node.md');
  assert.match(operators, /The Overview of aiqnet\.io\/node shows them too, with the server's settings and a `docker run` command filled in, for the wallet in any browser where it is connected/);
  assert.match(operators, /the Overview of aiqnet\.io\/node follows the node for its wallet: online or not/);
  assert.ok(site('src/components/cabinet/NextSteps.tsx').includes('-e QNET_PRODUCTION=1 -e DOCKER_ENV=1'), 'the Overview fills in the docker run command');
});

// The registration doors answer pages of the live site only: the sandbox's site origin is added by the sandbox's own
// build of the node, never by the repository, and no official text names it.
test('the node and the documents name no sandbox site among the registration origins', () => {
  const rpc = read('development/qnet-integration/src/rpc/mod.rs');
  const sites = /pub\(crate\) fn registration_origin_allowed\(origin: Option<&str>\) -> bool \{\s*const SITES: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(rpc);
  assert.ok(sites, 'the origin list');
  assert.deepEqual([...sites[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]), ['https://aiqnet.io', 'https://www.aiqnet.io']);
  assert.equal(Number(sites[1]), 2);
  for (const file of OFFICIAL) assert.doesNotMatch(read(file), /sbx\.aiqnet\.io/, file);
  assert.match(flat('docs/developers/rpc-api.md'), /Only requests with no `Origin` header, or from `https:\/\/aiqnet\.io`, `https:\/\/www\.aiqnet\.io` or any `chrome-extension:\/\/` or `moz-extension:\/\/` origin, are served/);
  assert.match(flat('docs/protocols/light-node-messages.md'), /whose `Origin` is not `https:\/\/aiqnet\.io`, `https:\/\/www\.aiqnet\.io` or a `chrome-extension:\/\/` or `moz-extension:\/\/` origin is answered 403/);
});
