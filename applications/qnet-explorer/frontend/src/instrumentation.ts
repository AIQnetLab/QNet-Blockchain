// Runs once per server process. The web tier only reads: it opens the head hub (one LISTEN connection
// per process) so the first request already finds a warm snapshot. Schema and indexing belong to the
// qnet-indexer process.
export async function register() {
  // The import stays inside the runtime check, not after an early return: the bundler resolves
  // NEXT_RUNTIME at compile time and skips a dead branch, but it cannot skip code that merely follows
  // a return — so the edge compile of this file would pull `pg` in and fail on its `fs` require.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { headHub } = await import('./server/head-hub');
      headHub.start();
      console.log('[INFO][WEB] head_hub_started');
    } catch (err) {
      console.error(`[ERR][WEB] head_hub_start_failed err=${err instanceof Error ? err.message : String(err)}`);
    }
    // The balance check's light client walks to the certified head in the background, from where its store left off, so
    // the first Verify Balance after a restart finds the newest checkpoint verified. LIGHT_FOLLOW=0 turns it off.
    if (process.env.LIGHT_FOLLOW !== '0' && process.env.NEXT_PHASE !== 'phase-production-build') {
      try {
        const { sharedLightClient } = await import('./server/light/balance-proof');
        sharedLightClient().follow();
        console.log('[INFO][WEB] light_follow_started');
      } catch (err) {
        console.error(`[ERR][WEB] light_follow_start_failed err=${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
