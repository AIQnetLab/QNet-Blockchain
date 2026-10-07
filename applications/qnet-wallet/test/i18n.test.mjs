// Localization (i18n spec): every UI language has every key of the English source with the same
// placeholders, keeps the non-translatable tokens, uses the mobile app's terminology, and the manifest
// strings exist per Chrome locale; the pages hold no user-visible text outside the tables (a static scan
// of every string literal of dist/ui with an allow-list of non-translatable tokens). The layout in every
// language is checked in headless Chrome by scripts/overflow-check.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LANGUAGE, RTL_LANGUAGES, SUPPORTED_LANGUAGES, languageForTag,
} from '../dist/background/config.js';
import { ERROR_MESSAGES } from '../dist/background/errors.js';
import { LANGUAGE_NAMES, loadMessages } from '../dist/ui/i18n/index.js';

const WALLET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(WALLET, rel), 'utf8');
const EN = await loadMessages('en');
const TABLES = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (code) => [code, await loadMessages(code)])));
const placeholders = (text) => [...text.matchAll(/\$([1-9])/g)].map((m) => m[1]).sort().join(',');

// Chrome locale directory of each UI language (pt ships for Brazil and Portugal).
const CHROME_LOCALES = {
  en: ['en'], 'zh-CN': ['zh_CN'], ru: ['ru'], es: ['es'], ko: ['ko'], ja: ['ja'], pt: ['pt_BR', 'pt_PT'], fr: ['fr'], de: ['de'],
  ar: ['ar'], it: ['it'],
};

// Words that stay as they are in every language, wherever the English text has them.
const TOKENS = [
  /\bQNet\b/g, /\bSolana\b/g, /\b1DEV\b/g, /\bQNC\b/g, /\bSOL\b/g, /aiqnet\.io/g, /\bQNET_[A-Z_]+\b/g, /\bSPL\b/g,
  /\bLight\b/g, /\bSuper\b/g,
];

// The mobile app's terms (applications/qnet-mobile/src/i18n/locales), as stems every translation
// of an English text with the term must contain.
const GLOSSARY = {
  'recovery phrase': {
    'zh-CN': '恢复短语', ru: 'фраз', es: 'frase de recuperación', ko: '복구 문구', ja: 'リカバリーフレーズ', pt: 'frase de recuperação',
    fr: 'phrase de récupération', de: 'Wiederherstellungsphrase', ar: 'عبارة الاسترداد', it: 'frase di recupero',
  },
  'activation code': {
    'zh-CN': '激活码', ru: 'код', es: 'código de activación', ko: '활성화 코드', ja: 'アクティベーションコード', pt: 'código de ativação',
    fr: 'code d’activation', de: 'Aktivierungscode', ar: 'رمز التفعيل', it: 'codice di attivazione',
  },
  node: {
    'zh-CN': '节点', ru: 'нод', es: 'nodo', ko: '노드', ja: 'ノード', pt: 'nó', fr: 'nœud', de: 'Knoten', ar: 'عقد', it: 'nod',
  },
};

