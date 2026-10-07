#!/usr/bin/env node
// Writes qnet-wallet-<version>.zip, the store package: exactly the shipped files of dist/ with the store
// manifest (never the dev overlay), and only after verifyExtension finds nothing wrong, the crypto bundle is exactly what
// its sources build now (checkBundleFresh, EXT-R2A-02), and the light-client pin compiled into the bundle is the mobile
// source's and recent (checkLightClientPin, R4-EXTQ-05). The archive is
// deterministic (sorted entries, fixed timestamps), so the same dist/ always gives the same bytes.
// Usage: node scripts/package.mjs [--out <file>] [--today YYYY-MM-DD]
//   --today: the day the pin's age is counted to (default: today, UTC)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { checkBundleFresh, checkLightClientPin, verifyExtension } from './extension.mjs';

const WALLET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WALLET, 'dist');
const PIN_SOURCE = path.resolve(WALLET, '../qnet-mobile/src/config/genesisConsensus.js');
// 1980-01-01 00:00, the earliest DOS date: no build time leaks into the archive.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

function fail(message) {
  console.error(`[ERR][PACKAGE] ${message}`);
  process.exit(1);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex >= 0 && !args[outIndex + 1]) fail('--out needs a file');
const todayIndex = args.indexOf('--today');
if (todayIndex >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(args[todayIndex + 1] ?? '')) fail('--today needs a YYYY-MM-DD date');
const today = todayIndex >= 0 ? args[todayIndex + 1] : new Date().toISOString().slice(0, 10);

const { version } = JSON.parse(await readFile(path.join(WALLET, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(DIST, 'manifest.json'), 'utf8'));
if (manifest.version !== version) fail(`manifest version ${manifest.version} differs from package.json ${version}`);
const out = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : path.join(WALLET, `qnet-wallet-${version}.zip`);

const { files, problems } = await verifyExtension(DIST, { store: true });
if (problems.length > 0) fail(`dist/ does not load:\n  ${problems.join('\n  ')}`);

// the crypto bundle: exactly what its sources and the shared mobile modules build now (EXT-R2A-02)
const bundleProblems = await checkBundleFresh({ wallet: WALLET, bundle: path.join(DIST, 'lib/qnet-core.js') });
if (bundleProblems.length > 0) fail(`the crypto bundle cannot ship:\n  ${bundleProblems.join('\n  ')}`);

// the light client's weak-subjectivity pin: the source's, in the bundle, and recent enough to walk from
const core = await import(pathToFileURL(path.join(DIST, 'lib/qnet-core.js')).href);
const pinProblems = checkLightClientPin({
  source: await readFile(PIN_SOURCE, 'utf8').catch(() => ''), bundleTrustFloor: core.trustFloorIndex(), today,
});
if (pinProblems.length > 0) fail(`the light-client pin cannot ship:\n  ${pinProblems.join('\n  ')}`);

const entries = [];
for (const name of files) entries.push({ name, data: await readFile(path.join(DIST, name)) });
const archive = zip(entries);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, archive);
const sha256 = createHash('sha256').update(archive).digest('hex');
console.log(`[INFO][PACKAGE] ${path.relative(WALLET, out) || out}: ${files.length} files, ${archive.length} bytes, sha256=${sha256}`);
