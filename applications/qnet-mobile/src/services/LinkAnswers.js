/**
 * The QNet Link answers the user decided that are still being made or delivered to aiqnet.io (screens/QNetLinkScreen),
 * wherever the app is: their request's sheet may have given way to the next link or been closed meanwhile, and the app
 * says so outside it (components/AnswerAway).
 */
import { holdForUser } from '../utils/userHold';

// One entry ({ id }: the link's session id) per answer on its way, and who follows them.
const away = [];
const watchers = new Set();
const changed = () => { watchers.forEach((fn) => fn()); };

/**
 * Carries `work` (the promise of an answer the user decided, made and then delivered) to its end: until it settles it
 * holds the network for what the user waits on (utils/userHold) and counts as on its way under session `id`. Returns
 * `work`.
 */
export function carryAnswer(id, work) {
  const entry = { id };
  const release = holdForUser();
  away.push(entry);
  changed();
  const end = () => {
    release();
    away.splice(away.indexOf(entry), 1);
    changed();
  };
  Promise.resolve(work).then(end, end);
  return work;
}

/** The session ids of the answers on their way, one per answer. */
export const answersAway = () => away.map((e) => e.id);

/** Calls `fn()` each time an answer starts or ends its way; returns the function that stops it. */
export function watchAnswersAway(fn) {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}
