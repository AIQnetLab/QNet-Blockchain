// The hosts this app answers on (docs/protocols/qnet-link-v1.md sections 2 and 4). The site and its relay
// have one origin, https://aiqnet.io: the relay's and the faucet's Origin check, the extension's
// activation origin and the app's relay base all name it. The link has a host of its own, so a tap on the
// site's button always leaves the page's host: a browser may keep a same-host link as a page instead of
// opening the app. Any other name that reaches this app (www., explorer., an unknown Host header) is sent
// to the same path on aiqnet.io, so no second origin runs the site.

export const SITE_HOST = 'aiqnet.io';
export const SITE_ORIGIN = `https://${SITE_HOST}`;
export const LINK_HOST = 'link.aiqnet.io';
export const LINK_ORIGIN = `https://${LINK_HOST}`;
// The link page. It renders outside the site's shell on every host (src/components/SiteShell.tsx).
export const LINK_PAGE_PATH = '/l';

// A production build started on this machine (`npm start`, bound to 127.0.0.1) serves the site as is.
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

// The icons the page head (the root layout's metadata) and the manifest name, each a file in public/.
export const SITE_ICONS: readonly string[] = [
  '/favicon.ico', '/icon-16.png', '/icon-32.png', '/icon-48.png', '/icon-128.png', '/icon-180.png', '/icon-192.png', '/icon-512.png',
];

// What the link host serves itself, by exact path: the link page, the app-association files, and the
// manifest and icons that page's head names. Any other path there, also one that would only be the 404
// page, goes to the site (SITE-R4-CSP-01). Build assets (/_next/static/) never reach the proxy (src/proxy.ts).
const LINK_HOST_PATHS: ReadonlySet<string> = new Set([
  LINK_PAGE_PATH,
  '/.well-known/assetlinks.json',
  '/.well-known/apple-app-site-association',
  '/manifest.json',
  ...SITE_ICONS,
]);

// The host of a Host header: lowercase, without a port.
export function requestHost(header: string | null): string {
  return (header ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

// Where a request goes instead of being served: the same path and query on the site. Null when this host
// serves it: aiqnet.io and a local run everything, the link host its own files, any other host nothing.
// A development build (`next dev`, reachable on the LAN by its address) serves every host.
export function hostRedirect(host: string, pathname: string, search: string, devBuild = false): string | null {
  if (host === SITE_HOST || LOCAL_HOSTS.has(host)) return null;
  if (host === LINK_HOST) {
    if (LINK_HOST_PATHS.has(pathname)) return null;
  } else if (devBuild) {
    return null;
  }
  return `${SITE_ORIGIN}${pathname}${search}`;
}
