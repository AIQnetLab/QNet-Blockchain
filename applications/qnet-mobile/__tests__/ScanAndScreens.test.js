/**
 * 28.09: the Send screen's QR scan takes a QNet address and nothing else, decoded on the device on both platforms;
 * Receive carries one plain line and no warning boxes; the address is shown whole and copies on a tap; creating a
 * wallet never moves on by itself; auto-lock offers Never; the Settings tab's gear is centred.
 * 29.09: the scan is a drawn icon inside the recipient field, at its end, instead of a word above it. The Solana Send
 * screen has its own scan (__tests__/SolanaScan.test.js); this one still takes a QNet address only.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Linking, PermissionsAndroid, Platform, StyleSheet, Text, TurboModuleRegistry } from 'react-native';
import { sha3_256 } from 'js-sha3';
import { makeT } from '../src/i18n';
import translations from '../src/i18n/translations';

jest.mock('react-native-camera-kit', () => {
  const mockReact = require('react');
  const { View: MockView } = require('react-native');
  const Camera = mockReact.forwardRef((props, ref) => mockReact.createElement(MockView, { ...props, ref }));
  return { __esModule: true, Camera, default: {} };
});

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const screen = read('src/screens/WalletScreen.js');
const t = makeT('en');

// A checksummed EON address: 19 hex, "eon", 15 hex, then the first 8 hex of SHA3-256 over the first 37 characters.
const eon = (seed) => {
  const body = `${sha3_256(seed).slice(0, 19)}eon${sha3_256(`${seed}:tail`).slice(0, 15)}`;
  return body + sha3_256(body).slice(0, 8);
};

describe('what the scan takes (utils/scanAddress)', () => {
  const { qnetAddressFromScan } = require('../src/utils/scanAddress');
  const good = eon('scan-test');

  it('a QNet address the address field accepts, trimmed and lowercase', () => {
    expect(good).toMatch(/^[0-9a-f]{19}eon[0-9a-f]{23}$/);
    expect(qnetAddressFromScan(good)).toBe(good);
    expect(qnetAddressFromScan(`  ${good.toUpperCase()}\n`)).toBe(good);
  });

  it('nothing else: a bad checksum, 64 hex, a Solana address, a link, a payment code, text, a long or non-string value', () => {
    const typo = good.slice(0, 44) + (good[44] === '0' ? '1' : '0');
    for (const text of [
      typo,
      'a'.repeat(64),
      '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      `https://aiqnet.io/address/${good}`,
      `qnet:${good}`,
      `qnet:${good}?amount=1`,
      'solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      'hello world',
      '',
      `${good} ${'x'.repeat(100)}`,
      null, undefined, 42, { address: good },
    ]) {
      expect([text, qnetAddressFromScan(text)]).toEqual([text, null]);
    }
  });
});

describe('the scan sheet (components/QrScanSheet)', () => {
  const QrScanSheet = require('../src/components/QrScanSheet').default;
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(''));
  const read = async (tree, value) => {
    await act(async () => { tree.root.findByProps({ testID: 'scan-camera' }).props.onReadCode({ nativeEvent: { codeStringValue: value } }); });
  };
  afterEach(() => { Platform.OS = 'ios'; jest.restoreAllMocks(); });

  it('fills the recipient with a QNet address once; anything else is a short note, the camera keeps scanning, nothing opens', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const onAddress = jest.fn();
    let tree;
    await act(async () => { tree = renderer.create(<QrScanSheet t={t} onAddress={onAddress} onClose={() => {}} />); });
    const camera = tree.root.findByProps({ testID: 'scan-camera' });
    expect(camera.props.allowedBarcodeTypes).toEqual(['qr']);

    for (const junk of ['https://example.org/pay', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'b'.repeat(64)]) {
      await read(tree, junk);
      expect(texts(tree)).toContain('Not a QNet address');
      expect(tree.root.findAllByProps({ testID: 'scan-camera' }).length).toBeGreaterThan(0);
    }
    expect(onAddress).not.toHaveBeenCalled();

    const good = eon('sheet');
    await read(tree, good.toUpperCase());
    await read(tree, eon('second'));
    expect(onAddress.mock.calls).toEqual([[good]]);
    expect(openURL).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('Android asks for the camera only when the sheet opens; a refusal shows one line, the way to the settings and no camera', async () => {
    Platform.OS = 'android';
    const ask = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('never_ask_again');
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    let tree;
    await act(async () => { tree = renderer.create(<QrScanSheet t={t} onAddress={() => {}} onClose={() => {}} />); });
    expect(ask).toHaveBeenCalledWith(PermissionsAndroid.PERMISSIONS.CAMERA);
    expect(tree.root.findAllByProps({ testID: 'scan-camera' })).toHaveLength(0);
    expect(texts(tree)).toContain(t('scan_camera_off'));
    act(() => { tree.root.findByProps({ testID: 'scan-settings' }).props.onPress(); });
    expect(openSettings).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('back from the settings with the camera allowed, the scan starts in the same sheet', async () => {
    Platform.OS = 'android';
    jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('denied');
    const check = jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
    let onChange;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, fn) => { onChange = fn; return { remove: () => {} }; });
    let tree;
    await act(async () => { tree = renderer.create(<QrScanSheet t={t} onAddress={() => {}} onClose={() => {}} />); });
    expect(tree.root.findAllByProps({ testID: 'scan-camera' })).toHaveLength(0);
    await act(async () => { onChange('active'); });
    expect(check).toHaveBeenCalledWith(PermissionsAndroid.PERMISSIONS.CAMERA);
    expect(tree.root.findAllByProps({ testID: 'scan-camera' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('iOS asks through the camera module when the sheet opens; a refusal shows the same line instead of a black frame', async () => {
    const mod = { requestDeviceCameraAuthorization: jest.fn().mockResolvedValue(false), checkDeviceCameraAuthorizationStatus: jest.fn() };
    jest.spyOn(TurboModuleRegistry, 'get').mockImplementation((name) => (name === 'RNCameraKitModule' ? mod : null));
    let tree;
    await act(async () => { tree = renderer.create(<QrScanSheet t={t} onAddress={() => {}} onClose={() => {}} />); });
    expect(mod.requestDeviceCameraAuthorization).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByProps({ testID: 'scan-camera' })).toHaveLength(0);
    expect(texts(tree)).toContain(t('scan_camera_off'));
    expect(tree.root.findAllByProps({ testID: 'scan-settings' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('Close closes it', async () => {
    const onClose = jest.fn();
    let tree;
    await act(async () => { tree = renderer.create(<QrScanSheet t={t} onAddress={() => {}} onClose={onClose} />); });
    act(() => { tree.root.findByProps({ testID: 'scan-close' }).props.onPress(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });
});

describe('the scan on the Send screen, QNet only', () => {
  const form = screen.slice(screen.indexOf('{/* Recipient Address'), screen.indexOf('{/* Amount Input */}'));

  it('the scan is an icon inside the recipient field only on QNet, and the sheet opens only for a QNet send', () => {
    // One container holds the address field and, after it, the icon button: no word on it, no row above the field.
    expect(form).toMatch(new RegExp([
      String.raw`<Text style=\{styles\.label\}>\{t\('send_to_address'\)\}</Text>\s*`,
      String.raw`<View style=\{styles\.recipientField\}>\s*<TextInput[^/]*?/>\s*`,
      String.raw`\{sendingToken\.network === 'qnet' \? \(\s*<TouchableOpacity[\s\S]*?testID="send-scan"\s*>\s*`,
      String.raw`<ScanIcon color="#00d4ff" />\s*</TouchableOpacity>\s*\) : null\}\s*</View>\s*</View>`,
    ].join('')));
    expect(form).toMatch(/style=\{\[styles\.input, styles\.recipientInput, sendingToken\.network === 'qnet' && styles\.recipientInputScan\]\}/);
    // Named for screen readers by the scan's title; the keyboard goes away and the sheet opens as before.
    expect(form).toMatch(/accessibilityRole="button"\s*accessibilityLabel=\{t\('scan_title'\)\}/);
    expect(form).toMatch(/onPress=\{\(\) => \{ Keyboard\.dismiss\(\); setShowScan\(true\); \}\}/);
    // The target reaches past the field's outer edge only, never over the text.
    expect(form).toMatch(/hitSlop=\{\{ top: 8, bottom: 8, \[rtl \? 'left' : 'right'\]: 8 \}\}/);
    expect(form).not.toMatch(/scan_button|recipientLabel/);
    for (const table of Object.values(translations)) expect('scan_button' in table).toBe(false);
    expect(screen).toMatch(/\{showScan && showSendScreen && sendingToken && sendingToken\.network === 'qnet' && activeTab === 'assets' \? \(\s*<QrScanSheet/);
    // What the sheet hands over goes into the field only: the review and the fresh check still come after Send.
    expect(screen).toMatch(/onAddress=\{\(address\) => \{ setSendAddress\(address\); setShowScan\(false\); \}\}/);
    // Closing the form, locking the wallet and Android back all close the camera.
    const close = screen.slice(screen.indexOf('const closeSendScreen = () => {'));
    expect(close.slice(0, close.indexOf('};'))).toMatch(/setShowScan\(false\)/);
    const lock = screen.slice(screen.indexOf('const lockSession = () => {'));
    expect(lock.slice(0, lock.indexOf('\n  };'))).toMatch(/setShowScan\(false\)/);
    expect(screen).toMatch(/if \(showScan\) \{ setShowScan\(false\); return true; \}/);
  });

  it('the field keeps its full width; the icon\'s 44 dp target covers its end, which turns with the screen\'s direction', () => {
    const styles = require('../src/screens/WalletScreen.styles').default;
    const field = StyleSheet.flatten([styles.input, styles.recipientInput, styles.recipientInputScan]);
    const button = StyleSheet.flatten(styles.scanButton);
    expect(field.width).toBe('100%');
    expect(button).toEqual({
      position: 'absolute', end: 0, top: 0, bottom: 0, width: 44, alignItems: 'center', justifyContent: 'center',
    });
    // The text stops where the target starts (border and end padding together), and the field is at least 44 high.
    expect(field.borderWidth + field.paddingEnd).toBe(button.width);
    expect(field.minHeight).toBeGreaterThanOrEqual(44);
    // Start and end only, no left or right: in Arabic the screen runs right to left and the icon sits on the left.
    for (const st of [button, StyleSheet.flatten(styles.recipientInputScan)]) {
      expect(Object.keys(st).filter((k) => /left|right/i.test(k))).toEqual([]);
    }
    // The wrapper takes the field's bottom margin, so the button spans the field alone and the icon is centred on it.
    expect(field.marginBottom).toBe(0);
    expect(styles.recipientField.marginBottom).toBe(styles.input.marginBottom);
  });

  it('the icon is drawn like the tab bar icons: a 24 box, the same stroke, corners and a QR code centred in it', () => {
    const { ScanIcon, SCAN_CORNERS, SCAN_SQUARES } = require('../src/components/QrScanSheet');
    const Svg = require('react-native-svg').default;
    const { Path, Rect } = require('react-native-svg');
    let tree;
    act(() => { tree = renderer.create(<ScanIcon color="#00d4ff" />); });
    expect(tree.root.findByType(Svg).props).toMatchObject({ width: 24, height: 24, viewBox: '0 0 24 24' });
    expect(tree.root.findByType(Path).props).toMatchObject({
      d: SCAN_CORNERS, stroke: '#00d4ff', strokeWidth: 1.8, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round',
    });
    expect(tree.root.findAllByType(Rect).map((r) => r.props.fill)).toEqual(SCAN_SQUARES.map(() => '#00d4ff'));
    expect(tree.root.findAllByType(Text)).toHaveLength(0);
    act(() => tree.unmount());

    // The corner brackets' points: four mirror images of one corner, from 3 to 21 (the stroke stays inside the box).
    const points = [];
    let x = 0;
    let y = 0;
    for (const [, c, args] of SCAN_CORNERS.matchAll(/([MVHhva])([^MVHhva]*)/g)) {
      const n = (args.match(/-?[\d.]+/g) || []).map(Number);
      if (c === 'M') [x, y] = n;
      else if (c === 'V') y = n[0];
      else if (c === 'H') x = n[0];
      else if (c === 'h') x += n[0];
      else if (c === 'v') y += n[0];
      else { x += n[5]; y += n[6]; } // a: a quarter circle to its end point
      points.push(`${x},${y}`);
    }
    expect(points).toHaveLength(16);
    for (const p of points) {
      const [px, py] = p.split(',').map(Number);
      expect([p, points.includes(`${24 - px},${py}`), points.includes(`${px},${24 - py}`)]).toEqual([p, true, true]);
      expect(Math.min(px, py) - 0.9).toBeGreaterThanOrEqual(2);
      expect(Math.max(px, py) + 0.9).toBeLessThanOrEqual(22);
    }
    // The QR code between them is centred on (12, 12).
    const lo = Math.min(...SCAN_SQUARES.flatMap((q) => [q.x, q.y]));
    const hi = Math.max(...SCAN_SQUARES.flatMap((q) => [q.x + q.size, q.y + q.size]));
    expect(Math.abs((lo + hi) / 2 - 12)).toBeLessThan(0.01);
  });

  it('the camera is declared on both platforms, and the scanner is a dependency', () => {
    expect(read('android/app/src/main/AndroidManifest.xml')).toMatch(/<uses-permission android:name="android\.permission\.CAMERA" \/>/);
    expect(read('android/app/src/main/AndroidManifest.xml')).toMatch(/android\.hardware\.camera" android:required="false"/);
    const plist = read('ios/QNetMobile/Info.plist');
    const text = /<key>NSCameraUsageDescription<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)[1];
    // An address: a QNet one on the QNet Send screen, a Solana one (or its payment request) on the Solana one (29.09).
    expect(text).toMatch(/scan an address from a QR code/);
    // It names what the user taps: the icon in the recipient field (it has no word on it).
    expect(text).toMatch(/when you tap the scan icon on the Send screen\.$/);
    expect(read('ios/QNetMobile/en.lproj/InfoPlist.strings')).toContain(`"NSCameraUsageDescription" = "${text}";`);
    expect(JSON.parse(read('package.json')).dependencies['react-native-camera-kit']).toBe('18.0.1');
  });

  it('on Android the QR code is decoded on the device only: the patched camera library has no other decoder and no face model', () => {
    const lib = 'node_modules/react-native-camera-kit/android';
    // The patch is what a fresh install applies (postinstall: patch-package).
    const patch = read('patches/react-native-camera-kit+18.0.1.patch');
    expect(patch).toMatch(/^-    implementation 'com\.google\.mlkit:barcode-scanning:17\.3\.0'$/m);
    expect(patch).toMatch(/^-    implementation 'com\.google\.android\.gms:play-services-mlkit-face-detection:17\.1\.0'$/m);
    expect(patch).toMatch(/^\+    implementation 'com\.google\.zxing:core:3\.5\.4'$/m);
    expect(JSON.parse(read('package.json')).scripts.postinstall).toBe('patch-package');
    // The library as installed.
    const gradle = read(`${lib}/build.gradle`);
    expect(gradle).not.toMatch(/mlkit/);
    expect(gradle).toMatch(/^    implementation 'com\.google\.zxing:core:3\.5\.4'$/m);
    const analyzer = read(`${lib}/src/main/java/com/rncamerakit/QRCodeAnalyzer.kt`);
    expect(analyzer).toMatch(/^import com\.google\.zxing\.qrcode\.QRCodeReader$/m);
    expect(analyzer).toMatch(/^import com\.google\.zxing\.PlanarYUVLuminanceSource$/m);
    // Every frame is closed on every path; a tilted code's box comes from its corners along its own edges.
    expect(analyzer).toMatch(/\} finally \{\r?\n\s+image\.close\(\)\r?\n\s+\}/);
    expect(analyzer).toMatch(/val d = 3\.5f \* max\(abs\(u\.x\), abs\(u\.y\)\) \*/);
    const sources = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(kt|java)$/.test(name)) sources.push(rel);
      }
    };
    walk(`${lib}/src`);
    expect(sources).toContain(`${lib}/src/main/java/com/rncamerakit/QRCodeAnalyzer.kt`);
    expect(sources.filter((f) => /com\.google\.mlkit|com\.google\.android\.gms/.test(read(f)))).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, `${lib}/src/main/java/com/rncamerakit/FaceAnalyzer.kt`))).toBe(false);
    // The event the sheet reads still carries the code's text.
    expect(read(`${lib}/src/main/java/com/rncamerakit/events/ReadCodeEvent.kt`)).toMatch(/putString\("codeStringValue", codeStringValue\)/);
    // Nothing in the app's own build refers to the removed libraries any more.
    expect(read('android/app/build.gradle')).not.toMatch(/mlkit/);
    expect(read('android/app/proguard-rules.pro')).not.toMatch(/mlkit/);
  });
});

