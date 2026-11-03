import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';

// The indexer unit's ExecStartPre (deployment/deploy-aiqnet.sh) runs `main.js --migrate-only`: it must commit every
// migration, free the writer lock and exit 0 without following the chain, or the site, ordered after the unit, would
// start on tables that are not there yet. Against a real database, empty or not, when TEST_DATABASE_URL names one.
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const FRONTEND = path.join(__dirname, '..', '..');

test('--migrate-only commits every migration, frees the writer lock and exits 0 without following the chain', { skip: !DATABASE_URL }, async () => {
  // A node address nothing answers: an entry that went on to follow the chain would never exit by itself.
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'main.js'), '--migrate-only'], {
    cwd: FRONTEND,
    env: { ...process.env, DATABASE_URL, QNET_API_URLS: 'http://127.0.0.1:9', INDEXER_LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 30_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0, output);
  assert.match(output, /\[INFO\]\[MIGRATE\] migrate_only_done/);
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const applied = (await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    const files = fs.readdirSync(path.join(FRONTEND, 'migrations')).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    assert.deepEqual(applied, files);
    const lock = await db.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', ['qnet-explorer-indexer']);
    assert.equal(lock.rows[0].ok, true, 'the writer lock is free for the indexer the unit starts next');
  } finally {
    await db.end();
  }
});
