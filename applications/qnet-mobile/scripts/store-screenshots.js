#!/usr/bin/env node
/**
 * The App Store screenshots of the iOS simulator build (ios-build.yml, job screenshots): one iPhone of the 6.9" display
 * size and one iPad of the 13" size, each driven through store-screenshots/screenshots.yaml by the flow runner.
 *
 *   node scripts/store-screenshots.js capture --app <QNetMobile.app> --out <dir>
 *   node scripts/store-screenshots.js check <dir>
 *
 * The flows ask this process, on a local port (store-screenshots/control.js), to capture a scene with simctl at the
 * device's own pixel size, or to put the app password or the recovery phrase on the simulator's pasteboard, which the
 * flow then pastes: neither value is an argument, a flow variable or a log line. The phrase is QNET_SCREENSHOT_PHRASE;
 * without it the run makes a new one.
 */
'use strict';
/* global Atomics, SharedArrayBuffer */

const { Buffer } = require('buffer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FLOWS = path.join(ROOT, 'store-screenshots');
const MAIN_FLOW = path.join(FLOWS, 'screenshots.yaml');
const PHRASE_ENV = 'QNET_SCREENSHOT_PHRASE';

// The App Store display sizes, portrait, the preferred size first; `names` picks a type only when no type's screen size
// can be read.
const DEVICES = Object.freeze({
  iphone: Object.freeze({ dir: 'iphone-6.9', family: 'iPhone', sizes: [[1320, 2868], [1290, 2796]], names: /Pro Max/ }),
  ipad: Object.freeze({ dir: 'ipad-13', family: 'iPad', sizes: [[2064, 2752], [2048, 2732]], names: /13-inch|12\.9-inch/ }),
});

const STATUS_BAR = Object.freeze(['--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
  '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100']);

// The send review's Confirm arms 1.5 s after it appears (SEND_ARM_MS): each scene is captured once its screen settled.
const SETTLE_MS = 2500;
const PASTEBOARD = Object.freeze(['password', 'phrase', 'clear']);
const SHOT_NAME = /^[0-9]{2}-[a-z]+$/;
const FAILED_DIR = 'failed';

/** The flow files screenshots.yaml runs, in order, each with the scenes it captures (control.js "shot/<name>"). */
function flowScenes() {
  const text = fs.readFileSync(MAIN_FLOW, 'utf8');
  return [...text.matchAll(/^- runFlow: (\S+\.yaml)\r?$/gm)].map(([, file]) => ({
    file,
    shots: [...fs.readFileSync(path.join(FLOWS, file), 'utf8').matchAll(/ACTION: "shot\/([^"]+)"/g)].map((m) => m[1]),
  }));
}

/** Every scene's file name (without .png), in the order the flows capture them. */
function shotNames() {
  return flowScenes().flatMap((f) => f.shots);
}

/** The bundle id every flow drives (its appId line). */
function flowAppId() {
  return /^appId: (\S+)\r?$/m.exec(fs.readFileSync(MAIN_FLOW, 'utf8'))[1];
}

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Kept through flattening: colour space and pixel density; the rest describes the alpha or the old sample depth.
const KEPT_CHUNKS = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'pHYs']);

/** What a PNG's IHDR declares: { width, height, bitDepth, colorType, interlace }. Throws on anything else. */
function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)
    || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG');
  }
  return {
    width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25], interlace: buf[28],
  };
}

