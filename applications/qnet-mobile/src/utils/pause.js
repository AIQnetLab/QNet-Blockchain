// The app's one wait: resolves after `ms`. Callers that are tested take it as an injectable `sleep`. It imports
// nothing: the extension's crypto bundle compiles it with the light client.
export const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The back-offs under way of the retries that wait for aiqnet.io to answer (retryPause), and the wakes so far.
const backoffs = new Set();
let wakes = 0;

/** pause(ms) that wakeRetries() ends at once: a retry's back-off, with nothing to wait for once the network is back. */
export const retryPause = (ms) => new Promise((resolve) => {
  const end = () => {
    clearTimeout(timer);
    backoffs.delete(end);
    resolve();
  };
  const timer = setTimeout(end, ms);
  backoffs.add(end);
});

/** Ends every retryPause under way, so its retry tries again now (services/NetworkWake). */
export function wakeRetries() {
  wakes += 1;
  [...backoffs].forEach((end) => end());
}

/**
 * The back-off of one retry loop: `first` ms, doubled after each pause up to `max`. A wake (wakeRetries) while a try or
 * a pause runs starts it again from `first`, so a try that fails again right after the network came back never waits
 * the long pause it had reached. `trying()` as each try starts; `nextMs()` the pause that would follow; `pause()` waits it
 * (`sleep`, retryPause by default).
 */
export function retryBackoff(first, max, sleep = retryPause) {
  let wait = first;
  let seen = wakes;
  const woken = () => wakes !== seen;
  return {
    trying() { seen = wakes; },
    nextMs: () => (woken() ? first : wait),
    async pause() {
      if (woken()) wait = first;
      seen = wakes;
      await sleep(wait);
      wait = woken() ? first : Math.min(wait * 2, max);
    },
  };
}
