/**
 * Web addresses for the in-app browser: a strict parser (no reliance on the platform URL class, which React
 * Native implements only in part), origins, the navigation policy, the address bar's input, and what the
 * address bar and the confirmation sheets show (the registrable domain emphasised, international names
 * decoded with a warning). Pure JS, no I/O.
 */

export const MAX_URL_LENGTH = 8192;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

// scheme "://" authority path? query? fragment?  — authority without credentials (an "@" is refused).
const WEB_URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#@\s\\]*)((?:\/[^?#\s]*)?)(\?[^#\s]*)?(#\S*)?$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^\[[0-9a-f:.]{2,45}\]$/;
// Controls, spaces and the bidi / invisible characters that make an address read as something it is not.
const UNSAFE_CHARS_RE = /[\x00-\x20\x7f-\x9f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

const DEFAULT_PORTS = { https: '443', http: '80' };

function validHost(host) {
  if (!host || host.length > 253) return false;
  if (IPV4_RE.test(host) || IPV6_RE.test(host)) return true;
  const labels = host.split('.');
  // A name ending in a number is an IPv4 address to every URL parser: only the canonical dotted form passes.
  if (/^(\d+|0x[0-9a-f]*)$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => LABEL_RE.test(l));
}

const isIpHost = (host) => IPV4_RE.test(host) || IPV6_RE.test(host);

/**
 * { scheme, host, port, path, query, fragment } of an absolute http(s) URL with an ASCII host, or null.
 * The host is lowercased; `port` is '' for the scheme's default.
 */
export function parseWebUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return null;
  if (UNSAFE_CHARS_RE.test(url)) return null;
  const m = WEB_URL_RE.exec(url);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return null;
  let authority = m[2].toLowerCase();
  let port = '';
  const pm = /:(\d{0,5})$/.exec(authority);
  if (pm) {
    port = pm[1];
    authority = authority.slice(0, -pm[0].length);
  }
  if (port !== '' && (Number(port) < 1 || Number(port) > 65535)) return null;
  if (port === DEFAULT_PORTS[scheme]) port = '';
  const host = authority.endsWith('.') ? authority.slice(0, -1) : authority;
  if (!validHost(host)) return null;
  return { scheme, host, port, path: m[3] || '/', query: m[4] || '', fragment: m[5] || '' };
}

const isLoopback = (host) => LOOPBACK_HOSTS.includes(host);

/** "scheme://host[:port]" of a parsed URL. */
export function originOfParsed(p) {
  return `${p.scheme}://${p.host}${p.port ? `:${p.port}` : ''}`;
}

/**
 * The origin a page on `url` has, when it is one the wallet talks to: https, or plain-http loopback in a
 * development build. null otherwise.
 */
export function walletOriginOf(url, { dev = false } = {}) {
  const p = parseWebUrl(url);
  if (!p) return null;
  if (p.scheme === 'https') return originOfParsed(p);
  return dev && isLoopback(p.host) ? originOfParsed(p) : null;
}

/**
 * The canonical form of an origin reported by the native side (the sender of a message), or null when it is
 * not exactly an origin the wallet talks to. A single trailing "/" and a default port are tolerated.
 */
