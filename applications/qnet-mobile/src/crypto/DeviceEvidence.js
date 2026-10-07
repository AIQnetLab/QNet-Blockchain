/**
 * Reading the device key's public point out of its own evidence (light-node-messages section 5.1): the certificate
 * of an Android Keystore key, and Apple's attestation object of an App Attest key, whose first certificate certifies
 * the key. Pure JS: a strict reader of the few CBOR and DER forms these carry, which refuses everything else. The
 * app checks nothing else here; the genesis nodes verify the chains.
 */

import { bytesToHex } from '@noble/hashes/utils.js';

function bad(what) {
  return new TypeError(`DeviceEvidence: invalid ${what}`);
}

// ---- CBOR (RFC 8949): definite lengths, integers, byte and ASCII text strings, arrays, maps ----

/** One CBOR data item that fills `bytes` exactly. Maps come back as Map, byte strings as Uint8Array. */
export function readCbor(bytes) {
  let at = 0;
  const need = (n) => {
    if (at + n > bytes.length) throw bad('CBOR');
  };
  const length = (info) => {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!size) throw bad('CBOR'); // indefinite lengths and reserved values
    need(size);
    let n = 0;
    for (let k = 0; k < size; k++) n = n * 256 + bytes[at++];
    if (!Number.isSafeInteger(n)) throw bad('CBOR');
    return n;
  };
  const item = (depth) => {
    if (depth > 8) throw bad('CBOR');
    need(1);
    const head = bytes[at++];
    const n = length(head & 31);
    switch (head >> 5) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: {
        need(n);
        const out = bytes.slice(at, at + n);
        at += n;
        return out;
      }
      case 3: {
        need(n);
        let text = '';
        for (let k = 0; k < n; k++) {
          if (bytes[at + k] > 0x7e || bytes[at + k] < 0x20) throw bad('CBOR text');
          text += String.fromCharCode(bytes[at + k]);
        }
        at += n;
        return text;
      }
      case 4: {
        const list = [];
        for (let k = 0; k < n; k++) list.push(item(depth + 1));
        return list;
      }
      case 5: {
        const map = new Map();
        for (let k = 0; k < n; k++) {
          const key = item(depth + 1);
          if (map.has(key)) throw bad('CBOR map');
          map.set(key, item(depth + 1));
        }
        return map;
      }
      default: throw bad('CBOR'); // tags, floats and simple values are not in this evidence
    }
  };
  const value = item(0);
  if (at !== bytes.length) throw bad('CBOR');
  return value;
}

// ---- DER (X.690) ----

function tlv(der, at, end) {
  if (at + 2 > end) throw bad('DER');
  const tag = der[at];
  let len = der[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || start + n > end) throw bad('DER');
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + der[start + k];
    start += n;
  }
  if (start + len > end) throw bad('DER');
  return { tag, start, end: start + len };
}

function children(der, node) {
  const out = [];
  for (let at = node.start; at < node.end;) {
    const child = tlv(der, at, node.end);
    out.push(child);
    at = child.end;
  }
  return out;
}

const same = (der, node, expected) => node.end - node.start === expected.length
  && expected.every((b, k) => der[node.start + k] === b);

const OID_EC_PUBLIC_KEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]; // 1.2.840.10045.2.1
const OID_P256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]; // 1.2.840.10045.3.1.7

/** The P-256 key an X.509 certificate (DER) certifies, as the 65-byte uncompressed point in hex; throws otherwise. */
export function certificatePublicKey(der) {
  if (!(der instanceof Uint8Array)) throw bad('certificate');
  const cert = tlv(der, 0, der.length);
  if (cert.tag !== 0x30 || cert.end !== der.length) throw bad('certificate');
  const [tbs] = children(der, cert);
  if (!tbs || tbs.tag !== 0x30) throw bad('certificate');
  let fields = children(der, tbs);
  if (fields[0] && fields[0].tag === 0xa0) fields = fields.slice(1); // the explicit version
  // serial, signature algorithm, issuer, validity, subject, then the subject's public key
  const spki = fields[5];
  if (!spki || spki.tag !== 0x30) throw bad('certificate');
  const [alg, key] = children(der, spki);
  if (!alg || alg.tag !== 0x30 || !key || key.tag !== 0x03) throw bad('certificate');
  const [oid, curve] = children(der, alg);
  if (!oid || oid.tag !== 0x06 || !same(der, oid, OID_EC_PUBLIC_KEY)
    || !curve || curve.tag !== 0x06 || !same(der, curve, OID_P256)) throw bad('key: not P-256');
  if (key.end - key.start !== 66 || der[key.start] !== 0 || der[key.start + 1] !== 0x04) throw bad('key point');
  return bytesToHex(der.subarray(key.start + 1, key.end));
}

/** The key an App Attest attestation object certifies (its first x5c certificate), as `certificatePublicKey`. */
export function attestationPublicKey(attestation) {
  if (!(attestation instanceof Uint8Array)) throw bad('attestation');
  const obj = readCbor(attestation);
  if (!(obj instanceof Map) || obj.get('fmt') !== 'apple-appattest') throw bad('attestation');
  const stmt = obj.get('attStmt');
  const x5c = stmt instanceof Map ? stmt.get('x5c') : null;
  if (!Array.isArray(x5c) || !(x5c[0] instanceof Uint8Array)) throw bad('attestation');
  return certificatePublicKey(x5c[0]);
}
