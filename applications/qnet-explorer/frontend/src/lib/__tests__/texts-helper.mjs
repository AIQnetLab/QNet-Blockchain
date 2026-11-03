// The English catalog and its translator, as the tests read the site's words: TEXTS by key, EN for the functions that
// take the page's translator (src/lib/texts.ts translator), `english` for a source file read with its catalog lookups
// written out in English, so a test can pin the words a page shows, and `pageWords` for a page's text as a reader sees
// it in English.

import TEXTS from '../../i18n/locales/en.ts';
import { translator } from '../texts.ts';
import { code, read } from './source.mjs';

export { TEXTS };
export const EN = translator('en', TEXTS);

// Whether a piece of source shows the text of `call`, a key in quotes or an expression of keys: through t (a string)
// or say (the text a page shows, lib/rich.tsx).
export const shows = (src, call) => src.includes(`t(${call})`) || src.includes(`say(${call})`);

const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// A file without comments, each t('key') or say('key') as its English text: an attribute's value in double quotes, a
// child as text, anything else as a string literal. A lookup with values or a sentence with elements (rich) stays as
// written.
export function english(path) {
  return code(path)
    .replace(/=\{(?:t|say)\('([a-z0-9_]+)'\)\}/g, (_, k) => `="${TEXTS[k]}"`)
    .replace(/\{(?:t|say)\('([a-z0-9_]+)'\)\}/g, (_, k) => TEXTS[k])
    .replace(/\b(?:t|say)\('([a-z0-9_]+)'\)/g, (_, k) => quote(TEXTS[k]));
}

// The index of the bracket that closes the one opened just before `from`.
function closing(src, from) {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

// The top-level `name: value` pairs of an object literal's body.
function pairs(body) {
  const out = {};
  let depth = 0;
  let start = 0;
  const add = (part) => {
    const m = /^\s*(\w+)\s*:\s*([\s\S]*?)\s*$/.exec(part);
    if (m) out[m[1]] = m[2];
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      add(body.slice(start, i));
      start = i + 1;
    }
  }
  add(body.slice(start));
  return out;
}

// Every t('key'), say('key') and rich('key', { slot: … }) of a piece of source as the key's English, a slot filled with
// its element's own words where they are written there, else left as {slot}.
function expand(src) {
  for (;;) {
    const m = /\b(t|say|rich)\('([a-z0-9_]+)'/.exec(src);
    if (!m) return src;
    const open = src.indexOf('(', m.index);
    let start = m.index;
    let end = closing(src, open + 1) + 1;
    let text = TEXTS[m[2]] ?? m[2];
    if (m[1] === 'rich') {
      const args = src.slice(open + 1, end - 1);
      const brace = args.indexOf('{');
      if (brace >= 0) {
        const slots = pairs(args.slice(brace + 1, closing(args, brace + 1)));
        text = text.replace(/\{(\w+)\}/g, (whole, name) => (name in slots ? ` ${expand(slots[name]).replace(/<[^>]*>/g, ' ').replace(/[{}]/g, '')} ` : whole));
      }
    }
    if (src[start - 1] === '{' && src[end] === '}') {
      start -= 1;
      end += 1;
    }
    src = src.slice(0, start) + text + src.slice(end);
  }
}

// A page's text as a reader sees it in English: its catalog lookups written out, tags dropped, entities and whitespace
// folded.
export function pageWords(path) {
  return expand(read(path)).replace(/<[^>]*>/g, ' ').replace(/&apos;/g, "'").replace(/\s+/g, ' ');
}
