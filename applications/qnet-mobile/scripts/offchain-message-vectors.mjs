#!/usr/bin/env node
// Vectors for qnet_signMessage, computed by the QNet browser extension's own crypto bundle
// (applications/qnet-wallet/dist/lib/qnet-core.js), so the app's port (src/crypto/OffchainMessage.js) is pinned
// to the extension byte for byte: the signed bytes of each (origin, message), the refusals, and a signature by
// the wallet KAT key that the app must verify; and the same for the site-record signer (buildSiteRecord,
// signSiteRecord), which signs only aiqnet.io's burn record and node reservation.
//
//   node scripts/offchain-message-vectors.mjs           write __tests__/fixtures/offchain_message_vectors.json
//   node scripts/offchain-message-vectors.mjs --check   exit 1 if the file differs from a fresh run
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../__tests__/fixtures/offchain_message_vectors.json');
const BUNDLE = resolve(HERE, '../../qnet-wallet/dist/lib/qnet-core.js');
const KAT = JSON.parse(readFileSync(resolve(HERE, '../__tests__/fixtures/wallet_kat.json'), 'utf8'));

const core = await import(pathToFileURL(BUNDLE).href);

const ORIGINS = [
  'https://example.com', 'https://app.example.co.uk:8443', 'https://xn--mnchen-3ya.de', 'https://1.2.3.4',
  'http://localhost:3000', 'http://127.0.0.1',
  // refused
  'http://example.com', 'https://example.com/', 'https://example.com:443', 'https://EXAMPLE.com',
  'https://user@example.com', 'https://münchen.de', 'https://example.com:08443', 'https://example.com:65536',
  'https://0x7f.1', 'ftp://example.com', '', 'example.com',
];

const long = 'a'.repeat(4096);
// aiqnet.io's two record messages: a node reservation of the payment way, a burn record of the extension's way.
const BURNER = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const RESERVATION = `QNet node reservation v1\nwallet: ${KAT.eon_address}\nnode: light\nway: payment\nburner: ${BURNER}\n`
  + 'time: 1790000000\ncluster: devnet';
const RECORD = `QNet burn record v1\nwallet: ${KAT.eon_address}\nnode: super\nburner: ${BURNER}\nburn: ${'3'.repeat(88)}\n`
  + 'amount: 10000\ncluster: devnet';
const MESSAGES = [
  'Hello QNet', 'Sign in to example.com\nNonce: 8f2c1d', 'Привет, мир — 👋', 'tab\there', long, `${long}b`,
  'q1337|transfer:a:b:1:0:10:10000', '  PING:abc', 'selfattest:1:2', 'Token_Refresh:x', 'qnet_register:x',
  'delegate_ping:x', 'qnet_onchain_reg:x', '', '\u202eevil', 'a\u0000b', 'lone \ud800 surrogate',
  'a\u200fb', 'café', '日本語のメッセージ',
  // The node's wallet-signed light-node registration and device migration preimages, plain and disguised.
  'register:02dca74ef2eae3be97feon499504db891ae0c60e364a8:QNET-L1234:light', 'migrate:QNET-L1234:ab12',
  ' Register:x', 'ｒｅｇｉｓｔｅｒ:x', 'M I G R A T E:x',
  'Please register: your seat', 'Registered: yes',
  // The untagged consent and claim families and the device messages.
  'client_node_reg:x', ' Claim_Rewards:x', 'qnet_claim_v1:x', 'qnet_dev_rebind:v1|1337|x', 'QNET_DEV_release:v1|x',
  // Hidden characters (refused): zero-width space, word joiner, BOM inside the text, soft hyphen, combining
  // grapheme joiner, tag characters, variation selector 16, braille blank, Hangul filler, line separator,
  // private use, unassigned.
  'Approve 10 QNC\u200b to X', 'hi\u2060there', 'a\ufeffb', 'soft\u00adhyphen', 'a\u034fb',
  'Log in to example.com\u{E0020}\u{E0061}\u{E0070}', 'ok\ufe0f', 'a\u2800b', 'a\u3164b', 'line\u2028two',
  'a\ue000b', 'a\u0378b',
  // Disguised protocol prefixes: behind a hidden character (INVALID_MESSAGE first), spaced, ideographic
  // space, full width, circled digit.
  '\u200bq1337|transfer:a:b:1:0:10:10000', '\u00adselfattest:1', 'p i n g:abc', '\u3000ping:abc',
  '\uff51\uff11\uff13\uff13\uff17|x', 'q\u2460337|x', 'Q 1337 | x', 'qnet_ register:x',
  // Accepted: the same letters that fold only when they are not at the start.
  'Hello ping:abc', 'note: \uff51 is full width', 'Log in, nonce q1337',
  // The payment address's owner bind and aiqnet.io's records are never a dApp message, however they are written.
  'qnet_burn_owner_v2:light_mobile_0:x', RESERVATION, RECORD, 'QNET BURN RECORD V1', 'qnet node reservation v1: x',
];

