/**
 * Every link the system hands to the app (a QNet Link request, a transfer link) waits in the platform's link inbox from
 * the moment it arrives until the wallet screen is done with it: Android's MainActivity (LinkInbox.kt) and iOS's scene
 * (LinkInbox.swift) put it there whatever state the app is in, before its JS can hear anything, and keep it on the
 * device for a new process. So a link is never lost to a screen that was not up, a view made anew in a running app, a
 * JS that started again, the lock screen or a process end, and never applied twice. This is the one way links come into
 * the app's JS. The screen gets them one at a time, in the order they came.
 */
import { AppState, Linking, NativeModules } from 'react-native';

// The screen that takes links: { onLink, handed, held }. `handed`: the inbox ids it was given, kept after it is done
// with them too, so a look that read the inbox just before never hands one again (an id is never reused). `held`: the
// id it was given and is not done with; the next link waits in the inbox until then.
let watcher = null;

const inbox = () => NativeModules.QNetLinkInbox || null;

// Hands the watching screen the oldest waiting link it was not given yet, while it holds none. `afterRelease`: the look
// the screen's letting go of a link starts, so the link it hands arrived while that one was held (`waited`).
async function look(afterRelease = false) {
  const w = watcher;
  const box = inbox();
  if (!w || w.held !== null || !box || typeof box.pending !== 'function') return;
  let waiting = [];
  try { waiting = await box.pending(); } catch (_) { waiting = []; }
  if (watcher !== w || w.held !== null || !Array.isArray(waiting)) return;
  const e = waiting.find((x) => x && typeof x.url === 'string' && Number.isSafeInteger(x.id) && !w.handed.has(x.id));
  if (!e) return;
  w.handed.add(e.id);
  w.held = e.id;
  let released = false;
  w.onLink(e.url, () => {
    if (released) return;
    released = true;
    try { box.done(e.id); } catch (_) { /* the inbox drops it with the process */ }
    if (w.held === e.id) w.held = null;
    look(true);
  }, { waited: afterRelease });
}

/**
 * A line of the link path in the platform's log, in every build (the JS logger writes only in development): `event`
 * request_shown | answer_delivered | answer_not_delivered | transfer_form_opened, `fields` its codes and numbers
 * (intent, offer, outcome, status, ms, token). The native inbox writes only those keys, so no session, key or address
 * is logged.
 */
export function noteLink(event, fields = {}) {
  const box = inbox();
  if (!box || typeof box.note !== 'function') return;
  try { box.note(event, fields); } catch (_) { /* a log line never holds the link path up */ }
}

/**
 * `onLink(url, done, { waited })` hears the oldest waiting link, and the next one once `done()` was called: once the
 * screen opened it, decided it or refused it; until then it waits, and the next screen hears it again. `waited`: it
 * arrived while the screen held an earlier link. Returns the function that stops it. The platform's link event and the
 * app's return to the front only say when to look again.
 */
export function watchLinks(onLink) {
  const w = { onLink, handed: new Set(), held: null };
  watcher = w;
  const subs = [
    Linking.addEventListener('url', () => { look(); }),
    AppState.addEventListener('change', (state) => { if (state === 'active') look(); }),
  ];
  look();
  return () => {
    if (watcher === w) watcher = null;
    subs.forEach((s) => s.remove());
  };
}
