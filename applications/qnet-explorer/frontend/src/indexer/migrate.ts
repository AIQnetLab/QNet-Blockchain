import * as fs from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';
import { log } from './log';

// Ordered SQL files in migrations/, each applied as one transaction and recorded in schema_migrations.
// A database that predates the ledger (tables exist, ledger empty) is baselined: the files that built it
// are recorded without being re-run.
const BASELINE = ['001_init.sql', '002_batch_transfers.sql'];

export async function runMigrations(pool: Pool, dir: string): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  if (applied.size === 0) {
    const legacy = await pool.query<{ ok: boolean }>(`SELECT to_regclass('public.transactions') IS NOT NULL AS ok`);
    if (legacy.rows[0]?.ok) {
      for (const name of BASELINE) {
        await pool.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
        applied.add(name);
      }
      log.info('MIGRATE', 'baselined', { files: BASELINE.length });
    }
  }
  const files = fs.readdirSync(dir).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, name), 'utf-8');
    const client = await pool.connect();
    const t0 = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      log.info('MIGRATE', 'applied', { name, ms: Date.now() - t0 });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
