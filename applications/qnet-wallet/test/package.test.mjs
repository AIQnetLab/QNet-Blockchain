// The extension loads as shipped (every file the manifest and pages name exists, every import resolves,
// nothing shipped is left unloaded), and `npm run package` zips exactly that, deterministically, with the
// store manifest.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import * as core from '../dist/lib/qnet-core.js';
import {
  PIN_MAX_AGE_DAYS, SHIPPED, checkBundleFresh, checkLightClientPin, listShippedFiles, pinOfSource, pngSize, verifyExtension,
} from '../scripts/extension.mjs';

const WALLET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WALLET, 'dist');
const PIN_SOURCE = await readFile(path.join(WALLET, '../qnet-mobile/src/config/genesisConsensus.js'), 'utf8');
const PIN = pinOfSource(PIN_SOURCE);
const dayAfter = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function withCopy(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qnet-ext-'));
  try {
    for (const entry of SHIPPED) await cp(path.join(DIST, entry), path.join(dir, entry), { recursive: true });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Central directory of a zip without a comment: [{name, data}] with each entry inflated.
function unzip(archive) {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, 'end of central directory');
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const method = archive.readUInt16LE(at + 10);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const body = archive.subarray(start, start + size);
    entries.push({ name, data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body), method });
    at += 46 + nameLength;
  }
  return entries;
}

describe('package: the extension loads', () => {
  it('dist/ names only files it ships, resolves every import and loads every script and stylesheet', async () => {
    const { files, problems } = await verifyExtension(DIST, { store: true });
    assert.deepEqual(problems, []);
    for (const required of ['manifest.json', 'background/sw.js', 'content/relay.js', 'inject/provider.js', 'ui/popup.html',
      'ui/setup.html', 'ui/approve.html', 'lib/qnet-core.js', '_locales/en/messages.json', 'icons/icon-128.png']) {
      assert.ok(files.includes(required), required);
    }
  });

  it('reports a missing module, an unloaded script, a missing icon and an importing content script', async () => {
    await withCopy(async (dir) => {
      await unlink(path.join(dir, 'ui/qr.js'));
      await writeFile(path.join(dir, 'background/unused.js'), 'export const x = 1;\n');
      const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
      manifest.icons['64'] = 'icons/icon-64.png';
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      const relay = await readFile(path.join(dir, 'content/relay.js'), 'utf8');
      await writeFile(path.join(dir, 'content/relay.js'), `import '../ui/common.js';\n${relay}`);
      const { problems } = await verifyExtension(dir);
      assert.ok(problems.some((p) => p.startsWith('ui/popup.js: import "./qr.js"')), problems.join('\n'));
      assert.ok(problems.includes('background/unused.js: shipped but never loaded'), problems.join('\n'));
      assert.ok(problems.includes('manifest.json: icon icons/icon-64.png is not shipped'), problems.join('\n'));
      assert.ok(problems.includes('content/relay.js: content scripts must be classic scripts'), problems.join('\n'));
    });
  });

  // EXT-R4-02: the 16, 32 and 48 px icons were three copies of one 132x131 picture, scaled (blurred) by the browser, and the
  // QNC and 1DEV rows drew one image.
  it('every manifest icon is a square PNG of its declared size, and each token has its own picture (EXT-R4-02)', async () => {
    const manifest = JSON.parse(await readFile(path.join(DIST, 'manifest.json'), 'utf8'));
    for (const set of [manifest.icons, manifest.action.default_icon]) {
      assert.deepEqual(Object.keys(set).sort(), ['128', '16', '32', '48']);
      for (const [size, icon] of Object.entries(set)) {
        const data = await readFile(path.join(DIST, icon));
        assert.ok(data.subarray(1, 4).toString('latin1') === 'PNG', icon);
        assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], [Number(size), Number(size)], icon);
      }
    }
    const token = (name) => readFile(path.join(DIST, 'icons', name));
    const [qnc, oneDev, sol] = await Promise.all(['qnc-token.png', '1dev-token.png', 'sol-token.png'].map(token));
    assert.ok(!qnc.equals(oneDev) && !qnc.equals(sol) && !oneDev.equals(sol), 'QNC, 1DEV and SOL each have their own picture');
    await withCopy(async (dir) => {
      // an icon of another shape, one of another size, one that is not a PNG, and one picture under two names
      const icon48 = await readFile(path.join(dir, 'icons/icon-48.png'));
      const skewed = Buffer.from(icon48);
      skewed.writeUInt32BE(132, 16);
      skewed.writeUInt32BE(131, 20);
      assert.deepEqual(pngSize(skewed), { width: 132, height: 131 });
      await writeFile(path.join(dir, 'icons/icon-16.png'), skewed);
      const icon128 = await readFile(path.join(dir, 'icons/icon-128.png'));
      await writeFile(path.join(dir, 'icons/icon-32.png'), Buffer.concat([icon128, Buffer.from([0])]));
      await writeFile(path.join(dir, 'icons/icon-48.png'), 'GIF89a');
      await writeFile(path.join(dir, 'icons/1dev-token.png'), qnc);
      const { problems } = await verifyExtension(dir);
      assert.deepEqual(problems.sort(), [
        'icons/qnc-token.png: the same picture as icons/1dev-token.png',
        'manifest.json: icon icons/icon-16.png is 132x131, declared 16x16',
        'manifest.json: icon icons/icon-32.png is 128x128, declared 32x32',
        'manifest.json: icon icons/icon-48.png is not a PNG',
      ]);
      // npm run package refuses such a dist/ (verifyExtension runs first)
      const script = await readFile(path.join(WALLET, 'scripts/package.mjs'), 'utf8');
      assert.match(script, /await verifyExtension\(DIST, \{ store: true \}\);\nif \(problems\.length > 0\) fail/);
    });
  });

  it('refuses a dev build as a store build', async () => {
    await withCopy(async (dir) => {
      const config = await readFile(path.join(dir, 'background/config.js'), 'utf8');
      await writeFile(path.join(dir, 'background/config.js'), config.replace('DEV_BUILD = false', 'DEV_BUILD = true'));
      const { problems } = await verifyExtension(dir, { store: true });
      assert.deepEqual(problems, ['background/config.js: DEV_BUILD is not false in the store build']);
      assert.deepEqual((await verifyExtension(dir, { store: false })).problems, []);
    });
  });
});