describe('i18n: languages', () => {
  it('are the mobile app\'s languages, each with a table, a native name and a Chrome locale', async () => {
    // the app keeps one table per language in src/i18n/locales and lists them in its picker (src/i18n/index.js)
    const mobileTables = (await readdir(path.join(WALLET, '../qnet-mobile/src/i18n/locales')))
      .filter((name) => name.endsWith('.js')).map((name) => name.slice(0, -3));
    const mobilePicker = [...(await read('../qnet-mobile/src/i18n/index.js')).matchAll(/\{ code: '([a-zA-Z-]+)'/g)].map((m) => m[1]);
    assert.ok(mobileTables.length > 1);
    assert.deepEqual([...mobilePicker].sort(), [...mobileTables].sort());
    assert.deepEqual([...SUPPORTED_LANGUAGES].sort(), [...mobileTables].sort());
    assert.equal(SUPPORTED_LANGUAGES[0], DEFAULT_LANGUAGE);
    assert.deepEqual(Object.keys(LANGUAGE_NAMES).sort(), [...SUPPORTED_LANGUAGES].sort());
    assert.deepEqual(Object.keys(CHROME_LOCALES).sort(), [...SUPPORTED_LANGUAGES].sort());
    assert.deepEqual([...RTL_LANGUAGES], ['ar']);
    const shipped = (await readdir(path.join(WALLET, 'dist/ui/i18n'))).sort();
    assert.deepEqual(shipped, ['index.js', ...SUPPORTED_LANGUAGES.map((code) => `${code}.js`)].sort());
  });

  it('the browser language picks the UI language, else none', () => {
    const cases = [
      ['en-US', 'en'], ['ru', 'ru'], ['ru-RU', 'ru'], ['pt-BR', 'pt'], ['pt_PT', 'pt'], ['zh-CN', 'zh-CN'], ['zh', 'zh-CN'],
      ['zh-Hans-SG', 'zh-CN'], ['zh-TW', null], ['zh-Hant', null], ['es-419', 'es'], ['ar-EG', 'ar'], ['DE-at', 'de'],
      ['nl', null], ['', null], [null, null], ['x'.repeat(65), null],
    ];
    for (const [tag, expected] of cases) assert.equal(languageForTag(tag), expected, String(tag));
  });
});

describe('i18n: tables', () => {
  it('every language has exactly the English keys, non-empty, with the same placeholders', () => {
    const keys = Object.keys(EN).sort();
    for (const [code, table] of Object.entries(TABLES)) {
      assert.ok(Object.isFrozen(table), `${code} is frozen`);
      assert.deepEqual(Object.keys(table).sort(), keys, `${code}: keys`);
      for (const key of keys) {
        const text = table[key];
        assert.equal(typeof text, 'string', `${code}.${key}`);
        assert.ok(text.length > 0 && text.length <= 2000, `${code}.${key}: length`);
        assert.equal(text, text.trim(), `${code}.${key}: surrounding whitespace`);
        assert.equal(placeholders(text), placeholders(EN[key]), `${code}.${key}: placeholders ${text}`);
        assert.ok(!/\$[A-Za-z_]\w*\$|\{[a-z]+\}|%s|undefined|TODO/.test(text), `${code}.${key}: stray placeholder syntax`);
        assert.ok(!/[\u0000-\u0008\u000b-\u001f‎‏‪-‮⁦-⁩]/.test(text), `${code}.${key}: control or bidi character`);
      }
    }
  });

  it('keeps the non-translatable tokens of the English text', () => {
    for (const [code, table] of Object.entries(TABLES)) {
      for (const [key, english] of Object.entries(EN)) {
        for (const token of TOKENS) {
          const want = english.match(token)?.length ?? 0;
          const got = table[key].match(token)?.length ?? 0;
          assert.ok(got >= Math.min(want, 1), `${code}.${key} lost ${token}: ${table[key]}`);
        }
      }
    }
  });

  it('uses the mobile app\'s terms for recovery phrase, activation code and node', () => {
    for (const [term, stems] of Object.entries(GLOSSARY)) {
      const english = Object.entries(EN).filter(([, text]) => new RegExp(`\\b${term}`, 'i').test(text));
      assert.ok(english.length > 0, term);
      for (const [code, stem] of Object.entries(stems)) {
        for (const [key] of english) {
          const text = TABLES[code][key].toLowerCase();
          assert.ok(text.includes(stem.toLowerCase()), `${code}.${key} should say "${stem}" for "${term}": ${TABLES[code][key]}`);
        }
      }
    }
  });

  // Owner, 06.10: after the burn the Activate tab keeps the code and one line to aiqnet.io/node, in every language.
  it('names aiqnet.io/node in the Activate tab\'s one line, in every language', () => {
    for (const code of SUPPORTED_LANGUAGES) {
      assert.ok(TABLES[code].activateManage.includes('aiqnet.io/node'), `${code}.activateManage: ${TABLES[code].activateManage}`);
    }
  });

  it('every worker error code has a text, and err_ keys name real codes', () => {
    for (const code of Object.keys(ERROR_MESSAGES)) assert.ok(Object.hasOwn(EN, `err_${code}`), `err_${code}`);
    for (const key of Object.keys(EN).filter((k) => k.startsWith('err_'))) {
      assert.ok(key === 'err_BACKOFF_wait' || Object.hasOwn(ERROR_MESSAGES, key.slice(4)), key);
    }
  });
});

describe('i18n: manifest strings', () => {
  it('every Chrome locale names and describes the extension within the store limits', async () => {
    const english = JSON.parse(await read('dist/_locales/en/messages.json'));
    const dirs = (await readdir(path.join(WALLET, 'dist/_locales'))).sort();
    assert.deepEqual(dirs, Object.values(CHROME_LOCALES).flat().sort());
    for (const dir of dirs) {
      const messages = JSON.parse(await read(`dist/_locales/${dir}/messages.json`));
      assert.deepEqual(Object.keys(messages).sort(), Object.keys(english).sort(), dir);
      for (const [key, entry] of Object.entries(messages)) {
        assert.deepEqual(Object.keys(entry).sort(), ['description', 'message'], `${dir}.${key}`);
        assert.equal(entry.description, english[key].description, `${dir}.${key}: the description is for translators`);
        assert.match(entry.message, /QNet/, `${dir}.${key}`);
      }
      assert.ok(messages.extName.message.length <= 45, `${dir}: name`);
      assert.ok(messages.extDescription.message.length <= 132, `${dir}: description`);
    }
  });
});

// ---------------------------------------------------------------- static scan

// Every string and template literal of a script with its offset (comments and regular expressions are
// skipped; a template's ${...} parts are scanned as code and shown as \u0000 in its text).
function literals(source) {
  const found = [];
  let pos = 0;
  let prev = '';
  const KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'new', 'delete', 'throw', 'instanceof', 'yield', 'await']);
  const regexAllowed = () => {
    if (prev === '' || prev === 'lit-op') return true;
    if (prev === 'lit') return false;
    if (/^[\w$]+$/.test(prev)) return KEYWORDS.has(prev);
    return ![')', ']', '}'].includes(prev);
  };
  function readString(quote) {
    let text = '';
    pos += 1;
    while (pos < source.length && source[pos] !== quote) {
      if (source[pos] === '\\') {
        text += source.slice(pos, pos + 2);
        pos += 2;
      } else {
        text += source[pos];
        pos += 1;
      }
    }
    pos += 1;
    return text;
  }
  function readRegex() {
    pos += 1;
    let inClass = false;
    while (pos < source.length) {
      const c = source[pos];
      if (c === '\\') pos += 2;
      else {
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        pos += 1;
      }
    }
    pos += 1;
    while (/[a-z]/.test(source[pos] ?? '')) pos += 1;
  }
  function readTemplate() {
    let text = '';
    pos += 1;
    while (pos < source.length) {
      const c = source[pos];
      if (c === '\\') {
        text += source.slice(pos, pos + 2);
        pos += 2;
      } else if (c === '`') {
        pos += 1;
        return text;
      } else if (c === '$' && source[pos + 1] === '{') {
        pos += 2;
        prev = '';
        code(true);
        text += '\u0000';
      } else {
        text += c;
        pos += 1;
      }
    }
    return text;
  }
  function code(untilBrace) {
    let depth = 0;
    while (pos < source.length) {
      const c = source[pos];
      if (c === '/' && source[pos + 1] === '/') {
        const end = source.indexOf('\n', pos);
        pos = end < 0 ? source.length : end;
      } else if (c === '/' && source[pos + 1] === '*') {
        const end = source.indexOf('*/', pos + 2);
        pos = end < 0 ? source.length : end + 2;
      } else if (c === '\'' || c === '"') {
        const start = pos;
        found.push({ start, end: 0, text: readString(c), template: false });
        found[found.length - 1].end = pos;
        prev = 'lit';
      } else if (c === '`') {
        const start = pos;
        const entry = { start, end: 0, text: '', template: true };
        found.push(entry);
        entry.text = readTemplate();
        entry.end = pos;
        prev = 'lit';
      } else if (c === '/' && regexAllowed()) {
        readRegex();
        prev = 'lit';
      } else if (/\s/.test(c)) {
        pos += 1;
      } else if (/[\w$]/.test(c)) {
        const match = /^[\w$]+/.exec(source.slice(pos, pos + 64));
        prev = match[0];
        pos += match[0].length;
      } else {
        if (c === '{') depth += 1;
        if (c === '}') {
          if (untilBrace && depth === 0) {
            pos += 1;
            return;
          }
          depth -= 1;
        }
        prev = c;
        pos += 1;
      }
    }
  }
  code(false);
  return found;
}