export function canonicalOrigin(value, { dev = false } = {}) {
  if (typeof value !== 'string' || value.length > 300) return null;
  const text = value.endsWith('/') ? value.slice(0, -1) : value;
  const p = parseWebUrl(text);
  if (!p || p.path !== '/' || p.query || p.fragment || /[/?#]/.test(text.replace(/^[a-z]+:\/\//i, ''))) return null;
  return walletOriginOf(originOfParsed(p), { dev });
}

// ── Navigation policy ─────────────────────────────────────────────────────────────────────────────────

// Where a refused aiqnet.io page leads instead: the explorer, the site's one page for the in-app browser.
export const EXPLORER_PAGE = 'https://aiqnet.io/explorer';

/**
 * The aiqnet.io pages the in-app browser never loads: the QNet Link host (a link.aiqnet.io/l link is for the
 * device's own browser or camera; from inside the app it would come back to the app itself), the site's node
 * cabinet (/node and below), /activate, /wallet and /l (store rules, qnet-link-v1 section 14.8), and the other pages the
 * site keeps out of the app's view: its home page, /docs, /dao, /testnet and /qnet-wallet-extension (the site's
 * IN_APP_EXCLUDED_PAGES, src/lib/activate-view.ts). They are refused on aiqnet.io and on the two names that serve the
 * same site (www., explorer.); other subdomains, such as games.aiqnet.io, are ordinary sites. The app refuses them
 * itself, so keeping them out never depends on the page's own script seeing the app in time, nor on the site
 * redirecting its other names (MB-03). Android's WebView patch holds the same list.
 */
export const WALLET_ONLY_PATHS = Object.freeze(['activate', 'wallet', 'node', 'l', 'docs', 'dao', 'testnet', 'qnet-wallet-extension']);
const WALLET_ONLY_RE = new RegExp(`^/(${WALLET_ONLY_PATHS.join('|')})(/|$)`, 'i');
// The host names that serve the site itself, listed by name: never a subdomain wildcard.
const SITE_HOSTS = new Set(['aiqnet.io', 'www.aiqnet.io', 'explorer.aiqnet.io']);

export function isWalletOnlyPage(p) {
  if (!p) return false;
  if (p.host === 'link.aiqnet.io') return true;
  if (!SITE_HOSTS.has(p.host)) return false;
  const path = routedPath(p.path);
  return path === '/' || WALLET_ONLY_RE.test(path);
}

// A path as a site's router reads it: escapes decoded, `.` and `..` segments resolved, repeated slashes as one, so
// `/%6Eode` or `/x/../node` is `/node` (a WebView on iOS sends such a path as it was written).
function routedPath(path) {
  let text = path;
  try { text = decodeURIComponent(path); } catch (_) { /* a malformed escape is read as written */ }
  const out = [];
  for (const segment of text.split('/')) {
    if (segment === '..') out.pop();
    else if (segment !== '' && segment !== '.') out.push(segment);
  }
  return `/${out.join('/')}`;
}

/**
 * Whether the WebView may load `url`. { allow: true } or { allow: false, reason: 'insecure' | 'external' |
 * 'invalid' | 'site' }. Top-level: https only (plain-http loopback in development builds) and about:blank; every
 * other scheme — intent:, market:, tel:, mailto:, custom app schemes, http:, file:, data:, blob:, javascript: — is
 * refused and never handed to another app. A subframe may also be about:srcdoc, data: or blob: (it can never
 * reach the wallet: only the top frame's messages are accepted). The wallet-only pages are refused in any frame
 * ('site', isWalletOnlyPage), and a top frame goes to the explorer instead (`redirect`).
 */
export function navigationDecision(url, { dev = false, topFrame = true } = {}) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return { allow: false, reason: 'invalid' };
  const sm = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!sm) return { allow: false, reason: 'invalid' };
  const scheme = sm[1].toLowerCase();
  if (scheme === 'about') {
    return url === 'about:blank' || (!topFrame && url === 'about:srcdoc') ? { allow: true } : { allow: false, reason: 'invalid' };
  }
  if (scheme === 'https') {
    const p = parseWebUrl(url);
    if (!p) return { allow: false, reason: 'invalid' };
    if (!isWalletOnlyPage(p)) return { allow: true };
    return topFrame ? { allow: false, reason: 'site', redirect: EXPLORER_PAGE } : { allow: false, reason: 'site' };
  }
  if (scheme === 'http') {
    const p = parseWebUrl(url);
    if (dev && p && isLoopback(p.host)) return { allow: true };
    return { allow: false, reason: p ? 'insecure' : 'invalid' };
  }
  if (!topFrame && (scheme === 'data' || scheme === 'blob')) return { allow: true };
  return { allow: false, reason: 'external' };
}

// ── Punycode (RFC 3492) for international host names ──────────────────────────────────────────────────

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAXINT = 0x7fffffff;

function adapt(delta, numPoints, firstTime) {
  let k = 0;
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  for (; d > ((BASE - TMIN) * TMAX) >> 1; k += BASE) d = Math.floor(d / (BASE - TMIN));
  return Math.floor(k + ((BASE - TMIN + 1) * d) / (d + SKEW));
}

function basicToDigit(cp) {
  if (cp >= 0x30 && cp < 0x3a) return cp - 0x30 + 26;
  if (cp >= 0x41 && cp < 0x5b) return cp - 0x41;
  if (cp >= 0x61 && cp < 0x7b) return cp - 0x61;
  return BASE;
}

