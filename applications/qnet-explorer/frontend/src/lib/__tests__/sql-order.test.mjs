// SQL that reads a number as text must not order by that text: in ORDER BY a bare name means the output column first,
// so `SELECT height::text ... ORDER BY height DESC` sorts '999999' above '3508200' (the explorer head read 999,999 after
// every indexer restart). Every query of the indexer and the site is scanned: an ORDER BY item that names a text
// output column must be qualified (`blocks.height`) or the output renamed. Run: npm run test:wallet
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const FRONTEND = new URL('../../../', import.meta.url);
const ROOTS = ['src/indexer', 'src/server', 'src/app', 'src/lib', 'lib', 'scripts'];

function files(rel) {
  const out = [];
  const walk = (r) => {
    for (const name of readdirSync(new URL(`${r}/`, FRONTEND))) {
      const path = `${r}/${name}`;
      if (name === '__tests__' || name === 'node_modules') continue;
      if (statSync(new URL(path, FRONTEND)).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
    }
  };
  walk(rel);
  return out;
}

// The string literals of a source that hold an ORDER BY.
function queries(text) {
  const literals = text.match(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/gs) ?? [];
  return literals.filter((s) => /\border\s+by\b/i.test(s));
}

/** The ORDER BY items of `sql` that name a column the query outputs as text. */
export function textOrdered(sql) {
  const textOut = new Set();
  for (const m of sql.matchAll(/::\s*text\s+as\s+([a-z_][a-z0-9_]*)/gi)) textOut.add(m[1].toLowerCase());
  for (const m of sql.matchAll(/(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*::\s*text\b(?!\s+as\b)/gi)) textOut.add(m[1].toLowerCase());
  const bad = [];
  for (const m of sql.matchAll(/\border\s+by\s+([\s\S]*?)(?=\blimit\b|\boffset\b|\)|`|$)/gi)) {
    for (const item of m[1].split(',')) {
      const name = /^\s*([a-z_][a-z0-9_]*)\s*(?:asc|desc|collate|nulls|$)/i.exec(item)?.[1]?.toLowerCase();
      if (name && textOut.has(name)) bad.push(name);
    }
  }
  return bad;
}

test('the check catches a text-ordered column and passes a qualified one', () => {
  assert.deepEqual(textOrdered('SELECT height::text, hash FROM blocks ORDER BY height DESC LIMIT 1'), ['height']);
  assert.deepEqual(textOrdered('SELECT block::text AS block, data FROM transactions ORDER BY block DESC, tx_index DESC LIMIT 4'), ['block']);
  assert.deepEqual(textOrdered("SELECT height::text, reason FROM (SELECT height, 'x' AS reason FROM blocks) c ORDER BY height DESC LIMIT $2"), ['height']);
  assert.deepEqual(textOrdered('SELECT count(*)::text AS c FROM t GROUP BY k ORDER BY c'), ['c']);
  assert.deepEqual(textOrdered('SELECT height::text, hash FROM blocks ORDER BY blocks.height DESC LIMIT 1'), []);
  assert.deepEqual(textOrdered("SELECT height::text, reason FROM (SELECT height FROM blocks) c ORDER BY c.height DESC LIMIT $2"), []);
  assert.deepEqual(textOrdered('SELECT g.h::text AS h FROM generate_series($1::bigint, $2::bigint) g(h) ORDER BY g.h'), []);
  assert.deepEqual(textOrdered('SELECT hash, block, amount::text AS amount FROM transactions ORDER BY block DESC, tx_index DESC'), []);
});

test('no query of the indexer or the site orders by a number read as text', () => {
  const found = [];
  let scanned = 0;
  for (const root of ROOTS) {
    for (const path of files(root)) {
      for (const sql of queries(readFileSync(new URL(path, FRONTEND), 'utf8'))) {
        scanned += 1;
        for (const name of textOrdered(sql)) found.push(`${path}: ORDER BY ${name} (${sql.replace(/\s+/g, ' ').slice(0, 120)})`);
      }
    }
  }
  assert.ok(scanned >= 20, `${scanned} queries with ORDER BY`);
  assert.deepEqual(found, []);
});
