// Static contract of the v3 extension (spec: Manifest, Tests "Static checks"; R10, R21, R23, R24): the
// store manifest, the files it ships, the constants the classic content scripts mirror, the module API
// surface CONTRACTS.md describes, the dev overlay, and the worker's synchronous listener wiring.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as config from '../dist/background/config.js';
import { LIMITS } from '../dist/background/config.js';
import {
  ERROR_MESSAGES, UNSUPPORTED_CALL_FIELDS, UNSUPPORTED_PARAM_MESSAGE, WalletError, toProviderError,
} from '../dist/background/errors.js';
import { checkDevBuild } from '../scripts/extension.mjs';
import { createChrome } from './helpers/chrome-mock.mjs';

const WALLET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WALLET, 'dist');
const read = (rel) => readFile(path.join(WALLET, rel), 'utf8');
const MANIFEST = JSON.parse(await read('dist/manifest.json'));
const PACKAGE = JSON.parse(await read('package.json'));

// The extension's own source directories (scripts/build-dev.mjs copies them with icons and the bundle).
const V3_DIRS = ['background', 'content', 'inject', 'ui', '_locales'];
const CLEARTEXT = `${'http'}://`;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const V3_FILES = [path.join(DIST, 'manifest.json')];
for (const dir of V3_DIRS) V3_FILES.push(...(await walk(path.join(DIST, dir))));
const rel = (file) => path.relative(WALLET, file).split(path.sep).join('/');

const ORIGINS = [...config.QNET.NODES, config.QNET.EXPLORER_API, ...config.SOLANA.RPC_URLS];
// The exact hosts that serve pages: the site and its games host (whose pages connect and send, and never activate a node);
// no wildcard, and not the hosts that only redirect to the site, so no other aiqnet.io name gets the provider (R4-ERP-02).
const DAPP_MATCHES = ['https://aiqnet.io/*', 'https://games.aiqnet.io/*'];

describe('skeleton: store manifest', () => {
  it('is MV3 3.1.0 on Chrome 111+ with the module worker and the popup', () => {
    assert.equal(MANIFEST.manifest_version, 3);
    assert.equal(MANIFEST.version, '3.1.0');
    assert.equal(MANIFEST.version, PACKAGE.version);
    assert.equal(MANIFEST.version, config.WALLET_VERSION);
    assert.equal(MANIFEST.minimum_chrome_version, '111');
    assert.deepEqual(MANIFEST.background, { service_worker: 'background/sw.js', type: 'module' });
    assert.equal(MANIFEST.action.default_popup, config.UI_PAGES.popup);
    assert.equal(MANIFEST.default_locale, 'en');
  });

  it('asks for storage, alarms and idle only, and the pinned HTTPS origins only', () => {
    assert.deepEqual([...MANIFEST.permissions].sort(), ['alarms', 'idle', 'storage']);
    assert.equal(MANIFEST.optional_permissions, undefined);
    assert.equal(MANIFEST.optional_host_permissions, undefined);
    assert.deepEqual([...MANIFEST.host_permissions].sort(), ORIGINS.map((o) => `${o}/*`).sort());
    const text = JSON.stringify(MANIFEST);
    for (const banned of ['<all_urls>', '*://*/*', 'tabs', 'activeTab', 'scripting', 'webRequest', 'externally_connectable']) {
      assert.ok(!text.includes(`"${banned}"`), banned);
    }
    assert.ok(!text.includes(CLEARTEXT), 'no cleartext URL in the store manifest');
  });

  it('exposes no web-accessible resources', () => {
    assert.equal(MANIFEST.web_accessible_resources, undefined);
  });

  it('pins a strict CSP for extension pages and the worker', () => {
    const csp = MANIFEST.content_security_policy.extension_pages;
    const directives = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const [name, ...values] = d.split(/\s+/);
      return [name, values];
    }));
    assert.deepEqual(directives['default-src'], ["'self'"]);
    // 'wasm-unsafe-eval' lets the bundle compile its Argon2id WebAssembly; it allows no JS eval.
    assert.deepEqual(directives['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
    assert.deepEqual(directives['style-src'], ["'self'"]);
    assert.deepEqual(directives['object-src'], ["'none'"]);
    assert.deepEqual(directives['base-uri'], ["'none'"]);
    assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
    assert.deepEqual(directives['form-action'], ["'none'"]);
    assert.deepEqual([...directives['connect-src']].sort(), ["'self'", ...ORIGINS].sort());
    for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", 'data:', 'blob:', '*', 'http', 'nonce-']) {
      assert.ok(!directives['script-src'].some((value) => value.includes(unsafe)), unsafe);
    }
    assert.equal(csp.match(/wasm-unsafe-eval/g).length, 1, 'only script-src names wasm-unsafe-eval');
    assert.equal(MANIFEST.content_security_policy.sandbox, undefined);
  });

  it('runs the provider in the MAIN world and the relay isolated, top frame only, on aiqnet.io and games.aiqnet.io only', () => {
    const scripts = MANIFEST.content_scripts;
    assert.equal(scripts.length, 2);
    const [main, relay] = scripts;
    assert.deepEqual(main.js, ['inject/provider.js']);
    assert.equal(main.world, 'MAIN');
    assert.equal(main.run_at, 'document_start');
    assert.deepEqual(relay.js, [config.PROVIDER.RELAY_SCRIPT]);
    assert.ok(relay.world === undefined || relay.world === 'ISOLATED');
    assert.equal(relay.run_at, 'document_start');
    for (const entry of scripts) {
      assert.deepEqual(entry.matches, DAPP_MATCHES);
      assert.equal(entry.all_frames, false);
      assert.equal(entry.match_about_blank, undefined);
      assert.equal(entry.css, undefined);
    }
  });

  it('references only files that exist, with every __MSG_ key in the English messages', async () => {
    const files = [
      MANIFEST.background.service_worker, MANIFEST.action.default_popup,
      ...MANIFEST.content_scripts.flatMap((e) => e.js),
      ...Object.values(MANIFEST.icons), ...Object.values(MANIFEST.action.default_icon),
      ...Object.values(config.UI_PAGES), 'lib/qnet-core.js', '_locales/en/messages.json',
    ];
    for (const file of files) assert.ok((await stat(path.join(DIST, file))).isFile(), file);
    const messages = JSON.parse(await read('dist/_locales/en/messages.json'));
    for (const [, key] of JSON.stringify(MANIFEST).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
      assert.ok(messages[key]?.message, key);
    }
  });
});

