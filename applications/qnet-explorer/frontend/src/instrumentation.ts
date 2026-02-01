// Next.js instrumentation file - runs once on server startup
export async function register() {
  console.log('[Instrumentation] register() called');
  console.log('[Instrumentation] NEXT_RUNTIME:', process.env.NEXT_RUNTIME);
  
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Only run in Node.js runtime (not Edge)
    console.log('[Instrumentation] Running in Node.js runtime, initializing...');
    try {
      // Run migrations first
      console.log('[Instrumentation] Importing db module...');
      const { getDbPool } = await import('../lib/db');
      console.log('[Instrumentation] Getting database pool...');
      const pool = getDbPool();
      console.log('[Instrumentation] Connecting to database...');
      const client = await pool.connect();
      
      try {
        const fs = await import('fs');
        const path = await import('path');
        
        // Prevent path traversal attacks
        const migrationsDir = path.join(process.cwd(), 'migrations');
        const migrationPath = path.join(migrationsDir, '001_init.sql');
        
        // Validate path is within migrations directory
        const resolvedPath = path.resolve(migrationPath);
        const resolvedDir = path.resolve(migrationsDir);
        if (!resolvedPath.startsWith(resolvedDir)) {
          throw new Error('Invalid migration path: path traversal detected');
        }
        
        // Limit file size to prevent DoS (max 1MB)
        const stats = fs.statSync(migrationPath);
        if (stats.size > 1024 * 1024) {
          throw new Error('Migration file too large (max 1MB)');
        }
        
        if (fs.existsSync(migrationPath)) {
          const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
          
          // Limit SQL statement length to prevent DoS
          if (migrationSql.length > 10 * 1024 * 1024) {
            throw new Error('Migration SQL too large (max 10MB)');
          }
          
          // Security: Only allow specific SQL keywords to prevent injection
          const allowedKeywords = [
            'CREATE TABLE', 'CREATE INDEX', 'CREATE OR REPLACE FUNCTION',
            'CREATE TRIGGER', 'INSERT INTO', 'ALTER TABLE', 'GRANT', 'REVOKE'
          ];
          
          // Execute migration (skip user creation statements and validate)
          const statements = migrationSql
            .split(';')
            .map(s => s.trim())
            .filter(s => {
              if (s.length === 0 || s.startsWith('--')) return false;
              if (s.includes('CREATE USER')) return false; // Skip user creation
              
              // Security check: ensure statement starts with allowed keyword
              const upperStatement = s.toUpperCase();
              const isAllowed = allowedKeywords.some(keyword => 
                upperStatement.startsWith(keyword)
              );
              
              if (!isAllowed) {
                console.warn('[Migration] Skipping potentially unsafe statement:', s.substring(0, 50));
                return false;
              }
              
              return true;
            });
          
          for (const statement of statements) {
            if (statement.length > 0) {
              try {
                await client.query(statement);
              } catch (err: unknown) {
                // Ignore "already exists" errors
                const error = err as { message?: string; code?: string };
                if (!error.message?.includes('already exists') && 
                    !error.message?.includes('duplicate') &&
                    !error.code?.startsWith('42')) { // PostgreSQL error codes starting with 42 are usually "already exists"
                  console.warn('[Migration] Warning:', error.message);
                }
              }
            }
          }
          console.log('[Migration] Database schema initialized');
        }
      } finally {
        client.release();
      }
      
      // Start sync service
      console.log('[Instrumentation] Importing sync-service module...');
      const { startSyncService, getSyncServiceStatus } = await import('../lib/sync-service');
      console.log('[Instrumentation] Starting sync service...');
      startSyncService();
      console.log('[Instrumentation] Sync service start() called');
      
      // Verify it started
      setTimeout(async () => {
        try {
          const status = await getSyncServiceStatus();
          if (!status.isRunning) {
            console.warn('[Instrumentation] Sync service did not start, retrying...');
            startSyncService();
          } else {
            console.log('[Instrumentation] ✅ Sync service confirmed running');
          }
        } catch (err) {
          console.error('[Instrumentation] Failed to verify sync service:', err);
        }
      }, 2000);
    } catch (err) {
      console.error('[Instrumentation] Failed to initialize:', err);
      if (err instanceof Error) {
        console.error('[Instrumentation] Error message:', err.message);
        console.error('[Instrumentation] Error stack:', err.stack);
      }
      // Don't exit - allow app to start even if DB is not available
    }
  } else {
    console.log('[Instrumentation] Skipping - not in Node.js runtime');
  }
}

