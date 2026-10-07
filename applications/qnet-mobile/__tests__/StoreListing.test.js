// The paste-ready App Store texts must say what the build is (CROSS-02, CROSS-11, CROSS-12): one bundle ID shared by
// the Xcode project, the listing and the site's apple-app-site-association; the age rating answer the built-in
// browser requires; and review notes that name every screen the build has.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const listing = fs.readFileSync(path.join(ROOT, 'store-listing', 'app-store-listing.txt'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'store-listing', 'README.md'), 'utf8');

it('one bundle ID: the Xcode project, the listing and the site that serves apple-app-site-association', () => {
  const pbx = fs.readFileSync(path.join(ROOT, 'ios', 'QNetMobile.xcodeproj', 'project.pbxproj'), 'utf8');
  const ids = [...new Set([...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1].trim()))];
  expect(ids).toEqual(['com.qnetmobile']);
  expect(listing).toMatch(/Bundle ID: com\.qnetmobile\b/);
  expect(listing).not.toMatch(/com\.qnet\.mobile/);
  const site = path.join(ROOT, '..', 'qnet-explorer', 'frontend', 'src', 'lib', 'app-links.ts');
  if (fs.existsSync(site)) {
    expect(fs.readFileSync(site, 'utf8')).toMatch(/export const IOS_BUNDLE_ID = 'com\.qnetmobile';/);
  }
});

it('the age rating answer is "Unrestricted Web Access: Yes", the same in both files', () => {
  expect(listing).toMatch(/Unrestricted\s+Web Access: Yes/);
  expect(listing).not.toMatch(/no unrestricted web access/i);
  expect(readme).toMatch(/Unrestricted Web Access:\s*Yes/);
});

it('the review notes name the five QNet Link sheets, what they sign, where a node comes from and the device check', () => {
  const notes = listing.slice(listing.indexOf('APP REVIEW INFORMATION'));
  expect(notes).toMatch(/link\.aiqnet\.io/);
  expect(notes).toMatch(/Five sheets no button or menu inside the app opens/);
  expect(notes).toMatch(/\(2\) "Set up a light node for this wallet": the wallet signs that the website may prepare a light node for it with a one-time address the website then makes \(no funds leave the wallet\)/);
  expect(notes).toMatch(/\(3\) "Link this wallet's node to this device": the wallet signs its own consent/);
  expect(notes).toMatch(/\(4\) "Move node balance to this wallet"/);
  // The Node tab has no off switch (owner, 30.09): the node leaves the device on the unlink sheet.
  expect(notes).toMatch(/\(5\) "Unlink this wallet's node from this device"/);
  expect(listing).not.toMatch(/Stop on this device/);
  expect(readme).not.toMatch(/Stop on this device/);
  // Each sheet by the title the app shows.
  const translations = require('../src/i18n/translations').default;
  for (const k of ['link_title_connect', 'link_title_reserve', 'link_title_link', 'link_title_claim', 'link_title_unlink']) {
    expect([k, notes.includes(`"${translations.en[k]}"`)]).toEqual([k, true]);
  }
  // A super node comes only from the extension and runs on a server; the app shows it and nothing more (A4).
  expect(notes).toMatch(/A super node is registered with the QNet browser extension on a computer and runs on the user's own server with the QNet node software; the app only shows it\./);
  // The demo walks the payment way: the reservation sheet first, the consent after the burn.
  expect(notes).toMatch(/"Make a payment address" > "Open QNet Wallet" \(sheet 2\), send the amounts, "Burn", "Continue in QNet Wallet" > "Open QNet Wallet" \(sheet 3 with consent\)/);
  expect(notes).toMatch(/never burns or buys anything/);
  expect(notes).toMatch(/the website burns 1DEV test tokens/);
  expect(notes).toMatch(/App Attest and DeviceCheck \(no prompt, no tracking\)/);
  expect(notes).not.toMatch(/activation code is entered|Recover code|Activate on this phone|asks for notification/i);
  // The public listing itself (above the review notes) still names neither the extension nor the burn, nor a code.
  const publicPart = listing.slice(0, listing.indexOf('APP REVIEW INFORMATION'));
  expect(publicPart).not.toMatch(/burn|extension|activation|reward|\bearn/i);
  expect(publicPart).toMatch(/not offered on Mac or Apple Vision Pro/);
});

// SD-01: one app, one unlock rule on every device: the screen lock where there is one, a password where there is none.
it('both stores describe the same unlock: the screen lock, or a password on a device without one', () => {
  const dir = path.join(ROOT, '..', '..', 'fastlane', 'metadata', 'android', 'en-US');
  const play = fs.readFileSync(path.join(dir, 'full_description.txt'), 'utf8');
  for (const [name, text] of [['app-store-listing', listing], ['full_description', play],
    ['google-play-description', fs.readFileSync(path.join(ROOT, 'store-listing', 'google-play-description.txt'), 'utf8')]]) {
    expect([name, /no (app )?password/i.test(text)]).toEqual([name, false]);
  }
  expect(listing).toMatch(/Face ID, Touch ID or the device passcode, or with a password on a device without one/);
  expect(play).toMatch(/or with a password on a device without one/);
});

// SD-10: no store text of an earlier app is left for a tool that publishes the whole tree.
it('no stale store texts: no F-Droid metadata, and no changelog names codes, rewards, burns or activation', () => {
  expect(fs.existsSync(path.join(ROOT, 'fdroid-metadata.yml'))).toBe(false);
  const dir = path.join(ROOT, '..', '..', 'fastlane', 'metadata', 'android', 'en-US', 'changelogs');
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    expect([f, /activat|reward|burn|\bcodes?\b/i.test(text)]).toEqual([f, false]);
  }
});

