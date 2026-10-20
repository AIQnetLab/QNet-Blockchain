// The App Store screenshot run (scripts/store-screenshots.js, store-screenshots/*.yaml, ios-build.yml job screenshots):
// the scenes it visits, the English texts and element ids its flows find, the sizes it accepts, the simulator types it
// picks, and the recovery phrase reaching the simulator only on simctl's standard input.
const { Buffer } = require('buffer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const bip39 = require('bip39');
const shots = require('../scripts/store-screenshots');
const en = require('../src/i18n/translations').default.en;
const { LANGUAGES } = require('../src/i18n');
const { PASSWORD_MIN_LENGTH } = require('../src/crypto/PasswordStrength');

const ROOT = path.join(__dirname, '..');
const FLOWS = path.join(ROOT, 'store-screenshots');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
const flow = (file) => read(FLOWS, file);
const flowFiles = fs.readdirSync(FLOWS).filter((f) => f.endsWith('.yaml')).sort();
const allFlows = flowFiles.map(flow).join('\n');
const workflow = read(ROOT, '..', '..', '.github', 'workflows', 'ios-build.yml');
const job = (name, next) => workflow.slice(workflow.indexOf(`\n  ${name}:\n`), workflow.indexOf(`\n  ${next}:\n`));
const bottomTabs = /BOTTOM_TABS = Object\.freeze\(\[([^\]]+)\]\)/.exec(read(ROOT, 'src', 'components', 'BottomBar.js'))[1]
  .match(/'([a-z]+)'/g).map((s) => s.slice(1, -1));

