// Shared by the QNet Link tests: the protocol's vectors and the app's side of the exchange done with
// node:crypto (OpenSSL), independent of @noble and of WebCrypto.

import { readFileSync } from 'node:fs';
import { createCipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from 'node:crypto';

const PROTOCOLS = new URL('../../../../../../docs/protocols/', import.meta.url);

// Revision 1: the extension's qnet_activateNode answers and the activation codes (qnet-link-v1.vectors.json).
export const VECTORS = JSON.parse(readFileSync(new URL('qnet-link-v1.vectors.json', PROTOCOLS), 'utf8'));
// Revision 2 and the light node messages (light-node.vectors.json); LINK is its QNet Link part.
export const LIGHT = JSON.parse(readFileSync(new URL('light-node.vectors.json', PROTOCOLS), 'utf8'));
export const LINK = LIGHT.link;
export const LINK_CONSTANTS = LIGHT.constants.link;

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

// A raw X25519 private key as PKCS#8, for WebCrypto importKey.
export const x25519Pkcs8 = (raw) => new Uint8Array(Buffer.concat([PKCS8_X25519, Buffer.from(raw)]));

// The encrypted answer body {appPub, iv, ct} the app posts for a session, and the check number it derives.
export function appSeal({ id, intent, sitePub, plaintext, reqHash = null }) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, randomBytes(32)]), format: 'der', type: 'pkcs8' });
  const appPub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
  const pub = createPublicKey({ key: Buffer.concat([SPKI_X25519, Buffer.from(sitePub, 'base64url')]), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: priv, publicKey: pub });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(id, 'hex'), Buffer.from('qnet-link-v1'), 32));
  const checkNumber = Buffer.from(hkdfSync('sha256', shared, Buffer.from(id, 'hex'), Buffer.from('qnet-link-v1-sas'), 4)).readUInt32BE(0) % 1_000_000;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`qnet-link-v1|${id}|${intent}${reqHash ? `|${reqHash}` : ''}`));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final(), cipher.getAuthTag()]);
  return { appPub: appPub.toString('base64url'), iv: iv.toString('base64url'), ct: ct.toString('base64url'), checkNumber };
}

// The relay body of a sealed answer.
export const bodyOf = ({ appPub, iv, ct }) => ({ appPub, iv, ct });