it('the Play texts describe the same build: no code, no reward, the device check and a changelog for this version', () => {
  const dir = path.join(ROOT, '..', '..', 'fastlane', 'metadata', 'android', 'en-US');
  const full = fs.readFileSync(path.join(dir, 'full_description.txt'), 'utf8');
  expect(full).not.toMatch(/activation code|reward|burn|extension/i);
  expect(full).toMatch(/pass the system's device check, one node per device/);
  const code = /versionCode (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8'))[1];
  const whatsNew = fs.readFileSync(path.join(dir, 'changelogs', `${code}.txt`), 'utf8');
  expect(whatsNew.length).toBeLessThanOrEqual(500);
  expect(whatsNew).not.toMatch(/code|aiqnet|website|cabinet|activat|reward|burn/i);
});

// CROSS-R2-08: every link the store builds and the App Store listing give to the site carries the site's app marker,
// so the site shows its app view (explorer and policies only): no activation page, extension or APK a few taps away.
it('the listing\'s URLs and the app\'s legal links open the site in its app view', () => {
  for (const label of ['Support URL', 'Marketing URL', 'Privacy Policy']) {
    const m = new RegExp(`${label}:\\s+(\\S+)`).exec(listing);
    expect([label, m && /^https:\/\/aiqnet\.io\/[a-z]+\?from=app$/.test(m[1])]).toEqual([label, true]);
  }
  expect(listing).not.toMatch(/Marketing URL:\s+https:\/\/aiqnet\.io\/wallet/);
  const screen = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'WalletScreen.js'), 'utf8');
  const links = screen.slice(screen.indexOf('const LEGAL_LINKS = ['), screen.indexOf('];', screen.indexOf('const LEGAL_LINKS = [')));
  const urls = [...links.matchAll(/'(https:[^']+)'/g)].map((m) => m[1]);
  expect(urls).toHaveLength(3);
  for (const u of urls) expect([u, u.endsWith('?from=app')]).toEqual([u, true]);
  const site = path.join(ROOT, '..', 'qnet-explorer', 'frontend', 'src', 'lib', 'activate-view.ts');
  if (fs.existsSync(site)) {
    const view = fs.readFileSync(site, 'utf8');
    expect(view).toMatch(/export const FROM_APP_PARAM = 'from';/);
    expect(view).toMatch(/export const FROM_APP_VALUE = 'app';/);
  }
});