// A PNG of the given IHDR, from the script's own chunk writer; with `idat` (the raw filtered scanlines) a whole image,
// else the header alone.
function png({ width, height, colorType = 2, bitDepth = 8, idat = null, extra = [] }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([
    shots.PNG_SIGNATURE, shots.pngChunk('IHDR', ihdr),
    ...extra.map(([type, data]) => shots.pngChunk(type, data)),
    ...(idat ? [shots.pngChunk('IDAT', zlib.deflateSync(idat))] : []), shots.pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* eslint-disable no-bitwise */
// Scanlines with filter type y % 5 on row y, encoded here independently of the script's decoder.
function filtered(pixels, stride, bpp) {
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y * stride < pixels.length; y++) {
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    const type = y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = type;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a
        : (Math.abs(p - b) <= Math.abs(p - c) ? b : c);
      out[i + 1] = (line[i] - [0, a, b, (a + b) >> 1, paeth][type]) & 0xff;
    }
    rows.push(out);
    prev = line;
  }
  return Buffer.concat(rows);
}
/* eslint-enable no-bitwise */

describe('the flows', () => {
  it('visit the six scenes in the listing\'s order after the import, and never type anything or confirm a send', () => {
    expect(shots.flowScenes()).toEqual([
      { file: 'import.yaml', shots: [] },
      { file: 'autolock.yaml', shots: [] },
      { file: 'wallet.yaml', shots: ['01-wallet'] },
      { file: 'send.yaml', shots: ['02-send'] },
      { file: 'receive.yaml', shots: ['03-receive'] },
      { file: 'history.yaml', shots: ['04-history'] },
      { file: 'node.yaml', shots: ['05-node'] },
      { file: 'settings.yaml', shots: ['06-settings'] },
    ]);
    expect(flowFiles).toEqual([...shots.flowScenes().map((f) => f.file), 'paste.yaml', 'screenshots.yaml'].sort());
    for (const [file, tab] of [['wallet.yaml', 'assets'], ['history.yaml', 'history'], ['node.yaml', 'node'], ['settings.yaml', 'settings']]) {
      expect([file, bottomTabs.includes(tab), flow(file).includes(`id: "tab-${tab}"`)]).toEqual([file, true, true]);
    }
    // Send and Receive open from Assets, and each returns there.
    expect(flow('send.yaml')).toMatch(/id: "assets-send"[\s\S]*shot\/02-send[\s\S]*tapOn: "\.\*Back"\s*$/);
    expect(flow('receive.yaml')).toMatch(/tapOn: "Receive"[\s\S]*shot\/03-receive[\s\S]*tapOn: "\.\*Back"\s*$/);
    // Settings captures the language list open.
    expect(flow('settings.yaml')).toMatch(/tapOn: "English"[\s\S]*visible: "Русский"[\s\S]*shot\/06-settings/);
    // The send review is captured and cancelled; nothing is ever typed into the app, and the keyboard's return submits
    // only the Auto-Lock change's password prompt.
    expect(flow('send.yaml')).toMatch(/shot\/02-send[\s\S]*tapOn: "Cancel"/);
    expect(allFlows).not.toMatch(/send-review-confirm|"Confirm"|inputText|pasteText|eraseText/);
    expect(flowFiles.filter((f) => /pressKey/.test(flow(f)))).toEqual(['autolock.yaml']);
  });

  it('keep the wallet open: Auto-Lock is Never from right after the import, and set back before the last capture', () => {
    const screen = read(ROOT, 'src', 'screens', 'WalletScreen.js');
    // The app's default is the row value the flow opens the choices from; a longer time asks for the password, which the
    // keyboard's return submits.
    expect(screen).toContain("const DEFAULT_AUTO_LOCK = '1';");
    expect(/const AUTO_LOCK_CHOICES = \[([^\]]+)\]/.exec(screen)[1]).toContain("'never'");
    expect(screen).toContain("if (!(await confirmFresh(t('auth_change_autolock')))) return;");
    expect(screen).toMatch(/placeholder=\{t\('password'\)\}[^>]*onSubmitEditing=\{submitFresh\}/);
    expect(flow('autolock.yaml')).toMatch(new RegExp([
      'id: "tab-settings"', 'tapOn: "1 minute"', 'tapOn: "Never"', 'ACTION: "pasteboard/password"', 'file: paste\\.yaml',
      'FIELD: "Password"', 'pressKey: Enter', 'ACTION: "pasteboard/clear"', 'visible: "Never"',
    ].join('[\\s\\S]*')));
    expect(flow('settings.yaml')).toMatch(/tapOn: "Never"\n- tapOn: "1 minute"\n- extendedWaitUntil:\n\s+notVisible: "Never"[\s\S]*tapOn: "English"/);
    // The import screen holds the phrase under its own one-minute lock: each wait after the paste stays well under it.
    const afterPhrase = flow('import.yaml').split('pasteboard/phrase')[1];
    const waits = [...afterPhrase.matchAll(/timeout: (\d+)/g)].map((m) => Number(m[1]));
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(40000);
    // Every animation wait is bounded well below the flow runner's default of 15 s.
    expect(allFlows).not.toMatch(/- waitForAnimationToEnd\s*\n(?!\s+timeout:)/);
    const animation = [...allFlows.matchAll(/- waitForAnimationToEnd:\n\s+timeout: (\d+)/g)].map((m) => Number(m[1]));
    expect(animation).toHaveLength((allFlows.match(/waitForAnimationToEnd/g) || []).length);
    expect(animation.every((ms) => ms <= 3000)).toBe(true);
  });

  it('find the app by its English texts and its element ids', () => {
    const texts = [
      ['Import Existing Wallet', en.import_wallet],
      ['Step 1: Create a password.*', en.import_step1.replace('{min}', String(PASSWORD_MIN_LENGTH))],
      ['Enter password', en.enter_password],
      ['Confirm password', en.confirm_password],
      ['.*Passwords match', `✓ ${en.pw_match}`],
      ['Next', en.common_next],
      ['Step 2: Enter your recovery phrase', en.import_step2],
      ['Enter the 12 or 24 word recovery phrase', en.import_placeholder],
      ['Words: (12|24) ✓', `${en.import_word_count_live.replace('{count}', '12')} ✓`],
      ['I accept the .*', en.terms_accept_template.replace('{terms}', en.terms_of_service)],
      ['Import Wallet', en.import_title],
      ['To address', en.send_to_address],
      ['Enter an EON address', en.send_placeholder_eon],
      ['Check this send', en.send_review_title],
      ['Cancel', en.cancel],
      ['.*Back', `← ${en.common_back}`],
      ['Receive', en.assets_receive],
      ['No transactions yet', en.hist_empty],
      ['Checking node status.*', en.node_checking],
      ['English', LANGUAGES.find((l) => l.code === 'en').name],
      ['Русский', LANGUAGES.find((l) => l.code === 'ru').name],
      ['1 minute', en.autolock_1],
      ['Never', en.autolock_never],
      ['Password', en.password],
    ];
    for (const [pattern, shown] of texts) {
      expect([pattern, new RegExp(`^(?:${pattern})$`, 'is').test(shown)]).toEqual([pattern, true]);
    }
    // Every text a flow looks for is one of those, or the system's Paste, the 25% button, or the ticked checkbox.
    const screen = read(ROOT, 'src', 'screens', 'WalletScreen.js');
    expect(screen).toContain('>25%</Text>');
    const used = [...allFlows.matchAll(/(?:tapOn|longPressOn|visible|notVisible|text|leftOf|below|FIELD): "([^"]+)"/g)].map((m) => m[1]);
    const known = new Set([...texts.map(([p]) => p), 'Paste', '25%', '✓']);
    expect(used.filter((u) => !known.has(u))).toEqual([]);
    // The QNC row's figure, never its dash.
    const figure = new RegExp(`^(?:${/visible: '([^']+)'/.exec(flow('wallet.yaml'))[1]})$`, 'is');
    expect(['QNC 0', 'QNC 42,578.81988', '0'].map((s) => figure.test(s))).toEqual([true, true, true]);
    expect(['QNC —', 'QNC'].map((s) => figure.test(s))).toEqual([false, false]);
    // Element ids: the bottom bar's tabs and testIDs the screens set.
    const sources = ['screens/WalletScreen.js', 'screens/HistoryTab.js'].map((f) => read(ROOT, 'src', f)).join('\n');
    for (const id of new Set([...allFlows.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]))) {
      const found = id.startsWith('tab-') ? bottomTabs.includes(id.slice(4)) : sources.includes(`testID="${id}"`);
      expect([id, found]).toEqual([id, true]);
    }
  });

  it('drive the app this project builds, on the simulator the run created', () => {
    const pbx = read(ROOT, 'ios', 'QNetMobile.xcodeproj', 'project.pbxproj');
    const ids = new Set([...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]));
    expect([...ids]).toEqual([shots.flowAppId()]);
    for (const file of flowFiles) expect([file, flow(file).split('\n').includes(`appId: ${shots.flowAppId()}`)]).toEqual([file, true]);
    expect(shots.flowArgs('UDID-9')).toEqual(['--device', 'UDID-9', 'test', path.join(FLOWS, 'screenshots.yaml')]);
  });
});

