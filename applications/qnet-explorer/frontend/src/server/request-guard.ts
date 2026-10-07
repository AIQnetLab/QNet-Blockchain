// The checks the site's own routes make before anything else (the QNet Link relay, the faucet). A browser
// puts an Origin header on every cross-site POST, and without a CORS preflight a third-party page can only
// send text/plain, form or multipart bodies; so requiring application/json and either no Origin (the app,
// curl, a server) or this site's own leaves another page no POST it can send with a visitor's IP address.
// A GET that another page makes with <img>, <script>, <link> or a frame carries no Origin, but a browser
// names where every request came from in Sec-Fetch-Site (Fetch Metadata): such a request is refused on
// that header, before any per-IP limit counts it (R4-SRA-01).

import { readCappedBytes } from '../lib/capped-body.ts';
import { SITE_ORIGIN } from '../lib/hosts.ts';

const LOCAL_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;
const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

// Development builds, where http://localhost pages call the routes.
export const DEV_ORIGINS = process.env.NODE_ENV !== 'production';

// Sec-Fetch-Site absent (the app, curl, a server, a browser without Fetch Metadata) or `same-origin` (this
// site's own pages). Any other value is a browser request that another site's page (`cross-site`), another
// host of the site such as the link page (`same-site`), or a typed address or bookmark (`none`) made.
export function fetchSiteAllowed(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}

// No Origin, or this site's own; never the link host, whose page calls nothing. A localhost origin only in
// development, or when the request itself came to localhost (a production build run locally). And, on any
// method, no browser request that a page of this origin did not make (fetchSiteAllowed).
export function originAllowed(request: Request, devOrigins: boolean = DEV_ORIGINS): boolean {
  if (!fetchSiteAllowed(request)) return false;
  const origin = request.headers.get('origin');
  if (origin === null || origin === SITE_ORIGIN) return true;
  if (!LOCAL_ORIGIN_RE.test(origin)) return false;
  return devOrigins || LOCAL_HOST_RE.test(request.headers.get('host') ?? '');
}

// The activation routes (/api/cabinet/activation/*, shared contract C3.0) also take the QNet extension's own calls: an
// Origin of chrome-extension://<its 32-letter id>, and Sec-Fetch-Site `none`, which a browser extension's request
// carries. Anything else a browser names is another site's page, refused before any limit counts it.
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

export function activationOriginAllowed(request: Request, devOrigins: boolean = DEV_ORIGINS): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  if (origin === null || origin === SITE_ORIGIN || EXTENSION_ORIGIN_RE.test(origin)) return true;
  if (!LOCAL_ORIGIN_RE.test(origin)) return false;
  return devOrigins || LOCAL_HOST_RE.test(request.headers.get('host') ?? '');
}

export function isJsonRequest(request: Request): boolean {
  const type = request.headers.get('content-type');
  return type !== null && type.split(';')[0].trim().toLowerCase() === 'application/json';
}

// The body as UTF-8 text, read up to `max` bytes plus one: 413 past the cap, 400 when not UTF-8.
export async function readBody(request: Request, max: number): Promise<string | 400 | 413> {
  const bytes = await readCappedBytes(request, max);
  if (bytes === null) return 413;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 400;
  }
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; status: 403 | 415 | 413 | 400; error: string };

// Origin, media type, size and JSON, in that order: what a state-changing POST must pass before its
// handler looks at the body. `allowed`: the origin rule (the activation routes take the extension's too).
export async function readJsonPost(
  request: Request,
  max: number,
  devOrigins: boolean = DEV_ORIGINS,
  allowed: (request: Request, devOrigins: boolean) => boolean = originAllowed,
): Promise<JsonBody> {
  if (!allowed(request, devOrigins)) return { ok: false, status: 403, error: 'forbidden_origin' };
  if (!isJsonRequest(request)) return { ok: false, status: 415, error: 'unsupported_media_type' };
  const text = await readBody(request, max);
  if (text === 413) return { ok: false, status: 413, error: 'payload_too_large' };
  if (text === 400) return { ok: false, status: 400, error: 'invalid_request' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
}