// Literals that never reach the screen as text, by what precedes them.
const HIDDEN_CONTEXT = [
  /\bt\(\s*$/, /className\s*[:=]\s*$/, /classList\.(?:add|remove|toggle|contains)\(\s*$/,
  /\blog\.(?:debug|info|warn|error)\([^()]*$/, /\b(?:import|from)\s*$/, /\bimport\(\s*$/,
  /(?:querySelector|querySelectorAll|getElementById|createElement|addEventListener|removeEventListener|setAttribute|getAttribute|removeAttribute|hasAttribute)\(\s*$/,
  /\bnew (?:Error|UiError|TypeError|RangeError)\(\s*$/, /\bcall\(\s*$/, /\bel\(\s*$/, /===?\s*$/, /!==?\s*$/,
  /\bthis\.name\s*=\s*$/,
];
// Attribute or option values that are never shown.
const HIDDEN_KEYS = /(?:^|[{,\s])(?:type|name|role|id|for|rel|href|src|action|kind|inputMode|inputmode|dir|lang|value|'data-[a-z-]+'|'aria-(?:live|pressed|selected|hidden|busy)'|autocomplete|spellcheck|autocapitalize|autocorrect|'data-gramm[a-z_]*'|'data-lt-active'|'data-enable-grammarly'|accessLevel)\s*:\s*$/;
// Shown on screen when they carry a letter.
const VISIBLE_CONTEXT = [/\btext\s*:\s*$/, /\.textContent\s*=\s*$/, /\bplaceholder\s*:\s*$/, /\btitle\s*[:=]\s*$/, /'aria-label'\s*:\s*$/, /\balt\s*:\s*$/];
// Non-translatable tokens a page may write as they are.
const ALLOWED = new Set(['QNC', 'SOL', '1DEV', 'QNet', 'Solana', 'DELETE', 'QNET_ACTIVATION_CODE', 'QNET_BURN_TX_HASH',
  'QNET_BURN_AMOUNT', 'QNET_WALLET_SEED', '0.0', '—', '…', '•', '+', '−', '',
  // KeyboardEvent.key names
  'Enter']);

function looksVisible(text) {
  const plain = text.replace(/\u0000/g, ' ').replace(/\\n/g, ' ');
  if (!/\p{L}{2,}/u.test(plain)) return false;
  // a camelCase identifier (a property or global name), not words
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(plain)) return false;
  return /\p{Lu}\p{Ll}/u.test(plain) || /\p{L}{2,}[ \t]+\p{L}{2,}/u.test(plain) || /[^\x00-\x7f]/.test(plain.replace(/[—…•−→←]/g, ''));
}

// A list of class names ('ap-mono ap-address'): hyphenated lowercase tokens only.
const CLASS_LIST = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?: [a-z][a-z0-9]*(?:-[a-z0-9]+)+)*$/;

function hardCoded(source, keys = new Set()) {
  const hits = [];
  for (const literal of literals(source)) {
    const before = source.slice(Math.max(0, literal.start - 80), literal.start);
    const after = source.slice(literal.end, literal.end + 3);
    const visibleSink = VISIBLE_CONTEXT.some((re) => re.test(before));
    if (ALLOWED.has(literal.text.trim())) continue;
    // a table key passed on to t(), or a class list, anywhere but straight into the page
    if (!visibleSink && (keys.has(literal.text) || CLASS_LIST.test(literal.text))) continue;
    if (/^\s*:/.test(after) && /[{,]\s*$/.test(before)) continue; // an object key
    if (HIDDEN_CONTEXT.some((re) => re.test(before))) continue;
    if (!visibleSink && HIDDEN_KEYS.test(before)) continue;
    if ((visibleSink && /\p{L}/u.test(literal.text.replace(/\u0000/g, ''))) || looksVisible(literal.text)) {
      hits.push(`${source.slice(0, literal.start).split('\n').length}: ${literal.text.slice(0, 60)}`);
    }
  }
  return hits;
}

describe('i18n: no text outside the tables', () => {
  it('the scanner finds text in the places pages write it', () => {
    const sample = [
      "el('p', { text: 'Hello' });", "node.textContent = 'x y';", "button('Send now', go);", "notice('warn', 'Be careful');",
      "t('ok'); el('div', { className: 'row actions' }); log.warn('not shown here', code); call('vault.status');",
      "const re = /it's [a-z]/; const s = 'Visible text';", 'const m = `Hi ${name}, welcome`;', "attrs: { 'aria-label': 'Close' }",
    ].join('\n');
    assert.deepEqual(hardCoded(sample).map((hit) => hit.replace(/^\d+: /, '')), ['Hello', 'x y', 'Send now', 'Be careful', 'Visible text', 'Hi \u0000, welcome', 'Close']);
  });

  it('dist/ui scripts and pages carry no user-visible text of their own', async () => {
    const files = (await readdir(path.join(WALLET, 'dist/ui'))).filter((name) => name.endsWith('.js'));
    assert.ok(files.includes('popup.js') && files.includes('approve.js') && files.includes('setup.js'));
    const keys = new Set(Object.keys(EN));
    for (const name of files) {
      assert.deepEqual(hardCoded(await read(`dist/ui/${name}`), keys), [], `dist/ui/${name}`);
    }
    for (const name of (await readdir(path.join(WALLET, 'dist/ui'))).filter((n) => n.endsWith('.html'))) {
      const html = await read(`dist/ui/${name}`);
      assert.match(html, /<title>QNet Wallet<\/title>/, name);
      const text = html.replace(/<title>[^<]*<\/title>/, '').replace(/<[^>]+>/g, '').trim();
      assert.equal(text, '', `${name} has text outside the scripts`);
    }
  });

  it('every key the pages ask for exists, and none is unused', async () => {
    const source = (await Promise.all(['popup.js', 'setup.js', 'approve.js', 'kit.js'].map((name) => read(`dist/ui/${name}`)))).join('\n');
    const literal = new Set([...source.matchAll(/'([A-Za-z0-9_@]+)'/g)].map((m) => m[1]));
    for (const [, key] of source.matchAll(/\bt\('([^']+)'/g)) assert.ok(Object.hasOwn(EN, key), `missing ${key}`);
    const families = [...source.matchAll(/\bt\(`([A-Za-z_]+?_)\$\{/g)].map((m) => m[1]);
    assert.ok(families.length >= 5, 'template keys are collected');
    for (const key of Object.keys(EN)) {
      if (key.startsWith('err_')) continue;
      assert.ok(literal.has(key) || families.some((prefix) => key.startsWith(prefix)), `${key} is unused`);
    }
  });
});