describe('skeleton: shipped files', () => {
  it('are UTF-8 without BOM, LF only, valid JSON where JSON', async () => {
    for (const file of V3_FILES) {
      const bytes = await readFile(file);
      assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${rel(file)} has a BOM`);
      assert.ok(!bytes.includes(0x0d), `${rel(file)} has CR`);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (file.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(text), rel(file));
    }
  });

  it('contain no HTML sinks, dynamic code, cleartext URLs or raw console calls', async () => {
    const banned = [
      ['innerHTML', /\binnerHTML\b/], ['outerHTML', /\bouterHTML\b/], ['insertAdjacentHTML', /insertAdjacentHTML/],
      ['document.write', /document\.write/], ['eval', /\beval\s*\(/], ['new Function', /new\s+Function\s*\(/],
      ['string timer', /set(?:Timeout|Interval)\(\s*['"`]/], ['cleartext URL', /http:\/\//],
      ['console', /\bconsole\./], ['importScripts', /importScripts/], ['remote import', /import\s*\(\s*['"`]https?:/],
    ];
    for (const file of V3_FILES.filter((f) => /\.(js|html|css|json)$/.test(f))) {
      const text = await readFile(file, 'utf8');
      for (const [name, re] of banned) {
        // the guarded logger is the one place allowed to reach the console (silent in the store build)
        if (name === 'console' && rel(file) === 'dist/background/log.js') continue;
        assert.ok(!re.test(text), `${rel(file)}: ${name}`);
      }
    }
    const logger = await read('dist/background/log.js');
    assert.match(logger, /const sink = DEV_BUILD \? globalThis\.console : null;/);
  });

  it('are syntactically valid: modules for the worker and pages, classic scripts for content scripts', async () => {
    // Worker modules and common.js are parsed by importing them (module API tests, worker wiring).
    for (const file of V3_FILES.filter((f) => f.endsWith('.js'))) {
      const name = rel(file);
      if (name.startsWith('dist/content/') || name.startsWith('dist/inject/')) {
        const source = await readFile(file, 'utf8');
        assert.doesNotThrow(() => new vm.Script(source, { filename: name }), name);
        assert.ok(!/^\s*(import|export)\s/m.test(source), `${name} must stay a classic script`);
      } else if (name.startsWith('dist/ui/') && name !== 'dist/ui/common.js') {
        const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      }
    }
  });

  it('pages load one module script and one stylesheet of their own, nothing inline', async () => {
    for (const page of Object.values(config.UI_PAGES)) {
      const html = await read(`dist/${page}`);
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      assert.equal(scripts.length, 1, page);
      const [, attrs, body] = scripts[0];
      assert.match(attrs, /type="module"/, page);
      assert.match(attrs, /src="[a-z]+\.js"/, page);
      assert.equal(body.trim(), '', `${page} inline script`);
      assert.ok(!/\son[a-z]+\s*=/i.test(html), `${page} inline handler`);
      assert.ok(!/\sstyle\s*=/i.test(html), `${page} inline style`);
      assert.ok(!/<style\b/i.test(html), `${page} style element`);
      assert.ok(!/<(iframe|object|embed|form|base)\b/i.test(html), `${page} forbidden element`);
      const links = [...html.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(links, ['popup.css'], page);
      const script = attrs.match(/src="([a-z]+\.js)"/)[1];
      const source = await read(`dist/ui/${script}`);
      const body0 = source.replace(/^(\s*(\/\/[^\n]*)?\n)*/, '').replace(/^import[^;]+;\s*/gm, '');
      assert.match(body0, /^refuseFramed\(\);/, `${script} must refuse to run framed before anything else`);
    }
  });

  it('the classic content scripts mirror background/config.js', async () => {
    const constant = (source, name) => {
      const match = source.match(new RegExp(`const ${name} = ([^\\n]+);\\n`));
      assert.ok(match, name);
      return vm.runInNewContext(match[1].replace(/Object\.freeze/g, ''));
    };
    const relay = await read('dist/content/relay.js');
    const inject = await read('dist/inject/provider.js');
    const P = config.PROVIDER;
    assert.equal(constant(relay, 'PORT_NAME'), P.PORT_NAME);
    assert.equal(constant(relay, 'TO_RELAY'), P.TO_RELAY);
    assert.equal(constant(relay, 'TO_PAGE'), P.TO_PAGE);
    assert.equal(constant(relay, 'MAX_MESSAGE_CHARS'), LIMITS.PORT_MESSAGE_MAX_CHARS);
    assert.deepEqual([...constant(relay, 'EVENTS')], [...P.EVENTS]);
    // an event through the tab for a page whose port is closed (EXT-F3)
    assert.equal(constant(relay, 'TAB_EVENT'), P.TAB_EVENT);
    assert.equal(constant(inject, 'TO_RELAY'), P.TO_RELAY);
    assert.equal(constant(inject, 'TO_PAGE'), P.TO_PAGE);
    assert.equal(constant(inject, 'ANNOUNCE_EVENT'), P.ANNOUNCE_EVENT);
    assert.equal(constant(inject, 'REQUEST_EVENT'), P.REQUEST_EVENT);
    assert.equal(constant(inject, 'NAME'), P.NAME);
    assert.equal(constant(inject, 'RDNS'), P.RDNS);
    assert.equal(constant(inject, 'CHANNEL'), P.CHANNEL);
    assert.equal(P.CHANNEL, 'extension');
    assert.equal(P.ACTIVATION_ORIGIN, 'https://aiqnet.io');
    assert.deepEqual([...constant(inject, 'EVENTS')], [...P.EVENTS]);
    assert.match(constant(inject, 'ICON'), /^data:image\/svg\+xml;base64,/);
    assert.equal(constant(inject, 'COOLDOWN_MESSAGE'), ERROR_MESSAGES.APPROVAL_COOLDOWN);
    assert.deepEqual(toProviderError(new WalletError('APPROVAL_COOLDOWN')), { code: 4001, message: ERROR_MESSAGES.APPROVAL_COOLDOWN });
    // the one error with data, with its own text: the page script says what errors.js sends
    assert.equal(constant(inject, 'UNSUPPORTED_PARAM'), 'UNSUPPORTED_PARAM');
    assert.equal(constant(inject, 'UNSUPPORTED_PARAM_MESSAGE'), UNSUPPORTED_PARAM_MESSAGE);
    for (const field of UNSUPPORTED_CALL_FIELDS) {
      assert.deepEqual(toProviderError(new WalletError('UNSUPPORTED_PARAM', { field })),
        { code: -32602, message: 'Unsupported parameter', data: { reason: 'UNSUPPORTED_PARAM' } });
    }
  });

  it('config holds the facts the spec fixes', () => {
    assert.equal(config.DEV_BUILD, false);
    assert.equal(config.QNET.CHAIN_ID, 'q1337');
    assert.ok(ORIGINS.every((o) => o.startsWith('https://') && new URL(o).origin === o));
    assert.equal(config.SOLANA.CLUSTER, 'devnet');
    assert.equal(config.SOLANA.ONE_DEV_MINT, '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ');
    assert.deepEqual(config.SOLANA.NODE_TYPE_MEMO, { light: 'QNET_NODE_TYPE:LIGHT', super: 'QNET_NODE_TYPE:SUPER' });
    assert.equal(config.DECIMALS.ONE_DEV, 6);
    // minutes, or Never: no inactivity timer (owner, 28.09)
    assert.deepEqual([...config.AUTO_LOCK_CHOICES], [5, 15, 30, 60, 'never']);
    assert.equal(config.AUTO_LOCK_NEVER, 'never');
    assert.equal(config.DEFAULT_AUTO_LOCK_MINUTES, 15);
    assert.equal(config.VAULT_DB.NAME, 'qnet-vault-v3');
    assert.equal(config.STORAGE_KEYS.SITES, 'qnet_sites_v3');
    assert.equal(LIMITS.APPROVAL_QUEUE_PER_ORIGIN, 3);
    assert.equal(config.TIMINGS.CONFIRM_ARM_MS, 1000);
    // the light node's registration and the smallest move of its balance (1 QNC)
    assert.equal(config.REGISTRATION_ALARM, 'qnet-register');
    assert.notEqual(config.REGISTRATION_ALARM, config.AUTO_LOCK_ALARM);
    assert.equal(LIMITS.REGISTRATION_MAX_ATTEMPTS, 12);
    assert.equal(config.TIMINGS.REGISTRATION_ADMIT_HOLD_MS, 600000);
    assert.equal(config.CLAIM_MIN_NANO, '1000000000');
    // a recovery phrase copied by its Copy button leaves the clipboard after a minute
    assert.equal(config.TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS, 60000);
    // aiqnet.io's record of the wallet's burns (decision 35): the one path asked there, the origin a proof names in every
    // build, the timers every client shares, and the read limits of qnet_getActivation
    assert.equal(config.RECORD_PATH, '/api/cabinet/activation/');
    assert.equal(config.RECORD_ORIGIN, 'https://aiqnet.io');
    assert.equal(config.QNET.EXPLORER_API, config.RECORD_ORIGIN);
    assert.deepEqual([config.TIMINGS.RECORD_TIMEOUT_MS, config.TIMINGS.RESERVATION_TTL_MS, config.TIMINGS.SIGN_MARGIN_MS],
      [8000, 600000, 120000]);
    assert.deepEqual([LIMITS.ACTIVATION_READS_PER_MINUTE, config.TIMINGS.WALLET_SEARCH_SPACING_MS, config.TIMINGS.WALLET_SEARCH_FRESH_MS],
      [30, 20000, 60000]);
  });
});

// The API CONTRACTS.md promises. Implementers may add exports; none of these may disappear.
const EXPORTS = {
  'background/activation.js': ['activateForSite', 'burn', 'copyCode', 'getPrice', 'getStatus', 'lookup', 'maskCode', 'publicActivation',
    'recover', 'setRegistrationHook', 'siteActivation', 'siteView', 'syncRecord'],
  'background/amount.js': ['DECIMALS', 'U64_MAX', 'formatUnits', 'isPositiveAmount', 'parseUnits'],
  'background/errors.js': ['ERROR_MESSAGES', 'PROVIDER_ERROR_CODES', 'ProviderError', 'WalletError', 'toProviderError', 'toUiError'],
  'background/events.js': ['notifyViews', 'setViewBroadcaster'],
  'background/keys.js': ['burnRecordMessage', 'deriveAddresses', 'getQnetPublicKey', 'initKeys', 'signBurnRecord', 'signClaimPayload',
    'signNodeClaim', 'signNodeRegistration', 'signNodeStatus', 'signNodeUnbind', 'signOffchain', 'signQnetTransfer', 'signSolanaMessage',
    'signingEnabled', 'startKeys'],
  'background/nodes.js': ['claimForSite', 'claimView', 'getRegistration', 'onAlarm', 'onChain', 'publicRegistration',
    'registeredBurn', 'registrationFor', 'requestRecord', 'resumeRegistration', 'unlinkForSite', 'unlinkView'],
  'background/log.js': ['log'],
  'background/provider.js': ['displayOrigin', 'eventSink', 'getApproval', 'handleRequest', 'listSites', 'notifyLockChanged',
    'onPortClosed', 'onWindowRemoved', 'readSites', 'resolveApproval', 'revokeSite', 'setEventSink'],
  'background/qnet.js': ['assertPayableRecipient', 'getBalance', 'getHistory', 'nodeRequest', 'prepareTransfer', 'preview',
    'recipientCheck', 'resolveNonce', 'resubmitPending', 'send', 'sendTransfer', 'siteRequest', 'transferFeeNano'],
  'background/router.js': ['PROVIDER_METHODS', 'PROVIDER_RESULT_KEY_EXCEPTIONS', 'RESULT_KEY_EXCEPTIONS', 'SECRET_RESULT_KEYS',
    'UI_MESSAGES', 'createRouter', 'isActivationOrigin', 'isCanonicalOrigin', 'isSafeResult', 'isU64String', 'originMatchesPattern', 'providerOriginOf', 'relayMatchPatterns',
    'uiPageOf', 'validateParams'],
  'background/session.js': ['backoffDelayMs', 'cachedViews', 'checkBackoff', 'getAddresses', 'getBackoffUntil', 'getSettings', 'initSession',
    'isAutoLockChoice', 'isUnlocked', 'lock', 'lockNow', 'onAlarm', 'onIdleState', 'onLockChange', 'recordPasswordFailure',
    'recordPasswordSuccess', 'rememberView', 'replaceVaultKey', 'requireUnlocked', 'setSettings', 'startSession', 'touch', 'withVaultKey'],
  'background/solana.js': ['blockHeight', 'buildBurnTransaction', 'burnInstruction', 'compileLegacyMessage',
    'createAtaIdempotentInstruction', 'findWalletBurns', 'getBalances', 'getHistory', 'historyItem', 'memoInstruction', 'quote', 'rpc', 'send',
    'sendAndConfirm', 'serializeTransaction', 'signatureStatus', 'simulate', 'systemTransferInstruction',
    'transferCheckedInstruction', 'validateBurnTx'],
  'background/vault.js': ['KDF_DEFAULT', 'KDF_FLOOR', 'PLAINTEXT_VERSION', 'VAULT_DB', 'assertKdfFloor', 'beginRestore',
    'canonicalJson', 'changePassword', 'createVault', 'restoreVault', 'decodePlaintext', 'deleteVaultDatabase', 'deriveVaultKey', 'emptyState',
    'encodePlaintext', 'getStatus', 'importVault', 'normalizePassword', 'readEntropy', 'readLightAnchors',
    'readSiteBinding', 'readState', 'RECIPIENTS_MAX', 'reveal', 'unlock', 'updateState', 'vaultExists', 'verifyPassword', 'wipe',
    'withRecipient', 'writeLightAnchors', 'writeNewVault'],
  'ui/common.js': ['DECIMALS', 'UiError', 'call', 'clear', 'clearCopiedNow', 'copyText', 'currentLanguage', 'el', 'formatUnits',
    'hardenSecretInput', 'holdToReveal', 'loadLocale', 'log', 'onWalletEvent', 'openSetup', 'parseUnits', 'refuseFramed', 'shortAddress',
    't', 'wipeInputs'],
};

describe('skeleton: module API', () => {
  it('every module exports the contracted names', async () => {
    for (const [file, names] of Object.entries(EXPORTS)) {
      const mod = await import(`../dist/${file}`);
      for (const name of names) assert.ok(name in mod, `${file} exports ${name}`);
    }
  });

  it('every exported function carries a JSDoc block', async () => {
    for (const file of Object.keys(EXPORTS)) {
      const source = await read(`dist/${file}`);
      for (const match of source.matchAll(/^export (?:async )?function (\w+)/gm)) {
        const before = source.slice(0, match.index).trimEnd();
        assert.ok(before.endsWith('*/'), `${file}: ${match[1]} has no JSDoc`);
      }
    }
  });
});

describe('skeleton: dev overlay', () => {
  it('build-dev writes dist-dev style output with loopback matches and leaves dist untouched', async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'qnet-dev-'));
    const target = path.join(out, 'ext');
    try {
      const before = await read('dist/manifest.json');
      const result = spawnSync(process.execPath, ['scripts/build-dev.mjs', '--out', target], { cwd: WALLET, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await read('dist/manifest.json'), before);
      const dev = JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8'));
      for (const entry of dev.content_scripts) {
        assert.deepEqual(entry.matches, [...DAPP_MATCHES, `${CLEARTEXT}localhost/*`, `${CLEARTEXT}127.0.0.1/*`]);
      }
      assert.deepEqual(dev.host_permissions, MANIFEST.host_permissions);
      assert.equal(dev.web_accessible_resources, undefined);
      const devConfig = await readFile(path.join(target, 'background/config.js'), 'utf8');
      assert.match(devConfig, /export const DEV_BUILD = true;/);
      assert.ok((await stat(path.join(target, 'lib/qnet-core.js'))).isFile());
      await assert.rejects(stat(path.join(target, 'background.js')), 'only the shipped entries are copied');
      const refused = spawnSync(process.execPath, ['scripts/build-dev.mjs', '--out', path.join(DIST, 'dev')], { cwd: WALLET });
      assert.notEqual(refused.status, 0, 'refuses to write inside dist/');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('dist-dev/ is git-ignored', async () => {
    const ignore = await read('.gitignore');
    assert.ok(ignore.split('\n').map((l) => l.trim()).includes('/dist-dev/'));
  });

  // EXT-FA1-01: a dev build is dist/ byte for byte apart from its overlay; a dist/ change it lacks is named
  it('a dev build is dist/ byte for byte apart from its overlay, and every drift is named (EXT-FA1-01)', async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'qnet-dev-'));
    const target = path.join(out, 'ext');
    try {
      const result = spawnSync(process.execPath, ['scripts/build-dev.mjs', '--out', target], { cwd: WALLET, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await checkDevBuild(DIST, target), []);
      // a dist/ file changed since the build, a file only one side has, and an overlay that is not dist/'s
      await appendFile(path.join(target, 'background/nodes.js'), '\n');
      await rm(path.join(target, 'ui/i18n/ar.js'));
      await writeFile(path.join(target, 'ui/extra.js'), '');
      const manifestPath = path.join(target, 'manifest.json');
      await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replace('"version": "3.1.0"', '"version": "3.0.9"'));
      const configPath = path.join(target, 'background/config.js');
      await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('DEV_BUILD = true', 'DEV_BUILD = false'));
      assert.deepEqual((await checkDevBuild(DIST, target)).sort(), [
        'background/config.js: not the dev overlay of dist/\'s',
        'background/nodes.js: differs from dist/',
        'manifest.json: not the dev overlay of dist/\'s',
        'ui/extra.js: in the dev build but not in dist/',
        'ui/i18n/ar.js: in dist/ but not in the dev build',
      ]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  // EXT-FA1-01: the unpacked dev build tested against the local site must be the code that ships
  it('dist-dev/, when present, is the dev build of dist/ as it is now: run npm run build:dev after a dist/ change', async (t) => {
    const dev = path.join(WALLET, 'dist-dev');
    if (!(await stat(dev).catch(() => null))?.isDirectory()) {
      t.skip('no dist-dev/');
      return;
    }
    assert.deepEqual(await checkDevBuild(DIST, dev), [], 'dist-dev/ is behind dist/: run npm run build:dev');
  });
});

describe('skeleton: worker wiring', () => {
  it('sw.js registers every listener synchronously and survives unimplemented modules', async () => {
    const chrome = createChrome({ manifest: MANIFEST });
    globalThis.chrome = chrome;
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await import('../dist/background/sw.js');
      assert.equal(chrome.runtime.onMessage.listenerCount(), 1);
      assert.equal(chrome.runtime.onConnect.listenerCount(), 1);
      assert.equal(chrome.runtime.onStartup.listenerCount(), 1);
      assert.equal(chrome.alarms.onAlarm.listenerCount(), 1);
      assert.equal(chrome.idle.onStateChanged.listenerCount(), 1);
      assert.equal(chrome.windows.onRemoved.listenerCount(), 1);
      const provider = await import('../dist/background/provider.js');
      assert.equal(typeof provider.eventSink(), 'function');
      const { notifyViews } = await import('../dist/background/events.js');
      notifyViews('activation');
      notifyViews('not-an-event');
      assert.deepEqual(chrome.runtime.sent, [{ channel: config.VIEW_EVENT_CHANNEL, event: 'activation', data: null }]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
      delete globalThis.chrome;
    }
  });
});
