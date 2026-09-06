import * as path from 'path';
import { Pool, Client } from 'pg';
import { NodeClient } from './node-client';
import { Writer } from './writer';
import { Chain } from './chain';
import { runMigrations } from './migrate';
import { rebuildStatsIfNeeded, auditStats } from './stats';
import { log, errText } from './log';

// qnet-indexer: the explorer's only writer. Runs beside the web tier under PM2; the web tier only reads
// and listens for the head NOTIFY this process emits.

function pool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const p = new Pool({ connectionString: url, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false });
  // The index is rebuildable from the chain: asynchronous commit trades a crash-window of writes for
  // throughput; every commit is still atomic.
  p.on('connect', c => { void c.query("SET synchronous_commit = 'off'"); });
  p.on('error', e => log.err('DB', 'pool_error', { err: errText(e) }));
  return p;
}

// A session-scoped advisory lock: a second indexer against the same database exits instead of
// interleaving writes. Held by a dedicated connection for the life of the process.
async function claimWriter(): Promise<Client> {
  const holder = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false });
  await holder.connect();
  const r = await holder.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', ['qnet-explorer-indexer']);
  if (!r.rows[0]?.ok) {
    await holder.end().catch(() => undefined);
    throw new Error('another indexer holds the writer lock');
  }
  holder.on('error', e => { log.err('DB', 'writer_lock_lost', { err: errText(e) }); process.exit(1); });
  return holder;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const lock = await claimWriter();
  const db = pool();
  await runMigrations(db, path.join(process.cwd(), 'migrations'));
  await rebuildStatsIfNeeded(db);
  const node = new NodeClient();
  const chain = new Chain(node, new Writer(db), db);
  await chain.start();

  const audit = setInterval(() => void auditStats(db).catch(e => log.err('STATS', 'audit_failed', { err: errText(e) })), 24 * 3600 * 1000);
  const status = setInterval(() => {
    const s = chain.status();
    log.info('INDEXER', 'status', { head: s.head, prefix: s.prefix, node_height: s.nodeHeight, lag: s.nodeHeight - s.prefix, ws: s.wsConnected, heal_pending: s.healPending, halted: s.halted ?? undefined });
  }, 60_000);

  const shutdown = async (sig: string) => {
    log.info('INDEXER', 'shutdown', { signal: sig });
    clearInterval(audit); clearInterval(status);
    await chain.stop();
    await db.end().catch(() => undefined);
    await lock.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', e => log.err('INDEXER', 'unhandled_rejection', { err: errText(e) }));
}

main().catch(e => {
  log.err('INDEXER', 'fatal', { err: errText(e) });
  process.exit(1);
});
