// QNet Link v1 key exchange, the site's side (docs/protocols/qnet-link-v1.md sections 6 and 14.6): an ephemeral
// X25519 key pair per session, HKDF-SHA256 and AES-256-GCM from WebCrypto, and the check number. The private
// key is a non-extractable WebCrypto key where the browser has X25519, which a cabinet page may keep until the
// session ends (src/lib/link-store.ts); elsewhere it is bytes in this object's memory (@noble/curves) only.

import { x25519 } from '@noble/curves/ed25519';
import {
  AAD_PREFIX,
  CAPS,
  CT_MIN_BYTES,
  HKDF_INFO,
  SAS_INFO,
  buildLink,
  bytesToHex,
  checkRequest,
  decodeB64url,
  encodeB64url,
  hexToBytes,
  requestHash,
  requestText,
  utf8Bytes,
  type LinkIntent,
  type LinkRequest,
  type RelayAnswerBody,
} from './qnet-link.ts';

export type SiteKey = { kind: 'bytes'; secret: Uint8Array } | { kind: 'webcrypto'; privateKey: CryptoKey };

export interface SiteSession {
  id: string;
  sitePub: string;
  intent: LinkIntent;
  // Null for `connect`.
  request: LinkRequest | null;
  reqHash: string | null;
  link: string;
  // Zeroed (bytes) or dropped (WebCrypto) by closeSiteSession; a closed session opens nothing.
  key: SiteKey;
  closed: boolean;
}

export interface OpenedAnswer {
  plaintext: string;
  // Six digits both sides derive from the shared secret (section 14.6).
  checkNumber: number;
}

type Random = (bytes: Uint8Array) => Uint8Array;
const platformRandom: Random = (bytes) => crypto.getRandomValues(bytes);

// A session from its parts; throws on a request that does not fit the intent.
export function sessionWithKey(id: string, intent: LinkIntent, request: LinkRequest | null, sitePub: string, key: SiteKey): SiteSession {
  const checked = intent === 'connect' ? null : checkRequest(intent, request);
  if ((intent === 'connect') !== (request === null) || (intent !== 'connect' && !checked)) throw new Error('request');
  const reqHash = checked && intent !== 'connect' ? requestHash(requestText(intent, checked)) : null;
  const link = buildLink(reqHash ? { id, sitePub, intent, reqHash } : { id, sitePub, intent });
  return { id, sitePub, intent, request: checked, reqHash, link, key, closed: false };
}

// A session from a given private key and id (the vectors).
export function siteSession(id: string, intent: LinkIntent, request: LinkRequest | null, secretKey: Uint8Array): SiteSession {
  return sessionWithKey(id, intent, request, encodeB64url(x25519.getPublicKey(secretKey)), { kind: 'bytes', secret: secretKey });
}

// A new session: a fresh id and key pair, the key non-extractable when WebCrypto has X25519.
export async function newSiteSession(
  intent: LinkIntent,
  request: LinkRequest | null,
  { random = platformRandom, subtle = globalThis.crypto?.subtle }: { random?: Random; subtle?: SubtleCrypto } = {},
): Promise<SiteSession> {
  const id = bytesToHex(random(new Uint8Array(16)));
  if (subtle) {
    try {
      const pair = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
      const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      if (pub.length === 32) return sessionWithKey(id, intent, request, encodeB64url(pub), { kind: 'webcrypto', privateKey: pair.privateKey });
    } catch {
      // no X25519 in this browser's WebCrypto: the key stays in memory
    }
  }
  return siteSession(id, intent, request, random(new Uint8Array(32)));
}

// The POST /api/link/sessions body: exactly the session's request keys.
export function sessionRequestBody(s: SiteSession): string {
  return JSON.stringify(s.request === null
    ? { id: s.id, sitePub: s.sitePub, intent: s.intent }
    : { id: s.id, sitePub: s.sitePub, intent: s.intent, request: s.request });
}

export function closeSiteSession(s: SiteSession): void {
  if (s.key.kind === 'bytes') s.key.secret.fill(0);
  s.closed = true;
}

// The AAD of an answer: the session id, the intent and, for `link` and `claim`, the request's hash.
export function answerAad(id: string, intent: LinkIntent, reqHash: string | null): string {
  return `${AAD_PREFIX}${id}|${intent}${reqHash ? `|${reqHash}` : ''}`;
}

async function sharedSecret(key: SiteKey, appPub: Uint8Array, subtle: SubtleCrypto): Promise<Uint8Array> {
  if (key.kind === 'bytes') {
    // noble refuses the low-order points (an all-zero secret); the caller states the rule again.
    return x25519.getSharedSecret(key.secret, appPub);
  }
  const pub = await subtle.importKey('raw', new Uint8Array(appPub), { name: 'X25519' }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, key.privateKey, 256));
}

// The plaintext of the app's answer and the check number; throws on any failure (encoding, low-order key,
// tag), which the page reports as "the answer could not be read".
export async function openAnswer(s: SiteSession, body: RelayAnswerBody, subtle: SubtleCrypto = crypto.subtle): Promise<OpenedAnswer> {
  if (s.closed) throw new Error('closed');
  const appPub = decodeB64url(body.appPub, 32);
  const iv = decodeB64url(body.iv, 12);
  const ct = decodeB64url(body.ct);
  if (!appPub || !iv || !ct || ct.length < CT_MIN_BYTES || ct.length > CAPS[s.intent].ct) throw new Error('encoding');
  let shared: Uint8Array;
  try {
    shared = await sharedSecret(s.key, appPub, subtle);
  } catch {
    throw new Error('key');
  }
  // WebCrypto takes an ArrayBuffer-backed copy; both are zeroed below.
  const ikm = new Uint8Array(shared);
  try {
    if (ikm.every((b) => b === 0)) throw new Error('key');
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const salt = new Uint8Array(hexToBytes(s.id));
    const key = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new Uint8Array(utf8Bytes(HKDF_INFO)) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new Uint8Array(utf8Bytes(answerAad(s.id, s.intent, s.reqHash))), tagLength: 128 },
      key,
      new Uint8Array(ct),
    );
    const sas = new DataView(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: new Uint8Array(utf8Bytes(SAS_INFO)) }, base, 32));
    return { plaintext: new TextDecoder('utf-8', { fatal: true }).decode(plain), checkNumber: sas.getUint32(0) % 1_000_000 };
  } finally {
    shared.fill(0);
    ikm.fill(0);
  }
}