// The site-record signer: the two record messages for aiqnet.io's origin (and a loopback one), and its refusals.
const SITE_RECORDS = [
  ['https://aiqnet.io', RESERVATION], ['https://aiqnet.io', RECORD], ['http://localhost:3000', RESERVATION],
  // refused
  ['https://aiqnet.io', 'Hello QNet'], ['https://aiqnet.io', ''], ['https://aiqnet.io', 'QNet node reservation v1'],
  ['https://aiqnet.io', 'qnet node reservation v1\nwallet: x'], ['https://aiqnet.io', ` ${RECORD}`],
  ['https://aiqnet.io', RECORD.replace('\n', '\r\n')], ['https://aiqnet.io', `${RESERVATION}\u200b`],
  ['https://aiqnet.io', `${RESERVATION}\r`], ['https://aiqnet.io', `QNet burn record v1\n${long}`],
  ['http://aiqnet.io', RESERVATION], ['https://aiqnet.io/', RECORD],
  // two faults: the message is judged first
  ['http://aiqnet.io', 'Hello QNet'],
];

function outcome(fn) {
  try {
    return { ok: fn() };
  } catch (error) {
    return { error: error.code || error.message };
  }
}

const build = [];
for (const origin of ORIGINS) {
  for (const message of origin === 'https://example.com' ? MESSAGES : ['Hello QNet']) {
    const r = outcome(() => core.bytesToHex(core.buildOffchainMessage(origin, message)));
    build.push(r.error ? { origin, message, error: r.error } : { origin, message, bytes_hex: r.ok });
  }
}

const siteRecord = SITE_RECORDS.map(([origin, message]) => {
  const r = outcome(() => core.bytesToHex(core.buildSiteRecord(origin, message)));
  return r.error ? { origin, message, error: r.error } : { origin, message, bytes_hex: r.ok };
});

// Every code point the extension refuses inside a message, as [first, last] ranges: the app must refuse
// exactly these (lone surrogates included).
const refused = [];
for (let cp = 0; cp <= 0x10ffff; cp += 1) {
  let bad = false;
  try {
    core.buildOffchainMessage('https://example.com', `a${String.fromCodePoint(cp)}b`);
  } catch (error) {
    if (error.code !== 'INVALID_MESSAGE') throw new Error(`unexpected refusal ${error.code} at ${cp}`);
    bad = true;
  }
  if (!bad) continue;
  const last = refused[refused.length - 1];
  if (last && last[1] === cp - 1) last[1] = cp;
  else refused.push([cp, cp]);
}

const seed = core.hexToBytes(KAT.bip39_seed_hex);
const { publicKey, secretKey, address } = core.deriveQnetKeypair(seed);
if (core.bytesToHex(publicKey) !== KAT.pk_hex || address !== KAT.eon_address) throw new Error('KAT key mismatch');
const SIGNED = { origin: 'https://example.com', message: 'Sign in to example.com\nNonce: 8f2c1d' };
const signed = core.signOffchainMessage(SIGNED.origin, SIGNED.message, secretKey, publicKey);
const RECORD_SIGNED = { origin: 'https://aiqnet.io', message: RESERVATION };
const recordSigned = core.signSiteRecord(RECORD_SIGNED.origin, RECORD_SIGNED.message, secretKey, publicKey);
secretKey.fill(0);

const vectors = {
  source: 'applications/qnet-wallet/dist/lib/qnet-core.js (buildOffchainMessage, signOffchainMessage, buildSiteRecord, '
    + 'signSiteRecord)',
  header: core.OFFCHAIN_MESSAGE_HEADER,
  context: core.OFFCHAIN_MESSAGE_CONTEXT,
  max_bytes: core.OFFCHAIN_MESSAGE_MAX_BYTES,
  protocol_prefixes: [...core.PROTOCOL_PREFIXES],
  unicode: process.versions.unicode,
  refused_code_points: refused,
  build,
  signature: {
    ...SIGNED,
    address,
    public_key_sha3_256: KAT.pk_sha3_256,
    signature_hex: core.bytesToHex(signed.signature),
  },
  site_record: siteRecord,
  site_record_signature: {
    ...RECORD_SIGNED,
    address,
    signature_hex: core.bytesToHex(recordSigned.signature),
  },
};

const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes('--check')) {
  // The signature is randomized (hedged ML-DSA); everything else must match exactly.
  const current = JSON.parse(readFileSync(OUT, 'utf8'));
  const strip = (v) => ({
    ...v,
    signature: { ...v.signature, signature_hex: null },
    site_record_signature: v.site_record_signature && { ...v.site_record_signature, signature_hex: null },
  });
  const record = current.site_record_signature;
  const same = JSON.stringify(strip(current)) === JSON.stringify(strip(vectors))
    && core.verifyOffchainMessage(current.signature.origin, current.signature.message,
      core.hexToBytes(current.signature.signature_hex), publicKey)
    && ml_dsa65.verify(core.hexToBytes(record.signature_hex), core.buildSiteRecord(record.origin, record.message), publicKey,
      { context: new TextEncoder().encode(core.OFFCHAIN_MESSAGE_CONTEXT) });
  console.log(same ? 'offchain message vectors: up to date' : 'offchain message vectors: STALE');
  process.exit(same ? 0 : 1);
}
writeFileSync(OUT, text);
console.log(`wrote ${OUT} (${build.length} build vectors, ${siteRecord.length} site-record vectors)`);
