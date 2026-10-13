// The chain is named "QNet Blockchain" in every text a user can read, in every language, and in no other way: no other
// form of its name, no translation of it, no bare "QNet" for it. The product names QNet Wallet and QNet Link stay.
const fs = require('fs');
const path = require('path');
const translations = require('../src/i18n/translations').default;
const legacy = require('../src/i18n/overlay.legacy').default;
const { CHAIN_NAME } = require('../src/i18n');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Other forms of the chain's name, in any of the app's languages.
const BANNED = [
  /QNet[\s-]*(network|chain)\b/i,
  /QNet[\s-]+blockchain/, // the name with a small b
  /QNet-Blockchain/,
  /\bthe QNet(?!\s(Wallet|Link)\b)/i,
  /Quantum\s+(Blockchain|Network)/i,
  /Post-Quantum\s+Blockchain/i,
  /(сет[ьиюяей]|сетью|блокчейн\S*|цепочк\S*)\s+QNet/i,
  /QNet-?(Netzwerk|Kette)/i,
  /\b(réseau|chaîne|blockchain|red|cadena|rete|catena|rede|cadeia)\s+((de|di|da|do|du)\s+(la\s+)?)?QNet/i,
  /QNet\s*(ネットワーク|ブロックチェーン|チェーン)/,
  /QNet\s*(네트워크|블록체인|체인)/,
  /QNet\s*(网络|區塊鏈|区块链|链)/,
  /(شبكة|الشبكة|سلسلة كتل|بلوكتشين|بلوك تشين)\s+QNet/,
];

// Every "QNet" is one of the three names, written as they are in every language (the product name QNet Wallet too).
const BARE = /QNet(?!\s(Blockchain|Wallet|Link)\b)/;

function offences(text) {
  const found = BANNED.filter((re) => re.test(text)).map(String);
  if (BARE.test(text)) found.push('bare QNet');
  return found;
}

describe('the chain\'s name', () => {
  it('is QNet Blockchain in the code that writes it', () => {
    expect(CHAIN_NAME).toBe('QNet Blockchain');
  });

  it('the checks catch the forms they are for', () => {
    for (const text of ['QNet network', 'the QNet blockchain', 'QNet-Blockchain', 'Quantum Blockchain', 'сеть QNet',
      'блокчейн QNet', 'QNet-Netzwerk', 'réseau QNet', 'la blockchain de QNet', 'red QNet', 'rete QNet', 'rede QNet',
      'blockchain da QNet', 'QNetネットワーク', 'QNet 네트워크', 'QNet 网络', 'شبكة QNet', 'QNet could not be reached',
      'Recorded on QNet.', 'Scan a QNet address', 'Get started with QNet', 'QNet Кошелёк', 'Cartera QNet', 'محفظة QNet',
      'QNet ウォレット', 'QNet 钱包']) {
      expect([text, offences(text).length > 0]).toEqual([text, true]);
    }
    for (const text of ['QNet Blockchain did not answer.', 'QNet Wallet', 'QNet Link', 'QNet Wallet の', 'QNet Wallet이',
      'the network fee', 'QNC', 'QNET WALLET', 'aiqnet.io']) {
      expect([text, offences(text)]).toEqual([text, []]);
    }
  });

  it.each(Object.keys(translations))('every text of %s names it QNet Blockchain only', (lang) => {
    const tables = { ...translations[lang], ...legacy[lang] };
    const bad = Object.entries(tables).map(([k, v]) => [k, offences(String(v))]).filter(([, o]) => o.length > 0);
    expect(bad).toEqual([]);
  });

  it('the screens write it from one place, never as a bare QNet', () => {
    const ws = read('src/screens/WalletScreen.js');
    expect(ws).toMatch(/>\{CHAIN_NAME\}<\/Text>/);
    expect(ws).toMatch(/\[\['qnet', CHAIN_NAME\], \['solana', 'Solana'\]\]/);
    expect(ws).toMatch(/network: isQnetSend \? CHAIN_NAME : 'Solana'/);
    expect(ws).toMatch(/subtitle=\{`\$\{CHAIN_NAME\} testnet · \$\{t\('solana_devnet'\)\}`\}/);
    for (const file of ['src/screens/WalletScreen.js', 'src/screens/NodeTab.js', 'src/screens/HistoryTab.js',
      'src/screens/QNetLinkScreen.js', 'src/screens/SolanaSend.js', 'src/components/SendReview.js',
      'src/components/TxResultCard.js', 'src/components/QrScanSheet.js', 'src/browser/BrowserScreen.js',
      'src/browser/DappSheet.js']) {
      const code = read(file).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');
      const found = [/>\s*QNet\s*</g, /QNet Testnet/gi, /\[\s*'qnet',\s*'QNet'\s*\]/g, /\?\s*'QNet'\s*:/g]
        .flatMap((re) => code.match(re) || []);
      expect([file, found]).toEqual([file, []]);
    }
  });

  it('a Solana text never names it: a Solana send nobody answered says the Solana network did not answer', () => {
    for (const [lang, table] of Object.entries(translations)) {
      const bad = Object.keys(table).filter((k) => /solana|_SOL_/i.test(k) && table[k].includes('QNet Blockchain'));
      expect([lang, bad]).toEqual([lang, []]);
      expect([lang, table.tx_note_unknown_solana.includes('Solana')]).toEqual([lang, true]);
    }
    const ws = read('src/screens/WalletScreen.js');
    const solanaSent = ws.slice(ws.indexOf('const onSolanaSent'), ws.indexOf('const onSolanaSent') + 600);
    expect(solanaSent).toMatch(/note: t\('tx_note_unknown_solana'\)/);
    expect(solanaSent).not.toMatch(/'tx_note_unknown'/);
  });

  it('the system texts outside the tables say it no other way either', () => {
    const files = [
      'ios/QNetMobile/Info.plist',
      ...fs.readdirSync(path.join(root, 'ios/QNetMobile')).filter((d) => d.endsWith('.lproj'))
        .map((d) => `ios/QNetMobile/${d}/InfoPlist.strings`),
      'android/app/src/main/res/values/strings.xml',
      'app.json',
    ];
    for (const file of files) {
      const strings = [...read(file).matchAll(/<string>([^<]*)<\/string>|"([^"]*)"\s*;|<string name="[^"]*">([^<]*)<\/string>|"displayName":\s*"([^"]*)"/g)]
        .map((m) => m[1] || m[2] || m[3] || m[4] || '');
      expect([file, strings.filter((s) => offences(s).length > 0)]).toEqual([file, []]);
    }
  });
});