describe('the recovery phrase', () => {
  const secrets = { password: 'Pw-0123456789', phrase: bip39.generateMnemonic(128) };

  it('comes only from QNET_SCREENSHOT_PHRASE; a run without it makes a new one', () => {
    expect(shots.PHRASE_ENV).toBe('QNET_SCREENSHOT_PHRASE');
    const given = bip39.generateMnemonic(128);
    const own = shots.runSecrets({ QNET_SCREENSHOT_PHRASE: `  ${given.split(' ').join('\n ')} ` });
    expect([own.own, own.secrets.phrase]).toEqual([true, given]);
    const fresh = shots.runSecrets({});
    expect([fresh.own, bip39.validateMnemonic(fresh.secrets.phrase), fresh.secrets.phrase.split(' ').length]).toEqual([false, true, 12]);
    expect(fresh.secrets.password.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
    expect(shots.runSecrets({}).secrets.password).not.toBe(fresh.secrets.password);
    let message = '';
    try { shots.runSecrets({ QNET_SCREENSHOT_PHRASE: 'zebra orbit '.repeat(6) }); } catch (e) { message = e.message; }
    expect(message).toMatch(/QNET_SCREENSHOT_PHRASE is not a valid/);
    expect(message).not.toMatch(/zebra|orbit/);
    // The flows never read it, nor the password: they only ask the script to put them on the pasteboard.
    expect(allFlows).not.toMatch(/\$\{[^}]*(PHRASE|PASSWORD)/);
    expect(flow('import.yaml')).toMatch(/pasteboard\/password[\s\S]*Enter password[\s\S]*pasteboard\/phrase[\s\S]*recovery phrase"[\s\S]*pasteboard\/clear/);
  });

  it('reaches the simulator only on simctl\'s standard input, and never the flow runner\'s environment', () => {
    const calls = [];
    const exec = (cmd, args, opts) => calls.push({ cmd, args, input: opts && opts.input });
    shots.pasteboard('UDID-1', secrets.phrase, exec);
    expect(calls).toEqual([{ cmd: 'xcrun', args: ['simctl', 'pbcopy', 'UDID-1'], input: secrets.phrase }]);

    const env = shots.maestroEnv({ PATH: '/bin', QNET_SCREENSHOT_PHRASE: secrets.phrase }, { control: 'http://127.0.0.1:9', own: true });
    expect(env.QNET_SCREENSHOT_PHRASE).toBeUndefined();
    expect(Object.values(env)).not.toContain(secrets.phrase);
    expect([env.MAESTRO_QNET_CONTROL, env.MAESTRO_QNET_OWN_WALLET, env.PATH]).toEqual(['http://127.0.0.1:9', 'true', '/bin']);
    expect(shots.maestroEnv({}, { control: 'x', own: false }).MAESTRO_QNET_OWN_WALLET).toBe('false');
  });

  it('is put on the pasteboard on request, and no answer of the control port carries it', () => {
    const calls = [];
    const state = { imported: false };
    const handle = shots.controlHandler({
      udid: 'UDID-2', dir: os.tmpdir(), kind: 'iphone', secrets, state, settleMs: 0,
      exec: (cmd, args, opts) => calls.push({ args, input: opts && opts.input }),
    });
    const answers = [
      handle('POST', '/pasteboard/password'), handle('POST', '/pasteboard/phrase'),
      handle('GET', '/pasteboard/phrase'), handle('POST', '/pasteboard/secret'), handle('POST', '/pasteboard/phrase/x'),
      handle('POST', '/shot/../../etc'),
    ];
    expect(answers.map((a) => a.status)).toEqual([200, 200, 500, 500, 500, 500]);
    expect(calls.map((c) => c.input)).toEqual([secrets.password, secrets.phrase]);
    expect(state.imported).toBe(false);
    expect(handle('POST', '/pasteboard/clear')).toEqual({ status: 200, body: 'ok' });
    expect([calls[2].input, state.imported]).toEqual(['', true]);
    for (const a of answers) expect(a.body).not.toMatch(new RegExp(`${secrets.password}|${secrets.phrase.split(' ')[0]} `));
  });

  it('is asked for over a port on the loopback address only', async () => {
    const calls = [];
    const server = await shots.controlServer({
      udid: 'UDID-4', dir: os.tmpdir(), kind: 'ipad', secrets, state: {}, settleMs: 0,
      exec: (cmd, args, opts) => calls.push(opts && opts.input),
    });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const post = (p) => new Promise((resolve, reject) => {
        const req = require('http').request(server.url + p, { method: 'POST' }, (res) => {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => resolve([res.statusCode, body]));
        });
        req.on('error', reject);
        req.end('');
      });
      expect(await post('/pasteboard/phrase')).toEqual([200, 'ok']);
      expect(await post('/pasteboard/nothing')).toEqual([500, 'unknown request']);
      expect(calls).toEqual([secrets.phrase]);
    } finally {
      await server.close();
    }
  });

  it('is given by the workflow only to the step that captures, from the repository secret', () => {
    const screenshots = job('screenshots', 'testflight');
    expect(workflow.match(/secrets\.QNET_SCREENSHOT_PHRASE/g)).toHaveLength(1);
    const step = screenshots.slice(screenshots.indexOf('- name: Take the screenshots'), screenshots.indexOf('- name: Check the screenshot sizes'));
    expect(step).toMatch(/env:\n\s+QNET_SCREENSHOT_PHRASE: \$\{\{ secrets\.QNET_SCREENSHOT_PHRASE \}\}\n/);
    expect(workflow).not.toMatch(/echo[^\n]*PHRASE|-e QNET|-e MAESTRO|set -x/);
  });
});

