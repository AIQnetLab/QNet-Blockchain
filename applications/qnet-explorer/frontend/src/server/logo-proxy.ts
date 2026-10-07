// Token logos served from aiqnet.io itself (GET /api/token/:contract/logo). A QRC-20 logo is an https URL
// its deployer recorded on chain; a visitor's browser loading it directly would hand that deployer the
// visitor's IP address, browser and the time, on the visitor's own address and transaction pages. So the
// page loads logos only from this origin (img-src 'self' in src/proxy.ts), and this server fetches
// each one once, strips everything but the image, and keeps it in memory.
//
// The server fetches URLs a stranger chose, so the fetch is fenced: https on port 443 only; a host that
// resolves to any private, loopback, link-local, shared, documentation, multicast or reserved address is
// refused, and the connection goes to the address that was checked; no redirect is followed; at most
// MAX_LOGO_BYTES are read within FETCH_TIMEOUT_MS; the answer must be a PNG, JPEG, WebP or GIF by its own
// bytes (never SVG, never the upstream Content-Type); no cookie, referrer or visitor detail is sent.
// The URL is never taken from the request: it is the logo the nodes report for the contract.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

export const MAX_LOGO_BYTES = 256 * 1024;
export const FETCH_TIMEOUT_MS = 5_000;
export const LOGO_TTL_MS = 6 * 60 * 60_000;
export const MISS_TTL_MS = 10 * 60_000;
export const MAX_CONCURRENT_FETCHES = 4;

// A contract address in EON form (docs/developers/smart-contracts.md, "Contract address").
export const CONTRACT_RE = /^[0-9a-f]{19}eon[0-9a-f]{15}[0-9a-f]{8}$/;

export type LogoType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export interface Logo {
  type: LogoType;
  body: Uint8Array;
}

// ---------------------------------------------------------------- addresses a fetch may reach

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  // Unspecified, loopback and IPv4-compatible; NAT64 (both); discard; IETF protocol space (Teredo
  // included); documentation; 6to4; unique local; link-local; site-local; multicast. An IPv4-mapped address
  // (::ffff:a.b.c.d) is checked against the IPv4 rules by BlockList itself; a ::ffff:0:0/96 rule here would
  // match every IPv4 address.
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(net, prefix, 'ipv6');

export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return false;
  return !BLOCKED.check(ip, version === 4 ? 'ipv4' : 'ipv6');
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, options: { all: true; verbatim: true }, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

// A `lookup` for the connection: resolves every address of the host and refuses the host if any of them is
// not public, so the socket can only connect to an address that was checked (no second resolution to rebind).
export function guardedLookup(resolve: Resolver = dnsLookup as unknown as Resolver) {
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback): void => {
    resolve(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 0);
        return;
      }
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
        callback(Object.assign(new Error('address not allowed'), { code: 'EADDRNOTALLOWED' }), '', 0);
        return;
      }
      if (typeof options === 'object' && options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

// The logo URL as the fetch takes it: https, no user info, the default port, a host name or a public
// address. Null for anything else.
export function logoUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443')) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.endsWith('.')) return null;
  if (isIP(host) !== 0) return isPublicAddress(host) ? url : null;
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost')) return null;
  return url;
}

// ---------------------------------------------------------------- the image itself

export function sniffImage(bytes: Uint8Array): LogoType | null {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (bytes.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  return null;
}

type RequestFn = (options: RequestOptions, callback: (res: IncomingMessage) => void) => ReturnType<typeof httpsRequest>;

export interface FetchOptions {
  lookup?: ReturnType<typeof guardedLookup>;
  request?: RequestFn;
  timeoutMs?: number;
  maxBytes?: number;
}

// One GET of a checked logo URL; the image, or null for any failure.
export function fetchLogoImage(url: URL, opts: FetchOptions = {}): Promise<Logo | null> {
  const { lookup = guardedLookup(), request = httpsRequest as RequestFn, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_LOGO_BYTES } = opts;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host) !== 0;
  if (url.protocol !== 'https:' || (literal && !isPublicAddress(host))) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (logo: Logo | null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      req.destroy();
      resolve(logo);
    };
    const req = request(
      {
        protocol: 'https:',
        hostname: host,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        lookup: lookup as unknown as RequestOptions['lookup'],
        ...(literal ? {} : { servername: host }),
        headers: { accept: 'image/png,image/jpeg,image/webp,image/gif', 'accept-encoding': 'identity', 'user-agent': 'aiqnet.io-logo' },
      },
      (res) => {
        const length = Number(res.headers['content-length']);
        if (res.statusCode !== 200 || (Number.isFinite(length) && length > maxBytes)) {
          finish(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) finish(null);
          else chunks.push(chunk);
        });
        res.on('end', () => {
          const body = new Uint8Array(Buffer.concat(chunks));
          const type = sniffImage(body);
          finish(type ? { type, body } : null);
        });
        res.on('error', () => finish(null));
      },
    );
    const deadline = setTimeout(() => finish(null), timeoutMs);
    req.on('error', () => finish(null));
    req.end();
  });
}

