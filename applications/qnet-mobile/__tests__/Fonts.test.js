/**
 * The app's six faces (assets/native/fonts), bundled once for both platforms: Android reads the folder as an asset
 * source (android/app/build.gradle), iOS lists them in Info.plist and copies them as resources. Each face is named by
 * its PostScript name = its file name, keeps its copyright and licence records, and ships beside its OFL text. A
 * script a face does not cover takes the system face for the whole role (theme.type).
 */
import fs from 'fs';
import path from 'path';
import { FACES, MONO_ADVANCE, ROLE_NAMES, type } from '../src/theme';

const APP = path.join(__dirname, '..');
const DIR = path.join(APP, 'assets', 'native', 'fonts');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

// The tables of a TrueType file, and its name records (Windows, Unicode BMP) by id.
function tables(buf) {
  const out = {};
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i += 1) {
    const o = 12 + 16 * i;
    out[buf.toString('ascii', o, o + 4)] = { offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) };
  }
  return out;
}
function names(buf) {
  const { offset } = tables(buf).name;
  const count = buf.readUInt16BE(offset + 2);
  const strings = offset + buf.readUInt16BE(offset + 4);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    const r = offset + 6 + 12 * i;
    if (buf.readUInt16BE(r) !== 3 || buf.readUInt16BE(r + 2) !== 1) continue;
    const id = buf.readUInt16BE(r + 6);
    const len = buf.readUInt16BE(r + 8);
    const at = strings + buf.readUInt16BE(r + 10);
    let s = '';
    for (let k = 0; k < len; k += 2) s += String.fromCharCode(buf.readUInt16BE(at + k));
    out[id] = s;
  }
  return out;
}
// The advance most glyphs of a face share, in em.
function commonAdvance(buf) {
  const t = tables(buf);
  const upm = buf.readUInt16BE(t.head.offset + 18);
  const metrics = buf.readUInt16BE(t.hhea.offset + 34);
  const counts = new Map();
  for (let g = 1; g < metrics; g += 1) {
    const w = buf.readUInt16BE(t.hmtx.offset + 4 * g);
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const [w] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return w / upm;
}

describe('the faces', () => {
  const faces = Object.values(FACES);

  it('each face the theme names is in the folder, named by its PostScript name, with its licence beside it', () => {
    expect(faces.sort()).toEqual(['Archivo-Regular', 'Archivo-SemiBold', 'Archivo-Title', 'MartianMono-Data', 'MartianMono-Figure',
      'MartianMono-Label']);
    for (const face of faces) {
      const buf = fs.readFileSync(path.join(DIR, `${face}.ttf`));
      const n = names(buf);
      expect([face, n[6]]).toEqual([face, face]);
      // The copyright, the licence and its address travel inside every face.
      expect([face, /Copyright 2020 The (Archivo|Martian Mono) Project Authors/.test(n[0])]).toEqual([face, true]);
      expect([face, /SIL Open Font License, Version 1\.1/.test(n[13]), n[14]]).toEqual([face, true, 'https://openfontlicense.org']);
    }
    for (const ofl of ['OFL-Archivo.txt', 'OFL-MartianMono.txt']) {
      const text = fs.readFileSync(path.join(DIR, ofl), 'utf8');
      expect(text).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
      // No Reserved Font Name is declared, so the cut faces may keep the families' names.
      expect(text.split('PREAMBLE')[0]).not.toMatch(/Reserved Font Name/i);
    }
  });

  it('the mono faces are as wide as the estimates of what fits take them to be', () => {
    for (const [key, em] of Object.entries(MONO_ADVANCE)) {
      expect([key, Math.abs(commonAdvance(fs.readFileSync(path.join(DIR, `${FACES[key]}.ttf`))) - em) < 0.005]).toEqual([key, true]);
    }
  });

  it('the folder stays small: at most 450 KB with the licence texts', () => {
    const total = fs.readdirSync(DIR).reduce((a, f) => a + fs.statSync(path.join(DIR, f)).size, 0);
    expect(total).toBeLessThanOrEqual(450 * 1024);
  });
});

describe('bundled for both platforms, one copy of each file', () => {
  const faces = Object.values(FACES);

  it('Android reads the folder as an asset source of every build', () => {
    expect(read('android/app/build.gradle')).toMatch(/main\.assets\.srcDirs \+= '\.\.\/\.\.\/assets\/native'/);
  });

  it('iOS lists every face in Info.plist and copies it with the app', () => {
    const plist = read('ios/QNetMobile/Info.plist');
    const list = plist.slice(plist.indexOf('<key>UIAppFonts</key>'), plist.indexOf('</array>', plist.indexOf('<key>UIAppFonts</key>')));
    expect([...list.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]).sort()).toEqual(faces.map((f) => `${f}.ttf`).sort());
    const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
    const resources = pbx.slice(pbx.indexOf('/* Begin PBXResourcesBuildPhase section */'), pbx.indexOf('/* End PBXResourcesBuildPhase section */'));
    for (const face of faces) {
      expect([face, pbx.includes(`path = ../assets/native/fonts/${face}.ttf; sourceTree = SOURCE_ROOT;`)]).toEqual([face, true]);
      expect([face, resources.includes(`/* ${face}.ttf in Resources */`)]).toEqual([face, true]);
    }
  });
});

describe('a face per script', () => {
  it('Latin languages set words in Archivo and labels in Martian Mono, capitalised and tracked', () => {
    for (const lang of ['en', 'es', 'fr', 'de', 'it', 'pt']) {
      expect([lang, type('body', lang).fontFamily, type('title', lang).fontFamily]).toEqual([lang, 'Archivo-Regular', 'Archivo-Title']);
      expect([lang, type('label', lang)]).toEqual([lang, expect.objectContaining({ fontFamily: 'MartianMono-Label', textTransform: 'uppercase', letterSpacing: 1.3 })]);
    }
  });

  it('Russian sets words in the system face with a weight, labels still in Martian Mono', () => {
    expect(type('row', 'ru')).toEqual(expect.objectContaining({ fontWeight: '600' }));
    expect(type('row', 'ru').fontFamily).toBeUndefined();
    expect(type('title', 'ru')).toEqual(expect.objectContaining({ fontWeight: '700', letterSpacing: 0 }));
    expect(type('label', 'ru')).toEqual(expect.objectContaining({ fontFamily: 'MartianMono-Label', textTransform: 'uppercase' }));
  });

  it('Japanese, Korean, Chinese and Arabic set words and labels in the system face, never capitalised or tracked', () => {
    for (const lang of ['ja', 'ko', 'zh-CN', 'ar']) {
      for (const role of ['body', 'row', 'title', 'label', 'act']) {
        const st = type(role, lang);
        expect([lang, role, st.fontFamily, st.textTransform, st.letterSpacing]).toEqual([lang, role, undefined, undefined, 0]);
        expect([lang, role, typeof st.fontWeight]).toEqual([lang, role, 'string']);
      }
    }
  });

  it('figures, amounts and addresses keep Martian Mono in every language; a bundled face never carries a weight', () => {
    for (const lang of ['en', 'ru', 'ja', 'ar']) {
      for (const role of ['data', 'amount', 'address', 'figure']) expect([lang, role, /^MartianMono-/.test(type(role, lang).fontFamily)]).toEqual([lang, role, true]);
      for (const role of ROLE_NAMES) {
        const st = type(role, lang);
        expect([lang, role, !!st.fontFamily && !!st.fontWeight]).toEqual([lang, role, false]);
        expect([lang, role, st.includeFontPadding, typeof st.lineHeight]).toEqual([lang, role, false, 'number']);
      }
    }
  });
});
