import { NextResponse, type NextRequest } from 'next/server';
import { hostRedirect, requestHost } from './lib/hosts.ts';
import { DEFAULT_LOCALE, LOCALE_HEADER, NAMED_HEADER, PATH_HEADER, localeCookie } from './lib/languages.ts';
import { isPageLoad, localeRoute } from './lib/locale-route.ts';

// Content-Security-Policy with a fresh nonce per page response (the Next.js App Router pattern). This is
// the site's proxy, the Next.js 16 name of middleware (Node.js runtime). Next.js reads the nonce from the
// request's CSP header and puts it on its own scripts; 'strict-dynamic' lets those load the page chunks.
// Pages render per request for this (see the root layout).
//
// The site has one host, aiqnet.io (src/lib/hosts.ts). link.aiqnet.io serves the link page and the
// app-association files; every other path there, and every path on any other host (www., explorer., an
// unknown Host), API routes included, is a 308 to the same path on aiqnet.io.

const DEV = process.env.NODE_ENV !== 'production';

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

// The node cabinet's pages (/node) hold a payment key and open requests to the wallets: they also start no worker,
// embed no frame and take a manifest from this origin only, and in production upgrade any http address.
const CABINET_EXTRA = ["worker-src 'none'", "frame-src 'none'", "manifest-src 'self'"];

function isCabinetPath(pathname: string): boolean {
  return pathname === '/node' || pathname.startsWith('/node/');
}

function policy(nonce: string, cabinet: boolean): string {
  return [
    "default-src 'self'",
    // React evaluates code for its development error overlay; a production build never gets 'unsafe-eval'.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV ? " 'unsafe-eval'" : ''}`,
    // style attributes and styled-jsx; styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    // Only this origin and data: (the inline SVG icons). Token logos recorded on chain are served from
    // /api/token/<contract>/logo (src/server/logo-proxy.ts), so no visitor's browser reaches a deployer's host.
    "img-src 'self' data:",
    "font-src 'self'",
    // The browser talks only to this origin: /api/* and the /api/stream event source.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    ...(cabinet ? [...CABINET_EXTRA, ...(DEV ? [] : ['upgrade-insecure-requests'])] : []),
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const elsewhere = hostRedirect(requestHost(request.headers.get('host')), pathname, search, DEV);
  if (elsewhere) return NextResponse.redirect(elsewhere, 308);
  // An API route reaches this point only on a host that serves it without being aiqnet.io (a local run):
  // it keeps its own headers (next.config.js).
  if (pathname.startsWith('/api/')) return NextResponse.next();
  // The page's language (src/lib/locale-route.ts): /ru/explorer renders /explorer in Russian.
  const route = localeRoute({
    pathname,
    search,
    cookie: request.headers.get('cookie'),
    acceptLanguage: request.headers.get('accept-language'),
    userAgent: request.headers.get('user-agent'),
    document: isPageLoad(request.method, request.headers),
  });
  const keep = (response: NextResponse) => {
    if (route.kind === 'none') return response;
    if (route.keep) response.headers.append('Set-Cookie', localeCookie(route.keep, !DEV));
    response.headers.set('Vary', 'Accept-Language, Cookie');
    return response;
  };
  // request.url is the address the server checks a rewrite and a redirect against (next.config.js
  // skipProxyUrlNormalize): on it a rewrite stays inside the server and a redirect leaves as a relative Location.
  const here = (path: string) => new URL(path, request.url);
  if (route.kind === 'redirect') return keep(NextResponse.redirect(here(route.location), 307));
  const path = route.kind === 'page' ? route.path : pathname;
  const csp = policy(newNonce(), isCabinetPath(path));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);
  requestHeaders.delete(LOCALE_HEADER);
  requestHeaders.delete(PATH_HEADER);
  requestHeaders.delete(NAMED_HEADER);
  if (route.kind === 'page') {
    requestHeaders.set(LOCALE_HEADER, route.locale);
    requestHeaders.set(PATH_HEADER, route.path);
    // An address that names English (/en/..., a browser that keeps no cookie) keeps it in the server's own redirects.
    if (route.rewrite && route.locale === DEFAULT_LOCALE) requestHeaders.set(NAMED_HEADER, '1');
  }
  const response = route.kind === 'page' && route.rewrite
    ? NextResponse.rewrite(here(`${route.path}${search}`), { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return keep(response);
}

// Every request but API routes (their own CSP in next.config.js) and the build assets under /_next/static,
// whatever its headers: a prefetch or router request is answered with a page too, so it gets the policy
// and the host routing like any other. /_next/image is not an asset here (the image optimizer is off,
// `images.unoptimized`), only a path that renders the 404 page. API routes reach it on every host but
// aiqnet.io, to be sent there; the site's own skip the proxy. The `has` value is a regular expression
// that Next.js anchors at both ends: any host except exactly aiqnet.io.
export const config = {
  matcher: [
    { source: '/((?!api/|_next/static/).*)' },
    { source: '/api/:path*', has: [{ type: 'host', value: '(?!aiqnet\\.io$).*' }] },
  ],
};
