// The site's source as a test reads it: `read` with LF line ends, `code` the same without comments.

import { readFileSync, readdirSync } from 'node:fs';

export const SRC = new URL('../../', import.meta.url);
export const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
export const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
// A file elsewhere in the repository (a document, another application's source), path from the repository's root.
export const REPO = new URL('../../../../../../', import.meta.url);
export const repo = (path) => readFileSync(new URL(path, REPO), 'utf8').replace(/\r\n/g, '\n');
// Every TypeScript source of the site, as paths under src/, the tests left out.
export const sourceFiles = () => readdirSync(SRC, { recursive: true }).map((n) => n.replace(/\\/g, '/'))
  .filter((n) => /\.(ts|tsx)$/.test(n) && !n.startsWith('lib/__tests__/'));
// A stylesheet's rules as [selector, body], those inside a media query and a keyframes' steps included.
export const cssRules = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
// Every stylesheet of the site (src/styles, the root layout imports each), one text.
export const allSheets = () => readdirSync(new URL('styles/', SRC)).filter((n) => n.endsWith('.css')).map((n) => read(`styles/${n}`)).join('\n');
