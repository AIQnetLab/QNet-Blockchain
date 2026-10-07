// Round-3 platform findings: the recovery-phrase field exports nothing and a paste leaves the clipboard (MPLAT-R3-01),
// the integrity check runs when a phrase is shown or typed (MPLAT-R3-02), the store builds' outbound links open the
// site's app view (R3-XPD-01, R3-XPD-03), and any spelling of a phrase imports as the wallet it names (R3-XPD-07).
const fs = require('fs');
const path = require('path');
const { SEED_INPUT_PROPS, SEED_FIELD_ID, looksPasted, insertedText } = require('../src/utils/sensitiveInput');
const { explorerTxUrl } = require('../src/config/nodes');
const { WalletManager } = require('../src/components/WalletManager');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const screen = read('src/screens/WalletScreen.js');
const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

describe('MPLAT-R3-01: the phrase field exports nothing, and a paste leaves the clipboard', () => {
  it('a change that brought text at once is a paste, a Select All over an almost identical phrase included', () => {
    expect(looksPasted('', PHRASE)).toBe(true);
    const fixedWord = PHRASE.replace('ability', 'abandon');
    expect(insertedText(PHRASE, fixedWord)).toBe('andon');
    expect(looksPasted(PHRASE, fixedWord)).toBe(true); // Select All + Paste of the corrected copy
    expect(looksPasted('abandon abil', 'abandon abili')).toBe(false); // typing, one letter at a time
    expect(looksPasted('abandon', 'abandon ')).toBe(false);
    expect(looksPasted('abandon', 'abandon ab')).toBe(false);
    expect(looksPasted('a', 'a b c')).toBe(true); // two words at once
  });

  it('the field is marked for the native guards on both platforms', () => {
    expect(SEED_FIELD_ID).toBe('qnet-seed-input');
    expect(SEED_INPUT_PROPS).toMatchObject({ nativeID: SEED_FIELD_ID, testID: SEED_FIELD_ID, contextMenuHidden: false });
    // iOS: the patched text views key on that testID (their accessibilityIdentifier).
    const rn = read('patches/react-native+0.81.4.patch');
    expect(rn).toMatch(/Multiline\/RCTUITextView\.mm/);
    expect(rn).toMatch(/return \[view\.accessibilityIdentifier isEqualToString:@"qnet-seed-input"\];/);
    expect(rn).toMatch(/if \(RCTQNetIsSeedField\(self\) && action != @selector\(paste:\) && action != @selector\(select:\) &&/);
    expect(rn).toMatch(/- \(void\)copy:\(id\)sender\n\+\{\n\+  if \(RCTQNetIsSeedField\(self\)\) \{\n\+    return;/);
    expect(rn).toMatch(/\[\[UIPasteboard generalPasteboard\] setItems:@\[\] options:@\{\}\];/);
    expect(rn).toMatch(/\[builder removeMenuForIdentifier:UIMenuShare\];/);
    // Android: the app's own module finds the field by that nativeID.
    const kotlin = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    expect(kotlin).toMatch(/private const val SEED_NATIVE_ID = "qnet-seed-input"/);
    expect(kotlin).toMatch(/item\.isVisible = item\.itemId == android\.R\.id\.paste \|\| item\.itemId == android\.R\.id\.selectAll/);
    expect(kotlin).toMatch(/field\.customSelectionActionModeCallback = seedMenu\s*field\.customInsertionActionModeCallback = seedMenu/);
    expect(kotlin).toMatch(/cm\.addPrimaryClipChangedListener\(seedClipListener\)/);
    expect(kotlin).toMatch(/item\.itemId == android\.R\.id\.paste \|\| item\.itemId == android\.R\.id\.pasteAsPlainText\) \{\s*main\.post \{ clearClipboardNow\(\) \}/);
    const ios = read('ios/QNetMobile/QNetSecurityModule.m');
    expect(ios).toMatch(/RCT_EXPORT_METHOD\(pasteboardChangeCount:/);
    expect(ios).toMatch(/BOOL changed = since < 0 \|\| board\.changeCount != \(NSInteger\)since;\s*if \(changed && board\.hasStrings\)/);
  });

  it('the import screen uses them: the guard, the change count, the paste signal and the exit rule', () => {
    expect(screen).toMatch(/onLayout=\{onSeedFieldShown\}/);
    expect(screen).toMatch(/const onSeedFieldShown = \(\) => \{\s*guardSeedField\(true\);/);
    expect(screen).toMatch(/if \(looksPasted\(prev, text\)\) \{\s*seedPastedRef\.current = true;\s*clearPastedPhrase\(text\);/);
    expect(screen).toMatch(/if \(Platform\.OS === 'ios'\) \{\s*await clearPasteboardIfChanged\(seedBoardAtRef\.current\);/);
    expect(screen).not.toMatch(/words\(text\) - words\(seedPhrase\) >= 11/);
  });
});

describe('MPLAT-R3-02: the integrity check runs when a phrase is shown or typed', () => {
  it('creation, import and Export each check at that moment; creation and import warn, Export refuses', () => {
    const create = screen.slice(screen.indexOf('const createWallet = async'), screen.indexOf('const importWalletSteps'));
    expect(create).toMatch(/if \(!\(await confirmPhraseScreen\(\)\)\) return;/);
    expect(screen).toMatch(/const confirmPhraseScreen = async \(\) => \(await confirmNoScreenReaders\(\)\) && \(await confirmDeviceIntegrity\(\)\);/);
    expect(screen).toMatch(/const confirmDeviceIntegrity = async \(\) => \{\s*const r = await deviceIntegrity\(\);/);
    expect(screen).toMatch(/t\('rooted_title'\),\s*t\('rooted_body_phrase'\)/);
    // A password wallet: after the password step; under the screen lock the import starts at the phrase field.
    expect(screen).toMatch(/if \(!\(await confirmPhraseScreen\(\)\)\) return;\s*setImportStep\(2\);/);
    expect(screen).toMatch(/if \(deviceAuth && !\(await confirmPhraseScreen\(\)\)\) return;/);
    // Export of the phrase and of the private keys run one reveal (revealSecret), which checks first.
    expect(screen).toMatch(/const exportSeedPhrase = \(readersAcknowledged = false\) => revealSecret\('phrase', readersAcknowledged\);/);
    expect(screen).toMatch(/const exportPrivateKey = \(readersAcknowledged = false\) => revealSecret\('key', readersAcknowledged\);/);
    const exportFn = screen.slice(screen.indexOf('const revealSecret = async'), screen.indexOf('const handleChangePassword'));
    expect(exportFn).toMatch(/^const revealSecret = async \(kind, readersAcknowledged = false\) => \{\s*\/\/[^\n]*\n\s*const integrity = await deviceIntegrity\(\);[\s\S]{0,120}if \(integrity\.compromised\) \{/);
    const en = require('../src/i18n/translations').default.en;
    expect(en.set_rooted_warning).not.toMatch(/the recovery phrase is not shown here/);
  });
});

describe('R3-XPD-01 / R3-XPD-03: outbound links of the store builds open the site\'s app view', () => {
  it('every history row and result card opens the explorer with the marker', () => {
    expect(explorerTxUrl('f00d')).toBe('https://aiqnet.io/explorer/tx/f00d?from=app');
    const nodes = read('src/config/nodes.js');
    const line = nodes.split('\n').find((l) => l.includes('export const explorerTxUrl'));
    expect(line.trimEnd().endsWith('?from=app`;')).toBe(true); // the site's release check reads this line
  });

  it('every aiqnet.io URL given to Play carries the marker, and the developer website is a page of the app view', () => {
    const play = read('store-listing/google-play-description.txt');
    const urls = [...play.matchAll(/https:\/\/aiqnet\.io[^\s)]*/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const u of urls) expect([u, new URL(u).searchParams.get('from')]).toEqual([u, 'app']);
    expect(play).toMatch(/Developer website:\s+https:\/\/aiqnet\.io\/explorer\?from=app/);
  });
});

describe('R3-XPD-07: any spelling of a phrase imports as the wallet it names', () => {
  it('capitals, line breaks and double spaces are the same words: the extension\'s canonical form', async () => {
    expect(WalletManager.canonicalMnemonic(`  Abandon  ABANDON\tabandon\nabandon abandon abandon abandon abandon abandon abandon abandon About \n`))
      .toBe('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    const wm = new WalletManager();
    const seen = [];
    wm.mnemonicToSeedAsync = jest.fn(async (m) => { seen.push(m); throw new Error('stop here'); });
    await wm.importWallet('Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT').catch(() => {});
    expect(seen).toEqual(['abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about']);
    // Words outside the list or a bad checksum are still refused.
    await expect(wm.importWallet('Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'))
      .rejects.toMatchObject({ code: 'INVALID_PHRASE' });
  });
});
