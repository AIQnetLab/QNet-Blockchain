/**
 * iPad and Android tablets run the same app as phones (unified plan APP-6, plan-mobile section 8): the iOS target
 * builds for iPhone and iPad and for nothing else, every iPad orientation and window size is allowed, the iPad icons
 * exist, and the screens keep one centred column, keep clear of the safe area on every device and never lock the
 * orientation.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('the iOS project', () => {
  const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
  // The app target's two configurations: the ones naming the bundle.
  const configs = pbx.split(/\/\* (?:Debug|Release) \*\/ = \{/).filter((c) => c.includes('PRODUCT_BUNDLE_IDENTIFIER = com.qnetmobile;'));

  it('builds for iPhone and iPad in Debug and Release, never for a Mac or Vision Pro', () => {
    expect(configs).toHaveLength(2);
    for (const c of configs) {
      expect(c).toMatch(/TARGETED_DEVICE_FAMILY = "1,2";/);
      expect(c).toMatch(/SUPPORTS_MACCATALYST = NO;/);
      expect(c).toMatch(/SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = NO;/);
      expect(c).toMatch(/SUPPORTS_XR_DESIGNED_FOR_IPHONE_IPAD = NO;/);
    }
  });

  it('allows every iPad orientation and does not ask for the full screen', () => {
    const plist = read('ios/QNetMobile/Info.plist');
    const at = plist.indexOf('<key>UISupportedInterfaceOrientations~ipad</key>');
    expect(at).toBeGreaterThan(-1);
    const list = plist.slice(at, plist.indexOf('</array>', at));
    for (const o of ['Portrait', 'PortraitUpsideDown', 'LandscapeLeft', 'LandscapeRight']) {
      expect(list).toContain(`<string>UIInterfaceOrientation${o}</string>`);
    }
    expect(plist).not.toContain('UIRequiresFullScreen');
    expect(plist).toContain('<key>UILaunchStoryboardName</key>');
  });

  it('runs one window scene, its delegate built into the app, which Split View, Slide Over and Stage Manager show', () => {
    const plist = read('ios/QNetMobile/Info.plist');
    const manifest = /<key>UIApplicationSceneManifest<\/key>\s*<dict>([\s\S]*?)\n\t<\/dict>/.exec(plist)[1];
    expect(manifest).toMatch(/<key>UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/);
    const roles = /<key>UISceneConfigurations<\/key>\s*<dict>\s*<key>([^<]+)<\/key>\s*<array>([\s\S]*?)<\/array>\s*<\/dict>/.exec(manifest);
    expect(roles[1]).toBe('UIWindowSceneSessionRoleApplication');
    const configs = roles[2].split('</dict>').filter((c) => c.includes('<dict>'));
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatch(/<key>UISceneDelegateClassName<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate<\/string>/);
    // The window is made in code: no storyboard, and no scene class other than the default window scene.
    expect(configs[0]).not.toMatch(/UISceneStoryboardFile|UISceneClassName/);
    expect(read('ios/QNetMobile/SceneDelegate.swift')).toMatch(/^class SceneDelegate: UIResponder, UIWindowSceneDelegate \{$/m);
    expect(pbx).toMatch(/SceneDelegate\.swift in Sources \*\/,/);
    expect(pbx).toMatch(/path = QNetMobile\/SceneDelegate\.swift;/);
  });

  it('starts React Native once per process, in the scene\'s window or, for a background launch with no scene, one it takes later', () => {
    const app = read('ios/QNetMobile/AppDelegate.swift');
    const scene = read('ios/QNetMobile/SceneDelegate.swift');
    // One start site, in the app delegate; the launch itself makes no window.
    expect(`${app}\n${scene}`.match(/startReactNative\(/g)).toHaveLength(1);
    expect(app).toMatch(/func runReactNative\(in window: UIWindow, launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\?\) \{\s*window\.backgroundColor = AppDelegate\.launchColor\s*self\.window = window\s*reactNativeFactory\?\.startReactNative\(withModuleName: "QNetMobile", in: window, launchOptions: launchOptions\)/);
    expect(app).not.toMatch(/UIWindow\(frame:/);
    expect(app).toMatch(/DispatchQueue\.main\.async \{\s*guard self\.window == nil, application\.connectedScenes\.isEmpty else \{ return \}\s*self\.runReactNative\(in: UIWindow\(\), launchOptions: nil\)/);
    // A scene connecting while React Native runs takes its window instead of starting a second root.
    expect(scene).toMatch(/if let running = app\.window \{\s*(\/\/[^\n]*\n\s*)*running\.windowScene = windowScene/);
    expect(scene).toMatch(/let created = UIWindow\(windowScene: windowScene\)\s*self\.window = created\s*app\.runReactNative\(in: created, launchOptions: SceneDelegate\.launchOptions\(connectionOptions\)\)/);
  });

  it('has every iPad icon, each at its pixel size', () => {
    const dir = 'ios/QNetMobile/Images.xcassets/AppIcon.appiconset';
    const images = JSON.parse(read(`${dir}/Contents.json`)).images;
    const ipad = images.filter((i) => i.idiom === 'ipad');
    expect(ipad.map((i) => `${i.size}@${i.scale}`).sort()).toEqual(
      ['20x20@1x', '20x20@2x', '29x29@1x', '29x29@2x', '40x40@1x', '40x40@2x', '76x76@1x', '76x76@2x', '83.5x83.5@2x'].sort());
    const phoneFiles = new Set(images.filter((x) => x.idiom !== 'ipad').map((x) => x.filename));
    for (const i of images) {
      const png = fs.readFileSync(path.join(ROOT, dir, i.filename));
      const px = Math.round(parseFloat(i.size) * parseInt(i.scale, 10));
      // PNG header: width and height at bytes 16 and 20; the colour type at 25 (2 = RGB, no alpha).
      expect([i.filename, png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([i.filename, px, px]);
      if (!phoneFiles.has(i.filename)) expect([i.filename, png[25]]).toEqual([i.filename, 2]);
    }
  });
});

describe('Android tablets and windows', () => {
  it('never locks the orientation and keeps the activity through resizes', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).not.toMatch(/screenOrientation|resizeableActivity="false"/);
    expect(manifest).toMatch(/android:configChanges="[^"]*\bscreenSize\b[^"]*\bsmallestScreenSize\b/);
  });
});

describe('the screens', () => {
  const screen = read('src/screens/WalletScreen.js');
  const styles = require('../src/screens/WalletScreen.styles').default;

  it('every screen keeps one centred column of at most 640', () => {
    for (const k of ['scrollContentContainer', 'formContent', 'centerContent', 'fieldColumn']) {
      expect([k, styles[k].maxWidth, styles[k].alignSelf, styles[k].width]).toEqual([k, 640, 'center', '100%']);
    }
    // Nothing reads the window width: the layout is flex only.
    for (const f of ['src/screens/WalletScreen.js', 'src/screens/NodeTab.js']) {
      expect([f, /useWindowDimensions|Dimensions\./.test(read(f))]).toEqual([f, false]);
    }
  });

  it('keeps clear of the status bar and the notch from the safe area on every device, not by a fixed inset', () => {
    expect(screen).not.toMatch(/paddingTop: 44/);
    expect(screen).not.toMatch(/paddingBottom: 50/);
    expect(screen).not.toMatch(/edges=\{Platform\.OS/);
    // The system navigation bar too: nothing on a full screen sits under it (owner 20.10: "Forgot?" under Android's bar).
    expect(screen).toMatch(/const SCREEN_EDGES = \['top', 'left', 'right', 'bottom'\];/);
  });

  it('every modal turns with the device', () => {
    const modals = screen.split('<Modal').slice(1).map((m) => m.slice(0, m.indexOf('>')));
    expect(modals.length).toBeGreaterThan(0);
    for (const m of modals) expect(m).toMatch(/supportedOrientations=\{MODAL_ORIENTATIONS\}/);
    expect(screen).toMatch(/const MODAL_ORIENTATIONS = \['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'\];/);
  });

  it('the share sheet points at the button it came from (a popover on a tablet)', () => {
    expect(read('src/browser/BrowserScreen.js')).toMatch(/Share\.share\(\{ message: nav\.url \}, \{ anchor: findNodeHandle\(menuButtonRef\.current\)/);
  });
});
