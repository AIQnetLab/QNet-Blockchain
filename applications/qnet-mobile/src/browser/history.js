/**
 * The in-app browser's recent pages: on this phone only, at most 20, cleared by "Clear browsing data" and with
 * the wallet (WalletManager.WALLET_SCOPED_KEYS). A page is kept without its query and fragment, which is
 * where sites put session tokens.
 *
 * Every read and write runs after the ones asked for before it (several tabs finish loading at once, and a clear may
 * come while a page is being remembered), so no page overwrites another and nothing asked for before a clear outlives
 * it: an answer of an operation asked for before a clear is the empty list.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseWebUrl, originOfParsed } from './url';

export const HISTORY_KEY = 'qnet_browser_history';
export const HISTORY_MAX = 20;
const TITLE_MAX = 80;

/** The form a page is remembered in: https origin + path, or null for anything else. */
export function historyUrl(url) {
  const p = parseWebUrl(url);
  if (!p || p.scheme !== 'https') return null;
  return `${originOfParsed(p)}${p.path}`;
}

function clean(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || historyUrl(e.url) !== e.url || out.some((x) => x.url === e.url)) continue;
    out.push({ url: e.url, title: typeof e.title === 'string' ? e.title.slice(0, TITLE_MAX) : '', at: Number(e.at) || 0 });
    if (out.length >= HISTORY_MAX) break;
  }
  return out;
}

async function readList() {
  try {
    return clean(JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]'));
  } catch (_) {
    return [];
  }
}

let chain = Promise.resolve();
let clears = 0; // how many clears were asked for

// Runs `task` once every operation asked for before it has ended; `task(stale)` tells whether a clear was asked for
// since this operation was. Its answer is the empty list when one was.
function queued(task) {
  const at = clears;
  const stale = () => at !== clears;
  const run = chain.then(() => task(stale));
  chain = run.catch(() => {});
  return run.then((list) => (stale() ? [] : list));
}

export function loadHistory() {
  return queued(() => readList());
}

/** Puts a visited page first; returns the new list. */
export function rememberPage(url, title, now = Date.now()) {
  return queued(async (stale) => {
    const u = historyUrl(url);
    const list = await readList();
    // A clear asked for after this page was: the page goes with it, so nothing is written.
    if (!u || stale()) return list;
    const next = clean([{ url: u, title: String(title || ''), at: now }, ...list.filter((e) => e.url !== u)]);
    try { await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch (_) { /* kept in memory only */ }
    return next;
  });
}

export function clearHistory() {
  clears += 1;
  return queued(async () => {
    try { await AsyncStorage.removeItem(HISTORY_KEY); } catch (_) { /* nothing stored */ }
    return [];
  });
}
