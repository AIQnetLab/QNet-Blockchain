/**
 * The in-app browser's tabs (browser/BrowserScreen): at most MAX_TABS, in memory only, like the rest of the browsing
 * session (nothing of a tab is stored). Pure state changes; each tab's WebView and page session live in the screen.
 *
 * State: { tabs, active (the id of the tab in front) }. A tab: { id, source ({ uri } once a page was opened in it, else
 * null: no WebView yet), home (its start page is shown), webKey (its WebView's key: a new key is a new WebView),
 * wipeKey (the webKey of the WebView that started the browsing session, when this tab's did), lost (its WebView's
 * render process died while the tab was behind: it gets a new WebView when it comes forward), nav (what the WebView
 * last reported of the document on screen), pending (the address the tab is loading: one the user opened, or a top-frame
 * navigation the policy let through, a tapped link above all; null once a navigation-state event says what is on
 * screen), progress }.
 */

// Every open tab keeps its page loaded (nothing is discarded in the background), so the cap bounds the memory the
// browser can hold beside the wallet and the light node on a small phone; it also keeps the count a single digit.
export const MAX_TABS = 8;

export const EMPTY_NAV = Object.freeze({ url: '', title: '', canGoBack: false, canGoForward: false, loading: false });

const freeze = (tabs, active) => Object.freeze({ tabs: Object.freeze(tabs), active });

export function newTab(id) {
  return Object.freeze({ id, source: null, home: true, webKey: 1, wipeKey: null, lost: false, nav: EMPTY_NAV, pending: null, progress: 0 });
}

/** One tab on the start page, in front. */
export const createTabs = (id) => freeze([newTab(id)], id);

export const findTab = (state, id) => state.tabs.find((tab) => tab.id === id) || null;

/** Whether the tab has a page (and so a WebView). */
export const holdsPage = (tab) => !!tab && tab.source !== null;

export const canAddTab = (state) => state.tabs.length < MAX_TABS;

/** A new tab on the start page, in front; the same state when MAX_TABS are open. */
export function addTab(state, id) {
  if (!canAddTab(state) || findTab(state, id)) return state;
  return freeze([...state.tabs, newTab(id)], id);
}

export function selectTab(state, id) {
  return findTab(state, id) && state.active !== id ? freeze(state.tabs, id) : state;
}

/**
 * Closes tab `id`. When it was in front, the next tab comes forward (the one before it when it was the last); closing
 * the only tab leaves a fresh one (`freshId`) on the start page.
 */
export function closeTab(state, id, freshId) {
  const i = state.tabs.findIndex((tab) => tab.id === id);
  if (i < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) return createTabs(freshId);
  return freeze(tabs, state.active === id ? tabs[Math.min(i, tabs.length - 1)].id : state.active);
}

/** Every tab closes; a fresh one (`freshId`) on the start page is left. */
export const closeAllTabs = (freshId) => createTabs(freshId);

/** Tab `id` with `patch` applied (an object of fields, or a function of the tab); the same state when nothing changed. */
export function updateTab(state, id, patch) {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab;
    const next = typeof patch === 'function' ? patch(tab) : { ...tab, ...patch };
    if (next === tab) return tab;
    changed = true;
    return Object.freeze(next);
  });
  return changed ? freeze(tabs, state.active) : state;
}

/**
 * Tab `id` opens `uri` (in the WebView it has, or in its first one), its address shown at once (`pending`). The first
 * page opened while no tab holds a page starts a new browsing session, and the WebView it opens in is the one that
 * starts it (webViewEvents.incognitoFor); a page opened while another tab holds one joins that session and clears
 * nothing of it.
 *
 * React Native passes a prop to the native view only when its value changed, and a WebView loads its `source` only when
 * it gets one: the page a tab was given before, opened again once its WebView moved on to other pages, would load
 * nothing. So it comes with the source's `method` field set or cleared (a GET either way), and reaches the WebView.
 */
export function openInTab(state, id, uri) {
  const tab = findTab(state, id);
  if (!tab) return state;
  const wipeKey = holdsPage(tab) ? tab.wipeKey : (state.tabs.some(holdsPage) ? null : tab.webKey);
  const again = holdsPage(tab) && tab.source.uri === uri;
  const source = again && !tab.source.method ? { uri, method: 'GET' } : { uri };
  return updateTab(state, id, { source, home: false, wipeKey, pending: uri, progress: 0 });
}

/**
 * Tab `id`'s page started loading `url` in its top frame (a tapped link, a form, a redirect: a navigation the policy let
 * through): its address shows at once, as loading, until the WebView says what is on screen (showNav). A move within
 * the document on screen (a link to a fragment of it) loads nothing and shows nothing here.
 */
export function startLoad(state, id, url) {
  return updateTab(state, id, (tab) => {
    if (!holdsPage(tab) || typeof url !== 'string' || !url || tab.pending === url) return tab;
    const shown = tab.pending || tab.nav.url;
    const hash = url.indexOf('#');
    if (hash >= 0 && shown && url.slice(0, hash) === shown.split('#')[0]) return tab;
    return { ...tab, pending: url, progress: 0 };
  });
}

/**
 * What tab `id`'s WebView reported of the document on screen (a navigation-state event: a commit, a finished or failed
 * load, a move within the page). It is the address from now on: a navigation that ended without committing (a 204, a
 * download, a cancellation, an error) leaves the page that was on screen, and its address comes back.
 */
export const showNav = (state, id, nav) => updateTab(state, id, { nav, pending: null });

/** Tab `id` loads nothing it was going to (the user stopped it, or moved the page: back, forward, reload, home). */
export const dropPending = (state, id) => updateTab(state, id, (tab) => (tab.pending === null ? tab : { ...tab, pending: null }));

/** Whether the tab's current WebView is the one that started the browsing session (a remounted one never is). */
export const startsSession = (tab) => !!tab && tab.wipeKey !== null && tab.wipeKey === tab.webKey;

/**
 * Tab `id` gets a new WebView (its old one's render process died), opening `uri`, the page it showed (else the one it
 * was given last); the new WebView has no history yet. It joins the session as it is.
 */
export const remountTab = (state, id, uri) => updateTab(state, id, (tab) => (holdsPage(tab) ? {
  ...tab,
  webKey: tab.webKey + 1,
  lost: false,
  source: uri ? { uri } : tab.source,
  nav: { ...tab.nav, url: uri || tab.nav.url, canGoBack: false, canGoForward: false },
  pending: null,
  progress: 0,
} : tab));

/** Tab `id`'s render process died while it was behind: its dead WebView goes, and a new one opens when it comes forward. */
export const loseTab = (state, id) => updateTab(state, id, (tab) => (holdsPage(tab) && !tab.lost ? { ...tab, lost: true } : tab));
