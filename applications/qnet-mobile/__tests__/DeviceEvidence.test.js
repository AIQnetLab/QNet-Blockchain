/**
 * The device key's point read from its own evidence (src/crypto/DeviceEvidence.js): Apple's published attestation
 * object (its key id is SHA-256 of the point) and the Android chains Google publishes as test data, both from the
 * verifier crate's test data; node:crypto's reading of the same certificates is the reference. Anything but a P-256
 * key, and any malformed CBOR or DER, is refused.
 */
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { sha256 } = require('@noble/hashes/sha2.js');
const { readCbor, certificatePublicKey, attestationPublicKey } = require('../src/crypto/DeviceEvidence');

const TESTDATA = path.join(__dirname, '../../../core/qnet-device-attest/tests/testdata');
const apple = JSON.parse(fs.readFileSync(path.join(TESTDATA, 'apple/validation_guide_sample.json'), 'utf8'));
const u8 = (b) => new Uint8Array(b);
const fromB64 = (s) => u8(Buffer.from(s, 'base64'));

// The certificates of a PEM file, key's certificate first.
const pemChain = (file) => [...fs.readFileSync(path.join(TESTDATA, 'android', file), 'utf8')
  .matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => fromB64(m[1].replace(/\s+/g, '')));

// node:crypto's point of a certificate's key, when it is P-256; null otherwise.
function nodePoint(der) {
  try {
    const key = new nodeCrypto.X509Certificate(Buffer.from(der)).publicKey;
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') return null;
    const jwk = key.export({ format: 'jwk' });
    return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
  } catch (_) {
    return null;
  }
}

describe('Apple\'s attestation object', () => {
  const attestation = fromB64(apple.attestationObject);

  it('reads as CBOR with its two certificates, the key\'s first', () => {
    const obj = readCbor(attestation);
    expect(obj.get('fmt')).toBe('apple-appattest');
    const x5c = obj.get('attStmt').get('x5c');
    expect(Buffer.from(x5c[0]).toString('base64')).toBe(apple.leafCertificate);
    expect(Buffer.from(x5c[1]).toString('base64')).toBe(apple.intermediateCertificate);
    expect(obj.get('authData')).toBeInstanceOf(Uint8Array);
  });

  it('certifies the key whose SHA-256 is the key id', () => {
    const point = attestationPublicKey(attestation);
    expect(point).toBe(nodePoint(fromB64(apple.leafCertificate)));
    expect(Buffer.from(sha256(Buffer.from(point, 'hex'))).toString('base64')).toBe(apple.keyId);
  });

  it('refuses another format and an object without certificates', () => {
    const cbor = (bytes) => u8(bytes);
    // {"fmt": "none"}
    expect(() => attestationPublicKey(cbor([0xa1, 0x63, 0x66, 0x6d, 0x74, 0x64, 0x6e, 0x6f, 0x6e, 0x65]))).toThrow(TypeError);
    // {"fmt": "apple-appattest"} without attStmt
    const fmt = Buffer.from('apple-appattest');
    expect(() => attestationPublicKey(cbor([0xa1, 0x63, 0x66, 0x6d, 0x74, 0x60 + fmt.length, ...fmt]))).toThrow(TypeError);
    expect(() => attestationPublicKey(Buffer.from(apple.attestationObject, 'base64').toString('hex'))).toThrow(TypeError);
  });
});

describe('Android chains', () => {
  const files = fs.readdirSync(path.join(TESTDATA, 'android')).filter((f) => f.endsWith('.pem')).sort();

  it('every chain\'s key reads as node:crypto reads it, and only a P-256 key reads at all', () => {
    let p256 = 0;
    let other = 0;
    for (const file of files) {
      const [leaf] = pemChain(file);
      const want = nodePoint(leaf);
      if (want) {
        expect([file, certificatePublicKey(leaf)]).toEqual([file, want]);
        p256++;
      } else {
        expect(() => certificatePublicKey(leaf)).toThrow(TypeError);
        other++;
      }
    }
    expect(p256).toBeGreaterThanOrEqual(8);
    expect(other).toBeGreaterThanOrEqual(2); // an RSA key and ML-DSA keys
  });

  it('a remote-provisioned StrongBox chain and a TEE chain give their keys', () => {
    for (const file of ['caiman_sdk36_sb_ec_rkp.pem', 'caiman_sdk36_tee_ec_rkp.pem']) {
      expect(certificatePublicKey(pemChain(file)[0])).toMatch(/^04[0-9a-f]{128}$/);
    }
    expect(() => certificatePublicKey(pemChain('akita_sdk34_tee_rsa_none.pem')[0])).toThrow(/P-256/);
  });
});

describe('malformed input is refused', () => {
  const leaf = fromB64(apple.leafCertificate);

  it('DER: truncated, with bytes after it, or of another shape', () => {
    expect(() => certificatePublicKey(leaf.slice(0, leaf.length - 1))).toThrow(TypeError);
    expect(() => certificatePublicKey(u8([...leaf, 0]))).toThrow(TypeError);
    expect(() => certificatePublicKey(u8([0x31, ...leaf.slice(1)]))).toThrow(TypeError);
    expect(() => certificatePublicKey(u8([0x30, 0x84, 0, 0, 0, 1, 0]))).toThrow(TypeError); // a 4-byte length
    expect(() => certificatePublicKey(u8([0x30, 0x00]))).toThrow(TypeError);
    expect(() => certificatePublicKey(u8([]))).toThrow(TypeError);
    expect(() => certificatePublicKey([...leaf])).toThrow(TypeError);
  });

  it('CBOR: indefinite lengths, tags, floats, bytes after the item, repeated keys, non-ASCII text, deep nesting', () => {
    expect(readCbor(u8([0x83, 0x01, 0x20, 0x42, 0xab, 0xcd]))).toEqual([1, -1, u8([0xab, 0xcd])]);
    expect(readCbor(u8([0x19, 0x01, 0x00]))).toBe(256);
    for (const bad of [
      [0x5f, 0x41, 0x00, 0xff], // indefinite byte string
      [0x9f, 0x01, 0xff], // indefinite array
      [0xc0, 0x60], // a tag
      [0xf9, 0x3c, 0x00], // a half float
      [0xf5], // true
      [0x01, 0x02], // bytes after the item
      [0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02], // {"a":1,"a":2}
      [0x62, 0xc3, 0xa9], // "é"
      [0x42, 0x01], // a short byte string
      [0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], // beyond a safe integer
      [...Array(10).fill(0x81), 0x01], // ten nested arrays
    ]) {
      expect(() => readCbor(u8(bad))).toThrow(TypeError);
    }
  });
});
