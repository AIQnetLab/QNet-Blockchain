// Runs once per server process. The web tier only reads: it opens the head hub (one LISTEN connection
// per process) so the first request already finds a warm snapshot. Schema and indexing belong to the
// qnet-indexer process.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { headHub } = await import('./server/head-hub');
    headHub.start();
    console.log('[INFO][WEB] head_hub_started');
  } catch (err) {
    console.error(`[ERR][WEB] head_hub_start_failed err=${err instanceof Error ? err.message : String(err)}`);
  }
}
