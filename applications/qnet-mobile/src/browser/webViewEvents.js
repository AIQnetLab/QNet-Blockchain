/**
 * What the patched WebView's native events and settings mean (patches/react-native-webview+14.0.1.patch). The two
 * platforms' web views report a page change through different events, and the same setting does different things on
 * them; the browser screen asks this module and never the platform, so the same page change has the same effect on
 * every phone and tablet.
 */
import { Platform } from 'react-native';

/**
 * Whether a load-start event means that a new document committed in the top frame, the same origin included. iOS sends
 * it only from didCommitNavigation, never for history.pushState or replaceState. Android sends it for every history
 * update, pushState included, so there a new document is told by its own first message instead (PAGE_OPENED_METHOD).
 */
export function loadStartIsNewDocument() {
  return Platform.OS === 'ios';
}

/**
 * The `incognito` setting of a browser tab's WebView; `startsSession`: this WebView opens the first page of a new
 * browsing session (browser/tabs startsSession).
 *
 * iOS: the setting gives the web view a data store of its own, in memory only (WebKit's nonPersistentDataStore, one per
 * web view); without it the web view would use the persistent default store. Every tab carries it, so each tab has a
 * session of its own that nothing is written to disk from, that another tab never touches, and that ends with the tab.
 *
 * Android: the app has one cookie store and one site storage for all its web views, and the setting wipes both (and
 * the app's HTTP cache) whenever a web view is created with it (RNCWebViewManagerImpl.setIncognito). A new tab carrying
 * it would sign every other tab out of its sites, so only the web view that starts the session carries it: the session
 * starts empty, the other tabs join it, and it ends once no tab holds a page; the next page opened wipes it. The screen
 * sets `cacheEnabled={false}` on every tab, as the setting does for its own web view: a page is never answered from the
 * HTTP cache, but what it loads may still be written to that cache, in the app's private storage, like the cookie
 * store and the site storage, until a wipe.
 */
export function incognitoFor(startsSession) {
  return Platform.OS !== 'android' || startsSession === true;
}

/**
 * Whether "Clear browsing data" must wipe what the session left on the phone itself, once every tab is closed. Android:
 * yes, the cookie store, the site storage and the HTTP cache outlive the web views; a hidden web view created with
 * `incognito` while no tab holds a page wipes them at once and signs no tab out. iOS: no, each tab's store was in memory
 * and went with its web view.
 */
export function clearNeedsWipe() {
  return Platform.OS === 'android';
}