describe('Receive and the address card', () => {
  const receive = screen.slice(screen.indexOf("case 'receive':"), screen.indexOf("case 'browser':"));

  it('Receive: the title "Receive", one plain line per network, and no warning boxes', () => {
    expect(receive).toMatch(/t\('receive_title'\)/);
    expect(receive).toMatch(/t\(selectedNetwork === 'qnet' \? 'receive_your_qnet' : 'receive_your_solana'\)/);
    expect(t('receive_title')).toBe('Receive');
    expect(t('receive_your_qnet')).toBe('Your QNet address for QNC and QNet tokens.');
    expect(t('receive_your_solana')).toBe('Your Solana address for SOL and Solana tokens.');
    expect(receive).not.toMatch(/warning|Warning|notice/);
    for (const [lang, table] of Object.entries(translations)) {
      const all = Object.values(table).join('\n');
      expect([lang, /Only QNC|first and last characters|Receive QNC/.test(all)]).toEqual([lang, false]);
      expect([lang, Object.keys(table).some((k) => /^receive_(only|check|warn|qnc)/.test(k))]).toEqual([lang, false]);
    }
  });

  it('the address is whole on the card and on Receive, and a tap on it copies it; there is no Copy button', () => {
    const card = screen.slice(screen.indexOf('testID="address-card"') - 600, screen.indexOf('testID="address-card"') + 900);
    for (const part of [card, receive]) {
      expect(part).toMatch(/accessibilityRole="button"/);
      expect(part).toMatch(/copyToClipboard\(/);
      expect(part).not.toMatch(/slice\(0, ?\d+\)|…|ellipsizeMode/);
      expect(part).not.toMatch(/t\('seed_copy'\)|>Copy</);
    }
  });
});

describe('creating a wallet ends on the user\'s own press', () => {
  it('no timer moves on from the last step: saving the wallet leads to Assets and stays', () => {
    const confirm = screen.slice(screen.indexOf('const confirmSeedPhrase = async () => {'));
    const body = confirm.slice(0, confirm.indexOf('\n  };'));
    expect(body).toMatch(/setActiveTab\('assets'\)/);
    expect(body).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
  });
});

describe('auto-lock: Never', () => {
  it('is a choice in every language, has no inactivity timer, and choosing it asks for the fresh check first', () => {
    expect(screen).toMatch(/const AUTO_LOCK_CHOICES = \['1', '5', '15', '30', 'never'\];/);
    for (const [lang, table] of Object.entries(translations)) {
      expect([lang, typeof table.autolock_never === 'string' && table.autolock_never.length > 0]).toEqual([lang, true]);
    }
    expect(t('autolock_never')).toBe('Never');
    // Never is the longest time, so moving to it is "relaxing" and takes the password or the screen lock.
    expect(screen).toMatch(/const autoLockRank = \(v\) => \(v === 'never' \? Infinity : Number\(v\)\);/);
    expect(screen).toMatch(/const relaxing = autoLockRank\(time\) > autoLockRank\(autoLockTime\);/);
    // An open wallet gets no grace limit; the onboarding screens holding a phrase keep the default one.
    expect(screen).toMatch(/autoLockTime === 'never'\s*\? \(wallet \? Infinity : parseInt\(DEFAULT_AUTO_LOCK, 10\) \* 60 \* 1000\)/);
  });
});

describe('the Settings tab icon', () => {
  it('is a gear of eight equal teeth centred on the 24-unit box, like the other icons', () => {
    const { GEAR_PATH } = require('../src/components/BottomBar');
    const points = [...GEAR_PATH.matchAll(/[ML]([\d.]+) ([\d.]+)|A[\d.]+ [\d.]+ 0 0 1 ([\d.]+) ([\d.]+)/g)]
      .map((m) => (m[1] ? [+m[1], +m[2]] : [+m[3], +m[4]]))
      .slice(0, -1); // the last arc ends where the path started
    const radii = points.map(([x, y]) => Math.hypot(x - 12, y - 12));
    for (const r of radii) expect(Math.min(Math.abs(r - 9.3), Math.abs(r - 7.1))).toBeLessThan(0.02);
    const cx = points.reduce((a, [x]) => a + x, 0) / points.length;
    const cy = points.reduce((a, [, y]) => a + y, 0) / points.length;
    expect(Math.abs(cx - 12)).toBeLessThan(0.05);
    expect(Math.abs(cy - 12)).toBeLessThan(0.05);
    expect(radii.filter((r) => Math.abs(r - 9.3) < 0.02)).toHaveLength(16);
  });
});

describe('screen texts', () => {
  it('no text explains where data comes from or how the network checks it', () => {
    for (const [lang, table] of Object.entries(translations)) {
      const hits = Object.entries(table).filter(([, v]) => /aiqnet\.io explorer|two QNet nodes|Not verified|quorum/i.test(v));
      expect([lang, hits]).toEqual([lang, []]);
    }
    expect(t('hist_empty')).toBe('No transactions yet');
    expect([t('hist_status_pending'), t('hist_status_confirmed'), t('hist_status_failed')]).toEqual(['Pending', 'Confirmed', 'Failed']);
  });
});
