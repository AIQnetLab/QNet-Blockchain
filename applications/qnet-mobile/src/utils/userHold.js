// While a user action runs, the background verification starts no new download (docs: mobile-wallet "Requests from the
// open app"); one hold lasts at most USER_HOLD_MAX_MS. No react and no app logger here: the extension's crypto bundle
// compiles this module with the light client.

export const USER_HOLD_MAX_MS = 60_000;

let holds = 0;
let waiting = [];

/** Holds the background downloads back until the returned release runs (once), or USER_HOLD_MAX_MS passes. */
export function holdForUser() {
  let timer = null;
  let held = true;
  const release = (expired = false) => {
    if (!held) return;
    held = false;
    clearTimeout(timer);
    if (expired === true) console.warn(`[WARN][NET] user_hold_expired held_ms=${USER_HOLD_MAX_MS}`);
    holds -= 1;
    if (holds > 0) return;
    const go = waiting;
    waiting = [];
    go.forEach((resolve) => resolve());
  };
  holds += 1;
  timer = setTimeout(() => release(true), USER_HOLD_MAX_MS);
  return () => release(false);
}

/** Resolves once no user action holds the network: at once when none does. A background download awaits it first. */
export function afterUserActions() {
  if (holds === 0) return Promise.resolve();
  return new Promise((resolve) => { waiting.push(resolve); });
}