function pngChunks(buf) {
  const chunks = [];
  for (let o = 8; o + 12 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    chunks.push({ type: buf.toString('latin1', o + 4, o + 8), data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return chunks;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/* eslint-disable no-bitwise */
// Undoes one scanline's filter in place (PNG filter types 0-4), `prev` being the line above, already undone.
function unfilter(type, line, prev, bpp) {
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let add;
    if (type === 0) add = 0;
    else if (type === 1) add = a;
    else if (type === 2) add = b;
    else if (type === 3) add = (a + b) >> 1;
    else if (type === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      add = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
    } else throw new Error(`PNG filter type ${type}`);
    line[i] = (line[i] + add) & 0xff;
  }
}
/* eslint-enable no-bitwise */

/**
 * The PNG as 8-bit RGB with no alpha channel, as App Store Connect takes screenshots: any alpha is composited over black.
 * An 8-bit RGB PNG comes back as it is.
 */
function flattenPng(buf) {
  const info = pngInfo(buf);
  if (info.colorType === 2 && info.bitDepth === 8) return buf;
  if (![2, 6].includes(info.colorType) || ![8, 16].includes(info.bitDepth) || info.interlace !== 0) {
    throw new Error(`unsupported PNG layout: colour type ${info.colorType}, ${info.bitDepth}-bit, interlace ${info.interlace}`);
  }
  const chunks = pngChunks(buf);
  const sample = info.bitDepth / 8;
  const channels = info.colorType === 6 ? 4 : 3;
  const bpp = channels * sample;
  const stride = info.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  if (raw.length !== info.height * (stride + 1)) throw new Error('PNG image data has the wrong length');
  const outStride = info.width * 3 + 1;
  const out = Buffer.alloc(info.height * outStride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < info.height; y++) {
    const start = y * (stride + 1);
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    unfilter(raw[start], line, prev, bpp);
    for (let x = 0; x < info.width; x++) {
      const p = x * bpp;
      const alpha = channels === 4 ? line[p + 3 * sample] : 255; // the high byte of a 16-bit sample
      for (let k = 0; k < 3; k++) out[y * outStride + 1 + x * 3 + k] = Math.round((line[p + k * sample] * alpha) / 255);
    }
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(info.width, 0);
  ihdr.writeUInt32BE(info.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE, pngChunk('IHDR', ihdr),
    ...chunks.filter((c) => KEPT_CHUNKS.has(c.type)).map((c) => pngChunk(c.type, c.data)),
    pngChunk('IDAT', zlib.deflateSync(out)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Why a PNG of this IHDR is not of an App Store size of `kind`, or null.
function sizeProblem(info, kind) {
  const device = DEVICES[kind];
  if (device.sizes.some(([w, h]) => w === info.width && h === info.height)) return null;
  return `${info.width}×${info.height} is not an App Store ${device.dir} size (${device.sizes.map(([w, h]) => `${w}×${h}`).join(' or ')})`;
}

/** Why a screenshot cannot go to the App Store slot of `kind`, or null: its size, or an alpha channel. */
function shotProblem(buf, kind) {
  let info;
  try {
    info = pngInfo(buf);
  } catch (e) {
    return e.message;
  }
  const problem = sizeProblem(info, kind);
  if (problem) return problem;
  if (info.colorType !== 2) return `colour type ${info.colorType}: it must be RGB with no alpha channel`;
  return null;
}

/** Rewrites each captured file as flattenPng makes it (after the flows, so a capture answers the flow at once). */
function flattenShots(files) {
  for (const file of files) fs.writeFileSync(file, flattenPng(fs.readFileSync(file)));
}

/** Every problem of a capture folder: each device's folder must hold exactly the scenes of the flows, each fit. */
function checkDir(out) {
  const problems = [];
  const names = shotNames();
  for (const [kind, device] of Object.entries(DEVICES)) {
    const dir = path.join(out, device.dir);
    const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const name of names) {
      const file = path.join(dir, `${name}.png`);
      if (!fs.existsSync(file)) {
        problems.push(`${device.dir}/${name}.png is missing`);
        continue;
      }
      const problem = shotProblem(fs.readFileSync(file), kind);
      if (problem) problems.push(`${device.dir}/${name}.png: ${problem}`);
    }
    for (const extra of present.filter((f) => !names.includes(f.replace(/\.png$/, '')))) {
      problems.push(`${device.dir}/${extra} is not a scene of the flows`);
    }
  }
  return problems;
}

// ── Simulator ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The simulator types to capture on: the newest available iOS runtime, and in it, for each device kind, the newest type
 * whose screen has the kind's preferred App Store size (else its other one). `screenOf(type)` is [width, height] in
 * pixels, or null when unknown; only when no type of the family has a known screen is the type chosen by name.
 */
function pickDeviceTypes(runtimes, devicetypes, screenOf) {
  const runtime = runtimes.filter((r) => r.isAvailable && /iOS/.test(r.identifier)).pop();
  if (!runtime) throw new Error('no available iOS simulator runtime');
  const types = runtime.supportedDeviceTypes && runtime.supportedDeviceTypes.length ? runtime.supportedDeviceTypes : devicetypes;
  const picked = { runtime };
  for (const [kind, device] of Object.entries(DEVICES)) {
    const family = types.filter((t) => typeof t.name === 'string' && t.name.startsWith(device.family));
    const screens = new Map(family.map((t) => [t, screenOf(t)]));
    let choice = null;
    for (const [w, h] of device.sizes) {
      const fits = family.filter((t) => { const s = screens.get(t); return !!s && s[0] === w && s[1] === h; });
      if (fits.length) { choice = fits[fits.length - 1]; break; }
    }
    if (!choice && ![...screens.values()].some(Boolean)) choice = family.filter((t) => device.names.test(t.name)).pop() || null;
    if (!choice) throw new Error(`${runtime.name || runtime.identifier} has no ${device.family} type of an App Store ${device.dir} size`);
    picked[kind] = choice;
  }
  return picked;
}

const sh = (args, opts = {}) => execFileSync('xcrun', args, { encoding: 'utf8', ...opts });

// A device type's screen in pixels, from its profile in the simulator bundle.
function screenFromProfile(type) {
  try {
    const profile = path.join(type.bundlePath, 'Contents', 'Resources', 'profile.plist');
    const p = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', profile], { encoding: 'utf8' }));
    return Number.isInteger(p.mainScreenWidth) && Number.isInteger(p.mainScreenHeight) ? [p.mainScreenWidth, p.mainScreenHeight] : null;
  } catch (_) {
    return null;
  }
}

// The text goes to simctl on its standard input, never as an argument.
function pasteboard(udid, text, exec = execFileSync) {
  exec('xcrun', ['simctl', 'pbcopy', udid], { input: text });
}

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function screenshot(udid, file, exec = execFileSync) {
  exec('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', '--mask=ignored', file]);
}

/**
 * The control actions the flows send (control.js): POST /shot/<name> captures the screen as <dir>/<name>.png, its size
 * checked at once and the file listed in `state.shots`; POST /pasteboard/<password|phrase|clear> fills or empties the
 * pasteboard. Returns (method, url) => { status, body }; a body never carries a secret. `state.imported` turns true at
 * the clear the import flow sends once the wallet is open, after which a screen may be kept on failure.
 */
function controlHandler({ udid, dir, kind, secrets, state, exec = execFileSync, settleMs = SETTLE_MS }) {
  return (method, url) => {
    const [, action, name, ...rest] = String(url || '').split('/');
    try {
      if (method !== 'POST' || rest.length) throw new Error('unknown request');
      if (action === 'shot' && SHOT_NAME.test(name || '')) {
        sleep(settleMs);
        const file = path.join(dir, `${name}.png`);
        screenshot(udid, file, exec);
        const problem = sizeProblem(pngInfo(fs.readFileSync(file)), kind);
        if (problem) throw new Error(`${name}: ${problem}`);
        state.shots = [...(state.shots || []).filter((f) => f !== file), file];
        return { status: 200, body: 'ok' };
      }
      if (action === 'pasteboard' && PASTEBOARD.includes(name)) {
        pasteboard(udid, name === 'clear' ? '' : secrets[name], exec);
        if (name === 'clear') state.imported = true;
        return { status: 200, body: 'ok' };
      }
      throw new Error('unknown request');
    } catch (e) {
      return { status: 500, body: String((e && e.message) || e) };
    }
  };
}

function controlServer(options) {
  const handle = controlHandler(options);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const { status, body } = handle(req.method, req.url);
      res.writeHead(status, { 'content-type': 'text/plain' }).end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }),
    }));
  });
}

