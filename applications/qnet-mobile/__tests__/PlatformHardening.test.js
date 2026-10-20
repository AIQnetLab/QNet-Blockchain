// The platform half of keeping secrets on the phone, checked in the sources: screen and backup protection,
// task isolation, the seed on the clipboard only by its Copy button, keyboards kept out of secret fields, no console output in a
// release bundle, native ML-DSA serialized and self-test-free, and an Xcode project with no dangling files.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('Android', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');

  it('no backup, no device transfer, no shared task, overlays can be hidden', () => {
    expect(manifest).toMatch(/android:allowBackup="false"/);
    expect(manifest).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/);
    expect(manifest).toMatch(/android:fullBackupContent="@xml\/backup_rules"/);
    expect(manifest).toMatch(/android:taskAffinity=""/);
    expect(manifest).toMatch(/android\.permission\.HIDE_OVERLAY_WINDOWS/);
    const domains = ['root', 'file', 'database', 'sharedpref', 'external'];
    const rules = read('android/app/src/main/res/xml/data_extraction_rules.xml');
    for (const section of ['cloud-backup', 'device-transfer']) {
      const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(rules)[1];
      for (const d of domains) expect(body).toContain(`<exclude domain="${d}" path="." />`);
      expect(body).not.toContain('<include');
    }
    const backup = read('android/app/src/main/res/xml/backup_rules.xml');
    for (const d of domains) expect(backup).toContain(`<exclude domain="${d}" path="." />`);
  });

  it('the recents screen gets no snapshot; secret screens get FLAG_SECURE, hidden overlays and no a11y scraping', () => {
    expect(read('android/app/src/main/java/com/qnetmobile/MainActivity.kt')).toMatch(/setRecentsScreenshotEnabled\(false\)/);
    const security = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    for (const marker of ['FLAG_SECURE', 'setHideOverlayWindows', 'ACCESSIBILITY_DATA_SENSITIVE_YES',
      'filterTouchesWhenObscured', 'IME_FLAG_NO_PERSONALIZED_LEARNING', 'clipboard()?.clearNow()',
      'setInvalidatedByBiometricEnrollment(true)', 'AUTH_BIOMETRIC_STRONG', 'BiometricPrompt.CryptoObject',
      'setIsStrongBoxBacked(true)']) {
      expect(security).toContain(marker);
    }
    // One way to empty the clipboard, for the phrase field and the copied secret alike.
    expect(read('android/app/src/main/java/com/qnetmobile/SecretClip.kt')).toMatch(/internal fun ClipboardManager\.clearNow\(\) \{[\s\S]*?clearPrimaryClip\(\)/);
    expect(security).not.toMatch(/clearPrimaryClip|setPrimaryClip\(ClipData\.newPlainText\("", ""\)\)/);
    // MVA-R4-01: no vault key is bound to the screen lock (keystore2 deletes such keys when the lock is removed).
    expect(security).not.toMatch(/setUnlockedDeviceRequired\(/);
    expect(read('android/app/src/main/java/com/qnetmobile/DilithiumPackage.kt')).toContain('SecurityModule(reactContext)');
  });

  it('HTTPS only: no cleartext and no user CAs in release; debug adds only the local Metro hosts', () => {
    expect(manifest).toMatch(/android:networkSecurityConfig="@xml\/network_security_config"/);
    expect(manifest).not.toMatch(/usesCleartextTraffic/);
    expect(read('android/app/build.gradle')).not.toMatch(/usesCleartextTraffic/);
    const release = read('android/app/src/main/res/xml/network_security_config.xml');
    expect(release).toMatch(/<base-config cleartextTrafficPermitted="false">/);
    expect(release).toMatch(/<certificates src="system" \/>/);
    expect(release).not.toMatch(/cleartextTrafficPermitted="true"|src="user"/);
    expect(read('android/app/build.gradle')).toMatch(/debug\.res\.srcDirs \+= 'src\/metroDebug\/res'/);
    const debug = read('android/app/src/metroDebug/res/xml/network_security_config.xml');
    const hosts = [...debug.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map((m) => m[1]).sort();
    expect(hosts).toEqual(['10.0.2.2', '127.0.0.1', 'localhost']);
  });

  it('native ML-DSA: one lock across keygen and signing, zeroed buffers, no self-test thread, no seed fallback', () => {
    const kotlin = read('android/app/src/main/java/com/qnetmobile/DilithiumModule.kt');
    expect(kotlin).not.toMatch(/Thread\s*\{/);
    expect(kotlin).toMatch(/BuildConfig\.DEBUG/);
    expect(kotlin).not.toMatch(/Legacy path: re-derive/);
    const rng = read('android/app/src/main/cpp/randombytes_custom.c');
    expect(rng).toMatch(/pthread_mutex_lock/);
    const jni = read('android/app/src/main/cpp/dilithium_jni.c');
    expect(jni).toMatch(/dilithium_lock\(\);\s*dilithium_set_keygen_seed/);
    expect(jni).toMatch(/dilithium_lock\(\);\s*int ret = PQCLEAN_MLDSA65_CLEAN_crypto_sign_signature/);
    expect(jni).not.toMatch(/PQCLEAN_PK\[|PQCLEAN_SIG\[/);
    // Native logging exists in debug builds only.
    expect(jni).toMatch(/#ifdef QNET_NATIVE_LOG\s*#define LOGE\(\.\.\.\) __android_log_print[^\n]*\n#else\s*#define LOGE\(\.\.\.\) \(\(void\)0\)/);
    expect(read('android/app/src/main/cpp/CMakeLists.txt')).toMatch(/\$<\$<CONFIG:Debug>:QNET_NATIVE_LOG>/);
  });

  it('R8 keeps no blanket rule for the app package and no source file names or line numbers of its own', () => {
    const rules = read('android/app/proguard-rules.pro').split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(rules.join('\n')).not.toMatch(/-keep\s+class\s+com\.qnetmobile/);
    expect(rules.join('\n')).not.toMatch(/-keepattributes[^\n]*(SourceFile|LineNumberTable)/);
    expect(rules.join('\n')).toMatch(/-assumenosideeffects class android\.util\.Log/);
    expect(read('android/app/build.gradle')).toMatch(/minifyEnabled true/);
  });

  it('R8 optimises in full mode: no blanket keep of a library its own rules cover, no flag R8 ignores', () => {
    const rules = read('android/app/proguard-rules.pro').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    // React Native's own consumer rules keep what it reaches by reflection or JNI; Hermes' Java side ships none.
    expect(rules.filter((l) => l.startsWith('-keep'))).toEqual(['-keep class com.facebook.hermes.** { *; }']);
    expect(rules.join('\n')).not.toMatch(/-optimizationpasses|-dontpreverify|-dontskipnonpubliclibraryclasses|-dontoptimize|-verbose/);
    const gradle = read('android/app/build.gradle');
    expect(gradle).toMatch(/shrinkResources true/);
    expect(gradle).toMatch(/proguardFiles getDefaultProguardFile\("proguard-android-optimize\.txt"\), "proguard-rules\.pro"/);
    // Full mode is the default of the Android Gradle plugin in use; nothing turns it off.
    expect(read('android/gradle.properties')).not.toMatch(/android\.enableR8\.fullMode\s*=\s*false/);
    expect(read('node_modules/react-native/gradle/libs.versions.toml')).toMatch(/^agp = "8\./m);
  });

  it('edge to edge from API 29, as Android 15+ enforces it; the bars keep the dark app\'s look on every version', () => {
    // React Native's switch, turned on at start from API 29 only: below it React Native would give the navigation bar
    // a light scrim in light mode (its modal sheets too), so there the app keeps its own dark bars. With it the activity
    // and its modals draw behind both bars and the screens take the insets from SafeAreaProvider (App.tsx).
    expect(read('android/gradle.properties')).toMatch(/^edgeToEdgeEnabled=false\s*$/m);
    const app = read('android/app/src/main/java/com/qnetmobile/MainApplication.kt');
    expect(app).toMatch(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.Q\) setEdgeToEdgeFeatureFlagOn\(\)/);
    expect(app.indexOf('setEdgeToEdgeFeatureFlagOn()')).toBeLessThan(app.indexOf('loadReactNative(this)'));
    expect(read('App.tsx')).toMatch(/<SafeAreaProvider initialMetrics=\{initialWindowMetrics\}>/);
    const activity = read('android/app/src/main/java/com/qnetmobile/MainActivity.kt');
    const create = activity.slice(activity.indexOf('override fun onCreate('), activity.indexOf('override fun onPause('));
    expect(create.indexOf('super.onCreate(savedInstanceState)')).toBeLessThan(create.indexOf('WindowInsetsControllerCompat'));
    expect(create).toMatch(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.Q\) \{\s*val bars = WindowInsetsControllerCompat\(window, window\.decorView\)\s*bars\.isAppearanceLightStatusBars = false\s*bars\.isAppearanceLightNavigationBars = false\s*window\.isNavigationBarContrastEnforced = false/);
    // The colour setters Android 15 deprecates are never called by the app's own code.
    for (const f of ['MainActivity.kt', 'MainApplication.kt', 'SecurityModule.kt', 'TaskState.kt', 'SecretClip.kt']) {
      expect([f, /statusBarColor|navigationBarColor|setStatusBarColor|setNavigationBarColor|LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES/.test(read(`android/app/src/main/java/com/qnetmobile/${f}`))]).toEqual([f, false]);
    }
  });

  it('bitmaps are no larger than they are shown: the launch mark per density, the app mark per scale', () => {
    const size = (p) => { const b = fs.readFileSync(path.join(ROOT, p)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    // The launch screen draws the mark at 192 dp: one drawable per density at exactly that size (no mipmap copies, so
    // a device receives only its own density's).
    expect(read('android/app/src/main/res/drawable/launch_screen.xml')).toMatch(/android:width="192dp"\s+android:height="192dp"\s+android:drawable="@drawable\/splash_logo"/);
    for (const [density, scale] of [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]) {
      expect(size(`android/app/src/main/res/drawable-${density}/splash_logo.png`)).toEqual([192 * scale, 192 * scale]);
      expect(fs.existsSync(path.join(ROOT, `android/app/src/main/res/mipmap-${density}/splash_logo.png`))).toBe(false);
    }
    // The app mark is drawn at 72 at most (the lock screen); React Native picks the variant for the screen's scale.
    for (const [suffix, scale] of [['', 1], ['@2x', 2], ['@3x', 3], ['@4x', 4]]) {
      expect(size(`assets/qnet_logo${suffix}.png`)).toEqual([72 * scale, 72 * scale]);
    }
    expect(read('src/screens/WalletScreen.styles.js')).toMatch(/lockLogo: \{\s*width: 72,\s*height: 72,/);
  });
});

describe('iOS', () => {
  it('the app-switcher snapshot is covered and the push token is never printed', () => {
    const app = read('ios/QNetMobile/AppDelegate.swift');
    // Under the scene life cycle UIKit calls only the scene's resign and activation: the cover lives there.
    const scene = read('ios/QNetMobile/SceneDelegate.swift');
    expect(scene).toMatch(/func sceneWillResignActive\(_ scene: UIScene\) \{\s*guard SceneDelegate\.privacyCover == nil, let window = window else \{ return \}[\s\S]*?window\.addSubview\(cover\)/);
    expect(scene).toMatch(/func sceneDidBecomeActive\(_ scene: UIScene\) \{\s*SceneDelegate\.privacyCover\?\.removeFromSuperview\(\)/);
    // The window outlives a scene that disconnects while covered: the cover is the process's, never one delegate's.
    expect(scene).toMatch(/private static var privacyCover: UIView\?/);
    expect(app).not.toMatch(/applicationWillResignActive|applicationDidBecomeActive|privacyCover/);
    for (const f of [app, scene, read('ios/QNetMobile/TaskState.swift')]) expect(f).not.toMatch(/print\(|NSLog/);
    const plist = read('ios/QNetMobile/Info.plist');
    expect(plist).toMatch(/<key>RCTAsyncStorageExcludeFromBackup<\/key>\s*<true\/>/);
    // ATS with no exception at all: no local-network or arbitrary-load opening.
    expect(plist).toMatch(/<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
    expect(plist).not.toMatch(/NSAllowsLocalNetworking|NSExceptionDomains|NSAllowsArbitraryLoadsInWebContent/);
    const security = read('ios/QNetMobile/QNetSecurityModule.m');
    for (const marker of ['UIScreenCapturedDidChangeNotification', 'clearPasteboardIfChanged', 'LAPolicyDeviceOwnerAuthentication']) {
      expect(security).toContain(marker);
    }
    // A screenshot raises no alert of the app's own: the recording cover stays, the system's own notices are the system's.
    expect(security).not.toMatch(/UserDidTakeScreenshot|UIAlertController|screenshot/i);
    expect(read('src/screens/WalletScreen.js')).not.toMatch(/screenshotTitle|screenshotBody|native_screenshot/);
    const dil = read('ios/QNetMobile/DilithiumModule/DilithiumModule.m');
    expect(dil).toMatch(/#if DEBUG/);
    expect(dil).not.toMatch(/NSLog\(@"PQCLEAN_(PK|SIG)/);
    expect(read('ios/QNetMobile/DilithiumModule/randombytes_ios.c')).toMatch(/pthread_mutex_lock/);
  });

  it('every source file the Xcode project names exists, and the security module is built', () => {
    const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
    const refs = [...pbx.matchAll(/isa = PBXFileReference;[^}]*?path = ([^;]+);[^}]*?sourceTree = ([^;]+);/g)]
      .map((m) => ({ file: m[1].replace(/"/g, ''), tree: m[2].replace(/"/g, '') }))
      .filter((r) => r.tree === 'SOURCE_ROOT' || r.tree === '<group>')
      .filter((r) => /\.(m|c|swift|plist|storyboard|xcprivacy)$/.test(r.file));
    expect(refs.length).toBeGreaterThan(10);
    for (const r of refs) expect(fs.existsSync(path.join(ROOT, 'ios', r.file))).toBe(true);
    for (const f of ['QNetSecurityModule.m', 'SceneDelegate.swift', 'TaskState.swift', 'QNetTaskState.m']) {
      expect([f, new RegExp(`${f.replace('.', '\\.')} in Sources \\*/,`).test(pbx)]).toEqual([f, true]);
    }
  });
});

describe('JavaScript', () => {
  const screen = read('src/screens/WalletScreen.js');

  it('the recovery phrase reaches the clipboard only by its Copy button, which clears it; the plain clipboard carries addresses and hashes only', () => {
    expect(screen).not.toMatch(/Copy Recovery Phrase/);
    expect(screen).not.toMatch(/Clipboard\.setString\((mnemonic|seedText|copyText|stored\.code)/);
    // Two buttons (the new wallet's phrase, the phrase shown again from Settings), one path: DeviceSecurity copySecret.
    expect(screen.match(/onPress=\{\(\) => copyRecoveryPhrase\(/g)).toHaveLength(2);
    // The same path, and only that, takes a private key from Settings → Export private key to the clipboard.
    expect(screen.match(/copySecret\(/g)).toHaveLength(2);
    expect(screen).toMatch(/if \(entry && entry\.key && await copySecret\(entry\.key\)\) showCopied\(keyCopiedTimerRef, setKeyCopied, which, null\);/);
    // The plain clipboard is left for addresses and transaction hashes (copyToClipboard's `text`, the explorer's
    // fallback `hash`); a pasted phrase is cleared natively without reading the clipboard (DeviceSecurity clearClipboard).
    const plain = [...screen.matchAll(/Clipboard\.setString\(([^)]*)\)/g)].map((m) => m[1]);
    expect(plain.sort()).toEqual(['hash', 'text'].sort());
  });

  it('every masked field and the phrase field keep keyboards out; "never" auto-lock is a choice that asks first', () => {
    expect(screen).not.toMatch(/^\s*secureTextEntry\s*$/m);
    expect(screen).toMatch(/\{\.\.\.SEED_INPUT_PROPS\}/);
    const props = require('../src/utils/sensitiveInput');
    for (const p of [props.PASSWORD_INPUT_PROPS, props.SEED_INPUT_PROPS]) {
      expect(p).toMatchObject({ autoCorrect: false, spellCheck: false, autoComplete: 'off',
        importantForAutofill: 'no', textContentType: 'none', autoCapitalize: 'none' });
    }
    // Never is the longest time: moving to it takes the password or the screen lock like any longer time, and it
    // leaves only an open wallet without a grace limit (the onboarding screens holding a phrase keep the default).
    expect(screen).toMatch(/const AUTO_LOCK_CHOICES = \['1', '5', '15', '30', 'never'\];/);
    expect(screen).toMatch(/const autoLockRank = \(v\) => \(v === 'never' \? Infinity : Number\(v\)\);/);
    expect(screen).toMatch(/if \(time !== autoLockTime && \(deviceAuth \|\| relaxing\)\) \{\s*setShowAutoLockPicker\(false\);\s*if \(!\(await confirmFresh\(t\('auth_change_autolock'\)\)\)\) return;/);
    expect(screen).toMatch(/\? \(wallet \? Infinity : parseInt\(DEFAULT_AUTO_LOCK, 10\) \* 60 \* 1000\)/);
  });

  it('a release bundle carries no console output', () => {
    const babel = require('@babel/core');
    const file = path.join(ROOT, 'src/services/PushService.js');
    const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
      filename: file, envName: 'production', cwd: ROOT, root: ROOT,
    });
    expect(code).not.toMatch(/console\.(log|warn|error|info|debug)\(/);
    expect(read('src/utils/logger.js')).toMatch(/isDev \? \(\.\.\.args\) => console\.error\(\.\.\.args\) : noop/);
    // App code logs only through the logger: the lint rule refuses console calls outside it.
    const lint = require('../.eslintrc.js');
    expect(lint.rules['no-console']).toBe('error');
  });
});

describe('round 2: native hardening', () => {
  it('MPLAT-R2-01: a protected-interaction mode (no FLAG_SECURE) guards the screens that move value', () => {
    const security = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    expect(security).toMatch(/fun setProtectInteraction\(on: Boolean\)/);
    expect(security).toMatch(/val guard = secureOn \|\| protectOn/);
    expect(security).toMatch(/window\.setHideOverlayWindows\(guard\)/);
    expect(security).toMatch(/decor\.filterTouchesWhenObscured = guard/);
    const screen = read('src/screens/WalletScreen.js');
    expect(screen).toMatch(/useProtectedInteraction\(showSendScreen \|\| !!dappSheet \|\| !!linkRequest\)/);
  });

  it('MPLAT-R2-04: the saved view hierarchy (text of every mounted field) never leaves the process', () => {
    const main = read('android/app/src/main/java/com/qnetmobile/MainActivity.kt');
    expect(main).toMatch(/override fun onSaveInstanceState\(outState: Bundle\) \{\s*super\.onSaveInstanceState\(outState\)\s*outState\.remove\(VIEW_HIERARCHY_STATE\)/);
    expect(main).toContain('"android:viewHierarchyState"');
  });

  it('MPLAT-R2-02: iOS refuses third-party keyboards and ends editing while the screen is captured', () => {
    const app = read('ios/QNetMobile/AppDelegate.swift');
    expect(app).toMatch(/shouldAllowExtensionPointIdentifier extensionPointIdentifier: UIApplication\.ExtensionPointIdentifier[\s\S]*?return extensionPointIdentifier != \.keyboard/);
    expect(read('ios/QNetMobile/QNetSecurityModule.m')).toMatch(/endEditing:YES/);
  });

  it('MPLAT-R2-05: PQClean wipes its secret locals and the stack it used; SHAKE states are wiped before free', () => {
    const sign = read('android/app/src/main/cpp/mldsa65/sign.c');
    const keypair = sign.slice(sign.indexOf('int PQCLEAN_MLDSA65_CLEAN_crypto_sign_keypair('), sign.indexOf('int PQCLEAN_MLDSA65_CLEAN_crypto_sign_signature_ctx('));
    for (const v of ['seedbuf', '&s1', '&s1hat', '&s2', '&t0']) expect(keypair).toContain(`qnet_wipe(${v}, sizeof(`);
    const signature = sign.slice(sign.indexOf('int PQCLEAN_MLDSA65_CLEAN_crypto_sign_signature_ctx('), sign.indexOf('int PQCLEAN_MLDSA65_CLEAN_crypto_sign_ctx('));
    for (const v of ['seedbuf', '&s1', '&s2', '&t0', '&y', '&z', '&w0', '&w1', '&h', '&cp']) expect(signature).toContain(`qnet_wipe(${v}, sizeof(`);
    const shake = read('android/app/src/main/cpp/common/fips202.c');
    expect(shake).toMatch(/void shake256_ctx_release\(shake256ctx \*state\) \{\s*qnet_wipe_state\(state->ctx, PQC_SHAKECTX_BYTES\);\s*free\(state->ctx\);/);
    expect(shake).toMatch(/void shake256_inc_ctx_release\(shake256incctx \*state\) \{\s*qnet_wipe_state\(state->ctx, PQC_SHAKEINCCTX_BYTES\);\s*free\(state->ctx\);/);
    const jni = read('android/app/src/main/cpp/dilithium_jni.c');
    expect(jni.match(/dilithium_burn_stack\(\);\s*dilithium_unlock\(\);/g)).toHaveLength(2);
    const ios = read('ios/QNetMobile/DilithiumModule/DilithiumModule.m');
    expect(ios.match(/dilithium_burn_stack\(\);\s*dilithium_unlock\(\);/g).length).toBeGreaterThanOrEqual(3);
    for (const f of ['android/app/src/main/cpp/randombytes_custom.c', 'ios/QNetMobile/DilithiumModule/randombytes_ios.c']) {
      expect(read(f)).toMatch(/__attribute__\(\(noinline\)\) void dilithium_burn_stack\(void\)/);
    }
  });
});
