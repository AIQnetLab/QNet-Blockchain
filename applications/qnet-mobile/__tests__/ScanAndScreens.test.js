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
      expect(texts(tree)).toContain('Not a QNet Blockchain address');
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

  it('iOS on the legacy bridge: a module without the permission methods leaves the asking to the camera view', async () => {
    // The module object the legacy bridge hands over carries only its exported methods.
    const mod = { capture: jest.fn() };
    jest.spyOn(TurboModuleRegistry, 'get').mockImplementation((name) => (name === 'RNCameraKitModule' ? mod : null));
    let tree;
    await act(async () => { tree = renderer.create(<QrScanSheet t={t} onAddress={() => {}} onClose={() => {}} />); });
    expect(texts(tree)).not.toContain(t('scan_camera_off'));
    expect(tree.root.findAllByProps({ testID: 'scan-camera' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());
    // The app's patch exports both methods, so the legacy bridge reaches them (the same bodies as the library's).
    const patch = fs.readFileSync(path.join(__dirname, '../patches/react-native-camera-kit+18.0.1.patch'), 'utf8');
    expect(patch).toMatch(/\+RCT_EXPORT_METHOD\(checkDeviceCameraAuthorizationStatus:\(RCTPromiseResolveBlock\)resolve reject:\(RCTPromiseRejectBlock\)reject\) \{\n \s*\[CKCameraManager checkDeviceCameraAuthorizationStatus:resolve reject:reject\];/);
    expect(patch).toMatch(/\+RCT_EXPORT_METHOD\(requestDeviceCameraAuthorization:\(RCTPromiseResolveBlock\)resolve reject:\(RCTPromiseRejectBlock\)reject\) \{\n \s*\[CKCameraManager requestDeviceCameraAuthorization:resolve reject:reject\];/);
    // The library's own Android changes stay in the same patch.
    expect(patch).toMatch(/android\/src\/main\/java\/com\/rncamerakit\/QRCodeAnalyzer\.kt/);
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
  const form = screen.slice(screen.indexOf("{/* The recipient; on QNet, Scan"), screen.indexOf("label={t('send_amount')}"));

  it('Scan is an act inside the recipient field only on QNet, and the sheet opens only for a QNet send', () => {
    // The recipient's field, its label above it, and Scan at its end on QNet only: a word, no drawn icon.
    expect(form).toMatch(new RegExp([
      String.raw`<Field\s+label=\{t\('send_to_address'\)\}[\s\S]*?`,
      String.raw`end=\{sendingToken\.network === 'qnet' \? \(\s*<Action\s+kind="act"\s+label=\{t\('send_scan'\)\}`,
      String.raw`[\s\S]*?testID="send-scan"\s*/>\s*\) : null\}`,
    ].join('')));
    // Named for screen readers by the scan's title; the keyboard goes away and the sheet opens as before.
    expect(form).toMatch(/accessibilityLabel=\{t\('scan_title'\)\}/);
    expect(form).toMatch(/onPress=\{\(\) => \{ Keyboard\.dismiss\(\); setShowScan\(true\); \}\}/);
    expect(form).not.toMatch(/ScanIcon|scan_button|recipientLabel/);
    for (const table of Object.values(translations)) {
      expect('scan_button' in table).toBe(false);
      expect(typeof table.send_scan).toBe('string');
    }
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

  it('the field keeps its whole width; Scan sits at the end of its label\'s line, which turns with the screen\'s direction', async () => {
    const Field = require('../src/components/ui/Field').default;
    const { fieldStyles } = require('../src/components/ui/Field');
    const { actionStyles } = require('../src/components/ui/Action');
    const { TextInput, View } = require('react-native');
    expect(StyleSheet.flatten(fieldStyles.group).alignSelf).toBe('stretch');
    const line = StyleSheet.flatten(fieldStyles.labelLine);
    expect(line).toMatchObject({ flexDirection: 'row', justifyContent: 'space-between' });
    // Start and end only, no left or right: in Arabic the screen runs right to left and Scan sits on the left.
    expect(Object.keys(line).filter((k) => /left|right/i.test(k))).toEqual([]);
    let tree;
    await act(async () => { tree = renderer.create(<Field label="To" placeholder="x" end={<Text testID="act">Сканировать</Text>} />); });
    // The act is on the label's line, outside the input: the text and the placeholder keep the field's whole width.
    const input = tree.root.findByType(TextInput);
    expect(StyleSheet.flatten(input.props.style).paddingEnd).toBeUndefined();
    const row = tree.root.findAll((n) => n.type === View && n.props.style === fieldStyles.labelLine)[0];
    expect(row.findAll((n) => n.props.testID === 'act').length).toBeGreaterThan(0);
    expect(StyleSheet.flatten(input.props.style).minHeight).toBeGreaterThanOrEqual(44);
    expect(StyleSheet.flatten(actionStyles.plain).minHeight).toBeGreaterThanOrEqual(44);
    await act(async () => { tree.unmount(); });
  });

  it('no drawn scan icon is left: the act says Scan in every language', () => {
    const sheet = read('src/components/QrScanSheet.js');
    expect(sheet).not.toMatch(/react-native-svg|ScanIcon|SCAN_CORNERS/);
    expect(require('../src/components/QrScanSheet').ScanIcon).toBeUndefined();
    expect(t('send_scan')).toBe('Scan');
    for (const [lang, table] of Object.entries(translations)) expect([lang, !!table.send_scan]).toEqual([lang, true]);
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
    expect(t('receive_your_qnet')).toBe('Your address for QNC and tokens on QNet Blockchain.');
    expect(t('receive_your_solana')).toBe('Your Solana address for SOL and Solana tokens.');
    expect(receive).not.toMatch(/warning|Warning|notice/);
    for (const [lang, table] of Object.entries(translations)) {
      const all = Object.values(table).join('\n');
      expect([lang, /Only QNC|first and last characters|Receive QNC/.test(all)]).toEqual([lang, false]);
      expect([lang, Object.keys(table).some((k) => /^receive_(only|check|warn|qnc)/.test(k))]).toEqual([lang, false]);
    }
  });

  it('the address is one rounded element a tap copies, with its copy glyph and no Copy word: one line on Assets, whole on Receive', () => {
    const card = screen.slice(screen.indexOf('testID="address-card"') - 600, screen.indexOf('testID="address-card"') + 500);
    for (const part of [card, receive]) {
      expect(part).toMatch(/accessibilityRole="button"/);
      expect(part).toMatch(/copyToClipboard\(/);
      expect(part).toMatch(/style=\{\(\{ pressed \}\) => \[styles\.addressPill, copied && styles\.addressPillDone, pressed && styles\.rowPressed\]\}/);
      expect(part).toMatch(/<CopyGlyph done=\{copied\} \/>/);
      expect(part).not.toMatch(/common_copy'|slice\(0, ?\d+\)|…/);
    }
    // Assets: the whole address on one line, shrunk to fit, never cut; copied, the line says so.
    expect(card).toMatch(/\{\.\.\.ADDRESS_LINE\}>\s*\{copied \? t\('common_copied'\) : cardAddress\}/);
    expect(card).not.toMatch(/ellipsizeMode="middle"/);
    // Receive: every character, as the screen's subject.
    expect(receive).toMatch(/<SubjectAddress address=\{currentReceiveAddress\} \/>/);
    // The subject form shows every character: the parts joined back are the address.
    const subject = screen.slice(screen.indexOf('function SubjectAddress'), screen.indexOf('function SubjectAddress') + 900);
    expect(subject).not.toMatch(/ellipsizeMode|…/);
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
