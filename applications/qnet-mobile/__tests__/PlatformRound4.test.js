/**
 * Final audit, mobile fixer round 3, the texts every device shows (SD-R3-02, SD-R3-07, MN-R3-04): an iPhone or iPad
 * opens in the phone's language as Android does, and the iOS build declares the app's eleven languages with its purpose
 * strings in each; the shared tables name no platform service; and the device-check consent is the protocol's block,
 * word for word, saying all the system's check can report.
 */
jest.mock('react-native/Libraries/Settings/Settings', () => ({ __esModule: true, default: { get: jest.fn() } }));

const fs = require('fs');
const path = require('path');
const { I18nManager, Platform } = require('react-native');
const Settings = require('react-native/Libraries/Settings/Settings').default;
const { LANGUAGES, deviceLanguage } = require('../src/i18n');
const translations = require('../src/i18n/translations').default;

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// The iOS name of each of the app's languages (an .lproj folder, a CFBundleLocalizations entry).
const IOS_CODE = (code) => (code === 'zh-CN' ? 'zh-Hans' : code);

describe('SD-R3-02: an iPhone or iPad opens in the phone\'s language, and the build declares every language', () => {
  const os = Platform.OS;
  afterEach(() => { Platform.OS = os; jest.restoreAllMocks(); Settings.get.mockReset(); });

  it('iOS reads the user\'s preferred languages: React Native gives it no locale identifier', () => {
    Platform.OS = 'ios';
    // What React Native 0.81 exports on iOS: the layout direction only.
    jest.spyOn(I18nManager, 'getConstants').mockReturnValue({ isRTL: false, doLeftAndRightSwapInRTL: true });
    for (const [preferred, lang] of [
      [['ru-RU', 'en-US'], 'ru'], [['zh-Hans-CN'], 'zh-CN'], [['pt-BR'], 'pt'], [['ar-SA'], 'ar'], [['sv-SE', 'ru-RU'], 'en'],
      [['ja'], 'ja'], [[], 'en'], [undefined, 'en'],
    ]) {
      Settings.get.mockImplementation((key) => (key === 'AppleLanguages' ? preferred : undefined));
      expect([preferred, deviceLanguage()]).toEqual([preferred, lang]);
    }
    // No preferred list: the region's locale.
    Settings.get.mockImplementation((key) => (key === 'AppleLocale' ? 'de_DE' : undefined));
    expect(deviceLanguage()).toBe('de');
    // A settings module that throws: English, never a crash at the first start.
    Settings.get.mockImplementation(() => { throw new Error('no module'); });
    expect(deviceLanguage()).toBe('en');
  });

  it('Android keeps reading the locale identifier and never asks the iOS settings', () => {
    Platform.OS = 'android';
    jest.spyOn(I18nManager, 'getConstants').mockReturnValue({ localeIdentifier: 'ko_KR', isRTL: false, doLeftAndRightSwapInRTL: true });
    expect(deviceLanguage()).toBe('ko');
    expect(Settings.get).not.toHaveBeenCalled();
  });

  it('Info.plist declares the eleven languages, and each has its purpose strings', () => {
    const plist = read('ios/QNetMobile/Info.plist');
    const list = plist.slice(plist.indexOf('<key>CFBundleLocalizations</key>'));
    const declared = [...list.slice(0, list.indexOf('</array>')).matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(LANGUAGES.map((l) => IOS_CODE(l.code)).sort());
    expect(Object.keys(translations).map(IOS_CODE).sort()).toEqual(declared.sort());
    for (const code of declared) {
      const strings = read(`ios/QNetMobile/${code}.lproj/InfoPlist.strings`);
      for (const key of ['NSFaceIDUsageDescription', 'NSCameraUsageDescription']) {
        const m = new RegExp(`^"${key}" = "([^"\\n]+)";$`, 'm').exec(strings);
        expect([code, key, !!m]).toEqual([code, key, true]);
      }
    }
    // English is the Info.plist's own text.
    const en = read('ios/QNetMobile/en.lproj/InfoPlist.strings');
    const face = /<key>NSFaceIDUsageDescription<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)[1];
    expect(en).toContain(`"NSFaceIDUsageDescription" = "${face}";`);
    // Each translation is its own text, not the English one copied.
    for (const code of declared.filter((c) => c !== 'en')) {
      expect([code, read(`ios/QNetMobile/${code}.lproj/InfoPlist.strings`).includes(face)]).toEqual([code, false]);
    }
  });

  it('the Xcode project copies every language\'s strings and knows each region', () => {
    const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
    const quoted = (c) => (c.includes('-') ? `"${c}"` : c);
    const group = /(\w{24}) \/\* InfoPlist\.strings \*\/ = \{\s*isa = PBXVariantGroup;\s*children = \(([^)]*)\);\s*name = InfoPlist\.strings;\s*path = QNetMobile;/.exec(pbx);
    expect(group).not.toBe(null);
    const regions = /knownRegions = \(([^)]*)\);/.exec(pbx)[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const { code } of LANGUAGES) {
      const c = IOS_CODE(code);
      const ref = new RegExp(`(\\w{24}) /\\* ${c} \\*/ = \\{isa = PBXFileReference; lastKnownFileType = text\\.plist\\.strings; name = ${quoted(c).replace(/"/g, '\\"')}; path = ${quoted(`${c}.lproj/InfoPlist.strings`).replace(/"/g, '\\"').replace(/\./g, '\\.')}; sourceTree = "<group>"; \\};`).exec(pbx);
      expect([c, !!ref]).toEqual([c, true]);
      expect(group[2]).toContain(`${ref[1]} /* ${c} */`);
      expect(regions).toContain(quoted(c));
    }
    const build = new RegExp(`(\\w{24}) /\\* InfoPlist\\.strings in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${group[1]} `).exec(pbx);
    expect(build).not.toBe(null);
    const resources = pbx.slice(pbx.indexOf('/* Begin PBXResourcesBuildPhase section */'), pbx.indexOf('/* End PBXResourcesBuildPhase section */'));
    expect(resources).toContain(`${build[1]} /* InfoPlist.strings in Resources */`);
  });

  it('the docs and the App Store listing say what the build does', () => {
    const doc = fs.readFileSync(path.join(ROOT, '..', '..', 'docs', 'applications', 'mobile-wallet.md'), 'utf8');
    expect(doc).toMatch(/phone's language/i);
    const listing = read('store-listing/app-store-listing.txt');
    const langs = listing.slice(listing.indexOf('LANGUAGES'));
    for (const name of ['English', 'Chinese', 'Russian', 'Spanish', 'Korean', 'Japanese', 'Portuguese', 'French', 'German', 'Arabic', 'Italian']) {
      expect(langs).toContain(name);
    }
  });
});

