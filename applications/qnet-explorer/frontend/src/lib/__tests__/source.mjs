// The site's source as a test reads it: `read` with LF line ends, `code` the same without comments.

import { readFileSync } from 'node:fs';

export const SRC = new URL('../../', import.meta.url);
export const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
export const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