const digitToBasic = (d) => String.fromCharCode(d < 26 ? d + 0x61 : d - 26 + 0x30);
const threshold = (k, bias) => (k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias);

/** Decodes a punycode label body (without "xn--"); null when it is not valid punycode. */
export function punycodeDecode(input) {
  if (typeof input !== 'string' || input.length > 63) return null;
  const output = [];
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  const basic = Math.max(0, input.lastIndexOf('-'));
  for (let j = 0; j < basic; j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    output.push(c);
  }
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= BASE || digit > Math.floor((MAXINT - i) / w)) return null;
      i += digit * w;
      const t = threshold(k, bias);
      if (digit < t) break;
      if (w > Math.floor(MAXINT / (BASE - t))) return null;
      w *= BASE - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (Math.floor(i / out) > MAXINT - n) return null;
    n += Math.floor(i / out);
    i %= out;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  try {
    return String.fromCodePoint(...output);
  } catch (_) {
    return null;
  }
}

/** Encodes one label's code points as punycode (without "xn--"); null on overflow. */
export function punycodeEncode(label) {
  const input = Array.from(String(label), (c) => c.codePointAt(0));
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  const output = input.filter((c) => c < 0x80).map((c) => String.fromCharCode(c));
  const basicLength = output.length;
  let handled = basicLength;
  if (basicLength) output.push('-');
  while (handled < input.length) {
    let m = MAXINT;
    for (const c of input) if (c >= n && c < m) m = c;
    if (m - n > Math.floor((MAXINT - delta) / (handled + 1))) return null;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of input) {
      if (c < n && ++delta > MAXINT) return null;
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = threshold(k, bias);
          if (q < t) break;
          output.push(digitToBasic(t + ((q - t) % (BASE - t))));
          q = Math.floor((q - t) / (BASE - t));
        }
        output.push(digitToBasic(q));
        bias = adapt(delta, handled + 1, handled === basicLength);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return output.join('');
}

// A decoded label is shown only if it has nothing that hides, reorders or fakes a separator (MB2-05): whitespace,
// any control, format (bidi overrides, zero-width), private-use or unassigned character, a dot or slash look-alike,
// or a character that ends a host. The browser extension's rule (provider.js UNSAFE_LABEL), plus the one-dot
// leader and the small full stop.
const UNSAFE_LABEL = /[\s\p{C}.。．｡․﹒/\\⁄∕⧸／@:#?%]/u;

/**
 * A host as people read it: every "xn--" label decoded. A label that does not decode, or whose decoded form could
 * mislead (UNSAFE_LABEL), stays in its xn-- form.
 */
export function hostToUnicode(host) {
  if (typeof host !== 'string' || isIpHost(host)) return host;
  return host.split('.').map((l) => {
    if (!l.startsWith('xn--')) return l;
    const decoded = punycodeDecode(l.slice(4));
    return decoded && !UNSAFE_LABEL.test(decoded) ? decoded : l;
  }).join('.');
}

/** A typed host in ASCII form (lowercased, international labels punycode-encoded), or null. */
export function hostToAscii(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253 || UNSAFE_CHARS_RE.test(host)) return null;
  const lower = host.toLowerCase();
  if (IPV4_RE.test(lower) || IPV6_RE.test(lower)) return lower;
  const labels = lower.split('.');
  const out = [];
  for (const l of labels) {
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7f]*$/.test(l)) {
      out.push(l);
      continue;
    }
    let nfc = l;
    try { nfc = typeof l.normalize === 'function' ? l.normalize('NFC') : l; } catch (_) { nfc = l; }
    const enc = punycodeEncode(nfc);
    if (!enc) return null;
    out.push(`xn--${enc}`);
  }
  const ascii = out.join('.');
  return validHost(ascii) ? ascii : null;
}

export const isInternationalHost = (host) => typeof host === 'string' && host.split('.').some((l) => l.startsWith('xn--'));

// ── What the address bar and the sheets emphasise ─────────────────────────────────────────────────────

// Second-level labels under a two-letter country code that are public suffixes themselves (co.uk, com.br…),
// and hosting platforms where every subdomain belongs to someone else. A heuristic for emphasis only: the
// full host is always shown too.
const COUNTRY_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic', 'ltd', 'plc', 'sch', 'nom', 'info', 'biz']);
const PLATFORM_SUFFIXES = [
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
  'herokuapp.com', 'appspot.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net', 'onrender.com',
  'glitch.me', 'repl.co', 'surge.sh', 'fly.dev', 'ngrok.io', 'ngrok-free.app',
];