/** The flow runner's environment: the control address and the wallet kind added, the recovery phrase taken out. */
function maestroEnv(base, { control, own }) {
  const env = {
    ...base,
    MAESTRO_QNET_CONTROL: control,
    MAESTRO_QNET_OWN_WALLET: own ? 'true' : 'false',
    MAESTRO_CLI_NO_ANALYTICS: '1',
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    MAESTRO_DRIVER_STARTUP_TIMEOUT: base.MAESTRO_DRIVER_STARTUP_TIMEOUT || '240000',
  };
  delete env[PHRASE_ENV];
  return env;
}

/** The flow runner's arguments: the simulator named by its udid, so another booted one is never asked about or taken. */
function flowArgs(udid) {
  return ['--device', udid, 'test', MAIN_FLOW];
}

function runFlows(udid, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('maestro', flowArgs(udid), { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

// GitHub hides a value registered this way from every later log line.
function mask(value) {
  if (process.env.GITHUB_ACTIONS === 'true' && value) process.stdout.write(`::add-mask::${value}\n`);
}

/** The run's password (fresh each run) and recovery phrase: the secret's, or a new 12-word one. */
function runSecrets(env) {
  const bip39 = require('bip39');
  const given = String(env[PHRASE_ENV] || '').trim().split(/\s+/).filter(Boolean).join(' ');
  if (given && !bip39.validateMnemonic(given)) throw new Error(`${PHRASE_ENV} is not a valid 12 or 24 word recovery phrase`);
  const secrets = { password: crypto.randomBytes(12).toString('base64url'), phrase: given || bip39.generateMnemonic(128) };
  mask(secrets.phrase);
  mask(secrets.password);
  return { secrets, own: !!given };
}

async function captureDevice({ kind, picked, app, out, secrets, own }) {
  const device = DEVICES[kind];
  const dir = path.join(out, device.dir);
  fs.mkdirSync(dir, { recursive: true });
  const udid = sh(['simctl', 'create', `store-${device.dir}`, picked[kind].identifier, picked.runtime.identifier]).trim();
  const state = { imported: false, shots: [] };
  const control = await controlServer({ udid, dir, kind, secrets, state });
  try {
    sh(['simctl', 'boot', udid]);
    sh(['simctl', 'bootstatus', udid, '-b'], { stdio: 'ignore' });
    sh(['simctl', 'spawn', udid, 'defaults', 'write', 'Apple Global Domain', 'AppleLanguages', '-array', 'en']);
    sh(['simctl', 'spawn', udid, 'defaults', 'write', 'Apple Global Domain', 'AppleLocale', '-string', 'en_US']);
    sh(['simctl', 'status_bar', udid, 'override', ...STATUS_BAR]);
    sh(['simctl', 'install', udid, app]);
    const code = await runFlows(udid, maestroEnv(process.env, { control: control.url, own }));
    if (code !== 0) {
      // Only once the wallet is open: before that the screen may show the recovery phrase.
      if (state.imported) {
        fs.mkdirSync(path.join(out, FAILED_DIR), { recursive: true });
        try { screenshot(udid, path.join(out, FAILED_DIR, `${device.dir}.png`)); } catch (_) { /* the log says why */ }
      }
      throw new Error(`the flows stopped on the ${picked[kind].name} (exit ${code})`);
    }
    flattenShots(state.shots);
  } finally {
    await control.close();
    for (const args of [['simctl', 'shutdown', udid], ['simctl', 'delete', udid]]) {
      try { sh(args, { stdio: 'ignore' }); } catch (_) { /* the simulator goes with the runner */ }
    }
  }
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

async function capture({ app, out }) {
  if (!app || !out) throw new Error('capture needs --app <QNetMobile.app> and --out <dir>');
  const bundleId = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Info.plist')],
    { encoding: 'utf8' }).trim();
  if (bundleId !== flowAppId()) throw new Error(`the app is ${bundleId}, the flows drive ${flowAppId()}`);
  const { secrets, own } = runSecrets(process.env);
  // Frees the runner of simulators booted before the run; the flows name their own (flowArgs).
  try { sh(['simctl', 'shutdown', 'all'], { stdio: 'ignore' }); } catch (_) { /* nothing was booted */ }
  const picked = pickDeviceTypes(JSON.parse(sh(['simctl', 'list', '-j', 'runtimes'])).runtimes,
    JSON.parse(sh(['simctl', 'list', '-j', 'devicetypes'])).devicetypes, screenFromProfile);
  fs.mkdirSync(out, { recursive: true });
  for (const kind of Object.keys(DEVICES)) {
    console.log(`[screenshots] ${picked[kind].name}, ${picked.runtime.name}`);
    await captureDevice({ kind, picked, app, out, secrets, own });
  }
  summary(['## App Store screenshots', '',
    `${Object.keys(DEVICES).map((k) => picked[k].name).join(' and ')}, ${picked.runtime.name}; ${own
      ? `the wallet of ${PHRASE_ENV}` : `a new wallet (${PHRASE_ENV} is not set)`}.`]);
}

function check(out) {
  const problems = checkDir(out);
  const rows = Object.values(DEVICES).flatMap((d) => shotNames().map((name) => {
    const file = path.join(out, d.dir, `${name}.png`);
    let pixels = 'missing';
    try {
      const info = pngInfo(fs.readFileSync(file));
      pixels = `${info.width}×${info.height}`;
    } catch (_) { /* listed by checkDir */ }
    return `| ${d.dir}/${name}.png | ${pixels} |`;
  }));
  summary(['', '| Screenshot | Pixels |', '|---|---|', ...rows]);
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length) throw new Error(`${problems.length} screenshot problem(s)`);
  console.log(`[screenshots] ${rows.length} screenshots fit the App Store sizes`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (command === 'capture') await capture({ app: option('--app'), out: option('--out') });
  else if (command === 'check' && rest[0]) check(rest[0]);
  else throw new Error('usage: store-screenshots.js capture --app <QNetMobile.app> --out <dir> | check <dir>');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEVICES, STATUS_BAR, SETTLE_MS, PHRASE_ENV, PNG_SIGNATURE,
  flowScenes, shotNames, flowAppId, pngInfo, pngChunks, pngChunk, flattenPng, flattenShots, shotProblem, checkDir,
  pickDeviceTypes, pasteboard, controlHandler, controlServer, maestroEnv, flowArgs, runSecrets,
};