describe('SD-R3-07: the shared texts name no platform service', () => {
  it('the screenshot notice speaks of the device\'s photos and any cloud backup, in every language and natively', () => {
    for (const [lang, table] of Object.entries(translations)) {
      const text = table.native_screenshot_body;
      expect([lang, /icloud/i.test(text) || /\bPhotos\b|«Фото»|„Fotos“|“照片”|app Fotos|사진 앱/.test(text)]).toEqual([lang, false]);
    }
    expect(translations.en.native_screenshot_body).toBe(
      "This screen shows secret wallet data. Delete the screenshot from the device's photos and from any cloud backup: anyone who has it controls the wallet.",
    );
    const native = read('ios/QNetMobile/QNetSecurityModule.m');
    expect(native).toContain(`fallback:@"${translations.en.native_screenshot_body}"]`);
    expect(native).not.toMatch(/iCloud/);
  });
});

describe('MN-R3-04: the device-check consent is the protocol\'s block and says all the system\'s check can report', () => {
  it('the English text is qnet-link-v1 section 14.8 item 5, word for word', () => {
    const doc = fs.readFileSync(path.join(ROOT, '..', '..', 'docs', 'protocols', 'qnet-link-v1.md'), 'utf8');
    const start = doc.indexOf('> **Device check.**');
    const end = doc.indexOf('> *Privacy policy*', start);
    expect(start).toBeGreaterThan(0);
    const block = doc.slice(start, end).split('\n').map((l) => l.replace(/^\s*>\s?/, '')).join(' ')
      .replace('**Device check.**', '').replace(/\s+/g, ' ').trim();
    expect(translations.en.link_device_check_title).toBe('Device check.');
    expect(translations.en.link_device_check_body).toBe(block);
    expect(block).toContain('apps that can capture the screen, show themselves over other apps or control the device are installed or running');
  });
});