describe('package: the store zip', () => {
  it('holds exactly the shipped files, byte for byte, and the same dist/ gives the same zip', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qnet-zip-'));
    try {
      // counted on the pin's own day, so the zip checks here do not depend on today's date (the pin check has its own tests)
      const build = (name) => {
        const run = spawnSync(process.execPath, ['scripts/package.mjs', '--out', path.join(dir, name), '--today', PIN.generated],
          { cwd: WALLET, encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        return readFile(path.join(dir, name));
      };
      const first = await build('a.zip');
      const second = await build('b.zip');
      assert.ok(first.equals(second), 'deterministic');
      const entries = unzip(first);
      const { files } = await listShippedFiles(DIST);
      assert.deepEqual(entries.map((e) => e.name), files);
      for (const { name, data } of entries) assert.ok(data.equals(await readFile(path.join(DIST, name))), name);
      const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
      assert.equal(manifest.version, JSON.parse(await readFile(path.join(WALLET, 'package.json'), 'utf8')).version);
      assert.ok(!JSON.stringify(manifest).includes(`${'http'}://`), 'no dev overlay in the store package');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// EXT-R2A-02: a shared mobile module changed after the bundle was built; the store package of the old bundle shipped a
// password list the source no longer holds. No store package ships a bundle its sources do not build now.
describe('package: the crypto bundle is current', () => {
  it('the shipped bundle is what its sources build now; a bundle that differs by one byte is refused', async () => {
    assert.deepEqual(await checkBundleFresh({ wallet: WALLET, bundle: path.join(DIST, 'lib/qnet-core.js') }), []);
    await withCopy(async (dir) => {
      const bundle = path.join(dir, 'lib/qnet-core.js');
      const text = await readFile(bundle, 'utf8');
      await writeFile(bundle, `${text}\n`);
      assert.deepEqual(await checkBundleFresh({ wallet: WALLET, bundle }), ['lib/qnet-core.js is not what its sources build now: npm run build']);
    });
    const script = await readFile(path.join(WALLET, 'scripts/package.mjs'), 'utf8');
    assert.match(script, /await checkBundleFresh\(\{ wallet: WALLET, bundle: path\.join\(DIST, 'lib\/qnet-core\.js'\) \}\)/,
      'npm run package runs the check on the bundle it zips');
  });
});

// R4-EXTQ-05: no store package ships a light-client pin nodes may already have stripped the signatures of.
describe('package: the light-client pin', () => {
  it('the bundle carries the mobile source\'s pin, generated by ws-pin.js', () => {
    assert.ok(PIN !== null && PIN.index > 0 && /^\d{4}-\d{2}-\d{2}$/.test(PIN.generated), JSON.stringify(PIN));
    assert.equal(core.trustFloorIndex(), PIN.index + 1);
    assert.deepEqual(checkLightClientPin({ source: PIN_SOURCE, bundleTrustFloor: core.trustFloorIndex(), today: PIN.generated }), []);
  });

  it('refuses a pin older than PIN_MAX_AGE_DAYS, one the bundle does not carry, and a source without one', () => {
    const floor = PIN.index + 1;
    assert.deepEqual(checkLightClientPin({ source: PIN_SOURCE, bundleTrustFloor: floor, today: dayAfter(PIN.generated, PIN_MAX_AGE_DAYS) }), []);
    const stale = checkLightClientPin({ source: PIN_SOURCE, bundleTrustFloor: floor, today: dayAfter(PIN.generated, PIN_MAX_AGE_DAYS + 1) });
    assert.equal(stale.length, 1);
    assert.match(stale[0], /ws-pin\.js --write/);
    assert.equal(checkLightClientPin({ source: PIN_SOURCE, bundleTrustFloor: floor + 90, today: PIN.generated }).length, 1);
    assert.equal(checkLightClientPin({ source: 'export const WS_CHECKPOINT = { index: 0 };', bundleTrustFloor: 1, today: PIN.generated }).length, 1);
  });

  it('npm run package refuses to package when the pin is too old', () => {
    const run = spawnSync(process.execPath, ['scripts/package.mjs', '--out', path.join(os.tmpdir(), 'qnet-stale-pin.zip'),
      '--today', dayAfter(PIN.generated, PIN_MAX_AGE_DAYS + 30)], { cwd: WALLET, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /light-client pin cannot ship/);
  });
});
