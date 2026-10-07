/**
 * The two halves of the native module QNetDeviceAttest, read as source (no Mac and no device run here; the Android
 * half also has its JVM and on-device tests under android/app/src/test and src/androidTest): each platform builds and
 * registers it, the device key is made as light-node-messages section 5.1 says, no system version gates the node, the
 * methods and error codes NodeDeviceKey.js relies on exist on the platform that runs them, and erasing the app's data
 * deletes the key.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
// Code without its comments, so a comment may say what the code never does.
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const IOS = 'ios/QNetMobile/QNetDeviceAttestModule.m';
const MODULE_KT = 'android/app/src/main/java/com/qnetmobile/DeviceAttestModule.kt';
const KEY_KT = 'android/app/src/main/java/com/qnetmobile/NodeDeviceKey.kt';
const JS = 'src/services/NodeDeviceKey.js';

const IOS_METHODS = ['environment', 'generateKey', 'attestKey', 'generateAssertion', 'deviceCheckToken'];
const ANDROID_METHODS = ['environment', 'createKey', 'sign', 'hasKey', 'deleteKey', 'integrityToken', 'showPlayDialog'];

describe('iOS', () => {
  const m = code(IOS);

  it('is built into the app under the name the JS asks for, and exports exactly its methods', () => {
    const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
    expect(pbx).toMatch(/QNetDeviceAttestModule\.m in Sources \*\/,/);
    expect(pbx).toMatch(/path = QNetMobile\/QNetDeviceAttestModule\.m;/);
    expect(m).toMatch(/RCT_EXPORT_MODULE\(QNetDeviceAttest\)/);
    const exported = [...m.matchAll(/RCT_EXPORT_METHOD\((\w+):/g)].map((x) => x[1]);
    expect(exported.sort()).toEqual([...IOS_METHODS].sort());
  });

  it('uses App Attest and DeviceCheck, and tells a Mac, Apple Vision Pro and the Simulator apart', () => {
    for (const marker of ['DCAppAttestService', 'generateKeyWithCompletionHandler', 'attestKey:keyId clientDataHash:',
      'generateAssertion:keyId clientDataHash:', 'generateTokenWithCompletionHandler', 'isiOSAppOnMac', 'isMacCatalystApp',
      '"isiOSAppOnVision"', 'TARGET_OS_SIMULATOR', 'UIUserInterfaceIdiomPad', 'data.length == 32']) {
      expect([marker, m.includes(marker)]).toEqual([marker, true]);
    }
  });

  it('asks for no system version and uses no network of its own', () => {
    expect(m).not.toMatch(/@available|systemVersion|operatingSystemVersion|NSURLSession|NSURL\b/);
    // A development build attests in Apple's sandbox, a distributed one in production: no entitlement is needed.
    expect(read('ios/QNetMobile/QNetMobile.entitlements')).not.toMatch(/appattest-environment/);
  });
});

describe('Android', () => {
  const mod = code(MODULE_KT);
  const key = code(KEY_KT);

  it('is registered under the name the JS asks for, and exports exactly its methods', () => {
    expect(read('android/app/src/main/java/com/qnetmobile/DilithiumPackage.kt')).toContain('DeviceAttestModule(reactContext)');
    expect(mod).toMatch(/const val NAME = "QNetDeviceAttest"/);
    const exported = [...mod.matchAll(/@ReactMethod\s+fun (\w+)\(/g)].map((x) => x[1]);
    expect(exported.sort()).toEqual([...ANDROID_METHODS].sort());
  });

  it('makes a P-256 signing key with the attestation challenge, no user authentication and no device properties', () => {
    for (const marker of ['KeyProperties.PURPOSE_SIGN', 'ECGenParameterSpec("secp256r1")', 'KeyProperties.DIGEST_SHA256',
      '.setAttestationChallenge(challenge)', 'setIsStrongBoxBacked(true)', 'getCertificateChain(alias)',
      'Signature.getInstance("SHA256withECDSA")']) {
      expect([marker, key.includes(marker)]).toEqual([marker, true]);
    }
    for (const never of ['setUserAuthenticationRequired', 'setDevicePropertiesAttestationIncluded', 'setUnlockedDeviceRequired',
      'setAttestationIds', 'Build.MODEL', 'ANDROID_ID']) {
      expect([never, key.includes(never) || mod.includes(never)]).toEqual([never, false]);
    }
  });

  it('prefers a remotely provisioned chain, which the network trusts with the normal lease', () => {
    expect(key).toContain('const val PROVISIONING_INFO_OID = "1.3.6.1.4.1.11129.2.1.30"');
    expect(key).toMatch(/return pickBacking\(\s*hasStrongBox\(\),/);
    expect(read('android/app/src/test/java/com/qnetmobile/KeyBackingTest.kt')).toMatch(/aFactoryStrongBoxChainGivesWayToARemoteTeeChain/);
  });

  it('reports the nine features of the device report, and gates nothing on the system version', () => {
    for (const feature of ['FEATURE_PC', 'FEATURE_LEANBACK', 'FEATURE_WATCH', 'FEATURE_AUTOMOTIVE', 'FEATURE_EMBEDDED',
      'FEATURE_TOUCHSCREEN', 'isSystemUser', 'isHeadlessSystemUserMode', 'org.chromium.arc']) {
      expect([feature, key.includes(feature)]).toEqual([feature, true]);
    }
    // SDK checks only guard calls a system lacks (StrongBox, the headless-user query, a keystore error type).
    const gates = [...(key + mod).matchAll(/SDK_INT\s*(>=|<|>|<=)\s*Build\.VERSION_CODES\.(\w+)/g)].map((x) => `${x[1]}${x[2]}`);
    expect([...new Set(gates)].sort()).toEqual(['>=P', '>=S', '>=TIRAMISU']);
  });

  it('asks Google Play for a classic token bound to the nonce, and offers only its licence and integrity dialogs', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toMatch(/implementation\("com\.google\.android\.play:integrity:1\.\d+\.\d+"\)/);
    expect(mod).toMatch(/IntegrityTokenRequest\.builder\(\)\.setNonce\(nonce\)\.build\(\)/);
    expect(mod).not.toMatch(/StandardIntegrity|setCloudProjectNumber|GET_STRONG_INTEGRITY|CLOSE_\w+_ACCESS_RISK/);
    expect(mod).toMatch(/"licence" -> IntegrityDialogTypeCode\.GET_LICENSED/);
    expect(mod).toMatch(/"integrity" -> IntegrityDialogTypeCode\.GET_INTEGRITY/);
  });

  it('has its JVM test and its on-device test', () => {
    expect(read('android/app/src/test/java/com/qnetmobile/PlayCodesTest.kt')).toMatch(/PlayCodes\.error/);
    expect(read('android/app/src/androidTest/java/com/qnetmobile/NodeDeviceKeyTest.kt')).toMatch(/@RunWith\(AndroidJUnit4::class\)/);
    expect(read('android/app/build.gradle')).toMatch(/testInstrumentationRunner "androidx\.test\.runner\.AndroidJUnitRunner"/);
  });
});

describe('the JS and the two halves agree', () => {
  const js = read(JS);

  it('every native method the JS calls exists on its platform', () => {
    const called = new Set([...js.matchAll(/call\('(\w+)'/g)].map((x) => x[1]));
    const iosOnly = ['generateKey', 'attestKey', 'generateAssertion', 'deviceCheckToken'];
    const androidOnly = ['createKey', 'sign', 'deleteKey', 'integrityToken', 'showPlayDialog'];
    expect([...called].sort()).toEqual([...new Set(['environment', ...iosOnly, ...androidOnly])].sort());
    for (const name of iosOnly) expect([name, IOS_METHODS.includes(name)]).toEqual([name, true]);
    for (const name of androidOnly) expect([name, ANDROID_METHODS.includes(name)]).toEqual([name, true]);
  });

  it('what checkDevice reads is what each half answers', () => {
    const ios = code(IOS);
    const answer = ios.slice(ios.indexOf('resolve(@{'), ios.indexOf('});', ios.indexOf('resolve(@{')));
    const iosKeys = new Set([...answer.matchAll(/@"(\w+)":/g)].map((x) => x[1]));
    const check = js.slice(js.indexOf('export async function checkDevice'), js.indexOf('export async function currentKey'));
    const used = new Set([...check.matchAll(/env\.(\w+)/g)].map((x) => x[1]));
    expect(used.size).toBeGreaterThanOrEqual(7);
    for (const k of used) if (k !== 'report') expect([k, iosKeys.has(k)]).toEqual([k, true]);
    expect(code(MODULE_KT)).toMatch(/putMap\("report", report\)/);
  });

  it('every error code a native half gives is mapped, or is a plain failure', () => {
    const mapped = new Set([...js.slice(js.indexOf('const NATIVE_CODES'), js.indexOf('};', js.indexOf('const NATIVE_CODES')))
      .matchAll(/^\s+(\w+): '/gm)].map((x) => x[1]));
    const plain = new Set(['FAILED', 'KEYSTORE', 'PLAY_FAILED']);
    const ios = code(IOS);
    const kt = code(MODULE_KT);
    const given = new Set([
      ...[...ios.matchAll(/return @"([A-Z_]+)"/g), ...ios.matchAll(/reject\(@"([A-Z_]+)"/g)].map((x) => x[1]),
      ...[...kt.matchAll(/return "([A-Z_]+)"/g), ...kt.matchAll(/reject\("([A-Z_]+)"/g), ...kt.matchAll(/-> "([A-Z_]+)"/g),
        ...kt.matchAll(/remediable -> "([A-Z_]+)"/g)].map((x) => x[1]),
    ]);
    expect(given.size).toBeGreaterThanOrEqual(10);
    for (const c of given) expect([c, mapped.has(c) || plain.has(c)]).toEqual([c, true]);
  });

  it('asks for no system version either', () => {
    expect(code(JS)).not.toMatch(/Platform\.Version|systemVersion|sdkVersion|SDK_INT/);
  });

  it('erasing the app\'s data deletes the node\'s device key before the Keychain record that names it', () => {
    const wm = read('src/components/WalletManager.js');
    const erase = wm.slice(wm.indexOf('async eraseAllData()'), wm.indexOf('async _wipeKeychain()'));
    expect(erase.indexOf('forgetNodeDeviceKeys()')).toBeGreaterThan(0);
    expect(erase.indexOf('forgetNodeDeviceKeys()')).toBeLessThan(erase.indexOf('this._wipeKeychain()'));
  });
});