// ---------------------------------------------------------------- memory

export interface LogoCache {
  // undefined: not known; null: known to have no usable logo (for a shorter time).
  get(key: string): Logo | null | undefined;
  set(key: string, logo: Logo | null): void;
  size(): number;
  bytes(): number;
}

export function createLogoCache({
  maxEntries = 2_000,
  maxBytes = 32 * 1024 * 1024,
  ttlMs = LOGO_TTL_MS,
  missTtlMs = MISS_TTL_MS,
  now = Date.now,
}: { maxEntries?: number; maxBytes?: number; ttlMs?: number; missTtlMs?: number; now?: () => number } = {}): LogoCache {
  // Insertion order is least recently used first.
  const entries = new Map<string, { logo: Logo | null; expires: number }>();
  let total = 0;
  const drop = (key: string) => {
    const e = entries.get(key);
    if (!e) return;
    total -= e.logo?.body.length ?? 0;
    entries.delete(key);
  };
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.expires <= now()) {
        drop(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, e);
      return e.logo;
    },
    set(key, logo) {
      drop(key);
      const size = logo?.body.length ?? 0;
      if (size > maxBytes) return;
      while (entries.size > 0 && (entries.size >= maxEntries || total + size > maxBytes)) {
        drop(entries.keys().next().value as string);
      }
      entries.set(key, { logo, expires: now() + (logo ? ttlMs : missTtlMs) });
      total += size;
    },
    size: () => entries.size,
    bytes: () => total,
  };
}

// ---------------------------------------------------------------- the service

// What the nodes report as the contract's logo: its https URL, null when it has none (or is no token),
// or 'unavailable' when no node answered.
export type LogoSource = (contract: string) => Promise<string | null | 'unavailable'>;

export type LogoResult = { kind: 'logo'; logo: Logo } | { kind: 'none' } | { kind: 'busy' };

export function createLogoService({
  source,
  fetchImage = (url: URL) => fetchLogoImage(url),
  cache = createLogoCache(),
  maxConcurrent = MAX_CONCURRENT_FETCHES,
}: {
  source: LogoSource;
  fetchImage?: (url: URL) => Promise<Logo | null>;
  cache?: LogoCache;
  maxConcurrent?: number;
}) {
  const inFlight = new Map<string, Promise<LogoResult>>();
  let active = 0;

  async function load(contract: string): Promise<LogoResult> {
    const raw = await source(contract);
    if (raw === 'unavailable') return { kind: 'busy' };
    const url = raw === null ? null : logoUrl(raw);
    const logo = url ? await fetchImage(url) : null;
    cache.set(contract, logo);
    return logo ? { kind: 'logo', logo } : { kind: 'none' };
  }

  return {
    async get(contract: string): Promise<LogoResult> {
      const cached = cache.get(contract);
      if (cached !== undefined) return cached ? { kind: 'logo', logo: cached } : { kind: 'none' };
      const running = inFlight.get(contract);
      if (running) return running;
      if (active >= maxConcurrent) return { kind: 'busy' };
      active += 1;
      const job = load(contract)
        .catch((): LogoResult => ({ kind: 'busy' }))
        .finally(() => {
          active -= 1;
          inFlight.delete(contract);
        });
      inFlight.set(contract, job);
      return job;
    },
  };
}