// R4-XPD-05: the public description itself (what a reviewer or user taps inside the store) opens the site in its app
// view too, and names the languages the app ships in full.
it('every aiqnet.io link in the public texts carries the app marker, and the listing names all 11 languages', () => {
  const publicPart = listing.slice(0, listing.indexOf('APP REVIEW INFORMATION'));
  const play = fs.readFileSync(path.join(ROOT, 'store-listing', 'google-play-description.txt'), 'utf8');
  for (const [name, text] of [['app-store-listing', publicPart], ['google-play-description', play]]) {
    const urls = [...text.matchAll(/https:\/\/aiqnet\.io[^\s)"',]*/g)].map((m) => m[0].replace(/[.;:]+$/, ''));
    expect([name, urls.length > 0]).toEqual([name, true]);
    for (const u of urls) expect([name, u, /\?from=app$/.test(u)]).toEqual([name, u, true]);
  }
  const languages = /LANGUAGES\s*\n([^\n]+)/.exec(publicPart)[1];
  for (const lang of ['English', 'Chinese (Simplified)', 'Russian', 'Spanish', 'French', 'German', 'Japanese', 'Korean',
    'Portuguese', 'Arabic', 'Italian']) {
    expect([lang, languages.includes(lang)]).toEqual([lang, true]);
  }
  expect(languages).not.toMatch(/partial/i);
  expect(Object.keys(require('../src/i18n/translations').default)).toHaveLength(11);
});

// R5-XPD-02: the Play texts that are uploaded are the ones under fastlane/metadata (google-play-description.txt only
// points there): the full description, the short one and every "What's new" follow the same rules.
it('the uploaded Play texts link the site only in its app view and name all 11 languages', () => {
  const dir = path.join(ROOT, '..', '..', 'fastlane', 'metadata', 'android', 'en-US');
  const full = fs.readFileSync(path.join(dir, 'full_description.txt'), 'utf8');
  const texts = [['full_description', full], ['short_description', fs.readFileSync(path.join(dir, 'short_description.txt'), 'utf8')],
    ...fs.readdirSync(path.join(dir, 'changelogs')).map((f) => [`changelogs/${f}`, fs.readFileSync(path.join(dir, 'changelogs', f), 'utf8')])];
  let links = 0;
  for (const [name, text] of texts) {
    const urls = [...text.matchAll(/https?:\/\/(?:www\.)?aiqnet\.io[^\s)"',]*/g)].map((m) => m[0].replace(/[.;:]+$/, ''));
    links += urls.length;
    for (const u of urls) expect([name, u, /^https:\/\/aiqnet\.io\/[a-z]*\?from=app$/.test(u)]).toEqual([name, u, true]);
  }
  expect(links).toBeGreaterThan(0);
  const languages = /LANGUAGES\s*\n([^\n]+)/.exec(full)[1];
  for (const lang of ['English', 'Chinese (Simplified)', 'Russian', 'Spanish', 'French', 'German', 'Japanese', 'Korean',
    'Portuguese', 'Arabic', 'Italian']) {
    expect([lang, languages.includes(lang)]).toEqual([lang, true]);
  }
  expect(languages).not.toMatch(/partial/i);
  expect(full.length).toBeLessThanOrEqual(4000);
});

// The device's platform and model name the binding carries (src/services/DeviceModel.js) is the fourth type: Other Data
// Types, linked, for app functionality; Play's form has no type for it and the notes say why (owner, 06.10).
it('the privacy manifest declares what the store answers: device ID, user ID, financial info and the device model, all linked', () => {
  const manifest = fs.readFileSync(path.join(ROOT, 'ios', 'QNetMobile', 'PrivacyInfo.xcprivacy'), 'utf8');
  const entries = [...manifest.matchAll(/<dict>\s*<key>NSPrivacyCollectedDataType<\/key>([\s\S]*?)<\/dict>/g)].map((m) => m[1]);
  const types = entries.map((e) => [
    /^\s*<string>(NSPrivacyCollectedDataType\w+)<\/string>/.exec(e)?.[1],
    /<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<(true|false)\/>/.exec(e)?.[1],
    /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<(true|false)\/>/.exec(e)?.[1],
    [...e.matchAll(/<string>(NSPrivacyCollectedDataTypePurpose\w+)<\/string>/g)].map((p) => p[1]).join(','),
  ]);
  const functional = (type) => [type, 'true', 'false', 'NSPrivacyCollectedDataTypePurposeAppFunctionality'];
  expect(types).toEqual([functional('NSPrivacyCollectedDataTypeDeviceID'), functional('NSPrivacyCollectedDataTypeUserID'),
    functional('NSPrivacyCollectedDataTypeOtherFinancialInfo'), functional('NSPrivacyCollectedDataTypeOtherDataTypes'),
    functional('NSPrivacyCollectedDataTypeProductInteraction'), functional('NSPrivacyCollectedDataTypeOtherDiagnosticData')]);
  expect(manifest.match(/<key>NSPrivacyCollectedDataType<\/key>/g)).toHaveLength(6);
  expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  const appPrivacy = readme.slice(readme.indexOf('**App Store — App Privacy**'), readme.indexOf('## Export compliance'));
  const rows = appPrivacy.split('\n').filter((l) => /^\| [^-|]/.test(l) && !l.startsWith('| Data type |'));
  expect(rows).toEqual([
    '| Identifiers → User ID (QNet and Solana addresses) | Yes | No | App Functionality |',
    '| Identifiers → Device ID (push token and the device check, only while a node is linked) | Yes | No | App Functionality |',
    '| Financial Info → Other Financial Info (transactions the user signs) | Yes | No | App Functionality |',
    '| Other Data → Other Data Types (the device\'s platform and model name, only while a node is linked) | Yes | No | App Functionality |',
    '| Usage Data → Product Interaction (whether the app could answer the node\'s wake-ups, only while a node is linked) | Yes | No | App Functionality |',
    '| Diagnostics → Other Diagnostic Data (when a wake-up was sent, reached the device and was answered, only while a node is linked) | Yes | No | App Functionality |',
  ]);
  // Play: the model is no device ID and no app performance data; the notes say so, and no data type Play is told is
  // collected names it (the deletion answer does: unlinking deletes it).
  const play = readme.slice(readme.indexOf('**Google Play — Data safety**'), readme.indexOf('**App Store — App Privacy**'));
  expect(play.replace(/\s+/g, ' ')).toMatch(/Play's form has no data type for them, so no row above declares them: they are not "Device or other IDs" .* and not "App info and performance"/);
  const collected = play.split('\n').filter((l) => /^\| [^|]+ \| Collected\b/.test(l));
  expect(collected.map((l) => l.split(' | ')[0])).toEqual(['| Personal info → User IDs', '| Financial info → Purchase history (and Other financial info)',
    '| Device or other IDs', '| App activity → Installed apps', '| App activity → App interactions', '| App info and performance → Diagnostics']);
  for (const row of collected) expect(row).not.toMatch(/model/i);
});

// STD-1: store images show the build they ship with. Every screenshot folder carries build.txt naming the versionCode its
// images were taken from, the current one; the old top-tab build's screenshots ("Activate" tab, a large balance) are gone.
it('screenshots come from this build, or there are none', () => {
  const images = path.join(ROOT, '..', '..', 'fastlane', 'metadata', 'android', 'en-US', 'images');
  const code = /versionCode (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8'))[1];
  for (const kind of ['phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots', 'tvScreenshots', 'wearScreenshots']) {
    const dir = path.join(images, kind);
    if (!fs.existsSync(dir)) continue;
    const pictures = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
    if (pictures.length === 0) continue;
    const build = path.join(dir, 'build.txt');
    expect([kind, fs.existsSync(build) ? fs.readFileSync(build, 'utf8').trim() : null]).toEqual([kind, code]);
  }
});

// STD-2: App Store Connect refuses an App Store icon with an alpha channel (ITMS-90717): every icon is plain RGB.
it('the iOS app icons carry no alpha channel', () => {
  const dir = path.join(ROOT, 'ios', 'QNetMobile', 'Images.xcassets', 'AppIcon.appiconset');
  const contents = JSON.parse(fs.readFileSync(path.join(dir, 'Contents.json'), 'utf8'));
  const marketing = contents.images.find((i) => i.idiom === 'ios-marketing');
  expect(marketing && marketing.filename).toBe('icon-1024.png');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.png'))) {
    const head = fs.readFileSync(path.join(dir, f)).subarray(0, 26);
    expect([f, head.toString('latin1', 12, 16), head[25]]).toEqual([f, 'IHDR', 2]); // colour type 2: RGB, no alpha
  }
});

// STD-3: the review notes fit App Store Connect's 4,000 characters with three real phrases of the longest words, and the
// encryption answer is not part of them.
it('the App Review notes stay within 3,850 characters with real phrases; the encryption answer is apart', () => {
  const lines = listing.split('\n');
  const start = lines.findIndex((l) => l.startsWith('APP REVIEW INFORMATION — NOTES')) + 2;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('C: <12 words'));
  const notes = lines.slice(start, end + 1).join('\n');
  const phrase = Array(12).fill('abstract').join(' '); // 8 letters, the longest words of the list
  const filled = notes.replace(/<12 words[^>]*>/g, phrase).replace('{x}', '0.0');
  expect(filled.length).toBeLessThanOrEqual(3850);
  expect(notes).not.toMatch(/Encryption: ML-DSA-65|X25519 with HKDF-SHA256/);
  expect(listing).toMatch(/EXPORT COMPLIANCE[^\n]*\n=+\nEncryption: ML-DSA-65 signatures/);
});

// STD-4: one answer set for the content rating questionnaire, the same in both submission files.
it('the Play content rating answers are the README\'s: crypto rewards and web browsing both Yes', () => {
  const play = fs.readFileSync(path.join(ROOT, 'store-listing', 'google-play-description.txt'), 'utf8');
  const rating = play.slice(play.indexOf('CONTENT RATING'), play.indexOf('TAGS'));
  expect(rating).toMatch(/convertible cryptocurrency rewards: Yes/);
  expect(rating).toMatch(/unrestricted internet or web browsing: Yes/);
  expect(readme).toMatch(/convertible cryptocurrency rewards: yes/i);
  expect(readme).toMatch(/Play's IARC questionnaire the same way where it asks about web access/);
});

// STD-5: the consent names what the device check sends besides the public key, the same text on every device. What the
// system's check can tell is all the privacy policy says it reports (MN-R3-04): apps that can capture the screen, show
// themselves over other apps or control the device, installed as well as running.
it('the device-check consent names the system\'s own check and what it can tell, in every language', () => {
  const translations = require('../src/i18n/translations').default;
  expect(translations.en.link_device_check_body).toMatch(/sends only its public part, with the system's own check of the device, which can say whether apps that can capture the screen, show themselves over other apps or control the device are installed or running\./);
  // Every translation carries each part of the clause in its own words: the screen, the overlay, installed or running.
  const parts = {
    en: ['capture the screen', 'over other apps', 'installed or running'],
    ru: ['захватывать экран', 'поверх других приложений', 'установлены или запущены'],
    de: ['den Bildschirm erfassen', 'über anderen Apps', 'installiert sind oder laufen'],
    es: ['capturar la pantalla', 'sobre otras apps', 'instaladas o en ejecución'],
    fr: ["capturer l'écran", "par-dessus d'autres applications", 'installées ou en cours'],
    it: ['acquisire lo schermo', 'sopra altre app', 'installate o in esecuzione'],
    pt: ['capturar a tela', 'sobre outros apps', 'instalados ou em execução'],
    ja: ['画面を取得', '他のアプリの上に', 'インストールされているか'],
    ko: ['화면을 캡처', '다른 앱 위에', '설치되어 있거나'],
    'zh-CN': ['捕获屏幕', '其他应用上层', '安装了或正在运行'],
    ar: ['التقاط الشاشة', 'فوق التطبيقات الأخرى', 'مثبّتة أو قيد التشغيل'],
  };
  expect(Object.keys(translations).sort()).toEqual(Object.keys(parts).sort());
  for (const [lang, tr] of Object.entries(translations)) {
    for (const part of parts[lang]) expect([lang, part, tr.link_device_check_body.includes(part)]).toEqual([lang, part, true]);
  }
});

// STD-6: no other project's, wallet's or chain's name in the app's own code.
it('no other project is named in the app\'s own code', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  expect(read('src/crypto/PasswordStrength.js')).not.toMatch(/'(bitcoin|ethereum|metamask|phantom)'/);
  const wm = read('src/components/WalletManager.js');
  expect(wm).not.toMatch(/deriveEvmWallet|evmResult|evmAddress/);
  expect(wm).toMatch(/async deriveSecp256k1Account\(seed\)/);
});

// STD-R4-01: the notes never tell App Review something the build contradicts. A node answers the network also when
// the app is opened (PushService selfAttestIfNeeded at launch and on every return), so they say so, and claim no
// "nothing for app opens".
it('the review notes say a node is counted also when the app is opened, and claim nothing the build contradicts', () => {
  const notes = listing.slice(listing.indexOf('APP REVIEW INFORMATION'));
  expect(notes).not.toMatch(/app opens or any task/);
  expect(notes).not.toMatch(/No currency for[^.]*app open/i);
  expect(notes).toMatch(/NODE BALANCE\.[^\n]*answered its status request, in the background or when the app is opened/);
  expect(notes).toMatch(/offers nothing for downloads, referrals, posts, reviews or any promotional action/);
  const push = fs.readFileSync(path.join(ROOT, 'src', 'services', 'PushService.js'), 'utf8');
  expect(push).toMatch(/app open is a wakeup/); // the behaviour the sentence describes
});