/** The part of a host one owner registered (ASCII in, ASCII out): example.com, example.co.uk, me.github.io. */
export function registrableDomain(host) {
  if (typeof host !== 'string' || !host) return '';
  if (isIpHost(host) || !host.includes('.')) return host;
  const labels = host.split('.');
  for (const suffix of PLATFORM_SUFFIXES) {
    if (host === suffix) return host;
    if (host.endsWith(`.${suffix}`)) return labels.slice(-(suffix.split('.').length + 1)).join('.');
  }
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = labels.length >= 3 && tld.length === 2 && COUNTRY_SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/**
 * What to show for a page address: { origin, secure, host (readable), hostAscii, prefix, domain, port, idn }.
 * `prefix` + `domain` is the readable host with `domain` (the registrable part) to emphasise. null when the
 * URL is not an http(s) URL.
 */
export function describeUrl(url) {
  const p = parseWebUrl(url);
  if (!p) return null;
  const host = hostToUnicode(p.host);
  const domain = hostToUnicode(registrableDomain(p.host));
  const split = host.endsWith(domain);
  return {
    origin: originOfParsed(p),
    secure: p.scheme === 'https',
    host,
    hostAscii: p.host,
    prefix: split ? host.slice(0, host.length - domain.length) : '',
    domain: split ? domain : host,
    port: p.port,
    idn: isInternationalHost(p.host),
  };
}

/** The same for an origin ("https://host[:port]"). */
export const describeOrigin = (origin) => describeUrl(`${origin}/`);

/**
 * Whether a URL the OS delivers now was handed over by a page of the in-app browser rather than opened by another
 * app: the browser tab is on screen and the app has been in front for longer than `graceMs` (a link another app
 * opens brings the app to the front with it). `activeSince` is when the app last came to the front, 0 while not.
 */
export function handedOverByBrowser(activeTab, activeSince, now = Date.now(), graceMs = 2000) {
  return activeTab === 'browser' && activeSince > 0 && now - activeSince > graceMs;
}

// ── The address bar ───────────────────────────────────────────────────────────────────────────────────

/**
 * What the user typed, as the URL to open: { url } or { error: 'empty' | 'invalid' | 'scheme' }. https is
 * assumed; a typed http:// address opens as https (development builds keep plain-http loopback). Nothing typed
 * is ever sent to a search engine: text that is not an address is refused.
 */
export function addressToUrl(text, { dev = false } = {}) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { error: 'empty' };
  if (raw.length > MAX_URL_LENGTH || /\s/.test(raw) || UNSAFE_CHARS_RE.test(raw)) return { error: 'invalid' };
  let scheme = null;
  let rest = raw;
  const withSlashes = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(raw);
  if (withSlashes) {
    scheme = withSlashes[1].toLowerCase();
    rest = withSlashes[2];
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(raw)) {
    // mailto:, javascript:, data:, intent: … (a host followed by a port, "localhost:3000", is not a scheme)
    return { error: 'scheme' };
  }
  if (scheme !== null && scheme !== 'https' && scheme !== 'http') return { error: 'scheme' };
  const m = /^([^/?#]*)(.*)$/.exec(rest);
  let authority = m[1];
  const tail = m[2];
  if (!authority || authority.includes('@')) return { error: 'invalid' };
  let port = '';
  const pm = /:(\d{1,5})$/.exec(authority);
  if (pm && !authority.endsWith(']')) {
    port = pm[1];
    authority = authority.slice(0, -pm[0].length);
  }
  const host = hostToAscii(authority.endsWith('.') ? authority.slice(0, -1) : authority);
  if (!host) return { error: 'invalid' };
  // A bare word ("wallet") is not an address; a loopback name in development is.
  if (!host.includes('.') && !isIpHost(host) && !(dev && isLoopback(host))) return { error: 'invalid' };
  const useHttp = dev && isLoopback(host) && scheme !== 'https';
  const candidate = `${useHttp ? 'http' : 'https'}://${host}${port ? `:${port}` : ''}${tail || '/'}`;
  const p = parseWebUrl(candidate);
  if (!p) return { error: 'invalid' };
  return { url: `${originOfParsed(p)}${p.path}${p.query}${p.fragment}` };
}