describe('the screenshots', () => {
  it('fit only the App Store sizes, in portrait, without alpha', () => {
    const fits = (kind, width, height, colorType = 2) => shots.shotProblem(png({ width, height, colorType }), kind);
    expect([fits('iphone', 1320, 2868), fits('iphone', 1290, 2796), fits('ipad', 2064, 2752), fits('ipad', 2048, 2732)])
      .toEqual([null, null, null, null]);
    expect(fits('iphone', 1206, 2622)).toMatch(/1206×2622 is not an App Store iphone-6\.9 size/);
    expect(fits('iphone', 2868, 1320)).toMatch(/is not an App Store/);
    expect(fits('ipad', 1320, 2868)).toMatch(/is not an App Store ipad-13 size/);
    expect(fits('ipad', 1640, 2360)).toMatch(/is not an App Store/);
    expect(fits('iphone', 1320, 2868, 6)).toMatch(/no alpha channel/);
    expect(shots.shotProblem(Buffer.from('not an image'), 'ipad')).toBe('not a PNG');
  });

  it('are flattened to 8-bit RGB over black, through every scanline filter', () => {
    const width = 7;
    const height = 10;
    const rgba = Buffer.from(Array.from({ length: width * height * 4 }, (_, i) => (i * 37 + (i >> 2) * 11) % 256)); // eslint-disable-line no-bitwise
    const source = png({ width, height, colorType: 6, idat: filtered(rgba, width * 4, 4), extra: [['sRGB', Buffer.from([0])], ['tEXt', Buffer.from('k\0v')]] });
    const flat = shots.flattenPng(source);
    expect(shots.pngInfo(flat)).toEqual({ width, height, bitDepth: 8, colorType: 2, interlace: 0 });
    expect(shots.pngChunks(flat).map((c) => c.type)).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND']);
    const raw = zlib.inflateSync(Buffer.concat(shots.pngChunks(flat).filter((c) => c.type === 'IDAT').map((c) => c.data)));
    const expected = [];
    for (let p = 0; p < width * height; p++) {
      if (p % width === 0) expected.push(0);
      for (let k = 0; k < 3; k++) expected.push(Math.round((rgba[p * 4 + k] * rgba[p * 4 + 3]) / 255));
    }
    expect([...raw]).toEqual(expected);

    // 16-bit RGB keeps each sample's high byte.
    const rgb16 = Buffer.from(Array.from({ length: width * height * 6 }, (_, i) => (i * 53 + 7) % 256));
    const raw16 = zlib.inflateSync(shots.pngChunks(shots.flattenPng(png({ width, height, bitDepth: 16, idat: filtered(rgb16, width * 6, 6) })))
      .find((c) => c.type === 'IDAT').data);
    const expected16 = [];
    for (let p = 0; p < width * height; p++) {
      if (p % width === 0) expected16.push(0);
      for (let k = 0; k < 3; k++) expected16.push(rgb16[p * 6 + k * 2]);
    }
    expect([...raw16]).toEqual(expected16);

    // Already RGB: returned as it is; the app's own RGBA logo flattens at its size.
    const plain = png({ width: 2, height: 1, idat: Buffer.alloc(7) });
    expect(shots.flattenPng(plain)).toBe(plain);
    const logo = fs.readFileSync(path.join(ROOT, 'assets', 'qnet_logo.png'));
    const flatLogo = shots.pngInfo(shots.flattenPng(logo));
    expect([flatLogo.width, flatLogo.height, flatLogo.colorType]).toEqual([shots.pngInfo(logo).width, shots.pngInfo(logo).height, 2]);
  });

  it('are captured on request, checked at once, and a folder holds exactly the scenes of the flows', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qnet-shots-'));
    try {
      const sizes = { iphone: [1320, 2868], ipad: [2048, 2732] };
      for (const [kind, device] of Object.entries(shots.DEVICES)) {
        const dir = path.join(out, device.dir);
        fs.mkdirSync(dir);
        const [width, height] = sizes[kind];
        const handle = shots.controlHandler({
          udid: `UDID-${kind}`, dir, kind, secrets: {}, state: {}, settleMs: 0,
          exec: (cmd, args) => fs.writeFileSync(args[args.length - 1], png({ width, height })),
        });
        for (const name of shots.shotNames()) expect(handle('POST', `/shot/${name}`)).toEqual({ status: 200, body: 'ok' });
      }
      expect(shots.checkDir(out)).toEqual([]);

      // A capture with an alpha channel answers at once and is flattened once the flows end.
      const state = {};
      const rgba = shots.controlHandler({
        udid: 'UDID-5', dir: out, kind: 'iphone', secrets: {}, state, settleMs: 0,
        exec: (cmd, args) => fs.writeFileSync(args[args.length - 1], png({ width: 1320, height: 2868, colorType: 6 })),
      });
      expect([rgba('POST', '/shot/09-alpha'), rgba('POST', '/shot/09-alpha')].map((a) => a.status)).toEqual([200, 200]);
      expect(state.shots).toEqual([path.join(out, '09-alpha.png')]);
      const small = path.join(out, '10-small.png');
      fs.writeFileSync(small, png({ width: 2, height: 2, colorType: 6, idat: filtered(Buffer.alloc(16, 200), 8, 4) }));
      shots.flattenShots([small]);
      expect(shots.pngInfo(fs.readFileSync(small)).colorType).toBe(2);
      fs.rmSync(path.join(out, '09-alpha.png'));
      fs.rmSync(small);

      const wrong = shots.controlHandler({
        udid: 'UDID-3', dir: path.join(out, 'ipad-13'), kind: 'ipad', secrets: {}, state: {}, settleMs: 0,
        exec: (cmd, args) => fs.writeFileSync(args[args.length - 1], png({ width: 1668, height: 2420 })),
      })('POST', '/shot/05-node');
      expect(wrong.status).toBe(500);
      expect(wrong.body).toMatch(/05-node: 1668×2420 is not an App Store ipad-13 size/);
      fs.rmSync(path.join(out, 'iphone-6.9', '03-receive.png'));
      fs.writeFileSync(path.join(out, 'iphone-6.9', 'extra.png'), png({ width: 1320, height: 2868 }));
      expect(shots.checkDir(out)).toEqual([
        'iphone-6.9/03-receive.png is missing',
        'iphone-6.9/extra.png is not a scene of the flows',
        'ipad-13/05-node.png: 1668×2420 is not an App Store ipad-13 size (2064×2752 or 2048×2732)',
      ]);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('the simulator types', () => {
  const types = [
    ['iPhone 15 Pro Max', [1290, 2796]], ['iPhone 16 Pro Max', [1320, 2868]], ['iPhone 17', [1206, 2622]],
    ['iPhone Air', [1260, 2736]], ['iPad Air 13-inch (M3)', [2048, 2732]], ['iPad Pro 13-inch (M4)', [2064, 2752]],
    ['iPad Pro 11-inch (M4)', [1668, 2420]],
  ].map(([name, screen]) => ({ name, identifier: name.replace(/\W+/g, '-'), screen }));
  const runtimes = (supported) => [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', name: 'iOS 18.0', isAvailable: true, supportedDeviceTypes: [] },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0', name: 'iOS 26.0', isAvailable: true, supportedDeviceTypes: supported },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', name: 'iOS 27.0', isAvailable: false, supportedDeviceTypes: supported },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-26-0', name: 'watchOS 26.0', isAvailable: true },
  ];
  const screenOf = (t) => t.screen;
  const names = (p) => [p.runtime.name, p.iphone.name, p.ipad.name];

  it('are the newest of the preferred App Store size in the newest available iOS runtime', () => {
    expect(names(shots.pickDeviceTypes(runtimes(types), [], screenOf))).toEqual(['iOS 26.0', 'iPhone 16 Pro Max', 'iPad Pro 13-inch (M4)']);
    const older = types.filter((t) => !/16 Pro Max|Pro 13-inch/.test(t.name));
    expect(names(shots.pickDeviceTypes(runtimes(older), [], screenOf))).toEqual(['iOS 26.0', 'iPhone 15 Pro Max', 'iPad Air 13-inch (M3)']);
    // A runtime that lists no types: the device type list.
    expect(names(shots.pickDeviceTypes(runtimes([]).slice(0, 2), types, screenOf))).toEqual(['iOS 26.0', 'iPhone 16 Pro Max', 'iPad Pro 13-inch (M4)']);
  });

  it('fall back to the name only when no screen size can be read, and never take another size', () => {
    expect(names(shots.pickDeviceTypes(runtimes(types), [], () => null))).toEqual(['iOS 26.0', 'iPhone 16 Pro Max', 'iPad Pro 13-inch (M4)']);
    const none = types.filter((t) => !/Pro Max|13-inch/.test(t.name));
    expect(() => shots.pickDeviceTypes(runtimes(none), [], screenOf)).toThrow(/iOS 26\.0 has no iPhone type of an App Store iphone-6\.9 size/);
    expect(() => shots.pickDeviceTypes(runtimes(types).slice(2), [], screenOf)).toThrow(/no available iOS simulator runtime/);
  });
});

describe('the workflow', () => {
  it('takes them on a manual run with the screenshots input, from the build that survived its launch', () => {
    expect(workflow).toMatch(/\n {6}screenshots:\n {8}description: [^\n]+\n {8}type: boolean\n {8}default: false\n/);
    const simulator = job('simulator', 'screenshots');
    const gate = "if: github.event_name == 'workflow_dispatch' && inputs.screenshots";
    expect(simulator.indexOf('- name: Pack the simulator app')).toBeGreaterThan(simulator.indexOf('- name: Launch on a simulator'));
    expect(simulator).toMatch(new RegExp(`- name: Pack the simulator app for the screenshots\\n\\s+${gate.replace(/[.|&]/g, '\\$&')}\\n[\\s\\S]*tar -czf`));
    expect(simulator).toMatch(/name: ios-simulator-app\n/);
    // Neither step that keeps the build for them can fail the simulator job, which TestFlight waits for.
    for (const step of ['Pack the simulator app for the screenshots', 'Keep the simulator app for the screenshots']) {
      expect(simulator).toContain(`- name: ${step}\n        ${gate}\n        continue-on-error: true\n`);
    }

    const screenshots = job('screenshots', 'testflight');
    expect(screenshots).toMatch(/\n {4}needs: simulator\n/);
    expect(screenshots).toContain(`\n    ${gate}\n`);
    expect(screenshots).toMatch(/name: ios-simulator-app\n/);
    expect(screenshots).toContain('node scripts/store-screenshots.js capture --app "$APP" --out "$RUNNER_TEMP/app-store-screenshots"');
    expect(screenshots).toContain('node scripts/store-screenshots.js check "$RUNNER_TEMP/app-store-screenshots"');
    expect(screenshots).toMatch(/name: app-store-screenshots\n\s+path: \$\{\{ runner\.temp \}\}\/app-store-screenshots\n\s+if-no-files-found: error/);
    // A failed capture or check keeps the whole folder, failed/ included.
    expect(screenshots).toMatch(/if: failure\(\)\n\s+uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: app-store-screenshots-failed\n\s+path: \$\{\{ runner\.temp \}\}\/app-store-screenshots\n/);
    // One fixed release of the flow runner: its archive checked against a pinned SHA-256 before it is unpacked, no
    // install script, no analytics, and the version checked after.
    const install = screenshots.slice(screenshots.indexOf('- name: Install the flow runner'), screenshots.indexOf('- name: Fetch the simulator app'));
    expect(install).toMatch(/env:\n\s+MAESTRO_VERSION: \d+\.\d+\.\d+\n\s+MAESTRO_SHA256: [0-9a-f]{64}\n\s+MAESTRO_CLI_NO_ANALYTICS: '1'\n\s+MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true'\n/);
    expect(install).toContain('curl -fsSL -o "$RUNNER_TEMP/maestro.zip" "https://github.com/mobile-dev-inc/maestro/releases/download/cli-$MAESTRO_VERSION/maestro.zip"');
    expect(install).toMatch(/if \[ "\$ACTUAL" != "\$MAESTRO_SHA256" \]; then[^\n]*\n[^\n]*\n\s+exit 1\n\s+fi\n\s+unzip /);
    expect(install).not.toMatch(/\|\s*(?:ba)?sh\b/);
    expect(install).toMatch(/if \[ "\$INSTALLED" != "\$MAESTRO_VERSION" \]; then[\s\S]*exit 1/);
    // TestFlight still waits only for the checks and the launch.
    expect(workflow.slice(workflow.indexOf('\n  testflight:\n'))).toMatch(/^\n {2}testflight:\n(?:\s*#[^\n]*\n)*\s+needs: \[checks, simulator\]\n/);
  });
});
