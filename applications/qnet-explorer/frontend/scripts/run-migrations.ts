// NOTE: standalone manual/CLI migration helper — NOT the runtime migration path.
// At server startup migrations run via src/instrumentation.ts register().
import * as fs from 'fs';
import * as path from 'path';
import { getDbPool } from '../lib/db';

async function runMigrations() {
  try {
    console.log('[Migration] Starting migrations...');
    
    const pool = getDbPool();
    const client = await pool.connect();
    
    try {
      const migrationPath = path.join(process.cwd(), 'migrations', '001_init.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
      
      // Split by semicolons and execute each statement
      const statements = migrationSql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));
      
      for (const statement of statements) {
        if (statement.length > 0) {
          await client.query(statement);
        }
      }
      
      console.log('[Migration] Migrations applied successfully');
    } finally {
      client.release();
    }
    
    await pool.end();
  } catch (err) {
    console.error('[Migration] Failed to run migrations:', err);
    process.exit(1);
  }
}

runMigrations();

